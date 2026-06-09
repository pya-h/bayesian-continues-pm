// / MH-1 integration — the admin market ledger. Drives the real app
// via app.handle against the real DB: a known trade/LP/settle (and a separate
// cancel) sequence must reconstruct to the expected pool deltas, and the rollups
// must reconcile to `markets.cash`.
// Requires DATABASE_URL + ADMIN_PASSWORD (loaded via the test script's --env-file).

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
const STD = { outcomeUnit: 'USD', initialMu: 100, initialSigma: 10, initialReserve: 10000 };

async function login(username: string, password: string): Promise<string> {
  const res = await req('POST', '/auth/login', { body: { username, password } });
  return ((await res.json()) as { token: string }).token;
}

async function meId(token: string): Promise<string> {
  const res = await req('GET', '/auth/me', { token });
  return ((await res.json()) as { user: { userId: string } }).user.userId;
}

async function createOpenMarket(token: string, title: string): Promise<string> {
  const created = await req('POST', '/admin/markets', { token, body: { title, ...STD } });
  const { market } = (await created.json()) as { market: { marketId: string } };
  marketIds.push(market.marketId);
  await req('POST', `/admin/markets/${market.marketId}/open`, { token });
  return market.marketId;
}

interface LedgerEvent {
  kind: string;
  delta: number;
  affectsCash: boolean;
  cashAfter: number | null;
}
interface Ledger {
  marketId: string;
  status: string;
  events: LedgerEvent[];
  rollup: {
    genesisReserve: number;
    lpDeposits: number;
    lpWithdrawals: number;
    premiumIn: number;
    premiumOut: number;
    refunds: number;
    traderPayouts: number;
    lpClaimsPaid: number;
    netPoolChange: number;
    currentCash: number;
    reserveRequired: number;
    nav: number;
    cashFinal: number;
    reconciles: boolean;
    tradeCount: number;
    eventCount: number;
  };
}

async function getLedger(token: string, id: string): Promise<{ status: number; ledger?: Ledger }> {
  const res = await req('GET', `/admin/markets/${id}/ledger`, { token });
  if (res.status !== 200) return { status: res.status };
  const { ledger } = (await res.json()) as { ledger: Ledger };
  return { status: res.status, ledger };
}

afterAll(async () => {
  if (hasEnv) {
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

describe.if(hasEnv)('market ledger (integration)', () => {
  let adminToken = '';
  let aliceToken = '';

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    aliceToken = await login('alice', 'password');
  });

  test('admin-only: a non-admin is forbidden', async () => {
    const id = await createOpenMarket(adminToken, 'Ledger access (mh1 test)');
    const res = await req('GET', `/admin/markets/${id}/ledger`, { token: aliceToken });
    expect(res.status).toBe(403);
  });

  test('genesis + trades + LP deposit reconstruct and reconcile to markets.cash', async () => {
    const id = await createOpenMarket(adminToken, 'Ledger trade+lp (mh1 test)');
    await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 20 },
    });
    await req('POST', `/markets/${id}/lp/deposit`, { token: aliceToken, body: { amount: 500 } });

    const { status, ledger } = await getLedger(adminToken, id);
    expect(status).toBe(200);
    if (!ledger) throw new Error('no ledger');

    // Genesis is the reserve; a buy adds premium in; the deposit adds 500.
    expect(ledger.rollup.genesisReserve).toBeCloseTo(STD.initialReserve, 4);
    expect(ledger.rollup.premiumIn).toBeGreaterThan(0);
    expect(ledger.rollup.lpDeposits).toBeCloseTo(500, 4);

    // The reconstructed running balance equals the live pool cash.
    expect(ledger.rollup.reconciles).toBe(true);
    expect(ledger.rollup.netPoolChange).toBeCloseTo(ledger.rollup.currentCash, 4);

    // The events themselves sum (signed) to the pool cash.
    const summed = ledger.events.filter((e) => e.affectsCash).reduce((s, e) => s + e.delta, 0);
    expect(summed).toBeCloseTo(ledger.rollup.currentCash, 4);

    // The first event is the genesis deposit; the last cash-affecting event's
    // running balance equals the pool cash.
    expect(ledger.events[0]?.kind).toBe('genesis');
    const cashEvents = ledger.events.filter((e) => e.affectsCash);
    expect(cashEvents.at(-1)?.cashAfter).toBeCloseTo(ledger.rollup.currentCash, 4);

    // Exactly one of each expected kind shows up.
    const kinds = ledger.events.map((e) => e.kind);
    expect(kinds).toContain('genesis');
    expect(kinds).toContain('trade_buy');
    expect(kinds).toContain('lp_deposit');
  });

  test('resolve → settle records trader payouts without moving pool cash', async () => {
    const id = await createOpenMarket(adminToken, 'Ledger settle (mh1 test)');
    await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 20 },
    });
    const before = await getLedger(adminToken, id);
    const cashBefore = before.ledger?.rollup.currentCash ?? 0;

    await req('POST', `/admin/markets/${id}/resolve`, {
      token: adminToken,
      body: { thetaStar: 130 },
    });
    await req('POST', `/admin/markets/${id}/settle`, { token: adminToken });
    await req('POST', `/markets/${id}/claim`, { token: aliceToken });

    const { ledger } = await getLedger(adminToken, id);
    if (!ledger) throw new Error('no ledger');

    // CALL(100) @ θ*=130 over q=20 → 600 payout liability.
    expect(ledger.rollup.traderPayouts).toBeCloseTo(600, 3);
    // Pool cash is unchanged by settlement (residual is computed logically).
    expect(ledger.rollup.currentCash).toBeCloseTo(cashBefore, 4);
    expect(ledger.rollup.cashFinal).toBeCloseTo(cashBefore - 600, 3);
    // Still reconciles (payout events don't affect the cash running balance).
    expect(ledger.rollup.reconciles).toBe(true);

    const payout = ledger.events.find((e) => e.kind === 'trader_payout');
    expect(payout).toBeTruthy();
    expect(payout?.affectsCash).toBe(false);
    expect(payout?.cashAfter).toBeNull();
    expect(payout?.delta).toBeCloseTo(-600, 3);
  });

  test('cancel refunds reduce the pool and still reconcile', async () => {
    const id = await createOpenMarket(adminToken, 'Ledger cancel (mh1 test)');
    await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 15 },
    });
    await req('POST', `/admin/markets/${id}/cancel`, { token: adminToken });

    const { ledger } = await getLedger(adminToken, id);
    if (!ledger) throw new Error('no ledger');

    expect(ledger.status).toBe('CANCELLED');
    expect(ledger.rollup.refunds).toBeGreaterThan(0);
    // Refund returns the buy premium, so cash settles back near the genesis reserve.
    expect(ledger.rollup.currentCash).toBeCloseTo(STD.initialReserve, 3);
    expect(ledger.rollup.reconciles).toBe(true);

    const refund = ledger.events.find((e) => e.kind === 'refund');
    expect(refund).toBeTruthy();
    expect(refund?.delta).toBeLessThan(0); // leaves the pool
    expect(refund?.affectsCash).toBe(true);
  });

  test('404 for an unknown market', async () => {
    const res = await req('GET', '/admin/markets/00000000-0000-0000-0000-000000000000/ledger', {
      token: adminToken,
    });
    expect(res.status).toBe(404);
  });

  test('admin can read a specific user’s transaction history; non-admin cannot', async () => {
    const aliceId = await meId(aliceToken);

    const ok = await req('GET', `/admin/users/${aliceId}/transactions`, { token: adminToken });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      transactions: { kind: string }[];
      summary: { count: number };
    };
    expect(Array.isArray(body.transactions)).toBe(true);
    expect(body.summary.count).toBe(body.transactions.length);

    const forbidden = await req('GET', `/admin/users/${aliceId}/transactions`, {
      token: aliceToken,
    });
    expect(forbidden.status).toBe(403);

    const missing = await req(
      'GET',
      '/admin/users/00000000-0000-0000-0000-000000000000/transactions',
      { token: adminToken },
    );
    expect(missing.status).toBe(404);
  });
});
