// @bmm/core — the pure, deterministic BMM math engine.
// IO-free and framework-free by design: no database, no network
// no `Math.random`. Everything is unit-tested in isolation and reused by v2.

export const CORE_VERSION = '0.1.0';

// numerics
export { phi, Phi, erf, erfc, normInv, Rng, SQRT2, SQRT2PI } from './numerics.ts';

// types & belief
export type {
  BeliefModel,
  BeliefKind,
  BeliefStateDTO,
  GaussianStateDTO,
  MixtureStateDTO,
  MixtureComponentDTO,
  StudentTStateDTO,
  ContractType,
  ContractSpec,
  EngineConfig,
} from './types.ts';
export { GaussianBelief } from './gaussian.ts';
export { StudentTBelief } from './student_t.ts';
export { MixtureBelief, type MixtureComponent } from './mixture.ts';
export {
  type MixtureOpsConfig,
  DEFAULT_MIXTURE_OPS,
  mergeTwo,
  pruneComponents,
  mergeComponents,
  manageMixture,
  splitComponent,
} from './mixture_ops.ts';

// config
export { DEFAULT_PARAMS, makeEngineConfig } from './config.ts';

// contracts
export {
  payoff,
  validateContract,
  contractKey,
  payoffKinks,
  payoffBounds,
  type PayoffBounds,
} from './contracts.ts';

// contract↔belief compatibility (multi-model refactor)
export {
  type TailKind,
  type ModelTag,
  BELIEF_TAIL,
  contractBeliefCompatible,
} from './compat.ts';

// pricing
export { price, dPriceDMu, priceGaussianPayoff, expectF } from './pricing.ts';

// spread
export { computeSpread, type SpreadBreakdown } from './spread.ts';

// signal & bayes
export { extractSignal, type ExtractedSignal } from './signal.ts';
export { bayesUpdate, bayesUpdateMixture, bayesUpdateStudentT, updateBelief } from './bayes.ts';

// solvency
export {
  type BookEntry,
  type ReserveOpts,
  liability,
  expectedLiability,
  requiredReserve,
  withMmShort,
  maxExecutable,
} from './solvency.ts';

// stats
export {
  type PositionInput,
  type PositionStats,
  type StatsOpts,
  positionStats,
  secondMoment,
} from './stats.ts';

// circuit breakers
export {
  type Alert,
  type AlertSeverity,
  type BreakerKind,
  type BreakerAction,
  type BreakerInput,
  type BreakerThresholds,
  DEFAULT_BREAKER_THRESHOLDS,
  evalBreakers,
} from './breakers.ts';

// monte-carlo simulation
export {
  type SimParams,
  type SimRun,
  type SimSummary,
  simulateRun,
  runMonteCarlo,
} from './sim.ts';
