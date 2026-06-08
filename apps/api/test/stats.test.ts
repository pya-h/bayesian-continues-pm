// integration — stats endpoints over a seeded scenario via app.handle.
// Creates a throwaway market, runs a trade, and cross-checks the formula-backed
// numbers from /stats, /history, /overview, portfolio, and position detail.

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

async function createOpenMarket(token: string, body: Record<string, unknown>): Promise<string> {
  const created = await req('POST', '/admin/markets', { token, body });
  const { market } = (await created.json()) as { market: { marketId: string } };
  marketIds.push(market.marketId);
  await req('POST', `/admin/markets/${market.marketId}/open`, { token });
  return market.marketId;
}

const STD = { outcomeUnit: 'USD', initialMu: 100, initialSigma: 10, initialReserve: 10000 };

afterAll(async () => {
  if (hasEnv && marketIds.length) {
    for (const id of marketIds) {
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

interface MarketStatsBody {
  status: string;
  belief: { mu: number; sigma: number; sigma2: number };
  impliedPrice: number;
  volume: number;
  trades: number;
  traders: number;
  nav: number;
  beliefDrift: number;
  calibration: { thetaStar: number; ci80: { lo: number; hi: number }; inCi80: boolean } | null;
}

interface OverviewBody extends MarketStatsBody {
  spreadIncome: number;
  expectedLiability: number;
  reserveRequired: number;
  reserveUtil: number;
  cash: number;
  mmPnl: number;
}

interface PortfolioBody {
  positions: {
    marketId: string;
    contractId: string;
    contractKey: string;
    quantity: number;
    costBasis: number;
    fair: number;
    bid: number;
    positionValue: number;
    unrealizedPnl: number;
    realizedPnl: number;
    peakProfit: number;
    drawdownFromPeak: number;
    final: { thetaStar: number; payout: number; finalPnl: number; claimed: boolean } | null;
  }[];
  totals: { realized: number; unrealized: number; total: number; marketValue: number };
}

describe.if(hasEnv)('statistics (integration)', () => {
  let adminToken = '';
  let bobToken = '';
  let marketId = '';
  let contractId = '';
  let contractKey = '';

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    bobToken = await login('bob', 'password');
    marketId = await createOpenMarket(adminToken, { title: 'Stats (test)', ...STD });
    // One trade so there is volume, a belief update, and a position to inspect.
    const fillRes = await req('POST', `/markets/${marketId}/trade`, {
      token: bobToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 20 },
    });
    const { fill } = (await fillRes.json()) as { fill: { contractId: string } };
    contractId = fill.contractId;
  });

  test('GET /markets/:id/stats reports volume, counts, and bullish drift', async () => {
    const res = await req('GET', `/markets/${marketId}/stats`);
    expect(res.status).toBe(200);
    const { stats } = (await res.json()) as { stats: MarketStatsBody };
    expect(stats.trades).toBe(1);
    expect(stats.traders).toBe(1);
    expect(stats.volume).toBeGreaterThan(0);
    expect(stats.impliedPrice).toBeCloseTo(stats.belief.mu, 6); // LINEAR fair = μ
    expect(stats.beliefDrift).toBeGreaterThan(0); // a CALL buy lifts μ above 100
    expect(stats.calibration).toBeNull(); // not resolved yet
  });

  test('GET /admin/markets/:id/overview exposes MM aggregates', async () => {
    const res = await req('GET', `/admin/markets/${marketId}/overview`, { token: adminToken });
    expect(res.status).toBe(200);
    const { overview } = (await res.json()) as { overview: OverviewBody };
    expect(overview.spreadIncome).toBeGreaterThan(0);
    expect(overview.reserveRequired).toBeGreaterThan(0);
    expect(overview.reserveUtil).toBeCloseTo(overview.reserveRequired / overview.cash, 6);
    expect(overview.nav).toBeCloseTo(overview.cash - overview.expectedLiability, 6);
  });

  test('overview requires admin', async () => {
    const res = await req('GET', `/admin/markets/${marketId}/overview`, { token: bobToken });
    expect(res.status).toBe(403);
  });

  test('GET /markets/:id/history returns belief + price series', async () => {
    // Discover the contractKey from the portfolio first.
    const pf = (await (await req('GET', '/users/me/portfolio', { token: bobToken })).json()) as {
      portfolio: PortfolioBody;
    };
    contractKey = pf.portfolio.positions.find((p) => p.marketId === marketId)?.contractKey ?? '';
    expect(contractKey).not.toBe('');

    const res = await req('GET', `/markets/${marketId}/history?contractKey=${contractKey}`);
    expect(res.status).toBe(200);
    const { history } = (await res.json()) as {
      history: {
        beliefHistory: { mu: number; sigma: number }[];
        priceHistory: { contractKey: string; points: { fair: number }[] } | null;
      };
    };
    // Genesis point + one update from the trade.
    expect(history.beliefHistory.length).toBe(2);
    expect(history.beliefHistory[0]?.mu).toBeCloseTo(100, 6); // initial μ
    expect(history.priceHistory?.points.length).toBe(2);
    expect(history.priceHistory?.points.every((p) => p.fair >= 0)).toBe(true);
  });

  test('GET /users/me/portfolio marks the position and aggregates PnL', async () => {
    const res = await req('GET', '/users/me/portfolio', { token: bobToken });
    expect(res.status).toBe(200);
    const { portfolio } = (await res.json()) as { portfolio: PortfolioBody };
    const p = portfolio.positions.find((x) => x.marketId === marketId);
    expect(p?.quantity).toBeCloseTo(20, 6);
    expect(p?.costBasis).toBeGreaterThan(0);
    expect(p?.bid).toBeLessThanOrEqual(p?.fair ?? 0); // exit bid ≤ mid
    expect(p?.positionValue).toBeCloseTo((p?.quantity ?? 0) * (p?.bid ?? 0), 6);
    expect(Number.isFinite(portfolio.totals.total)).toBe(true);
    expect(p?.final).toBeNull();
  });

  test('GET /users/me/positions/:contractId returns payout distribution + mark path', async () => {
    const res = await req('GET', `/users/me/positions/${contractId}`, { token: bobToken });
    expect(res.status).toBe(200);
    const { position } = (await res.json()) as {
      position: {
        quantity: number;
        costBasis: number;
        stats: {
          expectedPayout: number;
          fairPrice: number;
          pProfit: number;
          maxIsP99: boolean;
          breakevenTheta: number | null;
        };
        markPath: { points: number[]; peak: number; maxDrawdown: number };
      };
    };
    // Expected payout = q · fair (hand check against core).
    expect(position.stats.expectedPayout).toBeCloseTo(
      position.quantity * position.stats.fairPrice,
      4,
    );
    expect(position.stats.pProfit).toBeGreaterThanOrEqual(0);
    expect(position.stats.pProfit).toBeLessThanOrEqual(1);
    expect(position.stats.maxIsP99).toBe(true); // CALL payoff is unbounded
    expect(position.stats.breakevenTheta).toBeGreaterThan(100); // strike + premium/unit
    expect(position.markPath.points.length).toBe(1); // one belief update so far
    expect(position.markPath.maxDrawdown).toBe(0);
  });

  test('position not owned → 404', async () => {
    const res = await req('GET', `/users/me/positions/${contractId}`, { token: adminToken });
    expect(res.status).toBe(404);
  });

  test('after resolve, portfolio shows the final outcome and payout', async () => {
    await req('POST', `/admin/markets/${marketId}/resolve`, {
      token: adminToken,
      body: { thetaStar: 140 },
    });
    const res = await req('GET', '/users/me/portfolio', { token: bobToken });
    const { portfolio } = (await res.json()) as { portfolio: PortfolioBody };
    const p = portfolio.positions.find((x) => x.marketId === marketId);
    expect(p?.final).not.toBeNull();
    expect(p?.final?.thetaStar).toBe(140);
    expect(p?.final?.payout).toBeCloseTo(20 * (140 - 100), 4); // q·(θ*−K) = 800
    expect(p?.final?.claimed).toBe(false);

    // Calibration is populated once θ* is known.
    const ov = (await (
      await req('GET', `/admin/markets/${marketId}/overview`, { token: adminToken })
    ).json()) as { overview: OverviewBody };
    expect(ov.overview.calibration?.thetaStar).toBe(140);
    expect(typeof ov.overview.calibration?.inCi80).toBe('boolean');
  });
});
