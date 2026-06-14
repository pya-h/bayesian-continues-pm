// Gen·exact v1 update (fixed-shape location/scale). The exponent shape λ
// is held constant; only μ and σ move, in the variance domain.

import { describe, expect, test } from 'bun:test';
import { bayesUpdateGenExact } from '../src/bayes.ts';
import { makeEngineConfig } from '../src/config.ts';
import { GenExactBelief } from '../src/gen_exact.ts';

const cfg = makeEngineConfig(70, 10, {}); // σ_min = 1, σ_ε = 10

const SHAPES: { name: string; lam: [number, number, number] }[] = [
  { name: 'unimodal', lam: [1, 0, 0] },
  { name: 'skew', lam: [1, 0.4, 0] },
  { name: 'bimodal', lam: [-1, 0, 0] },
];

describe('bayesUpdateGenExact — fixed-shape location/scale', () => {
  for (const s of SHAPES) {
    test(`${s.name}: μ moves toward s, variance shrinks, λ & kind preserved`, () => {
      const b = new GenExactBelief(70, 10, s.lam);
      const after = bayesUpdateGenExact(b, 90, 0.8, cfg);

      expect(after.kind).toBe('gen_exact');
      expect(after.lambdas).toEqual(s.lam); // shape unchanged
      // location moves toward the signal (strictly between prior μ and s)
      expect(after.mu).toBeGreaterThan(70);
      expect(after.mu).toBeLessThan(90);
      // the summary mean also moves toward s
      expect(after.mean()).toBeGreaterThan(b.mean());
      // variance strictly decreases under a positive-weight observation
      expect(after.variance()).toBeLessThan(b.variance());
    });
  }

  test('a downward signal moves μ down', () => {
    const b = new GenExactBelief(70, 10, [1, 0, 0]);
    const after = bayesUpdateGenExact(b, 50, 0.8, cfg);
    expect(after.mu).toBeLessThan(70);
    expect(after.mu).toBeGreaterThan(50);
  });

  test('w = 0 leaves location and shape unchanged', () => {
    const b = new GenExactBelief(70, 10, [1, 0.3, 0.1]);
    const after = bayesUpdateGenExact(b, 200, 0, cfg);
    expect(after.mu).toBe(70);
    expect(after.sigma).toBeCloseTo(10, 9);
    expect(after.lambdas).toEqual([1, 0.3, 0.1]);
    expect(after.variance()).toBeCloseTo(b.variance(), 9);
  });

  test('repeated confident signals converge μ toward s and keep shrinking variance', () => {
    let b = new GenExactBelief(70, 10, [1, 0, 0]);
    let prevVar = b.variance();
    for (let i = 0; i < 12; i++) {
      b = bayesUpdateGenExact(b, 95, 0.9, cfg);
      expect(b.variance()).toBeLessThanOrEqual(prevVar + 1e-12);
      prevVar = b.variance();
    }
    expect(Math.abs(b.mu - 95)).toBeLessThan(5); // homed in on the signal
  });

  test('σ_min floors the variance (extreme confident stream cannot collapse it)', () => {
    const tight = makeEngineConfig(70, 10, { sigmaMin: 3, sigmaEps: 1 });
    let b = new GenExactBelief(70, 10, [1, 0, 0]);
    for (let i = 0; i < 50; i++) b = bayesUpdateGenExact(b, 90, 1, tight);
    expect(b.variance()).toBeGreaterThanOrEqual(3 * 3 - 1e-9);
  });

  test('simplified update path also moves μ toward s and shrinks variance', () => {
    const simp = makeEngineConfig(70, 10, { useSimplifiedUpdate: true, lr: 0.3, decay: 0.1 });
    const b = new GenExactBelief(70, 10, [1, 0, 0]);
    const after = bayesUpdateGenExact(b, 90, 1, simp);
    expect(after.mu).toBeGreaterThan(70);
    expect(after.mu).toBeLessThan(90);
    expect(after.variance()).toBeLessThan(b.variance());
    expect(after.lambdas).toEqual([1, 0, 0]);
  });
});
