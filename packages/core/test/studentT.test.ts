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

describe('Student-t closed-form pricing (REVIEW-FINDINGS C1/C10)', () => {
  // Low ν + sd=20 is exactly the regime where the old ±10σ quadrature under-priced
  // CALL/PUT by 2–8% and the jump-payoff cell noise wrecked dPriceDMu.
  const t = StudentTBelief.fromVariance(3, 100, 400);

  test('binary/spread prices are exactly the cdf identities', () => {
    expect(price({ type: 'BINARY_CALL', strike: 110 }, t)).toBe(1 - t.cdf(110));
    expect(price({ type: 'BINARY_PUT', strike: 110 }, t)).toBe(t.cdf(110));
    expect(price({ type: 'SPREAD', lower: 95, upper: 105 }, t)).toBe(t.cdf(105) - t.cdf(95));
  });

  test('CALL matches the analytic E[(X−K)+] reference and converged quadrature', () => {
    // exact: s·[f_std(d)·(ν+d²)/(ν−1) − d·(1−F_std(d))], independently re-derived
    const K = 110;
    const s = Math.sqrt(t.scale2);
    const d = (K - t.mu) / s;
    const exact = s * (s * t.pdf(K) * ((t.nu + d * d) / (t.nu - 1)) - d * (1 - t.cdf(K)));
    const got = price({ type: 'CALL', strike: K }, t);
    expect(approx(got, exact, 1e-12)).toBe(true);
    // old quadrature gave ≈2.781 here (−2.1%); the converged value is ≈2.8418
    expect(approx(got, 2.8418, 2e-3)).toBe(true);
  });

  test('put-call parity holds at low ν: call − put = μ − K', () => {
    for (const K of [80, 100, 110, 130]) {
      const c = price({ type: 'CALL', strike: K }, t);
      const p = price({ type: 'PUT', strike: K }, t);
      expect(approx(c - p, t.mu - K, 1e-9)).toBe(true);
    }
  });

  test('dPriceDMu matches a fine central difference of the (exact) price', () => {
    const h = 1e-5;
    const specs: ContractSpec[] = [
      { type: 'CALL', strike: 108 },
      { type: 'PUT', strike: 92 },
      { type: 'BINARY_CALL', strike: 99.25 },
      { type: 'BINARY_PUT', strike: 104 },
      { type: 'SPREAD', lower: 95, upper: 105 },
    ];
    for (const spec of specs) {
      const up = price(spec, new StudentTBelief(t.nu, t.mu + h, t.scale2));
      const dn = price(spec, new StudentTBelief(t.nu, t.mu - h, t.scale2));
      const numeric = (up - dn) / (2 * h);
      expect(approx(dPriceDMu(spec, t), numeric, 1e-6)).toBe(true);
    }
  });

  test('binary dPriceDMu is the t pdf at the strike (location-family identity)', () => {
    expect(dPriceDMu({ type: 'BINARY_CALL', strike: 110 }, t)).toBe(t.pdf(110));
    expect(dPriceDMu({ type: 'BINARY_PUT', strike: 110 }, t)).toBe(-t.pdf(110));
  });

  test('quantile round-trips in the extreme tails (REVIEW-FINDINGS C21)', () => {
    // polynomial tails: the old fixed ±60·sd bracket clipped p beyond ~1−1e-6 at ν=3
    for (const p of [1e-9, 1e-7, 1 - 1e-7, 1 - 1e-9]) {
      const q = t.quantile(p);
      expect(Number.isFinite(q)).toBe(true);
      expect(approx(t.cdf(q), p, Math.max(1e-12, p * 1e-6))).toBe(true);
    }
  });

  test('GAUSSIAN bell payoff is bell-window-accurate, not ±10σ-truncated (C42)', () => {
    // ν=3, μ=0, variance=100 ⇒ sd=10. Wide+fine reference over a window that surely
    // covers both the bell and the belief, integrating g(θ)·pdf(θ).
    const tg = new StudentTBelief(3, 0, 100 / 3);
    const sd = tg.stddev();
    const ref = (c: number, w: number, sq = false) => {
      const lo = Math.min(tg.mu - 80 * sd, c - 60 * w);
      const hi = Math.max(tg.mu + 80 * sd, c + 60 * w);
      const N = 2_000_000;
      const h = (hi - lo) / N;
      let s = 0;
      for (let i = 0; i <= N; i++) {
        const x = lo + i * h;
        let g = Math.exp(-((x - c) ** 2) / (2 * w * w));
        if (sq) g *= g;
        s += (i === 0 || i === N ? 1 : i % 2 ? 4 : 2) * g * tg.pdf(x);
      }
      return (s * h) / 3;
    };
    // Far center (15σ away) was priced ≈0 (−100%) by the old ±10σ window; narrow
    // width (σ/400) was off −18% (bell inside one Simpson cell). Now exact.
    for (const [c, w] of [
      [0, 10],
      [11 * sd, 10],
      [15 * sd, 10],
      [0, sd / 400],
    ] as [number, number][]) {
      const spec: ContractSpec = { type: 'GAUSSIAN', center: c, width: w };
      const got = price(spec, tg);
      expect(approx(got, ref(c, w), Math.abs(ref(c, w)) * 1e-4 + 1e-12)).toBe(true);
    }
    // Generous explicit timeout: the 2M-node reference integral above is deliberately
    // heavy and can exceed bun's 5s default when the full parallel suite saturates the
    // CPU (the assertion itself is fast + deterministic). Prevents a CI-load flake.
  }, 30000);
});
