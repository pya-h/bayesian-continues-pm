// Belief load/save helper — the single place the API turns a market row into a
// `BeliefModel` and back. Keeps the belief-kind logic out of every service
// `loadBelief(row)` — `belief_state` present → deserialize by kind; else a
// Gaussian from `current_mu`/`current_sigma` (v1 rows, no migration needed).
// `beliefPersistFields(belief)` — the columns to write after an update
// `current_mu`/`current_sigma` always carry the summary mean/σ (so the
// μ-over-time chart, breakers, and stats keep working), and `belief_state` is
// NULL for Gaussian or the full serialized snapshot otherwise.

import { type BeliefModel, GaussianBelief, MixtureBelief, StudentTBelief } from '@bmm/core';
import type { BeliefStateDTO } from '@bmm/shared';

interface BeliefRow {
  currentMu: number;
  currentSigma: number;
  beliefState: BeliefStateDTO | null;
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
