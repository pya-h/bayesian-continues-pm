// Bayesian belief update.
// Default: precision-weighted conjugate Normal–Normal update. The simplified
// learning-rate variant is available behind cfg.useSimplifiedUpdate.
// Posterior variance is floored at σ_min² to prevent overconfidence.

import { GaussianBelief } from './gaussian.ts';
import type { EngineConfig } from './types.ts';

export function bayesUpdate(
  belief: GaussianBelief,
  signal: number,
  weight: number,
  cfg: EngineConfig,
): GaussianBelief {
  const sigmaMin2 = cfg.sigmaMin * cfg.sigmaMin;

  if (weight <= 0) {
    // No information → unchanged (but still respect the floor).
    return new GaussianBelief(belief.mu, Math.max(belief.sigma2, sigmaMin2));
  }

  if (cfg.useSimplifiedUpdate) {
    const muNew = belief.mu + cfg.lr * (signal - belief.mu) * weight;
    const sigma2New = belief.sigma2 * (1 - cfg.decay * weight);
    return new GaussianBelief(muNew, Math.max(sigma2New, sigmaMin2));
  }

  // Precision-weighted update.
  const precisionPrior = 1 / belief.sigma2;
  const precisionSignal = weight / (cfg.sigmaEps * cfg.sigmaEps);
  const totalPrecision = precisionPrior + precisionSignal;

  const muNew = (precisionPrior * belief.mu + precisionSignal * signal) / totalPrecision;
  const sigma2New = 1 / totalPrecision;

  return new GaussianBelief(muNew, Math.max(sigma2New, sigmaMin2));
}
