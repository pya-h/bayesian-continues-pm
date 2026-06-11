// Client-side projection of the next belief point — "if this order fills, where
// does the consensus μ ± σ move?". Unlike the spread (which needs the maker's live
// inventory), the belief update depends only on the contract, the signed size, the
// current belief, and the market's engine config — all of which the client already
// has (`cfg` ships on the market payload). So this reproduces the server's
// `projectedBelief` EXACTLY for every belief kind: it runs the same kind-aware
// `extractSignal` → `updateBelief` from @bmm/core (which dispatches to the Gaussian
// mixture, or Student-t update), so a mixture/Student-t market projects with its
// real update rule, not a Gaussian one. Runs live on every drag frame, no round-trip.

import { type BeliefModel, type EngineConfig, extractSignal, updateBelief } from '@bmm/core';
import type { ContractSpec } from './types.ts';

export function projectBelief(args: {
  spec: ContractSpec;
  signedQ: number;
  belief: BeliefModel;
  cfg: Record<string, number | boolean>;
}): { mu: number; sigma: number } {
  const { spec, signedQ, belief, cfg } = args;
  const engineCfg = cfg as unknown as EngineConfig;
  const sig = extractSignal(spec, signedQ, belief, engineCfg);
  const next = updateBelief(belief, sig.signal, sig.weight, engineCfg);
  return { mu: next.mean(), sigma: next.stddev() };
}
