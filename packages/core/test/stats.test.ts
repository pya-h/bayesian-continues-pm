import { describe, expect, test } from 'bun:test';
import { GaussianBelief } from '../src/gaussian.ts';
import { MixtureBelief } from '../src/mixture.ts';
import { price } from '../src/pricing.ts';
import { positionStats, secondMoment } from '../src/stats.ts';
import { StudentTBelief } from '../src/student_t.ts';
import type { ContractSpec } from '../src/types.ts';

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

  test('VaR/CVaR ordering: cvar95 ≤ var95 ≤ expectedPnl', () => {
    const spec = { type: 'CALL', strike: 65000 } as const;
    const s = positionStats({ spec, quantity: 10, costBasis: 10 * 2000 }, belief);
    // the worst-5% mean ≤ the 5th-percentile loss ≤ the mean PnL — the full chain
    // the test name promises (previously only the first link was asserted)
    expect(s.cvar95).toBeLessThanOrEqual(s.var95);
    expect(s.var95).toBeLessThanOrEqual(s.expectedPnl);
  });
});

describe('secondMoment — non-Gaussian closed forms (REVIEW-FINDINGS C5/C14)', () => {
  test('mixture binary/spread second moment equals the (exact) price: f² = f', () => {
    const m = new MixtureBelief([
      { pi: 0.5, mu: 90, sigma2: 25 },
      { pi: 0.5, mu: 110, sigma2: 25 },
    ]);
    for (const spec of [
      { type: 'BINARY_CALL', strike: 100 } as ContractSpec,
      { type: 'BINARY_PUT', strike: 110 } as ContractSpec,
      { type: 'SPREAD', lower: 95, upper: 105 } as ContractSpec,
    ]) {
      expect(secondMoment(spec, m)).toBe(price(spec, m));
    }
  });

  test('far low-weight mixture mode is not dropped (was 0 vs exact ≈12.505)', () => {
    const m = new MixtureBelief([
      { pi: 0.995, mu: 0, sigma2: 1 },
      { pi: 0.005, mu: 60, sigma2: 1 },
    ]);
    const m2 = secondMoment({ type: 'CALL', strike: 10 }, m);
    // exact: 0.005·E[(X−10)²·1{X>10}] under N(60,1) ≈ 0.005·(2500+1) = 12.505
    expect(approx(m2, 12.505, 0.01)).toBe(true);
  });

  test('LINEAR second moment is mean²+var for mixtures and t', () => {
    const m = new MixtureBelief([
      { pi: 0.7, mu: 95, sigma2: 9 },
      { pi: 0.3, mu: 115, sigma2: 16 },
    ]);
    expect(approx(secondMoment({ type: 'LINEAR' }, m), m.mean() ** 2 + m.variance(), 1e-9)).toBe(
      true,
    );
    const t = StudentTBelief.fromVariance(4, 50, 100);
    expect(approx(secondMoment({ type: 'LINEAR' }, t), 50 ** 2 + 100, 1e-9)).toBe(true);
  });

  test('student-t CALL/PUT second moment matches a tail-aware reference at low ν', () => {
    // ±10σ quadrature truncates the polynomial tail (~1% at ν=2.5); the
    // truncated-moment closed form does not. Reference values computed with a
    // log-space far-tail integration to 1e13.
    const t = StudentTBelief.fromVariance(2.5, 100, 400);
    expect(approx(secondMoment({ type: 'CALL', strike: 112 }, t), 121.5795, 0.01)).toBe(true);
    expect(approx(secondMoment({ type: 'CALL', strike: 90 }, t), 370.3597, 0.01)).toBe(true);
    // PUT mirror: E[(K−X)+²] = Var + (μ−K)² − E[(X−K)+²]
    const callSq = secondMoment({ type: 'CALL', strike: 112 }, t);
    const putSq = secondMoment({ type: 'PUT', strike: 112 }, t);
    expect(approx(callSq + putSq, t.variance() + (100 - 112) ** 2, 1e-6)).toBe(true);
  });
});
