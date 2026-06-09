// useState that mirrors itself into localStorage, so per-view UI choices (sort
// order, expanded vs compact, "show closed", filter chips) survive reloads and
// navigation. Keys are namespaced under `bmm:view:` to sit alongside the global
// display `bmm:prefs`. An optional `normalize` coerces stored JSON back into a
// valid value — important for union-typed settings whose options may change
// between releases. Storage failures (private mode, quota) degrade to in-memory.

import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';

const NS = 'bmm:view:';

export function usePersistentState<T>(
  key: string,
  initial: T,
  normalize?: (raw: unknown) => T,
): [T, Dispatch<SetStateAction<T>>] {
  const storageKey = NS + key;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw == null) return initial;
      const parsed = JSON.parse(raw);
      return normalize ? normalize(parsed) : (parsed as T);
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      /* storage unavailable — keep the in-memory value */
    }
  }, [storageKey, value]);

  return [value, setValue];
}

// Build a normalizer that falls back to `fallback` unless the value is in `allowed`.
export function oneOf<T extends string>(allowed: readonly T[], fallback: T) {
  const set = new Set<string>(allowed);
  return (raw: unknown): T => (typeof raw === 'string' && set.has(raw) ? (raw as T) : fallback);
}

export function asBool(fallback: boolean) {
  return (raw: unknown): boolean => (typeof raw === 'boolean' ? raw : fallback);
}
