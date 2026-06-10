// Integration — POST /markets/:id/sell-all. Liquidates every open position in a
// market in one atomic call. Drives the real app via app.handle against the real
// DB: a multi-contract holding must close in one shot, credit the trader, reduce
// the pool, and leave the admin ledger reconciling.
// Requires DATABASE_URL + ADMIN_PASSWORD (loaded via the test script's --env-file).

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
  transactions,
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
const STD = { outcomeUnit: 'USD', initialMu: 100, initialSigma: 10, initialReserve: 10000 };

async function login(username: string, password: string): Promise<string> {
  const res = await req('POST', '/auth/login', { body: { username, password } });
  return ((await res.json()) as { token: string }).token;
}

async function createOpenMarket(token: string, title: string): Promise<string> {
  const created = await req('POST', '/admin/markets', { token, body: { title, ...STD } });
  const { market } = (await created.json()) as { market: { marketId: string } };
  marketIds.push(market.marketId);
  await req('POST', `/admin/markets/${market.marketId}/open`, { token });
  return market.marketId;
}

async function marketCash(id: string): Promise<number> {
  const res = await req('GET', `/markets/${id}`);
  return ((await res.json()) as { market: { cash: number } }).market.cash;
}

interface SellAllResult {
  marketId: string;
  count: number;
  fills: { quantity: number; execPrice: number; proceeds: number; realizedPnl: number }[];
  totalProceeds: number;
  totalRealizedPnl: number;
  cash: number;
  reserveRequired: number;
  balance: number | null;
  beliefAfter: { mu: number; sigma: number };
}

afterAll(async () => {
  if (hasEnv) {
    for (const id of marketIds) {
      await db.delete(transactions).where(eq(transactions.marketId, id));
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

describe.if(hasEnv)('sell-all (integration)', () => {
  let adminToken = '';
  let aliceToken = '';

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    aliceToken = await login('alice', 'password');
  });

  test('liquidates every position in one call, credits the trader, reduces the pool', async () => {
    const id = await createOpenMarket(adminToken, 'Sell-all multi (test)');
    // Two distinct contracts → two positions to close.
    await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 20 },
    });
    await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 110 }, q: 15 },
    });
    const cashBefore = await marketCash(id);

    const res = await req('POST', `/markets/${id}/sell-all`, { token: aliceToken });
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: SellAllResult };

    expect(result.count).toBe(2);
    expect(result.fills).toHaveLength(2);
    expect(result.totalProceeds).toBeGreaterThan(0);
    expect(typeof result.totalRealizedPnl).toBe('number');
    // Selling back to the MM pays out of the pool → cash drops.
    expect(result.cash).toBeLessThan(cashBefore);
    // The pool only grew from alice's two premiums, so her pre-sell balance was
    // 10000 − (cashBefore − 10000); sell-all credits exactly totalProceeds on top.
    const balanceBefore = 10000 - (cashBefore - 10000);
    expect(result.balance).toBeCloseTo(balanceBefore + result.totalProceeds, 4);

    // Every position in this market is now flat.
    const port = await req('GET', '/users/me/portfolio', { token: aliceToken });
    const { portfolio } = (await port.json()) as {
      portfolio: { positions: { marketId: string; quantity: number }[] };
    };
    const here = portfolio.positions.filter((p) => p.marketId === id);
    for (const p of here) expect(Math.abs(p.quantity)).toBeLessThan(1e-6);

    // Nothing left to liquidate → 400 on a second call.
    const again = await req('POST', `/markets/${id}/sell-all`, { token: aliceToken });
    expect(again.status).toBe(400);
  });

  test('the admin ledger still reconciles after a sell-all', async () => {
    const id = await createOpenMarket(adminToken, 'Sell-all ledger (test)');
    await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 18 },
    });
    await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'BINARY_CALL', strike: 105 }, q: 10 },
    });
    await req('POST', `/markets/${id}/sell-all`, { token: aliceToken });

    const led = await req('GET', `/admin/markets/${id}/ledger`, { token: adminToken });
    const { ledger } = (await led.json()) as {
      ledger: { rollup: { reconciles: boolean; tradeCount: number; premiumOut: number } };
    };
    expect(ledger.rollup.reconciles).toBe(true);
    // 2 buys + 2 sells = 4 trades; the sells show as premium leaving the pool.
    expect(ledger.rollup.tradeCount).toBe(4);
    expect(ledger.rollup.premiumOut).toBeGreaterThan(0);
  });

  test('sell-all with no open positions → 400', async () => {
    const id = await createOpenMarket(adminToken, 'Sell-all empty (test)');
    const res = await req('POST', `/markets/${id}/sell-all`, { token: aliceToken });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/no open positions/i);
  });

  test('sell-all on a non-open market → 409', async () => {
    const created = await req('POST', '/admin/markets', {
      token: adminToken,
      body: { title: 'Sell-all closed (test)', ...STD },
    });
    const { market } = (await created.json()) as { market: { marketId: string } };
    marketIds.push(market.marketId);
    // left in CREATED (never opened)
    const res = await req('POST', `/markets/${market.marketId}/sell-all`, { token: aliceToken });
    expect(res.status).toBe(409);
  });

  test('unauthenticated sell-all → 401', async () => {
    const id = marketIds[0];
    const res = await req('POST', `/markets/${id}/sell-all`);
    expect(res.status).toBe(401);
  });
});
