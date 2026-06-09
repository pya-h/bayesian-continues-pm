// Transactions — the user's full platform activity ledger: trades, LP moves
// market creation, settlement claims, refunds, and admin funding. A stats header
// summarises lifetime flows; the list filters by category + free text and sorts
// with view choices persisted across reloads. Data is read-only from the API.

import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorNote, Panel, Spinner, Stat } from '../components/ui.tsx';
import { useTransactions } from '../hooks/queries.ts';
import { ApiError } from '../lib/api.ts';
import { fmt, fmtSigned, timeAgo } from '../lib/format.ts';
import {
  TX_CATEGORIES,
  TX_SORTS,
  type TxCategory,
  type TxSortKey,
  filterTransactions,
  sortTransactions,
  txCategory,
  txLabel,
} from '../lib/txView.ts';
import type { Transaction } from '../lib/types.ts';
import { oneOf, usePersistentState } from '../lib/usePersistentState.ts';

export function TransactionsPage() {
  const tx = useTransactions();

  const [category, setCategory] = usePersistentState<TxCategory>(
    'transactions.category',
    'all',
    oneOf(
      TX_CATEGORIES.map((c) => c.key),
      'all',
    ),
  );
  const [sort, setSort] = usePersistentState<TxSortKey>(
    'transactions.sort',
    'recent',
    oneOf(
      TX_SORTS.map((s) => s.key),
      'recent',
    ),
  );
  const [query, setQuery] = useState('');

  const rows = tx.data?.transactions ?? [];
  const summary = tx.data?.summary;

  const visible = useMemo(
    () => sortTransactions(filterTransactions(rows, { category, query }), sort),
    [rows, category, query, sort],
  );

  if (tx.isLoading) return <Spinner label="Loading transactions…" />;
  if (tx.error)
    return (
      <ErrorNote>
        {tx.error instanceof ApiError ? tx.error.message : 'Failed to load transactions.'}
      </ErrorNote>
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">Transactions</h1>
          <p className="text-sm text-muted">Every cash movement on your account.</p>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-edge bg-panel p-4 sm:grid-cols-4">
          <Stat label="Entered platform" value={fmt(summary.funded)} tone="buy" />
          <Stat label="Claimed from platform" value={fmt(summary.claimed)} tone="accent" />
          <Stat label="Trade volume" value={fmt(summary.tradeBuy + summary.tradeSell)} />
          <Stat
            label="Net wallet flow"
            value={fmtSigned(summary.net)}
            tone={summary.net >= 0 ? 'buy' : 'sell'}
            sub={`${summary.count} record${summary.count === 1 ? '' : 's'}`}
          />
        </div>
      )}

      {rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-panel px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-1">
            {TX_CATEGORIES.map((c) => (
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
              placeholder="Search market…"
              className="w-40 rounded-lg border border-edge bg-panel-2 px-2.5 py-1 text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as TxSortKey)}
              className="rounded-lg border border-edge bg-panel-2 px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
            >
              {TX_SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-edge p-10 text-center text-muted">
          No transactions yet. <Link to="/">Browse markets →</Link>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-edge p-8 text-center text-sm text-muted">
          No transactions match this filter.
        </div>
      ) : (
        <Panel className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs tnum">
              <thead className="border-b border-edge text-muted">
                <tr className="text-left">
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-2 py-2 font-medium">Detail</th>
                  <th className="px-2 py-2 text-right font-medium">Amount</th>
                  <th className="px-2 py-2 text-right font-medium">Balance</th>
                  <th className="px-4 py-2 text-right font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((t) => (
                  <Row key={t.txId} t={t} />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

function Row({ t }: { t: Transaction }) {
  const positive = t.amount >= 0;
  return (
    <tr className="border-t border-edge/60 transition-colors hover:bg-panel-2/40">
      <td className="px-4 py-2">
        <KindBadge kind={t.kind} />
      </td>
      <td className="px-2 py-2 text-muted">{detail(t)}</td>
      <td className={`px-2 py-2 text-right font-semibold ${positive ? 'text-buy' : 'text-sell'}`}>
        {fmtSigned(t.amount)}
      </td>
      <td className="px-2 py-2 text-right text-muted">
        {t.balanceAfter == null ? '∞' : fmt(t.balanceAfter)}
      </td>
      <td
        className="px-4 py-2 text-right text-muted"
        title={new Date(t.createdAt).toLocaleString()}
      >
        {timeAgo(t.createdAt)}
      </td>
    </tr>
  );
}

function detail(t: Transaction): ReactNode {
  if (t.kind === 'admin_credit') return <span>from {t.counterparty ?? 'admin'}</span>;
  if (t.kind === 'admin_grant') return <span>to {t.counterparty ?? 'user'}</span>;
  if (t.marketId && t.marketTitle)
    return (
      <Link to={`/markets/${t.marketId}`} className="text-fg hover:text-accent">
        {t.marketTitle}
      </Link>
    );
  return <span>—</span>;
}

const CATEGORY_TONE: Record<string, string> = {
  trades: 'border-accent/40 bg-accent-soft text-accent',
  liquidity: 'border-edge bg-panel-2 text-fg',
  settlement: 'border-buy/40 bg-buy/10 text-buy',
  funding: 'border-warn/40 bg-warn-soft text-warn',
};

function KindBadge({ kind }: { kind: string }) {
  const tone = CATEGORY_TONE[txCategory(kind)] ?? 'border-edge bg-panel-2 text-muted';
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone}`}
    >
      {txLabel(kind)}
    </span>
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
