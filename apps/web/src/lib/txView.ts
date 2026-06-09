// Pure view helpers for the Transactions tab — labels, category grouping, and
// filter/sort over a user's ledger. Kept IO-free so they're unit-tested and the
// page stays declarative. The lifetime `summary` comes from the API; these only
// shape the on-screen list.

import type { Transaction } from './types.ts';

export type TxSortKey = 'recent' | 'oldest' | 'amount' | 'amountAsc';

export const TX_SORTS: {
  key: TxSortKey;
  label: string;
  cmp: (a: Transaction, b: Transaction) => number;
}[] = [
  { key: 'recent', label: 'Newest first', cmp: (a, b) => b.createdAt.localeCompare(a.createdAt) },
  { key: 'oldest', label: 'Oldest first', cmp: (a, b) => a.createdAt.localeCompare(b.createdAt) },
  {
    key: 'amount',
    label: 'Largest amount',
    cmp: (a, b) => Math.abs(b.amount) - Math.abs(a.amount),
  },
  {
    key: 'amountAsc',
    label: 'Smallest amount',
    cmp: (a, b) => Math.abs(a.amount) - Math.abs(b.amount),
  },
];

export type TxCategory = 'all' | 'trades' | 'liquidity' | 'settlement' | 'funding';

export const TX_CATEGORIES: { key: TxCategory; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'trades', label: 'Trades' },
  { key: 'liquidity', label: 'Liquidity' },
  { key: 'settlement', label: 'Settlement' },
  { key: 'funding', label: 'Funding' },
];

const CATEGORY_OF: Record<string, Exclude<TxCategory, 'all'>> = {
  trade_buy: 'trades',
  trade_sell: 'trades',
  market_create: 'liquidity',
  lp_deposit: 'liquidity',
  lp_withdraw: 'liquidity',
  lp_claim: 'liquidity',
  claim: 'settlement',
  refund: 'settlement',
  admin_credit: 'funding',
  admin_grant: 'funding',
};

export function txCategory(kind: string): TxCategory {
  return CATEGORY_OF[kind] ?? 'all';
}

const KIND_LABEL: Record<string, string> = {
  trade_buy: 'Buy',
  trade_sell: 'Sell',
  market_create: 'Market created',
  lp_deposit: 'LP deposit',
  lp_withdraw: 'LP withdraw',
  lp_claim: 'LP claim',
  claim: 'Claim',
  refund: 'Refund',
  admin_credit: 'Funded',
  admin_grant: 'Grant',
};

export function txLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

export function filterTransactions(
  rows: Transaction[],
  opts: { category?: TxCategory; query?: string },
): Transaction[] {
  const category = opts.category ?? 'all';
  const q = (opts.query ?? '').trim().toLowerCase();
  return rows.filter((r) => {
    if (category !== 'all' && txCategory(r.kind) !== category) return false;
    if (!q) return true;
    return (
      (r.marketTitle ?? '').toLowerCase().includes(q) ||
      (r.counterparty ?? '').toLowerCase().includes(q) ||
      txLabel(r.kind).toLowerCase().includes(q)
    );
  });
}

export function sortTransactions(rows: Transaction[], key: TxSortKey): Transaction[] {
  const cmp = TX_SORTS.find((s) => s.key === key)?.cmp;
  return cmp ? [...rows].sort(cmp) : rows;
}
