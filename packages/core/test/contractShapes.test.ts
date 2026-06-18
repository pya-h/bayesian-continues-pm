// bounded shape-extension contracts (SKEW_GAUSSIAN, TENT, TRAPEZOID
// SIGMOID). All payoffs ∈ [0,1] (zero risk-model change). Verified three ways
// closed-form / quadrature price == general `expectF` == Monte-Carlo
// dPriceDMu == a central difference of `price`
// payoff shape, kinks, bounds, validation, key distinctness.
// The headline simplification: TENT and TRAPEZOID are exact CALL-ramp sums, so
// they price closed-form under EVERY belief kind — asserted across Gaussian
// mixture, Student-t and Gen·exact.

import { describe, expect, test } from 'bun:test';
import {
  contractKey,
  payoff,
  payoffBounds,
  payoffKinks,
  validateContract,
} from '../src/contracts.ts';
import { GaussianBelief } from '../src/gaussian.ts';
import { GenExactBelief } from '../src/gen_exact.ts';
import { MixtureBelief } from '../src/mixture.ts';
import { Rng } from '../src/numerics.ts';
import { dPriceDMu, expectF, price } from '../src/pricing.ts';
import { StudentTBelief } from '../src/student_t.ts';
import type { BeliefModel, ContractSpec } from '../src/types.ts';

const SPECS: ContractSpec[] = [
  { type: 'SKEW_GAUSSIAN', center: 72, widthLeft: 6, widthRight: 14 },
  { type: 'TENT', center: 68, width: 18 },
  { type: 'TRAPEZOID', lower: 64, upper: 78, width: 8 },
  { type: 'SIGMOID', center: 70, width: 4 },
];

const gaussian = new GaussianBelief(70, 100); // μ=70, σ=10
const mixture = new MixtureBelief([
  { pi: 0.6, mu: 66, sigma2: 64 },
  { pi: 0.4, mu: 82, sigma2: 100 },
]);
const studentT = new StudentTBelief(6, 70, 64);
const genExact = new GenExactBelief(70, 9, [1, 0.3, 0]);

function mcPrice(spec: ContractSpec, b: BeliefModel, n = 1_000_000): number {
  const xs = b.sample(n, new Rng(424242));
  let sum = 0;
  for (const x of xs) sum += payoff(spec, x);
  return sum / n;
}

describe('G5.1 payoff shape sanity', () => {
  test('all four are bounded in [0,1] across a wide θ sweep', () => {
    for (const spec of SPECS) {
      const b = payoffBounds(spec);
      expect(b.bounded).toBe(true);
      expect(b.min).toBe(0);
      expect(b.max).toBe(1);
      for (let theta = -50; theta <= 200; theta += 0.5) {
        const f = payoff(spec, theta);
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
  });

  test('SKEW_GAUSSIAN peaks at the center and is asymmetric (wL≠wR)', () => {
    const s: ContractSpec = { type: 'SKEW_GAUSSIAN', center: 72, widthLeft: 6, widthRight: 14 };
    expect(payoff(s, 72)).toBeCloseTo(1, 12);
    // one σ down (left width 6) vs one σ up (right width 14) — same |Δ| of 6
    // the left falls to e^{-1/2}; the right (wider) stays higher.
    expect(payoff(s, 66)).toBeCloseTo(Math.exp(-0.5), 12);
    expect(payoff(s, 78)).toBeGreaterThan(payoff(s, 66));
  });

  test('TENT is a triangle: peak 1 at c, 0 at c±w, ½ halfway', () => {
    const s: ContractSpec = { type: 'TENT', center: 68, width: 18 };
    expect(payoff(s, 68)).toBe(1);
    expect(payoff(s, 50)).toBe(0);
    expect(payoff(s, 86)).toBe(0);
    expect(payoff(s, 59)).toBeCloseTo(0.5, 12);
    expect(payoff(s, 40)).toBe(0); // outside
  });

  test('TRAPEZOID is flat 1 on [a,b] with ramps of run w', () => {
    const s: ContractSpec = { type: 'TRAPEZOID', lower: 64, upper: 78, width: 8 };
    expect(payoff(s, 64)).toBe(1);
    expect(payoff(s, 70)).toBe(1);
    expect(payoff(s, 78)).toBe(1);
    expect(payoff(s, 60)).toBeCloseTo(0.5, 12); // 4 into the left ramp of run 8
    expect(payoff(s, 82)).toBeCloseTo(0.5, 12); // 4 into the right ramp
    expect(payoff(s, 56)).toBe(0);
    expect(payoff(s, 86)).toBe(0);
  });

  test('SIGMOID is a monotone soft step through ½ at c', () => {
    const s: ContractSpec = { type: 'SIGMOID', center: 70, width: 4 };
    expect(payoff(s, 70)).toBeCloseTo(0.5, 12);
    expect(payoff(s, 1000)).toBeCloseTo(1, 6);
    expect(payoff(s, -1000)).toBeCloseTo(0, 6);
    let prev = -1;
    for (let theta = 40; theta <= 100; theta += 1) {
      const f = payoff(s, theta);
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
  });
});

describe('G5.1 kinks, bounds, keys, validation', () => {
  test('payoffKinks lands the corners', () => {
    expect(payoffKinks({ type: 'TENT', center: 68, width: 18 })).toEqual([50, 68, 86]);
    expect(payoffKinks({ type: 'TRAPEZOID', lower: 64, upper: 78, width: 8 })).toEqual([
      56, 64, 78, 86,
    ]);
    expect(
      payoffKinks({ type: 'SKEW_GAUSSIAN', center: 72, widthLeft: 6, widthRight: 14 }),
    ).toEqual([72]);
    expect(payoffKinks({ type: 'SIGMOID', center: 70, width: 4 })).toEqual([70]);
  });

  test('contractKey is distinct per shape and per param', () => {
    const keys = SPECS.map(contractKey);
    expect(new Set(keys).size).toBe(SPECS.length);
    expect(
      contractKey({ type: 'SKEW_GAUSSIAN', center: 72, widthLeft: 6, widthRight: 14 }),
    ).not.toBe(contractKey({ type: 'SKEW_GAUSSIAN', center: 72, widthLeft: 14, widthRight: 6 }));
  });

  test('validateContract rejects malformed params', () => {
    expect(() =>
      validateContract({ type: 'SKEW_GAUSSIAN', center: 1, widthLeft: 0, widthRight: 2 }),
    ).toThrow();
    expect(() => validateContract({ type: 'TENT', center: 1, width: -3 })).toThrow();
    expect(() => validateContract({ type: 'TRAPEZOID', lower: 9, upper: 4, width: 1 })).toThrow();
    expect(() => validateContract({ type: 'TRAPEZOID', lower: 4, upper: 9, width: 0 })).toThrow();
    expect(() => validateContract({ type: 'SIGMOID', center: 1, width: 0 })).toThrow();
    // well-formed pass through unchanged
    for (const spec of SPECS) expect(validateContract(spec)).toBe(spec);
  });
});

describe('G5.1 pricing — price == expectF == MC', () => {
  const beliefs: { name: string; b: BeliefModel }[] = [
    { name: 'gaussian', b: gaussian },
    { name: 'mixture', b: mixture },
    { name: 'student_t', b: studentT },
    { name: 'gen_exact', b: genExact },
  ];
  for (const { name, b } of beliefs) {
    for (const spec of SPECS) {
      test(`${name} / ${spec.type}: price ≈ expectF ≈ MC`, () => {
        const p = price(spec, b);
        const ef = expectF((x) => payoff(spec, x), b);
        const mc = mcPrice(spec, b);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1 + 1e-9);
        expect(Math.abs(p - ef)).toBeLessThan(2e-3);
        expect(Math.abs(p - mc)).toBeLessThan(0.01);
      });
    }
  }

  test('SKEW_GAUSSIAN closed form (Gaussian) matches a fine quadrature to 1e-6', () => {
    const s: ContractSpec = { type: 'SKEW_GAUSSIAN', center: 72, widthLeft: 6, widthRight: 14 };
    const p = price(s, gaussian);
    const fine = expectF((x) => payoff(s, x), gaussian, { L: 14, nodes: 200_000 });
    expect(Math.abs(p - fine)).toBeLessThan(1e-6);
  });

  test('a far / narrow SKEW & SIGMOID are still priced correctly (windowed quadrature)', () => {
    const farSkew: ContractSpec = {
      type: 'SKEW_GAUSSIAN',
      center: 140,
      widthLeft: 0.4,
      widthRight: 0.4,
    };
    const farSig: ContractSpec = { type: 'SIGMOID', center: 130, width: 0.3 };
    for (const spec of [farSkew, farSig]) {
      const p = price(spec, gaussian);
      const mc = mcPrice(spec, gaussian, 4_000_000);
      expect(Math.abs(p - mc)).toBeLessThan(0.005);
    }
  });
});

describe('G5.1 sensitivity — dPriceDMu == ∂price/∂μ (finite difference)', () => {
  // Only the Gaussian-family beliefs translate cleanly in μ via a constructor.
  const shift = (b: BeliefModel, h: number): BeliefModel => {
    if (b.kind === 'gaussian') return new GaussianBelief(b.mean() + h, b.variance());
    const m = b as MixtureBelief;
    return new MixtureBelief(
      m.components.map((c) => ({ pi: c.pi, mu: c.mu + h, sigma2: c.sigma2 })),
    );
  };
  for (const { name, b } of [
    { name: 'gaussian', b: gaussian as BeliefModel },
    { name: 'mixture', b: mixture as BeliefModel },
  ]) {
    for (const spec of SPECS) {
      test(`${name} / ${spec.type}: analytic ∂P/∂μ ≈ central difference`, () => {
        const h = 1e-3;
        const fd = (price(spec, shift(b, h)) - price(spec, shift(b, -h))) / (2 * h);
        expect(Math.abs(dPriceDMu(spec, b) - fd)).toBeLessThan(1e-3);
      });
    }
  }
});

describe('G5.1 TENT/TRAPEZOID = exact CALL-ramp sums (any belief kind)', () => {
  const call = (b: BeliefModel, K: number) => price({ type: 'CALL', strike: K }, b);
  for (const { name, b } of [
    { name: 'gaussian', b: gaussian as BeliefModel },
    { name: 'mixture', b: mixture as BeliefModel },
    { name: 'student_t', b: studentT as BeliefModel },
    { name: 'gen_exact', b: genExact as BeliefModel },
  ]) {
    test(`${name}: tent == (R(c−w)−2R(c)+R(c+w))/w to 1e-9`, () => {
      const c = 68;
      const w = 18;
      const composed = (call(b, c - w) - 2 * call(b, c) + call(b, c + w)) / w;
      expect(price({ type: 'TENT', center: c, width: w }, b)).toBeCloseTo(composed, 9);
    });
    test(`${name}: trapezoid == (R(a−w)−R(a)−R(b)+R(b+w))/w to 1e-9`, () => {
      const a = 64;
      const bb = 78;
      const w = 8;
      const composed = (call(b, a - w) - call(b, a) - call(b, bb) + call(b, bb + w)) / w;
      expect(price({ type: 'TRAPEZOID', lower: a, upper: bb, width: w }, b)).toBeCloseTo(
        composed,
        9,
      );
    });
  }
});
