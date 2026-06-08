// Your holdings in *this* market: cost basis, live bid-mark value, unrealized /
// realized PnL, and an expandable payout-distribution panel (from
// /users/me/positions/:contractId, i.e. core.positionStats). When the market is
// SETTLED, a Claim button credits the recorded payout.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.tsx';
import { qk, usePortfolio } from '../hooks/queries.ts';
import { ApiError, api } from '../lib/api.ts';
import { fmt, fmtPct, fmtSigned, specLabel } from '../lib/format.ts';
import type { PortfolioPosition } from '../lib/types.ts';
import { PositionPnlChart } from './PositionPnlChart.tsx';
import { Button, Spinner } from './ui.tsx';

export interface PositionBelief {
  mu: number;
  sigma: number;
  outcomeUnit: string;
  outcomeMin: number | null;
  outcomeMax: number | null;
}

export function PositionPanel({
  marketId,
  belief,
}: {
  marketId: string;
  belief?: PositionBelief;
}) {
  const portfolio = usePortfolio();
  const here = (portfolio.data?.positions ?? []).filter((p) => p.marketId === marketId);

  if (portfolio.isLoading)
    return (
      <div className="p-4">
        <Spinner label="Loading positions…" />
      </div>
    );
  if (here.length === 0)
    return <p className="p-4 text-sm text-muted">No positions in this market yet.</p>;

  return (
    <div className="divide-y divide-edge">
      {here.map((p) => (
        <PositionRow key={p.contractId} pos={p} belief={belief} />
      ))}
    </div>
  );
}

export function PositionRow({
  pos,
  hideClaim = false,
  belief,
}: { pos: PortfolioPosition; hideClaim?: boolean; belief?: PositionBelief }) {
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

  return (
    <div className="px-4 py-3 text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
      >
        <div>
          <div className="font-semibold">{specLabel(pos.spec)}</div>
          <div className="tnum text-xs text-muted">
            {fmt(pos.quantity, 2)} @ {fmt(pos.avgEntryPrice)} · basis {fmt(pos.costBasis)}
          </div>
        </div>
        <div className="text-right tnum">
          <div className={`font-semibold ${pnlTone}`}>{fmtSigned(pos.unrealizedPnl)}</div>
          <div className="text-xs text-muted">value {fmt(pos.positionValue)}</div>
        </div>
      </button>

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
              onClick={() => claim.mutate()}
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
        <div className="mt-3 rounded-lg border border-edge bg-panel-2 p-3 text-xs tnum">
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
