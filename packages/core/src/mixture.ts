// MixtureBelief — a K-component Gaussian mixture belief, p(θ) = Σ π_k N(θ; μ_k, σ_k²).
// The V2 headline: unlike a single Gaussian it can hold genuine
// multi-modality (two camps that disagree stay as two bumps instead of averaging
// into a mushy middle.md ).
// Implements the same BeliefModel contract as GaussianBelief, so every pricing /
// solvency / stats caller is untouched
// mean / variance via the law of total variance
// pdf / cdf as the weight-sum of component normals
// quantile by monotone bisection on the cdf (no closed form for a mixture)
// sample by picking a component ∝ π_k then drawing from it.

import { Phi, type Rng, phi } from './numerics.ts';
import type { BeliefModel, MixtureComponentDTO, MixtureStateDTO } from './types.ts';

export interface MixtureComponent {
  pi: number;
  mu: number;
  sigma2: number;
}

export class MixtureBelief implements BeliefModel {
  readonly kind = 'mixture' as const;
  // Components with weights normalized so Σπ_k = 1 (enforced in the constructor).
  readonly components: readonly MixtureComponent[];

  constructor(components: MixtureComponent[]) {
    if (components.length === 0) {
      throw new Error('MixtureBelief: needs at least one component');
    }
    let wsum = 0;
    for (const c of components) {
      if (!(c.pi >= 0) || !Number.isFinite(c.pi)) {
        throw new Error(`MixtureBelief: weight π must be ≥ 0 and finite, got ${c.pi}`);
      }
      if (!(c.sigma2 > 0) || !Number.isFinite(c.sigma2)) {
        throw new Error(`MixtureBelief: σ² must be > 0 and finite, got ${c.sigma2}`);
      }
      if (!Number.isFinite(c.mu)) throw new Error(`MixtureBelief: μ must be finite, got ${c.mu}`);
      wsum += c.pi;
    }
    if (!(wsum > 0)) throw new Error('MixtureBelief: total weight must be > 0');
    // Normalize defensively so the Σπ=1 invariant always holds, even after the
    // component-management ops (prune/merge) feed us slightly off-sum weights.
    this.components = components.map((c) => ({ pi: c.pi / wsum, mu: c.mu, sigma2: c.sigma2 }));
  }

  static fromDTO(dto: MixtureStateDTO): MixtureBelief {
    return new MixtureBelief(dto.components.map((c) => ({ pi: c.pi, mu: c.mu, sigma2: c.sigma2 })));
  }

  mean(): number {
    let m = 0;
    for (const c of this.components) m += c.pi * c.mu;
    return m;
  }

  variance(): number {
    // Law of total variance: Var = Σπ_k(σ_k² + μ_k²) − (Σπ_k μ_k)².
    const m = this.mean();
    let ex2 = 0;
    for (const c of this.components) ex2 += c.pi * (c.sigma2 + c.mu * c.mu);
    return Math.max(0, ex2 - m * m);
  }

  stddev(): number {
    return Math.sqrt(this.variance());
  }

  pdf(theta: number): number {
    let d = 0;
    for (const c of this.components) {
      const sigma = Math.sqrt(c.sigma2);
      d += c.pi * (phi((theta - c.mu) / sigma) / sigma);
    }
    return d;
  }

  cdf(theta: number): number {
    let f = 0;
    for (const c of this.components) f += c.pi * Phi((theta - c.mu) / Math.sqrt(c.sigma2));
    return f;
  }

  quantile(p: number): number {
    if (p <= 0) return Number.NEGATIVE_INFINITY;
    if (p >= 1) return Number.POSITIVE_INFINITY;
    // The cdf is continuous and strictly increasing, so bisect. Bracket from the
    // extreme component means ± a generous multiple of the widest component σ.
    let muMin = Number.POSITIVE_INFINITY;
    let muMax = Number.NEGATIVE_INFINITY;
    let sdMax = 0;
    for (const c of this.components) {
      muMin = Math.min(muMin, c.mu);
      muMax = Math.max(muMax, c.mu);
      sdMax = Math.max(sdMax, Math.sqrt(c.sigma2));
    }
    let lo = muMin - 40 * sdMax;
    let hi = muMax + 40 * sdMax;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if (this.cdf(mid) < p) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  sample(n: number, rng: Rng): number[] {
    // Cumulative weights for the categorical component pick.
    const cum = new Array<number>(this.components.length);
    let acc = 0;
    for (let k = 0; k < this.components.length; k++) {
      acc += (this.components[k] as MixtureComponent).pi;
      cum[k] = acc;
    }
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const u = rng.next();
      let k = 0;
      while (k < cum.length - 1 && u > (cum[k] as number)) k++;
      const c = this.components[k] as MixtureComponent;
      out[i] = c.mu + Math.sqrt(c.sigma2) * rng.nextNormal();
    }
    return out;
  }

  serialize(): MixtureStateDTO {
    const components: MixtureComponentDTO[] = this.components.map((c) => ({
      pi: c.pi,
      mu: c.mu,
      sigma2: c.sigma2,
    }));
    return { kind: 'mixture', components };
  }
}
