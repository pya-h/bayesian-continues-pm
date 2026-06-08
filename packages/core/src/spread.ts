// Spread — the MM's quoted half-spread around fair value.
// Structure preserved from the spec (base + inventory + adverse-selection + vol)
// with two dimensional corrections
// • adverse selection uses trade INTENSITY (|q|/qMax, dimensionless) rather than
// raw |q|, so the term is a bounded multiple of the per-σ price move
// |∂P/∂μ|·σ. Larger trades ⇒ wider spread (more likely informed).
// • volatility uses RELATIVE σ (σ / max(|μ|, σ)) so the term is a sensible
// fraction of fair value rather than scaling with the outcome's magnitude.
// Returns a breakdown (not just a scalar) so the UI can explain the quote.
// The half-spread is always ≥ 0; exec price = fair + spread (buy) / fair − spread (sell).

import type { GaussianBelief } from './gaussian.ts';
import { dPriceDMu, price } from './pricing.ts';
import type { BeliefModel, ContractSpec, EngineConfig } from './types.ts';

export interface SpreadBreakdown {
  base: number;
  inventory: number;
  adverseSelection: number;
  volatility: number;
  total: number;
  fair: number;
}

export function computeSpread(
  spec: ContractSpec,
  q: number,
  mmShort: number,
  belief: BeliefModel,
  cfg: EngineConfig,
): SpreadBreakdown {
  if (belief.kind !== 'gaussian') {
    throw new Error(`computeSpread: v1 requires Gaussian belief, got ${belief.kind}`);
  }
  const g = belief as GaussianBelief;
  const fair = price(spec, belief);
  const absFair = Math.abs(fair);
  const sigma = g.stddev();
  const intensity = Math.abs(q) / cfg.qMax;

  const base = cfg.s0 * absFair;
  const inventory = cfg.gamma * Math.abs(mmShort + q) * absFair;

  // |∂P/∂μ|·σ ≈ price move for a 1-σ shift in μ (in payout units). Scaled by λ·intensity.
  const perSigmaMove = Math.abs(dPriceDMu(spec, belief)) * sigma;
  const adverseSelection = cfg.lambda * intensity * perSigmaMove;

  const sigmaRel = sigma / Math.max(Math.abs(g.mu), sigma);
  const volatility = cfg.eta * sigmaRel * absFair;

  const total = base + inventory + adverseSelection + volatility;
  return { base, inventory, adverseSelection, volatility, total, fair };
}
