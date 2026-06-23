import { describe, expect, test } from 'bun:test';
import { Rng } from '../src/numerics.ts';
import { type SimParams, compareAdaptiveVsStatic, runMonteCarlo, simulateRun } from '../src/sim.ts';
import type { BeliefKind } from '../src/types.ts';

const BASE: SimParams = { runs: 100, traders: 60, mu0: 100, sigma0: 20, seed: 42 };

describe('runMonteCarlo — MODEL.md §17.3', () => {
  test('is deterministic for a given seed', () => {
    const a = runMonteCarlo(BASE);
    const b = runMonteCarlo(BASE);
    expect(a).toEqual(b);
  });

  test('a different seed gives a different experiment', () => {
    const a = runMonteCarlo(BASE);
    const b = runMonteCarlo({ ...BASE, seed: 43 });
    expect(a.meanBeliefError).not.toBe(b.meanBeliefError);
  });

  test('reports every metric as a finite number', () => {
    const s = runMonteCarlo(BASE);
    for (const v of [
      s.meanBeliefError,
      s.rmseBeliefError,
      s.meanPriorError,
      s.calibration80,
      s.meanMmPnl,
      s.meanUserWelfare,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(s.runs).toBe(BASE.runs);
    expect(s.traders).toBe(BASE.traders);
  });

  test('calibration is a probability in [0,1]', () => {
    const s = runMonteCarlo(BASE);
    expect(s.calibration80).toBeGreaterThanOrEqual(0);
    expect(s.calibration80).toBeLessThanOrEqual(1);
  });

  test('rmse ≥ mean error (Jensen)', () => {
    const s = runMonteCarlo(BASE);
    expect(s.rmseBeliefError).toBeGreaterThanOrEqual(s.meanBeliefError - 1e-9);
  });

  test('informed traders make the engine LEARN — final error ≪ prior baseline', () => {
    const informed = runMonteCarlo({ ...BASE, sigmaObs: BASE.sigma0 / 5 });
    expect(informed.meanBeliefError).toBeLessThan(informed.meanPriorError);
    // and meaningfully so — at least a 2× improvement over no learning.
    expect(informed.meanBeliefError).toBeLessThan(informed.meanPriorError / 2);
  });

  test('pure-noise traders do NOT beat the prior much (engine is not fooled into accuracy)', () => {
    const noisy = runMonteCarlo({ ...BASE, sigmaObs: BASE.sigma0 * 6 });
    // With near-useless signals the final error is no better than the prior.
    expect(noisy.meanBeliefError).toBeGreaterThan(noisy.meanPriorError * 0.6);
  });

  test('the MM earns the spread on informed flow (mmPnl > 0)', () => {
    const informed = runMonteCarlo({ ...BASE, sigmaObs: BASE.sigma0 / 5 });
    expect(informed.meanMmPnl).toBeGreaterThan(0);
  });
});

describe('simulateRun', () => {
  test('with zero traders the belief is untouched and books are flat', () => {
    const r = simulateRun({ ...BASE, traders: 0 }, new Rng(1));
    expect(r.muFinal).toBe(BASE.mu0);
    expect(r.sigmaFinal).toBe(BASE.sigma0);
    expect(r.trades).toBe(0);
    expect(r.mmPnl).toBe(0);
    expect(r.userWelfare).toBe(0);
    expect(r.beliefError).toBeCloseTo(Math.abs(BASE.mu0 - r.thetaTrue), 9);
  });

  test('threads its rng — same rng state reproduces the run', () => {
    const a = simulateRun(BASE, new Rng(99));
    const b = simulateRun(BASE, new Rng(99));
    expect(a).toEqual(b);
  });

  test('runs actually execute trades', () => {
    const r = simulateRun(BASE, new Rng(5));
    expect(r.trades).toBeGreaterThan(0);
  });
});

describe('adaptive parameters (V2-2c)', () => {
  // A "volatile" regime: traders are noisier (σ_obs = 2·σ₀) than the static σ_ε
  // assumes, and bet struck at their read so the signal surprise reflects that noise.
  const VOL: SimParams = {
    runs: 600,
    traders: 80,
    mu0: 100,
    sigma0: 20,
    sigmaObs: 40,
    seed: 0xb33f,
    strikeAtRead: true,
  };

  test('an adaptive run is deterministic for a given seed', () => {
    const a = runMonteCarlo({ ...VOL, adaptive: true });
    const b = runMonteCarlo({ ...VOL, adaptive: true });
    expect(a).toEqual(b);
  });

  test('adaptive σ_ε stays within the §14.1 rails [0.1, 2]·σ₀', () => {
    const s = runMonteCarlo({ ...VOL, adaptive: true });
    expect(s.meanSigmaEpsFinal).toBeGreaterThanOrEqual(0.1 * VOL.sigma0 - 1e-9);
    expect(s.meanSigmaEpsFinal).toBeLessThanOrEqual(2 * VOL.sigma0 + 1e-9);
  });

  test('adaptation is OFF by default (params stay at the static baseline)', () => {
    const s = runMonteCarlo(VOL); // no `adaptive`
    expect(s.adaptive).toBe(false);
    expect(s.railHitRate).toBe(0);
    // σ_ε held at the static default (= σ₀ via sigmaEpsRatio 1.0).
    expect(s.meanSigmaEpsFinal).toBeCloseTo(VOL.sigma0, 6);
  });

  test('in a volatile/noisy regime, adaptation improves calibration vs static', () => {
    const c = compareAdaptiveVsStatic(VOL);
    // Static σ_ε is too small for this noise ⇒ overconfident (calib ≪ 0.80).
    expect(c.static.calibration80).toBeLessThan(0.65);
    // Adaptive lifts σ_ε (here onto its rail), restoring an honest 80% CI.
    expect(c.adaptive.calibration80).toBeGreaterThan(c.static.calibration80 + 0.1);
    expect(c.adaptive.calibrationError).toBeLessThan(c.static.calibrationError);
    expect(c.adaptiveCalibratesBetter).toBe(true);
    expect(c.calibrationErrorDelta).toBeLessThan(0); // adaptive closer to ideal
  });

  test('the model zoo runs end-to-end under adaptation (every kind, finite metrics)', () => {
    const kinds: BeliefKind[] = ['gaussian', 'student_t', 'mixture', 'gen_exact'];
    for (const beliefKind of kinds) {
      // Small smoke run; gen_exact uses the cheaper v1 fixed-shape update here.
      const s = runMonteCarlo({
        ...VOL,
        runs: 8,
        traders: 20,
        adaptive: true,
        beliefKind,
        cfg: { genExactShapeAdapt: false },
      });
      expect(s.beliefKind).toBe(beliefKind);
      for (const v of [s.meanBeliefError, s.calibration80, s.meanMmPnl, s.meanSigmaEpsFinal]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(s.calibration80).toBeGreaterThanOrEqual(0);
      expect(s.calibration80).toBeLessThanOrEqual(1);
    }
  }, 30000);
});

// adaptive-parameter STABILITY. showed adaptation helps in one
// volatile regime; this block pins that the controller is *stable*: bounded
// within the rails everywhere, a consistent estimator of the true noise
// scale (more evidence ⇒ closer to σ_obs), a stable saturation in the deeply
// volatile regime (no drift/oscillation with horizon), and a benefit that is
// robust across seeds — not a single-seed artifact. All deterministic.
describe('adaptive-parameter stability (V2-7)', () => {
  const LO = 0.1 * 20; // σ_ε lower rail = 0.1·σ₀ = 2
  const HI = 2 * 20; // σ_ε upper rail = 2·σ₀ = 40
  const STAB: Omit<SimParams, 'adaptive'> = {
    runs: 300,
    traders: 80,
    mu0: 100,
    sigma0: 20,
    seed: 0xb33f,
    strikeAtRead: true,
  };

  test('σ_ε is a consistent estimator: more evidence ⇒ closer to the true noise scale', () => {
    // Interior regime (σ_obs = 1.5·σ₀ = 30, strictly inside the rails). σ_ε starts
    // high and should walk DOWN toward σ_obs as more trades accumulate.
    const horizons = [30, 80, 200];
    const se = horizons.map(
      (traders) =>
        runMonteCarlo({ ...STAB, sigmaObs: 30, traders, adaptive: true }).meanSigmaEpsFinal,
    );
    // Always within the rails (bounded — never diverges).
    for (const v of se) {
      expect(v).toBeGreaterThanOrEqual(LO);
      expect(v).toBeLessThanOrEqual(HI + 1e-9);
    }
    // Monotone approach from above toward σ_obs=30 as the horizon grows.
    expect(se[0]).toBeGreaterThan(se[1]);
    expect(se[1]).toBeGreaterThan(se[2]);
    // The long horizon's estimate is strictly closer to the truth than the short one.
    expect(Math.abs(se[2] - 30)).toBeLessThan(Math.abs(se[0] - 30));
  });

  test('stable saturation: in the deeply volatile regime σ_ε pins at the rail, horizon-independent', () => {
    // σ_obs = 2·σ₀ = 40: the honest σ_ε wants the upper rail and stays clamped there
    // regardless of horizon — no drift, no oscillation (the clamp is stable).
    const sat = [30, 80, 200].map(
      (traders) =>
        runMonteCarlo({ ...STAB, sigmaObs: 40, traders, adaptive: true }).meanSigmaEpsFinal,
    );
    for (const v of sat) expect(v).toBeGreaterThanOrEqual(0.95 * HI); // ≈ pinned high
    const spread =
      (Math.max(...sat) - Math.min(...sat)) / (sat.reduce((a, b) => a + b) / sat.length);
    expect(spread).toBeLessThan(0.05); // < 5% across a 6.7× horizon range
    expect(runMonteCarlo({ ...STAB, sigmaObs: 40, adaptive: true }).railHitRate).toBe(1);
  });

  test('the calibration benefit is robust across seeds (not a single-seed artifact)', () => {
    const calibs: number[] = [];
    for (const seed of [1, 2, 3, 7, 42]) {
      const c = compareAdaptiveVsStatic({ ...STAB, sigmaObs: 40, seed });
      expect(c.static.calibration80).toBeLessThan(0.6); // static overconfident every seed
      expect(c.adaptive.calibration80).toBeGreaterThan(0.7); // adaptive restores an honest CI
      expect(c.adaptive.calibration80).toBeLessThan(0.9); // without over-correcting
      expect(c.adaptiveCalibratesBetter).toBe(true);
      calibs.push(c.adaptive.calibration80);
    }
    // Low cross-seed variance ⇒ the lift is a stable property, not luck.
    expect(Math.max(...calibs) - Math.min(...calibs)).toBeLessThan(0.12);
  });

  test('bounded everywhere; monotonically beneficial across the volatile half of the spectrum', () => {
    // σ_ε never leaves the rails across the whole σ_obs spectrum (calm → extreme)
    // the controller is stable even where adaptation is neutral/over-cautious (σ_obs≈σ₀).
    for (const ratio of [0.5, 1, 1.5, 2, 3, 4]) {
      const c = compareAdaptiveVsStatic({ ...STAB, sigmaObs: ratio * 20 });
      expect(c.adaptive.meanSigmaEpsFinal).toBeGreaterThanOrEqual(LO);
      expect(c.adaptive.meanSigmaEpsFinal).toBeLessThanOrEqual(HI + 1e-9);
      // In the volatile half (σ_obs ≥ 1.5·σ₀) adaptation strictly improves calibration.
      if (ratio >= 1.5) expect(c.calibrationErrorDelta).toBeLessThan(0);
    }
  }, 30000);

  test('stability holds across the model zoo (σ_ε within rails for every kind)', () => {
    const kinds: BeliefKind[] = ['gaussian', 'student_t', 'mixture', 'gen_exact'];
    for (const beliefKind of kinds) {
      const s = runMonteCarlo({
        ...STAB,
        runs: 40,
        traders: 50,
        sigmaObs: 40,
        adaptive: true,
        beliefKind,
        cfg: { genExactShapeAdapt: false },
      });
      expect(s.meanSigmaEpsFinal).toBeGreaterThanOrEqual(LO);
      expect(s.meanSigmaEpsFinal).toBeLessThanOrEqual(HI + 1e-9);
      expect(Number.isFinite(s.calibration80)).toBe(true);
    }
  }, 30000);
});
