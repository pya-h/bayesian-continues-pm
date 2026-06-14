// Bayesian belief update.
// Default: precision-weighted conjugate Normal–Normal update. The simplified
// learning-rate variant is available behind cfg.useSimplifiedUpdate.
// Posterior variance is floored at σ_min² to prevent overconfidence.

import { GaussianBelief } from './gaussian.ts';
import { MixtureBelief, type MixtureComponent } from './mixture.ts';
import { DEFAULT_MIXTURE_OPS, type MixtureOpsConfig, manageMixture } from './mixture_ops.ts';
import { StudentTBelief } from './student_t.ts';
import type { BeliefModel, EngineConfig } from './types.ts';

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

// Bayesian update for a Gaussian mixture belief.
// Two coupled updates, then component management
// 1. **Membership / weight update** — treat the component label as latent with
// prior π_k. The signal's evidence under each component's predictive
// N(s; μ_k, σ_k² + σ_ε²) re-weights the mixture: π_k ← π_k · evidence_k^w
// renormalized (responsibilities r_k). A reliability-w of 0 leaves weights
// untouched; w of 1 is the full posterior over membership. This is what makes
// a consistent stream of signals **concentrate weight on the nearest mode**
// instead of averaging the modes together.
// 2. **Per-component conjugate update** — each component is pulled toward s with
// precision scaled by w·r_k, so the component that *owns* the signal absorbs
// it while the others barely move — the mechanism that keeps two camps as two
// bumps.
// 3. **Component management** — prune/merge/cap via `manageMixture`.
// Computed in log-space (log-sum-exp) so well-separated modes don't underflow.
export function bayesUpdateMixture(
  belief: MixtureBelief,
  signal: number,
  weight: number,
  cfg: EngineConfig,
  opsCfg: MixtureOpsConfig = DEFAULT_MIXTURE_OPS,
): MixtureBelief {
  const sigmaMin2 = cfg.sigmaMin * cfg.sigmaMin;
  let comps = belief.components;

  if (weight <= 0) {
    // No information → unchanged shape, but respect the per-component variance floor.
    return new MixtureBelief(
      comps.map((c) => ({ pi: c.pi, mu: c.mu, sigma2: Math.max(c.sigma2, sigmaMin2) })),
    );
  }

  const sigmaEps2 = cfg.sigmaEps * cfg.sigmaEps;
  const LOG_2PI = Math.log(2 * Math.PI);

  // 0. Adaptive mode-spawn (Gen·basis only; off for the legacy `mixture` kind).
  // A confident signal that lands farther than τ_spawn·σ_k from *every* existing
  // mode is evidence of a new camp the current mixture can't explain — seed a fresh
  // narrow component at the signal so the responsibility step below can grow a mode
  // there instead of dragging an existing one across the gap. `manageMixture` then
  // merges it straight back if it turns out redundant, or keeps it once it earns
  // responsibility. Gated under the K-cap so the parameter count stays bounded.
  if (opsCfg.allowSpawn && weight >= (opsCfg.spawnWeightMin ?? 0.1)) {
    const tauSpawn = opsCfg.tauSpawn ?? 3;
    const maxK = opsCfg.maxComponents;
    if (comps.length < maxK) {
      let minDist = Number.POSITIVE_INFINITY;
      for (const c of comps) {
        const d = Math.abs(signal - c.mu) / Math.sqrt(c.sigma2);
        if (d < minDist) minDist = d;
      }
      if (minDist > tauSpawn) {
        // Seed σ² = σ_ε² (the signal-noise scale), floored like any component.
        const seedVar = Math.max(sigmaEps2, sigmaMin2);
        const seedPi = opsCfg.spawnSeedWeight ?? 0.1;
        comps = [...comps, { pi: seedPi, mu: signal, sigma2: seedVar }];
      }
    }
  }

  // 1. Tempered log-evidence per component: w · log N(s; μ_k, σ_k² + σ_ε²).
  const logNum = new Array<number>(comps.length);
  let maxLog = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < comps.length; k++) {
    const c = comps[k] as MixtureComponent;
    const vk = c.sigma2 + sigmaEps2;
    const logEvidence = -0.5 * ((signal - c.mu) ** 2 / vk + Math.log(vk) + LOG_2PI);
    const ln = Math.log(c.pi) + weight * logEvidence;
    logNum[k] = ln;
    if (ln > maxLog) maxLog = ln;
  }
  // Normalize via log-sum-exp → responsibilities r_k.
  let z = 0;
  const r = new Array<number>(comps.length);
  for (let k = 0; k < comps.length; k++) {
    const e = Math.exp((logNum[k] as number) - maxLog);
    r[k] = e;
    z += e;
  }
  for (let k = 0; k < comps.length; k++) r[k] = (r[k] as number) / z;

  // 2. Responsibility-weighted conjugate update of each component.
  const updated: MixtureComponent[] = comps.map((c, k) => {
    const rk = r[k] as number;
    const precisionPrior = 1 / c.sigma2;
    const precisionSignal = (weight * rk) / sigmaEps2;
    const total = precisionPrior + precisionSignal;
    const mu = (precisionPrior * c.mu + precisionSignal * signal) / total;
    const sigma2 = Math.max(1 / total, sigmaMin2);
    return { pi: rk, mu, sigma2 };
  });

  // 3. Prune / merge / cap.
  return manageMixture(new MixtureBelief(updated), opsCfg);
}

// Bayesian update for a location-scale Student-t belief.
// The t with fixed ν is not self-conjugate, so we keep ν — the *structural* tail
// weight — fixed and move only the location μ and scale, applying the same
// precision-weighted step as the Gaussian path but in the **variance domain**
// (var = scale²·ν/(ν−2)). Equivalently: moment-match the prior to a Gaussian of
// the same variance, do the conjugate update, then map the posterior variance back
// to a t scale. This keeps the fat tails while learning at the Gaussian rate, and
// makes a Student-t market degrade gracefully to the Gaussian update as ν→∞.
export function bayesUpdateStudentT(
  belief: StudentTBelief,
  signal: number,
  weight: number,
  cfg: EngineConfig,
): StudentTBelief {
  const sigmaMin2 = cfg.sigmaMin * cfg.sigmaMin;
  const nu = belief.nu;
  const priorVar = belief.variance();

  if (weight <= 0) {
    // No information → unchanged location/tails, but respect the variance floor.
    return StudentTBelief.fromVariance(nu, belief.mu, Math.max(priorVar, sigmaMin2));
  }

  if (cfg.useSimplifiedUpdate) {
    const muNew = belief.mu + cfg.lr * (signal - belief.mu) * weight;
    const varNew = priorVar * (1 - cfg.decay * weight);
    return StudentTBelief.fromVariance(nu, muNew, Math.max(varNew, sigmaMin2));
  }

  // Precision-weighted update in the variance domain.
  const precisionPrior = 1 / priorVar;
  const precisionSignal = weight / (cfg.sigmaEps * cfg.sigmaEps);
  const total = precisionPrior + precisionSignal;
  const muNew = (precisionPrior * belief.mu + precisionSignal * signal) / total;
  const varNew = Math.max(1 / total, sigmaMin2);
  return StudentTBelief.fromVariance(nu, muNew, varNew);
}

// Kind-agnostic belief update — dispatches by belief kind. The API trade engine
// calls this so the update is the same regardless of belief kind.
export function updateBelief(
  belief: BeliefModel,
  signal: number,
  weight: number,
  cfg: EngineConfig,
  opsCfg?: MixtureOpsConfig,
): BeliefModel {
  if (belief.kind === 'mixture') {
    return bayesUpdateMixture(belief as MixtureBelief, signal, weight, cfg, opsCfg);
  }
  if (belief.kind === 'gaussian') {
    return bayesUpdate(belief as GaussianBelief, signal, weight, cfg);
  }
  if (belief.kind === 'student_t') {
    return bayesUpdateStudentT(belief as StudentTBelief, signal, weight, cfg);
  }
  throw new Error(`updateBelief: unsupported belief kind ${belief.kind}`);
}
