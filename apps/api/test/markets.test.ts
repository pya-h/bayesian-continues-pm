// integration — market create + lifecycle, via app.handle. Hits the real
// DB; creates one throwaway market and tears down all its rows afterward.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { config } from '../src/config.ts';
import { db, sql } from '../src/db/client.ts';
import {
  auditEvents,
  lpLedger,
  lpPositions,
  markets,
  oracles,
  transactions,
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
let marketId = '';

async function login(username: string, password: string): Promise<string> {
  const res = await req('POST', '/auth/login', { body: { username, password } });
  return ((await res.json()) as { token: string }).token;
}

afterAll(async () => {
  if (hasEnv && marketId) {
    await db.delete(transactions).where(eq(transactions.marketId, marketId));
    await db.delete(oracles).where(eq(oracles.marketId, marketId));
    await db.delete(lpLedger).where(eq(lpLedger.marketId, marketId));
    await db.delete(lpPositions).where(eq(lpPositions.marketId, marketId));
    await db.delete(auditEvents).where(eq(auditEvents.targetId, marketId));
    await db.delete(markets).where(eq(markets.marketId, marketId));
  }
  await sql.end();
});

describe.if(hasEnv)('market lifecycle (integration)', () => {
  let adminToken = '';
  let userToken = '';

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    userToken = await login('alice', 'password');
  });

  test('non-admin cannot create a market → 403', async () => {
    const res = await req('POST', '/admin/markets', {
      token: userToken,
      body: { title: 'x', outcomeUnit: 'USD', initialMu: 1, initialSigma: 1, initialReserve: 1 },
    });
    expect(res.status).toBe(403);
  });

  test('admin creates a market (CREATED) seeded with R₀', async () => {
    const res = await req('POST', '/admin/markets', {
      token: adminToken,
      body: {
        title: 'BTC EOM (test)',
        outcomeUnit: 'USD',
        initialMu: 65000,
        initialSigma: 5000,
        initialReserve: 1_000_000,
        cfg: { s0: 0.012 },
      },
    });
    expect(res.status).toBe(201);
    const { market } = (await res.json()) as { market: { marketId: string; status: string } };
    marketId = market.marketId;
    expect(market.status).toBe('CREATED');
  });

  test('new market reads back model = null (G0 migration applied)', async () => {
    const rows = await db
      .select({ model: markets.model })
      .from(markets)
      .where(eq(markets.marketId, marketId));
    expect(rows[0]?.model).toBeNull();
  });

  test('gen_basis / gen_exact create rejected for now (G0 fail-closed) → 400', async () => {
    for (const belief of [
      { kind: 'gen_basis', bumps: [{ mu: 0, sigma: 1, weight: 1 }] },
      { kind: 'gen_exact', lambdas: [1, 0, 0] },
    ]) {
      const res = await req('POST', '/admin/markets', {
        token: adminToken,
        body: {
          title: 'unsupported model (test)',
          outcomeUnit: 'USD',
          initialMu: 1,
          initialSigma: 1,
          initialReserve: 1,
          belief,
        },
      });
      expect(res.status).toBe(400);
    }
  });

  test('GET /markets/:id shows belief μ/σ + pool NAV', async () => {
    const res = await req('GET', `/markets/${marketId}`);
    expect(res.status).toBe(200);
    const { market } = (await res.json()) as {
      market: {
        belief: { mu: number; sigma: number };
        pool: { nav: number; sharesTotal: number; sharePrice: number };
        cfg: Record<string, number>;
      };
    };
    expect(market.belief.mu).toBe(65000);
    expect(market.belief.sigma).toBe(5000);
    // no contracts yet → NAV = cash = R₀, share price = 1
    expect(market.pool.nav).toBe(1_000_000);
    expect(market.pool.sharesTotal).toBe(1_000_000);
    expect(market.pool.sharePrice).toBe(1);
    expect(market.cfg.s0).toBe(0.012); // override persisted
  });

  test('listing includes the market', async () => {
    const res = await req('GET', '/markets');
    const { markets: list } = (await res.json()) as { markets: { marketId: string }[] };
    expect(list.some((m) => m.marketId === marketId)).toBe(true);
  });

  test('open → suspend → resume cycle', async () => {
    const open = await req('POST', `/admin/markets/${marketId}/open`, { token: adminToken });
    expect(((await open.json()) as { market: { status: string } }).market.status).toBe('OPEN');

    const susp = await req('POST', `/admin/markets/${marketId}/suspend`, { token: adminToken });
    expect(((await susp.json()) as { market: { status: string } }).market.status).toBe('SUSPENDED');

    const resume = await req('POST', `/admin/markets/${marketId}/resume`, { token: adminToken });
    expect(((await resume.json()) as { market: { status: string } }).market.status).toBe('OPEN');
  });

  test('illegal transition rejected (suspend a CREATED-only action) → 409', async () => {
    // market is OPEN now; resume (SUSPENDED→OPEN) is illegal from OPEN
    const res = await req('POST', `/admin/markets/${marketId}/resume`, { token: adminToken });
    expect(res.status).toBe(409);
  });

  test('resolve with θ* sets RESOLVED + thetaStar', async () => {
    const res = await req('POST', `/admin/markets/${marketId}/resolve`, {
      token: adminToken,
      body: { thetaStar: 64000 },
    });
    expect(res.status).toBe(200);
    const { market } = (await res.json()) as { market: { status: string; thetaStar: number } };
    expect(market.status).toBe('RESOLVED');
    expect(market.thetaStar).toBe(64000);
  });

  test('resolve without θ* → 400', async () => {
    // make a fresh open market is overkill; resolving an already-resolved market is 409 first
    // so just assert the validation path on a bad body against the resolved one (still 400 since body checked first)
    const res = await req('POST', `/admin/markets/${marketId}/resolve`, {
      token: adminToken,
      body: {},
    });
    expect(res.status).toBe(400);
  });
});
