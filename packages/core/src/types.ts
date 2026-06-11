// Core types: the BeliefModel interface (v2-ready), contract specs, and the
// per-market engine configuration. See and

import type { Rng } from './numerics.ts';

export type BeliefKind = 'gaussian' | 'mixture' | 'student_t';

export interface GaussianStateDTO {
  kind: 'gaussian';
  mu: number;
  sigma2: number;
}

// One Gaussian component of a mixture: weight π, mean μ, variance σ².
export interface MixtureComponentDTO {
  pi: number;
  mu: number;
  sigma2: number;
}

// Serializable snapshot of a K-component Gaussian mixture belief. Σπ_k = 1.
export interface MixtureStateDTO {
  kind: 'mixture';
  components: MixtureComponentDTO[];
}

// Serializable snapshot of a location-scale Student-t belief. scale2 = s² (not variance).
export interface StudentTStateDTO {
  kind: 'student_t';
  nu: number;
  mu: number;
  scale2: number;
}

export type BeliefStateDTO = GaussianStateDTO | MixtureStateDTO | StudentTStateDTO;

// The abstraction every pricing/solvency/stats consumer depends on. v1 ships
// GaussianBelief; v2 adds MixtureBelief / StudentTBelief behind this same shape.
export interface BeliefModel {
  readonly kind: BeliefKind;
  mean(): number;
  variance(): number;
  stddev(): number;
  pdf(theta: number): number;
  cdf(theta: number): number;
  quantile(p: number): number;
  sample(n: number, rng: Rng): number[];
  serialize(): BeliefStateDTO;
}

export type ContractType =
  | 'LINEAR'
  | 'CALL'
  | 'PUT'
  | 'BINARY_CALL'
  | 'BINARY_PUT'
  | 'SPREAD'
  | 'GAUSSIAN';

// A user-composable contract. Only the params relevant to `type` are used
// CALL/PUT/BINARY_CALL/BINARY_PUT → strike
// SPREAD → lower, upper
// GAUSSIAN → center, width
// LINEAR → (none)
export interface ContractSpec {
  type: ContractType;
  strike?: number;
  lower?: number;
  upper?: number;
  center?: number;
  width?: number;
}

// Per-market engine parameters. Defaults from live in config.ts.
// σ values here are ABSOLUTE (in outcome units), not ratios — the market layer
// derives them from μ₀/σ₀ at creation time.
export interface EngineConfig {
  sigmaMin: number; // σ_min — floor on stddev (prevents overconfidence)
  sigmaEps: number; // σ_ε — signal noise stddev
  s0: number; // base spread fraction
  gamma: number; // inventory adjustment coeff
  lambda: number; // adverse-selection coeff
  eta: number; // volatility adjustment coeff
  alpha: number; // directional signal strength (call/put/binary)
  beta: number; // linear signal strength
  qMax: number; // max trade size (normalizes intensity)
  qThreshold: number; // trade size below which belief impact ~ 0
  lr: number; // learning rate (simplified update path)
  decay: number; // uncertainty decay (simplified update path)
  reserveAlpha: number; // reserve VaR confidence (e.g. 0.99)
  useSimplifiedUpdate: boolean; // false → precision-weighted Bayes (default)
}
