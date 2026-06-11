// Integration — the admin audit-log viewer (`GET /admin/audit`). Drives the real
// app via app.handle against the real DB: privileged actions (market create /
// lifecycle, a trade, a top-up) must show up in the log, joined to the actor's
// username and a resolved target label (a market title or a username), newest
// first; and a non-admin must be forbidden.
// Requires DATABASE_URL + ADMIN_PASSWORD (loaded via the test script's --env-file).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, gte, inArray } from 'drizzle-orm';
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

async function login(username: string, password: string): Promise<string> {
  const res = await req('POST', '/auth/login', { body: { username, password } });
  return ((await res.json()) as { token: string }).token;
}

async function meId(token: string): Promise<string> {
  const res = await req('GET', '/auth/me', { token });
  return ((await res.json()) as { user: { userId: string } }).user.userId;
}

async function createOpenMarket(token: string, title: string): Promise<string> {
  const created = await req('POST', '/admin/markets', {
    token,
    body: { title, outcomeUnit: 'USD', initialMu: 100, initialSigma: 10, initialReserve: 10000 },
  });
  const { market } = (await created.json()) as { market: { marketId: string } };
  marketIds.push(market.marketId);
  await req('POST', `/admin/markets/${market.marketId}/open`, { token });
  return market.marketId;
}

interface AuditEvent {
  eventId: string;
  actor: string | null;
  action: string;
  targetType: 'market' | 'user' | null;
  targetLabel: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

async function getAudit(token: string): Promise<{ status: number; events?: AuditEvent[] }> {
  const res = await req('GET', '/admin/audit', { token });
  if (res.status !== 200) return { status: res.status };
  const { events } = (await res.json()) as { events: AuditEvent[] };
  return { status: res.status, events };
}

const hasEnv = !!process.env.DATABASE_URL && !!process.env.ADMIN_PASSWORD;
const marketIds: string[] = [];
const t0 = new Date();

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
    // The top-up audit events target a user (not a market) — clear the ones this run made.
    await db
      .delete(auditEvents)
      .where(and(eq(auditEvents.action, 'topup'), gte(auditEvents.createdAt, t0)));
    await db
      .update(users)
      .set({ balance: 10000 })
      .where(inArray(users.username, ['alice', 'bob']));
  }
  await sql.end();
});

describe.if(hasEnv)('admin audit log (integration)', () => {
  let adminToken = '';
  let aliceToken = '';
  let aliceId = '';

  beforeAll(async () => {
    adminToken = await login(config.admin.username, config.admin.password);
    aliceToken = await login('alice', 'password');
    aliceId = await meId(aliceToken);
  });

  test('admin-only: a non-admin is forbidden', async () => {
    const res = await req('GET', '/admin/audit', { token: aliceToken });
    expect(res.status).toBe(403);
  });

  test('records actions, resolving actor + target, newest first', async () => {
    const title = 'Audit demo (audit test)';
    const id = await createOpenMarket(adminToken, title); // market_create + market_open (actor=admin)
    await req('POST', `/markets/${id}/trade`, {
      token: aliceToken,
      body: { spec: { type: 'CALL', strike: 100 }, q: 10 }, // trade_execute (actor=alice)
    });
    await req('POST', `/admin/users/${aliceId}/topup`, {
      token: adminToken,
      body: { amount: 250 },
    }); // topup (target=user)

    const { status, events } = await getAudit(adminToken);
    expect(status).toBe(200);
    if (!events) throw new Error('no events');

    // market_create resolves to a market title, actor = admin.
    const createdByTitle = events.find(
      (e) => e.action === 'market_create' && e.targetLabel === title,
    );
    expect(createdByTitle).toBeDefined();
    expect(createdByTitle?.targetType).toBe('market');
    expect(createdByTitle?.actor).toBe(config.admin.username);

    // the trade was performed by alice against the market.
    const trade = events.find((e) => e.action === 'trade_execute' && e.targetLabel === title);
    expect(trade).toBeDefined();
    expect(trade?.actor).toBe('alice');
    expect(trade?.targetType).toBe('market');

    // the top-up resolves its target to a *user* (alice), with the amount in the payload.
    const topup = events.find(
      (e) => e.action === 'topup' && e.targetType === 'user' && e.targetLabel === 'alice',
    );
    expect(topup).toBeDefined();
    expect(topup?.actor).toBe(config.admin.username);
    expect(topup?.payload?.amount).toBe(250);

    // newest-first: createdAt is non-increasing down the list.
    const times = events.map((e) => new Date(e.createdAt).getTime());
    const sorted = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sorted);
  });
});
