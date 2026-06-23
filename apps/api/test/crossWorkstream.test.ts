// cross-workstream integration — oracles × adaptive params
// composed in a single market lifecycle.
// The two subsystems live on independent code paths: the cron oracle tick
// (resolve/auto-settle) vs. the per-fill adaptive controller (cfg_state +
// market_cfg_history). This suite pins that they compose without interfering
// • an `api`-oracle crypto market ADAPTS its engine params as it trades, then the
// cron tick AUTO-RESOLVES it from a (mocked) xprices feed and AUTO-SETTLES it —
// and the adaptive cfg state + history survive the RESOLVED→SETTLED transition
// intact (settlement must not clobber the controller's persisted state).
// • a `centralized` market adapts, is resolved by its assigned `oracle` user
// disputed by a holder, overridden by an admin, then settled — and the override
// re-pay is correct on a market that had adaptive trading.
// Hits the real DB; the xprices fetch is injected (no live network).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { config } from '../src/config.ts';
import { db, sql } from '../src/db/client.ts';
import {
  auditEvents,
  beliefUpdates,
  claims,
  contracts,
  disputes,
  lpLedger,
  lpPositions,
  markets,
  oracles,
  positions,
  trades,
  transactions,
  users,
} from '../src/db/schema.ts';
import { app } from '../src/index.ts';
import { setXpricesFetch } from '../src/lib/xprices.ts';
import { runAutoSettleSweep } from '../src/services/oracleSvc.ts';
import { runOracleTick } from '../src/services/scheduler.ts';

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return app.handle(
    new Request(`http://local${path}`, {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }),
  );
}

const hasEnv = !!process.env.DATABASE_URL && !!process.env.ADMIN_PASSWORD;
const marketIds: string[] = [];

interface CfgView {
  base: { sigmaEps: number };
  source: 'static' | 'adapt' | 'pin';
  state: { count: number };
  live: { sigmaEps: number };
  history: { sigmaEps: number; source: string; createdAt: string }[];
}

async function login(username: string, password: string): Promise<string> {
  const res = await req('POST', '/auth/login', { body: { username, password } });
  return ((await res.json()) as { token: string }).token;
}
async function userId(username: string): Promise<string> {
  const rows = await db
    .select({ id: users.userId })
    .from(users)
    .where(eq(users.username, username));
  return rows[0].id;
}
async function marketRow(id: string) {
  const rows = await db.select().from(markets).where(eq(markets.marketId, id));
  return rows[0];
}

function freshFeed(price: number) {
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          token_id: 'BTC',
          price,
          ema_price: price,
          confidence: 5,
          timestamp: new Date().toISOString(),
        }),
    });
}

afterAll(async () => {
  if (hasEnv) {
    for (const id of marketIds) {
      await db.delete(transactions).where(eq(transactions.marketId, id));
      await db.delete(disputes).where(eq(disputes.marketId, id));
      await db.delete(claims).where(eq(claims.marketId, id));
      await db.delete(trades).where(eq(trades.marketId, id));
      await db.delete(positions).where(eq(positions.marketId, id));
      await db.delete(beliefUpdates).where(eq(beliefUpdates.marketId, id));
      await db.delete(contracts).where(eq(contracts.marketId, id));
      await db.delete(oracles).where(eq(oracles.marketId, id));
      await db.delete(lpLedger).where(eq(lpLedger.marketId, id));
      await db.delete(lpPositions).where(eq(lpPositions.marketId, id));
      await db.delete(auditEvents).where(eq(auditEvents.targetId, id));
      // market_cfg_history cascades on the markets delete below.
      await db.delete(markets).where(eq(markets.marketId, id));
    }
    await db.update(users).set({ role: 'user' }).where(eq(users.username, 'bob'));
    await db
      .update(users)
      .set({ balance: 10000 })
      .where(inArray(users.username, ['alice', 'bob']));
  }
  setXpricesFetch(null);
  await sql.end();
});

describe.if(hasEnv)('cross-workstream: oracles × adaptive params (V2-7)', () => {
  let adminToken = '';
  let aliceToken = '';
  let bobToken = '';
  let bobId = '';

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    aliceToken = await login('alice', 'password');
    bobToken = await login('bob', 'password');
    bobId = await userId('bob');
  });

  const PAST = () => new Date(Date.now() - 3600_000).toISOString();

  // A crypto-scale market: μ=62k, σ=8k (BTC-ish). Mirrors the api seed market.
  async function createCrypto(body: Record<string, unknown>): Promise<string> {
    const res = await req('POST', '/admin/markets', {
      token: adminToken,
      body: {
        outcomeUnit: 'USD',
        initialMu: 62_000,
        initialSigma: 8_000,
        initialReserve: 500_000,
        ...body,
      },
    });
    expect([200, 201]).toContain(res.status);
    const { market } = (await res.json()) as { market: { marketId: string } };
    marketIds.push(market.marketId);
    return market.marketId;
  }
  async function open(id: string) {
    expect((await req('POST', `/admin/markets/${id}/open`, { token: adminToken })).status).toBe(
      200,
    );
  }
  async function trade(id: string, spec: Record<string, unknown>, q: number, token = aliceToken) {
    const r = await req('POST', `/markets/${id}/trade`, { token, body: { spec, q } });
    expect(r.status).toBe(200);
    return r.json();
  }
  async function getCfg(id: string): Promise<CfgView> {
    const r = await req('GET', `/admin/markets/${id}/cfg`, { token: adminToken });
    expect(r.status).toBe(200);
    return ((await r.json()) as { cfg: CfgView }).cfg;
  }

  // Alice repeatedly buys ONE binary-call contract: it both drives the adaptive
  // controller (signal s ≈ strike, |s−μ| ≪ σ₀ ⇒ a clean moderate surprise, no rail
  // hit) AND is the only position she claims on, so the payout is exactly N·q·[θ*≥K].
  const BUYS = 6;
  async function driveAndHold(id: string, strike: number) {
    for (let i = 0; i < BUYS; i++) await trade(id, { type: 'BINARY_CALL', strike }, 100);
  }

  test('api-oracle market adapts, auto-resolves from the feed, and settles — cfg survives the lifecycle', async () => {
    const id = await createCrypto({
      title: 'XW · BTC api + adaptive',
      oracleMode: 'api',
      oracleToken: 'BTC',
      resolvesAt: PAST(),
      disputeWindowSec: 0, // no dispute window ⇒ auto-settles on the next sweep
    });
    await open(id);
    await driveAndHold(id, 60_000); // strike below where the feed resolves ⇒ pays

    const adapted = await getCfg(id);
    expect(adapted.state.count).toBe(BUYS);
    expect(adapted.source).toBe('adapt'); // past warmup → adapting
    expect(adapted.history.length).toBe(BUYS);
    expect(Math.abs(adapted.live.sigmaEps - adapted.base.sigmaEps)).toBeGreaterThan(1e-6);

    // The cron tick: the api sweep resolves from the feed. (Zero-window auto-settle
    // lands on the NEXT sweep — resolved_at is stamped just after this tick's now.)
    setXpricesFetch(freshFeed(62_015.5));
    await runOracleTick();
    let m = await marketRow(id);
    expect(m.status).toBe('RESOLVED');
    expect(m.thetaStar).toBeCloseTo(62_015.5, 2);
    expect(m.resolvedAt).not.toBeNull();
    const reports = await db.select().from(oracles).where(eq(oracles.marketId, id));
    expect(reports.some((r) => r.source === 'api:xprices' && r.stale === false)).toBe(true);

    // Next sweep: zero window elapsed ⇒ settle.
    await runAutoSettleSweep(Date.now() + 60_000);
    m = await marketRow(id);
    expect(m.status).toBe('SETTLED');

    // Cross-workstream invariant: the adaptive cfg state + history are intact after
    // the RESOLVED→SETTLED transition — settlement never touches the controller.
    const after = await getCfg(id);
    expect(after.state.count).toBe(BUYS);
    expect(after.history.length).toBe(BUYS);
    expect(after.live.sigmaEps).toBeCloseTo(adapted.live.sigmaEps, 6);

    // The claim pays.
    const claim = await req('POST', `/markets/${id}/claim`, { token: aliceToken });
    expect(claim.status).toBe(200);
    const credited = ((await claim.json()) as { claim: { credited: number } }).claim.credited;
    expect(credited).toBeCloseTo(BUYS * 100, 6);
  });

  test('centralized market adapts, then a dispute override re-pays correctly', async () => {
    // bob is the assigned oracle.
    expect(
      (
        await req('PATCH', `/admin/users/${bobId}/role`, {
          token: adminToken,
          body: { role: 'oracle' },
        })
      ).status,
    ).toBe(200);

    const id = await createCrypto({
      title: 'XW · centralized + adaptive + dispute',
      oracleMode: 'centralized',
      oracleUserId: bobId,
      resolvesAt: PAST(),
      disputeWindowSec: 3600,
    });
    await open(id);

    // Alice repeatedly buys a BINARY_CALL @ 63k: drives adaptation AND is her claim.
    await driveAndHold(id, 63_000);
    expect((await getCfg(id)).source).toBe('adapt');

    // bob resolves LOW (θ*=61k < strike 63k ⇒ binary-call pays 0).
    expect(
      (
        await req('POST', `/oracle/markets/${id}/resolve`, {
          token: bobToken,
          body: { thetaStar: 61_000 },
        })
      ).status,
    ).toBe(200);
    expect((await marketRow(id)).status).toBe('RESOLVED');

    // Alice disputes; the override lifts θ* above the strike so the call now pays.
    expect(
      (
        await req('POST', `/markets/${id}/dispute`, {
          token: aliceToken,
          body: { reason: 'settled higher at deadline', proposedValue: 64_000 },
        })
      ).status,
    ).toBe(201);

    const queue = await req('GET', '/admin/disputes?status=open', { token: adminToken });
    const dlist = ((await queue.json()) as { disputes: { disputeId: string; marketId: string }[] })
      .disputes;
    const mine = dlist.find((d) => d.marketId === id);
    expect(mine).toBeTruthy();
    expect(
      (
        await req('POST', `/admin/disputes/${mine?.disputeId}/resolve`, {
          token: adminToken,
          body: { action: 'uphold', secondaryValue: 64_000, note: 'verified' },
        })
      ).status,
    ).toBe(200);
    expect((await marketRow(id)).thetaStar).toBeCloseTo(64_000, 6);

    // Window passed + no open dispute ⇒ auto-settle; alice claims the overridden payout.
    await runAutoSettleSweep(Date.now() + 7200_000);
    expect((await marketRow(id)).status).toBe('SETTLED');
    const claim = await req('POST', `/markets/${id}/claim`, { token: aliceToken });
    expect(claim.status).toBe(200);
    const credited = ((await claim.json()) as { claim: { credited: number } }).claim.credited;
    expect(credited).toBeCloseTo(BUYS * 100, 6); // override (64k ≥ 63k) made the calls pay 1·q

    // Adaptive history is still intact after the dispute/override/settle path.
    expect((await getCfg(id)).history.length).toBe(BUYS);
  });
});
