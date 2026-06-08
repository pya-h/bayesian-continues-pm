// Pricing — fair price E_p[f(θ)] for each contract under a Gaussian belief.
// Closed forms, plus ∂Price/∂μ for the
// adverse-selection spread term, and an adaptive-Simpson fallback for the general
// E_p[g(θ)] used by stats / future custom payoffs.

import { GaussianBelief } from './gaussian.ts';
import { Phi, phi } from './numerics.ts';
import type { BeliefModel, ContractSpec } from './types.ts';

function asGaussian(belief: BeliefModel): GaussianBelief {
  if (belief.kind !== 'gaussian') {
    throw new Error(`pricing: v1 closed forms require a Gaussian belief, got ${belief.kind}`);
  }
  return belief as GaussianBelief;
}

// Closed-form price of a Gaussian-payoff contract exp(-(θ-c)²/(2w²)).
export function priceGaussianPayoff(c: number, w: number, mu: number, sigma2: number): number {
  const w2 = w * w;
  const denom = w2 + sigma2;
  return Math.sqrt(w2 / denom) * Math.exp(-((c - mu) ** 2) / (2 * denom));
}

// Fair price E_p[f_C(θ)] = ∫ f(θ)·p(θ) dθ. –4.2.
export function price(spec: ContractSpec, belief: BeliefModel): number {
  const g = asGaussian(belief);
  const mu = g.mu;
  const sigma = g.stddev();

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
    case 'BINARY_CALL': {
      const K = spec.strike as number;
      return Phi((mu - K) / sigma);
    }
    case 'BINARY_PUT': {
      const K = spec.strike as number;
      return Phi((K - mu) / sigma);
    }
    case 'SPREAD': {
      const a = spec.lower as number;
      const b = spec.upper as number;
      return Phi((b - mu) / sigma) - Phi((a - mu) / sigma);
    }
    case 'GAUSSIAN':
      return priceGaussianPayoff(spec.center as number, spec.width as number, mu, g.sigma2);
    default:
      throw new Error(`price: unknown contract type ${(spec as ContractSpec).type}`);
  }
}

// ∂Price/∂μ — price sensitivity to the belief mean (used by adverse selection).
export function dPriceDMu(spec: ContractSpec, belief: BeliefModel): number {
  const g = asGaussian(belief);
  const mu = g.mu;
  const sigma = g.stddev();

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
      const V = w * w + g.sigma2;
      return (priceGaussianPayoff(c, w, mu, g.sigma2) * (c - mu)) / V;
    }
    default:
      throw new Error(`dPriceDMu: unknown contract type ${(spec as ContractSpec).type}`);
  }
}

// General expectation E_p[g(θ)] via adaptive Simpson over a ±L·σ window.
// Deterministic fallback for stats second moments and any future custom payoff.
export function expectF(
  fn: (theta: number) => number,
  belief: BeliefModel,
  opts: { L?: number; tol?: number } = {},
): number {
  const g = asGaussian(belief);
  const sigma = g.stddev();
  const L = opts.L ?? 12;
  const tol = opts.tol ?? 1e-10;
  const integrand = (theta: number) => fn(theta) * g.pdf(theta);
  return adaptiveSimpson(integrand, g.mu - L * sigma, g.mu + L * sigma, tol, 50);
}

function adaptiveSimpson(
  f: (x: number) => number,
  a: number,
  b: number,
  tol: number,
  maxDepth: number,
): number {
  const c = (a + b) / 2;
  const fa = f(a);
  const fb = f(b);
  const fc = f(c);
  const s = ((b - a) / 6) * (fa + 4 * fc + fb);
  return recurse(f, a, b, fa, fb, fc, s, tol, maxDepth);
}

function recurse(
  f: (x: number) => number,
  a: number,
  b: number,
  fa: number,
  fb: number,
  fc: number,
  s: number,
  tol: number,
  depth: number,
): number {
  const c = (a + b) / 2;
  const lc = (a + c) / 2;
  const rc = (c + b) / 2;
  const flc = f(lc);
  const frc = f(rc);
  const sLeft = ((c - a) / 6) * (fa + 4 * flc + fc);
  const sRight = ((b - c) / 6) * (fc + 4 * frc + fb);
  const s2 = sLeft + sRight;
  if (depth <= 0 || Math.abs(s2 - s) <= 15 * tol) {
    return s2 + (s2 - s) / 15;
  }
  return (
    recurse(f, a, c, fa, fc, flc, sLeft, tol / 2, depth - 1) +
    recurse(f, c, b, fc, fb, frc, sRight, tol / 2, depth - 1)
  );
}
