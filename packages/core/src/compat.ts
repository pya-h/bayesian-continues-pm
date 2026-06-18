// Contract ↔ belief compatibility (multi-model refactor, Phases G0 + ).
// A continuous belief-priced contract only has a finite price if the payoff's
// growth is dominated by the belief's tail decay. Gaussian-tailed beliefs
// (gaussian / mixture / gen_basis / gen_exact — all decay ≥ e^{-cu²}) integrate
// any polynomial or exponential payoff; a polynomial (Student-t) tail only
// integrates payoffs that grow slower than its decay (POLYNOMIAL of degree < ν
// never EXPONENTIAL — its price diverges). Independently, the two payoffs
// are UNBOUNDED, so unbounded liability/reserve is only sane on a market with a
// bounded outcome support; we require outcomeMin/Max for them.
// See model/contract-extensions.md and.2).

import { polynomialDegree } from './contracts.ts';
import type { ContractSpec } from './types.ts';

// How a belief's density decays in the tails — the thing a payoff must not outgrow.
export type TailKind = 'gaussian' | 'polynomial';

// The creator-chosen model tag. Kept as a local
// string union so `core` stays dependency-free.
export type ModelTag = 'gaussian' | 'student_t' | 'mixture' | 'gen_basis' | 'gen_exact';

// Tail decay per model. Everything Gaussian-derived (incl. finite mixtures and
// the exp(−poly) Gen·exact, whose polynomial exponent gives Gaussian-or-thinner
// tails) decays Gaussian-fast; only Student-t has a heavy polynomial tail.
export const BELIEF_TAIL: Record<ModelTag, TailKind> = {
  gaussian: 'gaussian',
  mixture: 'gaussian',
  gen_basis: 'gaussian',
  gen_exact: 'gaussian',
  student_t: 'polynomial',
};

// Largest dimensionless log-range an EXPONENTIAL may span across the market's
// outcome support: |a|·(outcomeMax−outcomeMin) ≤ this. Caps the payoff's dynamic
// range at e^{20} (~5e8) so premiums/liability stay numerically and economically
// sane regardless of the outcome scale.
export const EXP_MAX_LOG_RANGE = 20;

// Market context the integrability/boundedness guard needs beyond the tail kind.
export interface BeliefTailContext {
  tail: TailKind;
  // Student-t degrees of freedom (only when `tail === 'polynomial'`); a degree-n
  // polynomial has a finite moment iff n < ν.
  nu?: number;
  outcomeBounded: boolean;
  outcomeSpan?: number;
}

// Result of the compatibility check; `reason` is a user-facing explanation when blocked.
export interface CompatResult {
  ok: boolean;
  reason?: string;
}

// Whether a contract spec can be priced (finite expectation) AND reserved (bounded
// liability) against a market's belief. The v1 set (LINEAR / CALL / PUT / BINARY_* /
// SPREAD / GAUSSIAN) and the bounded shapes (SKEW_GAUSSIAN / TENT / TRAPEZOID /
// SIGMOID) are always compatible. The two unbounded contracts are gated
// both require a bounded-outcome market (else unbounded realized liability)
// EXPONENTIAL is rejected on a Student-t (polynomial-tail) belief — `E[e^{aθ}]`
// diverges — and its rate is capped to a sane dynamic range over the outcome span
// POLYNOMIAL of degree n is rejected on Student-t when n ≥ ν (infinite n-th moment).
export function contractBeliefCompatible(spec: ContractSpec, ctx: BeliefTailContext): CompatResult {
  if (spec.type !== 'POLYNOMIAL' && spec.type !== 'EXPONENTIAL') return { ok: true };

  // Unbounded payoff ⇒ require a bounded outcome support for a finite worst case.
  if (!ctx.outcomeBounded) {
    return {
      ok: false,
      reason: `${spec.type} is unbounded and only allowed on a bounded-outcome market (set outcomeMin and outcomeMax).`,
    };
  }

  if (spec.type === 'EXPONENTIAL') {
    if (ctx.tail === 'polynomial') {
      return {
        ok: false,
        reason:
          'EXPONENTIAL has an infinite price on a heavy-tailed (Student-t) belief — e^{aθ} outruns its polynomial decay.',
      };
    }
    const a = Math.abs(spec.rate ?? 0);
    const span = ctx.outcomeSpan ?? 0;
    if (a * span > EXP_MAX_LOG_RANGE) {
      return {
        ok: false,
        reason: `EXPONENTIAL rate too steep for this outcome range: |rate|·span = ${(a * span).toFixed(2)} exceeds ${EXP_MAX_LOG_RANGE}.`,
      };
    }
    return { ok: true };
  }

  // POLYNOMIAL: finite under a polynomial tail only when degree < ν.
  if (ctx.tail === 'polynomial') {
    const deg = polynomialDegree(spec.coeffs ?? []);
    const nu = ctx.nu ?? Number.POSITIVE_INFINITY;
    if (deg >= nu) {
      return {
        ok: false,
        reason: `POLYNOMIAL of degree ${deg} has an infinite moment on a Student-t belief with ν=${nu} (needs degree < ν).`,
      };
    }
  }
  return { ok: true };
}
