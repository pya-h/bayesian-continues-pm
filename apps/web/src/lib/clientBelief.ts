// Client-side projection of the next belief point — "if this order fills, where
// does the consensus μ ± σ move?". Unlike the spread (which needs the maker's live
// inventory), the belief update depends only on the contract, the signed size, the
// current belief, and the market's engine config — all of which the client already
// has (`cfg` ships on the market payload). So this reproduces the server's
// `projectedBelief` EXACTLY for every belief kind: it runs the same
// `updateBeliefForTrade` from @bmm/core (which dispatches to the Gaussian, mixture
// Student-t, or Gen·exact update, and routes a Gen·basis bell to the placement
// update) with the same model-derived mixture ops the API uses — so a mixture /
// Student-t / Gen·exact / Gen·basis market projects with its real update rule, not a
// Gaussian one. Runs live on every drag frame, no round-trip.

import {
  type BeliefModel,
  type EngineConfig,
  mixtureOpsForModel,
  updateBeliefForTrade,
} from '@bmm/core';
import type { ContractSpec, ModelTag } from './types.ts';

export function projectBelief(args: {
  spec: ContractSpec;
  signedQ: number;
  belief: BeliefModel;
  cfg: Record<string, number | boolean>;
  // The market's model tag — so a Gen·basis bell trade previews as a placement.
  model: ModelTag;
}): { mu: number; sigma: number } {
  const { spec, signedQ, belief, cfg, model } = args;
  const engineCfg = cfg as unknown as EngineConfig;
  // Mirror the server exactly: updateBeliefForTrade routes a Gen·basis bell to the
  // placement update, everything else to the standard extractSignal → updateBelief.
  // Pass the same model-derived mixture ops the API uses (mixtureOpsFor) so a
  // Gen·basis preview spawns modes / caps at 12 identically — not the spawn-off
  // DEFAULT_MIXTURE_OPS fallback.
  const next = updateBeliefForTrade(
    spec,
    signedQ,
    belief,
    engineCfg,
    model,
    mixtureOpsForModel(model),
  );
  return { mu: next.mean(), sigma: next.stddev() };
}
