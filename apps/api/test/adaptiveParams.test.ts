// integration — adaptive parameters wired into the trade path.
// Verifies the controller threads end-to-end: each trade folds its signal error
// into the persisted EWMA state, the live (adapted) σ_ε/s₀/α/β are what price and
// update the NEXT trade, a market_cfg_history row is written per fill, the admin
// pin/disable endpoint overrides adaptation, the effect is belief-kind agnostic
// and an extreme stream trips the rail (param_rail breaker).
// Hits the real DB; market_cfg_history cascades on market delete, so teardown is
// unchanged from the other integration suites.

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

interface CfgView {
  base: { sigmaEps: number; s0: number; alpha: number; beta: number };
  control: { enabled?: boolean; pinned?: Record<string, number> };
  source: 'static' | 'adapt' | 'pin';
  state: { emaSlow: number; emaFast: number; count: number };
  adapted: {
    sigmaEps: number;
    s0: number;
    alpha: number;
    beta: number;
    regime: number;
    railHit: boolean;
    rails: { sigmaEps: 'lo' | 'hi' | null };
  };
  live: { sigmaEps: number; s0: number; alpha: number; beta: number };
  history: { sigmaEps: number; source: string; railHit: boolean; createdAt: string }[];
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
      // market_cfg_history cascades on the markets delete below.
      await db.delete(markets).where(eq(markets.marketId, id));
    }
    await db
      .update(users)
      .set({ balance: 10000 })
      .where(inArray(users.username, ['alice']));
  }
  await sql.end();
});

describe.if(hasEnv)('adaptive parameters (V2-2b integration)', () => {
  let adminToken = '';
  let aliceToken = '';

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    aliceToken = await login('alice', 'password');
  });

  async function createMarket(body: Record<string, unknown>): Promise<string> {
    const res = await req('POST', '/admin/markets', {
      token: adminToken,
      body: {
        outcomeUnit: 'USD',
        initialMu: 70,
        initialSigma: 10,
        initialReserve: 100000,
        ...body,
      },
    });
    expect([200, 201]).toContain(res.status);
    const { market } = (await res.json()) as { market: { marketId: string } };
    marketIds.push(market.marketId);
    return market.marketId;
  }
  async function open(id: string) {
    expect((await req('POST', `/admin/markets/${id}/open`, { token: adminToken })).status).toBe(
      200,
    );
  }
  async function trade(id: string, spec: Record<string, unknown>, q: number) {
    const r = await req('POST', `/markets/${id}/trade`, { token: aliceToken, body: { spec, q } });
    expect(r.status).toBe(200);
    return r.json();
  }
  async function quote(id: string, spec: Record<string, unknown>, q: number) {
    const r = await req('POST', `/markets/${id}/quote`, { token: aliceToken, body: { spec, q } });
    expect(r.status).toBe(200);
    return (await r.json()) as { quote: { projectedBelief: { mu: number } } };
  }
  async function getCfg(id: string): Promise<CfgView> {
    const r = await req('GET', `/admin/markets/${id}/cfg`, { token: adminToken });
    expect(r.status).toBe(200);
    return ((await r.json()) as { cfg: CfgView }).cfg;
  }
  async function patchCfg(id: string, body: unknown): Promise<CfgView> {
    const r = await req('PATCH', `/admin/markets/${id}/cfg`, { token: adminToken, body });
    expect(r.status).toBe(200);
    return ((await r.json()) as { cfg: CfgView }).cfg;
  }

  const LINEAR = { type: 'LINEAR' };
  // A bell BUY's extracted signal is its center (pointBet, buy ⇒ target), so this
  // is a clean, moderate surprise (|s−μ| ≈ 6 ≪ σ₀=10) — and bounded ∈[0,1], so it's
  // cheap and never strains balance/reserve across the suite.
  const BELL = { type: 'GAUSSIAN', center: 76, width: 8 };

  test('controller state + cfg_history accumulate as trades arrive', async () => {
    const id = await createMarket({ title: 'Adaptive Gaussian (test)' });
    await open(id);

    const before = await getCfg(id);
    expect(before.source).toBe('static'); // cold: no observations yet
    expect(before.state.count).toBe(0);
    expect(before.history.length).toBe(0);
    expect(before.live.sigmaEps).toBeCloseTo(before.base.sigmaEps, 6);

    for (let i = 0; i < 6; i++) await trade(id, BELL, 100);

    const after = await getCfg(id);
    expect(after.state.count).toBe(6);
    expect(after.source).toBe('adapt'); // past warmup → adapting
    // Moderate bell surprises (|s−μ| ≈ 6 ≪ σ₀=10) keep σ_ε strictly inside the rails.
    expect(after.adapted.railHit).toBe(false);
    expect(Math.abs(after.adapted.sigmaEps - after.base.sigmaEps)).toBeGreaterThan(1e-6);
    expect(after.live.sigmaEps).toBeCloseTo(after.adapted.sigmaEps, 6);
    // One history row per fill, oldest-first (ascending createdAt).
    expect(after.history.length).toBe(6);
    for (let i = 1; i < after.history.length; i++) {
      expect(after.history[i].createdAt >= after.history[i - 1].createdAt).toBe(true);
    }
  });

  test('the live (adapted/pinned) σ_ε feeds the belief update', async () => {
    // Two identical markets; pin σ_ε high on one, low on the other. The same buy
    // must move the projected belief LESS when σ_ε is larger (precision ∝ 1/σ_ε²).
    const hi = await createMarket({ title: 'Adaptive pin-hi (test)' });
    const lo = await createMarket({ title: 'Adaptive pin-lo (test)' });
    await open(hi);
    await open(lo);
    await patchCfg(hi, { pinned: { sigmaEps: 40 } });
    await patchCfg(lo, { pinned: { sigmaEps: 3 } });

    expect((await getCfg(hi)).source).toBe('pin');
    expect((await getCfg(hi)).live.sigmaEps).toBeCloseTo(40, 6);
    expect((await getCfg(lo)).live.sigmaEps).toBeCloseTo(3, 6);

    const qHi = await quote(hi, LINEAR, 200);
    const qLo = await quote(lo, LINEAR, 200);
    const shiftHi = Math.abs(qHi.quote.projectedBelief.mu - 70);
    const shiftLo = Math.abs(qLo.quote.projectedBelief.mu - 70);
    expect(shiftLo).toBeGreaterThan(shiftHi);
  });

  test('adaptation is belief-kind agnostic (Student-t market adapts too)', async () => {
    const id = await createMarket({
      title: 'Adaptive Student-t (test)',
      belief: { kind: 'student_t', nu: 5 },
    });
    await open(id);
    for (let i = 0; i < 5; i++) await trade(id, BELL, 100);

    const cfg = await getCfg(id);
    expect(cfg.state.count).toBe(5);
    expect(cfg.source).toBe('adapt');
    expect(cfg.history.length).toBe(5);
  });

  test('admin disable freezes params at the static baseline', async () => {
    const id = await createMarket({ title: 'Adaptive disabled (test)' });
    await patchCfg(id, { enabled: false });
    await open(id);
    for (let i = 0; i < 6; i++) await trade(id, BELL, 100);

    const cfg = await getCfg(id);
    expect(cfg.source).toBe('static');
    expect(cfg.live.sigmaEps).toBeCloseTo(cfg.base.sigmaEps, 6);
    expect(cfg.live.s0).toBeCloseTo(cfg.base.s0, 6);
    // History still recorded, but labelled 'static' (no adaptation applied).
    expect(cfg.history.every((h) => h.source === 'static')).toBe(true);
  });

  test('admin pin overrides an already-adapting controller', async () => {
    const id = await createMarket({ title: 'Adaptive pin-after (test)' });
    await open(id);
    for (let i = 0; i < 5; i++) await trade(id, BELL, 100);
    expect((await getCfg(id)).source).toBe('adapt');

    const pinned = await patchCfg(id, { pinned: { sigmaEps: 7, s0: 0.005 } });
    expect(pinned.source).toBe('pin');
    expect(pinned.live.sigmaEps).toBeCloseTo(7, 6);
    expect(pinned.live.s0).toBeCloseTo(0.005, 6);

    // Clearing the pin returns to adaptation.
    const cleared = await patchCfg(id, { pinned: {} });
    expect(cleared.source).toBe('adapt');
  });

  test('an extreme far stream trips the σ_ε rail (param_rail breaker)', async () => {
    const id = await createMarket({ title: 'Adaptive rail (test)' });
    await open(id);
    // BINARY_CALL far above the mean: signal s ≈ strike, so |s−μ| ≫ σ₀ ⇒ σ_ε wants
    // to exceed 2·σ₀ and saturates the upper rail. Bounded payoff keeps reserve safe.
    for (let i = 0; i < 6; i++) await trade(id, { type: 'BINARY_CALL', strike: 130 }, 100);

    const cfg = await getCfg(id);
    expect(cfg.adapted.railHit).toBe(true);
    expect(cfg.adapted.rails.sigmaEps).toBe('hi');
    expect(cfg.adapted.sigmaEps).toBeCloseTo(2 * 10, 6); // sigmaEpsHiRatio·σ₀
    expect(cfg.history.some((h) => h.source === 'breaker' && h.railHit)).toBe(true);
  });
});
