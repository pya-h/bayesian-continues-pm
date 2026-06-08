// Live market socket. Subscribes to `market:<id>` (and the caller's `user:<id>`)
// and folds incoming events straight into the TanStack Query cache so every
// panel reading `useMarket`/`useMarketStats` re-renders on each tick — no manual
// refetch. Also surfaces a rolling recent-trades tape and connection state.

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { WS_URL } from '../lib/api.ts';
import type { MarketView } from '../lib/types.ts';
import { qk } from './queries.ts';

export interface TapeEntry {
  tradeId: string;
  side: 'buy' | 'sell';
  q: number;
  execPrice: number;
  fair: number;
  at: number;
}

export interface PriceTick {
  contractKey: string;
  fair: number;
  at: number;
}

export function useMarketSocket(marketId: string, userId?: string) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [tape, setTape] = useState<TapeEntry[]>([]);
  const [lastPrice, setLastPrice] = useState<PriceTick | null>(null);
  const seq = useRef(0); // monotonic counter — keeps tape keys unique without Date.now

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const patchMarket = (fn: (m: MarketView) => MarketView) => {
      qc.setQueryData<MarketView>(qk.market(marketId), (m) => (m ? fn(m) : m));
    };

    const connect = () => {
      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        setConnected(true);
        ws?.send(JSON.stringify({ action: 'subscribe', topic: `market:${marketId}` }));
        if (userId) ws?.send(JSON.stringify({ action: 'subscribe', topic: `user:${userId}` }));
      };

      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1500); // auto-reconnect
      };
      ws.onerror = () => ws?.close();

      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        const at = ++seq.current;

        switch (msg.type) {
          case 'belief_update':
            patchMarket((m) => ({
              ...m,
              belief: { ...m.belief, mu: msg.mu as number, sigma: msg.sigma as number },
            }));
            break;
          case 'reserve_update':
            patchMarket((m) => ({
              ...m,
              reserveRequired: msg.reserveRequired as number,
              cash: msg.cash as number,
            }));
            break;
          case 'lp_update':
            patchMarket((m) => ({
              ...m,
              cash: msg.cash as number,
              pool: {
                nav: msg.nav as number,
                sharesTotal: msg.sharesTotal as number,
                sharePrice: msg.sharePrice as number,
              },
            }));
            break;
          case 'market_status':
            patchMarket((m) => ({ ...m, status: msg.status as MarketView['status'] }));
            qc.invalidateQueries({ queryKey: qk.market(marketId) });
            break;
          case 'price_change':
            setLastPrice({ contractKey: msg.contractKey as string, fair: msg.fair as number, at });
            break;
          case 'trade_executed':
            // The market-topic variant carries trade details; the user-topic one
            // only has { marketId, tradeId } and just nudges the portfolio.
            if (typeof msg.execPrice === 'number') {
              setTape((prev) =>
                [
                  {
                    tradeId: msg.tradeId as string,
                    side: msg.side as 'buy' | 'sell',
                    q: msg.q as number,
                    execPrice: msg.execPrice as number,
                    fair: msg.fair as number,
                    at,
                  },
                  ...prev,
                ].slice(0, 30),
              );
              qc.invalidateQueries({ queryKey: qk.stats(marketId) });
              qc.invalidateQueries({ queryKey: qk.history(marketId) });
            } else {
              qc.invalidateQueries({ queryKey: qk.portfolio });
            }
            break;
          case 'claim_paid':
          case 'lp_claim':
            qc.invalidateQueries({ queryKey: qk.portfolio });
            break;
          default:
            break;
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [marketId, userId, qc]);

  return { connected, tape, lastPrice };
}
