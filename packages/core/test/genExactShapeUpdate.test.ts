// I4 — Gen·exact v2 moment-projection update (shape-adapting). Verifies the
// assumed-density filter against an INDEPENDENT importance-sampled Monte-Carlo of
// the true posterior `prior(θ)·N(θ; s, σ_ε²/w)` (principle 2: every new update is
// MC-checked). Covers: posterior mean/variance match, no spurious skew on a
// symmetric update, correct skew direction when the posterior is asymmetric
// stability under a confident stream, and the v1 fallback paths.

import { describe, expect, test } from 'bun:test';
import { bayesUpdateGenExact, bayesUpdateGenExactShape, updateBelief } from '../src/bayes.ts';
import { makeEngineConfig } from '../src/config.ts';
import { GenExactBelief, genExactShapeStats } from '../src/gen_exact.ts';
import { Rng } from '../src/numerics.ts';

const cfg = makeEngineConfig(50, 10, {}); // σ_ε = 10, σ_min = 1, shape-adapt on

function mcPosterior(prior: GenExactBelief, s: number, weight: number) {
  const sigmaL2 = (cfg.sigmaEps * cfg.sigmaEps) / weight;
  const xs = prior.sample(400_000, new Rng(13_579));
  let sw = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  for (const x of xs) {
    const d = x - s;
    const w = Math.exp(-(d * d) / (2 * sigmaL2));
    sw += w;
    s1 += w * x;
    s2 += w * x * x;
    s3 += w * x * x * x;
  }
  const mean = s1 / sw;
  const e2 = s2 / sw;
  const e3 = s3 / sw;
  const variance = e2 - mean * mean;
  const mu3 = e3 - 3 * mean * e2 + 2 * mean ** 3;
  return { mean, variance, skew: mu3 / variance ** 1.5 };
}

describe('genExactShapeStats — standardised shape diagnostics', () => {
  test('Gaussian preset [1,0,0] is symmetric and mildly platykurtic (λ₆ thins tails)', () => {
    const s = genExactShapeStats([1, 0, 0]);
    expect(Math.abs(s.eu)).toBeLessThan(1e-6);
    expect(Math.abs(s.skew)).toBeLessThan(1e-6);
    // the u⁶ stabiliser confines the tails ⇒ modestly negative excess kurtosis.
    expect(s.exKurt).toBeLessThan(0);
    expect(s.exKurt).toBeGreaterThan(-0.5);
  });

  test('λ₃ > 0 ⇒ negative skew (mass favours u < 0)', () => {
    expect(genExactShapeStats([1, 0.3, 0]).skew).toBeLessThan(-0.05);
    expect(genExactShapeStats([1, -0.3, 0]).skew).toBeGreaterThan(0.05);
  });

  test('λ₄ > 0 ⇒ thinner tails / flat-top (negative excess kurtosis)', () => {
    expect(genExactShapeStats([1, 0, 1.0]).exKurt).toBeLessThan(
      genExactShapeStats([1, 0, 0]).exKurt,
    );
  });
});

describe('bayesUpdateGenExactShape — moment-projection vs MC posterior', () => {
  test('symmetric prior + on-centre signal: no spurious skew, variance shrinks toward MC', () => {
    const prior = new GenExactBelief(50, 10, [1, 0, 0]);
    const after = bayesUpdateGenExactShape(prior, 50, 0.8, cfg);
    const mc = mcPosterior(prior, 50, 0.8);

    expect(after.kind).toBe('gen_exact');
    expect(after.mean()).toBeCloseTo(mc.mean, 0); // ≈ 50
    expect(after.mean()).toBeCloseTo(50, 0);
    // shape stays symmetric — no skew conjured from a symmetric update
    expect(Math.abs(after.lambdas[1])).toBeLessThan(0.03);
    // variance matches the true posterior and is below the prior
    expect(after.variance()).toBeLessThan(prior.variance());
    expect(Math.abs(after.variance() - mc.variance) / mc.variance).toBeLessThan(0.05);
  });

  test('symmetric prior + off-centre signal stays symmetric (Gaussian×Gaussian)', () => {
    const prior = new GenExactBelief(50, 10, [1, 0, 0]);
    const after = bayesUpdateGenExactShape(prior, 70, 0.8, cfg);
    const mc = mcPosterior(prior, 70, 0.8);
    expect(after.mean()).toBeGreaterThan(50);
    expect(after.mean()).toBeLessThan(70);
    expect(after.mean()).toBeCloseTo(mc.mean, 0);
    expect(Math.abs(after.lambdas[1])).toBeLessThan(0.03); // still ~symmetric
  });

  test('bimodal prior + side signal: posterior is asymmetric and the fit skews the right way', () => {
    const prior = new GenExactBelief(50, 10, [-1, 0, 0]); // symmetric bimodal
    const after = bayesUpdateGenExactShape(prior, 64, 1, cfg);
    const mc = mcPosterior(prior, 64, 1);

    // The MC posterior genuinely picks up skew (reweighting one camp).
    expect(Math.abs(mc.skew)).toBeGreaterThan(0.05);
    const fittedSkew = genExactShapeStats(after.lambdas).skew;
    // The projected shape skews in the SAME direction as the true posterior.
    expect(Math.sign(fittedSkew)).toBe(Math.sign(mc.skew));
    // Mean & variance still track the true posterior.
    expect(after.mean()).toBeCloseTo(mc.mean, 0);
    expect(Math.abs(after.variance() - mc.variance) / mc.variance).toBeLessThan(0.08);
    // λ₂ (the creator's bimodal choice) is preserved.
    expect(after.lambdas[0]).toBe(-1);
  });

  test('a confident stream homes μ to the signal, shrinks variance to the floor, keeps λ bounded', () => {
    const tight = makeEngineConfig(50, 10, { sigmaMin: 2, sigmaEps: 4 });
    let b = new GenExactBelief(50, 10, [1, 0, 0]);
    let prevVar = b.variance();
    for (let i = 0; i < 30; i++) {
      b = bayesUpdateGenExactShape(b, 80, 1, tight);
      expect(b.variance()).toBeLessThanOrEqual(prevVar + 1e-6);
      expect(Number.isFinite(b.mean())).toBe(true);
      expect(b.lambdas[1]).toBeGreaterThanOrEqual(-0.35);
      expect(b.lambdas[1]).toBeLessThanOrEqual(0.35);
      expect(b.lambdas[2]).toBeGreaterThanOrEqual(0);
      expect(b.lambdas[2]).toBeLessThanOrEqual(1.6);
      prevVar = b.variance();
    }
    expect(Math.abs(b.mean() - 80)).toBeLessThan(5);
    expect(b.variance()).toBeGreaterThanOrEqual(2 * 2 - 1e-6); // σ_min floor
  });

  test('zero weight and the simplified path leave the shape fixed (delegate to v1)', () => {
    const prior = new GenExactBelief(50, 10, [1, 0.2, 0.1]);
    const zero = bayesUpdateGenExactShape(prior, 90, 0, cfg);
    expect(zero.lambdas).toEqual([1, 0.2, 0.1]);
    expect(zero.mu).toBe(50);

    const simp = makeEngineConfig(50, 10, { useSimplifiedUpdate: true, lr: 0.3, decay: 0.1 });
    const s = bayesUpdateGenExactShape(prior, 90, 1, simp);
    expect(s.lambdas).toEqual([1, 0.2, 0.1]); // shape unchanged on the heuristic path
    expect(s.mu).toBeGreaterThan(50);
  });

  test('the dispatcher honours genExactShapeAdapt (v2 on by default, v1 when off)', () => {
    const prior = new GenExactBelief(50, 10, [-1, 0, 0]);
    const v2 = updateBelief(prior, 64, 1, cfg);
    const v1 = updateBelief(prior, 64, 1, makeEngineConfig(50, 10, { genExactShapeAdapt: false }));
    // v1 keeps the exact authored shape; v2 adapts it.
    expect((v1 as GenExactBelief).lambdas).toEqual([-1, 0, 0]);
    expect((v1 as GenExactBelief).lambdas).toEqual(bayesUpdateGenExact(prior, 64, 1, cfg).lambdas);
    // v2 moved the shape (skew) away from the symmetric authored one.
    expect(Math.abs((v2 as GenExactBelief).lambdas[1])).toBeGreaterThan(0.01);
  });
});
