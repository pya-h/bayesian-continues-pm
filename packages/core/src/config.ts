// Engine config defaults. gives ranges; we pick stable demo
// defaults and derive the absolute σ params from the market's initial (μ₀, σ₀).
// Note on σ_ε: the spec suggests 5–15% of σ₀ (very informative trades). For a
// play-money demo we default σ_ε = σ₀ (a full-weight signal carries the same
// precision as the prior → μ moves ~halfway), which avoids belief whipsaw. Tune
// per market via overrides.

import type { EngineConfig } from './types.ts';

export const DEFAULT_PARAMS = {
  s0: 0.01, // 1% base spread
  gamma: 0.0005, // inventory adjustment
  lambda: 0.5, // adverse selection
  eta: 0.05, // volatility adjustment
  alpha: 1.0, // directional signal strength
  beta: 1.0, // linear signal strength
  lr: 0.01, // simplified-update learning rate
  decay: 0.05, // simplified-update variance decay
  reserveAlpha: 0.99, // reserve VaR confidence
  useSimplifiedUpdate: false,
  genExactShapeAdapt: true, // gen_exact: order flow sculpts the shape (v2 moment-projection, I4)
  qMax: 500, // max trade size (normalizes intensity)
  qThreshold: 10, // size below which belief impact ~ 0
  sigmaMinRatio: 0.1, // σ_min = 10% of σ₀
  sigmaEpsRatio: 1.0, // σ_ε = 1.0 × σ₀
} as const;

// Build a full EngineConfig from the market's initial μ₀/σ₀ and optional overrides.
export function makeEngineConfig(
  mu0: number,
  sigma0: number,
  overrides: Partial<EngineConfig> = {},
): EngineConfig {
  void mu0; // reserved (some spec defaults key off μ₀); kept for signature stability
  const base: EngineConfig = {
    sigmaMin: DEFAULT_PARAMS.sigmaMinRatio * sigma0,
    sigmaEps: DEFAULT_PARAMS.sigmaEpsRatio * sigma0,
    s0: DEFAULT_PARAMS.s0,
    gamma: DEFAULT_PARAMS.gamma,
    lambda: DEFAULT_PARAMS.lambda,
    eta: DEFAULT_PARAMS.eta,
    alpha: DEFAULT_PARAMS.alpha,
    beta: DEFAULT_PARAMS.beta,
    qMax: DEFAULT_PARAMS.qMax,
    qThreshold: DEFAULT_PARAMS.qThreshold,
    lr: DEFAULT_PARAMS.lr,
    decay: DEFAULT_PARAMS.decay,
    reserveAlpha: DEFAULT_PARAMS.reserveAlpha,
    useSimplifiedUpdate: DEFAULT_PARAMS.useSimplifiedUpdate,
    genExactShapeAdapt: DEFAULT_PARAMS.genExactShapeAdapt,
  };
  return { ...base, ...overrides };
}
