import { describe, expect, test } from 'bun:test';
import { payoff } from '../src/contracts.ts';
import { GaussianBelief } from '../src/gaussian.ts';
import { dPriceDMu, expectF, price } from '../src/pricing.ts';
import type { ContractSpec } from '../src/types.ts';

const approx = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

describe('closed-form prices (MODEL.md §4.2 / §17.1)', () => {
  // unit-test row: μ=65000, σ=5000, K=70000 → Call ≈ $415
  const belief = new GaussianBelief(65000, 5000 ** 2);

  test('LINEAR price = μ', () => {
    expect(price({ type: 'LINEAR' }, belief)).toBe(65000);
  });

  test('CALL K=70000 ≈ 416.6 (spec says ≈415)', () => {
    const p = price({ type: 'CALL', strike: 70000 }, belief);
    // 5000·φ(-1) − 5000·Φ(-1) = 5000·(0.241970724 − 0.158655254) = 416.5773529
    expect(approx(p, 416.5773529384, 1e-6)).toBe(true);
  });

  test('PUT K=70000 via parity', () => {
    const call = price({ type: 'CALL', strike: 70000 }, belief);
    const put = price({ type: 'PUT', strike: 70000 }, belief);
    // Put-call parity: Call − Put = μ − K
    expect(approx(call - put, 65000 - 70000, 1e-6)).toBe(true);
  });

  test('BINARY_CALL + BINARY_PUT = 1 at same strike', () => {
    const bc = price({ type: 'BINARY_CALL', strike: 63000 }, belief);
    const bp = price({ type: 'BINARY_PUT', strike: 63000 }, belief);
    expect(approx(bc + bp, 1, 1e-9)).toBe(true);
  });

  test('BINARY_CALL = Φ((μ-K)/σ)', () => {
    const bc = price({ type: 'BINARY_CALL', strike: 65000 }, belief);
    expect(approx(bc, 0.5, 1e-9)).toBe(true); // K=μ → Φ(0)=0.5
  });

  test('SPREAD equals difference of binary puts', () => {
    const spread = price({ type: 'SPREAD', lower: 60000, upper: 70000 }, belief);
    const cdfHi = price({ type: 'BINARY_PUT', strike: 70000 }, belief);
    const cdfLo = price({ type: 'BINARY_PUT', strike: 60000 }, belief);
    expect(approx(spread, cdfHi - cdfLo, 1e-9)).toBe(true);
  });

  test('GAUSSIAN payoff price in (0,1) and peaks near μ', () => {
    const atMean = price({ type: 'GAUSSIAN', center: 65000, width: 3000 }, belief);
    const offMean = price({ type: 'GAUSSIAN', center: 80000, width: 3000 }, belief);
    expect(atMean > offMean).toBe(true);
    expect(atMean > 0 && atMean < 1).toBe(true);
  });
});

describe('prices match numerical integration (continuous payoffs)', () => {
  // Discontinuous payoffs (binary/spread) are validated by identity tests above
  // a generic quadrature can't match a step function tightly, and their closed
  // forms are exact, so we only cross-check the continuous payoffs here.
  const belief = new GaussianBelief(100, 15 ** 2);
  const specs: ContractSpec[] = [
    { type: 'LINEAR' },
    { type: 'CALL', strike: 110 },
    { type: 'PUT', strike: 90 },
    { type: 'GAUSSIAN', center: 102, width: 8 },
  ];

  for (const spec of specs) {
    test(`${spec.type} closed-form ≈ ∫ f·p`, () => {
      const closed = price(spec, belief);
      const numeric = expectF((t) => payoff(spec, t), belief, { nodes: 8000 });
      expect(approx(closed, numeric, 1e-5 * (Math.abs(closed) + 1))).toBe(true);
    });
  }
});

describe('∂Price/∂μ matches finite differences', () => {
  const specs: ContractSpec[] = [
    { type: 'LINEAR' },
    { type: 'CALL', strike: 110 },
    { type: 'PUT', strike: 95 },
    { type: 'BINARY_CALL', strike: 105 },
    { type: 'BINARY_PUT', strike: 92 },
    { type: 'SPREAD', lower: 85, upper: 115 },
    { type: 'GAUSSIAN', center: 102, width: 8 },
  ];
  const mu = 100;
  const sigma2 = 12 ** 2;
  const h = 1e-3;

  for (const spec of specs) {
    test(`${spec.type}`, () => {
      const analytic = dPriceDMu(spec, new GaussianBelief(mu, sigma2));
      const fd =
        (price(spec, new GaussianBelief(mu + h, sigma2)) -
          price(spec, new GaussianBelief(mu - h, sigma2))) /
        (2 * h);
      expect(approx(analytic, fd, 1e-5)).toBe(true);
    });
  }
});

describe('price monotonic in μ for bullish contracts', () => {
  test('CALL & BINARY_CALL increase with μ', () => {
    const lo = new GaussianBelief(100, 10 ** 2);
    const hi = new GaussianBelief(105, 10 ** 2);
    expect(
      price({ type: 'CALL', strike: 100 }, hi) > price({ type: 'CALL', strike: 100 }, lo),
    ).toBe(true);
    expect(
      price({ type: 'BINARY_CALL', strike: 100 }, hi) >
        price({ type: 'BINARY_CALL', strike: 100 }, lo),
    ).toBe(true);
  });
});
