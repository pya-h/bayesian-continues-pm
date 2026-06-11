// Client-side projection of the next belief point — "if this order fills, where
// does the consensus μ ± σ move?". Unlike the spread (which needs the maker's live
// inventory), the belief update depends only on the contract, the signed size, the
// current belief, and the market's engine config — all of which the client already
// has (`cfg` ships on the market payload). So this reproduces the server's
// `projectedBelief` EXACTLY (same `extractSignal` → `bayesUpdate` from @bmm/core)
// and can therefore run live on every drag frame without a round-trip.

import { type EngineConfig, GaussianBelief, bayesUpdate, extractSignal } from '@bmm/core';
import type { ContractSpec } from './types.ts';

export function projectBelief(args: {
  spec: ContractSpec;
  signedQ: number;
  mu: number;
  sigma: number;
  cfg: Record<string, number | boolean>;
}): { mu: number; sigma: number } {
  const { spec, signedQ, mu, sigma, cfg } = args;
  const sd = sigma > 0 ? sigma : 1e-6;
  const belief = new GaussianBelief(mu, sd * sd);
  const engineCfg = cfg as unknown as EngineConfig;
  const sig = extractSignal(spec, signedQ, belief, engineCfg);
  const next = bayesUpdate(belief, sig.signal, sig.weight, engineCfg);
  return { mu: next.mu, sigma: next.stddev() };
}
