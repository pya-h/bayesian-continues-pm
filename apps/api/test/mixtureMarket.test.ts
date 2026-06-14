// integration — create a bimodal MIXTURE market, verify it persists, prices
// consistently with a Monte-Carlo estimate, and that trading shifts the component
// weights toward the side the order flow favors. Hits the real DB; tears down all
// rows and restores trader balances afterward.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MixtureBelief, payoff } from '@bmm/core';
import { Rng } from '@bmm/core';
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

describe.if(hasEnv)('mixture market (V2-1 integration)', () => {
  let adminToken = '';
  let aliceToken = '';

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    aliceToken = await login('alice', 'password');
  });

  test('create a bimodal mixture market; belief persists with two modes', async () => {
    const created = await req('POST', '/admin/markets', {
      token: adminToken,
      body: {
        title: 'Bimodal mkt (test)',
        outcomeUnit: 'USD',
        initialMu: 70,
        initialSigma: 14,
        initialReserve: 10000,
        belief: {
          kind: 'mixture',
          components: [
            { pi: 0.5, mu: 60, sigma: 5 },
            { pi: 0.5, mu: 80, sigma: 5 },
          ],
        },
      },
    });
    expect([200, 201]).toContain(created.status);
    const { market } = (await created.json()) as { market: { marketId: string } };
    marketIds.push(market.marketId);

    // Persisted belief_state carries the mixture; current_mu = mixture mean = 70.
    const row = (await db.select().from(markets).where(eq(markets.marketId, market.marketId)))[0];
    expect(row?.beliefKind).toBe('mixture');
    expect(row?.beliefState?.kind).toBe('mixture');
    expect(Math.abs((row?.currentMu ?? 0) - 70)).toBeLessThan(1e-6);

    // The market view exposes the component legend.
    const view = await req('GET', `/markets/${market.marketId}`, { token: aliceToken });
    const { market: mv } = (await view.json()) as {
      market: { belief: { kind: string; components?: { pi: number; mu: number }[] } };
    };
    expect(mv.belief.kind).toBe('mixture');
    expect(mv.belief.components?.length).toBe(2);
  });

  test('mixture genesis uses the belief summary, not a mismatched authored initialMu (C48)', async () => {
    // Author initialMu = 50, but the components average to Σπμ = 70. The stored
    // genesis (initialMu column) and the history genesis point must be the true
    // summary (70), not the authored 50 — else the chart starts at the wrong place
    // and beliefDrift reads non-zero before any trade.
    const created = await req('POST', '/admin/markets', {
      token: adminToken,
      body: {
        title: 'Mismatched-μ mixture (test)',
        outcomeUnit: 'USD',
        initialMu: 50,
        initialSigma: 3,
        initialReserve: 10000,
        belief: {
          kind: 'mixture',
          components: [
            { pi: 0.5, mu: 60, sigma: 5 },
            { pi: 0.5, mu: 80, sigma: 5 },
          ],
        },
      },
    });
    expect([200, 201]).toContain(created.status);
    const { market } = (await created.json()) as { market: { marketId: string } };
    marketIds.push(market.marketId);

    const row = (await db.select().from(markets).where(eq(markets.marketId, market.marketId)))[0];
    expect(Math.abs((row?.initialMu ?? 0) - 70)).toBeLessThan(1e-6); // summary, not 50
    expect(Math.abs((row?.currentMu ?? 0) - 70)).toBeLessThan(1e-6);

    const hist = await req('GET', `/markets/${market.marketId}/history`, { token: aliceToken });
    const { history } = (await hist.json()) as {
      history: { beliefHistory: { mu: number }[] };
    };
    expect(Math.abs(history.beliefHistory[0].mu - 70)).toBeLessThan(1e-6); // genesis point

    // belief drift is 0 at genesis (no trades): current − genesis = 70 − 70.
    const stats = await req('GET', `/markets/${market.marketId}/stats`, { token: aliceToken });
    const { stats: s } = (await stats.json()) as { stats: { beliefDrift: number } };
    expect(Math.abs(s.beliefDrift)).toBeLessThan(1e-6);
  });

  test('quote fair on the mixture matches a Monte-Carlo estimate', async () => {
    const id = marketIds[0] as string;
    await req('POST', `/admin/markets/${id}/open`, { token: adminToken });

    const spec = { type: 'BINARY_CALL', strike: 75 } as const;
    const res = await req('POST', `/markets/${id}/quote`, {
      token: aliceToken,
      body: { spec, q: 20 },
    });
    expect(res.status).toBe(200);
    const { quote } = (await res.json()) as { quote: { fair: number } };

    // Independent MC of E[payoff] under the same bimodal belief.
    const mix = new MixtureBelief([
      { pi: 0.5, mu: 60, sigma2: 25 },
      { pi: 0.5, mu: 80, sigma2: 25 },
    ]);
    const draws = mix.sample(200_000, new Rng(0xbeef));
    let s = 0;
    for (const d of draws) s += payoff(spec, d);
    const mc = s / draws.length;
    expect(Math.abs(quote.fair - mc)).toBeLessThan(0.02);
  });

  test('a bullish stream shifts mixture weight toward the upper mode', async () => {
    const id = marketIds[0] as string;

    const weightNear = async (target: number) => {
      const view = await req('GET', `/markets/${id}`, { token: aliceToken });
      const { market } = (await view.json()) as {
        market: { belief: { components?: { pi: number; mu: number }[] } };
      };
      let w = 0;
      for (const c of market.belief.components ?? []) if (Math.abs(c.mu - target) < 12) w += c.pi;
      return w;
    };

    const before = await weightNear(80);
    // Repeated bullish call buys above the upper mode → evidence favors that camp.
    for (let i = 0; i < 6; i++) {
      const r = await req('POST', `/markets/${id}/trade`, {
        token: aliceToken,
        body: { spec: { type: 'CALL', strike: 82 }, q: 60 },
      });
      expect(r.status).toBe(200);
    }
    const after = await weightNear(80);
    expect(after).toBeGreaterThan(before);
  });
});
