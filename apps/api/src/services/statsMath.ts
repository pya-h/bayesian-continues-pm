// Pure stats helpers (no DB, no IO) — the deterministic core of the StatsSvc
// kept separate so it can be unit-tested in isolation
// • seriesStats — peak / trough / max-drawdown over a PnL (or mark) time series.
// • aggregatePnl — sum realized/unrealized PnL across positions.
// • ci80 / inCi80 — the belief's 80% credible interval and a θ-containment check
// (post-hoc calibration: was the realized θ* inside it?).
// All money outputs are rounded to 8 dp (round-half-even) for consistency with the
// rest of the accounting.

import { normInv } from '@bmm/core';
import { round8 } from '@bmm/shared';

export interface SeriesStats {
  count: number;
  peak: number;
  trough: number;
  last: number;
  // Largest peak-to-trough decline along the path (≥ 0).
  maxDrawdown: number;
}

// Running-max drawdown over a value series. `maxDrawdown` is the worst drop from a
// prior running peak (always ≥ 0); `peak`/`trough` are the global extrema.
export function seriesStats(values: number[]): SeriesStats {
  if (values.length === 0) return { count: 0, peak: 0, trough: 0, last: 0, maxDrawdown: 0 };
  const first = values[0] as number;
  let peak = first;
  let trough = first;
  let runningMax = first;
  let maxDrawdown = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (v < trough) trough = v;
    if (v > runningMax) runningMax = v;
    const dd = runningMax - v;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  return {
    count: values.length,
    peak: round8(peak),
    trough: round8(trough),
    last: round8(values[values.length - 1] as number),
    maxDrawdown: round8(maxDrawdown),
  };
}

export interface PnlParts {
  realized: number;
  unrealized: number;
}

export function aggregatePnl(parts: PnlParts[]): {
  realized: number;
  unrealized: number;
  total: number;
} {
  let realized = 0;
  let unrealized = 0;
  for (const p of parts) {
    realized += p.realized;
    unrealized += p.unrealized;
  }
  return {
    realized: round8(realized),
    unrealized: round8(unrealized),
    total: round8(realized + unrealized),
  };
}

const Z80 = normInv(0.9); // ≈ 1.2815515655

// The belief's 80% credible interval [μ − z·σ, μ + z·σ].
export function ci80(mu: number, sigma: number): { lo: number; hi: number } {
  return { lo: round8(mu - Z80 * sigma), hi: round8(mu + Z80 * sigma) };
}

// Post-hoc calibration: was the realized θ inside the 80% interval?
export function inCi80(mu: number, sigma: number, theta: number): boolean {
  const { lo, hi } = ci80(mu, sigma);
  return theta >= lo && theta <= hi;
}
