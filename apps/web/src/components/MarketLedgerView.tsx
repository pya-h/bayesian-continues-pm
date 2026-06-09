// MarketLedgerView — the admin-only per-market "bank statement" (TASKS /
// MH-2). Fetches the reconstructed cash-flow ledger and shows rollup stat cards
// plus a filterable / sortable event table. Read-only; reconciliation status is
// surfaced as a badge. View choices (category + sort) persist across reloads.

import { type ReactNode, useMemo, useState } from 'react';
import { useAdminMarketLedger } from '../hooks/queries.ts';
import { ApiError } from '../lib/api.ts';
import { fmt, fmtSigned, timeAgo } from '../lib/format.ts';
import {
  ML_CATEGORIES,
  ML_SORTS,
  type MlCategory,
  type MlSortKey,
  filterMarketLedger,
  mlCategory,
  mlLabel,
  sortMarketLedger,
} from '../lib/marketLedgerView.ts';
import type { MarketLedgerEvent } from '../lib/types.ts';
import { oneOf, usePersistentState } from '../lib/usePersistentState.ts';
import { ErrorNote, Spinner, Stat } from './ui.tsx';

export function MarketLedgerView({ marketId }: { marketId: string }) {
  const ledger = useAdminMarketLedger(marketId);

  const [category, setCategory] = usePersistentState<MlCategory>(
    'admin.ledger.category',
    'all',
    oneOf(
      ML_CATEGORIES.map((c) => c.key),
      'all',
    ),
  );
  const [sort, setSort] = usePersistentState<MlSortKey>(
    'admin.ledger.sort',
    'recent',
    oneOf(
      ML_SORTS.map((s) => s.key),
      'recent',
    ),
  );
  const [query, setQuery] = useState('');

  const events = ledger.data?.events ?? [];
  const visible = useMemo(
    () => sortMarketLedger(filterMarketLedger(events, { category, query }), sort),
    [events, category, query, sort],
  );

  if (ledger.isLoading)
    return (
      <div className="mt-3">
        <Spinner label="Loading ledger…" />
      </div>
    );
  if (ledger.error || !ledger.data)
    return (
      <div className="mt-3">
        <ErrorNote>
          {ledger.error instanceof ApiError ? ledger.error.message : 'Failed to load ledger.'}
        </ErrorNote>
      </div>
    );

  const r = ledger.data.rollup;

  return (
    <div className="mt-3 flex flex-col gap-3">
      {/* rollups */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-edge bg-panel-2 p-3 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label="Genesis reserve" value={fmt(r.genesisReserve)} />
        <Stat label="Premium in" value={fmt(r.premiumIn)} tone="buy" />
        <Stat label="Premium out" value={fmt(r.premiumOut)} tone="sell" />
        <Stat label="LP deposits" value={fmt(r.lpDeposits)} tone="buy" />
        <Stat label="LP withdrawals" value={fmt(r.lpWithdrawals)} tone="sell" />
        <Stat label="Refunds" value={fmt(r.refunds)} tone="sell" />
        <Stat label="Trader payouts" value={fmt(r.traderPayouts)} sub="settlement liability" />
        <Stat label="LP claims paid" value={fmt(r.lpClaimsPaid)} />
        <Stat label="Pool cash" value={fmt(r.currentCash)} tone="accent" />
        <Stat label="Pool NAV" value={fmt(r.nav)} />
        <Stat label="Reserve required" value={fmt(r.reserveRequired)} />
        <Stat label="Cash final (LP residual)" value={fmt(r.cashFinal)} sub="cash − payouts" />
      </div>

      {/* reconciliation + event count */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-semibold ${
            r.reconciles
              ? 'border-buy/40 bg-buy/10 text-buy'
              : 'border-sell/40 bg-sell/10 text-sell'
          }`}
        >
          {r.reconciles ? '✓ reconciles' : '⚠ mismatch'}
          <span className="font-normal text-muted">
            net pool {fmtSigned(r.netPoolChange)} = cash {fmt(r.currentCash)}
          </span>
        </span>
        <span className="text-muted">
          {r.eventCount} event{r.eventCount === 1 ? '' : 's'} · {r.tradeCount} trade
          {r.tradeCount === 1 ? '' : 's'}
        </span>
      </div>

      {/* filters */}
      {events.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {ML_CATEGORIES.map((c) => (
              <Chip key={c.key} active={category === c.key} onClick={() => setCategory(c.key)}>
                {c.label}
              </Chip>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search user…"
              className="w-32 rounded-lg border border-edge bg-panel px-2.5 py-1 text-xs text-fg placeholder:text-muted outline-none transition-colors focus:border-accent"
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as MlSortKey)}
              className="rounded-lg border border-edge bg-panel px-2 py-1 text-xs text-fg outline-none transition-colors focus:border-accent"
            >
              {ML_SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* event table */}
      {events.length === 0 ? (
        <div className="rounded-lg border border-dashed border-edge p-6 text-center text-xs text-muted">
          No pool events yet.
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-edge p-5 text-center text-xs text-muted">
          No events match this filter.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-edge">
          <table className="w-full text-xs tnum">
            <thead className="border-b border-edge text-muted">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">Event</th>
                <th className="px-2 py-2 font-medium">User</th>
                <th className="px-2 py-2 text-right font-medium">Δ pool</th>
                <th className="px-2 py-2 text-right font-medium">Cash after</th>
                <th className="px-3 py-2 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e, i) => (
                <Row key={e.ref?.id ?? `${e.kind}-${i}`} e={e} index={i} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type CatMeta = { rail: string; chip: string };
const CAT_FALLBACK: CatMeta = { rail: 'bg-edge', chip: 'border-edge bg-panel-2 text-muted' };
const CAT_META: Record<string, CatMeta> = {
  liquidity: { rail: 'bg-muted/60', chip: 'border-edge bg-panel-2 text-fg' },
  trades: { rail: 'bg-accent', chip: 'border-accent/40 bg-accent-soft text-accent' },
  settlement: { rail: 'bg-buy', chip: 'border-buy/40 bg-buy/10 text-buy' },
};

function Row({ e, index }: { e: MarketLedgerEvent; index: number }) {
  const meta = CAT_META[mlCategory(e.kind)] ?? CAT_FALLBACK;
  const positive = e.delta >= 0;
  return (
    <tr
      style={{ animationDelay: `${Math.min(index, 14) * 18}ms` }}
      className="animate-fade-up border-t border-edge/60 transition-colors hover:bg-panel-2/40"
    >
      <td className="py-1.5 pr-2 pl-0">
        <div className="flex items-center">
          <span
            className={`mr-2.5 h-6 w-0.5 shrink-0 rounded-full ${meta.rail}`}
            aria-hidden="true"
          />
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.chip}`}
          >
            {mlLabel(e.kind)}
          </span>
          {e.note && <span className="ml-2 text-[11px] text-muted">{e.note}</span>}
        </div>
      </td>
      <td className="px-2 py-1.5 text-muted">{e.username ?? '—'}</td>
      <td className={`px-2 py-1.5 text-right font-semibold ${positive ? 'text-buy' : 'text-sell'}`}>
        {fmtSigned(e.delta)}
      </td>
      <td className="px-2 py-1.5 text-right text-muted">
        {e.cashAfter == null ? '—' : fmt(e.cashAfter)}
      </td>
      <td
        className="whitespace-nowrap px-3 py-1.5 text-right text-muted"
        title={new Date(e.at).toLocaleString()}
      >
        {timeAgo(e.at)}
      </td>
    </tr>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
        active
          ? 'border-accent/50 bg-accent-soft text-accent'
          : 'border-edge bg-panel-2 text-muted hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}
