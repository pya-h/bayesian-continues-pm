// Pure view helpers for the admin market-ledger drill-in — kind labels, category
// grouping, and filter/sort over a market's reconstructed cash-flow events. Kept
// IO-free so they're unit-tested and the panel stays declarative. Rollups come
// from the API; these only shape the on-screen event list.

import type { MarketLedgerEvent } from './types.ts';

export type MlSortKey = 'recent' | 'oldest' | 'amount' | 'amountAsc';

export const ML_SORTS: {
  key: MlSortKey;
  label: string;
  cmp: (a: MarketLedgerEvent, b: MarketLedgerEvent) => number;
}[] = [
  { key: 'recent', label: 'Newest first', cmp: (a, b) => b.at.localeCompare(a.at) },
  { key: 'oldest', label: 'Oldest first', cmp: (a, b) => a.at.localeCompare(b.at) },
  { key: 'amount', label: 'Largest amount', cmp: (a, b) => Math.abs(b.delta) - Math.abs(a.delta) },
  {
    key: 'amountAsc',
    label: 'Smallest amount',
    cmp: (a, b) => Math.abs(a.delta) - Math.abs(b.delta),
  },
];

export type MlCategory = 'all' | 'liquidity' | 'trades' | 'settlement';

export const ML_CATEGORIES: { key: MlCategory; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'liquidity', label: 'Liquidity' },
  { key: 'trades', label: 'Trades' },
  { key: 'settlement', label: 'Settlement' },
];

const CATEGORY_OF: Record<string, Exclude<MlCategory, 'all'>> = {
  genesis: 'liquidity',
  lp_deposit: 'liquidity',
  lp_withdraw: 'liquidity',
  trade_buy: 'trades',
  trade_sell: 'trades',
  lp_claim: 'settlement',
  trader_payout: 'settlement',
  refund: 'settlement',
};

export function mlCategory(kind: string): MlCategory {
  return CATEGORY_OF[kind] ?? 'all';
}

const KIND_LABEL: Record<string, string> = {
  genesis: 'Genesis reserve',
  lp_deposit: 'LP deposit',
  lp_withdraw: 'LP withdraw',
  lp_claim: 'LP claim',
  trade_buy: 'Trade buy',
  trade_sell: 'Trade sell',
  refund: 'Refund',
  trader_payout: 'Trader payout',
};

export function mlLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

export function filterMarketLedger(
  events: MarketLedgerEvent[],
  opts: { category?: MlCategory; query?: string },
): MarketLedgerEvent[] {
  const category = opts.category ?? 'all';
  const q = (opts.query ?? '').trim().toLowerCase();
  return events.filter((e) => {
    if (category !== 'all' && mlCategory(e.kind) !== category) return false;
    if (!q) return true;
    return (
      (e.username ?? '').toLowerCase().includes(q) || mlLabel(e.kind).toLowerCase().includes(q)
    );
  });
}

export function sortMarketLedger(events: MarketLedgerEvent[], key: MlSortKey): MarketLedgerEvent[] {
  const cmp = ML_SORTS.find((s) => s.key === key)?.cmp;
  return cmp ? [...events].sort(cmp) : events;
}
