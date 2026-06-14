// Belief load/save helper — the single place the API turns a market row into a
// `BeliefModel` and back. Keeps the belief-kind logic out of every service
// `loadBelief(row)` — `belief_state` present → deserialize by kind; else a
// Gaussian from `current_mu`/`current_sigma` (v1 rows, no migration needed).
// `beliefPersistFields(belief)` — the columns to write after an update
// `current_mu`/`current_sigma` always carry the summary mean/σ (so the
// μ-over-time chart, breakers, and stats keep working), and `belief_state` is
// NULL for Gaussian or the full serialized snapshot otherwise.

import {
  type BeliefModel,
  DEFAULT_MIXTURE_OPS,
  GaussianBelief,
  GenExactBelief,
  MixtureBelief,
  type MixtureOpsConfig,
  StudentTBelief,
} from '@bmm/core';
import type { BeliefStateDTO, ModelTag } from '@bmm/shared';

interface BeliefRow {
  currentMu: number;
  currentSigma: number;
  beliefState: BeliefStateDTO | null;
}

// Mixture-management config for a market's belief update. Legacy `mixture`
// markets use the shipped defaults (spawning off). A Gen·basis market turns on
// adaptive mode-spawning and relaxes the component cap, so order flow at new
// locations grows fresh modes (multi-model refactor G1). For every other model
// the value is ignored by `updateBelief` (only the mixture path reads it).
// `model` is the creator's chosen tag; null ⇒ legacy row, inferred from
// `beliefKind`. The tag — not `beliefKind` — distinguishes Gen·basis (which
// is itself stored as a `mixture`) from the plain `mixture` kind.
export const GEN_BASIS_MAX_COMPONENTS = 12;
export const GEN_BASIS_TAU_SPAWN = 3;

export function mixtureOpsFor(row: {
  model: ModelTag | null;
  beliefKind: string;
}): MixtureOpsConfig {
  const model = row.model ?? row.beliefKind;
  if (model === 'gen_basis') {
    return {
      ...DEFAULT_MIXTURE_OPS,
      allowSpawn: true,
      maxComponents: GEN_BASIS_MAX_COMPONENTS,
      tauSpawn: GEN_BASIS_TAU_SPAWN,
    };
  }
  return DEFAULT_MIXTURE_OPS;
}

export function loadBelief(row: BeliefRow): BeliefModel {
  const s = row.beliefState;
  if (!s) return new GaussianBelief(row.currentMu, row.currentSigma * row.currentSigma);
  switch (s.kind) {
    case 'gaussian':
      return GaussianBelief.fromDTO(s);
    case 'mixture':
      return MixtureBelief.fromDTO(s);
    case 'student_t':
      return StudentTBelief.fromDTO(s);
    case 'gen_exact':
      return GenExactBelief.fromDTO(s);
    default:
      throw new Error(`loadBelief: unknown belief kind ${(s as { kind: string }).kind}`);
  }
}

export interface BeliefPersistFields {
  currentMu: number;
  currentSigma: number;
  beliefState: BeliefStateDTO | null;
}

// Columns to persist for a belief: summary mean/σ + full state (NULL if Gaussian).
export function beliefPersistFields(belief: BeliefModel): BeliefPersistFields {
  return {
    currentMu: belief.mean(),
    currentSigma: belief.stddev(),
    beliefState: belief.kind === 'gaussian' ? null : (belief.serialize() as BeliefStateDTO),
  };
}
