// Live market socket. Subscribes to `market:<id>` (and the caller's `user:<id>`)
// and folds incoming events straight into the TanStack Query cache so every
// panel reading `useMarket`/`useMarketStats` re-renders on each tick — no manual
// refetch. Also surfaces a rolling recent-trades tape and connection state.

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { WS_URL, getToken } from '../lib/api.ts';
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
    // Clear any prior market's tape/price so a market→market navigation (this
    // page doesn't remount.
    setTape([]);
    setLastPrice(null);

    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let reconnecting = false; // true once a drop has occurred → next open is a re-open

    const patchMarket = (fn: (m: MarketView) => MarketView) => {
      qc.setQueryData<MarketView>(qk.market(marketId), (m) => (m ? fn(m) : m));
    };

    const connect = () => {
      // Pass the JWT as a query param — browsers can't set headers on a WS
      // upgrade. The server authorizes the user:<id> topic against it.
      const token = getToken();
      ws = new WebSocket(token ? `${WS_URL}?token=${encodeURIComponent(token)}` : WS_URL);

      ws.onopen = () => {
        setConnected(true);
        ws?.send(JSON.stringify({ action: 'subscribe', topic: `market:${marketId}` }));
        if (userId) ws?.send(JSON.stringify({ action: 'subscribe', topic: `user:${userId}` }));
        // After a reconnect, events that fired during the gap (belief/status/reserve
        // updates, trades) were missed — the cached market is stale. Refetch the
        // authoritative state so the page isn't "live" but frozen.
        if (reconnecting) {
          reconnecting = false;
          qc.invalidateQueries({ queryKey: qk.market(marketId) });
          qc.invalidateQueries({ queryKey: qk.stats(marketId) });
          qc.invalidateQueries({ queryKey: qk.historyAll(marketId) });
          qc.invalidateQueries({ queryKey: qk.portfolio });
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!closed) {
          reconnecting = true; // next successful open must resync the missed gap
          retry = setTimeout(connect, 1500); // auto-reconnect
        }
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
          case 'belief_update': {
            patchMarket((m) => ({
              ...m,
              belief: { ...m.belief, mu: msg.mu as number, sigma: msg.sigma as number },
            }));
            // The event carries only μ/σ. For a mixture market that leaves the
            // *shape* (components) at the page-load snapshot after OTHER traders'
            // fills (own trades refetch via the mutation) — refetch the market to
            // pull the real components. Gaussian needs nothing more, and a
            // Student-t is fully determined by (ν, μ, σ) with ν immutable.
            const cached = qc.getQueryData<MarketView>(qk.market(marketId));
            if (cached?.belief.kind === 'mixture') {
              qc.invalidateQueries({ queryKey: qk.market(marketId) });
            }
            break;
          }
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
              qc.invalidateQueries({ queryKey: qk.historyAll(marketId) });
            } else {
              qc.invalidateQueries({ queryKey: qk.portfolio });
            }
            break;
          case 'claim_paid':
          case 'lp_claim':
            qc.invalidateQueries({ queryKey: qk.portfolio });
            break;
          case 'param_adapted':
            // Adaptive parameters moved. Refresh any open admin cfg view.
            qc.invalidateQueries({ queryKey: qk.adminCfg(marketId) });
            break;
          case 'dispute_filed':
          case 'dispute_resolved':
            // a dispute opened/closed — refresh the market (status/θ*/window)
            // and any admin dispute queue.
            qc.invalidateQueries({ queryKey: qk.market(marketId) });
            qc.invalidateQueries({ queryKey: ['admin', 'disputes'] });
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
