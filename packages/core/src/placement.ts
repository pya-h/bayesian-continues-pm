// Placement update — "paint the curve" for Gen·basis (multi-model refactor G4).
// The bell (GAUSSIAN) contract is the placement primitive: a bell BUY at center c
// *adds mass* to the basis bump nearest c (or spawns a fresh bump there if none is
// within `tauSpawn·σ`); a bell SELL *removes mass* from the nearest bump. Crucially
// this is **weight-only and additive** — unlike the responsibility update
// (`bayesUpdateMixture`), it does NOT multiplicatively reallocate the other bumps'
// weights or drift their means. That is the difference that lets repeated bets at
// distinct locations accumulate into *distinct, persistent* modes (the responsibility
// update is consensus-forming: it collapses weight onto the most-recent camp). This
// is the design's recommended paint mechanism
// model/parametric-belief-families.md (option 3, weight-only).
// Pricing / reserve / persistence are unchanged: the result is an ordinary
// `MixtureBelief` (`Σπₖ = 1`, closed-form priced, MC-reserved).

import { MixtureBelief } from './mixture.ts';
import { DEFAULT_MIXTURE_OPS, type MixtureOpsConfig, manageMixture } from './mixture_ops.ts';
import type { EngineConfig } from './types.ts';

// Apply a placement bet to a Gen·basis (mixture) belief.
// mass). Magnitude is the trade's reliability (≈ intensity), so a
// bigger order paints a heavier stroke.
export function placeBasisBump(
  belief: MixtureBelief,
  center: number,
  strength: number,
  cfg: EngineConfig,
  opsCfg: MixtureOpsConfig = DEFAULT_MIXTURE_OPS,
): MixtureBelief {
  const sigmaMin2 = cfg.sigmaMin * cfg.sigmaMin;
  const sigmaEps2 = cfg.sigmaEps * cfg.sigmaEps;
  const mag = Math.abs(strength);

  if (!(mag > 0) || !Number.isFinite(center)) {
    // No information → unchanged shape, but respect the per-component variance floor.
    return new MixtureBelief(
      belief.components.map((c) => ({ pi: c.pi, mu: c.mu, sigma2: Math.max(c.sigma2, sigmaMin2) })),
    );
  }

  const tauSpawn = opsCfg.tauSpawn ?? 3;
  const maxK = opsCfg.maxComponents;
  const comps = belief.components.map((c) => ({ ...c }));

  // Nearest existing bump, measured in its own σ units.
  let nearest = -1;
  let minDist = Number.POSITIVE_INFINITY;
  for (let k = 0; k < comps.length; k++) {
    const c = comps[k];
    if (!c) continue;
    const d = Math.abs(center - c.mu) / Math.sqrt(c.sigma2);
    if (d < minDist) {
      minDist = d;
      nearest = k;
    }
  }

  if (strength > 0) {
    if ((nearest < 0 || minDist > tauSpawn) && comps.length < maxK) {
      // Far from every mode (or empty) → spawn a fresh bump at the placed center.
      comps.push({ pi: mag, mu: center, sigma2: Math.max(sigmaEps2, sigmaMin2) });
    } else if (nearest >= 0) {
      // Near an existing mode → reinforce it: accumulate weight, pull its mean toward
      // the placed center (weighted by the added mass). The bump's width is left as-is
      // (the placement "brush size"); only the floor is enforced.
      const c = comps[nearest] as { pi: number; mu: number; sigma2: number };
      const wNew = c.pi + mag;
      c.mu = (c.pi * c.mu + mag * center) / wNew;
      c.pi = wNew;
      c.sigma2 = Math.max(c.sigma2, sigmaMin2);
    }
  } else if (nearest >= 0 && minDist <= tauSpawn) {
    // SELL *near* an existing bump → paint it down (remove mass); manageMixture prunes
    // it once it drops below π_min, so selling a camp away erases it. Selling where
    // there is no nearby mass (minDist > tauSpawn) is a no-op — you can only erase a
    // bump you're actually on, never a distant one.
    const c = comps[nearest] as { pi: number; mu: number; sigma2: number };
    c.pi = Math.max(0, c.pi - mag);
  }

  // The MixtureBelief constructor renormalises Σπ → 1; manageMixture then prunes
  // negligible bumps, merges near-duplicates, and enforces the K-cap.
  if (comps.every((c) => !(c.pi > 0))) {
    // Sold everything down — keep the (now floored) nearest bump so the belief survives.
    const keep = comps[Math.max(0, nearest)] as { mu: number; sigma2: number };
    return manageMixture(new MixtureBelief([{ pi: 1, mu: keep.mu, sigma2: keep.sigma2 }]), opsCfg);
  }
  return manageMixture(new MixtureBelief(comps), opsCfg);
}
