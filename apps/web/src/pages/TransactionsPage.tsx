// Transactions — the user's full platform activity ledger: trades, LP moves
// market creation, settlement claims, refunds, and admin funding. A stats header
// summarises lifetime flows; the list filters by category + free text and sorts
// with view choices persisted across reloads. Data is read-only from the API.

import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CountUp, ErrorNote, Panel, Spinner } from '../components/ui.tsx';
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
    <div className="flex flex-col gap-5">
      {/* hero header */}
      <div className="hero-glow surface gradient-border relative flex flex-col gap-1 overflow-hidden rounded-2xl border border-edge bg-panel p-5">
        <div className="relative flex items-baseline gap-2">
          <h1 className="text-gradient text-2xl font-semibold tracking-tight">Transactions</h1>
          {summary && (
            <span className="text-sm text-muted">
              {summary.count} record{summary.count === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <p className="relative text-sm text-muted">Every cash movement on your account.</p>
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryCard
            label="Entered platform"
            value={<CountUp value={summary.funded} format={(n) => fmt(n)} />}
            tone="buy"
            glyph="↓"
          />
          <SummaryCard
            label="Claimed out"
            value={<CountUp value={summary.claimed} format={(n) => fmt(n)} />}
            tone="accent"
            glyph="◎"
          />
          <SummaryCard
            label="Trade volume"
            value={<CountUp value={summary.tradeBuy + summary.tradeSell} format={(n) => fmt(n)} />}
            tone="fg"
            glyph="⇄"
          />
          <SummaryCard
            label="Net wallet flow"
            value={<CountUp value={summary.net} format={(n) => fmtSigned(n)} />}
            tone={summary.net >= 0 ? 'buy' : 'sell'}
            glyph={summary.net >= 0 ? '+' : '−'}
          />
        </div>
      )}

      {rows.length > 0 && (
        <div className="surface flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-panel px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-1">
            {TX_CATEGORIES.map((c) => (
              <Chip key={c.key} active={category === c.key} onClick={() => setCategory(c.key)}>
                {c.label}
              </Chip>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <span className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 text-muted">
                ⌕
              </span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search market…"
                className="input-glow w-40 rounded-lg border border-edge bg-panel-2 py-1 pr-2.5 pl-7 text-xs text-fg placeholder:text-muted outline-none transition-colors focus:border-accent"
              />
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as TxSortKey)}
              className="input-glow rounded-lg border border-edge bg-panel-2 px-2 py-1 text-xs text-fg outline-none transition-colors focus:border-accent"
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
          No transactions yet.{' '}
          <Link to="/" className="text-accent hover:underline">
            Browse markets →
          </Link>
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
                  <th className="px-4 py-2.5 font-medium">Type</th>
                  <th className="px-2 py-2.5 font-medium">Detail</th>
                  <th className="px-2 py-2.5 text-right font-medium">Amount</th>
                  <th className="px-2 py-2.5 text-right font-medium">Balance</th>
                  <th className="px-4 py-2.5 text-right font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((t, i) => (
                  <Row key={t.txId} t={t} index={i} />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

type CatMeta = { rail: string; chip: string };
const CAT_FALLBACK: CatMeta = { rail: 'bg-edge', chip: 'border-edge bg-panel-2 text-muted' };
const CAT_META: Record<string, CatMeta> = {
  trades: { rail: 'bg-accent', chip: 'border-accent/40 bg-accent-soft text-accent' },
  liquidity: { rail: 'bg-muted/60', chip: 'border-edge bg-panel-2 text-fg' },
  settlement: { rail: 'bg-buy', chip: 'border-buy/40 bg-buy/10 text-buy' },
  funding: { rail: 'bg-warn', chip: 'border-warn/40 bg-warn-soft text-warn' },
};

const KIND_GLYPH: Record<string, string> = {
  trade_buy: '↗',
  trade_sell: '↘',
  market_create: '✦',
  lp_deposit: '＋',
  lp_withdraw: '－',
  lp_claim: '◆',
  claim: '✓',
  refund: '↩',
  admin_credit: '↓',
  admin_grant: '↑',
};

function Row({ t, index }: { t: Transaction; index: number }) {
  const positive = t.amount >= 0;
  const meta = CAT_META[txCategory(t.kind)] ?? CAT_FALLBACK;
  return (
    <tr
      style={{ animationDelay: `${Math.min(index, 14) * 22}ms` }}
      className="animate-fade-up border-t border-edge/60 transition-colors hover:bg-accent-soft/40"
    >
      <td className="py-2 pr-2 pl-0">
        <div className="flex items-center">
          <span
            className={`mr-3 h-7 w-0.5 shrink-0 rounded-full ${meta.rail}`}
            aria-hidden="true"
          />
          <KindBadge kind={t.kind} />
        </div>
      </td>
      <td className="px-2 py-2 text-muted">{detail(t)}</td>
      <td className={`px-2 py-2 text-right font-semibold ${positive ? 'text-buy' : 'text-sell'}`}>
        {fmtSigned(t.amount)}
      </td>
      <td className="px-2 py-2 text-right text-muted">
        {t.balanceAfter == null ? '∞' : fmt(t.balanceAfter)}
      </td>
      <td
        className="whitespace-nowrap px-4 py-2 text-right text-muted"
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
      <Link to={`/markets/${t.marketId}`} className="text-fg transition-colors hover:text-accent">
        {t.marketTitle}
      </Link>
    );
  return <span>—</span>;
}

function KindBadge({ kind }: { kind: string }) {
  const meta = CAT_META[txCategory(kind)] ?? CAT_FALLBACK;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold shadow-soft ${meta.chip}`}
    >
      <span aria-hidden="true" className="text-[10px] leading-none opacity-80">
        {KIND_GLYPH[kind] ?? '•'}
      </span>
      {txLabel(kind)}
    </span>
  );
}

function SummaryCard({
  label,
  value,
  tone,
  glyph,
}: {
  label: string;
  value: ReactNode;
  tone: 'fg' | 'buy' | 'sell' | 'accent' | 'warn';
  glyph: string;
}) {
  const toneText = {
    fg: 'text-fg',
    buy: 'text-buy',
    sell: 'text-sell',
    accent: 'text-accent',
    warn: 'text-warn',
  }[tone];
  const chip = {
    fg: 'border-edge bg-panel-2 text-muted',
    buy: 'border-buy/40 bg-buy/10 text-buy',
    sell: 'border-sell/40 bg-sell/10 text-sell',
    accent: 'border-accent/40 bg-accent-soft text-accent',
    warn: 'border-warn/40 bg-warn-soft text-warn',
  }[tone];
  return (
    <div className="lift surface group flex flex-col gap-1.5 rounded-xl border border-edge bg-panel p-3.5 hover:border-accent/40">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">{label}</span>
        <span
          className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs ${chip}`}
          aria-hidden="true"
        >
          {glyph}
        </span>
      </div>
      <span className={`tnum text-xl font-semibold ${toneText}`}>{value}</span>
    </div>
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
          ? 'bg-grad-accent text-[var(--color-on-accent)] btn-glow-accent border-transparent'
          : 'border-edge bg-panel-2 text-muted hover:border-accent/40 hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}
