// Oracle service — the `api`-mode resolution path and the scheduler sweeps.
// `api`-mode markets carry an `oracle_token`; when their deadline (`resolves_at`)
// passes, the scheduler fetches that token's spot price from xprices and resolves
// the market with it as θ*. A bad/missing feed never resolves on junk: the market
// is SUSPENDED (if still OPEN) and an `oracle_failure` alert is published
// then retried on the next tick — a SUSPENDED-but-past-deadline `api` market stays
// in the sweep, so it auto-resolves the moment the feed recovers.
// Resolution itself reuses `transitionMarket(null, …, 'resolve')` (null = system
// actor) so claims/oracle-report/locking stay in one place. This module is pure of
// timers — `runApiResolutionSweep` is the cron body; see scheduler.ts for cadence.

import type { Alert } from '@bmm/core';
import { UserRole } from '@bmm/shared';
import { and, asc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import type { MarketRow, UserRow } from '../db/repos.ts';
import { disputes, markets, oracles } from '../db/schema.ts';
import { HttpError } from '../lib/errors.ts';
import { fetchPrice } from '../lib/xprices.ts';
import { publish, topics } from '../realtime.ts';
import { transitionMarket } from './marketSvc.ts';
import { type MarketView, buildMarketView } from './marketView.ts';

function publishOracleFailure(market: MarketRow, reason: string): void {
  const alert: Alert = {
    kind: 'oracle_failure',
    severity: 'critical',
    action: 'suspend',
    message: `Oracle feed for ${market.oracleToken ?? '?'} unusable at resolution: ${reason}.`,
    value: 1,
    threshold: 1,
  };
  publish(topics.system, {
    type: 'system:alert',
    marketId: market.marketId,
    ...alert,
    at: new Date().toISOString(),
  });
}

// Attempt to resolve one `api`-mode market from its configured token's price.
// Returns the outcome so the sweep (and tests) can assert on it. Never throws on a
// feed failure — that path suspends + alerts instead.
export async function resolveApiMarket(
  market: MarketRow,
  nowMs = Date.now(),
): Promise<{ status: 'resolved'; thetaStar: number } | { status: 'suspended'; reason: string }> {
  if (!market.oracleToken) {
    return { status: 'suspended', reason: 'api market has no oracle_token' };
  }
  const result = await fetchPrice(market.oracleToken, nowMs);

  if (!result.ok) {
    // Record the failed read for the audit trail, then halt + alert. Stays in the
    // sweep (we also poll SUSPENDED past-deadline markets) so it self-heals.
    await db.insert(oracles).values({
      marketId: market.marketId,
      source: 'api:xprices',
      token: market.oracleToken,
      resolvedValue: 0,
      stale: true,
    });
    if (market.status === 'OPEN') {
      // suspend halts trading while the feed is down; ignore a races-to-SUSPENDED 409.
      await transitionMarket(null, market.marketId, 'suspend').catch(() => undefined);
    }
    publishOracleFailure(market, result.reason);
    return { status: 'suspended', reason: result.reason };
  }

  await transitionMarket(null, market.marketId, 'resolve', {
    thetaStar: result.reading.price,
    oracleSource: 'api:xprices',
    oracleConfidence: result.reading.confidence ?? 1,
  });
  return { status: 'resolved', thetaStar: result.reading.price };
}

// One cron tick of the API-resolution sweep: every `api`-mode market that is past
// its deadline and not yet resolved (OPEN or SUSPENDED-pending-feed) gets a
// resolution attempt. Processed sequentially — the set is tiny and each takes the
// per-market lock anyway.
export async function runApiResolutionSweep(nowMs = Date.now()): Promise<{
  attempted: number;
  resolved: number;
  suspended: number;
}> {
  const due = await db
    .select()
    .from(markets)
    .where(
      and(
        eq(markets.oracleMode, 'api'),
        inArray(markets.status, ['OPEN', 'SUSPENDED']),
        isNotNull(markets.resolvesAt),
        lte(markets.resolvesAt, new Date(nowMs)),
      ),
    );

  let resolved = 0;
  let suspended = 0;
  for (const m of due as MarketRow[]) {
    const r = await resolveApiMarket(m, nowMs);
    if (r.status === 'resolved') resolved++;
    else suspended++;
  }
  return { attempted: due.length, resolved, suspended };
}

function deadlinePassed(m: MarketRow, nowMs: number): boolean {
  return m.resolvesAt == null || m.resolvesAt.getTime() <= nowMs;
}

// Markets a caller may resolve from the Oracle panel right now: `centralized`
// markets that are still open (OPEN/SUSPENDED), past their deadline, and assigned
// to the caller. Admins see every such market (oracleUserId null = admin-resolved
// included); a `role=oracle` user sees only the ones assigned to them.
export async function listOracleMarkets(actor: UserRow, nowMs = Date.now()): Promise<MarketView[]> {
  const isAdmin = actor.role === UserRole.ADMIN;
  const rows = await db
    .select()
    .from(markets)
    .where(
      and(
        eq(markets.oracleMode, 'centralized'),
        inArray(markets.status, ['OPEN', 'SUSPENDED']),
        isAdmin ? undefined : eq(markets.oracleUserId, actor.userId),
      ),
    )
    .orderBy(asc(markets.resolvesAt));
  const due = (rows as MarketRow[]).filter((m) => deadlinePassed(m, nowMs));
  return Promise.all(due.map((m) => buildMarketView(m)));
}

// Resolve a `centralized` market by its assigned oracle (or an admin). Enforces
// mode is centralized, the deadline has passed, and the caller is the assigned
// oracle (admins may resolve any centralized market, including admin-resolved ones
// with a null assignee). Delegates the state change to `transitionMarket`.
export async function resolveCentralizedMarket(
  actor: UserRow,
  marketId: string,
  thetaStar: number,
  nowMs = Date.now(),
): Promise<MarketRow> {
  const m = await db.select().from(markets).where(eq(markets.marketId, marketId)).limit(1);
  const market = m[0] as MarketRow | undefined;
  if (!market) throw new HttpError(404, 'Market not found');
  if (market.oracleMode !== 'centralized') {
    throw new HttpError(409, `Market oracle mode is "${market.oracleMode}", not centralized`);
  }
  const isAdmin = actor.role === UserRole.ADMIN;
  const isAssigned = market.oracleUserId != null && market.oracleUserId === actor.userId;
  if (!isAdmin && !isAssigned) {
    throw new HttpError(403, 'You are not the assigned oracle for this market');
  }
  if (!deadlinePassed(market, nowMs)) {
    throw new HttpError(409, 'Market deadline has not passed yet');
  }
  return transitionMarket(actor, marketId, 'resolve', {
    thetaStar,
    oracleSource: isAdmin && !isAssigned ? 'centralized:admin' : 'centralized',
  });
}

// One cron tick of the auto-settle sweep: every RESOLVED
// market whose dispute window has elapsed (`resolved_at + dispute_window_sec ≤ now`)
// AND has no `open` dispute transitions RESOLVED→SETTLED, opening claims. An open
// dispute holds the market in RESOLVED (claims stay gated) until an admin closes it.
// Applies to every oracle mode — the window is a market property, not mode-specific.
export async function runAutoSettleSweep(nowMs = Date.now()): Promise<{ settled: number }> {
  const nowIso = new Date(nowMs).toISOString();
  const due = await db
    .select()
    .from(markets)
    .where(
      and(
        eq(markets.status, 'RESOLVED'),
        isNotNull(markets.resolvedAt),
        // resolved_at + dispute_window_sec seconds ≤ now. The Date is bound as a
        // text param + cast (a bare Date can't bind into a raw-sql comparison).
        sql`${markets.resolvedAt} + make_interval(secs => ${markets.disputeWindowSec}) <= ${nowIso}::timestamptz`,
      ),
    );

  let settled = 0;
  for (const m of due as MarketRow[]) {
    const open = await db
      .select({ id: disputes.disputeId })
      .from(disputes)
      .where(and(eq(disputes.marketId, m.marketId), eq(disputes.status, 'open')))
      .limit(1);
    if (open.length > 0) continue; // an open dispute blocks settlement
    await transitionMarket(null, m.marketId, 'settle').catch(() => undefined);
    settled++;
  }
  return { settled };
}
