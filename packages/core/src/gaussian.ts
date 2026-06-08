// GaussianBelief — the v1 belief model N(μ, σ²).

import { Phi, type Rng, normInv, phi } from './numerics.ts';
import type { BeliefModel, GaussianStateDTO } from './types.ts';

export class GaussianBelief implements BeliefModel {
  readonly kind = 'gaussian' as const;
  readonly mu: number;
  readonly sigma2: number;

  constructor(mu: number, sigma2: number) {
    if (!(sigma2 > 0) || !Number.isFinite(sigma2)) {
      throw new Error(`GaussianBelief: sigma2 must be > 0 and finite, got ${sigma2}`);
    }
    if (!Number.isFinite(mu)) throw new Error(`GaussianBelief: mu must be finite, got ${mu}`);
    this.mu = mu;
    this.sigma2 = sigma2;
  }

  static fromDTO(dto: GaussianStateDTO): GaussianBelief {
    return new GaussianBelief(dto.mu, dto.sigma2);
  }

  mean(): number {
    return this.mu;
  }

  variance(): number {
    return this.sigma2;
  }

  stddev(): number {
    return Math.sqrt(this.sigma2);
  }

  pdf(theta: number): number {
    const sigma = this.stddev();
    return phi((theta - this.mu) / sigma) / sigma;
  }

  cdf(theta: number): number {
    return Phi((theta - this.mu) / this.stddev());
  }

  quantile(p: number): number {
    return this.mu + this.stddev() * normInv(p);
  }

  sample(n: number, rng: Rng): number[] {
    const sigma = this.stddev();
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = this.mu + sigma * rng.nextNormal();
    return out;
  }

  serialize(): GaussianStateDTO {
    return { kind: 'gaussian', mu: this.mu, sigma2: this.sigma2 };
  }
}
