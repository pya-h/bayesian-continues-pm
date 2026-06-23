// integration — oracle resolution modes & disputes.
// Covers the three things the phase promises
// • api mode — a crypto market auto-resolves from a (mocked) xprices feed; a
// stale feed SUSPENDS + alerts instead, then auto-retries to a
// resolution once the feed recovers.
// • centralized — only the assigned `oracle` user (or an admin) can resolve, and
// only after the deadline; the role is granted by an admin.
// • disputes — a holder's dispute holds auto-settle (and therefore claims); an
// admin override re-computes payouts; the window-pass auto-settles.
// Hits the real DB. The xprices fetch is injected (no live network).

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
import {
  resolveApiMarket,
  runApiResolutionSweep,
  runAutoSettleSweep,
} from '../src/services/oracleSvc.ts';

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
function staleFeed() {
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token_id: 'BTC', price: 0, stale: true }),
    });
}

afterAll(async () => {
  if (hasEnv) {
    if (marketIds.length) {
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
        await db.delete(markets).where(eq(markets.marketId, id));
      }
    }
    // Reset any state the suite mutated: bob's role (used as the oracle) + balances.
    await db.update(users).set({ role: 'user' }).where(eq(users.username, 'bob'));
    await db
      .update(users)
      .set({ balance: 10000 })
      .where(inArray(users.username, ['alice', 'bob']));
  }
  setXpricesFetch(null);
  await sql.end();
});

describe.if(hasEnv)('oracles & disputes (V2-3)', () => {
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
  const FUTURE = () => new Date(Date.now() + 3600_000).toISOString();

  async function createMarket(body: Record<string, unknown>): Promise<string> {
    const res = await req('POST', '/admin/markets', {
      token: adminToken,
      body: {
        outcomeUnit: 'USD',
        initialMu: 70,
        initialSigma: 10,
        initialReserve: 100000,
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
  async function aliceBuys(id: string) {
    // A bounded BINARY_CALL buy at a strike below μ — cheap, gives alice a payout
    // claim whose value flips with θ* (so an override visibly changes it).
    const r = await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'BINARY_CALL', strike: 65 }, q: 100 },
    });
    expect(r.status).toBe(200);
  }

  // api mode --------------------------------------------------------------

  test('api market auto-resolves from a fresh xprices feed', async () => {
    const id = await createMarket({
      title: 'BTC api (fresh)',
      oracleMode: 'api',
      oracleToken: 'BTC',
      resolvesAt: PAST(),
    });
    await open(id);

    setXpricesFetch(freshFeed(62015.5));
    const out = await resolveApiMarket(await marketRow(id));
    expect(out.status).toBe('resolved');

    const m = await marketRow(id);
    expect(m.status).toBe('RESOLVED');
    expect(m.thetaStar).toBeCloseTo(62015.5, 2);
    expect(m.resolvedAt).not.toBeNull();
    const reports = await db.select().from(oracles).where(eq(oracles.marketId, id));
    expect(reports.some((r) => r.source === 'api:xprices' && r.stale === false)).toBe(true);
  });

  test('a stale feed suspends + alerts, then auto-resolves once it recovers', async () => {
    const id = await createMarket({
      title: 'BTC api (stale→fresh)',
      oracleMode: 'api',
      oracleToken: 'BTC',
      resolvesAt: PAST(),
    });
    await open(id);

    setXpricesFetch(staleFeed());
    const bad = await resolveApiMarket(await marketRow(id));
    expect(bad.status).toBe('suspended');
    expect((await marketRow(id)).status).toBe('SUSPENDED');
    const staleRows = await db.select().from(oracles).where(eq(oracles.marketId, id));
    expect(staleRows.some((r) => r.stale === true)).toBe(true);

    // Feed recovers: the sweep still picks up SUSPENDED past-deadline api markets.
    setXpricesFetch(freshFeed(58000));
    const swept = await runApiResolutionSweep();
    expect(swept.resolved).toBeGreaterThanOrEqual(1);
    const m = await marketRow(id);
    expect(m.status).toBe('RESOLVED');
    expect(m.thetaStar).toBeCloseTo(58000, 2);
  });

  // centralized mode + role + authZ --------------------------------------

  test('admin grants the oracle role; only the assignee (or admin) resolves, post-deadline', async () => {
    // Promote bob to oracle via the admin role endpoint.
    const grant = await req('PATCH', `/admin/users/${bobId}/role`, {
      token: adminToken,
      body: { role: 'oracle' },
    });
    expect(grant.status).toBe(200);
    expect(((await grant.json()) as { user: { role: string } }).user.role).toBe('oracle');

    // Market assigned to bob, deadline already passed.
    const id = await createMarket({
      title: 'Centralized → bob',
      oracleMode: 'centralized',
      oracleUserId: bobId,
      resolvesAt: PAST(),
    });
    await open(id);

    // A plain user (alice) is blocked by the panel guard entirely.
    const aliceTry = await req('POST', `/oracle/markets/${id}/resolve`, {
      token: aliceToken,
      body: { thetaStar: 72 },
    });
    expect(aliceTry.status).toBe(403);

    // bob sees it in his panel queue and resolves it.
    const queue = await req('GET', '/oracle/markets', { token: bobToken });
    expect(queue.status).toBe(200);
    const list = ((await queue.json()) as { markets: { marketId: string }[] }).markets;
    expect(list.some((mk) => mk.marketId === id)).toBe(true);

    const resolve = await req('POST', `/oracle/markets/${id}/resolve`, {
      token: bobToken,
      body: { thetaStar: 73.5 },
    });
    expect(resolve.status).toBe(200);
    const m = await marketRow(id);
    expect(m.status).toBe('RESOLVED');
    expect(m.thetaStar).toBeCloseTo(73.5, 6);
  });

  test('a centralized market cannot be resolved before its deadline', async () => {
    const id = await createMarket({
      title: 'Centralized (future deadline)',
      oracleMode: 'centralized',
      oracleUserId: bobId,
      resolvesAt: FUTURE(),
    });
    await open(id);
    const tooEarly = await req('POST', `/oracle/markets/${id}/resolve`, {
      token: bobToken,
      body: { thetaStar: 70 },
    });
    expect(tooEarly.status).toBe(409);
    expect((await marketRow(id)).status).toBe('OPEN');
  });

  // disputes, gating & auto-settle ---------------------------------------

  test('dispute holds auto-settle + claims; admin override re-pays; window-pass settles', async () => {
    const id = await createMarket({
      title: 'Disputed centralized',
      oracleMode: 'centralized',
      oracleUserId: bobId,
      resolvesAt: PAST(),
      disputeWindowSec: 3600,
    });
    await open(id);
    await aliceBuys(id);

    // Resolve LOW (θ*=60 < strike 65 ⇒ binary-call pays 0). bob resolves.
    expect(
      (
        await req('POST', `/oracle/markets/${id}/resolve`, {
          token: bobToken,
          body: { thetaStar: 60 },
        })
      ).status,
    ).toBe(200);
    expect((await marketRow(id)).status).toBe('RESOLVED');

    // Window not elapsed ⇒ auto-settle leaves it RESOLVED; claims are gated.
    await runAutoSettleSweep();
    expect((await marketRow(id)).status).toBe('RESOLVED');
    const earlyClaim = await req('POST', `/markets/${id}/claim`, { token: aliceToken });
    expect(earlyClaim.status).toBe(409);

    // Alice (a holder) disputes — settlement is held even past the window.
    const filed = await req('POST', `/markets/${id}/dispute`, {
      token: aliceToken,
      body: { reason: 'price was higher at deadline', proposedValue: 80 },
    });
    expect(filed.status).toBe(201);
    await runAutoSettleSweep(Date.now() + 7200_000); // window passed, but dispute open
    expect((await marketRow(id)).status).toBe('RESOLVED');

    // Admin upholds → θ* overridden to 80 (> strike ⇒ binary-call now pays 100).
    const queue = await req('GET', '/admin/disputes?status=open', { token: adminToken });
    const dlist = ((await queue.json()) as { disputes: { disputeId: string; marketId: string }[] })
      .disputes;
    const mine = dlist.find((d) => d.marketId === id);
    expect(mine).toBeTruthy();
    const resolved = await req('POST', `/admin/disputes/${mine?.disputeId}/resolve`, {
      token: adminToken,
      body: { action: 'uphold', secondaryValue: 80, note: 'verified higher' },
    });
    expect(resolved.status).toBe(200);
    expect((await marketRow(id)).thetaStar).toBeCloseTo(80, 6);

    // No open dispute + window passed ⇒ auto-settle now settles it; alice can claim.
    await runAutoSettleSweep(Date.now() + 7200_000);
    expect((await marketRow(id)).status).toBe('SETTLED');
    const claim = await req('POST', `/markets/${id}/claim`, { token: aliceToken });
    expect(claim.status).toBe(200);
    const credited = ((await claim.json()) as { claim: { credited: number } }).claim.credited;
    expect(credited).toBeGreaterThan(0); // the override made the binary-call pay
  });

  // decentralized placeholder --------------------------------------------

  test('a decentralized market refuses resolution (not implemented) on every path', async () => {
    const id = await createMarket({
      title: 'Decentralized placeholder',
      oracleMode: 'decentralized',
      resolvesAt: PAST(),
    });
    await open(id);

    // The admin manual-override escape hatch must NOT silently resolve it.
    const adminTry = await req('POST', `/admin/markets/${id}/resolve`, {
      token: adminToken,
      body: { thetaStar: 70 },
    });
    expect(adminTry.status).toBe(501);
    // It stays OPEN — no θ*, no oracle report, no claims computed.
    const m = await marketRow(id);
    expect(m.status).toBe('OPEN');
    expect(m.thetaStar).toBeNull();
    const reports = await db.select().from(oracles).where(eq(oracles.marketId, id));
    expect(reports.length).toBe(0);
  });

  test('a zero-window market auto-settles immediately with no dispute', async () => {
    const id = await createMarket({
      title: 'No window',
      oracleMode: 'centralized',
      oracleUserId: bobId,
      resolvesAt: PAST(),
      disputeWindowSec: 0,
    });
    await open(id);
    await aliceBuys(id);
    expect(
      (
        await req('POST', `/oracle/markets/${id}/resolve`, {
          token: bobToken,
          body: { thetaStar: 90 },
        })
      ).status,
    ).toBe(200);
    await runAutoSettleSweep();
    expect((await marketRow(id)).status).toBe('SETTLED');
  });
});
