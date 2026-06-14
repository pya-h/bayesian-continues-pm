// Contract ↔ belief compatibility (multi-model refactor, scaffolding).
// A continuous belief-priced contract only has a finite price if the payoff's
// growth is dominated by the belief's tail decay. Gaussian-tailed beliefs
// (gaussian / mixture / gen_basis / gen_exact — all decay ≥ e^{-cu²}) integrate
// any polynomial or exponential payoff; a polynomial (Student-t) tail only
// integrates payoffs that grow slower than its decay (POLYNOMIAL of degree < ν
// never EXPONENTIAL). The real guard lands in; this stub keeps the
// call site shape but accepts everything the current contract set already prices.
// See model/contract-extensions.md and.2).

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

// Whether a contract spec can be priced (finite expectation) against a belief
// with the given tail. G0 stub: every contract in the current set (LINEAR /
// CALL / PUT / BINARY_* / SPREAD / GAUSSIAN) is integrable under both tails, so
// this returns `true` for all of them. replaces it with the real
// integrability check for the new unbounded payoffs (POLYNOMIAL / EXPONENTIAL).
export function contractBeliefCompatible(_spec: ContractSpec, _tail: TailKind): boolean {
  return true;
}
