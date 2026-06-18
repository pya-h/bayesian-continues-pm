// integration — the conditionally-compatible unbounded contracts
// (POLYNOMIAL, EXPONENTIAL) and the belief↔contract compatibility guard.
// On a bounded-outcome Gaussian market: both quote (fair == core price)
// and a POLYNOMIAL buy executes + persists its coeffs (c0,c1,… params).
// On an UNBOUNDED Gaussian market: both are rejected (400, "bounded-outcome").
// On a bounded Student-t market: EXPONENTIAL is rejected (infinite price)
// a low-degree POLYNOMIAL (deg < ν) is accepted, a high-degree one (deg ≥ ν)
// is rejected.
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

async function createMarket(token: string, body: Record<string, unknown>): Promise<string> {
  const created = await req('POST', '/admin/markets', { token, body });
  expect([200, 201]).toContain(created.status);
  const { market } = (await created.json()) as { market: { marketId: string } };
  marketIds.push(market.marketId);
  await req('POST', `/admin/markets/${market.marketId}/open`, { token });
  return market.marketId;
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

describe.if(hasEnv)('G5.2 unbounded contracts + compatibility guard (integration)', () => {
  let adminToken = '';
  let aliceToken = '';
  let boundedGaussian = '';
  let unboundedGaussian = '';
  let boundedStudentT = '';

  // Bounded Gaussian market belief N(100, 12²) for the core cross-check.
  const belief = new GaussianBelief(100, 144);
  const poly: ContractSpec = { type: 'POLYNOMIAL', coeffs: [0, 0, 1] }; // θ²
  const expo: ContractSpec = { type: 'EXPONENTIAL', center: 100, rate: 0.02 };

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    aliceToken = await login('alice', 'password');
    boundedGaussian = await createMarket(adminToken, {
      title: 'G5.2 bounded gaussian (test)',
      outcomeUnit: 'USD',
      outcomeMin: 40,
      outcomeMax: 160,
      initialMu: 100,
      initialSigma: 12,
      initialReserve: 100000,
    });
    unboundedGaussian = await createMarket(adminToken, {
      title: 'G5.2 unbounded gaussian (test)',
      outcomeUnit: 'USD',
      initialMu: 100,
      initialSigma: 12,
      initialReserve: 100000,
    });
    boundedStudentT = await createMarket(adminToken, {
      title: 'G5.2 bounded student-t (test)',
      outcomeUnit: 'USD',
      outcomeMin: 40,
      outcomeMax: 160,
      initialMu: 100,
      initialSigma: 12,
      initialReserve: 100000,
      belief: { kind: 'student_t', nu: 3 },
    });
  });

  test('bounded Gaussian: POLYNOMIAL & EXPONENTIAL quote == core price()', async () => {
    for (const spec of [poly, expo]) {
      const res = await req('POST', `/markets/${boundedGaussian}/quote`, {
        token: aliceToken,
        body: { spec, q: 5 },
      });
      expect(res.status).toBe(200);
      const { quote } = (await res.json()) as { quote: { fair: number } };
      expect(Math.abs(quote.fair - price(spec, belief))).toBeLessThan(1e-6);
    }
  });

  test('bounded Gaussian: a POLYNOMIAL buy executes and persists its coeffs', async () => {
    const res = await req('POST', `/markets/${boundedGaussian}/trade`, {
      token: aliceToken,
      body: { spec: poly, q: 2 },
    });
    expect(res.status).toBe(200);
    const rows = await db.select().from(contracts).where(eq(contracts.marketId, boundedGaussian));
    const row = rows.find((r) => r.type === 'POLYNOMIAL');
    expect(row).toBeDefined();
    expect(row?.params).toMatchObject({ c0: 0, c1: 0, c2: 1 });
  });

  test('unbounded Gaussian: both rejected (400, bounded-outcome required)', async () => {
    for (const spec of [poly, expo]) {
      const res = await req('POST', `/markets/${unboundedGaussian}/quote`, {
        token: aliceToken,
        body: { spec, q: 5 },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string; message?: string };
      expect(JSON.stringify(body)).toMatch(/bounded-outcome/);
    }
  });

  test('bounded Student-t: EXPONENTIAL rejected (infinite price)', async () => {
    const res = await req('POST', `/markets/${boundedStudentT}/quote`, {
      token: aliceToken,
      body: { spec: expo, q: 5 },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/Student-t|infinite price/);
  });

  test('bounded Student-t (ν=3): degree-2 POLYNOMIAL accepted, degree-4 rejected', async () => {
    const ok = await req('POST', `/markets/${boundedStudentT}/quote`, {
      token: aliceToken,
      body: { spec: { type: 'POLYNOMIAL', coeffs: [0, 0, 1] }, q: 5 },
    });
    expect(ok.status).toBe(200);

    const bad = await req('POST', `/markets/${boundedStudentT}/quote`, {
      token: aliceToken,
      body: { spec: { type: 'POLYNOMIAL', coeffs: [0, 0, 0, 0, 1] }, q: 5 },
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toMatch(/infinite moment|degree < ν/);
  });
});
