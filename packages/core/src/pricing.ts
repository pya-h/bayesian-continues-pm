// Pricing — fair price E_p[f(θ)] for each contract under a Gaussian belief.
// Closed forms, plus ∂Price/∂μ for the
// adverse-selection spread term, and a fixed composite-Simpson fallback for the
// general E_p[g(θ)] used by stats / future custom payoffs.

import { payoff } from './contracts.ts';
import { GenExactBelief } from './gen_exact.ts';
import type { MixtureBelief } from './mixture.ts';
import { Phi, phi } from './numerics.ts';
import { StudentTBelief } from './student_t.ts';
import type { BeliefModel, ContractSpec } from './types.ts';

// Closed-form price of a Gaussian-payoff contract exp(-(θ-c)²/(2w²)).
export function priceGaussianPayoff(c: number, w: number, mu: number, sigma2: number): number {
  const w2 = w * w;
  const denom = w2 + sigma2;
  return Math.sqrt(w2 / denom) * Math.exp(-((c - mu) ** 2) / (2 * denom));
}

// Closed-form price of an asymmetric (skew) bell — width `wL` below the center
// `wR` above — under a single Gaussian N(μ,σ²). Each side is the full-line bell
// price `priceGaussianPayoff` scaled by the truncation factor `P(Y ≷ c)`, where
// Y is the (normalised) product of the bell and the belief: Y ~ N(m, s²) with
// precision τ = 1/w² + 1/σ². So the half-line integral is exact, no quadrature.
function priceSkewGaussian(c: number, wL: number, wR: number, mu: number, sigma2: number): number {
  const half = (w: number, left: boolean): number => {
    const w2 = w * w;
    const tau = 1 / w2 + 1 / sigma2;
    const s = Math.sqrt(1 / tau);
    const m = (c / w2 + mu / sigma2) / tau;
    const z = (c - m) / s; // P(Y ≤ c) = Φ(z)
    const trunc = left ? Phi(z) : 1 - Phi(z);
    return priceGaussianPayoff(c, w, mu, sigma2) * trunc;
  };
  return half(wL, true) + half(wR, false);
}

// Fair price of a contract under a SINGLE Gaussian N(μ, σ²).
function priceUnderGaussian(spec: ContractSpec, mu: number, sigma2: number): number {
  const sigma = Math.sqrt(sigma2);
  switch (spec.type) {
    case 'LINEAR':
      return mu;
    case 'CALL': {
      const K = spec.strike as number;
      const d = (mu - K) / sigma;
      return sigma * phi(d) + (mu - K) * Phi(d);
    }
    case 'PUT': {
      const K = spec.strike as number;
      const d = (mu - K) / sigma;
      return sigma * phi(d) - (mu - K) * Phi(-d);
    }
    case 'BINARY_CALL':
      return Phi((mu - (spec.strike as number)) / sigma);
    case 'BINARY_PUT':
      return Phi(((spec.strike as number) - mu) / sigma);
    case 'SPREAD': {
      const a = spec.lower as number;
      const b = spec.upper as number;
      return Phi((b - mu) / sigma) - Phi((a - mu) / sigma);
    }
    case 'GAUSSIAN':
      return priceGaussianPayoff(spec.center as number, spec.width as number, mu, sigma2);
    case 'SKEW_GAUSSIAN':
      return priceSkewGaussian(
        spec.center as number,
        spec.widthLeft as number,
        spec.widthRight as number,
        mu,
        sigma2,
      );
    default:
      throw new Error(`price: unknown contract type ${(spec as ContractSpec).type}`);
  }
}

// E[exp(-(θ-c)²/(2·bw²))] under an arbitrary belief — the GAUSSIAN "bell" payoff
// (and, with bw = w/√2, its square for the second moment) integrated robustly.
// The plain `expectF` window (mean ± L·σ, fixed node count) silently mis-prices the
// bell two ways: a center far from the belief mean (|c − μ| ≳ L·σ) falls outside the
// window and is priced ≈0, and a width narrower than the cell size (w ≲ σ/200) lands
// inside one Simpson cell. The bell bounds the integrand's support to [c ± L·bw], so
// the window must cover BOTH the bell and the belief and the node count must resolve
// the NARROWER of the two scales. Exact to machine precision across both regimes
// the node cap keeps the contrived far-AND-narrow
// corner bounded rather than exploding the cost.
function expectGaussianBump(belief: BeliefModel, c: number, bw: number): number {
  const mean = belief.mean();
  const sigma = belief.stddev();
  const L = 12;
  const lo = Math.min(mean - L * sigma, c - L * bw);
  const hi = Math.max(mean + L * sigma, c + L * bw);
  const feature = Math.max(Math.min(sigma, bw), 1e-300); // narrowest scale to resolve
  let n = Math.ceil((hi - lo) / (feature / 24));
  n = Math.min(Math.max(n, 4000), 200_000);
  if (n % 2 === 1) n += 1;
  const h = (hi - lo) / n;
  const ig = (x: number) => Math.exp(-((x - c) ** 2) / (2 * bw * bw)) * belief.pdf(x);
  let sum = ig(lo) + ig(hi);
  for (let i = 1; i < n; i++) sum += (i % 2 === 0 ? 2 : 4) * ig(lo + i * h);
  return (sum * h) / 3;
}

// E[(GAUSSIAN payoff)²] under a belief — the square is a bell of width w/√2.
export function expectGaussianBumpSquared(belief: BeliefModel, c: number, w: number): number {
  return expectGaussianBump(belief, c, w / Math.SQRT2);
}

// E[fn(θ)] under any belief via a feature-aware composite-Simpson window — the
// generalisation of `expectGaussianBump` to an arbitrary localized integrand
// (the SIGMOID and the quadrature path of SKEW_GAUSSIAN). The window covers BOTH
// the belief (mean ± L·σ) and the contract feature (center ± L·feature), and the
// node count resolves the NARROWER of the two scales — so a far or narrow feature
// is neither missed nor under-sampled. Use only for SMOOTH/bounded integrands.
function expectFeature(
  belief: BeliefModel,
  fn: (theta: number) => number,
  center: number,
  feature: number,
): number {
  const mean = belief.mean();
  const sigma = belief.stddev();
  const L = 12;
  const lo = Math.min(mean - L * sigma, center - L * feature);
  const hi = Math.max(mean + L * sigma, center + L * feature);
  const scale = Math.max(Math.min(sigma, feature), 1e-300);
  let n = Math.ceil((hi - lo) / (scale / 24));
  n = Math.min(Math.max(n, 4000), 200_000);
  if (n % 2 === 1) n += 1;
  const h = (hi - lo) / n;
  const ig = (x: number) => fn(x) * belief.pdf(x);
  let sum = ig(lo) + ig(hi);
  for (let i = 1; i < n; i++) sum += (i % 2 === 0 ? 2 : 4) * ig(lo + i * h);
  return (sum * h) / 3;
}

// TENT and TRAPEZOID are exact linear combinations of CALL ramps, so they price
// closed-form under EVERY belief kind by reusing `price(CALL)`
// tent(θ) = (1/w)[ R(c−w) − 2R(c) + R(c+w) ] (R = CALL ramp)
// trap(θ) = (1/w)[ R(a−w) − R(a) − R(b) + R(b+w) ]
// No new per-kind math, exact wherever CALL is exact.
function tentPrice(spec: ContractSpec, belief: BeliefModel): number {
  const c = spec.center as number;
  const w = spec.width as number;
  const call = (K: number) => price({ type: 'CALL', strike: K }, belief);
  return (call(c - w) - 2 * call(c) + call(c + w)) / w;
}

function trapezoidPrice(spec: ContractSpec, belief: BeliefModel): number {
  const a = spec.lower as number;
  const b = spec.upper as number;
  const w = spec.width as number;
  const call = (K: number) => price({ type: 'CALL', strike: K }, belief);
  return (call(a - w) - call(a) - call(b) + call(b + w)) / w;
}

// Fair price under a Student-t(ν, μ, s²) belief — closed forms via the t pdf/cdf.
// Quadrature is wrong for t on both payoff families: binaries/spreads put the jump
// inside a Simpson cell (O(h) error that the central-difference ∂P/∂μ then amplifies
// to ±100%+), and unbounded CALL/PUT keep accumulating polynomial-tail mass past any
// finite window (−2% at ν=3 to −16% at ν=2.1). CALL uses
// E[(X−K)+] = s²·pdf(K)·(ν+d²)/(ν−1) − (K−μ)·(1−F(K)), d=(K−μ)/s (valid for ν>1
// we require ν>2); PUT follows by parity. The smooth GAUSSIAN payoff has no closed
// form under t, so it integrates numerically — but via the bell-aware window above
// not the plain ±L·σ one.
function priceUnderStudentT(spec: ContractSpec, t: StudentTBelief): number {
  switch (spec.type) {
    case 'LINEAR':
      return t.mu;
    case 'CALL':
    case 'PUT': {
      const K = spec.strike as number;
      const s = Math.sqrt(t.scale2);
      const d = (K - t.mu) / s;
      const call =
        t.scale2 * t.pdf(K) * ((t.nu + d * d) / (t.nu - 1)) - (K - t.mu) * (1 - t.cdf(K));
      return spec.type === 'CALL' ? call : call - (t.mu - K);
    }
    case 'BINARY_CALL':
      return 1 - t.cdf(spec.strike as number);
    case 'BINARY_PUT':
      return t.cdf(spec.strike as number);
    case 'SPREAD':
      return t.cdf(spec.upper as number) - t.cdf(spec.lower as number);
    case 'GAUSSIAN':
      return expectGaussianBump(t, spec.center as number, spec.width as number);
    default:
      return expectF((x) => payoff(spec, x), t);
  }
}

// Fair price under a Gen·exact (max-entropy exp(−poly)) belief. No closed form for
// the exp-poly density, so the smooth payoffs (CALL/PUT/GAUSSIAN) integrate via the
// bell-aware / general quadrature. The jump/step payoffs (BINARY/SPREAD) are priced
// from the belief's own CDF instead of quadrature — routing a discontinuity through
// Simpson gives O(h) error that the central-difference ∂P/∂μ would then amplify
// .
function priceUnderGenExact(spec: ContractSpec, b: GenExactBelief): number {
  switch (spec.type) {
    case 'LINEAR':
      return b.mean();
    case 'BINARY_CALL':
      return 1 - b.cdf(spec.strike as number);
    case 'BINARY_PUT':
      return b.cdf(spec.strike as number);
    case 'SPREAD':
      return b.cdf(spec.upper as number) - b.cdf(spec.lower as number);
    case 'GAUSSIAN':
      return expectGaussianBump(b, spec.center as number, spec.width as number);
    default:
      // CALL / PUT — continuous payoffs, integrate the payoff (O(h²)).
      return expectF((t) => payoff(spec, t), b);
  }
}

// ∂Price/∂μ under a SINGLE Gaussian N(μ, σ²).
function dPriceDMuUnderGaussian(spec: ContractSpec, mu: number, sigma2: number): number {
  const sigma = Math.sqrt(sigma2);
  switch (spec.type) {
    case 'LINEAR':
      return 1;
    case 'CALL':
      return Phi((mu - (spec.strike as number)) / sigma);
    case 'PUT':
      return -Phi(((spec.strike as number) - mu) / sigma);
    case 'BINARY_CALL':
      return phi((mu - (spec.strike as number)) / sigma) / sigma;
    case 'BINARY_PUT':
      return -phi(((spec.strike as number) - mu) / sigma) / sigma;
    case 'SPREAD': {
      const a = spec.lower as number;
      const b = spec.upper as number;
      return (phi((a - mu) / sigma) - phi((b - mu) / sigma)) / sigma;
    }
    case 'GAUSSIAN': {
      const c = spec.center as number;
      const w = spec.width as number;
      const V = w * w + sigma2;
      return (priceGaussianPayoff(c, w, mu, sigma2) * (c - mu)) / V;
    }
    default:
      throw new Error(`dPriceDMu: unknown contract type ${(spec as ContractSpec).type}`);
  }
}

// Fair price E_p[f_C(θ)] = ∫ f(θ)·p(θ) dθ. –4.2.
// Gaussian → closed form. Mixture → by linearity of expectation
// Price(f, Σπ_k N_k) = Σ π_k·Price(f, N_k) — exact, reusing the per-component
// closed forms. Student-t and other kinds fall back to the
// general `expectF` quadrature on the payoff.
export function price(spec: ContractSpec, belief: BeliefModel): number {
  // shape-extensions. TENT/TRAPEZOID reduce to CALL sums (exact, any kind)
  // SIGMOID is bounded quadrature (no closed form); SKEW_GAUSSIAN is closed-form
  // under Gaussian/mixture (handled in priceUnderGaussian) and quadrature otherwise.
  if (spec.type === 'TENT') return tentPrice(spec, belief);
  if (spec.type === 'TRAPEZOID') return trapezoidPrice(spec, belief);
  if (spec.type === 'SIGMOID') {
    return expectFeature(
      belief,
      (x) => payoff(spec, x),
      spec.center as number,
      spec.width as number,
    );
  }
  if (spec.type === 'SKEW_GAUSSIAN' && belief.kind !== 'gaussian' && belief.kind !== 'mixture') {
    const feature = Math.min(spec.widthLeft as number, spec.widthRight as number);
    return expectFeature(belief, (x) => payoff(spec, x), spec.center as number, feature);
  }

  if (belief.kind === 'gaussian') {
    return priceUnderGaussian(spec, belief.mean(), belief.variance());
  }
  if (belief.kind === 'mixture') {
    const m = belief as MixtureBelief;
    let sum = 0;
    for (const c of m.components) sum += c.pi * priceUnderGaussian(spec, c.mu, c.sigma2);
    return sum;
  }
  if (belief.kind === 'student_t') {
    return priceUnderStudentT(spec, belief as StudentTBelief);
  }
  if (belief.kind === 'gen_exact') {
    return priceUnderGenExact(spec, belief as GenExactBelief);
  }
  // LINEAR is E[θ] = mean exactly for any belief — avoids tail-truncation bias the
  // finite quadrature window would introduce on a fat-tailed belief.
  if (spec.type === 'LINEAR') return belief.mean();
  // Unknown / non-closed-form kind: numerically integrate the payoff.
  return expectF((t) => payoff(spec, t), belief);
}

// ∂Price/∂μ — price sensitivity to a rigid shift of the belief mean.
// For a mixture this is the sensitivity to translating *all* component means by the
// same dμ (which shifts the belief mean by dμ): Σ π_k·∂Price_k/∂μ_k. Used by the
// adverse-selection spread term.
export function dPriceDMu(spec: ContractSpec, belief: BeliefModel): number {
  // shape-extensions, kind-agnostic via the translation identity
  // ∂E[f(θ)]/∂μ = E[f'(θ)] (shifting μ translates the whole density). TENT/TRAPEZOID
  // differentiate their CALL decomposition; SIGMOID/SKEW integrate the analytic f'.
  if (spec.type === 'TENT') {
    const c = spec.center as number;
    const w = spec.width as number;
    const dca = (K: number) => dPriceDMu({ type: 'CALL', strike: K }, belief);
    return (dca(c - w) - 2 * dca(c) + dca(c + w)) / w;
  }
  if (spec.type === 'TRAPEZOID') {
    const a = spec.lower as number;
    const b = spec.upper as number;
    const w = spec.width as number;
    const dca = (K: number) => dPriceDMu({ type: 'CALL', strike: K }, belief);
    return (dca(a - w) - dca(a) - dca(b) + dca(b + w)) / w;
  }
  if (spec.type === 'SIGMOID') {
    const c = spec.center as number;
    const w = spec.width as number;
    // f' = f·(1−f)/w (logistic derivative), a bounded bump centred at c.
    const deriv = (x: number) => {
      const s = 1 / (1 + Math.exp(-(x - c) / w));
      return (s * (1 - s)) / w;
    };
    return expectFeature(belief, deriv, c, w);
  }
  if (spec.type === 'SKEW_GAUSSIAN') {
    const c = spec.center as number;
    const wL = spec.widthLeft as number;
    const wR = spec.widthRight as number;
    // f'(θ) = −(θ−c)/w²·exp(−(θ−c)²/2w²), with w = wL below c, wR above.
    const deriv = (x: number) => {
      const w = x < c ? wL : wR;
      return -((x - c) / (w * w)) * Math.exp(-((x - c) ** 2) / (2 * w * w));
    };
    return expectFeature(belief, deriv, c, Math.min(wL, wR));
  }

  if (belief.kind === 'gaussian') {
    return dPriceDMuUnderGaussian(spec, belief.mean(), belief.variance());
  }
  if (belief.kind === 'mixture') {
    const m = belief as MixtureBelief;
    let sum = 0;
    for (const c of m.components) sum += c.pi * dPriceDMuUnderGaussian(spec, c.mu, c.sigma2);
    return sum;
  }
  if (belief.kind === 'student_t') {
    // t is a location family in μ: ∂E[f(X)]/∂μ has exact identities via pdf/cdf for
    // every kinked/jump payoff. Central-differencing the quadrature price here is a
    // trap — the jump's O(h) cell noise divided by 2h gave ∂P/∂μ errors of ±100%+.
    const t = belief as StudentTBelief;
    switch (spec.type) {
      case 'LINEAR':
        return 1;
      case 'CALL':
        return 1 - t.cdf(spec.strike as number);
      case 'PUT':
        return -t.cdf(spec.strike as number);
      case 'BINARY_CALL':
        return t.pdf(spec.strike as number);
      case 'BINARY_PUT':
        return -t.pdf(spec.strike as number);
      case 'SPREAD':
        return t.pdf(spec.lower as number) - t.pdf(spec.upper as number);
      default: {
        // Smooth payoff (GAUSSIAN): central-difference the (quadrature) price.
        const h = Math.max(1e-3, t.stddev() * 1e-3);
        const up = price(spec, new StudentTBelief(t.nu, t.mu + h, t.scale2));
        const dn = price(spec, new StudentTBelief(t.nu, t.mu - h, t.scale2));
        return (up - dn) / (2 * h);
      }
    }
  }
  if (belief.kind === 'gen_exact') {
    // Fixed-shape Gen·exact is a pure location family in μ, so the same exact
    // pdf/cdf identities as Student-t hold for every kinked/jump payoff; only the
    // smooth GAUSSIAN payoff needs the central difference.
    const b = belief as GenExactBelief;
    switch (spec.type) {
      case 'LINEAR':
        return 1;
      case 'CALL':
        return 1 - b.cdf(spec.strike as number);
      case 'PUT':
        return -b.cdf(spec.strike as number);
      case 'BINARY_CALL':
        return b.pdf(spec.strike as number);
      case 'BINARY_PUT':
        return -b.pdf(spec.strike as number);
      case 'SPREAD':
        return b.pdf(spec.lower as number) - b.pdf(spec.upper as number);
      default: {
        // Smooth payoff (GAUSSIAN): central-difference the (quadrature) price.
        const h = Math.max(1e-3, b.stddev() * 1e-3);
        const up = price(spec, new GenExactBelief(b.mu + h, b.sigma, b.lambdas));
        const dn = price(spec, new GenExactBelief(b.mu - h, b.sigma, b.lambdas));
        return (up - dn) / (2 * h);
      }
    }
  }
  throw new Error(`dPriceDMu: unsupported belief kind ${belief.kind}`);
}

// General expectation E_p[g(θ)] via fixed composite Simpson over a ±L·σ window.
// Deterministic, O(nodes) cost — it CANNOT hang (an earlier adaptive variant could
// recurse toward 2^depth evaluations on kinked integrands like a call's payoff²).
// Accurate to ~1e-9 for smooth integrands; for continuous-but-kinked payoffs the
// error is O(h²). Discontinuous payoffs (binary/spread) have exact closed forms and
// should not be routed through here.
export function expectF(
  fn: (theta: number) => number,
  belief: BeliefModel,
  opts: { L?: number; nodes?: number } = {},
): number {
  // Window around the belief mean by its stddev. For a mixture the stddev includes
  // the between-component spread, so ±L·σ comfortably covers all modes.
  const mean = belief.mean();
  const sigma = belief.stddev();
  const L = opts.L ?? 10;
  // even node count for composite Simpson
  let n = opts.nodes ?? 4000;
  if (n % 2 === 1) n += 1;

  const a = mean - L * sigma;
  const b = mean + L * sigma;
  const h = (b - a) / n;
  const integrand = (theta: number) => fn(theta) * belief.pdf(theta);

  let sum = integrand(a) + integrand(b);
  for (let i = 1; i < n; i++) {
    sum += (i % 2 === 0 ? 2 : 4) * integrand(a + i * h);
  }
  return (sum * h) / 3;
}
