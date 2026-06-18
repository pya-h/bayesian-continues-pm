// I3 — Gen·exact moment cache. The standardised moments {emin, z, E[u], E[u²]}
// are a pure function of λ, so persisting them lets a reconstructed belief skip
// the normalisation quadrature. These tests pin that the cached path is
// numerically identical to recomputing, that a stale/absent cache is safely
// recomputed, that the serialized snapshot carries the cache, and that the lazy
// cdf grid still matches the eager result.

import { describe, expect, test } from 'bun:test';
import { bayesUpdateGenExact } from '../src/bayes.ts';
import { makeEngineConfig } from '../src/config.ts';
import { GenExactBelief, genExactStandardisedMoments } from '../src/gen_exact.ts';
import { price } from '../src/pricing.ts';

const SHAPES: [number, number, number][] = [
  [1, 0, 0],
  [1, 0.3, 0.2],
  [-1, 0, 0],
  [0.5, -0.25, 0.8],
  [2, 0.1, 1.6],
];

describe('Gen·exact moment cache (I3)', () => {
  test('a supplied cache reproduces the from-scratch belief exactly', () => {
    for (const lam of SHAPES) {
      const fresh = new GenExactBelief(50, 7, lam);
      const cached = new GenExactBelief(50, 7, lam, fresh.moments);
      // Bit-identical summary stats (same arithmetic, just skipped the recompute).
      expect(cached.mean()).toBe(fresh.mean());
      expect(cached.variance()).toBe(fresh.variance());
      expect(cached.stddev()).toBe(fresh.stddev());
      // pdf/cdf identical across the support.
      for (const th of [30, 45, 50, 55, 70]) {
        expect(cached.pdf(th)).toBe(fresh.pdf(th));
        expect(cached.cdf(th)).toBe(fresh.cdf(th));
      }
    }
  });

  test('the standalone helper matches the belief’s own cached moments', () => {
    for (const lam of SHAPES) {
      const b = new GenExactBelief(0, 1, lam);
      const m = genExactStandardisedMoments(lam);
      expect(m.emin).toBe(b.moments.emin);
      expect(m.z).toBe(b.moments.z);
      expect(m.eu).toBe(b.moments.eu);
      expect(m.eu2).toBe(b.moments.eu2);
    }
  });

  test('an invalid/stale cache is ignored and recomputed', () => {
    const good = new GenExactBelief(10, 2, [1, 0.2, 0.1]);
    // z ≤ 0 is structurally impossible → must be treated as stale and recomputed.
    const bad = new GenExactBelief(10, 2, [1, 0.2, 0.1], {
      emin: Number.NaN,
      z: -1,
      eu: 999,
      eu2: 999,
    });
    expect(bad.mean()).toBeCloseTo(good.mean(), 12);
    expect(bad.variance()).toBeCloseTo(good.variance(), 12);
  });

  test('serialize carries the cache and fromDTO round-trips identically', () => {
    const b = new GenExactBelief(120, 15, [1, 0.25, 0.3]);
    const dto = b.serialize();
    expect(dto.moments).toBeDefined();
    expect(dto.moments?.z).toBe(b.moments.z);
    const back = GenExactBelief.fromDTO(dto);
    expect(back.mean()).toBe(b.mean());
    expect(back.variance()).toBe(b.variance());
    expect(price({ type: 'BINARY_CALL', strike: 130 }, back)).toBe(
      price({ type: 'BINARY_CALL', strike: 130 }, b),
    );
  });

  test('the fixed-shape v1 update propagates the cache (λ unchanged)', () => {
    const cfg = makeEngineConfig(70, 10, {});
    const b = new GenExactBelief(70, 10, [1, 0.3, 0.1]);
    const after = bayesUpdateGenExact(b, 90, 0.8, cfg);
    // Same shape ⇒ identical standardised moments object content.
    expect(after.moments.emin).toBe(b.moments.emin);
    expect(after.moments.z).toBe(b.moments.z);
    expect(after.moments.eu).toBe(b.moments.eu);
    expect(after.moments.eu2).toBe(b.moments.eu2);
    expect(after.lambdas).toEqual(b.lambdas);
  });

  test('lazy cdf grid (BINARY/SPREAD pricing + sampling) matches a fresh recompute', () => {
    const b = new GenExactBelief(40, 6, [0.5, -0.2, 0.4]);
    const ref = new GenExactBelief(40, 6, [0.5, -0.2, 0.4]); // independent instance
    // SPREAD prices from the cdf grid — forces the lazy build on `b`.
    const spread = { type: 'SPREAD', lower: 35, upper: 48 } as const;
    expect(price(spread, b)).toBe(price(spread, ref));
    // quantiles (used by reserve sampling) match across the distribution.
    for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      expect(b.quantile(p)).toBe(ref.quantile(p));
    }
  });
});
