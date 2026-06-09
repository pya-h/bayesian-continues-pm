// Portfolio — every market the user has touched, grouped, with per-market P&L
// peak/drawdown, the resolved outcome, and a market-level Claim. Each position
// draws its own payoff diagram (P&L vs outcome) and expands into deeper stats.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.tsx';
import { type PositionBelief, PositionRow } from '../components/PositionPanel.tsx';
import { Button, ErrorNote, Panel, Spinner, Stat, StatusBadge } from '../components/ui.tsx';
import { qk, useMarkets, usePortfolio } from '../hooks/queries.ts';
import { ApiError, api } from '../lib/api.ts';
import { type MarketGroup, groupPositionsByMarket, groupTotalPnl } from '../lib/derive.ts';
import { fmt, fmtSigned } from '../lib/format.ts';

export function PortfolioPage() {
  const portfolio = usePortfolio();
  const markets = useMarkets();

  // marketId → live belief context, so each position can draw its payoff curve.
  const beliefs = useMemo(() => {
    const map = new Map<string, PositionBelief>();
    for (const m of markets.data ?? []) {
      map.set(m.marketId, {
        mu: m.belief.mu,
        sigma: m.belief.sigma,
        outcomeUnit: m.outcomeUnit,
        outcomeMin: m.outcomeMin,
        outcomeMax: m.outcomeMax,
      });
    }
    return map;
  }, [markets.data]);

  if (portfolio.isLoading) return <Spinner label="Loading portfolio…" />;
  if (portfolio.error)
    return (
      <ErrorNote>
        {portfolio.error instanceof ApiError
          ? portfolio.error.message
          : 'Failed to load portfolio.'}
      </ErrorNote>
    );

  const data = portfolio.data;
  const groups = groupPositionsByMarket(data?.positions ?? []);
  const totals = data?.totals;
  const claimable = groups.filter((g) => g.claimable).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-gradient text-2xl font-semibold tracking-tight">Portfolio</h1>
        <span className="text-sm text-muted">
          {groups.length} market{groups.length === 1 ? '' : 's'}
        </span>
      </div>

      {totals && (
        <div className="overflow-hidden rounded-xl border border-edge bg-panel">
          <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
            <Stat label="Market value" value={fmt(totals.marketValue)} />
            <Stat
              label="Unrealized PnL"
              value={fmtSigned(totals.unrealized)}
              tone={totals.unrealized >= 0 ? 'buy' : 'sell'}
            />
            <Stat
              label="Realized PnL"
              value={fmtSigned(totals.realized)}
              tone={totals.realized >= 0 ? 'buy' : 'sell'}
            />
            <Stat
              label="Total PnL"
              value={fmtSigned(totals.total)}
              tone={totals.total >= 0 ? 'buy' : 'sell'}
            />
          </div>
          <PnlBar realized={totals.realized} unrealized={totals.unrealized} />
        </div>
      )}

      {claimable > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft px-4 py-2.5 text-sm text-accent animate-fade-in">
          <span className="text-base">🎉</span>
          You have payouts to claim in {claimable} settled market{claimable === 1 ? '' : 's'}.
        </div>
      )}

      {groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-edge p-10 text-center text-muted">
          You haven't traded yet.{' '}
          <Link to="/" className="text-accent hover:underline">
            Browse markets →
          </Link>
        </div>
      ) : (
        groups.map((g) => <GroupCard key={g.marketId} group={g} belief={beliefs.get(g.marketId)} />)
      )}
    </div>
  );
}

function PnlBar({ realized, unrealized }: { realized: number; unrealized: number }) {
  const mag = Math.abs(realized) + Math.abs(unrealized);
  if (mag < 1e-9) return null;
  const rPct = (Math.abs(realized) / mag) * 100;
  const uPct = (Math.abs(unrealized) / mag) * 100;
  return (
    <div className="border-t border-edge px-4 py-3">
      <div className="flex h-2 overflow-hidden rounded-full bg-panel-2">
        <span
          className={realized >= 0 ? 'bg-buy' : 'bg-sell'}
          style={{ width: `${rPct}%` }}
          title={`Realized ${fmtSigned(realized)}`}
        />
        <span
          className={unrealized >= 0 ? 'bg-buy/60' : 'bg-sell/60'}
          style={{ width: `${uPct}%` }}
          title={`Unrealized ${fmtSigned(unrealized)}`}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] uppercase tracking-wide text-muted">
        <span>realized {fmtSigned(realized, 0)}</span>
        <span>unrealized {fmtSigned(unrealized, 0)}</span>
      </div>
    </div>
  );
}

function GroupCard({ group: g, belief }: { group: MarketGroup; belief?: PositionBelief }) {
  const [open, setOpen] = useState(true);
  const qc = useQueryClient();
  const { user, setUser } = useAuth();

  const claim = useMutation({
    mutationFn: () => api.claim(g.marketId).then((r) => r.claim),
    onSuccess: (c) => {
      if (user && c.credited && !user.isInfinite)
        setUser({ ...user, balance: user.balance + c.credited });
      qc.invalidateQueries({ queryKey: qk.portfolio });
    },
  });

  const total = groupTotalPnl(g);

  return (
    <Panel
      className="animate-fade-up"
      title={
        <span className="flex items-center gap-2">
          <Link to={`/markets/${g.marketId}`} className="hover:text-accent">
            {g.marketTitle}
          </Link>
          <StatusBadge status={g.marketStatus} />
        </span>
      }
      right={
        <div className="flex items-center gap-3 text-xs">
          <span className="tnum text-muted">
            value {fmt(g.value)} · peak {fmtSigned(g.peakProfit)} · dd {fmt(g.drawdownFromPeak)}
          </span>
          <span className={`tnum font-semibold ${total >= 0 ? 'text-buy' : 'text-sell'}`}>
            {fmtSigned(total)}
          </span>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? 'Collapse' : 'Expand'}
            className="text-muted transition-colors hover:text-fg"
          >
            {open ? '▾' : '▸'}
          </button>
        </div>
      }
    >
      {g.claimable && (
        <div className="flex items-center justify-between border-b border-edge bg-accent-soft px-4 py-2 text-sm">
          <span className="text-accent">This market is settled — claim your payouts.</span>
          <div className="flex items-center gap-2">
            {claim.isError && (
              <span className="text-xs text-sell">
                {claim.error instanceof ApiError ? claim.error.message : 'Claim failed.'}
              </span>
            )}
            <Button
              variant="primary"
              className="px-3 py-1.5 text-xs"
              disabled={claim.isPending}
              onClick={() => claim.mutate()}
            >
              {claim.isPending ? 'Claiming…' : 'Claim payouts'}
            </Button>
          </div>
        </div>
      )}
      {open && (
        <div className="grid grid-cols-1 items-start gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">
          {g.positions.map((p, i) => (
            <div
              key={p.contractId}
              style={{ animationDelay: `${Math.min(i, 6) * 40}ms` }}
              className="animate-fade-up rounded-lg border border-edge bg-panel-2/30"
            >
              <PositionRow pos={p} belief={belief} hideClaim />
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
