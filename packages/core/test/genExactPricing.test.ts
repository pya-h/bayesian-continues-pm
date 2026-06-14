// Gen·exact pricing & sensitivity, verified vs Monte-Carlo (the price IS
// E[payoff]) and vs a finite-difference of the price (∂P/∂μ). Uses σ=1 beliefs so
// payoffs are O(1) and the ±0.01 MC tolerance is meaningful.

import { describe, expect, test } from 'bun:test';
import { payoff } from '../src/contracts.ts';
import { GenExactBelief } from '../src/gen_exact.ts';
import { Rng } from '../src/numerics.ts';
import { dPriceDMu, price } from '../src/pricing.ts';
import type { ContractSpec } from '../src/types.ts';

const SHAPES: { name: string; lam: [number, number, number] }[] = [
  { name: 'unimodal', lam: [1, 0, 0] },
  { name: 'skew', lam: [1, 0.4, 0] },
  { name: 'flat-top', lam: [1, 0, 0.5] },
  { name: 'bimodal', lam: [-1, 0, 0] },
];

// Strikes/bands near the (σ=1, μ=0) belief so the payoff support overlaps the mass.
const SPECS: ContractSpec[] = [
  { type: 'CALL', strike: 0.4 },
  { type: 'PUT', strike: -0.3 },
  { type: 'BINARY_CALL', strike: 0.5 },
  { type: 'BINARY_PUT', strike: -0.2 },
  { type: 'SPREAD', lower: -1, upper: 1.5 },
  { type: 'GAUSSIAN', center: 0.3, width: 1.2 },
];

function mcPrice(spec: ContractSpec, b: GenExactBelief, n = 1_000_000): number {
  const xs = b.sample(n, new Rng(987654));
  let sum = 0;
  for (const x of xs) sum += payoff(spec, x);
  return sum / n;
}

describe('Gen·exact pricing — price = E[payoff] (vs MC)', () => {
  for (const s of SHAPES) {
    const b = new GenExactBelief(0, 1, s.lam);
    for (const spec of SPECS) {
      test(`${s.name} / ${spec.type}: closed/quadrature price matches MC`, () => {
        const p = price(spec, b);
        const mc = mcPrice(spec, b);
        expect(Math.abs(p - mc)).toBeLessThan(0.01);
      });
    }
  }

  test('LINEAR prices exactly to the belief mean', () => {
    const b = new GenExactBelief(70, 10, [1, 0.4, 0]);
    expect(price({ type: 'LINEAR' }, b)).toBeCloseTo(b.mean(), 9);
  });
});

describe('Gen·exact sensitivity — dPriceDMu = ∂price/∂μ (finite difference)', () => {
  for (const s of SHAPES) {
    const b = new GenExactBelief(0, 1, s.lam);
    for (const spec of SPECS) {
      test(`${s.name} / ${spec.type}: analytic ∂P/∂μ matches a central difference`, () => {
        const h = 1e-3;
        const up = price(spec, new GenExactBelief(b.mu + h, b.sigma, b.lambdas));
        const dn = price(spec, new GenExactBelief(b.mu - h, b.sigma, b.lambdas));
        const fd = (up - dn) / (2 * h);
        expect(Math.abs(dPriceDMu(spec, b) - fd)).toBeLessThan(2e-3);
      });
    }
  }
});
