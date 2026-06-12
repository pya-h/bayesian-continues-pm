// WebSocket endpoint. Clients subscribe to topic channels; the server pushes
// domain events to those topics via `realtime.publish`.
// Auth: browsers can't set an Authorization header on a WS upgrade, so the JWT is
// passed as a `?token=` query param. It's OPTIONAL — anonymous clients may still
// watch public `market:<id>` channels (live market pages work logged-out) — but
// topic subscription is authorized so a client cannot eavesdrop on another user's
// private events
// • market:<id> → anyone
// • user:<id> → only the authenticated owner (id === own userId)
// • system → admins only (circuit-breaker alerts)
// Client → server messages (JSON)
// { "action": "subscribe", "topic": "market:<id>" }
// { "action": "unsubscribe", "topic": "market:<id>" }
// { "action": "ping" }

import { jwt } from '@elysiajs/jwt';
import { Elysia } from 'elysia';
import { config } from './config.ts';
import { type UserRow, userRepo } from './db/repos.ts';

export interface WsIdentity {
  userId: string;
  role: string;
}

// Pure authorization policy for a topic subscription. Exported for unit testing.
// Unknown topics are denied by default (deny-list-free; allow-list only).
export function canSubscribeTopic(topic: string, identity: WsIdentity | null): boolean {
  if (topic.startsWith('market:')) return topic.length > 'market:'.length;
  if (topic.startsWith('user:')) return identity != null && topic === `user:${identity.userId}`;
  if (topic === 'system') return identity != null && identity.role === 'admin';
  return false;
}

export const wsRoutes = new Elysia()
  .use(jwt({ name: 'jwt', secret: config.jwtSecret }))
  // Resolve the socket's identity from ?token= during the upgrade request, so it's
  // ready (and awaited) before any message handler runs.
  .derive(async ({ jwt, query }) => {
    const token = typeof query?.token === 'string' ? query.token : null;
    if (!token) return { wsIdentity: null as WsIdentity | null };
    const payload = await jwt.verify(token);
    const sub = payload && typeof payload === 'object' ? (payload as { sub?: unknown }).sub : null;
    if (typeof sub !== 'string') return { wsIdentity: null as WsIdentity | null };
    const user = (await userRepo.byId(sub)) as UserRow | undefined;
    return {
      wsIdentity: user ? ({ userId: user.userId, role: user.role } as WsIdentity) : null,
    };
  })
  .ws('/ws', {
    open(ws) {
      const identity = ws.data.wsIdentity;
      // Only admins receive the system alert channel.
      if (identity && identity.role === 'admin') ws.subscribe('system');
      ws.send({ type: 'welcome' });
    },
    async message(ws, raw) {
      let msg: unknown = raw;
      if (typeof raw === 'string') {
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
      }
      if (!msg || typeof msg !== 'object') return;
      const { action, topic } = msg as { action?: string; topic?: string };
      let identity = ws.data.wsIdentity;

      if (action === 'subscribe' && typeof topic === 'string') {
        // The socket identity is captured at upgrade; for the privileged topic
        // re-read the role so a demotion/deletion takes effect on new subscriptions
        // without waiting for a reconnect. (Already-held subscriptions persist for
        // the socket lifetime — full revocation needs session infra.)
        if (topic === 'system' && identity) {
          const fresh = (await userRepo.byId(identity.userId)) as UserRow | undefined;
          identity = fresh ? { userId: fresh.userId, role: fresh.role } : null;
          ws.data.wsIdentity = identity;
        }
        if (!canSubscribeTopic(topic, identity)) {
          ws.send({ type: 'error', topic, error: 'forbidden' });
          return;
        }
        ws.subscribe(topic);
        ws.send({ type: 'subscribed', topic });
      } else if (action === 'unsubscribe' && typeof topic === 'string') {
        ws.unsubscribe(topic);
        ws.send({ type: 'unsubscribed', topic });
      } else if (action === 'ping') {
        ws.send({ type: 'pong' });
      }
    },
  });
