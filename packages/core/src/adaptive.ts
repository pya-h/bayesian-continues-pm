// Adaptive parameters — self-tuning σ_ε, s₀, and (optionally) α/β.
// step 3
// σ_ε_t = EWMA(σ_ε, |signal_error_t|, alpha=0.1)
// s₀_t = max(s₀_min, s₀ × (1 + volatility_regime))
// This module is **pure** (no IO, no `Math.random`, no clock) and **belief-kind
// agnostic**: it consumes a stream of scalar *signal errors* — `|s − μ_prior|`
// the surprise of each trade's extracted signal relative to the pre-update belief
// mean — which every `BeliefModel` produces via its summary `mean`. So the same
// controller tunes a Gaussian, Mixture, Gen·basis or Gen·exact market.
// It is intentionally separate from the per-model *shape* adaptivity that already
// ships (gen_basis spawning, gen_exact moment-projection): those reshape the belief
// *density*; this reshapes the engine *constants* (signal noise, spread, signal
// strength). The two compose — the EWMA σ_ε feeds the shared Bayesian precision
// term `w/σ_ε²` used by every kind's update.
// Design notes
// • σ_ε estimate. The spec blends σ_ε directly with `|error|`. But for ε ~ N(0,σ_ε²)
// the mean absolute deviation is `E|ε| = σ_ε·√(2/π)`, so a raw EWMA of `|error|`
// *underestimates* σ_ε by √(2/π) ≈ 0.798. We track the EWMA of `|error|` and apply
// the half-normal debias factor √(π/2) ≈ 1.253 to get an unbiased σ_ε (gated by
// `halfNormalCorrect`, default on). Faithful to the spec's intent, mathematically
// corrected.
// • Volatility regime. Detected from the *same* error stream with a second, faster
// EWMA: `regime = clamp(emaFast/emaSlow − 1, 0, regimeCap)`. Recent surprises
// growing faster than the slow baseline ⇒ regime > 0 ⇒ wider spread; it relaxes
// back to 0 as the two EWMAs re-converge. No external volatility feed needed.
// • Rails. Every adapted value is clamped to the spec's range; a clamp that
// binds is reported in {@link RailHits} so can drive the rail-hit circuit
// breaker / admin alert.

export interface AdaptiveState {
  // Slow EWMA of |signal error| (drives σ_ε).
  emaSlow: number;
  emaFast: number;
  count: number;
}

export interface AdaptiveConfig {
  enabled: boolean;
  // σ_ε EWMA weight (spec α = 0.1).
  alphaSlow: number;
  alphaFast: number;
  // Apply the √(π/2) half-normal debias to the σ_ε estimate.
  halfNormalCorrect: boolean;
  // Observations required before adaptation engages (else return base).
  warmup: number;
  // σ_ε rail, as a ratio of the market's σ₀ (lower / upper).
  sigmaEpsLoRatio: number;
  sigmaEpsHiRatio: number;
  s0Lo: number;
  s0Hi: number;
  regimeCap: number;
  adaptAlphaBeta: boolean;
  alphaLo: number;
  alphaHi: number;
  betaLo: number;
  betaHi: number;
}

export interface RailHits {
  sigmaEps: 'lo' | 'hi' | null;
  s0: 'lo' | 'hi' | null;
  alpha: 'lo' | 'hi' | null;
  beta: 'lo' | 'hi' | null;
}

export interface AdaptedParams {
  sigmaEps: number;
  s0: number;
  alpha: number;
  beta: number;
  regime: number;
  railHit: boolean;
  rails: RailHits;
}

// √(π/2) — debiases mean|ε| → σ for a half-normal.
const HALF_NORMAL = Math.sqrt(Math.PI / 2);
const TINY = 1e-12;

export const DEFAULT_ADAPTIVE: AdaptiveConfig = {
  enabled: true,
  alphaSlow: 0.1, // spec value
  alphaFast: 0.4,
  halfNormalCorrect: true,
  warmup: 3,
  // Brackets the static demo default σ_ε = 1.0·σ₀ (config.ts): can tighten toward the
  // "informative" floor or widen to 2× under noisy flow.
  sigmaEpsLoRatio: 0.1,
  sigmaEpsHiRatio: 2.0,
  s0Lo: 0.001, // §14.1
  s0Hi: 0.02, // §14.1
  regimeCap: 1.0, // at most doubles the base spread
  adaptAlphaBeta: false, // optional per spec; off for v1
  alphaLo: 0.5, // §14.1
  alphaHi: 2.0,
  betaLo: 0.5, // §14.1
  betaHi: 1.5,
};

export function initAdaptiveState(): AdaptiveState {
  return { emaSlow: 0, emaFast: 0, count: 0 };
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

// Fold one trade's signal error into the EWMA state (pure). `absErr = |s − μ_prior|`.
// The first observation seeds both EWMAs (avoids a long ramp from zero). Non-finite
// or negative errors are ignored (returns state unchanged).
export function observeError(
  state: AdaptiveState,
  absErr: number,
  cfg: AdaptiveConfig = DEFAULT_ADAPTIVE,
): AdaptiveState {
  if (!Number.isFinite(absErr) || absErr < 0) return state;
  if (state.count === 0) {
    return { emaSlow: absErr, emaFast: absErr, count: 1 };
  }
  return {
    emaSlow: (1 - cfg.alphaSlow) * state.emaSlow + cfg.alphaSlow * absErr,
    emaFast: (1 - cfg.alphaFast) * state.emaFast + cfg.alphaFast * absErr,
    count: state.count + 1,
  };
}

// Compute the live adapted parameters from the controller state, clamped to the
// rails (pure). `base` is the market's static {@link EngineConfig} reference
// (its `sigmaEps`/`s0`/`alpha`/`beta` are the baselines); `sigma0` is the market's
// initial σ₀ (sets the σ_ε rail in absolute units). Before warmup — or when
// disabled — returns the base values unchanged with no rail hits.
export function adaptParams(
  base: { sigmaEps: number; s0: number; alpha: number; beta: number },
  sigma0: number,
  state: AdaptiveState,
  cfg: AdaptiveConfig = DEFAULT_ADAPTIVE,
): AdaptedParams {
  const noHit: RailHits = { sigmaEps: null, s0: null, alpha: null, beta: null };
  if (!cfg.enabled || state.count < cfg.warmup) {
    return {
      sigmaEps: base.sigmaEps,
      s0: base.s0,
      alpha: base.alpha,
      beta: base.beta,
      regime: 0,
      railHit: false,
      rails: noHit,
    };
  }

  const s0pos = Math.max(sigma0, TINY);
  const rails: RailHits = { sigmaEps: null, s0: null, alpha: null, beta: null };

  // σ_ε: debiased EWMA of |error|, clamped to [lo·σ₀, hi·σ₀] ---
  const sigLo = cfg.sigmaEpsLoRatio * s0pos;
  const sigHi = cfg.sigmaEpsHiRatio * s0pos;
  const sigRaw = (cfg.halfNormalCorrect ? HALF_NORMAL : 1) * state.emaSlow;
  const sigmaEps = clamp(sigRaw, sigLo, sigHi);
  if (sigmaEps !== sigRaw) rails.sigmaEps = sigRaw < sigLo ? 'lo' : 'hi';

  // volatility regime from fast/slow divergence ---
  const regime =
    state.emaSlow > TINY ? clamp(state.emaFast / state.emaSlow - 1, 0, cfg.regimeCap) : 0;

  // s₀: base × (1 + regime), clamped to ---
  const s0Raw = base.s0 * (1 + regime);
  const s0 = clamp(s0Raw, cfg.s0Lo, cfg.s0Hi);
  if (s0 !== s0Raw) rails.s0 = s0Raw < cfg.s0Lo ? 'lo' : 'hi';

  // optional α/β: damp signal strength when noise rises above baseline ---
  let alpha = base.alpha;
  let beta = base.beta;
  if (cfg.adaptAlphaBeta) {
    const noiseRatio = base.sigmaEps > TINY ? base.sigmaEps / Math.max(sigmaEps, TINY) : 1;
    const aRaw = base.alpha * noiseRatio;
    const bRaw = base.beta * noiseRatio;
    alpha = clamp(aRaw, cfg.alphaLo, cfg.alphaHi);
    beta = clamp(bRaw, cfg.betaLo, cfg.betaHi);
    if (alpha !== aRaw) rails.alpha = aRaw < cfg.alphaLo ? 'lo' : 'hi';
    if (beta !== bRaw) rails.beta = bRaw < cfg.betaLo ? 'lo' : 'hi';
  }

  const railHit = !!(rails.sigmaEps || rails.s0 || rails.alpha || rails.beta);
  return { sigmaEps, s0, alpha, beta, regime, railHit, rails };
}
