// A tiny external store carrying the contract spec *currently being dragged* on
// the belief chart. The chart commits a drag to React state only on release (so a
// drag re-renders the chart, not the whole market page). The live-preview panel
// however, wants the in-progress spec every frame — routing that through the
// parent would re-render everything and reintroduce the drag lag.
// So the chart publishes the live spec here, and only the live-preview consumer
// (which subscribes via useSyncExternalStore) re-renders per frame. When no one is
// in live-preview mode, nothing subscribes and the publishes are a bare assignment.

import type { ContractSpec } from './types.ts';

type Listener = () => void;

let current: ContractSpec | null = null;
const listeners = new Set<Listener>();

export function setLiveSpec(spec: ContractSpec | null): void {
  if (spec === current) return;
  current = spec;
  for (const fn of listeners) fn();
}

export function subscribeLiveSpec(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getLiveSpec(): ContractSpec | null {
  return current;
}
