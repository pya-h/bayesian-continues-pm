// Pricing — fair price E_p[f(θ)] for each contract under a Gaussian belief.
// Closed forms, plus ∂Price/∂μ for the
// adverse-selection spread term, and a fixed composite-Simpson fallback for the
// general E_p[g(θ)] used by stats / future custom payoffs.

import { payoff } from './contracts.ts';
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
      const call = t.scale2 * t.pdf(K) * ((t.nu + d * d) / (t.nu - 1)) - (K - t.mu) * (1 - t.cdf(K));
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
