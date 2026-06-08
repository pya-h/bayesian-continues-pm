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
// Note: the sim models spread income vs settlement payout (the P&L that matters
// for calibration/profitability) but does NOT run the reserve solvency gate —
// that path is exercised by the api integration tests, not this diagnostic.

import { bayesUpdate } from './bayes.ts';
import { makeEngineConfig } from './config.ts';
import { payoff } from './contracts.ts';
import { GaussianBelief } from './gaussian.ts';
import { Rng, normInv } from './numerics.ts';
import { price } from './pricing.ts';
import { extractSignal } from './signal.ts';
import { computeSpread } from './spread.ts';
import type { ContractSpec, EngineConfig } from './types.ts';

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
}

export interface SimSummary {
  runs: number;
  traders: number;
  mu0: number;
  sigma0: number;
  sigmaObs: number;
  seed: number;
  // Mean |μ_final − θ_true| across runs (lower = the engine learns).
  meanBeliefError: number;
  rmseBeliefError: number;
  // Mean genesis error |μ₀ − θ_true| — the no-learning baseline to beat.
  meanPriorError: number;
  // Fraction of runs with θ_true inside the final 80% CI (well-calibrated ≈ 0.80).
  calibration80: number;
  // Mean MM profit (should be ≥ ~0 — the MM earns the spread).
  meanMmPnl: number;
  meanUserWelfare: number;
}

interface OpenLot {
  spec: ContractSpec;
  q: number;
  premium: number; // total paid to MM (execPrice·q)
}

// One market run: θ_true is drawn, traders arrive, the MM learns, then we settle.
export function simulateRun(params: SimParams, rng: Rng): SimRun {
  const { mu0, sigma0, traders } = params;
  const sigmaObs = params.sigmaObs ?? sigma0;
  const cfg = makeEngineConfig(mu0, sigma0, params.cfg ?? {});

  const thetaTrue = mu0 + sigma0 * rng.nextNormal();

  let belief = new GaussianBelief(mu0, sigma0 * sigma0);
  let mmCash = 0; // track the *delta*: premiums collected − payouts owed
  const lots: OpenLot[] = [];
  let nTrades = 0;

  for (let i = 0; i < traders; i++) {
    const mu = belief.mu;
    const sigma = belief.stddev();
    // Trader's noisy private read of the outcome.
    const y = thetaTrue + sigmaObs * rng.nextNormal();
    const edge = y - mu;
    if (Math.abs(edge) < 1e-9) continue;

    // Bullish read → buy a CALL at the current mean; bearish → buy a PUT.
    const spec: ContractSpec = { type: edge > 0 ? 'CALL' : 'PUT', strike: mu };
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

    // MM learns from the trade.
    const sig = extractSignal(spec, q, belief, cfg);
    belief = bayesUpdate(belief, sig.signal, sig.weight, cfg);
  }

  // Settle at θ_true: MM pays each lot its payoff; trader profit = payoff − premium.
  let welfareSum = 0;
  for (const lot of lots) {
    const settle = payoff(lot.spec, thetaTrue) * lot.q;
    mmCash -= settle; // MM pays out
    welfareSum += settle - lot.premium;
  }

  const muFinal = belief.mu;
  const sigmaFinal = belief.stddev();
  const ciHalf = Z80 * sigmaFinal;
  return {
    thetaTrue,
    muFinal,
    sigmaFinal,
    beliefError: Math.abs(muFinal - thetaTrue),
    inCi80: Math.abs(thetaTrue - muFinal) <= ciHalf,
    mmPnl: mmCash,
    userWelfare: lots.length > 0 ? welfareSum / lots.length : 0,
    trades: nTrades,
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
  // One seeded RNG threads the whole experiment → fully reproducible.
  const rng = new Rng(seed);

  let errSum = 0;
  let errSqSum = 0;
  let priorErrSum = 0;
  let inCi = 0;
  let mmSum = 0;
  let welfareSum = 0;

  for (let i = 0; i < params.runs; i++) {
    const r = simulateRun(params, rng);
    errSum += r.beliefError;
    errSqSum += r.beliefError * r.beliefError;
    priorErrSum += Math.abs(params.mu0 - r.thetaTrue);
    if (r.inCi80) inCi++;
    mmSum += r.mmPnl;
    welfareSum += r.userWelfare;
  }

  const n = params.runs;
  return {
    runs: n,
    traders: params.traders,
    mu0: params.mu0,
    sigma0: params.sigma0,
    sigmaObs,
    seed,
    meanBeliefError: errSum / n,
    rmseBeliefError: Math.sqrt(errSqSum / n),
    meanPriorError: priorErrSum / n,
    calibration80: inCi / n,
    meanMmPnl: mmSum / n,
    meanUserWelfare: welfareSum / n,
  };
}
