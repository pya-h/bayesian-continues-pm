// Bayesian belief update.
// Default: precision-weighted conjugate Normal–Normal update. The simplified
// learning-rate variant is available behind cfg.useSimplifiedUpdate.
// Posterior variance is floored at σ_min² to prevent overconfidence.

import { GaussianBelief } from './gaussian.ts';
import { GEN_EXACT_L, GenExactBelief, genExactShapeStats } from './gen_exact.ts';
import { MixtureBelief, type MixtureComponent } from './mixture.ts';
import { DEFAULT_MIXTURE_OPS, type MixtureOpsConfig, manageMixture } from './mixture_ops.ts';
import { placeBasisBump } from './placement.ts';
import { extractSignal } from './signal.ts';
import { StudentTBelief } from './student_t.ts';
import type { BeliefModel, ContractSpec, EngineConfig } from './types.ts';

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

// Bayesian update for a Gen·exact (max-entropy exp(−poly)) belief — v1: **fixed
// shape**. The exponent coefficients λ (the *shape*) are held constant; only the
// location μ and scale σ move, exactly like the Student-t path: moment-match to a
// Gaussian of the same variance, do the precision-weighted conjugate step in the
// **variance domain**, then map the posterior variance back to a σ at fixed shape
// (variance ∝ σ² for a fixed standardised density, so σ' = σ·√(Var'/Var)).
// Shape-adapting (re-fitting λ₃,λ₄ to the post-update skew/kurtosis) is the
// deferred v2 moment-projection step; v1 keeps the authored shape.
export function bayesUpdateGenExact(
  belief: GenExactBelief,
  signal: number,
  weight: number,
  cfg: EngineConfig,
): GenExactBelief {
  const sigmaMin2 = cfg.sigmaMin * cfg.sigmaMin;
  const priorVar = belief.variance();
  const lambdas = belief.lambdas;

  // Rescale σ so the belief variance becomes `targetVar`, keeping the shape fixed.
  // λ is unchanged, so the cached standardised moments stay valid — propagate them
  // (I3) to skip the normalisation quadrature on the posterior belief too.
  const withVariance = (mu: number, targetVar: number): GenExactBelief => {
    const sigmaNew = belief.sigma * Math.sqrt(Math.max(targetVar, sigmaMin2) / priorVar);
    return new GenExactBelief(mu, sigmaNew, lambdas, belief.moments);
  };

  if (weight <= 0) {
    // No information → unchanged shape/location, but respect the variance floor.
    return withVariance(belief.mu, Math.max(priorVar, sigmaMin2));
  }

  if (cfg.useSimplifiedUpdate) {
    const muNew = belief.mu + cfg.lr * (signal - belief.mu) * weight;
    return withVariance(muNew, priorVar * (1 - cfg.decay * weight));
  }

  // Precision-weighted update in the variance domain.
  const precisionPrior = 1 / priorVar;
  const precisionSignal = weight / (cfg.sigmaEps * cfg.sigmaEps);
  const total = precisionPrior + precisionSignal;
  const muNew = (precisionPrior * belief.mu + precisionSignal * signal) / total;
  return withVariance(muNew, 1 / total);
}

// Sandbox-safe λ ranges (mirror @bmm/shared genExactLambdasSchema; core stays
// dependency-free). The v2 shape fit clamps (λ₃,λ₄) here so a projected belief is
// always a valid, persistable Gen·exact shape.
const GEN_EXACT_LAM3_MAX = 0.35;
const GEN_EXACT_LAM4_MIN = 0;
const GEN_EXACT_LAM4_MAX = 1.6;
// Composite-Simpson node count for the v2 posterior-moment quadrature (even).
const GEN_EXACT_POST_NODES = 2000;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

// First four moments (mean, variance, skewness, excess kurtosis) of the exact
// posterior `prior(θ)·N(θ; s, σ_ℓ²)`, by Simpson quadrature over the prior support.
function genExactPosteriorMoments(
  prior: GenExactBelief,
  s: number,
  sigmaL2: number,
): { mean: number; variance: number; skew: number; exKurt: number } {
  const lo = prior.mu - GEN_EXACT_L * prior.sigma;
  const hi = prior.mu + GEN_EXACT_L * prior.sigma;
  const N = GEN_EXACT_POST_NODES;
  const h = (hi - lo) / N;
  let z = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  for (let i = 0; i <= N; i++) {
    const theta = lo + i * h;
    const d = theta - s;
    const val = prior.pdf(theta) * Math.exp(-(d * d) / (2 * sigmaL2));
    const sw = i === 0 || i === N ? 1 : i % 2 ? 4 : 2;
    const vt = val * theta;
    z += sw * val;
    s1 += sw * vt;
    s2 += sw * vt * theta;
    s3 += sw * vt * theta * theta;
    s4 += sw * vt * theta * theta * theta;
  }
  const m1 = s1 / z;
  const e2 = s2 / z;
  const e3 = s3 / z;
  const e4 = s4 / z;
  const v = Math.max(1e-12, e2 - m1 * m1);
  const mu3 = e3 - 3 * m1 * e2 + 2 * m1 * m1 * m1;
  const mu4 = e4 - 4 * m1 * e3 + 6 * m1 * m1 * e2 - 3 * m1 * m1 * m1 * m1;
  return { mean: m1, variance: v, skew: mu3 / v ** 1.5, exKurt: mu4 / (v * v) - 3 };
}

// Fit (λ₃,λ₄) — λ₂ held — so the standardised Gen·exact shape matches a target
// (skewness, excess kurtosis), via damped Gauss-Newton with a finite-difference
// Jacobian, clamped to the sandbox-safe ranges. Returns the best-seen point; an
// infeasible target projects onto the boundary. Falls back to the start on any
// non-finite step.
function fitGenExactShape(
  l2: number,
  startL3: number,
  startL4: number,
  targetSkew: number,
  targetExKurt: number,
): [number, number] {
  let l3 = clamp(startL3, -GEN_EXACT_LAM3_MAX, GEN_EXACT_LAM3_MAX);
  let l4 = clamp(startL4, GEN_EXACT_LAM4_MIN, GEN_EXACT_LAM4_MAX);
  const residual = (a: number, b: number): [number, number, number] => {
    const f = genExactShapeStats([l2, a, b]);
    const r0 = f.skew - targetSkew;
    const r1 = f.exKurt - targetExKurt;
    return [r0, r1, Math.hypot(r0, r1)];
  };
  let [, , best] = residual(l3, l4);

  const eps = 1e-3;
  for (let iter = 0; iter < 12 && best > 1e-4; iter++) {
    const f = genExactShapeStats([l2, l3, l4]);
    const r0 = f.skew - targetSkew;
    const r1 = f.exKurt - targetExKurt;
    // Forward-difference Jacobian J = ∂(skew,exKurt)/∂(λ₃,λ₄).
    const f3 = genExactShapeStats([l2, l3 + eps, l4]);
    const f4 = genExactShapeStats([l2, l3, l4 + eps]);
    const j00 = (f3.skew - f.skew) / eps;
    const j10 = (f3.exKurt - f.exKurt) / eps;
    const j01 = (f4.skew - f.skew) / eps;
    const j11 = (f4.exKurt - f.exKurt) / eps;
    const det = j00 * j11 - j01 * j10;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
    // Newton step d = −J⁻¹ r.
    const d3 = -(j11 * r0 - j01 * r1) / det;
    const d4 = -(-j10 * r0 + j00 * r1) / det;
    if (!Number.isFinite(d3) || !Number.isFinite(d4)) break;
    // Backtracking: accept the largest fraction of the step that improves the residual.
    let improved = false;
    for (let bt = 0, step = 1; bt < 4; bt++, step *= 0.5) {
      const n3 = clamp(l3 + step * d3, -GEN_EXACT_LAM3_MAX, GEN_EXACT_LAM3_MAX);
      const n4 = clamp(l4 + step * d4, GEN_EXACT_LAM4_MIN, GEN_EXACT_LAM4_MAX);
      const cand = genExactShapeStats([l2, n3, n4]);
      const norm = Math.hypot(cand.skew - targetSkew, cand.exKurt - targetExKurt);
      if (norm < best) {
        l3 = n3;
        l4 = n4;
        best = norm;
        improved = true;
        break;
      }
    }
    if (!improved) break; // at a (possibly boundary) minimum
  }
  return [l3, l4];
}

// Bayesian update for a Gen·exact belief — **v2: moment-projection (shape adapts)**
// . Assumed-density filtering: form the exact posterior
// `prior(θ)·N(θ; s, σ_ε²/w)`, take its first four moments, then project back onto
// the family — hold λ₂ (the creator's unimodal/bimodal choice), re-fit (λ₃,λ₄) to
// the posterior skew/kurtosis, and set (μ,σ) to match the posterior mean/variance.
// So order flow *sculpts* the shape (skew/tails), not just the location/scale.
// Reduces to the v1 location/scale step for a symmetric update (skew→0 keeps λ₃≈0)
// and delegates to v1 for the simplified path / zero-weight (no shape information).
export function bayesUpdateGenExactShape(
  belief: GenExactBelief,
  signal: number,
  weight: number,
  cfg: EngineConfig,
): GenExactBelief {
  // No information, or the heuristic simplified path → keep the authored shape.
  if (weight <= 0 || cfg.useSimplifiedUpdate) {
    return bayesUpdateGenExact(belief, signal, weight, cfg);
  }

  const sigmaMin2 = cfg.sigmaMin * cfg.sigmaMin;
  const sigmaL2 = (cfg.sigmaEps * cfg.sigmaEps) / weight; // likelihood variance σ_ε²/w
  const post = genExactPosteriorMoments(belief, signal, sigmaL2);

  // Project skew/kurtosis onto (λ₃,λ₄); λ₂ stays fixed.
  const [l2] = belief.lambdas;
  const [, l3Start, l4Start] = belief.lambdas;
  const [l3, l4] = fitGenExactShape(l2, l3Start, l4Start, post.skew, post.exKurt);
  const lambdas: [number, number, number] = [l2, l3, l4];

  // Map posterior mean/variance back to (μ,σ) at the fitted shape; λ changed, so the
  // moment cache is recomputed for the new shape (I3 invalidation point).
  const shape = genExactShapeStats(lambdas);
  const targetVar = Math.max(post.variance, sigmaMin2);
  const sigma = Math.sqrt(targetVar / shape.varU);
  const mu = post.mean - sigma * shape.eu;
  if (!Number.isFinite(mu) || !(sigma > 0)) {
    // Numerical degeneracy → fall back to the robust fixed-shape step.
    return bayesUpdateGenExact(belief, signal, weight, cfg);
  }
  return new GenExactBelief(mu, sigma, lambdas);
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
  if (belief.kind === 'gen_exact') {
    const b = belief as GenExactBelief;
    return cfg.genExactShapeAdapt
      ? bayesUpdateGenExactShape(b, signal, weight, cfg)
      : bayesUpdateGenExact(b, signal, weight, cfg);
  }
  throw new Error(`updateBelief: unsupported belief kind ${belief.kind}`);
}

// A trade is a Gen·basis **placement** ("paint the curve", G4) when it's a bell
// (GAUSSIAN) order on a `gen_basis` market (whose belief is always a `mixture`).
// Such a trade adds/removes mass at the bell's center rather than nudging the
// summary location via a standard signal.
function isPlacementTrade(
  spec: ContractSpec,
  belief: BeliefModel,
  model: string | null | undefined,
): boolean {
  return model === 'gen_basis' && spec.type === 'GAUSSIAN' && belief.kind === 'mixture';
}

// Signed placement strength of a bell trade: `+` a BUY (adds mass), `−` a SELL
// (removes mass); magnitude is the trade's reliability (intensity·confidence), so a
// bigger order paints a heavier stroke. Note this magnitude equals `extractSignal`'s
// weight by construction — a placement is the same conviction, applied as mass.
function placementStrength(signedQ: number, cfg: EngineConfig): number {
  const intensity = Math.min(1, Math.abs(signedQ) / cfg.qMax);
  const reliability = 1 - Math.exp(-Math.abs(signedQ) / cfg.qThreshold);
  return (signedQ >= 0 ? 1 : -1) * intensity * reliability;
}

// Belief update for a TRADE — the single entry point the trade engine (and the web
// preview) call. It extracts the signal from the contract and dispatches by kind
// with one special case: on a **Gen·basis** market a **bell (GAUSSIAN)** trade is a
// *placement* ("paint the curve", G4) — it adds/removes mass at the bell's center
// via the weight-only `placeBasisBump` so repeated bets at distinct centers grow
// distinct, persistent modes. Every other (model, contract) pair keeps the standard
// `extractSignal → updateBelief` path unchanged.
export function updateBeliefForTrade(
  spec: ContractSpec,
  signedQ: number,
  belief: BeliefModel,
  cfg: EngineConfig,
  model: string | null | undefined,
  opsCfg?: MixtureOpsConfig,
): BeliefModel {
  if (isPlacementTrade(spec, belief, model)) {
    const strength = placementStrength(signedQ, cfg);
    return placeBasisBump(belief as MixtureBelief, spec.center as number, strength, cfg, opsCfg);
  }
  const sig = extractSignal(spec, signedQ, belief, cfg);
  return updateBelief(belief, sig.signal, sig.weight, cfg, opsCfg);
}

// The (signal, weight) pair that the belief-update **audit row** should record for a
// trade — kept in lock-step with `updateBeliefForTrade` so the log reflects what was
// actually applied. For a Gen·basis **placement** (bell) the standard `extractSignal`
// is misleading (it reports a "pushed-away" location for sells and a generic
// reliability), so we instead record the placement itself: `signal` = the painted
// bell center, `weight` = the **signed** placement strength (`+` mass added, `−` mass
// removed). Every other trade falls through to `extractSignal` unchanged.
export function tradeSignal(
  spec: ContractSpec,
  signedQ: number,
  belief: BeliefModel,
  cfg: EngineConfig,
  model: string | null | undefined,
): { signal: number; weight: number } {
  if (isPlacementTrade(spec, belief, model)) {
    return { signal: spec.center as number, weight: placementStrength(signedQ, cfg) };
  }
  return extractSignal(spec, signedQ, belief, cfg);
}
