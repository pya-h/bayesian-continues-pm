import { describe, expect, test } from 'bun:test';
import { GaussianBelief, bayesUpdate, extractSignal, makeEngineConfig } from '@bmm/core';
import { projectBelief } from '../src/lib/clientBelief.ts';
import type { ContractSpec } from '../src/lib/types.ts';

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

const mu = 100;
const sigma = 20;
const cfg = makeEngineConfig(mu, sigma, {});
const cfgRec = cfg as unknown as Record<string, number | boolean>;

describe('projectBelief', () => {
  test('reproduces the server path exactly (extractSignal → bayesUpdate)', () => {
    const cases: { spec: ContractSpec; signedQ: number }[] = [
      { spec: { type: 'CALL', strike: 110 }, signedQ: 80 },
      { spec: { type: 'PUT', strike: 90 }, signedQ: 40 },
      { spec: { type: 'BINARY_CALL', strike: 105 }, signedQ: -60 },
      { spec: { type: 'SPREAD', lower: 95, upper: 115 }, signedQ: 120 },
      { spec: { type: 'GAUSSIAN', center: 100, width: 10 }, signedQ: -30 },
    ];
    for (const { spec, signedQ } of cases) {
      const belief = new GaussianBelief(mu, sigma * sigma);
      const sig = extractSignal(spec, signedQ, belief, cfg);
      const exp = bayesUpdate(belief, sig.signal, sig.weight, cfg);
      const got = projectBelief({ spec, signedQ, mu, sigma, cfg: cfgRec });
      expect(close(got.mu, exp.mu)).toBe(true);
      expect(close(got.sigma, exp.stddev())).toBe(true);
    }
  });

  test('buying a call nudges μ upward and never widens σ', () => {
    const got = projectBelief({
      spec: { type: 'CALL', strike: 110 },
      signedQ: 150,
      mu,
      sigma,
      cfg: cfgRec,
    });
    expect(got.mu).toBeGreaterThan(mu);
    expect(got.sigma).toBeLessThanOrEqual(sigma);
  });

  test('selling a call (bearish) pushes μ downward', () => {
    const got = projectBelief({
      spec: { type: 'CALL', strike: 110 },
      signedQ: -150,
      mu,
      sigma,
      cfg: cfgRec,
    });
    expect(got.mu).toBeLessThan(mu);
  });

  test('a tiny trade barely moves the belief (below the noise threshold)', () => {
    const got = projectBelief({
      spec: { type: 'CALL', strike: 110 },
      signedQ: 1,
      mu,
      sigma,
      cfg: cfgRec,
    });
    expect(Math.abs(got.mu - mu)).toBeLessThan(1);
  });

  test('degenerate σ ≤ 0 does not throw', () => {
    const got = projectBelief({
      spec: { type: 'BINARY_CALL', strike: 100 },
      signedQ: 10,
      mu: 100,
      sigma: 0,
      cfg: cfgRec,
    });
    expect(Number.isFinite(got.mu)).toBe(true);
    expect(Number.isFinite(got.sigma)).toBe(true);
  });
});
