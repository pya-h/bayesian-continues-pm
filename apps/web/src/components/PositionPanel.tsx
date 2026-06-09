// Your holdings in *this* market: cost basis, live bid-mark value, unrealized /
// realized PnL, and an expandable payout-distribution panel (from
// /users/me/positions/:contractId, i.e. core.positionStats). When the market is
// SETTLED, a Claim button credits the recorded payout.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext.tsx';
import { qk, usePortfolio } from '../hooks/queries.ts';
import { ApiError, api } from '../lib/api.ts';
import { fmt, fmtPct, fmtSigned, specLabel } from '../lib/format.ts';
import {
  POSITION_SORTS,
  type PositionSortKey,
  isClosedPosition,
  sortPositions,
} from '../lib/positionView.ts';
import type { PortfolioPosition } from '../lib/types.ts';
import { asBool, oneOf, usePersistentState } from '../lib/usePersistentState.ts';
import { PositionPnlChart } from './PositionPnlChart.tsx';
import { Button, Spinner, Toggle } from './ui.tsx';

export interface PositionBelief {
  mu: number;
  sigma: number;
  outcomeUnit: string;
  outcomeMin: number | null;
  outcomeMax: number | null;
}

export function PositionSortSelect({
  value,
  onChange,
}: {
  value: PositionSortKey;
  onChange: (k: PositionSortKey) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-muted">
      <span>Sort</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as PositionSortKey)}
        className="rounded-md border border-edge bg-panel-2 px-1.5 py-1 text-[11px] text-fg outline-none focus:border-accent"
      >
        {POSITION_SORTS.map((s) => (
          <option key={s.key} value={s.key}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function PositionPanel({
  marketId,
  belief,
  onSell,
  grid = false,
}: {
  marketId: string;
  belief?: PositionBelief;
  onSell?: (pos: PortfolioPosition) => void;
  grid?: boolean;
}) {
  const portfolio = usePortfolio();
  // Shared across markets and persisted, so the trader's preferred ordering /
  // closed-visibility sticks between markets and reloads.
  const [sort, setSort] = usePersistentState<PositionSortKey>(
    'positions.sort',
    'recent',
    oneOf(
      POSITION_SORTS.map((s) => s.key),
      'recent',
    ),
  );
  const [showClosed, setShowClosed] = usePersistentState(
    'positions.showClosed',
    false,
    asBool(false),
  );

  const all = useMemo(
    () => (portfolio.data?.positions ?? []).filter((p) => p.marketId === marketId),
    [portfolio.data, marketId],
  );
  const closedCount = useMemo(() => all.filter(isClosedPosition).length, [all]);
  const here = useMemo(() => {
    const rows = showClosed ? all : all.filter((p) => !isClosedPosition(p));
    return sortPositions(rows, sort);
  }, [all, showClosed, sort]);

  if (portfolio.isLoading)
    return (
      <div className="p-4">
        <Spinner label="Loading positions…" />
      </div>
    );
  if (all.length === 0)
    return <p className="p-4 text-sm text-muted">No positions in this market yet.</p>;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-4 py-2">
        <span className="text-[11px] text-muted">
          {here.length} position{here.length === 1 ? '' : 's'}
          {!showClosed && closedCount > 0 && ` · ${closedCount} closed hidden`}
        </span>
        <div className="flex items-center gap-3">
          {closedCount > 0 && (
            <span className="flex items-center gap-1.5 text-[11px] text-muted">
              <span>Closed</span>
              <Toggle checked={showClosed} onChange={setShowClosed} label="Show closed positions" />
            </span>
          )}
          <PositionSortSelect value={sort} onChange={setSort} />
        </div>
      </div>
      {here.length === 0 ? (
        <p className="p-4 text-sm text-muted">
          No active positions — toggle <span className="font-medium text-fg">Closed</span> to see
          the rest.
        </p>
      ) : grid ? (
        <div className="grid grid-cols-1 items-start gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">
          {here.map((p, i) => (
            <div
              key={p.contractId}
              style={{ animationDelay: `${Math.min(i, 6) * 40}ms` }}
              className="animate-fade-up rounded-lg border border-edge bg-panel-2/30"
            >
              <PositionRow pos={p} belief={belief} onSell={onSell} />
            </div>
          ))}
        </div>
      ) : (
        <div className="divide-y divide-edge">
          {here.map((p) => (
            <PositionRow key={p.contractId} pos={p} belief={belief} onSell={onSell} />
          ))}
        </div>
      )}
    </div>
  );
}

export function PositionRow({
  pos,
  hideClaim = false,
  belief,
  onSell,
}: {
  pos: PortfolioPosition;
  hideClaim?: boolean;
  belief?: PositionBelief;
  onSell?: (pos: PortfolioPosition) => void;
}) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { user, setUser } = useAuth();

  const detail = useQuery({
    queryKey: qk.position(pos.contractId),
    queryFn: () => api.positionDetail(pos.contractId).then((r) => r.position),
    enabled: open,
  });

  const claim = useMutation({
    mutationFn: () => api.claim(pos.marketId).then((r) => r.claim),
    onSuccess: (c) => {
      if (user && c.credited) setUser({ ...user, balance: user.balance + c.credited });
      qc.invalidateQueries({ queryKey: qk.portfolio });
    },
  });

  const settled = pos.marketStatus === 'SETTLED';
  const pnlTone = pos.unrealizedPnl >= 0 ? 'text-buy' : 'text-sell';
  // A position is sellable when the market is live and the caller wired up a sell
  // handler. Clicking anywhere on the card (header, basis line, or the payoff
  // chart) then jumps the trade panel to Sell, pre-filled.
  const sellable = !!onSell && pos.marketStatus === 'OPEN' && pos.quantity > 0;
  const onRowClick = () => (sellable ? onSell?.(pos) : setOpen((o) => !o));

  return (
    // biome-ignore lint/a11y/useSemanticElements: card wraps its own chevron/claim buttons, so a real <button> would nest interactive controls; keyboard handler + tabIndex below keep it accessible.
    <div
      role="button"
      tabIndex={0}
      onClick={onRowClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onRowClick();
        }
      }}
      title={sellable ? 'Sell this position' : undefined}
      aria-label={sellable ? `Sell ${specLabel(pos.spec)}` : 'Toggle position details'}
      className="group cursor-pointer px-4 py-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      <div className="flex w-full items-center justify-between gap-2">
        <div className="flex-1 text-left">
          <div className="flex items-center gap-1.5 font-semibold">
            {specLabel(pos.spec)}
            {sellable && (
              <span className="rounded bg-sell/15 px-1.5 py-0.5 text-[10px] font-semibold text-sell opacity-0 transition-opacity group-hover:opacity-100">
                Sell →
              </span>
            )}
          </div>
          <div className="tnum text-xs text-muted">
            {fmt(pos.quantity, 2)} @ {fmt(pos.avgEntryPrice)} · basis {fmt(pos.costBasis)}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="text-right tnum">
            <div className={`font-semibold ${pnlTone}`}>{fmtSigned(pos.unrealizedPnl)}</div>
            <div className="text-xs text-muted">value {fmt(pos.positionValue)}</div>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((o) => !o);
            }}
            aria-label={open ? 'Hide stats' : 'Show stats'}
            aria-expanded={open}
            className="rounded-md p-1 text-muted transition-colors hover:bg-panel-2 hover:text-fg"
          >
            <span className={`block transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
          </button>
        </div>
      </div>

      {belief && (
        <div className="mt-3 rounded-lg border border-edge bg-panel-2/60 p-2">
          <div className="mb-1 flex items-center justify-between px-1 text-[10px] uppercase tracking-wide text-muted">
            <span>Payoff vs outcome</span>
            <span className="flex items-center gap-2">
              <Legend color="var(--color-buy)" label="profit" />
              <Legend color="var(--color-sell)" label="loss" />
            </span>
          </div>
          <PositionPnlChart
            spec={pos.spec}
            quantity={pos.quantity}
            costBasis={pos.costBasis}
            mu={belief.mu}
            sigma={belief.sigma}
            outcomeUnit={belief.outcomeUnit}
            outcomeMin={belief.outcomeMin}
            outcomeMax={belief.outcomeMax}
            thetaStar={pos.final?.thetaStar ?? null}
            finalPnl={pos.final?.finalPnl ?? null}
          />
        </div>
      )}

      {pos.final && (
        <div className="mt-2 flex items-center justify-between rounded-lg border border-edge bg-panel-2 px-3 py-2 text-xs tnum">
          <span className="text-muted">
            Resolved θ* {fmt(pos.final.thetaStar, 0)} · payout {fmt(pos.final.payout)} ·{' '}
            <span className={pos.final.finalPnl >= 0 ? 'text-buy' : 'text-sell'}>
              {fmtSigned(pos.final.finalPnl)}
            </span>
          </span>
          {settled && !pos.final.claimed && !hideClaim && (
            <Button
              variant="primary"
              className="px-2.5 py-1 text-xs"
              disabled={claim.isPending}
              onClick={(e) => {
                e.stopPropagation();
                claim.mutate();
              }}
            >
              {claim.isPending ? '…' : 'Claim'}
            </Button>
          )}
          {pos.final.claimed && <span className="text-buy">claimed ✓</span>}
        </div>
      )}
      {claim.isError && (
        <p className="mt-1 text-xs text-sell">
          {claim.error instanceof ApiError ? claim.error.message : 'Claim failed.'}
        </p>
      )}

      {open && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: not a control — only stops the parent row's sell from firing while reading the stats detail.
        <div
          onClick={(e) => e.stopPropagation()}
          className="mt-3 rounded-lg border border-edge bg-panel-2 p-3 text-xs tnum"
        >
          {detail.isLoading ? (
            <Spinner label="Loading stats…" />
          ) : detail.data ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <Cell label="Expected payout" value={fmt(detail.data.stats.expectedPayout)} />
              <Cell label="Expected PnL" value={fmtSigned(detail.data.stats.expectedPnl)} />
              <Cell label="Payout σ" value={fmt(detail.data.stats.payoutStd)} />
              <Cell label="P(profit)" value={fmtPct(detail.data.stats.pProfit)} />
              <Cell
                label={detail.data.stats.maxIsP99 ? 'Max payout (p99)' : 'Max payout'}
                value={fmt(detail.data.stats.maxPayout)}
              />
              <Cell label="VaR 95%" value={fmt(detail.data.stats.var95)} />
              <Cell label="CVaR 95%" value={fmt(detail.data.stats.cvar95)} />
              <Cell
                label="Breakeven θ"
                value={
                  detail.data.stats.breakevenTheta == null
                    ? '—'
                    : fmt(detail.data.stats.breakevenTheta, 0)
                }
              />
              <Cell label="Mark peak" value={fmtSigned(detail.data.markPath.peak)} />
              <Cell label="Max drawdown" value={fmt(detail.data.markPath.maxDrawdown)} />
            </div>
          ) : (
            <p className="text-sell">Failed to load stats.</p>
          )}
        </div>
      )}
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className="font-medium text-fg">{value}</span>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2 w-2 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}
