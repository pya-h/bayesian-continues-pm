// WebSocket endpoint. Clients subscribe to topic channels; the server pushes
// domain events to those topics via `realtime.publish`. ships the
// subscribe/unsubscribe/ping plumbing; domain events are wired in later phases.
// Client → server messages (JSON)
// { "action": "subscribe", "topic": "market:<id>" }
// { "action": "unsubscribe", "topic": "market:<id>" }
// { "action": "ping" }

import { Elysia } from 'elysia';

export const wsRoutes = new Elysia().ws('/ws', {
  open(ws) {
    ws.subscribe('system');
    ws.send({ type: 'welcome' });
  },
  message(ws, raw) {
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
    if (action === 'subscribe' && typeof topic === 'string') {
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
