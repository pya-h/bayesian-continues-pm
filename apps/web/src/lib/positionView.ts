// Shared client-side ordering / filtering for a flat list of positions. Kept
// framework-free so both the market-page positions card and the cross-market
// portfolio use the exact same sort keys and "closed" definition.

import type { PortfolioPosition } from './types.ts';

export type PositionSortKey = 'recent' | 'oldest' | 'pnl' | 'value' | 'size';

export const POSITION_SORTS: {
  key: PositionSortKey;
  label: string;
  cmp: (a: PortfolioPosition, b: PortfolioPosition) => number;
}[] = [
  {
    key: 'recent',
    label: 'Recently traded',
    cmp: (a, b) => b.lastTradedAt.localeCompare(a.lastTradedAt),
  },
  { key: 'oldest', label: 'Oldest first', cmp: (a, b) => a.openedAt.localeCompare(b.openedAt) },
  { key: 'pnl', label: 'Unrealized P&L', cmp: (a, b) => b.unrealizedPnl - a.unrealizedPnl },
  { key: 'value', label: 'Position value', cmp: (a, b) => b.positionValue - a.positionValue },
  { key: 'size', label: 'Size', cmp: (a, b) => Math.abs(b.quantity) - Math.abs(a.quantity) },
];

export function sortPositions(
  rows: PortfolioPosition[],
  key: PositionSortKey,
): PortfolioPosition[] {
  const cmp = POSITION_SORTS.find((s) => s.key === key)?.cmp;
  return cmp ? [...rows].sort(cmp) : rows;
}

// A position is "closed" once you no longer hold any of it — the size has been
// sold/settled down to zero, leaving only realized P&L. A still-held position
// counts as open even in a settled market (you may still have a payout to claim).
export function isClosedPosition(p: PortfolioPosition): boolean {
  return Math.abs(p.quantity) < 1e-9;
}
