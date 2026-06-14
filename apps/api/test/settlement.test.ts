// integration — settlement & trader claims via app.handle. Hits the real
// DB; creates throwaway markets, trades/resolves/settles/cancels against them, then
// tears down all rows and restores trader balances.

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

const STD = { outcomeUnit: 'USD', initialMu: 100, initialSigma: 10, initialReserve: 100000 };

afterAll(async () => {
  if (hasEnv && marketIds.length) {
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

describe.if(hasEnv)('settlement & claims (integration)', () => {
  let adminToken = '';
  let aliceToken = '';

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    aliceToken = await login('alice', 'password');
  });

  test('resolve → settle → claim credits the payout exactly once', async () => {
    const id = await createOpenMarket(adminToken, { title: 'Settle mkt (test)', ...STD });

    const buyRes = await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 20 },
    });
    const { fill } = (await buyRes.json()) as { fill: { filledQ: number; balance: number } };
    expect(fill.filledQ).toBe(20);
    const balAfterBuy = fill.balance;

    // θ* = 130 ⇒ CALL(100) pays 30/unit ⇒ 20 units → 600.
    const resolved = await req('POST', `/admin/markets/${id}/resolve`, {
      token: adminToken,
      body: { thetaStar: 130 },
    });
    expect(resolved.status).toBe(200);
    const settled = await req('POST', `/admin/markets/${id}/settle`, { token: adminToken });
    expect(settled.status).toBe(200);

    const c1 = await req('POST', `/markets/${id}/claim`, { token: aliceToken });
    expect(c1.status).toBe(200);
    const claim1 = ((await c1.json()) as { claim: ClaimBody }).claim;
    expect(claim1.credited).toBeCloseTo(600, 6);
    expect(claim1.alreadyClaimed).toBe(false);
    expect(claim1.balance).toBeCloseTo(balAfterBuy + 600, 4);

    // Idempotent: a second claim pays nothing.
    const c2 = await req('POST', `/markets/${id}/claim`, { token: aliceToken });
    const claim2 = ((await c2.json()) as { claim: ClaimBody }).claim;
    expect(claim2.credited).toBe(0);
    expect(claim2.alreadyClaimed).toBe(true);
    expect(claim2.balance).toBeCloseTo(balAfterBuy + 600, 4);
  });

  test('claim still works after the market is CLOSED (archival does not strand payouts, C43)', async () => {
    const id = await createOpenMarket(adminToken, { title: 'Close-then-claim (test)', ...STD });

    const buyRes = await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 20 },
    });
    const { fill } = (await buyRes.json()) as { fill: { balance: number } };
    const balAfterBuy = fill.balance;

    await req('POST', `/admin/markets/${id}/resolve`, { token: adminToken, body: { thetaStar: 130 } });
    await req('POST', `/admin/markets/${id}/settle`, { token: adminToken });
    // Admin archives BEFORE alice claims her 600.
    const closed = await req('POST', `/admin/markets/${id}/close`, { token: adminToken });
    expect(closed.status).toBe(200);

    const c = await req('POST', `/markets/${id}/claim`, { token: aliceToken });
    expect(c.status).toBe(200);
    const claim = ((await c.json()) as { claim: ClaimBody }).claim;
    expect(claim.credited).toBeCloseTo(600, 6);
    expect(claim.balance).toBeCloseTo(balAfterBuy + 600, 4);
  });

  test('claim before settle (RESOLVED) → 409', async () => {
    const id = await createOpenMarket(adminToken, { title: 'NotSettled mkt (test)', ...STD });
    await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 5 },
    });
    await req('POST', `/admin/markets/${id}/resolve`, {
      token: adminToken,
      body: { thetaStar: 120 },
    });
    const res = await req('POST', `/markets/${id}/claim`, { token: aliceToken });
    expect(res.status).toBe(409);
  });

  test('claiming with no position is a 0-credit no-op', async () => {
    const id = await createOpenMarket(adminToken, { title: 'Empty mkt (test)', ...STD });
    await req('POST', `/admin/markets/${id}/resolve`, {
      token: adminToken,
      body: { thetaStar: 100 },
    });
    await req('POST', `/admin/markets/${id}/settle`, { token: adminToken });
    const res = await req('POST', `/markets/${id}/claim`, { token: aliceToken });
    expect(res.status).toBe(200);
    const claim = ((await res.json()) as { claim: ClaimBody }).claim;
    expect(claim.credited).toBe(0);
    expect(claim.alreadyClaimed).toBe(false);
  });

  test('cancel refunds the open cost basis to the trader', async () => {
    const id = await createOpenMarket(adminToken, { title: 'Cancel mkt (test)', ...STD });
    const balBefore = await balanceOf(aliceToken);

    const buyRes = await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 10 },
    });
    const { fill } = (await buyRes.json()) as { fill: { balance: number } };
    expect(fill.balance).toBeLessThan(balBefore); // debited on buy

    const cancelled = await req('POST', `/admin/markets/${id}/cancel`, { token: adminToken });
    expect(cancelled.status).toBe(200);

    const balAfter = await balanceOf(aliceToken);
    expect(balAfter).toBeCloseTo(balBefore, 4); // cost basis returned
  });
});

interface ClaimBody {
  credited: number;
  payout: number;
  alreadyClaimed: boolean;
  balance: number | null;
}
