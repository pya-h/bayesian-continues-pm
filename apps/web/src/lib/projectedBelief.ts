// External store carrying the *projected next belief point* for the prospective
// order in the trade panel — the belief μ ± σ that would result if the order
// filled. The quote panel produces it (live during a drag, or on-drop); the
// belief-over-time chart consumes it to draw a "next" ghost point.
// Routed through a store (not props) for the same reason as the live-spec store
// during a live-preview drag it updates every frame, and we don't want that to
// re-render the whole market page — only the small history chart that subscribes.

export interface ProjectedBelief {
  mu: number;
  sigma: number;
}

type Listener = () => void;

let current: ProjectedBelief | null = null;
const listeners = new Set<Listener>();

export function setProjectedBelief(next: ProjectedBelief | null): void {
  // Shallow-equal guard: don't wake subscribers when nothing actually moved.
  if (next === current) return;
  if (next && current && next.mu === current.mu && next.sigma === current.sigma) return;
  current = next;
  for (const fn of listeners) fn();
}

export function subscribeProjectedBelief(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getProjectedBelief(): ProjectedBelief | null {
  return current;
}
