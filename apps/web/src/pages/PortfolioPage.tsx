// Portfolio — every market the user has touched, grouped, with per-market P&L
// peak/drawdown, the resolved outcome, and a market-level Claim. Each group
// expands into its positions (reusing PositionRow's payout-distribution detail).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.tsx';
import { PositionRow } from '../components/PositionPanel.tsx';
import { Button, ErrorNote, Panel, Spinner, Stat, StatusBadge } from '../components/ui.tsx';
import { qk, usePortfolio } from '../hooks/queries.ts';
import { ApiError, api } from '../lib/api.ts';
import { type MarketGroup, groupPositionsByMarket, groupTotalPnl } from '../lib/derive.ts';
import { fmt, fmtSigned } from '../lib/format.ts';

export function PortfolioPage() {
  const portfolio = usePortfolio();

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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Portfolio</h1>
        <span className="text-sm text-muted">{groups.length} markets</span>
      </div>

      {totals && (
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-edge bg-panel p-4 sm:grid-cols-4">
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
      )}

      {groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-edge p-10 text-center text-muted">
          You haven't traded yet.{' '}
          <Link to="/" className="text-accent hover:underline">
            Browse markets →
          </Link>
        </div>
      ) : (
        groups.map((g) => <GroupCard key={g.marketId} group={g} />)
      )}
    </div>
  );
}

function GroupCard({ group: g }: { group: MarketGroup }) {
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
            className="text-muted hover:text-fg"
          >
            {open ? '▾' : '▸'}
          </button>
        </div>
      }
    >
      {g.claimable && (
        <div className="flex items-center justify-between border-b border-edge bg-panel-2 px-4 py-2 text-sm">
          <span className="text-muted">This market is settled — claim your payouts.</span>
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
        <div className="divide-y divide-edge">
          {g.positions.map((p) => (
            <PositionRow key={p.contractId} pos={p} hideClaim />
          ))}
        </div>
      )}
    </Panel>
  );
}
