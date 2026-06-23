import { describe, expect, test } from 'bun:test';
import {
  POSITION_SORTS,
  type PositionSortKey,
  isClosedPosition,
  sortPositions,
} from '../src/lib/positionView.ts';
import type { PortfolioPosition } from '../src/lib/types.ts';

// A minimal PortfolioPosition factory — only the fields the sort keys / closed
// definition read matter; everything else is filler.
function pos(over: Partial<PortfolioPosition>): PortfolioPosition {
  return {
    marketId: 'm1',
    marketTitle: 'Market One',
    marketStatus: 'OPEN',
    contractId: 'c1',
    contractKey: 'CALL:60',
    spec: { type: 'CALL', strike: 60 },
    quantity: 10,
    avgEntryPrice: 5,
    costBasis: 50,
    fair: 6,
    bid: 5.5,
    positionValue: 55,
    unrealizedPnl: 5,
    realizedPnl: 0,
    peakProfit: 8,
    drawdownFromPeak: 3,
    openedAt: '2026-01-01T00:00:00.000Z',
    lastTradedAt: '2026-01-01T00:00:00.000Z',
    final: null,
    ...over,
  };
}

describe('POSITION_SORTS catalog', () => {
  test('exposes all five sort keys in order', () => {
    expect(POSITION_SORTS.map((s) => s.key)).toEqual(['recent', 'oldest', 'pnl', 'value', 'size']);
  });

  test('each entry carries a non-empty label and a comparator', () => {
    for (const s of POSITION_SORTS) {
      expect(typeof s.label).toBe('string');
      expect(s.label.length).toBeGreaterThan(0);
      expect(typeof s.cmp).toBe('function');
    }
  });
});

describe('sortPositions', () => {
  test("'recent' orders by lastTradedAt DESC (most recent first)", () => {
    const rows = [
      pos({ contractId: 'old', lastTradedAt: '2026-01-01T00:00:00.000Z' }),
      pos({ contractId: 'new', lastTradedAt: '2026-03-01T00:00:00.000Z' }),
      pos({ contractId: 'mid', lastTradedAt: '2026-02-01T00:00:00.000Z' }),
    ];
    // Independent expectation: descending ISO string order.
    expect(sortPositions(rows, 'recent').map((r) => r.contractId)).toEqual(['new', 'mid', 'old']);
  });

  test("'oldest' orders by openedAt ASC (oldest first)", () => {
    const rows = [
      pos({ contractId: 'b', openedAt: '2026-02-01T00:00:00.000Z' }),
      pos({ contractId: 'a', openedAt: '2026-01-01T00:00:00.000Z' }),
      pos({ contractId: 'c', openedAt: '2026-03-01T00:00:00.000Z' }),
    ];
    expect(sortPositions(rows, 'oldest').map((r) => r.contractId)).toEqual(['a', 'b', 'c']);
  });

  test("'pnl' orders by unrealizedPnl DESC, including negatives", () => {
    const rows = [
      pos({ contractId: 'loss', unrealizedPnl: -10 }),
      pos({ contractId: 'big', unrealizedPnl: 25 }),
      pos({ contractId: 'flat', unrealizedPnl: 0 }),
    ];
    expect(sortPositions(rows, 'pnl').map((r) => r.contractId)).toEqual(['big', 'flat', 'loss']);
  });

  test("'value' orders by positionValue DESC", () => {
    const rows = [
      pos({ contractId: 'small', positionValue: 5 }),
      pos({ contractId: 'large', positionValue: 500 }),
      pos({ contractId: 'mid', positionValue: 50 }),
    ];
    expect(sortPositions(rows, 'value').map((r) => r.contractId)).toEqual([
      'large',
      'mid',
      'small',
    ]);
  });

  test("'size' orders by ABSOLUTE quantity DESC (a short of 40 outranks a long of 30)", () => {
    const rows = [
      pos({ contractId: 'long30', quantity: 30 }),
      pos({ contractId: 'short40', quantity: -40 }),
      pos({ contractId: 'long10', quantity: 10 }),
    ];
    // |−40| = 40 > |30| > |10|.
    expect(sortPositions(rows, 'size').map((r) => r.contractId)).toEqual([
      'short40',
      'long30',
      'long10',
    ]);
  });

  test('does not mutate the input array (returns a new sorted array)', () => {
    const rows = [
      pos({ contractId: 'a', positionValue: 1 }),
      pos({ contractId: 'b', positionValue: 9 }),
      pos({ contractId: 'c', positionValue: 5 }),
    ];
    const before = rows.map((r) => r.contractId);
    const out = sortPositions(rows, 'value');
    expect(out).not.toBe(rows);
    expect(rows.map((r) => r.contractId)).toEqual(before);
    expect(out.map((r) => r.contractId)).toEqual(['b', 'c', 'a']);
  });

  test('unknown key returns the SAME array reference unchanged (no copy, no sort)', () => {
    const rows = [pos({ contractId: 'a' }), pos({ contractId: 'b' })];
    const out = sortPositions(rows, 'nope' as PositionSortKey);
    expect(out).toBe(rows);
    expect(out.map((r) => r.contractId)).toEqual(['a', 'b']);
  });

  test('empty input yields an empty array for a known key', () => {
    expect(sortPositions([], 'recent')).toEqual([]);
  });

  test('single-element input is returned as a one-element copy', () => {
    const rows = [pos({ contractId: 'only' })];
    const out = sortPositions(rows, 'pnl');
    expect(out).not.toBe(rows);
    expect(out.map((r) => r.contractId)).toEqual(['only']);
  });

  test('every catalog comparator can sort without throwing', () => {
    const rows = [pos({ contractId: 'a' }), pos({ contractId: 'b' })];
    for (const s of POSITION_SORTS) {
      expect(() => sortPositions(rows, s.key)).not.toThrow();
    }
  });
});

describe('isClosedPosition', () => {
  test('exactly-zero quantity is closed', () => {
    expect(isClosedPosition(pos({ quantity: 0 }))).toBe(true);
  });

  test('a held long or short is open', () => {
    expect(isClosedPosition(pos({ quantity: 10 }))).toBe(false);
    expect(isClosedPosition(pos({ quantity: -10 }))).toBe(false);
  });

  test('a still-held position in a SETTLED market is still open (payout may be claimable)', () => {
    expect(isClosedPosition(pos({ quantity: 5, marketStatus: 'SETTLED' }))).toBe(false);
  });

  test('quantity within the 1e-9 epsilon counts as closed (float dust)', () => {
    // |5e-10| < 1e-9 ⇒ closed; ±, just below the threshold.
    expect(isClosedPosition(pos({ quantity: 5e-10 }))).toBe(true);
    expect(isClosedPosition(pos({ quantity: -5e-10 }))).toBe(true);
  });

  test('quantity at or above the epsilon is open', () => {
    // 2e-9 ≥ 1e-9 ⇒ NOT closed (strict <).
    expect(isClosedPosition(pos({ quantity: 2e-9 }))).toBe(false);
    expect(isClosedPosition(pos({ quantity: -2e-9 }))).toBe(false);
  });
});
