// System-alert socket. Opens a WS and subscribes to the `system` topic — which
// the server authorizes for admins only — to collect circuit-breaker alerts
// so the admin sees them live. Keeps a rolling, dismissable
// list with stable keys; auto-reconnects like useMarketSocket.

import { useCallback, useEffect, useRef, useState } from 'react';
import { WS_URL, getToken } from '../lib/api.ts';
import type { SystemAlert } from '../lib/types.ts';

export interface LiveAlert extends SystemAlert {
  // Stable client-side key (monotonic — no Date.now).
  id: number;
}

const MAX_ALERTS = 50;

export function useSystemAlerts(enabled = true) {
  const [alerts, setAlerts] = useState<LiveAlert[]>([]);
  const [connected, setConnected] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      // system alerts require an admin token — passed via query param.
      const token = getToken();
      ws = new WebSocket(token ? `${WS_URL}?token=${encodeURIComponent(token)}` : WS_URL);
      ws.onopen = () => {
        setConnected(true);
        ws?.send(JSON.stringify({ action: 'subscribe', topic: 'system' }));
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws?.close();
      ws.onmessage = (ev) => {
        let msg: SystemAlert;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type !== 'system:alert') return;
        const id = ++seq.current;
        setAlerts((prev) => [{ ...msg, id }, ...prev].slice(0, MAX_ALERTS));
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [enabled]);

  const dismiss = useCallback((id: number) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);
  const clear = useCallback(() => setAlerts([]), []);

  return { alerts, connected, dismiss, clear };
}
