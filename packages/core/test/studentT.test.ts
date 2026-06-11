import { describe, expect, test } from 'bun:test';
import { payoff } from '../src/contracts.ts';
import { GaussianBelief } from '../src/gaussian.ts';
import { Rng } from '../src/numerics.ts';
import { dPriceDMu, price } from '../src/pricing.ts';
import { StudentTBelief } from '../src/student_t.ts';
import type { ContractSpec } from '../src/types.ts';

const approx = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

describe('StudentTBelief — BeliefModel contract (V2-1)', () => {
  const t = new StudentTBelief(5, 100, 16); // ν=5, μ=100, scale²=16 (scale=4)

  test('mean = μ; variance = s²·ν/(ν−2)', () => {
    expect(t.mean()).toBe(100);
    expect(approx(t.variance(), (16 * 5) / 3, 1e-9)).toBe(true);
  });

  test('fromVariance round-trips to the requested variance', () => {
    const b = StudentTBelief.fromVariance(6, 50, 100);
    expect(approx(b.variance(), 100, 1e-9)).toBe(true);
  });

  test('pdf integrates to 1 and is symmetric about μ', () => {
    let area = 0;
    const dx = 0.02;
    for (let x = 100 - 80; x < 100 + 80; x += dx) area += t.pdf(x) * dx;
    expect(approx(area, 1, 1e-3)).toBe(true);
    expect(approx(t.pdf(100 - 7), t.pdf(100 + 7), 1e-12)).toBe(true);
  });

  test('cdf: 0.5 at μ, monotone, →0/→1 in the tails', () => {
    expect(approx(t.cdf(100), 0.5, 1e-9)).toBe(true);
    expect(t.cdf(100 - 200) < 1e-4).toBe(true);
    expect(t.cdf(100 + 200) > 1 - 1e-4).toBe(true);
    let prev = -1;
    for (let x = 40; x <= 160; x += 4) {
      const f = t.cdf(x);
      expect(f >= prev).toBe(true);
      prev = f;
    }
  });

  test('cdf matches a known standardized t value (ν=5)', () => {
    // Standard t_5 CDF at x=2 ≈ 0.9490303. Here x=(θ−μ)/scale=2 → θ=108.
    expect(approx(t.cdf(108), 0.9490303, 1e-5)).toBe(true);
  });

  test('quantile inverts the cdf', () => {
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(approx(t.cdf(t.quantile(p)), p, 1e-6)).toBe(true);
    }
    expect(approx(t.quantile(0.5), 100, 1e-4)).toBe(true);
  });

  test('fatter tails than a Gaussian of the same variance', () => {
    const g = new GaussianBelief(100, t.variance());
    // far in the tail, the t assigns more mass
    expect(t.pdf(100 + 5 * t.stddev()) > g.pdf(100 + 5 * t.stddev())).toBe(true);
  });

  test('sample mean/variance converge to the analytic moments', () => {
    const draws = t.sample(300_000, new Rng(0x7));
    let s = 0;
    for (const d of draws) s += d;
    const mean = s / draws.length;
    let v = 0;
    for (const d of draws) v += (d - mean) ** 2;
    v /= draws.length;
    expect(approx(mean, 100, 0.1)).toBe(true);
    expect(approx(v, t.variance(), t.variance() * 0.08)).toBe(true);
  });

  test('serialize / fromDTO round-trips', () => {
    const dto = t.serialize();
    expect(dto.kind).toBe('student_t');
    const back = StudentTBelief.fromDTO(dto);
    expect(back.nu).toBe(5);
    expect(approx(back.variance(), t.variance(), 1e-9)).toBe(true);
  });

  test('rejects ν ≤ 2 (infinite variance) and bad scale', () => {
    expect(() => new StudentTBelief(2, 0, 1)).toThrow();
    expect(() => new StudentTBelief(5, 0, 0)).toThrow();
  });
});

describe('Student-t pricing via quadrature fallback (V2-1)', () => {
  const t = new StudentTBelief(6, 65000, 4000 ** 2);
  const specs: ContractSpec[] = [
    { type: 'LINEAR' },
    { type: 'CALL', strike: 70000 },
    { type: 'BINARY_CALL', strike: 68000 },
    { type: 'SPREAD', lower: 60000, upper: 72000 },
  ];

  test('price matches a Monte-Carlo estimate of E[payoff]', () => {
    const draws = t.sample(500_000, new Rng(0x1234));
    for (const spec of specs) {
      let s = 0;
      for (const d of draws) s += payoff(spec, d);
      const mc = s / draws.length;
      const closed = price(spec, t);
      const tol = Math.max(0.01, Math.abs(closed) * 0.03);
      expect(approx(closed, mc, tol)).toBe(true);
    }
  });

  test('LINEAR price = μ', () => {
    expect(approx(price({ type: 'LINEAR' }, t), 65000, 1)).toBe(true);
  });

  test('dPriceDMu is finite and sane (binary-call sensitivity > 0)', () => {
    const d = dPriceDMu({ type: 'BINARY_CALL', strike: 65000 }, t);
    expect(Number.isFinite(d)).toBe(true);
    expect(d > 0).toBe(true); // raising μ raises P(θ > strike)
  });
});
