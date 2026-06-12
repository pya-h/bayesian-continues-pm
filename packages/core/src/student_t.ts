// StudentTBelief — a location-scale Student-t belief, Same μ as a
// Gaussian but **fat tails** controlled by ν (degrees of freedom): small ν → heavy
// tails (outliers stay plausible), ν → ∞ → Gaussian. Parameterized by (ν, μ, s²)
// where s is the *scale* (not the stddev); the variance is s²·ν/(ν−2).
// We require ν > 2 so the variance (used by reserve / stats / the integration
// window) is finite. Pricing of contracts under t has no general closed form, so
// `price` routes t through the `expectF` quadrature on the payoff.
// Self-contained numerics: lgamma (Lanczos), the regularized incomplete beta
// (for the CDF), and a Marsaglia–Tsang gamma sampler (for draws) live here so the
// shared numerics module stays Gaussian-focused.

import type { Rng } from './numerics.ts';
import type { BeliefModel, StudentTStateDTO } from './types.ts';

// special functions (local) ----------------------------------------------

const LANCZOS_G = 7;
const LANCZOS_C = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
] as const;

function lgamma(z: number): number {
  if (z < 0.5) {
    // reflection: Γ(z)Γ(1−z) = π/sin(πz)
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  }
  const x = z - 1;
  let a = LANCZOS_C[0] as number;
  const t = x + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_G + 2; i++) a += (LANCZOS_C[i] as number) / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}

function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

// Standard Student-t CDF for ANY df > 0 (no finite-variance restriction — callers
// like the truncated-moment identities in stats.ts need F_{ν−2} with ν−2 ≤ 2).
export function studentTCdfStd(df: number, x: number): number {
  const z = df / (df + x * x);
  const ib = 0.5 * betai(df / 2, 0.5, z);
  return x >= 0 ? 1 - ib : ib;
}

function gammaSample(shape: number, rng: Rng): number {
  if (shape < 1) {
    const u = rng.nextOpen();
    return gammaSample(shape + 1, rng) * u ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = rng.nextNormal();
    let v = 1 + c * x;
    if (v <= 0) continue;
    v = v * v * v;
    const u = rng.nextOpen();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

// belief ------------------------------------------------------------------

export class StudentTBelief implements BeliefModel {
  readonly kind = 'student_t' as const;
  readonly nu: number;
  readonly mu: number;
  // Squared SCALE parameter s² (not the variance). variance = s²·ν/(ν−2).
  readonly scale2: number;

  constructor(nu: number, mu: number, scale2: number) {
    if (!(nu > 2) || !Number.isFinite(nu)) {
      throw new Error(`StudentTBelief: ν must be > 2 (finite variance), got ${nu}`);
    }
    if (!(scale2 > 0) || !Number.isFinite(scale2)) {
      throw new Error(`StudentTBelief: scale² must be > 0 and finite, got ${scale2}`);
    }
    if (!Number.isFinite(mu)) throw new Error(`StudentTBelief: μ must be finite, got ${mu}`);
    this.nu = nu;
    this.mu = mu;
    this.scale2 = scale2;
  }

  // Build from a desired variance (converts variance → scale² via ν/(ν−2)).
  static fromVariance(nu: number, mu: number, variance: number): StudentTBelief {
    if (!(nu > 2)) throw new Error(`StudentTBelief.fromVariance: ν must be > 2, got ${nu}`);
    return new StudentTBelief(nu, mu, (variance * (nu - 2)) / nu);
  }

  private scale(): number {
    return Math.sqrt(this.scale2);
  }

  mean(): number {
    return this.mu;
  }

  variance(): number {
    return (this.scale2 * this.nu) / (this.nu - 2);
  }

  stddev(): number {
    return Math.sqrt(this.variance());
  }

  pdf(theta: number): number {
    const s = this.scale();
    const x = (theta - this.mu) / s;
    const logC =
      lgamma((this.nu + 1) / 2) -
      lgamma(this.nu / 2) -
      0.5 * Math.log(this.nu * Math.PI) -
      Math.log(s);
    return Math.exp(logC) * (1 + (x * x) / this.nu) ** (-(this.nu + 1) / 2);
  }

  cdf(theta: number): number {
    const t = (theta - this.mu) / this.scale();
    const x = this.nu / (this.nu + t * t);
    const ib = 0.5 * betai(this.nu / 2, 0.5, x);
    return t >= 0 ? 1 - ib : ib;
  }

  quantile(p: number): number {
    if (p <= 0) return Number.NEGATIVE_INFINITY;
    if (p >= 1) return Number.POSITIVE_INFINITY;
    // cdf is continuous and strictly increasing → bisect. The tails are polynomial
    // so no fixed ±k·sd bracket is safe in the extremes (for ν→2 the quantile/sd
    // ratio outgrows any constant); expand geometrically until the bracket holds p.
    const sd = this.stddev();
    let lo = this.mu - 60 * sd;
    let hi = this.mu + 60 * sd;
    for (let span = 60 * sd; this.cdf(hi) < p && Number.isFinite(hi); span *= 4) {
      hi = this.mu + span * 4;
    }
    for (let span = 60 * sd; this.cdf(lo) > p && Number.isFinite(lo); span *= 4) {
      lo = this.mu - span * 4;
    }
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (this.cdf(mid) < p) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  sample(n: number, rng: Rng): number[] {
    const s = this.scale();
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const z = rng.nextNormal();
      // χ²_ν = Gamma(ν/2, scale 2); standard t = Z / √(χ²_ν / ν).
      const chi2 = gammaSample(this.nu / 2, rng) * 2;
      const tStd = z / Math.sqrt(chi2 / this.nu);
      out[i] = this.mu + s * tStd;
    }
    return out;
  }

  static fromDTO(dto: StudentTStateDTO): StudentTBelief {
    return new StudentTBelief(dto.nu, dto.mu, dto.scale2);
  }

  serialize(): StudentTStateDTO {
    return { kind: 'student_t', nu: this.nu, mu: this.mu, scale2: this.scale2 };
  }
}
