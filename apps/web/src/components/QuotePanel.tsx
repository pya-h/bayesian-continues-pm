// Quote + execute panel. Re-quotes (debounced) whenever the contract, size, side
// or the live belief changes, and shows the full spread breakdown, exec price
// total cost, slippage guard, and the projected post-trade belief + reserve. The
// Buy/Sell button fires the trade and folds the fill back into balance + caches.

import { type EngineConfig, contractKey } from '@bmm/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAuth } from '../auth/AuthContext.tsx';
import { qk, usePortfolio } from '../hooks/queries.ts';
import { ApiError, api } from '../lib/api.ts';
import { beliefFromView } from '../lib/beliefFromView.ts';
import { projectBelief } from '../lib/clientBelief.ts';
import { estimateQuote } from '../lib/clientQuote.ts';
import { fmt, fmtPct, fmtSigned } from '../lib/format.ts';
import { getLiveSpec, subscribeLiveSpec } from '../lib/liveSpec.ts';
import { setProjectedBelief } from '../lib/projectedBelief.ts';
import { sellCloseStats, tradeStats } from '../lib/tradeStats.ts';
import type { Belief, ContractSpec, Fill, ModelTag, SellAllResult } from '../lib/types.ts';
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
  belief,
  model,
  outcomeUnit,
  outcomeMin = null,
  outcomeMax = null,
  cfg,
  sellRequest = null,
}: {
  marketId: string;
  spec: ContractSpec;
  tradable: boolean;
  mu: number;
  sigma: number;
  belief: Belief;
  // The market's model tag — so a Gen·basis bell trade previews as a placement.
  model?: ModelTag;
  outcomeUnit: string;
  outcomeMin?: number | null;
  outcomeMax?: number | null;
  cfg: Record<string, number | boolean>;
  sellRequest?: { qty: number; nonce: number } | null;
}) {
  const qc = useQueryClient();
  const { user, setUser } = useAuth();
  const portfolio = usePortfolio();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [qty, setQty] = useState(1);
  const [slippageOn, setSlippageOn] = useState(true);
  // Live preview: when ON, the fair/cost/analytics are recomputed on the client
  // every frame so they track a chart drag
  // interactively. When OFF, they come from the (debounced) server quote.
  const [livePreview, setLivePreview] = useState(false);
  const [lastFill, setLastFill] = useState<Fill | null>(null);
  const [lastSellAll, setLastSellAll] = useState<SellAllResult | null>(null);
  const [confirmSellAll, setConfirmSellAll] = useState(false);

  // A position click upstream sets the spec and bumps this request; respond by
  // switching to the Sell tab and pre-filling the full held size.
  useEffect(() => {
    if (!sellRequest) return;
    setSide('sell');
    if (sellRequest.qty > 0) setQty(sellRequest.qty);
  }, [sellRequest]);

  const signedQ = side === 'buy' ? Math.abs(qty) : -Math.abs(qty);
  // The contract and size respond IMMEDIATELY: they only change on a discrete user
  // action — a composer edit, or the moment a chart-handle drag is released — so the
  // quote and the trade analytics update the instant the curve settles, not on a
  // timer. Only the streaming belief is debounced, so live μ/σ ticks don't re-quote
  // on every tick.
  const beliefKey = `${mu.toFixed(2)}:${sigma.toFixed(2)}`;
  const beliefKeyD = useDebounced(beliefKey, 350);

  const quoteQ = useQuery({
    queryKey: ['quote', marketId, spec, signedQ, beliefKeyD],
    queryFn: () => api.quote(marketId, spec, signedQ).then((r) => r.quote),
    enabled: tradable && Math.abs(signedQ) > 0,
    placeholderData: keepPreviousData,
    retry: false,
    // Staleness floor: other traders move the maker's inventory / pool while the
    // user just looks, so a quote can silently go stale. Auto-refetch 30s after the
    // last fetch settles. react-query anchors this timer to the last fetch and
    // resets it on every refetch (an input change, a belief tick), so it only fires
    // after 30s of no server update — exactly the set-after / clear-on-next-call
    // behaviour we want, and it keeps firing even mid-drag (the quote key is stable
    // during a drag, so the timer runs off the last real fetch). Paused when the tab
    // is unfocused (default), so we don't poll while the user is away.
    refetchInterval: 30_000,
  });
  const quote = quoteQ.data;
  // A quote that is current for THIS spec/size. `isPlaceholderData` flags the
  // keepPreviousData window — but the quote key also churns on every (debounced)
  // belief tick from other traders' fills, and during THOSE windows the previous
  // quote is for the same contract/size and its maxPrice is still a valid bound
  // (the server re-checks at execution). So the gate only trips when the
  // placeholder belongs to a different spec/qty: without it an order could submit
  // with no quote at all (maxPrice undefined ⇒ the checked slippage guard silently
  // doesn't apply) or with a maxPrice from the wrong contract's exec price — and
  // gating belief ticks too would flicker-disable the button on busy markets.
  const orderKey = JSON.stringify([spec, signedQ]);
  const quoteOrderKey = useRef<string | null>(null);
  useEffect(() => {
    if (quoteQ.isSuccess && !quoteQ.isPlaceholderData) quoteOrderKey.current = orderKey;
  }, [quoteQ.isSuccess, quoteQ.isPlaceholderData, orderKey]);
  const quoteLive =
    !!quote && !quoteQ.isError && (!quoteQ.isPlaceholderData || quoteOrderKey.current === orderKey);

  // Subscribe to the chart's in-progress drag spec — but ONLY in live-preview
  // mode, so an ordinary drag never re-renders this panel (subscribe is a no-op
  // unsubscribe when the toggle is off, so the store fires no listeners here).
  const subscribeLive = useCallback(
    (fn: () => void) => (livePreview ? subscribeLiveSpec(fn) : () => {}),
    [livePreview],
  );
  const liveSpec = useSyncExternalStore(subscribeLive, getLiveSpec);
  const isDragging = livePreview && liveSpec != null;
  // The spec the preview prices: the live drag spec while dragging, else committed.
  const previewSpec = isDragging ? liveSpec : spec;

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
      setLastSellAll(null);
      if (user) setUser({ ...user, balance: fill.balance ?? user.balance });
      qc.invalidateQueries({ queryKey: qk.market(marketId) });
      qc.invalidateQueries({ queryKey: qk.stats(marketId) });
      qc.invalidateQueries({ queryKey: qk.historyAll(marketId) });
      qc.invalidateQueries({ queryKey: qk.portfolio });
      // ['position'] prefix-matches every open per-position detail panel — the trade
      // moved this contract's qty/basis/payout-distribution, so refetch it.
      qc.invalidateQueries({ queryKey: ['position'] });
    },
  });

  // All open positions the trader holds in *this* market — the sell-all set.
  const heldInMarket = useMemo(
    () =>
      (portfolio.data?.positions ?? []).filter((p) => p.marketId === marketId && p.quantity > 0),
    [portfolio.data, marketId],
  );

  // Pre-trade estimate at the *current* marks (close bid). Selling moves the
  // price, so the realized total is a touch lower — hence "≈".
  const sellAllEst = useMemo(() => {
    const proceeds = heldInMarket.reduce((s, p) => s + p.positionValue, 0);
    const profit = heldInMarket.reduce((s, p) => s + p.unrealizedPnl, 0);
    const costBasis = heldInMarket.reduce((s, p) => s + p.costBasis, 0);
    const contracts = heldInMarket.reduce((s, p) => s + p.quantity, 0);
    const ret = costBasis > 1e-9 ? profit / costBasis : null;
    return { proceeds, profit, costBasis, contracts, ret };
  }, [heldInMarket]);

  const sellAll = useMutation({
    mutationFn: () => api.sellAll(marketId).then((r) => r.result),
    onSuccess: (result) => {
      setLastSellAll(result);
      setLastFill(null);
      setConfirmSellAll(false);
      if (user) setUser({ ...user, balance: result.balance ?? user.balance });
      qc.invalidateQueries({ queryKey: qk.market(marketId) });
      qc.invalidateQueries({ queryKey: qk.stats(marketId) });
      qc.invalidateQueries({ queryKey: qk.historyAll(marketId) });
      qc.invalidateQueries({ queryKey: qk.portfolio });
      // sell-all closed every position here — refresh any open detail panels.
      qc.invalidateQueries({ queryKey: ['position'] });
    },
  });

  const isBuy = side === 'buy';

  // The market's real belief model (mixture / Student-t / Gaussian), so the live
  // previews price and project against its true shape — not a Gaussian stand-in.
  const beliefModel = useMemo(() => beliefFromView(belief), [belief]);

  // In live-preview mode, recompute fair / exec / totalCost on the client from the
  // (possibly mid-drag) preview spec, borrowing the spread from the last real
  // server quote. Exact fair, estimated cost — and it updates every frame.
  const estimate = useMemo(() => {
    if (!livePreview || !quote || Math.abs(signedQ) === 0) return null;
    try {
      return estimateQuote({
        spec: previewSpec,
        signedQ,
        belief: beliefModel,
        cfg: cfg as unknown as EngineConfig,
        serverInventory: quote.spread.inventory,
      });
    } catch {
      return null; // unpriceable spec mid-drag — fall back to the server quote
    }
  }, [livePreview, quote, previewSpec, signedQ, beliefModel, cfg]);

  // The numbers actually shown: the client estimate when previewing, else the
  // server quote. `estimated` flags that the panel is on the client estimate.
  const view = useMemo(() => {
    if (estimate)
      return {
        spec: previewSpec,
        fair: estimate.fair,
        execPrice: estimate.execPrice,
        totalCost: estimate.totalCost,
        estimated: true,
      };
    if (quote)
      return {
        spec,
        fair: quote.fair,
        execPrice: quote.execPrice,
        totalCost: quote.totalCost,
        estimated: false,
      };
    return null;
  }, [estimate, quote, previewSpec, spec]);

  const totalCost = view?.totalCost ?? 0;

  // Live "know your trade" analytics for the current order.
  const stats = useMemo(
    () =>
      view
        ? tradeStats({
            spec: view.spec,
            signedQ,
            totalCost: view.totalCost,
            fair: view.fair,
            mu,
            sigma,
            outcomeMin,
            outcomeMax,
            belief: beliefModel,
          })
        : null,
    [view, signedQ, mu, sigma, outcomeMin, outcomeMax, beliefModel],
  );

  // Projected next belief if this order fills (exact: same extractSignal→bayesUpdate
  // the server runs, with the market's own cfg). Tracks the preview spec, so it
  // follows a drag live in preview mode and settles on-drop otherwise.
  const projected = useMemo(() => {
    if (!tradable || Math.abs(signedQ) === 0) return null;
    try {
      return projectBelief({ spec: previewSpec, signedQ, belief: beliefModel, cfg, model });
    } catch {
      return null;
    }
  }, [tradable, previewSpec, signedQ, beliefModel, cfg, model]);

  // Publish it for the belief-over-time chart's "next" ghost point. Clear on
  // unmount.
  useEffect(() => {
    setProjectedBelief(projected);
  }, [projected]);
  useEffect(() => () => setProjectedBelief(null), []);

  // If this sell closes a contract the user already holds, the result is no
  // longer probabilistic — it realizes profit against what they paid. Match the
  // composed contract to a held long and show that instead of max-profit/loss.
  const held = useMemo(() => {
    const here = (portfolio.data?.positions ?? []).filter(
      (p) => p.marketId === marketId && sameContract(p.spec, spec) && p.quantity > 0,
    );
    return here[0] ?? null;
  }, [portfolio.data, marketId, spec]);

  const closeStats =
    !isBuy && quote && held
      ? sellCloseStats({
          proceeds: -totalCost,
          qty: Math.abs(signedQ),
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
          className={`absolute inset-y-0 left-0 w-1/2 rounded-lg transition-transform duration-300 [transition-timing-function:var(--ease-spring)] ${
            isBuy ? 'translate-x-0 bg-buy glow-buy' : 'translate-x-full bg-sell glow-sell'
          }`}
        />
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setSide(s);
              setConfirmSellAll(false);
            }}
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
          className="input-glow tnum rounded-lg border border-edge bg-panel-2 px-3 py-2 text-sm outline-none focus:border-accent"
        />
        {quote && (
          <button
            type="button"
            className="self-start text-xs text-accent hover:underline"
            // Buys floor to whole contracts; sells keep the fractional size so a
            // fractional holding (e.g. 2.5 from a partial fill) can be fully closed
            // the label prints the unfloored value either way.
            onClick={() => setQty(isBuy ? Math.floor(quote.maxExecutable) : quote.maxExecutable)}
          >
            max ≈ {fmt(quote.maxExecutable, 2)}
          </button>
        )}
      </label>

      {/* live-preview toggle: client-side estimate that tracks a chart drag */}
      <button
        type="button"
        onClick={() => setLivePreview((v) => !v)}
        className="flex items-center justify-between gap-3 rounded-lg border border-edge bg-panel-2 px-3 py-2 text-left transition-colors hover:border-accent/60"
      >
        <span className="flex flex-col">
          <span className="text-xs font-semibold text-fg">Live preview</span>
          <span className="text-[10px] text-muted">
            {livePreview
              ? 'Estimating on-device — updates as you drag the curve'
              : 'Server values, refreshed shortly after each change'}
          </span>
        </span>
        <span
          aria-hidden="true"
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${
            livePreview ? 'bg-accent glow-accent' : 'bg-edge'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform duration-200 [transition-timing-function:var(--ease-spring)] ${
              livePreview ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </span>
      </button>

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
            {view?.estimated && (
              <div className="-mt-0.5 mb-0.5 flex items-center gap-1.5 text-[10px] text-accent">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/70" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
                </span>
                live estimate — inventory term held from last server quote
              </div>
            )}
            {/* The unit only applies where fair = E[payoff] is in outcome units
                (LINEAR/CALL/PUT); binary/spread/bell fairs are unitless 0–1 prices. */}
            <Row
              label="Fair (mid)"
              value={`${fmt((view ?? quote).fair)}${
                ['LINEAR', 'CALL', 'PUT'].includes((view?.spec ?? spec).type)
                  ? ` ${outcomeUnit}`
                  : ''
              }`}
            />
            <div className="my-1 border-t border-edge pt-1.5 text-xs text-muted">
              {/* In live preview, base/adverse/vol track the drag; only inventory is held. */}
              <Row label="base" value={fmt((estimate?.spread ?? quote.spread).base, 4)} small />
              <Row
                label="inventory"
                value={fmt((estimate?.spread ?? quote.spread).inventory, 4)}
                small
              />
              <Row
                label="adverse-sel"
                value={fmt((estimate?.spread ?? quote.spread).adverseSelection, 4)}
                small
              />
              <Row
                label="volatility"
                value={fmt((estimate?.spread ?? quote.spread).volatility, 4)}
                small
              />
              <Row
                label="spread total"
                value={fmt((estimate?.spread ?? quote.spread).total, 4)}
                small
                strong
              />
            </div>
            <Row label="Exec price" value={fmt((view ?? quote).execPrice)} strong />
            <Row
              label={isBuy ? 'You pay' : 'You receive'}
              value={fmt(Math.abs(totalCost))}
              strong
              tone={isBuy ? 'sell' : 'buy'}
            />
            <div className="mt-1 border-t border-edge pt-1.5 text-xs text-muted">
              <Row
                label="Proj. belief μ"
                value={`${fmt((projected ?? quote.projectedBelief).mu, 1)} (σ ${fmt((projected ?? quote.projectedBelief).sigma, 1)})`}
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
        disabled={!tradable || qty <= 0 || trade.isPending || sellWithoutHolding || !quoteLive}
        onClick={() => trade.mutate()}
      >
        {trade.isPending
          ? 'Submitting…'
          : sellWithoutHolding
            ? 'Nothing to sell'
            : !quoteLive
              ? quoteQ.isError
                ? 'Quote unavailable'
                : 'Quoting…'
              : `${isBuy ? 'Buy' : 'Sell'} ${fmt(qty, 2)} contract${qty === 1 ? '' : 's'}`}
      </Button>

      {trade.isError && (
        <ErrorNote>
          {trade.error instanceof ApiError ? trade.error.message : 'Trade failed.'}
        </ErrorNote>
      )}

      {/* Sell-all: liquidate every open position in this market in one shot. */}
      {!isBuy && tradable && heldInMarket.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-edge bg-panel-2 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-fg">Liquidate everything</span>
            <span className="text-muted">
              {heldInMarket.length} position{heldInMarket.length === 1 ? '' : 's'} ·{' '}
              {fmt(sellAllEst.contracts, 0)} contracts
            </span>
          </div>
          <p className="text-[11px] text-muted">
            Closes all your positions in this market at once. Each sell moves the price, so later
            closes fill at the updated mark.
          </p>
          {confirmSellAll ? (
            <div className="flex flex-col gap-2">
              {/* Pre-trade estimate at current marks (≈ — selling moves the price). */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-edge bg-panel p-2.5">
                <AnalysisCell
                  label="Est. you receive"
                  raw={sellAllEst.proceeds}
                  text={`≈ ${fmt(sellAllEst.proceeds)}`}
                  tone="buy"
                />
                <AnalysisCell
                  label="Est. profit"
                  raw={sellAllEst.profit}
                  text={`≈ ${fmtSigned(sellAllEst.profit)}`}
                  tone={sellAllEst.profit >= 0 ? 'buy' : 'sell'}
                />
                <AnalysisCell
                  label="Cost basis"
                  raw={sellAllEst.costBasis}
                  text={fmt(sellAllEst.costBasis)}
                />
                <AnalysisCell
                  label="Est. return"
                  raw={sellAllEst.ret ?? 0}
                  text={sellAllEst.ret == null ? '—' : fmtSignedPct(sellAllEst.ret)}
                  tone={(sellAllEst.ret ?? 0) >= 0 ? 'buy' : 'sell'}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="sell"
                  className="flex-1"
                  disabled={sellAll.isPending}
                  onClick={() => sellAll.mutate()}
                >
                  {sellAll.isPending ? 'Selling…' : `Confirm — sell all ${heldInMarket.length}`}
                </Button>
                <Button
                  variant="ghost"
                  disabled={sellAll.isPending}
                  onClick={() => setConfirmSellAll(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmSellAll(true)}>
              Sell all positions
            </Button>
          )}
        </div>
      )}

      {sellAll.isError && (
        <ErrorNote>
          {sellAll.error instanceof ApiError ? sellAll.error.message : 'Sell all failed.'}
        </ErrorNote>
      )}

      {lastFill && <FillReceipt fill={lastFill} />}
      {lastSellAll && <SellAllReceipt result={lastSellAll} />}
    </div>
  );
}

function SellAllReceipt({ result }: { result: SellAllResult }) {
  return (
    <div className="animate-pop rounded-lg border border-buy/40 bg-buy-soft p-3 text-xs tnum">
      <div className="mb-1.5 font-semibold text-buy">
        Liquidated {result.count} position{result.count === 1 ? '' : 's'}
      </div>
      <Row label="Total received" value={fmtSigned(result.totalProceeds)} tone="buy" />
      <Row
        label="Realized P&L"
        value={fmtSigned(result.totalRealizedPnl)}
        tone={result.totalRealizedPnl >= 0 ? 'buy' : 'sell'}
      />
      <div className="mt-1.5 flex flex-col gap-0.5 border-t border-edge pt-1.5 text-muted">
        {result.fills.map((f) => (
          <div key={f.tradeId} className="flex items-center justify-between">
            <span>
              {fmt(f.quantity, 0)} @ {fmt(f.execPrice)}
              {f.partial ? ' (partial)' : ''}
            </span>
            <span className={f.realizedPnl >= 0 ? 'text-buy' : 'text-sell'}>
              {fmtSigned(f.realizedPnl)}
            </span>
          </div>
        ))}
      </div>
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
