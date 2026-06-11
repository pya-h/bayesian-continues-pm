import { describe, expect, test } from 'bun:test';
import { GaussianBelief } from '../src/gaussian.ts';
import { MixtureBelief } from '../src/mixture.ts';
import { Rng } from '../src/numerics.ts';

const approx = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

describe('MixtureBelief — BeliefModel contract', () => {
  // A clearly bimodal belief: two camps at 60 and 80, equal weight.
  const bimodal = new MixtureBelief([
    { pi: 0.5, mu: 60, sigma2: 25 },
    { pi: 0.5, mu: 80, sigma2: 25 },
  ]);

  test('normalizes weights so Σπ = 1', () => {
    const m = new MixtureBelief([
      { pi: 2, mu: 0, sigma2: 1 },
      { pi: 2, mu: 10, sigma2: 1 },
    ]);
    const sum = m.components.reduce((s, c) => s + c.pi, 0);
    expect(approx(sum, 1, 1e-12)).toBe(true);
    expect(approx(m.components[0]?.pi ?? 0, 0.5, 1e-12)).toBe(true);
  });

  test('mean = Σπ_k μ_k', () => {
    expect(approx(bimodal.mean(), 70, 1e-12)).toBe(true);
  });

  test('variance via law of total variance (between + within)', () => {
    // within = mean of σ_k² = 25; between = Var of means = 0.5·10² + 0.5·10² = 100.
    expect(approx(bimodal.variance(), 125, 1e-9)).toBe(true);
    expect(approx(bimodal.stddev(), Math.sqrt(125), 1e-9)).toBe(true);
  });

  test('single-component mixture equals the Gaussian it wraps', () => {
    const g = new GaussianBelief(65000, 5000 ** 2);
    const m = new MixtureBelief([{ pi: 1, mu: 65000, sigma2: 5000 ** 2 }]);
    expect(approx(m.mean(), g.mean(), 1e-9)).toBe(true);
    expect(approx(m.variance(), g.variance(), 1e-3)).toBe(true);
    for (const theta of [40000, 60000, 65000, 72000, 90000]) {
      expect(approx(m.pdf(theta), g.pdf(theta), 1e-15)).toBe(true);
      expect(approx(m.cdf(theta), g.cdf(theta), 1e-12)).toBe(true);
    }
  });

  test('pdf integrates to 1 and is genuinely bimodal (dip at the midpoint)', () => {
    // crude trapezoid over a wide window
    let area = 0;
    const dx = 0.05;
    for (let x = 20; x < 120; x += dx) area += bimodal.pdf(x) * dx;
    expect(approx(area, 1, 1e-3)).toBe(true);
    // both peaks exceed the trough between them
    expect(bimodal.pdf(60) > bimodal.pdf(70)).toBe(true);
    expect(bimodal.pdf(80) > bimodal.pdf(70)).toBe(true);
  });

  test('cdf is monotone increasing from ~0 to ~1', () => {
    expect(bimodal.cdf(0) < 1e-6).toBe(true);
    expect(bimodal.cdf(140) > 1 - 1e-6).toBe(true);
    let prev = -1;
    for (let x = 30; x <= 110; x += 2) {
      const f = bimodal.cdf(x);
      expect(f >= prev).toBe(true);
      prev = f;
    }
  });

  test('quantile inverts the cdf (round-trips)', () => {
    for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const q = bimodal.quantile(p);
      expect(approx(bimodal.cdf(q), p, 1e-6)).toBe(true);
    }
    // symmetric mixture → median at the center of mass
    expect(approx(bimodal.quantile(0.5), 70, 1e-4)).toBe(true);
  });

  test('sample mean/variance converge to the analytic moments', () => {
    const draws = bimodal.sample(200_000, new Rng(0x5eed));
    let s = 0;
    for (const d of draws) s += d;
    const mean = s / draws.length;
    let v = 0;
    for (const d of draws) v += (d - mean) ** 2;
    v /= draws.length;
    expect(approx(mean, 70, 0.2)).toBe(true);
    expect(approx(v, 125, 4)).toBe(true);
  });

  test('serialize / fromDTO round-trips', () => {
    const dto = bimodal.serialize();
    expect(dto.kind).toBe('mixture');
    expect(dto.components.length).toBe(2);
    const back = MixtureBelief.fromDTO(dto);
    expect(approx(back.mean(), bimodal.mean(), 1e-12)).toBe(true);
    expect(approx(back.variance(), bimodal.variance(), 1e-9)).toBe(true);
  });

  test('rejects degenerate construction', () => {
    expect(() => new MixtureBelief([])).toThrow();
    expect(() => new MixtureBelief([{ pi: 1, mu: 0, sigma2: 0 }])).toThrow();
    expect(() => new MixtureBelief([{ pi: 0, mu: 0, sigma2: 1 }])).toThrow(); // total weight 0
  });
});
