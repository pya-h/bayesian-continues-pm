import { describe, expect, test } from 'bun:test';
import { Rng } from '../src/numerics.ts';
import { type SimParams, runMonteCarlo, simulateRun } from '../src/sim.ts';

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
