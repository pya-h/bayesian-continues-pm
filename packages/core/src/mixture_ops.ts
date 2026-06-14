// Mixture component management.
// A mixture left unmanaged grows a component per trade and drifts toward
// degeneracy. After each Bayesian update we therefore
// • prune — drop negligible components (π < π_min), renormalize
// • merge — fuse near-duplicate components (|μ_i−μ_j| < τ·(σ_i+σ_j)) by
// moment-matching, so K stays bounded and modes stay distinct
// • cap — if still over maxComponents, force-merge the closest pair until
// within the cap (bounds memory/compute regardless of flow).
// Moment-matching merge is exact on the first two moments: the fused component
// preserves the merged pair's combined weight, mean, and variance, so the whole
// mixture's mean and variance are unchanged by a merge. Pruning drops a little
// mass and renormalizes, perturbing the mean only by O(π_pruned).
// `split` is an optional, off-by-default refinement (behind a cfg flag in the
// update path): when one component must explain signals on both sides of its
// mean, splitting it into two seeded ±σ halves lets the mixture grow a new mode.

import { MixtureBelief, type MixtureComponent } from './mixture.ts';

export interface MixtureOpsConfig {
  piMin: number;
  // Merge components i,j when |μ_i − μ_j| < tauMerge·(σ_i + σ_j).
  tauMerge: number;
  maxComponents: number;
  // adaptive spawning (Gen·basis, multi-model refactor G1) ----------------
  // These drive the *update* step only (bayesUpdateMixture); the manage ops
  // (prune/merge/cap) ignore them. Optional so existing partial-config callers
  // and the shipped `mixture` kind are untouched — spawning is off unless asked.
  allowSpawn?: boolean;
  // Spawn distance: a signal farther than tauSpawn·σ_k from *every* mode is "new".
  tauSpawn?: number;
  spawnWeightMin?: number;
  // Prior weight π for a freshly-seeded component (before the responsibility step).
  spawnSeedWeight?: number;
}

export const DEFAULT_MIXTURE_OPS: MixtureOpsConfig = {
  piMin: 0.02,
  tauMerge: 0.5,
  maxComponents: 6,
  allowSpawn: false,
  tauSpawn: 3,
  spawnWeightMin: 0.1,
  spawnSeedWeight: 0.1,
};

// Moment-match two components into one (exact on weight, mean, variance).
export function mergeTwo(a: MixtureComponent, b: MixtureComponent): MixtureComponent {
  const pi = a.pi + b.pi;
  if (!(pi > 0)) throw new Error('mergeTwo: combined weight must be > 0');
  const mu = (a.pi * a.mu + b.pi * b.mu) / pi;
  // E[θ²] of the pair, then σ² = E[θ²] − μ².
  const ex2 = (a.pi * (a.sigma2 + a.mu * a.mu) + b.pi * (b.sigma2 + b.mu * b.mu)) / pi;
  const sigma2 = Math.max(ex2 - mu * mu, 1e-12);
  return { pi, mu, sigma2 };
}

// Drop components with π < π_min and renormalize. Always keeps ≥ 1 component.
export function pruneComponents(
  comps: readonly MixtureComponent[],
  piMin: number,
): MixtureComponent[] {
  let kept = comps.filter((c) => c.pi >= piMin);
  if (kept.length === 0) {
    // Everything below the floor → keep the single heaviest so we never empty out.
    let best = comps[0] as MixtureComponent;
    for (const c of comps) if (c.pi > best.pi) best = c;
    kept = [best];
  }
  const total = kept.reduce((s, c) => s + c.pi, 0);
  return kept.map((c) => ({ pi: c.pi / total, mu: c.mu, sigma2: c.sigma2 }));
}

// Symmetric merge distance |μ_i − μ_j| / (σ_i + σ_j); smaller = more mergeable.
function pairDistance(a: MixtureComponent, b: MixtureComponent): number {
  const denom = Math.sqrt(a.sigma2) + Math.sqrt(b.sigma2);
  return Math.abs(a.mu - b.mu) / (denom > 0 ? denom : 1e-12);
}

// Merge near-duplicate components (by the τ criterion), then force-merge the
// closest remaining pairs until at most `maxComponents` survive.
export function mergeComponents(
  comps: readonly MixtureComponent[],
  cfg: MixtureOpsConfig,
): MixtureComponent[] {
  let list: MixtureComponent[] = comps.map((c) => ({ ...c }));

  const closestPair = (): { i: number; j: number; d: number } | null => {
    let best: { i: number; j: number; d: number } | null = null;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = pairDistance(list[i] as MixtureComponent, list[j] as MixtureComponent);
        if (!best || d < best.d) best = { i, j, d };
      }
    }
    return best;
  };

  while (list.length > 1) {
    const pair = closestPair();
    if (!pair) break;
    const a = list[pair.i] as MixtureComponent;
    const b = list[pair.j] as MixtureComponent;
    const qualifies =
      Math.abs(a.mu - b.mu) < cfg.tauMerge * (Math.sqrt(a.sigma2) + Math.sqrt(b.sigma2));
    const overCap = list.length > cfg.maxComponents;
    if (!qualifies && !overCap) break; // distinct enough and within cap → done
    const merged = mergeTwo(a, b);
    list = list.filter((_, k) => k !== pair.i && k !== pair.j);
    list.push(merged);
  }
  return list;
}

export function manageMixture(
  belief: MixtureBelief,
  cfg: MixtureOpsConfig = DEFAULT_MIXTURE_OPS,
): MixtureBelief {
  const pruned = pruneComponents(belief.components, cfg.piMin);
  const merged = mergeComponents(pruned, cfg);
  return new MixtureBelief(merged);
}

// Split one component into two seeded halves at μ ± σ/√2, sharing its weight.
// Moment-preserving like mergeTwo: halves of variance σ²/2 offset by ±σ/√2 keep the
// mean and give combined variance σ²/2 + σ²/2 = σ². Optional (off by default)
// lets a single over-stretched component grow into two modes.
export function splitComponent(c: MixtureComponent): [MixtureComponent, MixtureComponent] {
  const offset = Math.sqrt(c.sigma2 / 2);
  const halfVar = Math.max(c.sigma2 / 2, 1e-12);
  return [
    { pi: c.pi / 2, mu: c.mu - offset, sigma2: halfVar },
    { pi: c.pi / 2, mu: c.mu + offset, sigma2: halfVar },
  ];
}
