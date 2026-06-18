// integration — Gen·exact markets. A Gen·exact market stores a `gen_exact`
// belief (max-entropy exp(−poly)) carrying a `model = 'gen_exact'` tag. It prices
// via quadrature, trades (the v2 shape-adapting update moves μ toward the signal and
// lets (λ₃,λ₄) adapt while λ₂ is held), and round-trips through the DB. Hits the real DB.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GenExactBelief, price } from '@bmm/core';
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

describe.if(hasEnv)('gen_exact market (G2.4 integration)', () => {
  let adminToken = '';
  let aliceToken = '';

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    aliceToken = await login('alice', 'password');
  });

  async function createMarket(body: Record<string, unknown>): Promise<string> {
    const res = await req('POST', '/admin/markets', { token: adminToken, body });
    expect([200, 201]).toContain(res.status);
    const { market } = (await res.json()) as { market: { marketId: string } };
    marketIds.push(market.marketId);
    return market.marketId;
  }

  test('persists a gen_exact belief + model tag and exposes λ/loc/scale in the view', async () => {
    const id = await createMarket({
      title: 'Gen·exact (test)',
      outcomeUnit: 'USD',
      initialMu: 70,
      initialSigma: 10,
      initialReserve: 10000,
      belief: { kind: 'gen_exact', lambdas: [1, 0.2, 0.1] },
    });

    const row = (await db.select().from(markets).where(eq(markets.marketId, id)))[0];
    expect(row?.model).toBe('gen_exact');
    expect(row?.beliefKind).toBe('gen_exact');
    expect(row?.beliefState?.kind).toBe('gen_exact');

    const view = await req('GET', `/markets/${id}`, { token: aliceToken });
    const { market: mv } = (await view.json()) as {
      market: {
        model: string;
        belief: { kind: string; lambdas?: number[]; loc?: number; scale?: number };
      };
    };
    expect(mv.model).toBe('gen_exact');
    expect(mv.belief.kind).toBe('gen_exact');
    expect(mv.belief.lambdas).toEqual([1, 0.2, 0.1]);
    expect(mv.belief.loc).toBeCloseTo(70, 6);
    expect(mv.belief.scale).toBeCloseTo(10, 6);
  });

  test('rejects out-of-range λ at create (sandbox-safe bounds)', async () => {
    const res = await req('POST', '/admin/markets', {
      token: adminToken,
      body: {
        title: 'bad λ',
        outcomeUnit: 'USD',
        initialMu: 70,
        initialSigma: 10,
        initialReserve: 10000,
        belief: { kind: 'gen_exact', lambdas: [9, 0, 0] },
      },
    });
    expect(res.status).toBe(400);
  });

  test('a buy stream moves μ toward the signal under the shape-adapting v2 update', async () => {
    const id = await createMarket({
      title: 'Gen·exact trade (test)',
      outcomeUnit: 'USD',
      initialMu: 70,
      initialSigma: 10,
      initialReserve: 10000,
      belief: { kind: 'gen_exact', lambdas: [1, 0.2, 0.1] },
    });
    await req('POST', `/admin/markets/${id}/open`, { token: adminToken });

    const before = (await db.select().from(markets).where(eq(markets.marketId, id)))[0];
    const muBefore = before?.currentMu ?? 0;

    // Repeated upward CALL buys push the implied signal above the mean.
    for (let i = 0; i < 6; i++) {
      const r = await req('POST', `/markets/${id}/trade`, {
        token: aliceToken,
        body: { spec: { type: 'CALL', strike: 90 }, q: 50 },
      });
      expect(r.status).toBe(200);
    }

    const after = (await db.select().from(markets).where(eq(markets.marketId, id)))[0];
    expect(after?.currentMu ?? 0).toBeGreaterThan(muBefore); // μ moved up
    expect(after?.beliefState?.kind).toBe('gen_exact'); // shape kind preserved
    // v2 moment-projection (I4): λ₂ (the creator's unimodal/bimodal choice) is held
    // (λ₃,λ₄) adapt but stay within the sandbox-safe ranges; the moment cache persists.
    const st = after?.beliefState as {
      lambdas: [number, number, number];
      moments?: { z: number };
    };
    expect(st.lambdas[0]).toBe(1); // λ₂ preserved
    expect(st.lambdas[1]).toBeGreaterThanOrEqual(-0.35);
    expect(st.lambdas[1]).toBeLessThanOrEqual(0.35);
    expect(st.lambdas[2]).toBeGreaterThanOrEqual(0);
    expect(st.lambdas[2]).toBeLessThanOrEqual(1.6);
    expect(st.moments?.z).toBeGreaterThan(0); // I3 cache round-trips through the DB
  });

  test('the view quote matches an independent price() of the reconstructed belief', async () => {
    const id = await createMarket({
      title: 'Gen·exact quote (test)',
      outcomeUnit: 'USD',
      initialMu: 0,
      initialSigma: 1,
      initialReserve: 10000,
      belief: { kind: 'gen_exact', lambdas: [1, 0, 0.3] },
    });
    const res = await req('POST', `/markets/${id}/quote`, {
      token: aliceToken,
      body: { spec: { type: 'BINARY_CALL', strike: 0.5 }, q: 1 },
    });
    expect(res.status).toBe(200);
    const { quote } = (await res.json()) as { quote: { fair: number } };
    const ref = price({ type: 'BINARY_CALL', strike: 0.5 }, new GenExactBelief(0, 1, [1, 0, 0.3]));
    expect(Math.abs(quote.fair - ref)).toBeLessThan(1e-6);
  });
});
