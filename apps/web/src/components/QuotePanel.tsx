// Quote + execute panel. Re-quotes (debounced) whenever the contract, size, side
// or the live belief changes, and shows the full spread breakdown, exec price
// total cost, slippage guard, and the projected post-trade belief + reserve. The
// Buy/Sell button fires the trade and folds the fill back into balance + caches.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext.tsx';
import { qk } from '../hooks/queries.ts';
import { ApiError, api } from '../lib/api.ts';
import { fmt, fmtSigned } from '../lib/format.ts';
import type { ContractSpec, Fill } from '../lib/types.ts';
import { Button, ErrorNote } from './ui.tsx';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const SLIPPAGE = 0.02; // 2% default protection band on the exec price

export function QuotePanel({
  marketId,
  spec,
  tradable,
  mu,
  sigma,
  outcomeUnit,
}: {
  marketId: string;
  spec: ContractSpec;
  tradable: boolean;
  mu: number;
  sigma: number;
  outcomeUnit: string;
}) {
  const qc = useQueryClient();
  const { user, setUser } = useAuth();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [qty, setQty] = useState(1);
  const [slippageOn, setSlippageOn] = useState(true);
  const [lastFill, setLastFill] = useState<Fill | null>(null);

  const signedQ = side === 'buy' ? Math.abs(qty) : -Math.abs(qty);
  // Round the belief into the key so live ticks re-quote, but not on every pixel.
  const beliefKey = `${mu.toFixed(2)}:${sigma.toFixed(2)}`;
  const debounced = useDebounced({ spec, signedQ, beliefKey }, 350);

  const quoteQ = useQuery({
    queryKey: ['quote', marketId, debounced],
    queryFn: () => api.quote(marketId, debounced.spec, debounced.signedQ).then((r) => r.quote),
    enabled: tradable && Math.abs(debounced.signedQ) > 0,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const quote = quoteQ.data;

  const trade = useMutation({
    mutationFn: () => {
      const maxPrice =
        slippageOn && quote
          ? side === 'buy'
            ? quote.execPrice * (1 + SLIPPAGE)
            : quote.execPrice * (1 - SLIPPAGE)
          : undefined;
      return api.trade(marketId, spec, signedQ, maxPrice).then((r) => r.fill);
    },
    onSuccess: (fill) => {
      setLastFill(fill);
      if (user) setUser({ ...user, balance: fill.balance ?? user.balance });
      qc.invalidateQueries({ queryKey: qk.market(marketId) });
      qc.invalidateQueries({ queryKey: qk.stats(marketId) });
      qc.invalidateQueries({ queryKey: qk.history(marketId) });
      qc.invalidateQueries({ queryKey: qk.portfolio });
    },
  });

  const isBuy = side === 'buy';
  const totalCost = quote?.totalCost ?? 0;

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* side toggle */}
      <div className="grid grid-cols-2 gap-1.5">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            className={`rounded-lg py-2 text-sm font-semibold capitalize transition-colors ${
              side === s
                ? s === 'buy'
                  ? 'bg-buy text-white'
                  : 'bg-sell text-white'
                : 'border border-edge bg-panel-2 text-muted hover:text-fg'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted">Quantity</span>
        <input
          type="number"
          min={0}
          step={1}
          value={qty}
          onChange={(e) => setQty(Math.max(0, Number(e.target.value) || 0))}
          className="tnum rounded-lg border border-edge bg-panel-2 px-3 py-2 text-sm outline-none focus:border-accent"
        />
        {quote && (
          <button
            type="button"
            className="self-start text-xs text-accent hover:underline"
            onClick={() => setQty(Math.floor(quote.maxExecutable))}
          >
            max ≈ {fmt(quote.maxExecutable, 2)}
          </button>
        )}
      </label>

      {/* quote readout */}
      <div className="rounded-lg border border-edge bg-panel-2 p-3 text-sm">
        {!tradable ? (
          <p className="text-muted">Market is not open for trading.</p>
        ) : quoteQ.isError ? (
          <p className="text-sell">
            {quoteQ.error instanceof ApiError ? quoteQ.error.message : 'Quote failed.'}
          </p>
        ) : !quote ? (
          <p className="text-muted">Enter a size to see a live quote…</p>
        ) : (
          <div className="flex flex-col gap-1.5 tnum">
            <Row label="Fair (mid)" value={`${fmt(quote.fair)} ${outcomeUnit && ''}`} />
            <div className="my-1 border-t border-edge pt-1.5 text-xs text-muted">
              <Row label="base" value={fmt(quote.spread.base, 4)} small />
              <Row label="inventory" value={fmt(quote.spread.inventory, 4)} small />
              <Row label="adverse-sel" value={fmt(quote.spread.adverseSelection, 4)} small />
              <Row label="volatility" value={fmt(quote.spread.volatility, 4)} small />
              <Row label="spread total" value={fmt(quote.spread.total, 4)} small strong />
            </div>
            <Row label="Exec price" value={fmt(quote.execPrice)} strong />
            <Row
              label={isBuy ? 'You pay' : 'You receive'}
              value={fmt(Math.abs(totalCost))}
              strong
              tone={isBuy ? 'sell' : 'buy'}
            />
            <div className="mt-1 border-t border-edge pt-1.5 text-xs text-muted">
              <Row
                label="Proj. belief μ"
                value={`${fmt(quote.projectedBelief.mu, 1)} (σ ${fmt(quote.projectedBelief.sigma, 1)})`}
                small
              />
              <Row label="Proj. reserve" value={fmt(quote.projectedReserve)} small />
            </div>
          </div>
        )}
      </div>

      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={slippageOn}
          onChange={(e) => setSlippageOn(e.target.checked)}
        />
        Slippage guard (±{(SLIPPAGE * 100).toFixed(0)}% on exec price)
      </label>

      <Button
        variant={isBuy ? 'buy' : 'sell'}
        disabled={!tradable || qty <= 0 || trade.isPending}
        onClick={() => trade.mutate()}
      >
        {trade.isPending
          ? 'Submitting…'
          : `${isBuy ? 'Buy' : 'Sell'} ${fmt(qty, 2)} contract${qty === 1 ? '' : 's'}`}
      </Button>

      {trade.isError && (
        <ErrorNote>
          {trade.error instanceof ApiError ? trade.error.message : 'Trade failed.'}
        </ErrorNote>
      )}

      {lastFill && <FillReceipt fill={lastFill} />}
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  small,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  small?: boolean;
  tone?: 'buy' | 'sell';
}) {
  const toneCls = tone === 'buy' ? 'text-buy' : tone === 'sell' ? 'text-sell' : '';
  return (
    <div className={`flex items-center justify-between ${small ? 'text-xs' : ''}`}>
      <span className={small ? 'text-muted' : 'text-muted'}>{label}</span>
      <span className={`${strong ? 'font-semibold text-fg' : ''} ${toneCls}`}>{value}</span>
    </div>
  );
}

function FillReceipt({ fill }: { fill: Fill }) {
  return (
    <div className="rounded-lg border border-buy/40 bg-buy-soft p-3 text-xs tnum">
      <div className="mb-1 font-semibold text-buy">
        Filled {fmt(fill.filledQ, 2)} {fill.partial ? '(partial)' : ''} @ {fmt(fill.execPrice)}
      </div>
      <Row label="Total cost" value={fmtSigned(-fill.totalCost)} />
      <Row
        label="Position now"
        value={`${fmt(fill.position.quantity, 2)} @ ${fmt(fill.position.avgEntryPrice)}`}
      />
      {fill.position.realizedPnl !== 0 && (
        <Row label="Realized PnL" value={fmtSigned(fill.position.realizedPnl)} />
      )}
      <Row
        label="Belief μ"
        value={`${fmt(fill.beliefBefore.mu, 1)} → ${fmt(fill.beliefAfter.mu, 1)}`}
      />
    </div>
  );
}
