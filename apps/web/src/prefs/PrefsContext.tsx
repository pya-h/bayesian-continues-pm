// User display preferences (theme / accent / number precision / compactness /
// motion). Persisted in localStorage and applied to <html> as data-* attributes
// plus the format-layer setters. `applyPrefs` runs once at module load — before
// React mounts — so the very first paint is already themed (no flash).

import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react';
import { setCompactNumbers, setNumberPrecision } from '../lib/format.ts';
import { DEFAULT_PREFS, type Prefs, normalizePrefs } from './themes.ts';

const STORAGE_KEY = 'bmm:prefs';

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_PREFS;
  }
}

// Push prefs into the DOM + format layer. Idempotent; safe to call in render.
function applyPrefs(p: Prefs): void {
  const root = document.documentElement;
  root.dataset.theme = p.theme;
  root.dataset.accent = p.accent;
  root.dataset.motion = p.animations ? 'on' : 'off';
  root.style.colorScheme = p.theme === 'light' ? 'light' : 'dark';
  setNumberPrecision(p.precision);
  setCompactNumbers(p.compact);
}

// Apply immediately at import time so the first render is correctly themed and
// formatters already know the chosen precision.
const INITIAL = loadPrefs();
if (typeof document !== 'undefined') applyPrefs(INITIAL);

interface PrefsState {
  prefs: Prefs;
  setPrefs: (patch: Partial<Prefs>) => void;
  reset: () => void;
}

const PrefsCtx = createContext<PrefsState | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setState] = useState<Prefs>(INITIAL);

  const commit = useCallback((next: Prefs) => {
    applyPrefs(next); // apply synchronously so formatters are correct on the next render
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable — keep the in-memory value */
    }
    setState(next);
  }, []);

  const setPrefs = useCallback(
    (patch: Partial<Prefs>) => commit(normalizePrefs({ ...prefs, ...patch })),
    [prefs, commit],
  );
  const reset = useCallback(() => commit(DEFAULT_PREFS), [commit]);

  const value = useMemo<PrefsState>(() => ({ prefs, setPrefs, reset }), [prefs, setPrefs, reset]);
  return <PrefsCtx.Provider value={value}>{children}</PrefsCtx.Provider>;
}

export function usePrefs(): PrefsState {
  const ctx = useContext(PrefsCtx);
  if (!ctx) throw new Error('usePrefs must be used within <PrefsProvider>');
  return ctx;
}
