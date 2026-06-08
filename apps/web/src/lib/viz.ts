// Pure chart geometry for the belief-PDF / payoff visualisation. No React, no IO.
// Faithfulness matters more than novelty: payoff sampling and tail probabilities
// reuse `@bmm/core` (`payoff`, `Phi`), so the on-chart overlay and the
// shaded-region probabilities match exactly what the pricing engine computes.

import { Phi, payoff, payoffKinks } from '@bmm/core';
import type { ContractSpec } from './types.ts';

export interface Pt {
  x: number;
  y: number;
}
export type Domain = readonly [number, number];
export type Interval = readonly [number, number];

// Standard-normal-shaped density of the Gaussian belief N(μ, σ²) at x.
export function gaussianPdf(x: number, mu: number, sigma: number): number {
  const z = (x - mu) / sigma;
  return Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI));
}

// A sensible x-domain for the chart: μ ± `sigmas`·σ, widened to include any
// contract kinks (with a little padding) and clamped to the outcome bounds.
export function niceDomain(
  mu: number,
  sigma: number,
  opts: { sigmas?: number; kinks?: number[]; min?: number | null; max?: number | null } = {},
): Domain {
  const k = opts.sigmas ?? 4;
  let lo = mu - k * sigma;
  let hi = mu + k * sigma;
  for (const x of opts.kinks ?? []) {
    if (Number.isFinite(x)) {
      const pad = 0.5 * sigma;
      lo = Math.min(lo, x - pad);
      hi = Math.max(hi, x + pad);
    }
  }
  if (opts.min != null) lo = Math.max(lo, opts.min);
  if (opts.max != null) hi = Math.min(hi, opts.max);
  if (!(hi > lo)) hi = lo + Math.max(1, Math.abs(lo) * 1e-3); // never-degenerate guard
  return [lo, hi];
}

export function pdfCurve(mu: number, sigma: number, domain: Domain, n = 160): Pt[] {
  const [lo, hi] = domain;
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const x = lo + ((hi - lo) * i) / n;
    out.push({ x, y: gaussianPdf(x, mu, sigma) });
  }
  return out;
}

// Payoff polyline f(θ) over the domain. Contract kinks are injected as exact
// sample points (doubled with a hair of ε on either side) so corners stay crisp
// instead of being rounded off by the uniform grid.
export function payoffCurve(spec: ContractSpec, domain: Domain, n = 160): Pt[] {
  const [lo, hi] = domain;
  const xs = new Set<number>();
  for (let i = 0; i <= n; i++) xs.add(lo + ((hi - lo) * i) / n);
  const eps = (hi - lo) * 1e-6;
  for (const k of payoffKinks(spec)) {
    if (k > lo && k < hi) {
      xs.add(k - eps);
      xs.add(k);
      xs.add(k + eps);
    }
  }
  return [...xs].sort((a, b) => a - b).map((x) => ({ x, y: payoff(spec, x) }));
}

// The x-intervals a holder "wins" on — what the chart shades. Binary/spread give
// clean indicator intervals; CALL/PUT give the in-the-money ray; GAUSSIAN uses
// its full-width-half-maximum band (the visually meaningful core). LINEAR has no
// discrete winning region. Intervals are clipped to the visible domain.
export function winningRegions(spec: ContractSpec, domain: Domain): Interval[] {
  const [lo, hi] = domain;
  const clip = (a: number, b: number): Interval[] => {
    const aa = Math.max(a, lo);
    const bb = Math.min(b, hi);
    return bb > aa ? [[aa, bb]] : [];
  };
  switch (spec.type) {
    case 'CALL':
    case 'BINARY_CALL':
      return clip(spec.strike, hi);
    case 'PUT':
    case 'BINARY_PUT':
      return clip(lo, spec.strike);
    case 'SPREAD':
      return clip(spec.lower, spec.upper);
    case 'GAUSSIAN': {
      const hw = spec.width * Math.sqrt(2 * Math.LN2); // half-width at half-max
      return clip(spec.center - hw, spec.center + hw);
    }
    default:
      return [];
  }
}

export function probInRegions(mu: number, sigma: number, regions: Interval[]): number {
  let p = 0;
  for (const [a, b] of regions) p += Phi((b - mu) / sigma) - Phi((a - mu) / sigma);
  return Math.min(1, Math.max(0, p));
}

export function scale(domainLo: number, domainHi: number, rangeLo: number, rangeHi: number) {
  const span = domainHi - domainLo || 1;
  return (x: number) => rangeLo + ((x - domainLo) / span) * (rangeHi - rangeLo);
}

export function niceTicks(lo: number, hi: number, target = 5): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

export function toPath(pts: Pt[], sx: (x: number) => number, sy: (y: number) => number): string {
  if (pts.length === 0) return '';
  return pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(2)} ${sy(p.y).toFixed(2)}`)
    .join(' ');
}

// Settlement P&L of a position as a function of the outcome θ
// pnl(θ) = quantity · payoff(spec, θ) − costBasis.
// This is exactly what the holder realises if the market resolves at θ, so the
// curve *is* the trade's payoff diagram. Kinks are injected (like payoffCurve) so
// corners stay crisp.
export function pnlCurve(
  spec: ContractSpec,
  quantity: number,
  costBasis: number,
  domain: Domain,
  n = 140,
): Pt[] {
  return payoffCurve(spec, domain, n).map((p) => ({
    x: p.x,
    y: quantity * p.y - costBasis,
  }));
}

// Zero-crossings (breakevens) of a polyline, found by linear interpolation across
// each sign change. Used to mark where a position flips profit ⇄ loss.
export function zeroCrossings(pts: Pt[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!a || !b) continue;
    if ((a.y <= 0 && b.y > 0) || (a.y >= 0 && b.y < 0)) {
      const t = a.y / (a.y - b.y); // a.y + t·(b.y−a.y) = 0
      out.push(a.x + t * (b.x - a.x));
    }
  }
  return out;
}
