// Unit tests for GaussianBelief (gaussian.ts) — the v1 base belief N(μ, σ²) and the
// shape every other model is measured against. Covers the constructor guards (unhappy
// inputs), fromDTO/serialize round-trips, the pdf/cdf/quantile closed forms against
// known standard-normal values, and seeded-sampler determinism + convergence.
// Reference: N(100, 12²) ⇒ μ=100, σ=12. φ(0)=1/√(2π)=0.3989423, Φ(1)=0.8413447
// Φ⁻¹(0.9)=1.2815516 ⇒ quantile(0.9)=100+12·1.2815516=115.378619.

import { describe, expect, test } from 'bun:test';
import { GaussianBelief } from '../src/gaussian.ts';
import { Rng } from '../src/numerics.ts';

describe('GaussianBelief — construction & guards', () => {
  test('valid construction exposes μ, σ², σ and the variance', () => {
    const b = new GaussianBelief(100, 144);
    expect(b.kind).toBe('gaussian');
    expect(b.mean()).toBe(100);
    expect(b.variance()).toBe(144);
    expect(b.stddev()).toBe(12);
  });

  test('rejects non-positive or non-finite variance', () => {
    expect(() => new GaussianBelief(0, 0)).toThrow(/sigma2/);
    expect(() => new GaussianBelief(0, -1)).toThrow(/sigma2/);
    expect(() => new GaussianBelief(0, Number.NaN)).toThrow(/sigma2/);
    expect(() => new GaussianBelief(0, Number.POSITIVE_INFINITY)).toThrow(/sigma2/);
  });

  test('rejects non-finite mean', () => {
    expect(() => new GaussianBelief(Number.NaN, 1)).toThrow(/mu/);
    expect(() => new GaussianBelief(Number.POSITIVE_INFINITY, 1)).toThrow(/mu/);
  });
});

describe('GaussianBelief — DTO round-trip', () => {
  test('fromDTO reconstructs an equal belief and serialize is its inverse', () => {
    const dto = { kind: 'gaussian', mu: 42.5, sigma2: 9 } as const;
    const b = GaussianBelief.fromDTO(dto);
    expect(b.mean()).toBe(42.5);
    expect(b.variance()).toBe(9);
    expect(b.serialize()).toEqual(dto);
    // round-trips bit-for-bit
    expect(GaussianBelief.fromDTO(b.serialize()).serialize()).toEqual(dto);
  });
});

describe('GaussianBelief — pdf / cdf / quantile closed forms', () => {
  const b = new GaussianBelief(100, 144); // σ=12

  test('pdf peaks at μ with value φ(0)/σ and is symmetric', () => {
    expect(b.pdf(100)).toBeCloseTo(1 / (12 * Math.sqrt(2 * Math.PI)), 9); // φ(0)/σ
    expect(b.pdf(100 - 7)).toBeCloseTo(b.pdf(100 + 7), 12); // symmetry
    expect(b.pdf(1e9)).toBeCloseTo(0, 12); // far tail → 0
  });

  test('cdf matches Φ at the mean and at ±1σ', () => {
    expect(b.cdf(100)).toBeCloseTo(0.5, 12);
    expect(b.cdf(112)).toBeCloseTo(0.8413447, 6); // Φ(1)
    expect(b.cdf(88)).toBeCloseTo(0.1586553, 6); // Φ(−1)
    expect(b.cdf(100 - 50) + b.cdf(100 + 50)).toBeCloseTo(1, 9); // F(−z)+F(z)=1
  });

  test('quantile is the inverse cdf; the 80% CI is μ ± 1.2816σ', () => {
    expect(b.quantile(0.5)).toBeCloseTo(100, 9);
    expect(b.quantile(0.9)).toBeCloseTo(115.378619, 4);
    expect(b.cdf(b.quantile(0.37))).toBeCloseTo(0.37, 9); // round-trip
    expect(b.quantile(0.9) - b.quantile(0.1)).toBeCloseTo(2 * 12 * 1.2815516, 4);
  });
});

describe('GaussianBelief — seeded sampler', () => {
  test('same seed ⇒ identical draws (reproducible Monte-Carlo)', () => {
    const b = new GaussianBelief(0, 1);
    const a = b.sample(1000, new Rng(123));
    const c = b.sample(1000, new Rng(123));
    expect(a).toEqual(c);
    // a different seed gives a different stream
    expect(b.sample(1000, new Rng(124))[0]).not.toBe(a[0]);
  });

  test('large sample mean/variance converge to μ and σ²', () => {
    const b = new GaussianBelief(100, 144);
    const xs = b.sample(50_000, new Rng(7));
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
    expect(mean).toBeCloseTo(100, 0); // within ~1 of μ
    expect(Math.sqrt(variance)).toBeCloseTo(12, 0); // within ~1 of σ
  });
});
