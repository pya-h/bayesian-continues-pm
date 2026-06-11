// fast-follow integration — create a Student-t market (heavy tails, finite
// variance) from the admin create path, verify it persists with its ν/μ/scale²
// and that a quote prices consistently with a Monte-Carlo estimate under the same
// t belief. Hits the real DB; tears down all rows and restores balances after.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Rng, StudentTBelief, payoff } from '@bmm/core';
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

describe.if(hasEnv)('student-t market (V2-1 fast-follow integration)', () => {
  let adminToken = '';
  let aliceToken = '';
  const NU = 5;
  const MU = 70;
  const SIGMA = 14;

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    aliceToken = await login('alice', 'password');
  });

  test('create a student-t market; belief persists with ν/μ/scale²', async () => {
    const created = await req('POST', '/admin/markets', {
      token: adminToken,
      body: {
        title: 'Student-t mkt (test)',
        outcomeUnit: 'USD',
        initialMu: MU,
        initialSigma: SIGMA,
        initialReserve: 10000,
        belief: { kind: 'student_t', nu: NU },
      },
    });
    expect([200, 201]).toContain(created.status);
    const { market } = (await created.json()) as { market: { marketId: string } };
    marketIds.push(market.marketId);

    // Persisted belief_state carries the t params; current_mu = location μ; the
    // scale² is variance·(ν−2)/ν (so the stddev is exactly the authored σ).
    const row = (await db.select().from(markets).where(eq(markets.marketId, market.marketId)))[0];
    expect(row?.beliefKind).toBe('student_t');
    expect(row?.beliefState?.kind).toBe('student_t');
    const st = row?.beliefState as { kind: 'student_t'; nu: number; mu: number; scale2: number };
    expect(st.nu).toBe(NU);
    expect(Math.abs(st.mu - MU)).toBeLessThan(1e-6);
    expect(Math.abs(st.scale2 - (SIGMA * SIGMA * (NU - 2)) / NU)).toBeLessThan(1e-6);
    expect(Math.abs((row?.currentMu ?? 0) - MU)).toBeLessThan(1e-6);
    // Summary stddev equals the authored σ.
    expect(Math.abs((row?.currentSigma ?? 0) - SIGMA)).toBeLessThan(1e-6);

    const view = await req('GET', `/markets/${market.marketId}`, { token: aliceToken });
    const { market: mv } = (await view.json()) as { market: { belief: { kind: string } } };
    expect(mv.belief.kind).toBe('student_t');
  });

  test('quote fair on the student-t matches a Monte-Carlo estimate', async () => {
    const id = marketIds[0] as string;
    await req('POST', `/admin/markets/${id}/open`, { token: adminToken });

    const spec = { type: 'BINARY_CALL', strike: 85 } as const;
    const res = await req('POST', `/markets/${id}/quote`, {
      token: aliceToken,
      body: { spec, q: 20 },
    });
    expect(res.status).toBe(200);
    const { quote } = (await res.json()) as { quote: { fair: number } };

    // Independent MC of E[payoff] under the same location-scale t belief.
    const t = StudentTBelief.fromVariance(NU, MU, SIGMA * SIGMA);
    const draws = t.sample(400_000, new Rng(0xc0ffee));
    let s = 0;
    for (const d of draws) s += payoff(spec, d);
    const mc = s / draws.length;
    expect(Math.abs(quote.fair - mc)).toBeLessThan(0.02);
  });

  test('trading updates the t belief (ν fixed) and drifts μ toward the order flow', async () => {
    const id = marketIds[0] as string;

    const before = (await db.select().from(markets).where(eq(markets.marketId, id)))[0] as {
      currentMu: number;
      beliefState: { kind: string; nu: number };
    };

    // A bullish call stream above μ pulls the location up; the belief stays a t.
    for (let i = 0; i < 5; i++) {
      const r = await req('POST', `/markets/${id}/trade`, {
        token: aliceToken,
        body: { spec: { type: 'CALL', strike: 90 }, q: 40 },
      });
      expect(r.status).toBe(200);
    }

    const after = (await db.select().from(markets).where(eq(markets.marketId, id)))[0] as {
      currentMu: number;
      beliefKind: string;
      beliefState: { kind: string; nu: number };
    };

    expect(after.beliefKind).toBe('student_t');
    expect(after.beliefState.kind).toBe('student_t');
    expect(after.beliefState.nu).toBe(NU); // tail weight unchanged
    expect(after.currentMu).toBeGreaterThan(before.currentMu); // learned upward
  });
});
