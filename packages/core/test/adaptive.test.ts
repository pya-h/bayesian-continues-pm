// adaptive parameters (core math). Verifies the EWMA σ_ε estimator
// regime-scaled s₀, optional α/β damping, and that every adapted value stays on
// the rails. The controller is belief-kind agnostic (it consumes scalar
// signal errors), so a model-agnostic stream is asserted via the half-normal
// recovery of a known σ_ε from N(0,σ²) absolute draws.

import { describe, expect, test } from 'bun:test';
import {
  type AdaptiveConfig,
  DEFAULT_ADAPTIVE,
  adaptParams,
  initAdaptiveState,
  observeError,
} from '../src/adaptive.ts';
import { Rng } from '../src/numerics.ts';

const BASE = { sigmaEps: 100, s0: 0.01, alpha: 1.0, beta: 1.0 };
const SIGMA0 = 100;

function run(errs: number[], cfg: AdaptiveConfig = DEFAULT_ADAPTIVE) {
  let st = initAdaptiveState();
  for (const e of errs) st = observeError(st, e, cfg);
  return st;
}

describe('adaptive — warmup & inertness', () => {
  test('returns base config before warmup', () => {
    const st = run([50, 60]); // warmup default 3 → still cold
    const p = adaptParams(BASE, SIGMA0, st);
    expect(p.sigmaEps).toBe(BASE.sigmaEps);
    expect(p.s0).toBe(BASE.s0);
    expect(p.railHit).toBe(false);
    expect(p.regime).toBe(0);
  });

  test('disabled → inert even after many observations', () => {
    const cfg = { ...DEFAULT_ADAPTIVE, enabled: false };
    const st = run([200, 200, 200, 200, 200], cfg);
    const p = adaptParams(BASE, SIGMA0, st, cfg);
    expect(p.sigmaEps).toBe(BASE.sigmaEps);
    expect(p.s0).toBe(BASE.s0);
    expect(p.railHit).toBe(false);
  });

  test('observeError ignores non-finite / negative errors', () => {
    let st = initAdaptiveState();
    st = observeError(st, Number.NaN);
    st = observeError(st, -5);
    expect(st.count).toBe(0);
    st = observeError(st, 40);
    expect(st.count).toBe(1);
    expect(st.emaSlow).toBe(40);
    expect(st.emaFast).toBe(40);
  });
});

describe('adaptive — σ_ε estimation', () => {
  // The half-normal mean: for ε ~ N(0,σ²), E|ε| = σ·√(2/π) ≈ 0.79788·σ.
  const MEAN_ABS = Math.sqrt(2 / Math.PI);

  test('half-normal debias recovers σ_ε exactly from a mean-|ε| stream', () => {
    // Deterministic: feed the theoretical mean|ε| so the EWMA settles on it (no RNG
    // variance), then the √(π/2) debias must invert √(2/π) back to σ exactly.
    const trueSigma = 70;
    const st = run(Array(20).fill(trueSigma * MEAN_ABS));
    const p = adaptParams(BASE, SIGMA0, st);
    expect(p.sigmaEps).toBeCloseTo(trueSigma, 6);
  });

  test('without debias the estimate is exactly √(2/π) lower (biased)', () => {
    const trueSigma = 70;
    const st = run(Array(20).fill(trueSigma * MEAN_ABS), {
      ...DEFAULT_ADAPTIVE,
      halfNormalCorrect: false,
    });
    const biased = adaptParams(BASE, SIGMA0, st, { ...DEFAULT_ADAPTIVE, halfNormalCorrect: false });
    expect(biased.sigmaEps).toBeCloseTo(trueSigma * MEAN_ABS, 6); // ≈ 0.798·σ
  });

  test('recovers σ_ε from real |N(0,σ²)| draws within tolerance (loose, RNG)', () => {
    // A heavier-averaging EWMA (small α) so the endpoint is a stable population estimate.
    const cfg = { ...DEFAULT_ADAPTIVE, alphaSlow: 0.01 };
    const rng = new Rng(1234);
    const trueSigma = 70;
    const errs: number[] = [];
    for (let i = 0; i < 6000; i++) errs.push(Math.abs(rng.nextNormal() * trueSigma));
    const p = adaptParams(BASE, SIGMA0, run(errs, cfg), cfg);
    expect(p.sigmaEps).toBeGreaterThan(trueSigma * 0.8);
    expect(p.sigmaEps).toBeLessThan(trueSigma * 1.2);
  });

  test('EWMA tracks a regime shift (low noise → high noise)', () => {
    const low = adaptParams(BASE, SIGMA0, run(Array(40).fill(20)));
    const high = adaptParams(BASE, SIGMA0, run([...Array(40).fill(20), ...Array(40).fill(120)]));
    expect(high.sigmaEps).toBeGreaterThan(low.sigmaEps);
  });
});

describe('adaptive — rails (§14.1)', () => {
  test('σ_ε clamps to the upper rail under extreme noise + reports the hit', () => {
    const st = run(Array(30).fill(100000)); // huge errors
    const p = adaptParams(BASE, SIGMA0, st);
    expect(p.sigmaEps).toBe(DEFAULT_ADAPTIVE.sigmaEpsHiRatio * SIGMA0); // 2·σ₀ = 200
    expect(p.rails.sigmaEps).toBe('hi');
    expect(p.railHit).toBe(true);
  });

  test('σ_ε clamps to the lower rail under near-zero noise', () => {
    const st = run(Array(30).fill(0.0001));
    const p = adaptParams(BASE, SIGMA0, st);
    expect(p.sigmaEps).toBe(DEFAULT_ADAPTIVE.sigmaEpsLoRatio * SIGMA0); // 0.1·σ₀ = 10
    expect(p.rails.sigmaEps).toBe('lo');
  });

  test('s₀ never exceeds the §14.1 ceiling and regime is capped', () => {
    // fast >> slow forces regime to its cap; base s₀·(1+cap)=0.02 hits exactly the rail edge.
    const st = run([...Array(50).fill(10), ...Array(3).fill(100000)]);
    const p = adaptParams(BASE, SIGMA0, st);
    expect(p.regime).toBeLessThanOrEqual(DEFAULT_ADAPTIVE.regimeCap + 1e-9);
    expect(p.s0).toBeLessThanOrEqual(DEFAULT_ADAPTIVE.s0Hi + 1e-12);
    expect(p.s0).toBeGreaterThanOrEqual(DEFAULT_ADAPTIVE.s0Lo);
  });

  test('s₀ widens under a rising-volatility regime', () => {
    const calm = adaptParams(BASE, SIGMA0, run(Array(40).fill(30)));
    const spiking = adaptParams(BASE, SIGMA0, run([...Array(40).fill(30), 400, 400, 400]));
    expect(spiking.regime).toBeGreaterThan(0);
    expect(spiking.s0).toBeGreaterThan(calm.s0);
  });
});

describe('adaptive — optional α/β', () => {
  test('off by default: α/β stay at base', () => {
    const st = run(Array(30).fill(300));
    const p = adaptParams(BASE, SIGMA0, st);
    expect(p.alpha).toBe(BASE.alpha);
    expect(p.beta).toBe(BASE.beta);
  });

  test('on: noisier-than-baseline flow damps α/β within rails', () => {
    const cfg: AdaptiveConfig = { ...DEFAULT_ADAPTIVE, adaptAlphaBeta: true };
    // errors ≫ baseline σ_ε=100 ⇒ σ_ε rises ⇒ noiseRatio<1 ⇒ α,β shrink.
    const st = run(Array(40).fill(160), cfg);
    const p = adaptParams(BASE, SIGMA0, st, cfg);
    expect(p.alpha).toBeLessThan(BASE.alpha);
    expect(p.alpha).toBeGreaterThanOrEqual(cfg.alphaLo);
    expect(p.beta).toBeLessThanOrEqual(cfg.betaHi);
    expect(p.beta).toBeGreaterThanOrEqual(cfg.betaLo);
  });
});

describe('adaptive — purity', () => {
  test('observeError does not mutate prior state', () => {
    const st0 = initAdaptiveState();
    const st1 = observeError(st0, 50);
    expect(st0.count).toBe(0);
    expect(st1).not.toBe(st0);
  });

  test('adaptParams is a pure read (same state → same result)', () => {
    const st = run([40, 50, 60, 70]);
    const a = adaptParams(BASE, SIGMA0, st);
    const b = adaptParams(BASE, SIGMA0, st);
    expect(a).toEqual(b);
  });
});
