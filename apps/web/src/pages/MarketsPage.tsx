// Markets index — one card per market: status, consensus μ, σ band, your badge.

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ErrorNote, Skeleton, StatusBadge } from '../components/ui.tsx';
import { useMarkets, usePortfolio } from '../hooks/queries.ts';
import { ApiError } from '../lib/api.ts';
import { fmt, fmtCompact } from '../lib/format.ts';
import type { MarketView } from '../lib/types.ts';

export function MarketsPage() {
  const markets = useMarkets();
  const portfolio = usePortfolio();

  // marketId → number of open positions the user holds, for the "your-position" badge.
  const heldByMarket = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of portfolio.data?.positions ?? []) {
      if (p.quantity > 0) map.set(p.marketId, (map.get(p.marketId) ?? 0) + 1);
    }
    return map;
  }, [portfolio.data]);

  if (markets.isLoading)
    return (
      <div>
        <div className="mb-4 flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Markets</h1>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      </div>
    );
  if (markets.error)
    return (
      <ErrorNote>
        {markets.error instanceof ApiError ? markets.error.message : 'Failed to load markets.'}
      </ErrorNote>
    );

  const rows = markets.data ?? [];

  return (
    <div>
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Markets</h1>
        <span className="text-sm text-muted">{rows.length} total</span>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-edge p-10 text-center text-muted">
          No markets yet. An admin needs to create one.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((m, i) => (
            <MarketCard
              key={m.marketId}
              market={m}
              held={heldByMarket.get(m.marketId) ?? 0}
              index={i}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MarketCard({
  market: m,
  held,
  index,
}: { market: MarketView; held: number; index: number }) {
  const { mu, sigma } = m.belief;
  return (
    <Link
      to={`/markets/${m.marketId}`}
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
      className="lift group flex flex-col gap-3 rounded-xl border border-edge bg-panel p-4 animate-fade-up hover:border-accent/60 hover:shadow-lg hover:shadow-black/20"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold leading-snug group-hover:text-accent">{m.title}</h3>
        <StatusBadge status={m.status} />
      </div>
      {m.description && <p className="line-clamp-2 text-sm text-muted">{m.description}</p>}
      <div className="mt-auto flex items-end justify-between">
        <div>
          <div className="text-xs text-muted">Consensus</div>
          <div className="tnum text-xl font-semibold">
            {fmt(mu, 0)}
            <span className="ml-1 text-sm font-normal text-muted">{m.outcomeUnit}</span>
          </div>
          <div className="tnum text-xs text-muted">
            ± {fmt(sigma, 0)} σ &nbsp;·&nbsp; [{fmt(mu - sigma, 0)}, {fmt(mu + sigma, 0)}]
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted">NAV</div>
          <div className="tnum text-sm font-semibold">{fmtCompact(m.pool.nav)}</div>
          {held > 0 && (
            <div className="mt-1 inline-block rounded bg-accent-soft px-1.5 py-0.5 text-xs font-semibold text-accent">
              {held} position{held > 1 ? 's' : ''}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}
