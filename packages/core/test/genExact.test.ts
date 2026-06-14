// GenExactBelief (max-entropy exp(−poly)) math, verified against
// independent quadrature + Monte-Carlo (the gate that prevents silent math
// errors before any api/web wiring). Mirrors the checks the sandbox `maxEnt`
// passed.

import { describe, expect, test } from 'bun:test';
import { GEN_EXACT_L, GenExactBelief } from '../src/gen_exact.ts';
import { Rng } from '../src/numerics.ts';

function bruteMoments(b: GenExactBelief, n = 60000) {
  const lo = b.mu - GEN_EXACT_L * b.sigma;
  const hi = b.mu + GEN_EXACT_L * b.sigma;
  const h = (hi - lo) / n;
  let mass = 0;
  let m1 = 0;
  let m2 = 0;
  for (let i = 0; i <= n; i++) {
    const x = lo + i * h;
    const w = i === 0 || i === n ? 0.5 : 1;
    const p = b.pdf(x);
    mass += w * p;
    m1 += w * x * p;
    m2 += w * x * x * p;
  }
  mass *= h;
  m1 *= h;
  m2 *= h;
  const mean = m1 / mass;
  return { mass, mean, variance: m2 / mass - mean * mean };
}

function modeCount(b: GenExactBelief, n = 4000): number {
  const lo = b.mu - GEN_EXACT_L * b.sigma;
  const hi = b.mu + GEN_EXACT_L * b.sigma;
  const h = (hi - lo) / n;
  let modes = 0;
  for (let i = 2; i < n - 1; i++) {
    const x = lo + i * h;
    const p = b.pdf(x);
    if (p > b.pdf(x - h) && p >= b.pdf(x + h) && p > 1e-4) modes++;
  }
  return modes;
}

// A representative sweep of shapes, including bimodal (λ₂<0) and skew (λ₃≠0).
const SHAPES: { name: string; mu: number; sigma: number; lam: [number, number, number] }[] = [
  { name: 'gaussian-like', mu: 70, sigma: 10, lam: [1, 0, 0] },
  { name: 'skew+', mu: 70, sigma: 10, lam: [1, 0.3, 0] },
  { name: 'skew−', mu: 70, sigma: 10, lam: [1, -0.3, 0] },
  { name: 'flat-top', mu: 0, sigma: 1, lam: [1, 0, 0.5] },
  { name: 'bimodal', mu: 50, sigma: 8, lam: [-1, 0, 0] },
  { name: 'skewed-bimodal', mu: 50, sigma: 8, lam: [-0.8, 0.2, 0.05] },
];

describe('GenExactBelief — normalisation & moments', () => {
  for (const s of SHAPES) {
    test(`${s.name}: pdf integrates to 1 and cached moments match quadrature`, () => {
      const b = new GenExactBelief(s.mu, s.sigma, s.lam);
      const g = bruteMoments(b);
      expect(Math.abs(g.mass - 1)).toBeLessThan(1e-3); // ∫p = 1
      // cached mean/variance vs an independent fine-grid recompute
      expect(Math.abs(g.mean - b.mean())).toBeLessThan(1e-2);
      expect(Math.abs(g.variance - b.variance()) / b.variance()).toBeLessThan(2e-3);
      expect(b.variance()).toBeGreaterThan(0);
    });
  }
});

describe('GenExactBelief — CDF / quantile', () => {
  for (const s of SHAPES) {
    test(`${s.name}: cdf monotone in [0,1] and cdf(quantile(p)) ≈ p`, () => {
      const b = new GenExactBelief(s.mu, s.sigma, s.lam);
      // monotone & bounded
      let prev = -1;
      for (let i = 0; i <= 40; i++) {
        const x = b.mu + (GEN_EXACT_L * b.sigma * (i - 20)) / 20;
        const c = b.cdf(x);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
        expect(c).toBeGreaterThanOrEqual(prev - 1e-12); // non-decreasing
        prev = c;
      }
      // round-trip
      for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
        expect(Math.abs(b.cdf(b.quantile(p)) - p)).toBeLessThan(2e-3);
      }
    });
  }
});

describe('GenExactBelief — shape sanity', () => {
  test('λ₂=1, λ₃=λ₄=0 is ≈ Gaussian (symmetric, unimodal, mean=μ)', () => {
    const b = new GenExactBelief(70, 10, [1, 0, 0]);
    expect(Math.abs(b.mean() - 70)).toBeLessThan(1e-6); // symmetric → mean at μ
    expect(modeCount(b)).toBe(1);
    // symmetric about μ
    for (const d of [5, 12, 20]) {
      expect(Math.abs(b.pdf(70 + d) - b.pdf(70 - d))).toBeLessThan(1e-9);
    }
    // close to a true normal of the same stddev (the u⁶ stabiliser perturbs slightly)
    const sd = b.stddev();
    const normPdf = (x: number) =>
      Math.exp(-0.5 * ((x - 70) / sd) ** 2) / (sd * Math.sqrt(2 * Math.PI));
    for (const x of [60, 65, 70, 75, 80]) {
      expect(Math.abs(b.pdf(x) - normPdf(x)) / normPdf(70)).toBeLessThan(0.05);
    }
  });

  test('λ₂<0 ⇒ bimodal (two pdf maxima)', () => {
    const b = new GenExactBelief(50, 8, [-1, 0, 0]);
    expect(modeCount(b)).toBe(2);
  });

  test('λ₃>0 ⇒ skew shifts the mean off μ (toward the lower-energy side)', () => {
    const pos = new GenExactBelief(70, 10, [1, 0.4, 0]);
    const neg = new GenExactBelief(70, 10, [1, -0.4, 0]);
    expect(pos.mean()).toBeLessThan(70); // +λ₃ favours u<0 → mean below μ
    expect(neg.mean()).toBeGreaterThan(70); // mirror image
    // symmetric coefficients ⇒ mirror-image mean offsets
    expect(Math.abs(70 - pos.mean() - (neg.mean() - 70))).toBeLessThan(1e-6);
  });

  test('λ₄>0 ⇒ thinner tails / smaller variance than λ₄=0 at the same λ₂', () => {
    const base = new GenExactBelief(0, 1, [1, 0, 0]);
    const thin = new GenExactBelief(0, 1, [1, 0, 0.6]);
    expect(thin.variance()).toBeLessThan(base.variance());
  });
});

describe('GenExactBelief — sampling (inverse-CDF) matches cached moments', () => {
  for (const s of SHAPES) {
    test(`${s.name}: sample mean/variance ≈ analytic (n=400k, seeded)`, () => {
      const b = new GenExactBelief(s.mu, s.sigma, s.lam);
      const xs = b.sample(400_000, new Rng(12345));
      const mean = xs.reduce((a, x) => a + x, 0) / xs.length;
      const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length;
      expect(Math.abs(mean - b.mean())).toBeLessThan(0.03 * b.stddev());
      expect(Math.abs(variance - b.variance()) / b.variance()).toBeLessThan(0.03);
    });
  }
});

describe('GenExactBelief — serialization & guards', () => {
  test('round-trips through the DTO', () => {
    const b = new GenExactBelief(50, 8, [-0.8, 0.2, 0.05]);
    const r = GenExactBelief.fromDTO(b.serialize());
    expect(r.serialize()).toEqual(b.serialize());
    expect(r.mean()).toBeCloseTo(b.mean(), 9);
    expect(r.variance()).toBeCloseTo(b.variance(), 9);
  });

  test('rejects non-finite / non-positive parameters', () => {
    expect(() => new GenExactBelief(Number.NaN, 1, [1, 0, 0])).toThrow();
    expect(() => new GenExactBelief(0, 0, [1, 0, 0])).toThrow();
    expect(() => new GenExactBelief(0, -1, [1, 0, 0])).toThrow();
    expect(() => new GenExactBelief(0, 1, [Number.POSITIVE_INFINITY, 0, 0])).toThrow();
  });
});
