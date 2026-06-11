import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MiniBelief } from '../components/MiniBelief.tsx';
import { ErrorNote, Skeleton, StatusBadge } from '../components/ui.tsx';
import { useMarkets, usePortfolio } from '../hooks/queries.ts';
import { ApiError } from '../lib/api.ts';
import {
  MARKET_SORTS,
  MARKET_STATUS_FILTERS,
  type MarketSort,
  type MarketStatusFilter,
  filterSortMarkets,
  statusCounts,
} from '../lib/derive.ts';
import { fmt, fmtCompact, timeAgo } from '../lib/format.ts';
import type { MarketView } from '../lib/types.ts';

export function MarketsPage() {
  const markets = useMarkets();
  const portfolio = usePortfolio();

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<MarketStatusFilter>('ALL');
  const [sort, setSort] = useState<MarketSort>('activity');

  // marketId → number of open positions the user holds, for the "your-position" badge.
  const heldByMarket = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of portfolio.data?.positions ?? []) {
      if (p.quantity > 0) map.set(p.marketId, (map.get(p.marketId) ?? 0) + 1);
    }
    return map;
  }, [portfolio.data]);

  const all = markets.data ?? [];
  const counts = useMemo(() => statusCounts(all), [all]);
  const rows = useMemo(
    () => filterSortMarkets(all, { query, status, sort }),
    [all, query, status, sort],
  );

  if (markets.isLoading)
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-lg font-semibold">Markets</h1>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-52" />
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

  return (
    <div className="flex flex-col gap-5">
      {/* heading + search + sort */}
      <div className="hero-glow gradient-border surface relative flex flex-col gap-3 overflow-hidden rounded-2xl border border-edge bg-panel p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <h1 className="text-gradient text-2xl font-semibold tracking-tight">Markets</h1>
            <span className="text-sm text-muted">{all.length} live</span>
          </div>
          <p className="text-sm text-muted">
            Trade the crowd’s forecast — pick a market to dive in.
          </p>
        </div>
        <div className="relative flex items-center gap-2">
          <div className="relative">
            <span className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 text-muted">
              ⌕
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search markets…"
              className="input-glow w-44 rounded-lg border border-edge bg-panel-2 py-1.5 pr-3 pl-7 text-sm outline-none transition-colors focus:border-accent sm:w-56"
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <span className="hidden sm:inline">Sort</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as MarketSort)}
              className="input-glow rounded-lg border border-edge bg-panel-2 px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
            >
              {MARKET_SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* status filter chips */}
      <div className="-mx-1 flex flex-wrap gap-1.5 overflow-x-auto px-1">
        {MARKET_STATUS_FILTERS.map((s) => {
          const active = status === s;
          const n = counts[s] ?? 0;
          return (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium capitalize transition-all duration-200 ${
                active
                  ? 'btn-glow-accent border-transparent bg-grad-accent text-[var(--color-on-accent)]'
                  : 'border-edge bg-panel-2 text-muted hover:border-accent/40 hover:text-fg'
              }`}
            >
              {s === 'ALL' ? 'All' : s.toLowerCase()}
              <span
                className={`tnum ${active ? 'text-[var(--color-on-accent)]/80' : 'text-muted/70'}`}
              >
                {n}
              </span>
            </button>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-edge p-10 text-center text-muted">
          {all.length === 0
            ? 'No markets yet. An admin needs to create one.'
            : 'No markets match your filters.'}
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
  const resolved = m.thetaStar != null;
  return (
    <Link
      to={`/markets/${m.marketId}`}
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
      className="lift surface group relative flex flex-col gap-3 overflow-hidden rounded-xl border border-edge bg-panel p-4 animate-fade-up"
    >
      {/* accent wash that blooms on hover */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-grad-accent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
      />
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold leading-snug transition-colors group-hover:text-accent">
          {m.title}
        </h3>
        <StatusBadge status={m.status} />
      </div>
      {m.description && <p className="line-clamp-1 text-sm text-muted">{m.description}</p>}

      {/* belief-density signature */}
      <div className="h-14 w-full overflow-hidden rounded-lg border border-edge/40 bg-panel-2/50">
        <MiniBelief
          mu={mu}
          sigma={sigma}
          outcomeMin={m.outcomeMin}
          outcomeMax={m.outcomeMax}
          thetaStar={m.thetaStar}
        />
      </div>

      <div className="mt-auto flex items-end justify-between">
        <div>
          <div className="text-xs text-muted">{resolved ? 'Resolved θ*' : 'Consensus'}</div>
          <div className="tnum text-2xl font-semibold leading-tight">
            {fmt(resolved ? (m.thetaStar ?? mu) : mu, 0)}
            <span className="ml-1 text-sm font-normal text-muted">{m.outcomeUnit}</span>
          </div>
          <div className="tnum text-xs text-muted">
            68% CI [{fmt(mu - sigma, 0)}, {fmt(mu + sigma, 0)}]
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted">Pool</div>
          <div className="tnum text-sm font-semibold">{fmtCompact(m.pool.nav)}</div>
          {held > 0 ? (
            <div className="mt-1 inline-block rounded bg-accent-soft px-1.5 py-0.5 text-xs font-semibold text-accent">
              {held} position{held > 1 ? 's' : ''}
            </div>
          ) : (
            <div className="mt-1 text-[10px] text-muted/70">{timeAgo(m.createdAt)}</div>
          )}
        </div>
      </div>
    </Link>
  );
}
