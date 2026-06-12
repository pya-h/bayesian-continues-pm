// Solvency — the MM's liability and required reserve., corrected for
// the inventory sign convention
// mmShort[C] = Σ users' positions in C (units the MM owes f_C(θ*) on)
// L(θ) = Σ_C mmShort[C] · f_C(θ) (what the MM pays out at outcome θ)
// Reserve = max(0, VaR_α(L)) (α-quantile of L under the belief)
// Reserve uses seeded Monte Carlo (reproducible). A book that can only profit the
// MM (L ≤ 0 everywhere in the sampled mass) yields reserve 0.

import { payoff } from './contracts.ts';
import { Rng } from './numerics.ts';
import { price } from './pricing.ts';
import type { BeliefModel, ContractSpec } from './types.ts';

export interface BookEntry {
  spec: ContractSpec;
  mmShort: number;
}

// MM payout L(θ) for the whole book at a single outcome θ.
export function liability(book: BookEntry[], theta: number): number {
  let sum = 0;
  for (const e of book) sum += e.mmShort * payoff(e.spec, theta);
  return sum;
}

// Expected liability E_p[L(θ)] = Σ mmShort · fair_price. Used for NAV/marks.
export function expectedLiability(book: BookEntry[], belief: BeliefModel): number {
  let sum = 0;
  for (const e of book) sum += e.mmShort * price(e.spec, belief);
  return sum;
}

export interface ReserveOpts {
  alpha?: number; // VaR confidence (default 0.99)
  samples?: number; // MC samples (default 50_000)
  seed?: number; // RNG seed (default 0xbmm)
}

// Required reserve = max(0, α-quantile of L(θ)) under the belief, via Monte Carlo.
// Deterministic given (book, belief, opts) because the RNG is seeded.
export function requiredReserve(
  book: BookEntry[],
  belief: BeliefModel,
  opts: ReserveOpts = {},
): number {
  if (book.length === 0) return 0;
  const alpha = opts.alpha ?? 0.99;
  const n = opts.samples ?? 50_000;
  const rng = new Rng(opts.seed ?? 0x626d6d);

  const draws = belief.sample(n, rng);
  const losses = new Float64Array(n);
  for (let i = 0; i < n; i++) losses[i] = liability(book, draws[i] as number);
  losses.sort();

  const idx = Math.min(n - 1, Math.max(0, Math.floor(alpha * (n - 1))));
  return Math.max(0, losses[idx] as number);
}

export function withMmShort(
  book: BookEntry[],
  spec: ContractSpec,
  key: string,
  keyOf: (s: ContractSpec) => string,
  newMmShort: number,
): BookEntry[] {
  const out: BookEntry[] = [];
  let found = false;
  for (const e of book) {
    if (keyOf(e.spec) === key) {
      out.push({ spec: e.spec, mmShort: newMmShort });
      found = true;
    } else {
      out.push(e);
    }
  }
  if (!found) out.push({ spec, mmShort: newMmShort });
  return out;
}

// Largest |size| ≤ |qDesired| (same sign as qDesired) such that the post-trade
// reserve stays within `cashLimit`. Reserve is sized at the
// pre-trade belief + new inventory; binary search assumes reserve ~monotone in size.
// `solveFill` (apps/api/src/services/tradeMath.ts), which adds the premium-backing
// rule and the gate's 1e-6 slack. Kept for the core test-suite cross-check; do not
// wire into new runtime code.
export function maxExecutable(
  otherBook: BookEntry[],
  spec: ContractSpec,
  key: string,
  keyOf: (s: ContractSpec) => string,
  mmShort: number,
  qDesired: number,
  belief: BeliefModel,
  cashLimit: number,
  opts: ReserveOpts = {},
): number {
  const sign = qDesired >= 0 ? 1 : -1;
  const target = Math.abs(qDesired);

  const reserveAt = (size: number): number => {
    const book = withMmShort(otherBook, spec, key, keyOf, mmShort + sign * size);
    return requiredReserve(book, belief, opts);
  };

  if (reserveAt(target) <= cashLimit) return target; // full fill fits

  // Binary search the feasible frontier.
  let lo = 0;
  let hi = target;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (reserveAt(mid) <= cashLimit) lo = mid;
    else hi = mid;
  }
  return lo;
}
