// Pricing — fair price E_p[f(θ)] for each contract under a Gaussian belief.
// Closed forms, plus ∂Price/∂μ for the
// adverse-selection spread term, and a fixed composite-Simpson fallback for the
// general E_p[g(θ)] used by stats / future custom payoffs.

import type { GaussianBelief } from './gaussian.ts';
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
  const g = asGaussian(belief);
  const sigma = g.stddev();
  const L = opts.L ?? 10;
  // even node count for composite Simpson
  let n = opts.nodes ?? 4000;
  if (n % 2 === 1) n += 1;

  const a = g.mu - L * sigma;
  const b = g.mu + L * sigma;
  const h = (b - a) / n;
  const integrand = (theta: number) => fn(theta) * g.pdf(theta);

  let sum = integrand(a) + integrand(b);
  for (let i = 1; i < n; i++) {
    sum += (i % 2 === 0 ? 2 : 4) * integrand(a + i * h);
  }
  return (sum * h) / 3;
}
