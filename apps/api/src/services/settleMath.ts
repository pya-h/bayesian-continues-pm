// Pure settlement math (no DB, no IO) — the deterministic core of, kept
// separate so it can be unit-tested in isolation
// • positionPayout — a long position's payout at resolution: quantity · f(θ*)
// . Uses core's payoff; works for every contract type.
// • positionRefund — a long position's cost-basis refund on CANCELLED markets
// quantity · avgEntryPrice (the capital still locked in the open holding).
// Positions are long-only (sells are enforced ≤ holding upstream), so quantity ≥ 0
// here and both results are non-negative.

import { type ContractSpec, payoff } from '@bmm/core';
import { round8 } from '@bmm/shared';

// Payout of a long position at the resolved outcome θ*: quantity · f(θ*).
export function positionPayout(spec: ContractSpec, quantity: number, theta: number): number {
  return round8(quantity * payoff(spec, theta));
}

export function positionRefund(quantity: number, avgEntryPrice: number): number {
  return round8(quantity * avgEntryPrice);
}
