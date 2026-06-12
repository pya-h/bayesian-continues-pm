// hardening integration — the scenarios the earlier per-phase suites
// didn't yet cover end-to-end against the real DB via app.handle
// • solvency rejection — a buyer who can afford nothing is rejected (409), not
// half-filled into debt.
// • concurrency — N parallel trades on one market serialize with no lost
// updates: final position == Σ filled
// final cash == R₀ + Σ premiums.
// • cancel refund — cancelling an OPEN market refunds each trader's locked cost
// basis and shrinks MM cash.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, inArray, or } from 'drizzle-orm';
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
const POOR = 'poor_hardening_test';

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
    // Remove the throwaway pauper user (FKs are RESTRICT → children first).
    const rows = await db.select({ id: users.userId }).from(users).where(eq(users.username, POOR));
    for (const { id } of rows) {
      await db
        .delete(transactions)
        .where(or(eq(transactions.userId, id), eq(transactions.counterpartyId, id)));
      await db.delete(claims).where(eq(claims.userId, id));
      await db.delete(positions).where(eq(positions.userId, id));
      await db.delete(auditEvents).where(eq(auditEvents.actorId, id));
      await db.delete(users).where(eq(users.userId, id));
    }
    await db
      .update(users)
      .set({ balance: 10000 })
      .where(inArray(users.username, ['alice', 'bob']));
  }
  await sql.end();
});

describe.if(hasEnv)('Phase 11 hardening (integration)', () => {
  let adminToken = '';
  let aliceToken = '';

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    aliceToken = await login('alice', 'password');
    // Ensure a clean pauper (balance 0) — drop any leftover, then register fresh.
    const stale = await db.select({ id: users.userId }).from(users).where(eq(users.username, POOR));
    for (const { id } of stale) {
      await db
        .delete(transactions)
        .where(or(eq(transactions.userId, id), eq(transactions.counterpartyId, id)));
      await db.delete(positions).where(eq(positions.userId, id));
      await db.delete(auditEvents).where(eq(auditEvents.actorId, id));
      await db.delete(users).where(eq(users.userId, id));
    }
  });

  test('solvency: a zero-balance buyer is rejected (409), not filled into debt', async () => {
    const reg = await req('POST', '/auth/register', {
      body: { username: POOR, password: 'password' },
    });
    expect(reg.status).toBe(201);
    const poorToken = ((await reg.json()) as { token: string }).token;

    const id = await createOpenMarket(adminToken, {
      title: 'Solvency reject (test)',
      outcomeUnit: 'USD',
      initialMu: 100,
      initialSigma: 10,
      initialReserve: 10000,
    });

    const res = await req('POST', `/markets/${id}/trade`, {
      token: poorToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 50 },
    });
    expect(res.status).toBe(409); // can't afford even a sliver → gate rejects

    // Nothing moved: no trades, μ unchanged, cash still R₀.
    const after = await req('GET', `/markets/${id}`);
    const m = ((await after.json()) as { market: { cash: number; belief: { mu: number } } }).market;
    expect(m.cash).toBe(10000);
    expect(m.belief.mu).toBe(100);
  });

  test('concurrency: N parallel buys serialize with no lost updates', async () => {
    const id = await createOpenMarket(adminToken, {
      title: 'Concurrency (test)',
      outcomeUnit: 'USD',
      initialMu: 100,
      initialSigma: 10,
      initialReserve: 50000, // ample room so all fully fill
    });

    const N = 8;
    const qEach = 5;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        req('POST', `/markets/${id}/trade`, {
          token: aliceToken,
          body: { spec: { type: 'CALL', strike: 100 }, q: qEach },
        }),
      ),
    );
    const fills = await Promise.all(
      results.map(async (r) => {
        expect(r.status).toBe(200);
        return ((await r.json()) as { fill: { filledQ: number; totalCost: number } }).fill;
      }),
    );

    const totalFilled = fills.reduce((s, f) => s + f.filledQ, 0);
    const totalCost = fills.reduce((s, f) => s + f.totalCost, 0);
    expect(totalFilled).toBeCloseTo(N * qEach, 6); // every unit landed

    // Final market cash == R₀ + Σ premiums (no lost increments under the lock).
    const mkt = await req('GET', `/markets/${id}`);
    const cash = ((await mkt.json()) as { market: { cash: number } }).market.cash;
    expect(cash).toBeCloseTo(50000 + totalCost, 4);

    // Final authoritative position quantity == Σ filled (no lost writes).
    const pf = await req('GET', '/users/me/portfolio', { token: aliceToken });
    const positionsList = (
      (await pf.json()) as { portfolio: { positions: { marketId: string; quantity: number }[] } }
    ).portfolio.positions;
    const pos = positionsList.find((p) => p.marketId === id);
    expect(pos?.quantity).toBeCloseTo(N * qEach, 6);

    // Exactly N trades were recorded.
    const tradeRows = await db.select().from(trades).where(eq(trades.marketId, id));
    expect(tradeRows).toHaveLength(N);
  });

  test('cancel: refunds each trader the locked cost basis and shrinks MM cash', async () => {
    const id = await createOpenMarket(adminToken, {
      title: 'Cancel refund (test)',
      outcomeUnit: 'USD',
      initialMu: 100,
      initialSigma: 10,
      initialReserve: 10000,
    });

    const meBefore = await req('GET', '/auth/me', { token: aliceToken });
    const balBefore = ((await meBefore.json()) as { user: { balance: number } }).user.balance;

    const trade = await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 20 },
    });
    const fill = ((await trade.json()) as { fill: { totalCost: number; cash: number } }).fill;
    const cost = fill.totalCost; // premium alice paid (her locked cost basis)

    const meMid = await req('GET', '/auth/me', { token: aliceToken });
    const balMid = ((await meMid.json()) as { user: { balance: number } }).user.balance;
    expect(balMid).toBeCloseTo(balBefore - cost, 4); // debited

    const cancel = await req('POST', `/admin/markets/${id}/cancel`, { token: adminToken });
    expect(cancel.status).toBe(200);
    const cancelled = ((await cancel.json()) as { market: { status: string } }).market;
    expect(cancelled.status).toBe('CANCELLED');

    const meAfter = await req('GET', '/auth/me', { token: aliceToken });
    const balAfter = ((await meAfter.json()) as { user: { balance: number } }).user.balance;
    expect(balAfter).toBeCloseTo(balBefore, 4); // fully refunded

    // Pool cash is fully distributed: refund left first, then the remainder was
    // returned to LPs pro-rata, leaving the pool at 0.
    const mkt = await req('GET', `/markets/${id}`);
    const cash = ((await mkt.json()) as { market: { cash: number } }).market.cash;
    expect(cash).toBeCloseTo(0, 4);
  });
});
