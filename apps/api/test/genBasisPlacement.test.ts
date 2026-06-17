// G4 integration — "paint the curve" on a Gen·basis market. A user places **bell
// (GAUSSIAN) BUY** bets at three distinct centers; each carves a distinct, persistent
// mode (the weight-only placement update), so the user sculpts a multi-bump belief
// through trades. Selling a bell back at a camp erases it. Reserve stays bounded.
// Hits the real DB.

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
const hasModeNear = (cs: Comp[], x: number, tol = 16) => cs.some((c) => Math.abs(c.mu - x) < tol);

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

describe.if(hasEnv)('gen_basis placement — paint the curve (G4 integration)', () => {
  let adminToken = '';
  let aliceToken = '';

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    aliceToken = await login('alice', 'password');
  });

  async function createOpenMarket(): Promise<string> {
    const res = await req('POST', '/admin/markets', {
      token: adminToken,
      body: {
        title: 'Paint (test)',
        outcomeUnit: 'USD',
        initialMu: 100,
        initialSigma: 10,
        initialReserve: 10000,
        belief: { kind: 'gen_basis', bumps: [{ mu: 100, sigma: 8, weight: 1 }] },
      },
    });
    expect([200, 201]).toContain(res.status);
    const { market } = (await res.json()) as { market: { marketId: string } };
    marketIds.push(market.marketId);
    await req('POST', `/admin/markets/${market.marketId}/open`, { token: adminToken });
    return market.marketId;
  }

  async function placeBell(id: string, center: number, q: number) {
    const r = await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'GAUSSIAN', center, width: 6 }, q },
    });
    expect(r.status).toBe(200);
  }

  test('bell buys at three centers sculpt a three-bump belief', async () => {
    const id = await createOpenMarket();
    for (let round = 0; round < 4; round++) {
      for (const c of [50, 100, 150]) await placeBell(id, c, 100);
    }
    const cs = await components(id, aliceToken);
    expect(cs.length).toBeGreaterThanOrEqual(3);
    expect(hasModeNear(cs, 50)).toBe(true);
    expect(hasModeNear(cs, 100)).toBe(true);
    expect(hasModeNear(cs, 150)).toBe(true);
    // weights normalised
    expect(Math.abs(cs.reduce((s, c) => s + c.pi, 0) - 1)).toBeLessThan(1e-6);

    // reserve stays bounded (bell payoff ∈ [0,1] ⇒ liability is capped by exposure)
    const row = (await db.select().from(markets).where(eq(markets.marketId, id)))[0];
    expect(Number.isFinite(row?.reserveRequired)).toBe(true);
    expect(row?.reserveRequired ?? -1).toBeGreaterThanOrEqual(0);
    expect(row?.reserveRequired ?? Number.POSITIVE_INFINITY).toBeLessThan(10000);
  });

  test('selling a bell back at a camp paints it down (erases the mode)', async () => {
    const id = await createOpenMarket();
    for (let round = 0; round < 4; round++) {
      for (const c of [50, 100, 150]) await placeBell(id, c, 100);
    }
    expect(hasModeNear(await components(id, aliceToken), 50)).toBe(true);
    // Sell the 50 camp back down — only as much bell-50 as Alice actually holds
    // (a sell of an unheld position 400s), so unwind until the position is gone.
    for (let k = 0; k < 5; k++) {
      const r = await req('POST', `/markets/${id}/trade`, {
        token: aliceToken,
        body: { spec: { type: 'GAUSSIAN', center: 50, width: 6 }, q: -100 },
      });
      if (r.status !== 200) break; // position exhausted
    }
    const cs = await components(id, aliceToken);
    expect(hasModeNear(cs, 50)).toBe(false); // erased
    expect(hasModeNear(cs, 150)).toBe(true); // the far camp survives
  });
});
