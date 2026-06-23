import { describe, expect, test } from 'bun:test';
import {
  MONEY_DP,
  addMoney,
  formatMoney,
  mulMoney,
  round8,
  subMoney,
  sumMoney,
} from '../src/index.ts';

// Net-new money coverage beyond shared.test.ts: the scale constant, the rounding
// boundary either side of the half tie, negative-direction arithmetic, large /
// near-precision-ceiling magnitudes, accumulation correctness, and the
// non-finite guards on the derived helpers (add/sub/mul/sum/format).

describe('money — scale & rounding boundary', () => {
  test('MONEY_DP is 8 and round8 snaps to that grid', () => {
    expect(MONEY_DP).toBe(8);
    // 1e-8 is the smallest representable unit; 1e-9 is below it.
    expect(round8(1e-8)).toBe(1e-8);
    expect(round8(1e-9)).toBe(0);
  });

  test('round8 rounds up just above a tie and down just below', () => {
    // 0.123456786 → diff 0.6 (>0.5) → up to …79
    expect(round8(0.123456786)).toBe(0.12345679);
    // 0.123456784 → diff 0.4 (<0.5) → down to …78
    expect(round8(0.123456784)).toBe(0.12345678);
    // a clean (non-tie) value is returned untouched at 8dp
    expect(round8(0.12345678)).toBe(0.12345678);
  });

  test('round8 is idempotent (rounding an already-rounded value is a no-op)', () => {
    for (const x of [0.1, 0.30000001, -2.46913578, 12345.6789, 0]) {
      expect(round8(round8(x))).toBe(round8(x));
    }
  });

  test('round8 normalises negative-zero to 0', () => {
    expect(Object.is(round8(-1e-12), 0)).toBe(true); // not -0
  });
});

describe('money — arithmetic helpers', () => {
  test('addMoney/subMoney handle negatives and sign crossings', () => {
    expect(addMoney(-0.1, -0.2)).toBe(-0.3);
    expect(addMoney(0.3, -0.1)).toBe(0.2);
    expect(subMoney(0.1, 0.3)).toBe(-0.2);
    expect(subMoney(-0.3, -0.1)).toBe(-0.2);
    // exact-zero crossing keeps no float dust
    expect(subMoney(0.3, 0.3)).toBe(0);
  });

  test('mulMoney with a negative operand and a fractional product', () => {
    expect(mulMoney(-0.1, 0.2)).toBe(-0.02); // 0.020000000000000004 → -0.02
    expect(mulMoney(-2, -0.5)).toBe(1);
    expect(mulMoney(0, 1234.5678)).toBe(0);
  });

  test('large magnitudes within the documented ~9e7 ceiling stay exact', () => {
    // Well under |x|·1e8 > 2^53; integer-cents arithmetic must not drift.
    expect(addMoney(50_000_000, 25_000_000)).toBe(75_000_000);
    expect(subMoney(9_000_000.5, 0.25)).toBe(9_000_000.25);
    expect(mulMoney(1_000_000, 2)).toBe(2_000_000);
  });
});

describe('money — sumMoney accumulation', () => {
  test('single final rounding beats per-term drift', () => {
    expect(sumMoney([0.1, 0.2, 0.3, 0.4])).toBe(1);
    // 100 × 0.01 = 1 exactly through one final round
    expect(sumMoney(Array(100).fill(0.01))).toBe(1);
    // mixed signs net to a clean zero
    expect(sumMoney([1.23456789, -0.23456789, -1])).toBe(0);
  });

  test('order independence: sum of a list equals sum of its reverse', () => {
    const xs = [0.1, 0.2, 0.07, 123.456, -0.0009];
    expect(sumMoney(xs)).toBe(sumMoney([...xs].reverse()));
  });
});

describe('money — non-finite guards on derived helpers', () => {
  // round8 throws on non-finite; every helper routes through it, so each must
  // surface the same guard rather than silently producing NaN balances.
  test('addMoney throws on non-finite operands', () => {
    expect(() => addMoney(Number.NaN, 1)).toThrow(/non-finite/);
    expect(() => addMoney(1, Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });

  test('subMoney / mulMoney throw on non-finite operands', () => {
    expect(() => subMoney(Number.POSITIVE_INFINITY, 1)).toThrow(/non-finite/);
    expect(() => mulMoney(Number.NEGATIVE_INFINITY, 2)).toThrow(/non-finite/);
  });

  test('sumMoney throws when the running total is non-finite', () => {
    expect(() => sumMoney([1, Number.NaN, 2])).toThrow(/non-finite/);
    expect(() => sumMoney([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])).toThrow(
      /non-finite/,
    );
  });

  test('formatMoney renders a negative value and a thousands group', () => {
    expect(formatMoney(-1.2, 2)).toMatch(/^-1[.,]20$/);
    // 1234.5 → grouped integer part + 2dp; allow any locale grouping/decimal mark
    expect(formatMoney(1234.5, 2)).toMatch(/^1\D?234[.,]50$/);
  });
});
