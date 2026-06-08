import { describe, expect, test } from 'bun:test';
import { makeEngineConfig } from '../src/config.ts';
import { GaussianBelief } from '../src/gaussian.ts';
import { computeSpread } from '../src/spread.ts';
import { price } from '../src/pricing.ts';

const approx = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

describe('computeSpread (MODEL.md §4.3)', () => {
  const cfg = makeEngineConfig(65000, 5000, { s0: 0.01 });
  const belief = new GaussianBelief(65000, 5000 ** 2);
  const spec = { type: 'CALL', strike: 70000 } as const;

  test('base term = s₀ · |fair| (§17.1 spread row)', () => {
    const fair = price(spec, belief);
    const s = computeSpread(spec, 10, 0, belief, cfg);
    expect(approx(s.base, 0.01 * Math.abs(fair), 1e-9)).toBe(true);
    expect(approx(s.fair, fair, 1e-9)).toBe(true);
  });

  test('total ≥ base ≥ 0 and all components non-negative', () => {
    const s = computeSpread(spec, 10, 0, belief, cfg);
    expect(s.base >= 0).toBe(true);
    expect(s.inventory >= 0).toBe(true);
    expect(s.adverseSelection >= 0).toBe(true);
    expect(s.volatility >= 0).toBe(true);
    expect(s.total >= s.base).toBe(true);
    expect(approx(s.total, s.base + s.inventory + s.adverseSelection + s.volatility, 1e-9)).toBe(
      true,
    );
  });

  test('larger trades widen the spread (adverse selection)', () => {
    const small = computeSpread(spec, 5, 0, belief, cfg);
    const big = computeSpread(spec, 300, 0, belief, cfg);
    expect(big.total > small.total).toBe(true);
    expect(big.adverseSelection > small.adverseSelection).toBe(true);
  });

  test('accumulated inventory widens the spread', () => {
    const flat = computeSpread(spec, 10, 0, belief, cfg);
    const loaded = computeSpread(spec, 10, 500, belief, cfg);
    expect(loaded.inventory > flat.inventory).toBe(true);
    expect(loaded.total > flat.total).toBe(true);
  });

  test('higher uncertainty widens the spread (volatility term)', () => {
    const calm = computeSpread(spec, 10, 0, new GaussianBelief(65000, 2000 ** 2), cfg);
    const wild = computeSpread(spec, 10, 0, new GaussianBelief(65000, 9000 ** 2), cfg);
    expect(wild.volatility > calm.volatility).toBe(true);
  });

  test('spread is symmetric in trade sign for the size-driven terms', () => {
    const buy = computeSpread(spec, 100, 0, belief, cfg);
    const sell = computeSpread(spec, -100, 0, belief, cfg);
    // |q| and intensity use magnitude → adverse selection identical
    expect(approx(buy.adverseSelection, sell.adverseSelection, 1e-9)).toBe(true);
  });
});
