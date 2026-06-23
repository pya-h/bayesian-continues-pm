// Pure helpers for the admin adaptive-parameters view. Kept free of React
// so they're unit-testable: the SVG sparkline path builder, the series extractor
// and the source/rail label maps.

import type { CfgHistoryRow, MarketCfg } from './types.ts';

export const CFG_SOURCE_LABEL: Record<string, string> = {
  static: 'Static',
  adapt: 'Adapting',
  pin: 'Pinned',
  breaker: 'Rail hit',
};

export type CfgSeriesField = 'sigmaEps' | 's0' | 'alpha' | 'beta' | 'regime';

export function cfgSeries(history: CfgHistoryRow[], field: CfgSeriesField): number[] {
  return history.map((h) => h[field]);
}

// Build an SVG polyline `points` string mapping `values` into a `w×h` box with
// `pad` margin. Higher values sit higher (smaller y). A constant series is drawn
// as a flat mid-line; an empty series yields ''; a single point is centred.
export function sparkPoints(values: number[], w: number, h: number, pad = 2): string {
  const n = values.length;
  if (n === 0) return '';
  const innerW = Math.max(1, w - 2 * pad);
  const innerH = Math.max(1, h - 2 * pad);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (!(hi > lo)) {
    // Constant (or single) series — render a flat line through the middle.
    lo -= 0.5;
    hi += 0.5;
  }
  const range = hi - lo;
  const xAt = (i: number) => (n === 1 ? w / 2 : pad + (i / (n - 1)) * innerW);
  const yAt = (v: number) => h - pad - ((v - lo) / range) * innerH;
  return values.map((v, i) => `${round(xAt(i))},${round(yAt(v))}`).join(' ');
}

function round(x: number): number {
  return Math.round(x * 10) / 10;
}

export function pinnedKeys(cfg: MarketCfg): string[] {
  const p = cfg.control.pinned ?? {};
  return (['sigmaEps', 's0', 'alpha', 'beta'] as const).filter((k) => p[k] !== undefined);
}

// Compact summary of which rails are currently bound, e.g. "σ_ε hi".
export function railSummary(cfg: MarketCfg): string {
  const r = cfg.adapted.rails;
  const labels: Record<string, string> = { sigmaEps: 'σ_ε', s0: 's₀', alpha: 'α', beta: 'β' };
  const hits = (Object.keys(labels) as (keyof typeof r)[])
    .filter((k) => r[k] !== null)
    .map((k) => `${labels[k]} ${r[k]}`);
  return hits.join(', ');
}
