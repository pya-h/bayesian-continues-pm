// Adaptive-parameter wiring — the single place the API turns a market's
// static `cfg` + persisted controller state into the **live** `EngineConfig` used
// to price and update each trade, and folds each trade's signal error back into the
// rolling state.
// Causality (important): a trade is priced/updated with the params derived from the
// controller's **pre-trade** state; the trade's own signal error then advances the
// state for the **next** trade. So {@link liveEngineConfig} reads, {@link foldError}
// writes, and the two never race within one fill.
// Belief-kind agnostic: the only input is the scalar error `|s − μ_prior|`, which
// every `BeliefModel` produces via `mean`. The adapted `σ_ε` feeds the shared
// Bayesian precision term `w/σ_ε²`, so it tunes Gaussian / Mixture / Gen·basis /
// Gen·exact identically.

import {
  type AdaptedParams,
  type AdaptiveConfig,
  type AdaptiveState,
  DEFAULT_ADAPTIVE,
  type EngineConfig,
  adaptParams,
  initAdaptiveState,
  observeError,
} from '@bmm/core';
import type { AdaptiveControlDTO, MarketCfgState } from '@bmm/shared';

const ADAPTIVE_CFG_KEYS = [
  'alphaSlow',
  'alphaFast',
  'halfNormalCorrect',
  'warmup',
  'sigmaEpsLoRatio',
  'sigmaEpsHiRatio',
  's0Lo',
  's0Hi',
  'regimeCap',
  'adaptAlphaBeta',
  'alphaLo',
  'alphaHi',
  'betaLo',
  'betaHi',
] as const;

interface CfgRow {
  cfg: Record<string, number | boolean>;
  cfgState: MarketCfgState | null;
  initialSigma: number;
}

export interface LiveCfg {
  // Engine config to price/update THIS trade (base + adapted/pinned σ_ε,s₀,α,β).
  cfg: EngineConfig;
  adapted: AdaptedParams;
  state: AdaptiveState;
  acfg: AdaptiveConfig;
  control: AdaptiveControlDTO | undefined;
  source: 'static' | 'adapt' | 'pin';
}

export function resolveAdaptiveConfig(control: AdaptiveControlDTO | undefined): AdaptiveConfig {
  const acfg: AdaptiveConfig = { ...DEFAULT_ADAPTIVE };
  if (control?.enabled === false) acfg.enabled = false;
  const overrides = control?.cfg;
  if (overrides) {
    for (const k of ADAPTIVE_CFG_KEYS) {
      const v = overrides[k];
      if (v === undefined) continue;
      if (k === 'halfNormalCorrect' || k === 'adaptAlphaBeta') {
        if (typeof v === 'boolean') (acfg[k] as boolean) = v;
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        (acfg[k] as number) = v;
      }
    }
  }
  return acfg;
}

export function loadCfgState(row: { cfgState: MarketCfgState | null }): {
  state: AdaptiveState;
  control: AdaptiveControlDTO | undefined;
  acfg: AdaptiveConfig;
} {
  const state = row.cfgState?.adaptive ?? initAdaptiveState();
  const control = row.cfgState?.control;
  return { state, control, acfg: resolveAdaptiveConfig(control) };
}

export function liveEngineConfig(row: CfgRow): LiveCfg {
  const base = row.cfg as unknown as EngineConfig;
  const { state, control, acfg } = loadCfgState(row);
  const adapted = adaptParams(base, row.initialSigma, state, acfg);

  const pinned = control?.pinned ?? {};
  const cfg: EngineConfig = {
    ...base,
    sigmaEps: pinned.sigmaEps ?? adapted.sigmaEps,
    s0: pinned.s0 ?? adapted.s0,
    alpha: pinned.alpha ?? adapted.alpha,
    beta: pinned.beta ?? adapted.beta,
  };

  const hasPin =
    pinned.sigmaEps !== undefined ||
    pinned.s0 !== undefined ||
    pinned.alpha !== undefined ||
    pinned.beta !== undefined;
  const source: LiveCfg['source'] = hasPin
    ? 'pin'
    : acfg.enabled && state.count >= acfg.warmup
      ? 'adapt'
      : 'static';

  return { cfg, adapted, state, acfg, control, source };
}

// Fold one trade's signal into the controller (pure). `signal` is the extracted
// signal `s`, `priorMu` the pre-update belief mean; the observation is `|s − μ|`.
// Non-finite signals are ignored by the underlying EWMA.
export function foldError(
  state: AdaptiveState,
  signal: number,
  priorMu: number,
  acfg: AdaptiveConfig,
): AdaptiveState {
  return observeError(state, Math.abs(signal - priorMu), acfg);
}

export function packCfgState(
  state: AdaptiveState,
  control: AdaptiveControlDTO | undefined,
): MarketCfgState {
  return control ? { adaptive: state, control } : { adaptive: state };
}

export interface CfgHistoryRow {
  sigmaEps: number;
  s0: number;
  alpha: number;
  beta: number;
  regime: number;
  railHit: boolean;
  source: string;
}

export function cfgHistoryRow(
  row: CfgRow,
  nextState: AdaptiveState,
  acfg: AdaptiveConfig,
  control: AdaptiveControlDTO | undefined,
): CfgHistoryRow {
  const base = row.cfg as unknown as EngineConfig;
  const after = adaptParams(base, row.initialSigma, nextState, acfg);
  const pinned = control?.pinned ?? {};
  const hasPin =
    pinned.sigmaEps !== undefined ||
    pinned.s0 !== undefined ||
    pinned.alpha !== undefined ||
    pinned.beta !== undefined;
  const inert = !acfg.enabled || nextState.count < acfg.warmup;
  const source = hasPin ? 'pin' : inert ? 'static' : after.railHit ? 'breaker' : 'adapt';
  return {
    sigmaEps: pinned.sigmaEps ?? after.sigmaEps,
    s0: pinned.s0 ?? after.s0,
    alpha: pinned.alpha ?? after.alpha,
    beta: pinned.beta ?? after.beta,
    regime: after.regime,
    railHit: after.railHit,
    source,
  };
}
