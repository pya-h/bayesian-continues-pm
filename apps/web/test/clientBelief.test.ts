import { describe, expect, test } from 'bun:test';
import {
  GaussianBelief,
  MixtureBelief,
  StudentTBelief,
  bayesUpdate,
  extractSignal,
  makeEngineConfig,
  updateBelief,
} from '@bmm/core';
import { beliefFromView } from '../src/lib/beliefFromView.ts';
import { projectBelief } from '../src/lib/clientBelief.ts';
import type { Belief, ContractSpec } from '../src/lib/types.ts';

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

const mu = 100;
const sigma = 20;
const cfg = makeEngineConfig(mu, sigma, {});
const cfgRec = cfg as unknown as Record<string, number | boolean>;
const gauss = new GaussianBelief(mu, sigma * sigma);

describe('projectBelief', () => {
  test('reproduces the server path exactly (extractSignal → bayesUpdate) for Gaussian', () => {
    const cases: { spec: ContractSpec; signedQ: number }[] = [
      { spec: { type: 'CALL', strike: 110 }, signedQ: 80 },
      { spec: { type: 'PUT', strike: 90 }, signedQ: 40 },
      { spec: { type: 'BINARY_CALL', strike: 105 }, signedQ: -60 },
      { spec: { type: 'SPREAD', lower: 95, upper: 115 }, signedQ: 120 },
      { spec: { type: 'GAUSSIAN', center: 100, width: 10 }, signedQ: -30 },
    ];
    for (const { spec, signedQ } of cases) {
      const sig = extractSignal(spec, signedQ, gauss, cfg);
      const exp = bayesUpdate(gauss, sig.signal, sig.weight, cfg);
      const got = projectBelief({ spec, signedQ, belief: gauss, cfg: cfgRec });
      expect(close(got.mu, exp.mu)).toBe(true);
      expect(close(got.sigma, exp.stddev())).toBe(true);
    }
  });

  test('uses the KIND-AWARE update for a Student-t belief (dispatches via updateBelief)', () => {
    const spec: ContractSpec = { type: 'CALL', strike: 110 };
    const signedQ = 80;
    const t = StudentTBelief.fromVariance(5, mu, sigma * sigma);
    const sig = extractSignal(spec, signedQ, t, cfg);
    const exp = updateBelief(t, sig.signal, sig.weight, cfg); // bayesUpdateStudentT
    const got = projectBelief({ spec, signedQ, belief: t, cfg: cfgRec });
    expect(close(got.mu, exp.mean())).toBe(true);
    expect(close(got.sigma, exp.stddev())).toBe(true);
  });

  test('uses the mixture update — diverges from a Gaussian projection of equal σ', () => {
    const spec: ContractSpec = { type: 'CALL', strike: 82 };
    const signedQ = 120;
    const mix = new MixtureBelief([
      { pi: 0.5, mu: 60, sigma2: 25 },
      { pi: 0.5, mu: 80, sigma2: 25 },
    ]);
    // projectBelief matches the kind-aware mixture update…
    const sig = extractSignal(spec, signedQ, mix, cfg);
    const exp = updateBelief(mix, sig.signal, sig.weight, cfg); // bayesUpdateMixture
    const got = projectBelief({ spec, signedQ, belief: mix, cfg: cfgRec });
    expect(close(got.mu, exp.mean(), 1e-9)).toBe(true);
    expect(close(got.sigma, exp.stddev(), 1e-9)).toBe(true);
    // …and a Gaussian of equal mean/σ projects to a visibly different σ (the old bug).
    const g = new GaussianBelief(mix.mean(), mix.variance());
    const gSig = extractSignal(spec, signedQ, g, cfg);
    const gExp = bayesUpdate(g, gSig.signal, gSig.weight, cfg);
    expect(Math.abs(got.sigma - gExp.stddev())).toBeGreaterThan(1e-6);
  });

  test('buying a call nudges μ upward and never widens σ', () => {
    const got = projectBelief({
      spec: { type: 'CALL', strike: 110 },
      signedQ: 150,
      belief: gauss,
      cfg: cfgRec,
    });
    expect(got.mu).toBeGreaterThan(mu);
    expect(got.sigma).toBeLessThanOrEqual(sigma);
  });

  test('selling a call (bearish) pushes μ downward', () => {
    const got = projectBelief({
      spec: { type: 'CALL', strike: 110 },
      signedQ: -150,
      belief: gauss,
      cfg: cfgRec,
    });
    expect(got.mu).toBeLessThan(mu);
  });

  test('a tiny trade barely moves the belief (below the noise threshold)', () => {
    const got = projectBelief({
      spec: { type: 'CALL', strike: 110 },
      signedQ: 1,
      belief: gauss,
      cfg: cfgRec,
    });
    expect(Math.abs(got.mu - mu)).toBeLessThan(1);
  });

  test('degenerate σ ≤ 0 does not throw (beliefFromView clamps)', () => {
    const degenerate = beliefFromView({ kind: 'gaussian', mu: 100, sigma: 0, sigma2: 0 } as Belief);
    const got = projectBelief({
      spec: { type: 'BINARY_CALL', strike: 100 },
      signedQ: 10,
      belief: degenerate,
      cfg: cfgRec,
    });
    expect(Number.isFinite(got.mu)).toBe(true);
    expect(Number.isFinite(got.sigma)).toBe(true);
  });
});
