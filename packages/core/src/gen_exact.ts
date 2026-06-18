// GenExactBelief — the max-entropy `exp(−poly)` belief (multi-model refactor
// Gen·exact ). Density
// p(θ) = exp(−E(u)) / (σ·Z), u = (θ−μ)/σ
// E(u) = ½λ₂u² + λ₃u³ + λ₄u⁴ + λ₆u⁶
// is the least-committal (maximum-entropy) shape matching a handful of moments
// dialled by the exponent coefficients: λ₂ → Gaussian, +λ₃ → skew, +λ₄>0 →
// thinner tails / flat-top, λ₂<0 → bimodal. The **auto-stabiliser**
// λ₆ = 0.004 + 0.06·max(0,−λ₄) + 0.03·|λ₃|
// adds just enough confining u⁶ curvature that the density is *always* integrable
// (tails decay) and skew can't drag the mean off — so any finite (λ₂,λ₃,λ₄) is a
// valid belief. This is the exact formula prototyped and MC-checked in the math
// sandbox, ported faithfully.
// There is no closed-form normaliser, so `Z`, the mean and the variance are cached
// in the constructor via **fixed composite-Simpson** over the standardised window
// `u ∈ [−L, L]` (L=7), with a **min-energy shift** (subtract Eₘᵢₙ before `exp`) for
// numerical stability — every exponent is then ≤ 0, so nothing overflows however
// extreme the λ's. The CDF/quantile/sample share a cumulative table over the same
// grid (inverse-CDF, deterministic) so the reserve Monte-Carlo and stats work
// unchanged. Pricing routes through the `expectF` quadrature (no closed form)
// see pricing.ts.

import type { Rng } from './numerics.ts';
import type { BeliefModel, GenExactMoments, GenExactStateDTO } from './types.ts';

export const GEN_EXACT_L = 7;
// Composite-Simpson node count over [−L, L] (must be even).
export const GEN_EXACT_NODES = 2000;

// Confining u⁶ coefficient. A small floor (0.004) keeps even a pure-Gaussian shape
// integrable; the `−λ₄` term restores decay when λ₄<0 (which would otherwise make
// u⁴ open downward), and the `|λ₃|` term stops a large skew dragging the mean to
// the tail. Identical to the sandbox `maxEnt` stabiliser.
export function genExactLambda6(lam3: number, lam4: number): number {
  return 0.004 + 0.06 * Math.max(0, -lam4) + 0.03 * Math.abs(lam3);
}

// The standardised exponent E(u) = ½λ₂u² + λ₃u³ + λ₄u⁴ + λ₆u⁶.
function genExactEnergy(u: number, l2: number, l3: number, l4: number, l6: number): number {
  const u2 = u * u;
  return 0.5 * l2 * u2 + l3 * u2 * u + l4 * u2 * u2 + l6 * u2 * u2 * u2;
}

// Compute the standardised moments {emin, z, E[u], E[u²]} of a Gen·exact shape via
// fixed composite-Simpson over u ∈ [−L, L] with a min-energy shift. These depend
// only on the λ tuple (location/scale-invariant) — the basis of the I3 cache.
export function genExactStandardisedMoments(
  lambdas: readonly [number, number, number],
): GenExactMoments {
  const [l2, l3, l4] = lambdas;
  const l6 = genExactLambda6(l3, l4);
  const L = GEN_EXACT_L;
  const N = GEN_EXACT_NODES;
  const h = (2 * L) / N;

  // 1. Min-energy shift: largest exp argument is then 0, so nothing overflows.
  let emin = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= N; i++) {
    const e = genExactEnergy(-L + i * h, l2, l3, l4, l6);
    if (e < emin) emin = e;
  }

  // 2. Composite Simpson for Z, E[u], E[u²] (w_i = exp(−(E(u_i) − Eₘᵢₙ))).
  let zS = 0;
  let m1S = 0;
  let m2S = 0;
  for (let i = 0; i <= N; i++) {
    const u = -L + i * h;
    const w = Math.exp(-(genExactEnergy(u, l2, l3, l4, l6) - emin));
    const sw = i === 0 || i === N ? 1 : i % 2 ? 4 : 2;
    zS += sw * w;
    m1S += sw * w * u;
    m2S += sw * w * u * u;
  }
  const z = (zS * h) / 3;
  return { emin, z, eu: (m1S * h) / 3 / z, eu2: (m2S * h) / 3 / z };
}

// Standardised shape statistics of a Gen·exact density (skew/kurtosis are λ-only).
export interface GenExactShapeStats {
  eu: number;
  // Var[u] — standardised variance (the σ↔belief-variance bridge).
  varU: number;
  // Skewness γ₁ = μ₃/μ₂^{3/2} (note: λ₃>0 ⇒ negative skew).
  skew: number;
  // Excess kurtosis γ₂ = μ₄/μ₂² − 3.
  exKurt: number;
}

// Standardised central-moment statistics (E[u], Var[u], skewness, excess kurtosis)
// of a Gen·exact shape — a pure function of λ, used by the v2 moment-projection
// update (I4) to fit (λ₃,λ₄) to a target skew/kurtosis. Same fixed Simpson grid as
// {@link genExactStandardisedMoments}, extended to the 3rd/4th raw moments.
export function genExactShapeStats(lambdas: readonly [number, number, number]): GenExactShapeStats {
  const [l2, l3, l4] = lambdas;
  const l6 = genExactLambda6(l3, l4);
  const L = GEN_EXACT_L;
  const N = GEN_EXACT_NODES;
  const h = (2 * L) / N;

  let emin = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= N; i++) {
    const e = genExactEnergy(-L + i * h, l2, l3, l4, l6);
    if (e < emin) emin = e;
  }

  let zS = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  for (let i = 0; i <= N; i++) {
    const u = -L + i * h;
    const w = Math.exp(-(genExactEnergy(u, l2, l3, l4, l6) - emin));
    const sw = i === 0 || i === N ? 1 : i % 2 ? 4 : 2;
    const wu = w * u;
    zS += sw * w;
    s1 += sw * wu;
    s2 += sw * wu * u;
    s3 += sw * wu * u * u;
    s4 += sw * wu * u * u * u;
  }
  // Raw standardised moments (the h/3 Simpson factor cancels in every ratio).
  const e1 = s1 / zS;
  const e2 = s2 / zS;
  const e3 = s3 / zS;
  const e4 = s4 / zS;
  const m2 = Math.max(1e-12, e2 - e1 * e1);
  const m3 = e3 - 3 * e1 * e2 + 2 * e1 * e1 * e1;
  const m4 = e4 - 4 * e1 * e3 + 6 * e1 * e1 * e2 - 3 * e1 * e1 * e1 * e1;
  return { eu: e1, varU: m2, skew: m3 / m2 ** 1.5, exKurt: m4 / (m2 * m2) - 3 };
}

function validMoments(m: GenExactMoments | undefined): m is GenExactMoments {
  return (
    !!m &&
    Number.isFinite(m.emin) &&
    Number.isFinite(m.z) &&
    m.z > 0 &&
    Number.isFinite(m.eu) &&
    Number.isFinite(m.eu2)
  );
}

export class GenExactBelief implements BeliefModel {
  readonly kind = 'gen_exact' as const;
  readonly mu: number;
  readonly sigma: number;
  // The exponent shape coefficients [λ₂, λ₃, λ₄] (λ₆ is derived).
  readonly lambdas: readonly [number, number, number];
  // Derived confining coefficient (not persisted; recomputed from λ₃,λ₄).
  readonly lambda6: number;

  // cached numerics ---
  // Standardised moments {emin, z, E[u], E[u²]} — λ-only, persistable (I3).
  readonly moments: GenExactMoments;
  private readonly emin: number; // min energy over the grid (the shift)
  private readonly zNorm: number; // ∫ exp(−(E−Eₘᵢₙ)) du over [−L,L]
  private readonly meanCache: number;
  private readonly varianceCache: number;
  private readonly hStep: number; // grid spacing 2L/N
  // The cumulative-mass table (for cdf/quantile/sample) is built lazily on first
  // use — pure-pricing reads (mean/pdf) never pay for it, which is the I3 win.
  private cdfGridCache: Float64Array | null = null;

  // valid object is supplied the normalisation quadrature is skipped; otherwise
  // it is computed. Stale/non-finite caches are ignored and recomputed.
  constructor(
    mu: number,
    sigma: number,
    lambdas: readonly [number, number, number],
    moments?: GenExactMoments,
  ) {
    if (!Number.isFinite(mu)) throw new Error(`GenExactBelief: μ must be finite, got ${mu}`);
    if (!(sigma > 0) || !Number.isFinite(sigma)) {
      throw new Error(`GenExactBelief: σ must be > 0 and finite, got ${sigma}`);
    }
    const [l2, l3, l4] = lambdas;
    if (!Number.isFinite(l2) || !Number.isFinite(l3) || !Number.isFinite(l4)) {
      throw new Error(`GenExactBelief: λ's must be finite, got [${l2}, ${l3}, ${l4}]`);
    }
    this.mu = mu;
    this.sigma = sigma;
    this.lambdas = [l2, l3, l4];
    this.lambda6 = genExactLambda6(l3, l4);
    this.hStep = (2 * GEN_EXACT_L) / GEN_EXACT_NODES;

    const m = validMoments(moments) ? moments : genExactStandardisedMoments(this.lambdas);
    this.moments = m;
    this.emin = m.emin;
    this.zNorm = m.z;
    this.meanCache = mu + sigma * m.eu;
    this.varianceCache = sigma * sigma * Math.max(1e-9, m.eu2 - m.eu * m.eu);
  }

  // The exponent E(u) = ½λ₂u² + λ₃u³ + λ₄u⁴ + λ₆u⁶.
  private energy(u: number): number {
    const [l2, l3, l4] = this.lambdas;
    return genExactEnergy(u, l2, l3, l4, this.lambda6);
  }

  // Cumulative-mass table over the standardised grid, normalised to end at 1 — a
  // monotone CDF in [0,1]. Built once, lazily (cdf/quantile/sample need it; pure
  // pricing does not).
  private get cdfGrid(): Float64Array {
    if (this.cdfGridCache !== null) return this.cdfGridCache;
    const L = GEN_EXACT_L;
    const N = GEN_EXACT_NODES;
    const h = this.hStep;
    const cum = new Float64Array(N + 1);
    let wPrev = 0;
    for (let i = 0; i <= N; i++) {
      const w = Math.exp(-(this.energy(-L + i * h) - this.emin));
      if (i === 0) cum[i] = 0;
      else cum[i] = (cum[i - 1] as number) + 0.5 * (wPrev + w) * h; // trapezoid
      wPrev = w;
    }
    const total = cum[N] as number;
    for (let i = 0; i <= N; i++) cum[i] = (cum[i] as number) / total;
    this.cdfGridCache = cum;
    return cum;
  }

  mean(): number {
    return this.meanCache;
  }

  variance(): number {
    return this.varianceCache;
  }

  stddev(): number {
    return Math.sqrt(this.varianceCache);
  }

  pdf(theta: number): number {
    const u = (theta - this.mu) / this.sigma;
    if (Math.abs(u) > GEN_EXACT_L) return 0; // outside the standardised support
    return Math.exp(-(this.energy(u) - this.emin)) / (this.sigma * this.zNorm);
  }

  cdf(theta: number): number {
    const u = (theta - this.mu) / this.sigma;
    if (u <= -GEN_EXACT_L) return 0;
    if (u >= GEN_EXACT_L) return 1;
    // Linear-interpolate the cumulative grid (monotone by construction).
    const t = (u + GEN_EXACT_L) / this.hStep;
    const i = Math.floor(t);
    if (i >= GEN_EXACT_NODES) return 1;
    const frac = t - i;
    const c0 = this.cdfGrid[i] as number;
    const c1 = this.cdfGrid[i + 1] as number;
    return c0 * (1 - frac) + c1 * frac;
  }

  quantile(p: number): number {
    // Bounded support: clamp to the window edges at the extremes.
    if (p <= 0) return this.mu - GEN_EXACT_L * this.sigma;
    if (p >= 1) return this.mu + GEN_EXACT_L * this.sigma;
    // Binary-search the monotone cumulative grid, then interpolate the node index.
    const g = this.cdfGrid;
    let lo = 0;
    let hi = GEN_EXACT_NODES;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((g[mid] as number) <= p) lo = mid;
      else hi = mid;
    }
    const c0 = g[lo] as number;
    const c1 = g[hi] as number;
    const frac = c1 > c0 ? (p - c0) / (c1 - c0) : 0;
    const u = -GEN_EXACT_L + (lo + frac) * this.hStep;
    return this.mu + this.sigma * u;
  }

  sample(n: number, rng: Rng): number[] {
    // Inverse-CDF — deterministic given the rng stream (needed for MC reserve).
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = this.quantile(rng.nextOpen());
    return out;
  }

  static fromDTO(dto: GenExactStateDTO): GenExactBelief {
    return new GenExactBelief(dto.mu, dto.sigma, dto.lambdas, dto.moments);
  }

  serialize(): GenExactStateDTO {
    const [l2, l3, l4] = this.lambdas;
    const { emin, z, eu, eu2 } = this.moments;
    return {
      kind: 'gen_exact',
      mu: this.mu,
      sigma: this.sigma,
      lambdas: [l2, l3, l4],
      moments: { emin, z, eu, eu2 },
    };
  }
}
