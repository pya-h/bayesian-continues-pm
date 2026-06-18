// integration — the bounded shape-extension contracts (SKEW_GAUSSIAN, TENT
// TRAPEZOID, SIGMOID) quote, trade and persist end-to-end. Each quote's fair is
// cross-checked against the core `price` (the engine of record) and bounded in
// [0,1]; one is actually executed to prove the contract row + trade path accept it.
// Hits the real DB; tears down its rows afterward.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ContractSpec, GaussianBelief, price } from '@bmm/core';
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
      .where(inArray(users.username, ['alice']));
  }
  await sql.end();
});

describe.if(hasEnv)('G5.1 shape-extension contracts (integration)', () => {
  let adminToken = '';
  let aliceToken = '';
  let marketId = '';
  // The market belief is N(100, 12²).
  const belief = new GaussianBelief(100, 144);

  const SPECS: ContractSpec[] = [
    { type: 'SKEW_GAUSSIAN', center: 104, widthLeft: 6, widthRight: 16 },
    { type: 'TENT', center: 98, width: 20 },
    { type: 'TRAPEZOID', lower: 92, upper: 110, width: 10 },
    { type: 'SIGMOID', center: 100, width: 5 },
  ];

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    aliceToken = await login('alice', 'password');
    const created = await req('POST', '/admin/markets', {
      token: adminToken,
      body: {
        title: 'Shape-extensions mkt (test)',
        outcomeUnit: 'USD',
        initialMu: 100,
        initialSigma: 12,
        initialReserve: 10000,
      },
    });
    expect([200, 201]).toContain(created.status);
    const { market } = (await created.json()) as { market: { marketId: string } };
    marketId = market.marketId;
    marketIds.push(marketId);
    await req('POST', `/admin/markets/${marketId}/open`, { token: adminToken });
  });

  for (const spec of SPECS) {
    test(`${spec.type}: quote fair matches core price() and is bounded`, async () => {
      const res = await req('POST', `/markets/${marketId}/quote`, {
        token: aliceToken,
        body: { spec, q: 10 },
      });
      expect(res.status).toBe(200);
      const { quote } = (await res.json()) as { quote: { fair: number } };
      expect(quote.fair).toBeGreaterThanOrEqual(0);
      expect(quote.fair).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.abs(quote.fair - price(spec, belief))).toBeLessThan(1e-6);
    });
  }

  test('a SKEW_GAUSSIAN buy executes and persists a contract row', async () => {
    const spec = SPECS[0] as ContractSpec;
    const res = await req('POST', `/markets/${marketId}/trade`, {
      token: aliceToken,
      body: { spec, q: 30 },
    });
    expect(res.status).toBe(200);

    const rows = await db.select().from(contracts).where(eq(contracts.marketId, marketId));
    const row = rows.find((r) => r.type === 'SKEW_GAUSSIAN');
    expect(row).toBeDefined();
    expect(row?.params).toMatchObject({ center: 104, widthLeft: 6, widthRight: 16 });
  });
});
