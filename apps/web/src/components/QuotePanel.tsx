// Quote + execute panel. Re-quotes (debounced) whenever the contract, size, side
// or the live belief changes, and shows the full spread breakdown, exec price
// total cost, slippage guard, and the projected post-trade belief + reserve. The
// Buy/Sell button fires the trade and folds the fill back into balance + caches.

import { contractKey } from '@bmm/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext.tsx';
import { qk, usePortfolio } from '../hooks/queries.ts';
import { ApiError, api } from '../lib/api.ts';
import { fmt, fmtPct, fmtSigned } from '../lib/format.ts';
import { sellCloseStats, tradeStats } from '../lib/tradeStats.ts';
import type { ContractSpec, Fill } from '../lib/types.ts';
import { Button, ErrorNote, FlashNumber } from './ui.tsx';

// Money formatters that survive an unbounded (±∞) best/worst case.
const fmtInf = (n: number, d?: number) =>
  n === Number.POSITIVE_INFINITY ? '∞' : n === Number.NEGATIVE_INFINITY ? '−∞' : fmt(n, d);
const fmtSignedInf = (n: number, d?: number) =>
  n === Number.POSITIVE_INFINITY ? '+∞' : n === Number.NEGATIVE_INFINITY ? '−∞' : fmtSigned(n, d);
// Percent with an explicit sign — for returns.
const fmtSignedPct = (frac: number) =>
  `${frac < 0 ? '−' : '+'}${(Math.abs(frac) * 100).toFixed(1)}%`;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const SLIPPAGE = 0.02; // 2% default protection band on the exec price

// Two specs are the *same sellable contract* iff they share the engine's
// canonical identity — the exact key the API matches a sell against. Using the
// real contractKey (not a coarse rounding) keeps the close UI in lockstep with
// what the server will actually accept, so we never show "closing" for a spec
// the API would reject as un-held.
function sameContract(a: ContractSpec, b: ContractSpec): boolean {
  try {
    return contractKey(a) === contractKey(b);
  } catch {
    return false;
  }
}

export function QuotePanel({
  marketId,
  spec,
  tradable,
  mu,
  sigma,
  outcomeUnit,
  outcomeMin = null,
  outcomeMax = null,
}: {
  marketId: string;
  spec: ContractSpec;
  tradable: boolean;
  mu: number;
  sigma: number;
  outcomeUnit: string;
  outcomeMin?: number | null;
  outcomeMax?: number | null;
}) {
  const qc = useQueryClient();
  const { user, setUser } = useAuth();
  const portfolio = usePortfolio();
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

  // Live "know your trade" analytics for the *debounced* order.
  const stats = useMemo(
    () =>
      quote
        ? tradeStats({
            spec: debounced.spec,
            signedQ: debounced.signedQ,
            totalCost: quote.totalCost,
            fair: quote.fair,
            mu,
            sigma,
            outcomeMin,
            outcomeMax,
          })
        : null,
    [quote, debounced.spec, debounced.signedQ, mu, sigma, outcomeMin, outcomeMax],
  );

  // If this sell closes a contract the user already holds, the result is no
  // longer probabilistic — it realizes profit against what they paid. Match the
  // composed contract to a held long and show that instead of max-profit/loss.
  const held = useMemo(() => {
    const here = (portfolio.data?.positions ?? []).filter(
      (p) => p.marketId === marketId && sameContract(p.spec, debounced.spec) && p.quantity > 0,
    );
    return here[0] ?? null;
  }, [portfolio.data, marketId, debounced.spec]);

  const closeStats =
    !isBuy && quote && held
      ? sellCloseStats({
          proceeds: -quote.totalCost,
          qty: Math.abs(debounced.signedQ),
          heldQty: held.quantity,
          avgEntryPrice: held.avgEntryPrice,
        })
      : null;
  // v1 is long-only: a sell can only *close* a contract you already hold.
  const sellWithoutHolding = !isBuy && held == null;

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* side toggle with a sliding indicator */}
      <div className="relative grid grid-cols-2 overflow-hidden rounded-lg border border-edge bg-panel-2 text-sm font-semibold">
        <span
          aria-hidden="true"
          className={`absolute inset-y-0 left-0 w-1/2 rounded-lg transition-transform duration-200 ${
            isBuy ? 'translate-x-0 bg-buy' : 'translate-x-full bg-sell'
          }`}
        />
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            className={`relative z-10 py-2 capitalize transition-colors ${
              side === s ? 'text-white' : 'text-muted hover:text-fg'
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

      {/* know-your-trade analytics */}
      {tradable && quote && stats && (
        <div className="animate-fade-in rounded-lg border border-edge bg-panel-2 p-3">
          {closeStats ? (
            <>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-fg">Closing your position</span>
                <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                  selling {fmt(closeStats.qClosed, 0)} of {fmt(held?.quantity ?? 0, 0)} held
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                <AnalysisCell
                  label="Payout"
                  raw={closeStats.proceeds}
                  text={fmt(closeStats.proceeds)}
                  tone="buy"
                />
                <AnalysisCell
                  label="Profit"
                  raw={closeStats.realizedProfit}
                  text={fmtSigned(closeStats.realizedProfit)}
                  tone={closeStats.realizedProfit >= 0 ? 'buy' : 'sell'}
                />
                <AnalysisCell
                  label="Cost basis"
                  raw={closeStats.costBasis}
                  text={fmt(closeStats.costBasis)}
                />
                <AnalysisCell
                  label="Return"
                  raw={closeStats.returnPct ?? 0}
                  text={closeStats.returnPct == null ? '—' : fmtSignedPct(closeStats.returnPct)}
                  tone={(closeStats.returnPct ?? 0) >= 0 ? 'buy' : 'sell'}
                />
              </div>
            </>
          ) : sellWithoutHolding ? (
            <div className="flex flex-col items-center gap-1.5 px-2 py-3 text-center">
              <span className="text-lg">📭</span>
              <span className="text-xs font-semibold text-fg">Nothing to close here</span>
              <span className="text-xs text-muted">
                Selling closes a contract you already hold. You don’t own this exact contract — pick
                one from <span className="font-medium text-fg">Your positions</span>, or switch to{' '}
                <span className="font-medium text-buy">Buy</span>.
              </span>
            </div>
          ) : (
            <>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-fg">Trade analysis</span>
                <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                  {fmtPct(stats.pProfit)} win chance
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                <AnalysisCell
                  label={isBuy ? 'Max payout' : 'Premium received'}
                  raw={isBuy ? stats.contractMaxPayout : -totalCost}
                  text={fmtInf(isBuy ? stats.contractMaxPayout : -totalCost)}
                />
                <AnalysisCell
                  label="Expected P&L"
                  raw={stats.expectedPnl}
                  text={fmtSignedInf(stats.expectedPnl)}
                  tone={stats.expectedPnl >= 0 ? 'buy' : 'sell'}
                />
                <AnalysisCell
                  label="Max profit"
                  raw={stats.maxProfit}
                  text={fmtSignedInf(stats.maxProfit)}
                  tone="buy"
                />
                <AnalysisCell
                  label="Max loss"
                  raw={-stats.maxLoss}
                  text={stats.maxLoss > 0 ? `−${fmtInf(stats.maxLoss)}` : fmt(0)}
                  tone="sell"
                />
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] uppercase tracking-wide text-muted">
                    Breakeven θ
                  </span>
                  <span className="tnum text-sm font-semibold text-fg">
                    {stats.breakevens.length === 0
                      ? '—'
                      : stats.breakevens
                          .slice(0, 2)
                          .map((b) => fmt(b, 0))
                          .join(' · ')}
                    {stats.breakevens.length > 0 && (
                      <span className="ml-1 text-xs font-normal text-muted">{outcomeUnit}</span>
                    )}
                  </span>
                </div>
                <AnalysisCell
                  label="Risk : reward"
                  raw={stats.riskReward ?? 0}
                  text={stats.riskReward == null ? '—' : `${fmt(stats.riskReward, 2)}×`}
                />
              </div>
            </>
          )}
        </div>
      )}

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
        disabled={!tradable || qty <= 0 || trade.isPending || sellWithoutHolding}
        onClick={() => trade.mutate()}
      >
        {trade.isPending
          ? 'Submitting…'
          : sellWithoutHolding
            ? 'Nothing to sell'
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

function AnalysisCell({
  label,
  raw,
  text,
  tone,
}: {
  label: string;
  raw: number;
  text: string;
  tone?: 'buy' | 'sell';
}) {
  const toneCls = tone === 'buy' ? 'text-buy' : tone === 'sell' ? 'text-sell' : 'text-fg';
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <FlashNumber value={raw} className={`tnum text-sm font-semibold ${toneCls}`}>
        {text}
      </FlashNumber>
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
    <div className="rounded-lg border border-buy/40 bg-buy-soft p-3 text-xs tnum animate-pop">
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
