// WebSocket authorization. Two layers
// 1. Pure policy unit tests for `canSubscribeTopic` (no server, no DB).
// 2. Live integration: boot the app on an ephemeral port and prove a client
// cannot subscribe to — or receive — another user's private events.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../src/config.ts';
import { sql } from '../src/db/client.ts';
import { app } from '../src/index.ts';
import { setServer } from '../src/realtime.ts';
import { publish, topics } from '../src/realtime.ts';
import { canSubscribeTopic } from '../src/ws.ts';

// 1. pure policy -------------------------------------------------------
describe('canSubscribeTopic (policy)', () => {
  const user = { userId: 'u1', role: 'user' };
  const other = { userId: 'u2', role: 'user' };
  const admin = { userId: 'a1', role: 'admin' };

  test('market:<id> is public', () => {
    expect(canSubscribeTopic('market:abc', null)).toBe(true);
    expect(canSubscribeTopic('market:abc', user)).toBe(true);
  });
  test('market: with no id is rejected', () => {
    expect(canSubscribeTopic('market:', null)).toBe(false);
  });
  test('user:<id> only for the owner', () => {
    expect(canSubscribeTopic('user:u1', null)).toBe(false);
    expect(canSubscribeTopic('user:u1', other)).toBe(false);
    expect(canSubscribeTopic('user:u1', user)).toBe(true);
  });
  test('system only for admins', () => {
    expect(canSubscribeTopic('system', null)).toBe(false);
    expect(canSubscribeTopic('system', user)).toBe(false);
    expect(canSubscribeTopic('system', admin)).toBe(true);
  });
  test('unknown topics denied by default', () => {
    expect(canSubscribeTopic('secret', admin)).toBe(false);
    expect(canSubscribeTopic('', admin)).toBe(false);
  });
});

// 2. live integration --------------------------------------------------
const hasEnv = !!process.env.DATABASE_URL && !!process.env.ADMIN_PASSWORD;

function reqJson(method: string, path: string, body?: unknown) {
  return app.handle(
    new Request(`http://local${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}
async function login(username: string, password: string) {
  const r = await reqJson('POST', '/auth/login', { username, password });
  return (await r.json()) as { token: string; user: { userId: string } };
}

class WsClient {
  private buf: Record<string, unknown>[] = [];
  private waiters: {
    pred: (m: Record<string, unknown>) => boolean;
    resolve: (m: Record<string, unknown>) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => this.push(JSON.parse(ev.data as string));
  }
  private push(m: Record<string, unknown>) {
    const i = this.waiters.findIndex((w) => w.pred(m));
    if (i >= 0) {
      const w = this.waiters.splice(i, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(m);
    } else this.buf.push(m);
  }
  next(pred: (m: Record<string, unknown>) => boolean, ms = 2000): Promise<Record<string, unknown>> {
    const hit = this.buf.findIndex(pred);
    if (hit >= 0) return Promise.resolve(this.buf.splice(hit, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws frame timeout')), ms);
      this.waiters.push({ pred, resolve, timer });
    });
  }
  async none(pred: (m: Record<string, unknown>) => boolean, ms = 700): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    if (this.buf.some(pred)) throw new Error('unexpected frame received');
  }
  send(o: unknown) {
    this.ws.send(JSON.stringify(o));
  }
  close() {
    this.ws.close();
  }
}

describe.if(hasEnv)('ws auth (integration)', () => {
  let port = 0;
  let aliceToken = '';
  let aliceId = '';
  let bobToken = '';
  let adminToken = '';
  const open: WsClient[] = [];

  function connect(token?: string): Promise<WsClient> {
    const url = `ws://localhost:${port}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    const ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws open timeout')), 3000);
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('ws error'));
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data as string);
        if (m.type === 'welcome') {
          clearTimeout(timer);
          const c = new WsClient(ws);
          open.push(c);
          resolve(c);
        }
      };
    });
  }

  beforeAll(async () => {
    app.listen(0);
    const server = app.server as unknown as { port: number; stop(closeActive?: boolean): void };
    setServer(server as unknown as { publish(t: string, d: string): void });
    port = server.port;
    const a = await login('alice', 'password');
    aliceToken = a.token;
    aliceId = a.user.userId;
    bobToken = (await login('bob', 'password')).token;
    adminToken = (await login(config.admin.username, config.admin.password)).token;
  });

  afterAll(async () => {
    for (const c of open) c.close();
    (app.server as unknown as { stop(): void } | null)?.stop?.();
    await sql.end();
  });

  test('anonymous client may watch a public market topic', async () => {
    const c = await connect();
    c.send({ action: 'subscribe', topic: 'market:anything' });
    const m = await c.next((x) => x.topic === 'market:anything');
    expect(m.type).toBe('subscribed');
  });

  test('anonymous client is denied a user topic and the system topic', async () => {
    const c = await connect();
    c.send({ action: 'subscribe', topic: `user:${aliceId}` });
    expect((await c.next((x) => x.topic === `user:${aliceId}`)).type).toBe('error');
    c.send({ action: 'subscribe', topic: 'system' });
    expect((await c.next((x) => x.topic === 'system')).type).toBe('error');
  });

  test("a user cannot subscribe to another user's topic", async () => {
    const bob = await connect(bobToken);
    bob.send({ action: 'subscribe', topic: `user:${aliceId}` });
    expect((await bob.next((x) => x.topic === `user:${aliceId}`)).type).toBe('error');
  });

  test('a user can subscribe to their own topic; admin gets system', async () => {
    const alice = await connect(aliceToken);
    alice.send({ action: 'subscribe', topic: `user:${aliceId}` });
    expect((await alice.next((x) => x.topic === `user:${aliceId}`)).type).toBe('subscribed');

    const admin = await connect(adminToken);
    admin.send({ action: 'subscribe', topic: 'system' });
    expect((await admin.next((x) => x.topic === 'system')).type).toBe('subscribed');
  });

  test("an attacker does NOT receive another user's private event", async () => {
    const alice = await connect(aliceToken);
    const bob = await connect(bobToken);
    alice.send({ action: 'subscribe', topic: `user:${aliceId}` });
    await alice.next((x) => x.topic === `user:${aliceId}` && x.type === 'subscribed');
    // bob is denied alice's topic
    bob.send({ action: 'subscribe', topic: `user:${aliceId}` });
    await bob.next((x) => x.topic === `user:${aliceId}` && x.type === 'error');

    // server publishes a private event to alice
    publish(topics.user(aliceId), { type: 'trade_executed', marketId: 'm', tradeId: 't' });

    expect((await alice.next((x) => x.type === 'trade_executed')).marketId).toBe('m');
    await bob.none((x) => x.type === 'trade_executed'); // bob must not receive it
  });
});
