// Signal extraction — infer the trader's private signal s and its reliability w
// from a trade. (with the corrections / sensible extensions
// for SPREAD and GAUSSIAN, which the spec leaves unspecified).
// Convention: q > 0 is a user BUY, q < 0 is a user SELL.

import type { BeliefModel, ContractSpec, EngineConfig } from './types.ts';

export interface ExtractedSignal {
  signal: number;
  weight: number;
}

// Infer (signal, weight) from a trade. Belief-kind agnostic: it reads only the
// belief's summary location (mean) and scale (stddev), so it works for Gaussian
// and mixture alike. The per-component weight re-allocation that turns this scalar
// into multi-modal movement happens in the Bayes update (bayes.ts), not here.
export function extractSignal(
  spec: ContractSpec,
  q: number,
  belief: BeliefModel,
  cfg: EngineConfig,
): ExtractedSignal {
  const mu = belief.mean();
  const sigma = belief.stddev();
  const absQ = Math.abs(q);
  const direction = q >= 0 ? 1 : -1;
  // Clamped: solvency-gated fills can exceed qMax, and an unclamped intensity would
  // push weight > 1 (bayes' simplified path multiplies σ² by (1 − decay·weight)).
  const intensity = Math.min(1, absQ / cfg.qMax);
  const a = cfg.alpha;

  let signal: number;
  switch (spec.type) {
    case 'LINEAR': {
      // buy → above μ, sell → below μ
      signal = mu + direction * cfg.beta * sigma * intensity;
      break;
    }
    case 'CALL':
    case 'BINARY_CALL': {
      // bullish: buy pushes the signal above the strike
      const K = spec.strike as number;
      signal = K + direction * a * sigma * (1 + intensity);
      break;
    }
    case 'PUT':
    case 'BINARY_PUT': {
      // bearish: buy pushes the signal below the strike
      const K = spec.strike as number;
      signal = K - direction * a * sigma * (1 + intensity);
      break;
    }
    case 'GAUSSIAN': {
      // point bet on center c: buy pulls belief toward c, sell pushes away
      const c = spec.center as number;
      signal = pointBet(c, mu, direction, a, sigma, intensity);
      break;
    }
    case 'SPREAD': {
      // range bet [a,b]: buy pulls toward midpoint, sell pushes away
      const m = ((spec.lower as number) + (spec.upper as number)) / 2;
      signal = pointBet(m, mu, direction, a, sigma, intensity);
      break;
    }
    default:
      signal = mu;
  }

  // Reliability: scales with size; trades below q_threshold are mostly noise.
  const weight = intensity * (1 - Math.exp(-absQ / cfg.qThreshold));
  return { signal, weight };
}

// Buy → toward target; sell → away from target in μ's current direction.
function pointBet(
  target: number,
  mu: number,
  direction: number,
  alpha: number,
  sigma: number,
  intensity: number,
): number {
  if (direction > 0) return target;
  const away = Math.sign(mu - target) || 1;
  return mu + away * alpha * sigma * (1 + intensity);
}
