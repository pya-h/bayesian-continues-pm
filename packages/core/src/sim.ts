// Monte-Carlo simulation — A pure, seeded harness that runs the
// full BMM loop against synthetic informed traders so we can measure, in
// aggregate, whether the engine *learns* and whether it's solvent/profitable
// for i in 1..runs
// θ_true ~ N(μ₀, σ₀²) # the outcome to be discovered
// for t in 1..traders: # each trader sees a noisy y ≈ θ_true
// trade a CALL/PUT toward y vs the current fair; MM prices, spreads, learns
// settle at θ_true and tally
// measure: belief accuracy |μ_f − θ_true|, calibration P(θ_true ∈ CI₈₀)
// MM profitability, average trader welfare.
// Deterministic given (params, seed): the single seeded Rng threads every draw
// so the report is reproducible and the module is unit-testable. It also doubles
// as a tuning tool for the default engine params (vary cfg, compare summaries).
// additions (all opt-in, defaults preserve the V1 Gaussian/ATM behaviour)
// • `adaptive` — run the self-tuning controller (adaptive.ts) per trade
// so σ_ε/s₀ track the realized signal surprise. `compareAdaptiveVsStatic`
// runs the same scenario both ways to show the effect on calibration.
// • `strikeAtRead` — traders bet struck at their noisy read y (not at the mean)
// so the signal surprise reflects genuine signal noise — the regime where the
// EWMA σ_ε is meaningful (an ATM market's surprise is endogenous to σ).
// • `beliefKind` — run the model zoo (gaussian / student_t / mixture / gen_exact)
// through the kind-agnostic price/update path, not only Gaussian.
// Note: the sim models spread income vs settlement payout (the P&L that matters
// for calibration/profitability) but does NOT run the reserve solvency gate —
// that path is exercised by the api integration tests, not this diagnostic.

import {
  type AdaptiveConfig,
  type AdaptiveState,
  DEFAULT_ADAPTIVE,
  adaptParams,
  initAdaptiveState,
  observeError,
} from './adaptive.ts';
import { updateBelief } from './bayes.ts';
import { makeEngineConfig } from './config.ts';
import { payoff } from './contracts.ts';
import { GaussianBelief } from './gaussian.ts';
import { GenExactBelief } from './gen_exact.ts';
import { MixtureBelief } from './mixture.ts';
import { type MixtureOpsConfig, mixtureOpsForModel } from './mixture_ops.ts';
import { Rng, normInv } from './numerics.ts';
import { price } from './pricing.ts';
import { extractSignal } from './signal.ts';
import { computeSpread } from './spread.ts';
import { StudentTBelief } from './student_t.ts';
import type { BeliefKind, BeliefModel, ContractSpec, EngineConfig } from './types.ts';

// z for an 80% central interval: μ ± z·σ, z = Φ⁻¹(0.90) ≈ 1.2816.
const Z80 = normInv(0.9);

export interface SimParams {
  runs: number;
  traders: number;
  mu0: number;
  sigma0: number;
  // Trader observation noise stddev (how informed they are). Default σ₀.
  sigmaObs?: number;
  cfg?: Partial<EngineConfig>;
  // RNG seed (default 0xb33f).
  seed?: number;
  beliefKind?: BeliefKind;
  nu?: number;
  // Run the adaptive controller. `true` uses {@link DEFAULT_ADAPTIVE}; a
  // partial config overrides specific fields. Default off ⇒ static V1 params.
  adaptive?: boolean | Partial<AdaptiveConfig>;
  // Traders bet struck at their noisy read y instead of at the current mean. Makes
  // the signal surprise track real noise (where adaptive σ_ε matters). Default off.
  strikeAtRead?: boolean;
}

export interface SimRun {
  thetaTrue: number;
  muFinal: number;
  sigmaFinal: number;
  // |μ_final − θ_true|.
  beliefError: number;
  // θ_true within the final 80% CI?
  inCi80: boolean;
  mmPnl: number;
  userWelfare: number;
  trades: number;
  // Final adaptive σ_ε (= static cfg σ_ε when adaptation is off).
  sigmaEpsFinal: number;
  railHit: boolean;
}

export interface SimSummary {
  runs: number;
  traders: number;
  mu0: number;
  sigma0: number;
  sigmaObs: number;
  seed: number;
  beliefKind: BeliefKind;
  adaptive: boolean;
  // Mean |μ_final − θ_true| across runs (lower = the engine learns).
  meanBeliefError: number;
  rmseBeliefError: number;
  // Mean genesis error |μ₀ − θ_true| — the no-learning baseline to beat.
  meanPriorError: number;
  // Fraction of runs with θ_true inside the final 80% CI (well-calibrated ≈ 0.80).
  calibration80: number;
  calibrationError: number;
  // Mean MM profit (should be ≥ ~0 — the MM earns the spread).
  meanMmPnl: number;
  meanUserWelfare: number;
  // Mean final σ_ε across runs (shows how far adaptation moved it from baseline).
  meanSigmaEpsFinal: number;
  railHitRate: number;
}

interface OpenLot {
  spec: ContractSpec;
  q: number;
  premium: number; // total paid to MM (execPrice·q)
}

// Construct the genesis belief for a given kind, centred at (μ₀, σ₀).
function makeBelief(kind: BeliefKind, mu0: number, sigma0: number, nu: number): BeliefModel {
  switch (kind) {
    case 'gaussian':
      return new GaussianBelief(mu0, sigma0 * sigma0);
    case 'student_t':
      return StudentTBelief.fromVariance(nu, mu0, sigma0 * sigma0);
    case 'gen_exact':
      // λ=[1,0,0] is the (near-)Gaussian member of the exp(−poly) family.
      return new GenExactBelief(mu0, sigma0, [1, 0, 0]);
    case 'mixture':
      // A single-component mixture centred at μ₀ (spawn stays off in this sim).
      return new MixtureBelief([{ pi: 1, mu: mu0, sigma2: sigma0 * sigma0 }]);
    default:
      throw new Error(`makeBelief: unsupported kind ${kind}`);
  }
}

function resolveAdaptive(adaptive: SimParams['adaptive']): AdaptiveConfig {
  if (!adaptive) return { ...DEFAULT_ADAPTIVE, enabled: false };
  if (adaptive === true) return { ...DEFAULT_ADAPTIVE, enabled: true };
  return { ...DEFAULT_ADAPTIVE, ...adaptive, enabled: true };
}

// One market run: θ_true is drawn, traders arrive, the MM learns, then we settle.
export function simulateRun(params: SimParams, rng: Rng): SimRun {
  const { mu0, sigma0, traders } = params;
  const sigmaObs = params.sigmaObs ?? sigma0;
  const kind = params.beliefKind ?? 'gaussian';
  const baseCfg = makeEngineConfig(mu0, sigma0, params.cfg ?? {});
  const acfg = resolveAdaptive(params.adaptive);
  const opsCfg: MixtureOpsConfig | undefined =
    kind === 'mixture' ? mixtureOpsForModel('mixture') : undefined;

  const thetaTrue = mu0 + sigma0 * rng.nextNormal();

  let belief = makeBelief(kind, mu0, sigma0, params.nu ?? 5);
  let mmCash = 0; // track the *delta*: premiums collected − payouts owed
  const lots: OpenLot[] = [];
  let nTrades = 0;

  let adaptState: AdaptiveState = initAdaptiveState();
  let railHit = false;
  // Live engine config — recomputed per trade when adaptation is on.
  let cfg = baseCfg;

  for (let i = 0; i < traders; i++) {
    const mu = belief.mean();
    const sigma = belief.stddev();
    // Trader's noisy private read of the outcome.
    const y = thetaTrue + sigmaObs * rng.nextNormal();
    const edge = y - mu;
    if (Math.abs(edge) < 1e-9) continue;

    if (acfg.enabled) {
      const a = adaptParams(baseCfg, sigma0, adaptState, acfg);
      if (a.railHit) railHit = true;
      cfg = { ...baseCfg, sigmaEps: a.sigmaEps, s0: a.s0, alpha: a.alpha, beta: a.beta };
    }

    // Bullish read → buy a CALL; bearish → buy a PUT. Struck either at the trader's
    // read (signal surprise tracks real noise) or at the current mean.
    const strike = params.strikeAtRead ? y : mu;
    const spec: ContractSpec = { type: edge > 0 ? 'CALL' : 'PUT', strike };
    // Size scales with conviction (|edge| in σ units), capped at qMax.
    const conviction = Math.min(1, Math.abs(edge) / (2 * sigma));
    const q = Math.max(1, conviction * cfg.qMax);

    const fair = price(spec, belief);
    const spread = computeSpread(spec, q, mmShortOf(lots, spec), belief, cfg);
    const execPrice = fair + spread.total; // trader buys at the ask
    const premium = execPrice * q;
    mmCash += premium; // MM receives the premium now
    lots.push({ spec, q, premium });
    nTrades++;

    // MM learns from the trade, then the controller folds this trade's surprise.
    const sig = extractSignal(spec, q, belief, cfg);
    belief = updateBelief(belief, sig.signal, sig.weight, cfg, opsCfg);
    if (acfg.enabled) adaptState = observeError(adaptState, Math.abs(sig.signal - mu), acfg);
  }

  // Settle at θ_true: MM pays each lot its payoff; trader profit = payoff − premium.
  let welfareSum = 0;
  for (const lot of lots) {
    const settle = payoff(lot.spec, thetaTrue) * lot.q;
    mmCash -= settle; // MM pays out
    welfareSum += settle - lot.premium;
  }

  const muFinal = belief.mean();
  const sigmaFinal = belief.stddev();
  const ciHalf = Z80 * sigmaFinal;
  const sigmaEpsFinal = acfg.enabled
    ? adaptParams(baseCfg, sigma0, adaptState, acfg).sigmaEps
    : baseCfg.sigmaEps;
  return {
    thetaTrue,
    muFinal,
    sigmaFinal,
    beliefError: Math.abs(muFinal - thetaTrue),
    inCi80: Math.abs(thetaTrue - muFinal) <= ciHalf,
    mmPnl: mmCash,
    userWelfare: lots.length > 0 ? welfareSum / lots.length : 0,
    trades: nTrades,
    sigmaEpsFinal,
    railHit,
  };
}

// mmShort for `spec` = Σ of open lot sizes on the same contract key (type+strike).
function mmShortOf(lots: OpenLot[], spec: ContractSpec): number {
  let s = 0;
  for (const l of lots) {
    if (l.spec.type === spec.type && l.spec.strike === spec.strike) s += l.q;
  }
  return s;
}

export function runMonteCarlo(params: SimParams): SimSummary {
  const seed = params.seed ?? 0xb33f;
  const sigmaObs = params.sigmaObs ?? params.sigma0;
  const kind = params.beliefKind ?? 'gaussian';
  // One seeded RNG threads the whole experiment → fully reproducible.
  const rng = new Rng(seed);

  let errSum = 0;
  let errSqSum = 0;
  let priorErrSum = 0;
  let inCi = 0;
  let mmSum = 0;
  let welfareSum = 0;
  let sigmaEpsSum = 0;
  let railHits = 0;

  for (let i = 0; i < params.runs; i++) {
    const r = simulateRun(params, rng);
    errSum += r.beliefError;
    errSqSum += r.beliefError * r.beliefError;
    priorErrSum += Math.abs(params.mu0 - r.thetaTrue);
    if (r.inCi80) inCi++;
    mmSum += r.mmPnl;
    welfareSum += r.userWelfare;
    sigmaEpsSum += r.sigmaEpsFinal;
    if (r.railHit) railHits++;
  }

  const n = params.runs;
  const calibration80 = inCi / n;
  return {
    runs: n,
    traders: params.traders,
    mu0: params.mu0,
    sigma0: params.sigma0,
    sigmaObs,
    seed,
    beliefKind: kind,
    adaptive: !!params.adaptive,
    meanBeliefError: errSum / n,
    rmseBeliefError: Math.sqrt(errSqSum / n),
    meanPriorError: priorErrSum / n,
    calibration80,
    calibrationError: Math.abs(calibration80 - 0.8),
    meanMmPnl: mmSum / n,
    meanUserWelfare: welfareSum / n,
    meanSigmaEpsFinal: sigmaEpsSum / n,
    railHitRate: railHits / n,
  };
}

export interface AdaptiveComparison {
  static: SimSummary;
  adaptive: SimSummary;
  calibrationErrorDelta: number;
  beliefErrorDelta: number;
  adaptiveCalibratesBetter: boolean;
}

// Run the identical scenario (same seed/flow) under static vs adaptive parameters
// and report the calibration/accuracy deltas. This is the checkpoint tool —
// in a volatile (noisy, strike-at-read) regime, adaptation keeps σ_ε from
// collapsing, so the final 80% CI stays honest and `adaptiveCalibratesBetter`.
export function compareAdaptiveVsStatic(params: Omit<SimParams, 'adaptive'>): AdaptiveComparison {
  const staticSummary = runMonteCarlo({ ...params, adaptive: false });
  const adaptiveSummary = runMonteCarlo({ ...params, adaptive: true });
  return {
    static: staticSummary,
    adaptive: adaptiveSummary,
    calibrationErrorDelta: adaptiveSummary.calibrationError - staticSummary.calibrationError,
    beliefErrorDelta: adaptiveSummary.meanBeliefError - staticSummary.meanBeliefError,
    adaptiveCalibratesBetter:
      adaptiveSummary.calibrationError <= staticSummary.calibrationError + 1e-9,
  };
}
