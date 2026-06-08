// Theme + accent catalogues for the Preferences panel. The swatch colours here
// are only for the picker UI; the real palettes live as CSS variables in
// index.css and are selected by the `data-theme` / `data-accent` attributes.

export type ThemeId = 'dark' | 'midnight' | 'slate' | 'light';
export type AccentId = 'blue' | 'violet' | 'emerald' | 'amber' | 'rose' | 'cyan';

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  swatch: [string, string, string];
}

export interface AccentMeta {
  id: AccentId;
  label: string;
  color: string;
}

export const THEMES: ThemeMeta[] = [
  { id: 'dark', label: 'Dark', swatch: ['#0b0e14', '#161b27', '#dfe5f0'] },
  { id: 'midnight', label: 'Midnight', swatch: ['#060812', '#131a30', '#e7ecf9'] },
  { id: 'slate', label: 'Slate', swatch: ['#0c0e12', '#1b1f27', '#e4e8f0'] },
  { id: 'light', label: 'Light', swatch: ['#eef1f7', '#ffffff', '#1a2233'] },
];

export const ACCENTS: AccentMeta[] = [
  { id: 'blue', label: 'Blue', color: '#5b8cff' },
  { id: 'violet', label: 'Violet', color: '#8b7cff' },
  { id: 'emerald', label: 'Emerald', color: '#2fb37a' },
  { id: 'amber', label: 'Amber', color: '#e0a948' },
  { id: 'rose', label: 'Rose', color: '#f2607d' },
  { id: 'cyan', label: 'Cyan', color: '#2bb6c4' },
];

export interface Prefs {
  theme: ThemeId;
  accent: AccentId;
  precision: number;
  compact: boolean;
  animations: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'dark',
  accent: 'blue',
  precision: 2,
  compact: true,
  animations: true,
};

const THEME_IDS = new Set(THEMES.map((t) => t.id));
const ACCENT_IDS = new Set(ACCENTS.map((a) => a.id));

export function normalizePrefs(raw: unknown): Prefs {
  const p = (raw ?? {}) as Partial<Prefs>;
  return {
    theme: THEME_IDS.has(p.theme as ThemeId) ? (p.theme as ThemeId) : DEFAULT_PREFS.theme,
    accent: ACCENT_IDS.has(p.accent as AccentId) ? (p.accent as AccentId) : DEFAULT_PREFS.accent,
    precision:
      typeof p.precision === 'number' && Number.isFinite(p.precision)
        ? Math.max(0, Math.min(6, Math.round(p.precision)))
        : DEFAULT_PREFS.precision,
    compact: typeof p.compact === 'boolean' ? p.compact : DEFAULT_PREFS.compact,
    animations: typeof p.animations === 'boolean' ? p.animations : DEFAULT_PREFS.animations,
  };
}
