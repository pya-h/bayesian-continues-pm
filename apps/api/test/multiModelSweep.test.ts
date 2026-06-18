// G6 — full multi-model × contracts integration sweep. For every belief model
// (Gaussian, Student-t, Mixture, Gen·basis, Gen·exact) and a representative
// extension contract, drive the whole lifecycle through the HTTP surface
// create → open → trade → resolve(θ*) → settle → claim
// and assert the trader's payout is exactly `filledQ · payoff(spec, θ*)` — i.e. the
// settlement/claim pipeline is kind-agnostic and the new contracts settle correctly.
// Hits the real DB; tears down all rows + restores balances afterward.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ContractSpec, payoff } from '@bmm/core';
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
      .where(inArray(users.username, ['alice', 'bob']));
  }
  await sql.end();
});

interface SweepCase {
  name: string;
  body: Record<string, unknown>;
  spec: ContractSpec;
  q: number;
  thetaStar: number;
}

const CASES: SweepCase[] = [
  {
    name: 'Gaussian × SKEW_GAUSSIAN',
    body: { outcomeUnit: 'USD', initialMu: 100, initialSigma: 10, initialReserve: 100000 },
    spec: { type: 'SKEW_GAUSSIAN', center: 105, widthLeft: 5, widthRight: 12 },
    q: 40,
    thetaStar: 108,
  },
  {
    name: 'Student-t × TENT',
    body: {
      outcomeUnit: 'USD',
      initialMu: 100,
      initialSigma: 10,
      initialReserve: 100000,
      belief: { kind: 'student_t', nu: 5 },
    },
    spec: { type: 'TENT', center: 100, width: 20 },
    q: 60,
    thetaStar: 95,
  },
  {
    name: 'Mixture × TRAPEZOID',
    body: {
      outcomeUnit: 'USD',
      initialMu: 100,
      initialSigma: 14,
      initialReserve: 100000,
      belief: {
        kind: 'mixture',
        components: [
          { pi: 0.6, mu: 96, sigma: 8 },
          { pi: 0.4, mu: 112, sigma: 10 },
        ],
      },
    },
    spec: { type: 'TRAPEZOID', lower: 95, upper: 110, width: 8 },
    q: 50,
    thetaStar: 103,
  },
  {
    name: 'Gen·basis × SIGMOID',
    body: {
      outcomeUnit: 'USD',
      initialMu: 50,
      initialSigma: 14,
      initialReserve: 100000,
      belief: { kind: 'gen_basis', bumps: [{ mu: 50, sigma: 14, weight: 1 }] },
    },
    spec: { type: 'SIGMOID', center: 50, width: 5 },
    q: 50,
    thetaStar: 55,
  },
  {
    name: 'Gen·exact × GAUSSIAN bell',
    body: {
      outcomeUnit: '°C',
      initialMu: 1.4,
      initialSigma: 0.6,
      initialReserve: 100000,
      belief: { kind: 'gen_exact', lambdas: [1, 0.25, 0.1] },
    },
    spec: { type: 'GAUSSIAN', center: 1.5, width: 0.3 },
    q: 60,
    thetaStar: 1.5,
  },
  {
    name: 'Bounded Gaussian × POLYNOMIAL (G5.2)',
    body: {
      outcomeUnit: '%',
      outcomeMin: 0,
      outcomeMax: 100,
      initialMu: 52,
      initialSigma: 9,
      initialReserve: 300000,
    },
    spec: { type: 'POLYNOMIAL', coeffs: [52 * 52, -2 * 52, 1] }, // (θ−52)²
    q: 2,
    thetaStar: 70,
  },
];

describe.if(hasEnv)('multi-model × contracts lifecycle sweep (integration)', () => {
  let adminToken = '';
  let aliceToken = '';

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    aliceToken = await login('alice', 'password');
  });

  for (const c of CASES) {
    test(`${c.name}: create → trade → resolve → settle → claim pays filledQ·f(θ*)`, async () => {
      const created = await req('POST', '/admin/markets', {
        token: adminToken,
        body: { title: `Sweep · ${c.name} (test)`, ...c.body },
      });
      expect([200, 201]).toContain(created.status);
      const id = ((await created.json()) as { market: { marketId: string } }).market.marketId;
      marketIds.push(id);
      await req('POST', `/admin/markets/${id}/open`, { token: adminToken });

      const buy = await req('POST', `/markets/${id}/trade`, {
        token: aliceToken,
        body: { spec: c.spec, q: c.q },
      });
      expect(buy.status).toBe(200);
      const { fill } = (await buy.json()) as { fill: { filledQ: number } };
      expect(fill.filledQ).toBeGreaterThan(0);

      const resolved = await req('POST', `/admin/markets/${id}/resolve`, {
        token: adminToken,
        body: { thetaStar: c.thetaStar },
      });
      expect(resolved.status).toBe(200);
      const settled = await req('POST', `/admin/markets/${id}/settle`, { token: adminToken });
      expect(settled.status).toBe(200);

      const claimed = await req('POST', `/markets/${id}/claim`, { token: aliceToken });
      expect(claimed.status).toBe(200);
      const claim = ((await claimed.json()) as { claim: { credited: number } }).claim;

      const expected = fill.filledQ * payoff(c.spec, c.thetaStar);
      expect(claim.credited).toBeCloseTo(expected, 4);
    });
  }
});
