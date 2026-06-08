// integration — LP deposit / withdraw / settlement-claim via app.handle.
// Hits the real DB; creates throwaway markets, then tears down all rows and
// restores trader balances.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { config } from '../src/config.ts';
import { db, sql } from '../src/db/client.ts';
import {
  auditEvents,
  beliefUpdates,
  claims,
  contracts,
  lpLedger,
  lpPositions,
  markets,
  oracles,
  positions,
  trades,
  users,
} from '../src/db/schema.ts';
import { app } from '../src/index.ts';

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

async function createOpenMarket(token: string, body: Record<string, unknown>): Promise<string> {
  const created = await req('POST', '/admin/markets', { token, body });
  const { market } = (await created.json()) as { market: { marketId: string } };
  marketIds.push(market.marketId);
  await req('POST', `/admin/markets/${market.marketId}/open`, { token });
  return market.marketId;
}

async function balanceOf(token: string): Promise<number> {
  const res = await req('GET', '/auth/me', { token });
  return ((await res.json()) as { user: { balance: number } }).user.balance;
}

const STD = { outcomeUnit: 'USD', initialMu: 100, initialSigma: 10 };

interface PoolView {
  cash: number;
  reserveRequired: number;
  nav: number;
  sharesTotal: number;
  sharePrice: number;
}
interface YourView {
  shares: number;
  sharePct: number;
  totalDeposited: number;
  estValue: number;
  claimed: boolean;
}
interface LpView {
  pool: PoolView;
  your: YourView | null;
}

afterAll(async () => {
  if (hasEnv && marketIds.length) {
    for (const id of marketIds) {
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
    await db
      .update(users)
      .set({ balance: 10000 })
      .where(inArray(users.username, ['alice', 'bob']));
  }
  await sql.end();
});

describe.if(hasEnv)('liquidity provision (integration)', () => {
  let adminToken = '';
  let aliceToken = '';
  let bobToken = '';

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    aliceToken = await login('alice', 'password');
    bobToken = await login('bob', 'password');
  });

  test('deposit mints pro-rata shares, debits balance, grows the pool', async () => {
    const id = await createOpenMarket(adminToken, {
      title: 'LP deposit (test)',
      ...STD,
      initialReserve: 10000,
    });
    const balBefore = await balanceOf(aliceToken);

    const res = await req('POST', `/markets/${id}/lp/deposit`, {
      token: aliceToken,
      body: { amount: 5000 },
    });
    expect(res.status).toBe(200);
    const { deposit } = (await res.json()) as { deposit: { minted: number; lp: LpView } };
    expect(deposit.minted).toBeCloseTo(5000, 4); // genesis price 1, no trades
    expect(deposit.lp.your?.shares).toBeCloseTo(5000, 4);
    expect(deposit.lp.pool.sharesTotal).toBeCloseTo(15000, 4); // 10000 creator + 5000
    expect(deposit.lp.pool.cash).toBeCloseTo(15000, 4);

    expect(await balanceOf(aliceToken)).toBeCloseTo(balBefore - 5000, 4);
  });

  test('withdraw (no open risk) returns cash and burns shares', async () => {
    const id = await createOpenMarket(adminToken, {
      title: 'LP withdraw (test)',
      ...STD,
      initialReserve: 10000,
    });
    // admin (creator) holds 10000 shares; reserve is 0 with no trades → fully free.
    const res = await req('POST', `/markets/${id}/lp/withdraw`, {
      token: adminToken,
      body: { shares: 2000 },
    });
    expect(res.status).toBe(200);
    const { withdraw } = (await res.json()) as {
      withdraw: { cashOut: number; burned: number; partial: boolean; lp: LpView };
    };
    expect(withdraw.partial).toBe(false);
    expect(withdraw.cashOut).toBeCloseTo(2000, 4); // 20% of NAV 10000
    expect(withdraw.burned).toBeCloseTo(2000, 4);
    expect(withdraw.lp.pool.sharesTotal).toBeCloseTo(8000, 4);
    expect(withdraw.lp.pool.cash).toBeCloseTo(8000, 4);
  });

  test('withdraw is capped by the 1.2× solvency buffer (partial)', async () => {
    const id = await createOpenMarket(adminToken, {
      title: 'LP gated (test)',
      ...STD,
      initialReserve: 1000,
    });
    // A sizeable buy opens MM risk and pushes the required reserve up near cash.
    await req('POST', `/markets/${id}/trade`, {
      token: bobToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 200 },
    });
    // Try to pull all 1000 creator shares — must be capped at cash − 1.2·Reserve.
    const res = await req('POST', `/markets/${id}/lp/withdraw`, {
      token: adminToken,
      body: { shares: 1000 },
    });
    expect(res.status).toBe(200);
    const { withdraw } = (await res.json()) as {
      withdraw: { cashOut: number; burned: number; partial: boolean; lp: LpView };
    };
    expect(withdraw.partial).toBe(true);
    expect(withdraw.cashOut).toBeGreaterThan(0);
    expect(withdraw.burned).toBeLessThan(1000);
    // Buffer preserved: remaining cash ≥ 1.2 × required reserve.
    const pool = withdraw.lp.pool;
    expect(pool.cash + 1e-2).toBeGreaterThanOrEqual(1.2 * pool.reserveRequired);
  });

  test('deposit on a non-open market → 409', async () => {
    const created = await req('POST', '/admin/markets', {
      token: adminToken,
      body: { title: 'LP closed (test)', ...STD, initialReserve: 10000 },
    });
    const { market } = (await created.json()) as { market: { marketId: string } };
    marketIds.push(market.marketId); // left CREATED
    const res = await req('POST', `/markets/${market.marketId}/lp/deposit`, {
      token: aliceToken,
      body: { amount: 1000 },
    });
    expect(res.status).toBe(409);
  });

  test('full lifecycle: deposit → trade → resolve → settle → LP claim reflects MM PnL', async () => {
    const id = await createOpenMarket(adminToken, {
      title: 'LP lifecycle (test)',
      ...STD,
      initialReserve: 10000,
    });
    const aliceBalBefore = await balanceOf(aliceToken);

    // Alice provides 5000 of liquidity (price 1 → 5000 shares of 15000 total).
    const dep = await req('POST', `/markets/${id}/lp/deposit`, {
      token: aliceToken,
      body: { amount: 5000 },
    });
    expect(dep.status).toBe(200);

    // Bob buys calls; the MM banks the premium.
    await req('POST', `/markets/${id}/trade`, {
      token: bobToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 20 },
    });

    // Resolve below the strike ⇒ calls expire worthless ⇒ trader payout 0
    // the MM keeps the spread+premium ⇒ LPs profit.
    await req('POST', `/admin/markets/${id}/resolve`, {
      token: adminToken,
      body: { thetaStar: 90 },
    });
    await req('POST', `/admin/markets/${id}/settle`, { token: adminToken });

    const c1 = await req('POST', `/markets/${id}/lp/claim`, { token: aliceToken });
    expect(c1.status).toBe(200);
    const claim1 = ((await c1.json()) as { claim: ClaimBody }).claim;
    expect(claim1.credited).toBeGreaterThan(5000); // got back more than deposited
    expect(claim1.pnl).toBeGreaterThan(0);
    expect(await balanceOf(aliceToken)).toBeCloseTo(aliceBalBefore - 5000 + claim1.credited, 3);

    // Idempotent: a second LP claim pays nothing.
    const c2 = await req('POST', `/markets/${id}/lp/claim`, { token: aliceToken });
    const claim2 = ((await c2.json()) as { claim: ClaimBody }).claim;
    expect(claim2.credited).toBe(0);
    expect(claim2.alreadyClaimed).toBe(true);

    // The creator's R₀ stake claims its share of the same cash_final.
    const cAdmin = await req('POST', `/markets/${id}/lp/claim`, { token: adminToken });
    const claimAdmin = ((await cAdmin.json()) as { claim: ClaimBody }).claim;
    expect(claimAdmin.credited).toBeGreaterThan(0);
    // Alice (5000 shares) + creator (10000) split the whole cash_final.
    expect(claim1.credited + claimAdmin.credited).toBeCloseTo(claim1.cashFinal, 2);
  });

  test('LP claim before settle → 409', async () => {
    const id = await createOpenMarket(adminToken, {
      title: 'LP early (test)',
      ...STD,
      initialReserve: 10000,
    });
    await req('POST', `/admin/markets/${id}/resolve`, {
      token: adminToken,
      body: { thetaStar: 100 },
    });
    const res = await req('POST', `/markets/${id}/lp/claim`, { token: adminToken });
    expect(res.status).toBe(409);
  });
});

interface ClaimBody {
  credited: number;
  pnl: number;
  alreadyClaimed: boolean;
  cashFinal: number;
}
