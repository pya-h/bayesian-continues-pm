// integration — Gen·basis markets. A Gen·basis market is stored as an
// adaptive Gaussian mixture (belief_kind = 'mixture') carrying a `model =
// 'gen_basis'` tag; its update path turns on mode-spawning, so order flow at a
// new location grows a fresh mode. A plain `mixture` market (spawn off) never
// grows its component count. Hits the real DB; tears rows down afterward.

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

interface Comp {
  pi: number;
  mu: number;
  sigma: number;
}
async function components(id: string, token: string): Promise<Comp[]> {
  const view = await req('GET', `/markets/${id}`, { token });
  const { market } = (await view.json()) as { market: { belief: { components?: Comp[] } } };
  return market.belief.components ?? [];
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

describe.if(hasEnv)('gen_basis market (G1.2 integration)', () => {
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

  // Drive a stream of bell (GAUSSIAN) buys whose centers alternate between the
  // consensus and a far location — the signal lands at the bell center.
  async function alternatingBellBuys(id: string, near: number, far: number, n: number) {
    for (let i = 0; i < n; i++) {
      const center = i % 2 === 0 ? near : far;
      const r = await req('POST', `/markets/${id}/trade`, {
        token: aliceToken,
        body: { spec: { type: 'GAUSSIAN', center, width: 6 }, q: 100 },
      });
      expect(r.status).toBe(200);
    }
  }

  test('persists as a mixture carrying the gen_basis model tag + authored bumps', async () => {
    const id = await createMarket({
      title: 'Gen·basis (test)',
      outcomeUnit: 'USD',
      initialMu: 70,
      initialSigma: 10,
      initialReserve: 10000,
      belief: { kind: 'gen_basis', bumps: [{ mu: 70, sigma: 5, weight: 1 }] },
    });

    const row = (await db.select().from(markets).where(eq(markets.marketId, id)))[0];
    expect(row?.model).toBe('gen_basis'); // creator-chosen tag
    expect(row?.beliefKind).toBe('mixture'); // math representation
    expect(row?.beliefState?.kind).toBe('mixture');

    const view = await req('GET', `/markets/${id}`, { token: aliceToken });
    const { market: mv } = (await view.json()) as {
      market: { model: string; belief: { kind: string; components?: Comp[] } };
    };
    expect(mv.model).toBe('gen_basis');
    expect(mv.belief.kind).toBe('mixture');
    expect(mv.belief.components?.length).toBe(1);
    expect(Math.abs((mv.belief.components?.[0]?.mu ?? 0) - 70)).toBeLessThan(1e-6);
  });

  test('a far-from-consensus buy stream grows a new mode (spawn on)', async () => {
    const id = await createMarket({
      title: 'Gen·basis spawn (test)',
      outcomeUnit: 'USD',
      initialMu: 70,
      initialSigma: 10,
      initialReserve: 10000,
      belief: { kind: 'gen_basis', bumps: [{ mu: 70, sigma: 5, weight: 1 }] },
    });
    await req('POST', `/admin/markets/${id}/open`, { token: adminToken });

    expect((await components(id, aliceToken)).length).toBe(1); // starts unimodal
    await alternatingBellBuys(id, 70, 115, 12);

    const comps = await components(id, aliceToken);
    expect(comps.length).toBeGreaterThanOrEqual(2); // a new mode formed
    expect(comps.some((c) => c.mu > 95)).toBe(true); // it sits at the far camp
  });

  test('a legacy mixture market never spawns under the same stream (spawn off)', async () => {
    const id = await createMarket({
      title: 'Mixture control (test)',
      outcomeUnit: 'USD',
      initialMu: 70,
      initialSigma: 10,
      initialReserve: 10000,
      belief: {
        kind: 'mixture',
        components: [
          { pi: 0.5, mu: 60, sigma: 5 },
          { pi: 0.5, mu: 80, sigma: 5 },
        ],
      },
    });
    await req('POST', `/admin/markets/${id}/open`, { token: adminToken });

    expect((await components(id, aliceToken)).length).toBe(2);
    await alternatingBellBuys(id, 70, 115, 12);

    // No spawn ⇒ the component count can only stay flat or shrink (merge/prune).
    expect((await components(id, aliceToken)).length).toBeLessThanOrEqual(2);
  });

  test('belief-history snapshots redraw the multi-modal shape (V2-8 ghost trail)', async () => {
    const id = await createMarket({
      title: 'Gen·basis history (test)',
      outcomeUnit: 'USD',
      initialMu: 70,
      initialSigma: 10,
      initialReserve: 10000,
      belief: { kind: 'gen_basis', bumps: [{ mu: 70, sigma: 5, weight: 1 }] },
    });
    await req('POST', `/admin/markets/${id}/open`, { token: adminToken });
    await alternatingBellBuys(id, 70, 115, 12);

    const res = await req('GET', `/markets/${id}/history`);
    expect(res.status).toBe(200);
    const { history } = (await res.json()) as {
      history: {
        beliefHistory: {
          mu: number;
          sigma: number;
          belief: { kind: string; components?: { pi: number; mu: number }[] } | null;
        }[];
      };
    };

    const pts = history.beliefHistory;
    expect(pts.length).toBeGreaterThan(2); // genesis + one per spawn-stream fill
    // Genesis predates any snapshot → null (the chart redraws it as a Gaussian).
    expect(pts[0]?.belief).toBeNull();
    // Every post-genesis point carries a full mixture snapshot to redraw its past PDF…
    for (const p of pts.slice(1)) expect(p.belief?.kind).toBe('mixture');
    // …and by the end of the far-camp stream a snapshot shows the second mode.
    expect(pts.some((p) => (p.belief?.components?.length ?? 0) >= 2)).toBe(true);
  });
});
