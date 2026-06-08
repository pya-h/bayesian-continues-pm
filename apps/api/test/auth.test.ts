// Integration test for — auth + admin top-up, driven through the Elysia
// app via app.handle (no port bind). Hits the real DB (DATABASE_URL), so it
// creates a uniquely-named throwaway user and deletes it afterward.
// Requires DATABASE_URL + ADMIN_PASSWORD (loaded via the test script's --env-file).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { config } from '../src/config.ts';
import { db, sql } from '../src/db/client.ts';
import { users } from '../src/db/schema.ts';
import { app } from '../src/index.ts';

const uname = `itest_${Date.now()}`;
const pass = 'secret123';

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

beforeAll(async () => {
  if (hasEnv) await db.delete(users).where(eq(users.username, uname));
});
afterAll(async () => {
  if (hasEnv) await db.delete(users).where(eq(users.username, uname));
  await sql.end();
});

describe.if(hasEnv)('auth + admin (integration)', () => {
  let userToken = '';
  let userId = '';
  let adminToken = '';

  test('register a new user → 201 + token', async () => {
    const res = await req('POST', '/auth/register', { body: { username: uname, password: pass } });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { token: string; user: { userId: string; balance: number } };
    expect(json.token).toBeTruthy();
    expect(json.user.balance).toBe(0);
    userToken = json.token;
    userId = json.user.userId;
  });

  test('duplicate register → 409', async () => {
    const res = await req('POST', '/auth/register', { body: { username: uname, password: pass } });
    expect(res.status).toBe(409);
  });

  test('login wrong password → 401', async () => {
    const res = await req('POST', '/auth/login', { body: { username: uname, password: 'nope' } });
    expect(res.status).toBe(401);
  });

  test('login → token; /me returns the user', async () => {
    const login = await req('POST', '/auth/login', { body: { username: uname, password: pass } });
    expect(login.status).toBe(200);
    const { token } = (await login.json()) as { token: string };
    const me = await req('GET', '/auth/me', { token });
    expect(me.status).toBe(200);
    const meJson = (await me.json()) as { user: { username: string } };
    expect(meJson.user.username).toBe(uname);
  });

  test('/me without token → 401', async () => {
    const res = await req('GET', '/auth/me');
    expect(res.status).toBe(401);
  });

  test('non-admin hitting /admin/users → 403', async () => {
    const res = await req('GET', '/admin/users', { token: userToken });
    expect(res.status).toBe(403);
  });

  test('admin login works', async () => {
    const res = await req('POST', '/auth/login', {
      body: { username: config.admin.username, password: config.admin.password },
    });
    expect(res.status).toBe(200);
    adminToken = ((await res.json()) as { token: string }).token;
    expect(adminToken).toBeTruthy();
  });

  test('admin lists users', async () => {
    const res = await req('GET', '/admin/users', { token: adminToken });
    expect(res.status).toBe(200);
    const { users: list } = (await res.json()) as { users: { username: string }[] };
    expect(list.some((u) => u.username === uname)).toBe(true);
  });

  test('admin tops up the user → balance increases', async () => {
    const res = await req('POST', `/admin/users/${userId}/topup`, {
      token: adminToken,
      body: { amount: 2500 },
    });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { balance: number } };
    expect(user.balance).toBe(2500);
  });

  test('topup with bad amount → 400', async () => {
    const res = await req('POST', `/admin/users/${userId}/topup`, {
      token: adminToken,
      body: { amount: -5 },
    });
    expect(res.status).toBe(400);
  });
});
