import { describe, expect, test } from 'bun:test';
import { contractKey } from '../src/contracts.ts';
import { GaussianBelief } from '../src/gaussian.ts';
import {
  type BookEntry,
  expectedLiability,
  liability,
  maxExecutable,
  requiredReserve,
} from '../src/solvency.ts';

const approx = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

describe('liability & expected liability', () => {
  const belief = new GaussianBelief(100, 15 ** 2);

  test('liability sums mmShort · payoff', () => {
    const book: BookEntry[] = [
      { spec: { type: 'CALL', strike: 100 }, mmShort: 10 },
      { spec: { type: 'BINARY_CALL', strike: 110 }, mmShort: 5 },
    ];
    // at θ=120: call pays 20 (×10=200), binary pays 1 (×5=5) → 205
    expect(liability(book, 120)).toBe(205);
    // at θ=90: both 0
    expect(liability(book, 90)).toBe(0);
  });

  test('expected liability = Σ mmShort · fair price', () => {
    const book: BookEntry[] = [{ spec: { type: 'BINARY_CALL', strike: 100 }, mmShort: 100 }];
    // binary call at K=μ → price 0.5 → E[L] = 50
    expect(approx(expectedLiability(book, belief), 50, 1e-6)).toBe(true);
  });
});

describe('requiredReserve (MC VaR)', () => {
  const belief = new GaussianBelief(65000, 5000 ** 2);

  test('empty book → 0', () => {
    expect(requiredReserve([], belief)).toBe(0);
  });

  test('reserve ≥ expected liability for a one-sided short book', () => {
    const book: BookEntry[] = [{ spec: { type: 'CALL', strike: 65000 }, mmShort: 100 }];
    const reserve = requiredReserve(book, belief);
    const eL = expectedLiability(book, belief);
    expect(reserve > eL).toBe(true); // 99th pct of a right-skewed loss > its mean
  });

  test('deterministic given seed', () => {
    const book: BookEntry[] = [{ spec: { type: 'CALL', strike: 65000 }, mmShort: 100 }];
    expect(requiredReserve(book, belief)).toBe(requiredReserve(book, belief));
  });

  test('binary-call reserve ≈ mmShort at high α (almost surely ITM region capped at 1)', () => {
    // deep ITM binary: K well below μ → payoff ~1 a.s. → L ≈ mmShort
    const book: BookEntry[] = [{ spec: { type: 'BINARY_CALL', strike: 40000 }, mmShort: 200 }];
    const reserve = requiredReserve(book, belief);
    expect(approx(reserve, 200, 1)).toBe(true);
  });

  test('larger short position → larger reserve (monotone)', () => {
    const small: BookEntry[] = [{ spec: { type: 'CALL', strike: 65000 }, mmShort: 50 }];
    const big: BookEntry[] = [{ spec: { type: 'CALL', strike: 65000 }, mmShort: 200 }];
    expect(requiredReserve(big, belief) > requiredReserve(small, belief)).toBe(true);
  });

  test('higher α → larger (or equal) reserve', () => {
    const book: BookEntry[] = [{ spec: { type: 'CALL', strike: 65000 }, mmShort: 100 }];
    const r95 = requiredReserve(book, belief, { alpha: 0.95 });
    const r999 = requiredReserve(book, belief, { alpha: 0.999 });
    expect(r999 >= r95).toBe(true);
  });
});

describe('maxExecutable (partial fill)', () => {
  const belief = new GaussianBelief(65000, 5000 ** 2);
  const spec = { type: 'CALL', strike: 65000 } as const;
  const key = contractKey(spec);

  test('full fill when cash is ample', () => {
    const got = maxExecutable([], spec, key, contractKey, 0, 100, belief, 1e12);
    expect(got).toBe(100);
  });

  test('partial fill when cash limited', () => {
    const full = requiredReserve([{ spec, mmShort: 100 }], belief);
    const got = maxExecutable([], spec, key, contractKey, 0, 100, belief, full * 0.4);
    expect(got > 0 && got < 100).toBe(true);
    // reserve at the returned size should be within the cash limit
    expect(requiredReserve([{ spec, mmShort: got }], belief) <= full * 0.4 + 1e-6).toBe(true);
  });

  test('zero when even the smallest size breaches (cash 0, reserve>0 required)', () => {
    const got = maxExecutable([], spec, key, contractKey, 0, 100, belief, 0);
    expect(approx(got, 0, 1e-6)).toBe(true);
  });
});
