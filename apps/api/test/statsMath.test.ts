// unit tests — pure stats helpers (no DB). Peak/drawdown over a synthetic
// series, PnL aggregation, and the 80% calibration interval.

import { describe, expect, test } from 'bun:test';
import { aggregatePnl, ci80, inCi80, seriesStats } from '../src/services/statsMath.ts';

describe('seriesStats (peak / trough / max drawdown)', () => {
  test('empty series is all zero', () => {
    expect(seriesStats([])).toEqual({ count: 0, peak: 0, trough: 0, last: 0, maxDrawdown: 0 });
  });

  test('monotone-up series has no drawdown', () => {
    const s = seriesStats([0, 1, 2, 3, 4]);
    expect(s.peak).toBe(4);
    expect(s.trough).toBe(0);
    expect(s.last).toBe(4);
    expect(s.maxDrawdown).toBe(0);
  });

  test('drawdown is the worst peak-to-trough drop, not peak-to-last', () => {
    // rises to 10, falls to 2 (dd 8), recovers to 7, falls to 5 (dd from 10 = 5).
    const s = seriesStats([0, 10, 2, 7, 5]);
    expect(s.peak).toBe(10);
    expect(s.trough).toBe(0);
    expect(s.last).toBe(5);
    expect(s.maxDrawdown).toBe(8); // 10 → 2
  });

  test('peak profit is the running max even if it ends negative', () => {
    const s = seriesStats([3, 5, -2, -10]);
    expect(s.peak).toBe(5);
    expect(s.maxDrawdown).toBe(15); // 5 → -10
    expect(s.last).toBe(-10);
  });
});

describe('aggregatePnl', () => {
  test('sums realized and unrealized into a total', () => {
    const agg = aggregatePnl([
      { realized: 100, unrealized: -30 },
      { realized: -20, unrealized: 50 },
    ]);
    expect(agg.realized).toBe(80);
    expect(agg.unrealized).toBe(20);
    expect(agg.total).toBe(100);
  });

  test('empty is zero', () => {
    expect(aggregatePnl([])).toEqual({ realized: 0, unrealized: 0, total: 0 });
  });
});

describe('ci80 / calibration', () => {
  test('80% interval is μ ± 1.2816·σ', () => {
    const { lo, hi } = ci80(100, 10);
    expect(lo).toBeCloseTo(100 - 12.815515655, 6);
    expect(hi).toBeCloseTo(100 + 12.815515655, 6);
  });

  test('θ inside the band is calibrated, outside is not', () => {
    expect(inCi80(100, 10, 105)).toBe(true);
    expect(inCi80(100, 10, 90)).toBe(true); // 90 > 87.18 lower bound
    expect(inCi80(100, 10, 80)).toBe(false); // below 87.18
    expect(inCi80(100, 10, 120)).toBe(false); // above 112.82
  });
});
