import { describe, expect, test } from 'bun:test';
import { Phi, Rng, erf, normInv, phi } from '../src/numerics.ts';

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

describe('phi (standard normal PDF)', () => {
  test('known values', () => {
    expect(close(phi(0), 0.3989422804014327)).toBe(true);
    expect(close(phi(1), 0.24197072451914337)).toBe(true);
    expect(close(phi(-1), 0.24197072451914337)).toBe(true);
    expect(close(phi(2), 0.05399096651318806)).toBe(true);
  });
});

describe('Phi (standard normal CDF)', () => {
  test('known values to ~1e-10', () => {
    expect(close(Phi(0), 0.5)).toBe(true);
    expect(close(Phi(1), 0.8413447460685429)).toBe(true);
    expect(close(Phi(-1), 0.15865525393145707)).toBe(true);
    expect(close(Phi(1.96), 0.9750021048517795)).toBe(true);
    expect(close(Phi(2), 0.9772498680518208)).toBe(true);
    expect(close(Phi(3), 0.9986501019683699)).toBe(true);
    expect(close(Phi(-3), 0.0013498980316301035)).toBe(true);
  });

  test('tail accuracy (absolute)', () => {
    expect(close(Phi(5), 0.9999997133484281, 1e-12)).toBe(true);
    expect(close(Phi(-5), 2.866515719235352e-7, 1e-12)).toBe(true);
    expect(close(Phi(8), 1, 1e-12)).toBe(true);
  });

  test('symmetry Phi(x) + Phi(-x) = 1', () => {
    for (const x of [0.3, 1.1, 2.7, 4.2, 6.0]) {
      expect(close(Phi(x) + Phi(-x), 1, 1e-12)).toBe(true);
    }
  });
});

describe('erf', () => {
  test('known values', () => {
    expect(close(erf(0), 0)).toBe(true);
    expect(close(erf(0.5), 0.5204998778130465)).toBe(true);
    expect(close(erf(1), 0.8427007929497149)).toBe(true);
    expect(close(erf(2), 0.9953222650189527)).toBe(true);
    expect(close(erf(-1), -0.8427007929497149)).toBe(true);
  });
});

describe('normInv (probit)', () => {
  test('inverts Phi to ~1e-9', () => {
    for (const x of [-3, -1.5, -0.4, 0, 0.4, 1.5, 2.33, 3.09]) {
      expect(close(normInv(Phi(x)), x, 1e-9)).toBe(true);
    }
  });
  test('known quantiles', () => {
    expect(close(normInv(0.975), 1.959963984540054, 1e-9)).toBe(true);
    expect(close(normInv(0.99), 2.3263478740408408, 1e-9)).toBe(true);
  });
  test('extreme tails stay finite (no Halley-step overflow to NaN)', () => {
    for (const p of [1e-310, 1e-315, 5e-324, 1 - 1e-15]) {
      expect(Number.isFinite(normInv(p))).toBe(true);
    }
    // Sign + monotonicity preserved into the deep tail.
    expect(normInv(5e-324)).toBeLessThan(normInv(1e-300));
  });
});

describe('Rng (seeded)', () => {
  test('deterministic & reproducible', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 5; i++) expect(a.next()).toBe(b.next());
  });

  test('uniform mean ≈ 0.5 over a large sample', () => {
    const r = new Rng(7);
    let s = 0;
    const n = 100_000;
    for (let i = 0; i < n; i++) s += r.next();
    expect(close(s / n, 0.5, 5e-3)).toBe(true);
  });

  test('nextNormal: mean ≈ 0, var ≈ 1', () => {
    const r = new Rng(123);
    const n = 200_000;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const z = r.nextNormal();
      s += z;
      s2 += z * z;
    }
    const mean = s / n;
    const variance = s2 / n - mean * mean;
    expect(close(mean, 0, 1e-2)).toBe(true);
    expect(close(variance, 1, 2e-2)).toBe(true);
  });
});
