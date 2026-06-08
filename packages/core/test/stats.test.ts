import { describe, expect, test } from 'bun:test';
import { GaussianBelief } from '../src/gaussian.ts';
import { price } from '../src/pricing.ts';
import { positionStats, secondMoment } from '../src/stats.ts';

const approx = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

describe('secondMoment', () => {
  const belief = new GaussianBelief(100, 15 ** 2);

  test('LINEAR: E[θ²] = μ² + σ²', () => {
    expect(approx(secondMoment({ type: 'LINEAR' }, belief), 100 ** 2 + 15 ** 2, 1e-6)).toBe(true);
  });

  test('binary: E[f²] = E[f] = price', () => {
    const spec = { type: 'BINARY_CALL', strike: 105 } as const;
    expect(approx(secondMoment(spec, belief), price(spec, belief), 1e-9)).toBe(true);
  });

  test('variance ≥ 0 across contract types (m2 ≥ price²)', () => {
    for (const spec of [
      { type: 'CALL', strike: 105 },
      { type: 'PUT', strike: 95 },
      { type: 'GAUSSIAN', center: 100, width: 10 },
      { type: 'SPREAD', lower: 90, upper: 110 },
    ] as const) {
      const m2 = secondMoment(spec, belief);
      expect(m2 >= price(spec, belief) ** 2 - 1e-9).toBe(true);
    }
  });
});

describe('positionStats', () => {
  const belief = new GaussianBelief(65000, 5000 ** 2);

  test('expected payout = q · fair; expected PnL nets cost basis', () => {
    const spec = { type: 'LINEAR' } as const;
    const fair = price(spec, belief);
    const s = positionStats({ spec, quantity: 2, costBasis: 2 * fair }, belief);
    expect(approx(s.expectedPayout, 2 * fair, 1e-6)).toBe(true);
    expect(approx(s.expectedPnl, 0, 1e-6)).toBe(true);
  });

  test('bounded contract: max payout = q (binary) when long', () => {
    const spec = { type: 'BINARY_CALL', strike: 65000 } as const;
    const s = positionStats({ spec, quantity: 10, costBasis: 5 }, belief);
    expect(s.maxIsP99).toBe(false);
    expect(approx(s.maxPayout, 10, 1e-9)).toBe(true);
    expect(approx(s.minPayout, 0, 1e-9)).toBe(true);
  });

  test('unbounded contract: maxPayout flagged as p99', () => {
    const spec = { type: 'CALL', strike: 65000 } as const;
    const s = positionStats({ spec, quantity: 5, costBasis: 100 }, belief);
    expect(s.maxIsP99).toBe(true);
    expect(s.maxPayout > 0).toBe(true);
  });

  test('P(profit) sane: deep-ITM binary bought cheap ⇒ high P(profit)', () => {
    const spec = { type: 'BINARY_CALL', strike: 50000 } as const; // ~ a.s. ITM
    const s = positionStats({ spec, quantity: 1, costBasis: 0.5 }, belief);
    expect(s.pProfit > 0.9).toBe(true);
  });

  test('breakeven θ for CALL = K + premium/q', () => {
    const spec = { type: 'CALL', strike: 70000 } as const;
    const s = positionStats({ spec, quantity: 10, costBasis: 10 * 500 }, belief);
    expect(approx(s.breakevenTheta as number, 70000 + 500, 1e-6)).toBe(true);
  });

  test('VaR/CVaR ordering: cvar95 ≤ var95 ≤ expectedPnl region', () => {
    const spec = { type: 'CALL', strike: 65000 } as const;
    const s = positionStats({ spec, quantity: 10, costBasis: 10 * 2000 }, belief);
    expect(s.cvar95 <= s.var95).toBe(true);
  });
});
