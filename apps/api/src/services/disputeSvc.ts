// DisputeSvc — the post-RESOLVED challenge window.
// A position holder may file a dispute while a market is RESOLVED and still inside
// its `dispute_window_sec`. An `open` dispute blocks the auto-settle sweep, so the
// market stays RESOLVED and claims stay gated (claims open only on SETTLED). An
// admin closes a dispute by **upholding** it (override θ* → re-compute claims) or
// **rejecting** it (the resolution stands). The actual SETTLED transition is left
// to the auto-settle sweep / admin settle once no dispute is open and the window
// has elapsed — so this service never opens claims directly.

import type { DisputeView, ResolveDisputeDTO } from '@bmm/shared';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import type { MarketRow, UserRow } from '../db/repos.ts';
import { claims, disputes, markets, oracles, positions, users } from '../db/schema.ts';
import { writeAudit } from '../lib/audit.ts';
import { HttpError } from '../lib/errors.ts';
import { publish, topics } from '../realtime.ts';
import { withMarketLock } from './marketQueue.ts';
import { recordClaims } from './settleSvc.ts';

function withinWindow(m: MarketRow, nowMs: number): boolean {
  if (m.resolvedAt == null) return false;
  return nowMs < m.resolvedAt.getTime() + m.disputeWindowSec * 1000;
}

async function holdsPosition(userId: string, marketId: string): Promise<boolean> {
  const rows = await db
    .select({ q: positions.quantity })
    .from(positions)
    .where(and(eq(positions.userId, userId), eq(positions.marketId, marketId)));
  return rows.some((r) => r.q > 0);
}

// File a dispute against a market's resolution. Only a position holder, only while
// RESOLVED and inside the window, and at most one open dispute per user per market.
export async function fileDispute(
  actor: UserRow,
  marketId: string,
  input: { reason: string; proposedValue?: number },
  nowMs = Date.now(),
): Promise<DisputeView> {
  const created = await withMarketLock(marketId, async () => {
    const mrows = await db.select().from(markets).where(eq(markets.marketId, marketId)).limit(1);
    const m = mrows[0] as MarketRow | undefined;
    if (!m) throw new HttpError(404, 'Market not found');
    if (m.status !== 'RESOLVED') {
      throw new HttpError(409, 'Disputes can only be filed on a resolved market');
    }
    if (!withinWindow(m, nowMs)) throw new HttpError(409, 'The dispute window has closed');
    if (!(await holdsPosition(actor.userId, marketId))) {
      throw new HttpError(403, 'Only position holders may dispute this market');
    }
    const existing = await db
      .select({ id: disputes.disputeId })
      .from(disputes)
      .where(
        and(
          eq(disputes.marketId, marketId),
          eq(disputes.userId, actor.userId),
          eq(disputes.status, 'open'),
        ),
      )
      .limit(1);
    if (existing.length > 0) throw new HttpError(409, 'You already have an open dispute here');

    const ins = await db
      .insert(disputes)
      .values({
        marketId,
        userId: actor.userId,
        reason: input.reason,
        proposedValue: input.proposedValue ?? null,
      })
      .returning();
    await writeAudit({
      actorId: actor.userId,
      action: 'dispute_filed',
      targetId: marketId,
      payload: { disputeId: ins[0]?.disputeId, proposedValue: input.proposedValue ?? null },
    });
    return ins[0];
  });

  // Alert admins that a resolution is contested (holds auto-settle).
  publish(topics.system, {
    type: 'system:alert',
    marketId,
    kind: 'oracle_failure',
    severity: 'warning',
    action: 'alert',
    message: 'A market resolution has been disputed — settlement is on hold.',
    value: 1,
    threshold: 1,
    at: new Date().toISOString(),
  });
  publish(topics.market(marketId), { type: 'dispute_filed', disputeId: created?.disputeId });
  return toDisputeView(created as typeof disputes.$inferSelect);
}

// Admin resolution of a dispute. `uphold` overrides θ* to `secondaryValue` and
// re-computes every claim (the market is still RESOLVED/uncredited, so deleting and
// re-recording claims is safe); `reject` leaves the resolution untouched. Either
// way the dispute is closed. Runs under the market lock alongside the claim rewrite.
export async function resolveDispute(
  admin: UserRow,
  disputeId: string,
  input: ResolveDisputeDTO,
): Promise<DisputeView> {
  // Read the dispute's market outside the lock so we can lock-then-transact (the
  // codebase convention — acquiring a DB connection while holding the lock, never
  // the reverse, avoids pool-starvation deadlock).
  const pre = await db.select().from(disputes).where(eq(disputes.disputeId, disputeId)).limit(1);
  const preD = pre[0];
  if (!preD) throw new HttpError(404, 'Dispute not found');
  if (preD.status !== 'open') throw new HttpError(409, 'Dispute is already resolved');

  const updated = await withMarketLock(preD.marketId, () =>
    db.transaction(async (tx) => {
      const drows = await tx
        .select()
        .from(disputes)
        .where(eq(disputes.disputeId, disputeId))
        .for('update');
      const d = drows[0];
      if (!d) throw new HttpError(404, 'Dispute not found');
      if (d.status !== 'open') throw new HttpError(409, 'Dispute is already resolved');

      const mrows = await tx
        .select()
        .from(markets)
        .where(eq(markets.marketId, d.marketId))
        .for('update');
      const m = mrows[0] as MarketRow | undefined;
      if (!m) throw new HttpError(404, 'Market not found');
      if (m.status !== 'RESOLVED') {
        throw new HttpError(409, 'Market is no longer in the disputable (resolved) state');
      }

      const upheld = input.action === 'uphold';
      if (upheld) {
        const newTheta = input.secondaryValue as number; // schema guarantees presence
        // Re-resolve: replace the prior (uncredited) claims with ones at the new θ*.
        await tx.delete(claims).where(eq(claims.marketId, d.marketId));
        await recordClaims(tx, d.marketId, newTheta);
        await tx
          .update(markets)
          .set({ thetaStar: newTheta, updatedAt: new Date() })
          .where(eq(markets.marketId, d.marketId));
        await tx.insert(oracles).values({
          marketId: d.marketId,
          source: 'admin_override',
          token: m.oracleToken,
          resolvedValue: newTheta,
          confidence: 1,
          disputed: true,
        });
      }

      const res = await tx
        .update(disputes)
        .set({
          status: upheld ? 'upheld' : 'rejected',
          secondaryValue: upheld ? (input.secondaryValue ?? null) : null,
          resolverId: admin.userId,
          resolutionNote: input.note ?? null,
          resolvedAt: new Date(),
        })
        .where(eq(disputes.disputeId, disputeId))
        .returning();
      await writeAudit(
        {
          actorId: admin.userId,
          action: 'dispute_resolved',
          targetId: d.marketId,
          payload: {
            disputeId,
            action: input.action,
            secondaryValue: input.secondaryValue ?? null,
          },
        },
        tx,
      );
      if (!res[0]) throw new HttpError(500, 'Dispute update failed');
      return res[0];
    }),
  );

  publish(topics.market(updated.marketId), {
    type: 'dispute_resolved',
    disputeId,
    status: updated.status,
  });
  return toDisputeView(updated as typeof disputes.$inferSelect);
}

export async function listDisputes(
  status?: 'open' | 'upheld' | 'rejected',
): Promise<DisputeView[]> {
  const rows = await db
    .select({
      d: disputes,
      marketTitle: markets.title,
      username: users.username,
    })
    .from(disputes)
    .innerJoin(markets, eq(disputes.marketId, markets.marketId))
    .innerJoin(users, eq(disputes.userId, users.userId))
    .where(status ? eq(disputes.status, status) : undefined)
    .orderBy(desc(disputes.createdAt));
  return rows.map((r) => toDisputeView(r.d, r.marketTitle, r.username));
}

function toDisputeView(
  d: typeof disputes.$inferSelect,
  marketTitle?: string,
  username?: string,
): DisputeView {
  return {
    disputeId: d.disputeId,
    marketId: d.marketId,
    marketTitle,
    userId: d.userId,
    username,
    reason: d.reason,
    status: d.status,
    proposedValue: d.proposedValue,
    secondaryValue: d.secondaryValue,
    resolverId: d.resolverId,
    resolutionNote: d.resolutionNote,
    createdAt: d.createdAt.toISOString(),
    resolvedAt: d.resolvedAt ? d.resolvedAt.toISOString() : null,
  };
}
