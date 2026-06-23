// Reconstruct the live `BeliefModel` from a `MarketView` belief snapshot, so the
// client-side previews (live fair estimate, projected post-trade belief, the
// fair-price-vs-strike sweep) price against the market's ACTUAL belief — a
// mixture's bumps or a Student-t's fat tails — instead of a Gaussian stand-in.
// Mirrors the API's `loadBelief`, but from the public view shape: components carry
// σ (not σ²), and a Student-t carries ν with σ as the summary stddev (so its scale²
// is σ²·(ν−2)/ν via `fromVariance`). Unknown/degenerate inputs fall back to the
// Gaussian summary — these are presentation helpers, never the settlement path.

import {
  type BeliefModel,
  GaussianBelief,
  GenExactBelief,
  MixtureBelief,
  StudentTBelief,
} from '@bmm/core';
import type { BeliefStateDTO } from '@bmm/shared';
import type { Belief } from './types.ts';

export function beliefFromView(belief: Belief): BeliefModel {
  if (belief.kind === 'mixture' && belief.components && belief.components.length > 0) {
    return new MixtureBelief(
      belief.components.map((c) => ({ pi: c.pi, mu: c.mu, sigma2: c.sigma * c.sigma })),
    );
  }
  if (belief.kind === 'student_t' && belief.nu && belief.nu > 2) {
    return StudentTBelief.fromVariance(belief.nu, belief.mu, belief.sigma * belief.sigma);
  }
  // Gen·exact: reconstruct from its raw location/scale + exponent shape (loc/scale
  // not the summary mean/σ, are the actual params).
  if (belief.kind === 'gen_exact' && belief.lambdas && belief.loc != null && belief.scale != null) {
    return new GenExactBelief(belief.loc, belief.scale, belief.lambdas);
  }
  const sd = belief.sigma > 0 ? belief.sigma : 1e-6;
  return new GaussianBelief(belief.mu, sd * sd);
}

// Reconstruct a `BeliefModel` from a persisted belief-history snapshot (the
// ghost trail). Mirrors the API's `loadBelief`, but from the serialized
// `BeliefStateDTO` (components carry σ², a Student-t carries scale²). A NULL state
// Gaussian markets and the genesis point — falls back to N(μ, σ²) from the point's
// summary mean/σ. Presentation only; never the settlement path.
export function beliefFromSnapshot(
  state: BeliefStateDTO | null | undefined,
  mu: number,
  sigma: number,
): BeliefModel {
  if (state) {
    switch (state.kind) {
      case 'gaussian':
        return GaussianBelief.fromDTO(state);
      case 'mixture':
        return MixtureBelief.fromDTO(state);
      case 'student_t':
        return StudentTBelief.fromDTO(state);
      case 'gen_exact':
        return GenExactBelief.fromDTO(state);
    }
  }
  const sd = sigma > 0 ? sigma : 1e-6;
  return new GaussianBelief(mu, sd * sd);
}
