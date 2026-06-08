// integration — quote + trade execution via app.handle. Hits the real
// DB; creates throwaway markets, trades against them, then tears down all rows and
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
    // Restore demo balances mutated by trading.
    await db
      .update(users)
      .set({ balance: 10000 })
      .where(inArray(users.username, ['alice', 'bob']));
  }
  await sql.end();
});

describe.if(hasEnv)('trade engine (integration)', () => {
  let adminToken = '';
  let aliceToken = '';

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    aliceToken = await login('alice', 'password');
  });

  test('quote returns fair, spread breakdown, projected belief/reserve', async () => {
    const id = await createOpenMarket(adminToken, {
      title: 'Quote mkt (test)',
      outcomeUnit: 'USD',
      initialMu: 100,
      initialSigma: 10,
      initialReserve: 10000,
    });
    const res = await req('POST', `/markets/${id}/quote`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 20 },
    });
    expect(res.status).toBe(200);
    const { quote } = (await res.json()) as {
      quote: {
        side: string;
        fair: number;
        spread: { total: number };
        execPrice: number;
        projectedBelief: { mu: number };
        projectedReserve: number;
        maxExecutable: number;
      };
    };
    expect(quote.side).toBe('buy');
    expect(quote.fair).toBeGreaterThan(0);
    expect(quote.spread.total).toBeGreaterThan(0);
    expect(quote.execPrice).toBeGreaterThan(quote.fair); // ask > fair
    expect(quote.projectedBelief.mu).toBeGreaterThan(100); // bullish call buy lifts μ
    expect(quote.projectedReserve).toBeGreaterThan(0);
    expect(quote.maxExecutable).toBe(20);
  });

  test('buy lifts μ, collects premium, opens reserve, records position', async () => {
    const id = await createOpenMarket(adminToken, {
      title: 'Buy mkt (test)',
      outcomeUnit: 'USD',
      initialMu: 100,
      initialSigma: 10,
      initialReserve: 10000,
    });

    const before = await req('GET', `/markets/${id}`);
    const cashBefore = ((await before.json()) as { market: { cash: number } }).market.cash;
    expect(cashBefore).toBe(10000);

    const res = await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 20 },
    });
    expect(res.status).toBe(200);
    const { fill } = (await res.json()) as {
      fill: {
        side: string;
        filledQ: number;
        partial: boolean;
        execPrice: number;
        beliefBefore: { mu: number };
        beliefAfter: { mu: number };
        cash: number;
        reserveRequired: number;
        balance: number;
        position: { quantity: number; avgEntryPrice: number };
      };
    };
    expect(fill.side).toBe('buy');
    expect(fill.filledQ).toBe(20);
    expect(fill.partial).toBe(false);
    expect(fill.beliefAfter.mu).toBeGreaterThan(fill.beliefBefore.mu); // μ moved up
    expect(fill.cash).toBeGreaterThan(10000); // premium collected
    expect(fill.reserveRequired).toBeGreaterThan(0); // risk opened
    expect(fill.position.quantity).toBe(20);
    expect(fill.position.avgEntryPrice).toBeCloseTo(fill.execPrice, 6);
    expect(fill.balance).toBeCloseTo(10000 - fill.execPrice * 20, 4); // debited
  });

  test('sell part of a holding reduces quantity and realizes PnL', async () => {
    const id = await createOpenMarket(adminToken, {
      title: 'Sell mkt (test)',
      outcomeUnit: 'USD',
      initialMu: 100,
      initialSigma: 10,
      initialReserve: 10000,
    });
    await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 30 },
    });
    const res = await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: -10 },
    });
    expect(res.status).toBe(200);
    const { fill } = (await res.json()) as {
      fill: { side: string; filledQ: number; position: { quantity: number; realizedPnl: number } };
    };
    expect(fill.side).toBe('sell');
    expect(fill.filledQ).toBe(-10);
    expect(fill.position.quantity).toBe(20); // 30 − 10
    expect(typeof fill.position.realizedPnl).toBe('number');
  });

  test('cannot sell a contract you do not hold → 400', async () => {
    const id = await createOpenMarket(adminToken, {
      title: 'No-hold mkt (test)',
      outcomeUnit: 'USD',
      initialMu: 100,
      initialSigma: 10,
      initialReserve: 10000,
    });
    const res = await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'PUT', strike: 100 }, q: -5 },
    });
    expect(res.status).toBe(400);
  });

  test('oversized trade is partially filled at the solvency frontier', async () => {
    const id = await createOpenMarket(adminToken, {
      title: 'Partial mkt (test)',
      outcomeUnit: 'USD',
      initialMu: 100,
      initialSigma: 10,
      initialReserve: 10, // tiny capacity
    });
    const res = await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'BINARY_CALL', strike: 100 }, q: 1000 },
    });
    expect(res.status).toBe(200);
    const { fill } = (await res.json()) as {
      fill: { partial: boolean; filledQ: number; reserveRequired: number; cash: number };
    };
    expect(fill.partial).toBe(true);
    expect(fill.filledQ).toBeGreaterThan(0);
    expect(fill.filledQ).toBeLessThan(1000); // capped well below request
    // gate held: effectiveCash (pre-premium) ≥ 1.2 × reserve ⇒ ~10 ≥ 1.2·reserve
    expect(1.2 * fill.reserveRequired).toBeLessThanOrEqual(10 + 1e-3);
  });

  test('trade against a non-open market → 409', async () => {
    const created = await req('POST', '/admin/markets', {
      token: adminToken,
      body: {
        title: 'Closed mkt (test)',
        outcomeUnit: 'USD',
        initialMu: 100,
        initialSigma: 10,
        initialReserve: 10000,
      },
    });
    const { market } = (await created.json()) as { market: { marketId: string } };
    marketIds.push(market.marketId);
    // left in CREATED (never opened)
    const res = await req('POST', `/markets/${market.marketId}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 5 },
    });
    expect(res.status).toBe(409);
  });

  test('unauthenticated trade → 401', async () => {
    const id = marketIds[0];
    const res = await req('POST', `/markets/${id}/trade`, {
      body: { spec: { type: 'CALL', strike: 100 }, q: 5 },
    });
    expect(res.status).toBe(401);
  });
});
