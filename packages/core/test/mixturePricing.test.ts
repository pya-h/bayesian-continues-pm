import { describe, expect, test } from 'bun:test';
import { payoff } from '../src/contracts.ts';
import { GaussianBelief } from '../src/gaussian.ts';
import { MixtureBelief } from '../src/mixture.ts';
import { Rng } from '../src/numerics.ts';
import { dPriceDMu, expectF, price } from '../src/pricing.ts';
import type { ContractSpec } from '../src/types.ts';

const approx = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

const mix = new MixtureBelief([
  { pi: 0.6, mu: 60000, sigma2: 4000 ** 2 },
  { pi: 0.4, mu: 80000, sigma2: 6000 ** 2 },
]);

const specs: ContractSpec[] = [
  { type: 'LINEAR' },
  { type: 'CALL', strike: 70000 },
  { type: 'PUT', strike: 65000 },
  { type: 'BINARY_CALL', strike: 72000 },
  { type: 'BINARY_PUT', strike: 58000 },
  { type: 'SPREAD', lower: 62000, upper: 78000 },
  { type: 'GAUSSIAN', center: 70000, width: 5000 },
];

describe('mixture pricing (V2-1)', () => {
  test('price = Σ π_k · price(component) — exact by linearity', () => {
    for (const spec of specs) {
      let weighted = 0;
      for (const c of mix.components) {
        weighted += c.pi * price(spec, new GaussianBelief(c.mu, c.sigma2));
      }
      expect(approx(price(spec, mix), weighted, 1e-9)).toBe(true);
    }
  });

  test('price matches a Monte-Carlo estimate of E[payoff]', () => {
    const draws = mix.sample(400_000, new Rng(0xabcdef));
    for (const spec of specs) {
      let s = 0;
      for (const d of draws) s += payoff(spec, d);
      const mc = s / draws.length;
      const closed = price(spec, mix);
      // tolerance scaled to the payoff magnitude (binaries/spreads ~O(1), call ~O(1e3))
      const tol = Math.max(0.01, Math.abs(closed) * 0.02);
      expect(approx(closed, mc, tol)).toBe(true);
    }
  });

  test('LINEAR price equals the mixture mean', () => {
    expect(approx(price({ type: 'LINEAR' }, mix), mix.mean(), 1e-6)).toBe(true);
  });

  test('binary call + binary put at same strike = 1', () => {
    const bc = price({ type: 'BINARY_CALL', strike: 71000 }, mix);
    const bp = price({ type: 'BINARY_PUT', strike: 71000 }, mix);
    expect(approx(bc + bp, 1, 1e-9)).toBe(true);
  });

  test('dPriceDMu = Σ π_k · component dPriceDMu, and matches a central difference', () => {
    for (const spec of specs) {
      let weighted = 0;
      for (const c of mix.components) {
        // central difference on each component mean
        const h = 1e-2;
        const up = price(spec, new GaussianBelief(c.mu + h, c.sigma2));
        const dn = price(spec, new GaussianBelief(c.mu - h, c.sigma2));
        weighted += c.pi * ((up - dn) / (2 * h));
      }
      expect(approx(dPriceDMu(spec, mix), weighted, 1e-3)).toBe(true);
    }
  });

  test('expectF on a mixture integrates the pdf to 1 and prices a smooth payoff', () => {
    const one = expectF(() => 1, mix);
    expect(approx(one, 1, 1e-6)).toBe(true);
    // GAUSSIAN payoff is smooth → Simpson should match the closed form well
    const spec: ContractSpec = { type: 'GAUSSIAN', center: 70000, width: 5000 };
    expect(
      approx(
        expectF((t) => payoff(spec, t), mix),
        price(spec, mix),
        1e-4,
      ),
    ).toBe(true);
  });
});
