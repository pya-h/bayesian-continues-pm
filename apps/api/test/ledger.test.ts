// / TX-1 integration — the transaction ledger. Drives the real app
// via app.handle against the real DB, asserting that every cash movement
// writes the expected `transactions` row(s) atomically with the balance change.
// Requires DATABASE_URL + ADMIN_PASSWORD (loaded via the test script's --env-file).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TransactionKind } from '@bmm/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
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

async function latestTx(userId: string, kind?: string, marketId?: string) {
  const conds = [eq(transactions.userId, userId)];
  if (kind) conds.push(eq(transactions.kind, kind));
  if (marketId) conds.push(eq(transactions.marketId, marketId));
  const rows = await db
    .select()
    .from(transactions)
    .where(and(...conds))
    .orderBy(desc(transactions.createdAt))
    .limit(1);
  return rows[0];
}

let adminId = '';
let aliceId = '';

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
    // Remove the topup rows (null marketId) this suite created for alice.
    if (aliceId) {
      await db
        .delete(transactions)
        .where(
          and(eq(transactions.refType, 'topup'), inArray(transactions.userId, [aliceId, adminId])),
        );
    }
    await db
      .update(users)
      .set({ balance: 10000 })
      .where(inArray(users.username, ['alice', 'bob']));
  }
  await sql.end();
});

describe.if(hasEnv)('transaction ledger (integration)', () => {
  let adminToken = '';
  let aliceToken = '';

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    aliceToken = await login('alice', 'password');
    adminId = await meId(adminToken);
    aliceId = await meId(aliceToken);
  });

  test('admin top-up writes admin_credit on the target and admin_grant on the admin', async () => {
    const res = await req('POST', `/admin/users/${aliceId}/topup`, {
      token: adminToken,
      body: { amount: 1234 },
    });
    expect(res.status).toBe(200);
    const newBalance = ((await res.json()) as { user: { balance: number } }).user.balance;

    const credit = await latestTx(aliceId, TransactionKind.ADMIN_CREDIT);
    expect(credit).toBeTruthy();
    expect(credit.amount).toBeCloseTo(1234, 6);
    expect(credit.counterpartyId).toBe(adminId);
    expect(credit.balanceAfter).toBeCloseTo(newBalance, 6);

    const grant = await latestTx(adminId, TransactionKind.ADMIN_GRANT);
    expect(grant).toBeTruthy();
    expect(grant.amount).toBeCloseTo(-1234, 6); // admin dispensed it
    expect(grant.counterpartyId).toBe(aliceId);
    expect(grant.balanceAfter).toBeNull(); // admin is infinite
  });

  test('creating a market ledgers market_create on the creator (admin, balanceAfter null)', async () => {
    const id = await createOpenMarket(adminToken, 'Ledger create (test)');
    const tx = await latestTx(adminId, TransactionKind.MARKET_CREATE, id);
    expect(tx).toBeTruthy();
    expect(tx.amount).toBeCloseTo(-STD.initialReserve, 6); // reserve put up
    expect(tx.balanceAfter).toBeNull(); // admin is infinite
    expect(tx.refType).toBe('market');
  });

  test('a buy ledgers trade_buy equal to the wallet debit', async () => {
    const id = await createOpenMarket(adminToken, 'Ledger buy (test)');
    const buy = await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 20 },
    });
    expect(buy.status).toBe(200);
    const { fill } = (await buy.json()) as {
      fill: { totalCost: number; balance: number; filledQ: number };
    };

    const tx = await latestTx(aliceId, TransactionKind.TRADE_BUY, id);
    expect(tx).toBeTruthy();
    expect(tx.amount).toBeCloseTo(-fill.totalCost, 6); // buy debits the premium
    expect(tx.amount).toBeLessThan(0);
    expect(tx.balanceAfter).toBeCloseTo(fill.balance, 6);
    expect((tx.metadata as { side: string }).side).toBe('buy');
  });

  test('LP deposit ledgers lp_deposit as an outflow', async () => {
    const id = await createOpenMarket(adminToken, 'Ledger LP (test)');
    const dep = await req('POST', `/markets/${id}/lp/deposit`, {
      token: aliceToken,
      body: { amount: 500 },
    });
    expect(dep.status).toBe(200);

    const tx = await latestTx(aliceId, TransactionKind.LP_DEPOSIT, id);
    expect(tx).toBeTruthy();
    expect(tx.amount).toBeCloseTo(-500, 6);
    expect(tx.refType).toBe('lp_ledger');
    expect(tx.balanceAfter).not.toBeNull();
  });

  test('resolve → settle → claim ledgers the payout as a credit', async () => {
    const id = await createOpenMarket(adminToken, 'Ledger claim (test)');
    await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 20 },
    });
    await req('POST', `/admin/markets/${id}/resolve`, {
      token: adminToken,
      body: { thetaStar: 130 },
    });
    await req('POST', `/admin/markets/${id}/settle`, { token: adminToken });
    const c = await req('POST', `/markets/${id}/claim`, { token: aliceToken });
    expect(c.status).toBe(200);
    const claim = ((await c.json()) as { claim: { credited: number; balance: number } }).claim;
    expect(claim.credited).toBeCloseTo(600, 4); // CALL(100) @ θ*=130 → 30/unit · 20

    const tx = await latestTx(aliceId, TransactionKind.CLAIM, id);
    expect(tx).toBeTruthy();
    expect(tx.amount).toBeCloseTo(600, 4);
    expect(tx.balanceAfter).toBeCloseTo(claim.balance, 4);
  });

  test('cancelling a market ledgers a refund to the trader', async () => {
    const id = await createOpenMarket(adminToken, 'Ledger cancel (test)');
    const buy = await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 15 },
    });
    const { fill } = (await buy.json()) as { fill: { totalCost: number } };

    const cancelled = await req('POST', `/admin/markets/${id}/cancel`, { token: adminToken });
    expect(cancelled.status).toBe(200);

    const tx = await latestTx(aliceId, TransactionKind.REFUND, id);
    expect(tx).toBeTruthy();
    expect(tx.amount).toBeGreaterThan(0); // cost basis returned
    expect(tx.amount).toBeCloseTo(fill.totalCost, 4); // full cost basis for a single buy
  });
});
