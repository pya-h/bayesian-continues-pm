import { describe, expect, test } from 'bun:test';
import { bayesUpdate, bayesUpdateStudentT } from '../src/bayes.ts';
import { makeEngineConfig } from '../src/config.ts';
import { GaussianBelief } from '../src/gaussian.ts';
import { extractSignal } from '../src/signal.ts';
import { StudentTBelief } from '../src/student_t.ts';
import type { EngineConfig } from '../src/types.ts';

const approx = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

describe('bayesUpdate — precision-weighted (MODEL.md §5.3)', () => {
  // row is internally under-specified (its μ_new and σ_new imply different
  // σ_ε). We pin a self-consistent σ_ε = √2·1000 ≈ 1414.21 that reproduces the
  // spec's σ_new ≈ 1857, and assert the formula-exact μ_new.
  const cfg = makeEngineConfig(65000, 5000, { sigmaEps: Math.SQRT2 * 1000, sigmaMin: 1 });
  const prior = new GaussianBelief(65000, 5000 ** 2);

  test('matches the conjugate formula exactly', () => {
    const post = bayesUpdate(prior, 72500, 0.5, cfg);
    // precision_prior = 4e-8, precision_signal = 0.5/2e6 = 2.5e-7
    // μ_new = (4e-8·65000 + 2.5e-7·72500)/2.9e-7 = 71465.517...
    // σ_new² = 1/2.9e-7 = 3.448e6 → σ_new = 1857.0
    expect(approx(post.mu, 71465.51724, 1e-3)).toBe(true);
    expect(approx(post.stddev(), 1857.0, 0.5)).toBe(true);
  });

  test('precision adds (posterior precision = prior + signal)', () => {
    const post = bayesUpdate(prior, 72500, 0.5, cfg);
    const expectedPrecision = 1 / prior.sigma2 + 0.5 / (cfg.sigmaEps * cfg.sigmaEps);
    expect(approx(1 / post.sigma2, expectedPrecision, 1e-12)).toBe(true);
  });

  test('μ moves toward signal; variance strictly decreases', () => {
    const post = bayesUpdate(prior, 72500, 0.5, cfg);
    expect(post.mu > prior.mu).toBe(true);
    expect(post.mu < 72500).toBe(true);
    expect(post.sigma2 < prior.sigma2).toBe(true);
  });

  test('zero weight → unchanged mean', () => {
    const post = bayesUpdate(prior, 99999, 0, cfg);
    expect(post.mu).toBe(prior.mu);
  });

  test('variance floored at σ_min²', () => {
    const cfgFloor: EngineConfig = makeEngineConfig(65000, 5000, {
      sigmaEps: 1,
      sigmaMin: 2000,
    });
    const post = bayesUpdate(prior, 70000, 1, cfgFloor);
    expect(post.sigma2 >= 2000 ** 2 - 1e-6).toBe(true);
  });

  test('more weight pulls μ closer to the signal (monotone)', () => {
    const low = bayesUpdate(prior, 72500, 0.2, cfg);
    const high = bayesUpdate(prior, 72500, 0.9, cfg);
    expect(high.mu > low.mu).toBe(true);
  });
});

describe('bayesUpdateStudentT — location-scale t, ν fixed (MODEL.md §2.3.3)', () => {
  const cfg = makeEngineConfig(65000, 5000, { sigmaEps: Math.SQRT2 * 1000, sigmaMin: 1 });
  const nu = 6;
  const prior = StudentTBelief.fromVariance(nu, 65000, 5000 ** 2);

  test('ν is preserved; only location/scale move', () => {
    const post = bayesUpdateStudentT(prior, 72500, 0.5, cfg);
    expect(post.nu).toBe(nu);
  });

  test('updates the variance exactly like the Gaussian conjugate step', () => {
    // Same variance-domain precision arithmetic as bayesUpdate, so μ and the
    // resulting variance match a Gaussian prior of equal variance.
    const gPrior = new GaussianBelief(65000, 5000 ** 2);
    const g = bayesUpdate(gPrior, 72500, 0.5, cfg);
    const t = bayesUpdateStudentT(prior, 72500, 0.5, cfg);
    expect(approx(t.mu, g.mu, 1e-6)).toBe(true);
    expect(approx(t.variance(), g.variance(), 1e-3)).toBe(true);
  });

  test('μ moves toward the signal; variance strictly decreases', () => {
    const post = bayesUpdateStudentT(prior, 72500, 0.5, cfg);
    expect(post.mu > prior.mu).toBe(true);
    expect(post.mu < 72500).toBe(true);
    expect(post.variance() < prior.variance()).toBe(true);
  });

  test('zero weight → unchanged location and ν', () => {
    const post = bayesUpdateStudentT(prior, 99999, 0, cfg);
    expect(post.mu).toBe(prior.mu);
    expect(post.nu).toBe(nu);
  });

  test('variance floored at σ_min²', () => {
    const cfgFloor = makeEngineConfig(65000, 5000, { sigmaEps: 1, sigmaMin: 2000 });
    const post = bayesUpdateStudentT(prior, 70000, 1, cfgFloor);
    expect(post.variance() >= 2000 ** 2 - 1e-3).toBe(true);
  });
});

describe('extractSignal (MODEL.md §5.2)', () => {
  const cfg = makeEngineConfig(100, 10);
  const belief = new GaussianBelief(100, 10 ** 2);

  test('buying a CALL signals above the strike; selling below', () => {
    const buy = extractSignal({ type: 'CALL', strike: 105 }, 50, belief, cfg);
    const sell = extractSignal({ type: 'CALL', strike: 105 }, -50, belief, cfg);
    expect(buy.signal > 105).toBe(true);
    expect(sell.signal < 105).toBe(true);
    expect(buy.weight > 0).toBe(true);
  });

  test('buying a PUT signals below the strike; selling a PUT signals above', () => {
    // Buying a PUT is bearish (below strike); SELLING a PUT is the opposite —
    // a bullish view that price stays above the strike. The sign must flip with
    // the side, mirroring CALL. (Regression guard: an easy mistake is to leave
    // the sell signal below the strike, learning μ in the wrong direction.)
    const buy = extractSignal({ type: 'PUT', strike: 95 }, 50, belief, cfg);
    const sell = extractSignal({ type: 'PUT', strike: 95 }, -50, belief, cfg);
    expect(buy.signal < 95).toBe(true);
    expect(sell.signal > 95).toBe(true);
  });

  test('BINARY_PUT sell signals above the strike (bullish), like PUT', () => {
    const sell = extractSignal({ type: 'BINARY_PUT', strike: 95 }, -50, belief, cfg);
    expect(sell.signal > 95).toBe(true);
  });

  test('selling a GAUSSIAN(center) pushes the signal away from the center', () => {
    // center 120 sits above μ=100, so a sell pushes μ further down, away from it.
    const sell = extractSignal({ type: 'GAUSSIAN', center: 120, width: 5 }, -50, belief, cfg);
    expect(sell.signal < 100).toBe(true);
  });

  test('selling a SPREAD pushes the signal away from the midpoint', () => {
    // midpoint 120 is above μ=100 → sell pushes the signal below μ.
    const sell = extractSignal({ type: 'SPREAD', lower: 110, upper: 130 }, -50, belief, cfg);
    expect(sell.signal < 100).toBe(true);
  });

  test('a big PUT buy lowers μ; a big PUT sell raises it', () => {
    const buy = extractSignal({ type: 'PUT', strike: 95 }, 300, belief, cfg);
    const sell = extractSignal({ type: 'PUT', strike: 95 }, -300, belief, cfg);
    expect(bayesUpdate(belief, buy.signal, buy.weight, cfg).mu).toBeLessThan(belief.mu);
    expect(bayesUpdate(belief, sell.signal, sell.weight, cfg).mu).toBeGreaterThan(belief.mu);
  });

  test('buying LINEAR signals above μ; selling below', () => {
    const buy = extractSignal({ type: 'LINEAR' }, 50, belief, cfg);
    const sell = extractSignal({ type: 'LINEAR' }, -50, belief, cfg);
    expect(buy.signal > 100).toBe(true);
    expect(sell.signal < 100).toBe(true);
  });

  test('buying a GAUSSIAN(center) pulls toward the center', () => {
    const buy = extractSignal({ type: 'GAUSSIAN', center: 120, width: 5 }, 50, belief, cfg);
    expect(buy.signal).toBe(120);
  });

  test('buying a SPREAD pulls toward the midpoint', () => {
    const buy = extractSignal({ type: 'SPREAD', lower: 110, upper: 130 }, 50, belief, cfg);
    expect(buy.signal).toBe(120);
  });

  test('weight grows with size and is ~0 for tiny trades', () => {
    const tiny = extractSignal({ type: 'CALL', strike: 105 }, 0.01, belief, cfg);
    const big = extractSignal({ type: 'CALL', strike: 105 }, 400, belief, cfg);
    expect(tiny.weight < 1e-3).toBe(true);
    expect(big.weight > tiny.weight).toBe(true);
  });

  test('end-to-end: a big CALL buy raises μ', () => {
    const sig = extractSignal({ type: 'CALL', strike: 105 }, 300, belief, cfg);
    const post = bayesUpdate(belief, sig.signal, sig.weight, cfg);
    expect(post.mu > belief.mu).toBe(true);
  });
});

describe('extractSignal intensity clamp (REVIEW-FINDINGS C6)', () => {
  test('weight never exceeds 1, even for fills past qMax', () => {
    const cfg = makeEngineConfig(100, 10);
    const belief = new GaussianBelief(100, 100);
    for (const q of [cfg.qMax, cfg.qMax * 3, 50_000]) {
      const sig = extractSignal({ type: 'LINEAR' }, q, belief, cfg);
      expect(sig.weight <= 1).toBe(true);
      // simplified-update σ² shrink factor (1 − decay·weight) must stay positive
      expect(1 - cfg.decay * sig.weight > 0).toBe(true);
    }
  });
});
