// Integration — LP recovery paths: cancel returns
// pool cash to LPs pro-rata, and an emptied pool (S_total = 0) accepts a genesis
// re-deposit instead of bricking the market. Hits the real DB; creates throwaway
// markets, then tears down all rows and restores trader balances.

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

const STD = { outcomeUnit: 'USD', initialMu: 100, initialSigma: 10 };

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

describe.if(hasEnv)('LP recovery paths (integration)', () => {
  let adminToken = '';
  let aliceToken = '';

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    aliceToken = await login('alice', 'password');
  });

  test('cancel returns pool cash to LPs pro-rata and never books negative cash (C9/C15)', async () => {
    const id = await createOpenMarket(adminToken, {
      title: 'LP cancel refund (test)',
      ...STD,
      initialReserve: 10000,
    });
    const balBefore = await balanceOf(aliceToken);

    const dep = await req('POST', `/markets/${id}/lp/deposit`, {
      token: aliceToken,
      body: { amount: 5000 },
    });
    expect(dep.status).toBe(200);
    expect(await balanceOf(aliceToken)).toBeCloseTo(balBefore - 5000, 4);

    const cancel = await req('POST', `/admin/markets/${id}/cancel`, { token: adminToken });
    expect(cancel.status).toBe(200);

    // No trades happened, so alice's pro-rata cut of the pool = her deposit.
    expect(await balanceOf(aliceToken)).toBeCloseTo(balBefore, 4);

    // Pool fully distributed, never negative; positions marked claimed.
    const mrow = (await db.select().from(markets).where(eq(markets.marketId, id)))[0];
    expect(mrow?.status).toBe('CANCELLED');
    expect(mrow?.cash ?? -1).toBeCloseTo(0, 6);
    expect((mrow?.cash ?? -1) >= 0).toBe(true);
    const lps = await db.select().from(lpPositions).where(eq(lpPositions.marketId, id));
    expect(lps.length).toBe(2); // creator + alice
    for (const lp of lps) expect(lp.claimed).toBe(true);

    // Cancel distribution is ledgered as LP_CLAIM rows.
    const txRows = await db.select().from(transactions).where(eq(transactions.marketId, id));
    const lpClaims = txRows.filter((t) => t.kind === 'lp_claim');
    expect(lpClaims.length).toBe(2);
  });

  test('cancel with open positions still refunds traders first, then LPs (C9)', async () => {
    const id = await createOpenMarket(adminToken, {
      title: 'LP cancel after trade (test)',
      ...STD,
      initialReserve: 10000,
    });
    const balBefore = await balanceOf(aliceToken);

    await req('POST', `/markets/${id}/lp/deposit`, { token: aliceToken, body: { amount: 3000 } });
    const trade = await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 20 },
    });
    expect(trade.status).toBe(200);

    const cancel = await req('POST', `/admin/markets/${id}/cancel`, { token: adminToken });
    expect(cancel.status).toBe(200);

    // Trader refund (cost basis) + LP distribution should make alice ~whole again
    // (she pockets the spread the pool collected on her own fill, pro-rata).
    const balAfter = await balanceOf(aliceToken);
    expect(balAfter).toBeGreaterThan(balBefore - 1); // not stranded
    const mrow = (await db.select().from(markets).where(eq(markets.marketId, id)))[0];
    expect((mrow?.cash ?? -1) >= 0).toBe(true);
  });

  test('emptied pool accepts a genesis re-deposit instead of bricking (C11)', async () => {
    const id = await createOpenMarket(adminToken, {
      title: 'LP re-genesis (test)',
      ...STD,
      initialReserve: 10000,
    });

    // Creator (admin) burns ALL genesis shares — no open risk, so the solvency
    // buffer allows a full withdrawal: cash = 0, sharesTotal = 0, market OPEN.
    const wd = await req('POST', `/markets/${id}/lp/withdraw`, {
      token: adminToken,
      body: { shares: 10000 },
    });
    expect(wd.status).toBe(200);
    const empty = (await db.select().from(markets).where(eq(markets.marketId, id)))[0];
    expect(empty?.lpSharesTotal ?? -1).toBeCloseTo(0, 6);
    expect(empty?.cash ?? -1).toBeCloseTo(0, 6);

    // Genesis re-deposit: mints at share price 1 (was: 409 forever / 0 shares).
    const balBefore = await balanceOf(aliceToken);
    const dep = await req('POST', `/markets/${id}/lp/deposit`, {
      token: aliceToken,
      body: { amount: 4000 },
    });
    expect(dep.status).toBe(200);
    const { deposit } = (await dep.json()) as {
      deposit: { minted: number; lp: { pool: { sharesTotal: number; cash: number } } };
    };
    expect(deposit.minted).toBeCloseTo(4000, 4);
    expect(deposit.lp.pool.sharesTotal).toBeCloseTo(4000, 4);
    expect(deposit.lp.pool.cash).toBeCloseTo(4000, 4);
    expect(await balanceOf(aliceToken)).toBeCloseTo(balBefore - 4000, 4);

    // The revived pool backs trading again.
    const trade = await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 5 },
    });
    expect(trade.status).toBe(200);
  });
});
