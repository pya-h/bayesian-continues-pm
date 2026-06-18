// conditionally-compatible unbounded contracts (POLYNOMIAL, EXPONENTIAL).
// Both are closed-form under a Gaussian belief — POLYNOMIAL via the raw Gaussian
// moments E[θᵏ], EXPONENTIAL via the Gaussian MGF E[e^{a(θ−c)}] = e^{a(μ−c)+½a²σ²}.
// Verified
// closed-form price == general `expectF` == Monte-Carlo
// mixture price = Σπₖ·priceₖ (linearity)
// dPriceDMu == a central difference of `price` (and the analytic identities)
// payoff/validation/bounds/key, and the EXPONENTIAL far-tail overflow clamp.

import { describe, expect, test } from 'bun:test';
import {
  contractKey,
  payoff,
  payoffBounds,
  payoffKinks,
  polynomialDegree,
  validateContract,
} from '../src/contracts.ts';
import { GaussianBelief } from '../src/gaussian.ts';
import { MixtureBelief } from '../src/mixture.ts';
import { Rng } from '../src/numerics.ts';
import { dPriceDMu, expectF, price } from '../src/pricing.ts';
import type { BeliefModel, ContractSpec } from '../src/types.ts';

const gaussian = new GaussianBelief(70, 100); // μ=70, σ=10
const mixture = new MixtureBelief([
  { pi: 0.6, mu: 66, sigma2: 64 },
  { pi: 0.4, mu: 82, sigma2: 100 },
]);

function mcPrice(spec: ContractSpec, b: BeliefModel, n = 2_000_000): number {
  const xs = b.sample(n, new Rng(424242));
  let sum = 0;
  for (const x of xs) sum += payoff(spec, x);
  return sum / n;
}

function relClose(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(1, Math.abs(a));
}

describe('POLYNOMIAL payoff & metadata', () => {
  test('Horner-evaluates Σ aₖθᵏ', () => {
    const s: ContractSpec = { type: 'POLYNOMIAL', coeffs: [1, -2, 3] }; // 1 − 2θ + 3θ²
    expect(payoff(s, 0)).toBe(1);
    expect(payoff(s, 2)).toBe(1 - 4 + 12);
    expect(payoff(s, -1)).toBe(1 + 2 + 3);
  });

  test('unbounded, smooth (no kinks), degree helpers', () => {
    const s: ContractSpec = { type: 'POLYNOMIAL', coeffs: [0, 0, 1] };
    expect(payoffBounds(s).bounded).toBe(false);
    expect(payoffKinks(s)).toEqual([]);
    expect(polynomialDegree([0, 0, 1])).toBe(2);
    expect(polynomialDegree([3, 1, 0])).toBe(1); // trailing zero ignored
    expect(contractKey(s)).toBe('POLYNOMIAL:a=0,0,1');
  });

  test('validation: degree cap, constant rejection, finite coeffs', () => {
    expect(() => validateContract({ type: 'POLYNOMIAL', coeffs: [0, 1] })).not.toThrow();
    expect(() => validateContract({ type: 'POLYNOMIAL', coeffs: [0, 0, 0, 0, 0, 1] })).toThrow(
      /degree/,
    );
    expect(() => validateContract({ type: 'POLYNOMIAL', coeffs: [5] })).toThrow(/non-constant/);
    expect(() => validateContract({ type: 'POLYNOMIAL', coeffs: [] })).toThrow();
  });
});

describe('EXPONENTIAL payoff & metadata', () => {
  test('exp(a(θ−c)), unbounded, smooth', () => {
    const s: ContractSpec = { type: 'EXPONENTIAL', center: 100, rate: 0.05 };
    expect(payoff(s, 100)).toBe(1);
    expect(payoff(s, 120)).toBeCloseTo(Math.exp(1), 12);
    expect(payoffBounds(s).bounded).toBe(false);
    expect(payoffKinks(s)).toEqual([]);
    expect(contractKey(s)).toBe('EXPONENTIAL:c=100:a=0.05');
  });

  test('validation: rate must be non-zero, center required', () => {
    expect(() => validateContract({ type: 'EXPONENTIAL', center: 0, rate: 0 })).toThrow(/non-zero/);
    expect(() => validateContract({ type: 'EXPONENTIAL', rate: 0.1 })).toThrow(/center/);
  });

  test('far-tail exponent is clamped (no overflow to Infinity)', () => {
    const s: ContractSpec = { type: 'EXPONENTIAL', center: 0, rate: 1 };
    expect(Number.isFinite(payoff(s, 1e6))).toBe(true); // would be exp(1e6) unclamped
    expect(Number.isFinite(payoff(s, -1e6))).toBe(true);
  });
});

describe('POLYNOMIAL closed-form price == expectF == MC', () => {
  const specs: ContractSpec[] = [
    { type: 'POLYNOMIAL', coeffs: [0, 0, 1] }, // θ²
    { type: 'POLYNOMIAL', coeffs: [3, -0.4, 0, 0.002] }, // cubic
  ];

  test('θ² on a Gaussian matches μ²+σ² exactly', () => {
    const p = price({ type: 'POLYNOMIAL', coeffs: [0, 0, 1] }, gaussian);
    expect(p).toBeCloseTo(70 * 70 + 100, 8); // 5000
  });

  test('gaussian: price == expectF == MC', () => {
    for (const s of specs) {
      const closed = price(s, gaussian);
      expect(closed).toBeCloseTo(
        expectF((x) => payoff(s, x), gaussian, { L: 12 }),
        4,
      );
      expect(relClose(closed, mcPrice(s, gaussian))).toBeLessThan(0.005); // MC noise
    }
  });

  test('mixture: closed-form = Σπₖ·priceₖ == MC', () => {
    for (const s of specs) {
      const closed = price(s, mixture);
      let manual = 0;
      for (const c of mixture.components) {
        manual += c.pi * price(s, new GaussianBelief(c.mu, c.sigma2));
      }
      expect(closed).toBeCloseTo(manual, 8);
      expect(relClose(closed, mcPrice(s, mixture))).toBeLessThan(0.005);
    }
  });
});

describe('EXPONENTIAL closed-form price (MGF) == expectF == MC', () => {
  const specs: ContractSpec[] = [
    { type: 'EXPONENTIAL', center: 70, rate: 0.05 },
    { type: 'EXPONENTIAL', center: 70, rate: -0.08 },
  ];

  test('MGF closed form on a Gaussian', () => {
    const s: ContractSpec = { type: 'EXPONENTIAL', center: 70, rate: 0.05 };
    // E[e^{a(θ−c)}] = e^{a(μ−c)+½a²σ²}, μ=c=70 ⇒ e^{½·0.0025·100} = e^{0.125}
    expect(price(s, gaussian)).toBeCloseTo(Math.exp(0.125), 10);
  });

  test('gaussian & mixture: price == expectF == MC', () => {
    for (const s of specs) {
      for (const b of [gaussian, mixture]) {
        const closed = price(s, b);
        expect(closed).toBeCloseTo(
          expectF((x) => payoff(s, x), b, { L: 12 }),
          4,
        );
        expect(relClose(closed, mcPrice(s, b))).toBeLessThan(0.005);
      }
    }
  });
});

describe('dPriceDMu (translation identity ∂E[f]/∂μ = E[f′])', () => {
  const specs: ContractSpec[] = [
    { type: 'POLYNOMIAL', coeffs: [0, 0, 1] }, // f′ = 2θ ⇒ ∂P/∂μ = 2μ
    { type: 'POLYNOMIAL', coeffs: [3, -0.4, 0, 0.002] },
    { type: 'EXPONENTIAL', center: 70, rate: 0.05 }, // ∂P/∂μ = a·P
  ];

  test('θ² sensitivity equals 2μ', () => {
    expect(dPriceDMu({ type: 'POLYNOMIAL', coeffs: [0, 0, 1] }, gaussian)).toBeCloseTo(140, 6);
  });

  test('matches a central difference of price on gaussian & mixture', () => {
    for (const s of specs) {
      for (const b of [gaussian, mixture]) {
        const analytic = dPriceDMu(s, b);
        const h = 1e-3;
        const up =
          b.kind === 'gaussian'
            ? price(s, new GaussianBelief(b.mean() + h, b.variance()))
            : price(
                s,
                new MixtureBelief(
                  (b as MixtureBelief).components.map((c) => ({ ...c, mu: c.mu + h })),
                ),
              );
        const dn =
          b.kind === 'gaussian'
            ? price(s, new GaussianBelief(b.mean() - h, b.variance()))
            : price(
                s,
                new MixtureBelief(
                  (b as MixtureBelief).components.map((c) => ({ ...c, mu: c.mu - h })),
                ),
              );
        expect(analytic).toBeCloseTo((up - dn) / (2 * h), 3);
      }
    }
  });

  test('EXPONENTIAL ∂P/∂μ = a·price', () => {
    const s: ContractSpec = { type: 'EXPONENTIAL', center: 70, rate: 0.05 };
    expect(dPriceDMu(s, gaussian)).toBeCloseTo(0.05 * price(s, gaussian), 10);
  });
});
