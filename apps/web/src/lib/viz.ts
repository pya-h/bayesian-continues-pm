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

// Location-scale Student-t belief density at x, **peak-normalised** (=1 at μ).
// `sigma` is the belief's stddev (finite for ν>2); the t's scale² is
// σ²·(ν−2)/ν. The chart's left axis is relative likelihood (peak = 1.0), so we
// return the t kernel (1 + ((x−μ)/scale)²/ν)^(−(ν+1)/2) directly — its Γ
// normalising constant cancels under the chart's own peak-normalisation, so we
// skip the lgamma an absolute density would need. Fatter tails than a Gaussian
// of equal σ; → the Gaussian shape as ν→∞.
export function studentTPdf(x: number, nu: number, mu: number, sigma: number): number {
  const scale2 = (sigma * sigma * (nu - 2)) / nu;
  const z2 = (x - mu) ** 2 / scale2;
  return (1 + z2 / nu) ** (-(nu + 1) / 2);
}

export function studentTPdfCurve(
  nu: number,
  mu: number,
  sigma: number,
  domain: Domain,
  n = 160,
): Pt[] {
  const [lo, hi] = domain;
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const x = lo + ((hi - lo) * i) / n;
    out.push({ x, y: studentTPdf(x, nu, mu, sigma) });
  }
  return out;
}

// The confining u⁶ stabiliser.
function genExactLambda6(lam3: number, lam4: number): number {
  return 0.004 + 0.06 * Math.max(0, -lam4) + 0.03 * Math.abs(lam3);
}

// Gen·exact (max-entropy exp(−poly)) belief density at x, **peak-normalised** for
// the chart's relative-likelihood axis. `loc`/`scale` are the belief's location μ /
// scale σ (not the summary mean/σ); `lambdas` is [λ₂,λ₃,λ₄]. Returns the raw kernel
// `exp(−E(u))`, `u=(x−loc)/scale`, `E(u)=½λ₂u²+λ₃u³+λ₄u⁴+λ₆u⁶`, zero outside the
// standardised support |u|>7 — the chart peak-normalises by the curve's own max (as
// it does for the Student-t kernel), so the absolute scale of the kernel is moot.
export function genExactPdf(
  x: number,
  loc: number,
  scale: number,
  lambdas: readonly [number, number, number],
): number {
  const u = (x - loc) / scale;
  if (Math.abs(u) > 7) return 0;
  const [l2, l3, l4] = lambdas;
  const l6 = genExactLambda6(l3, l4);
  const u2 = u * u;
  const e = 0.5 * l2 * u2 + l3 * u2 * u + l4 * u2 * u2 + l6 * u2 * u2 * u2;
  return Math.exp(-e);
}

// Evenly-sampled Gen·exact belief-PDF polyline over the domain (raw kernel).
export function genExactPdfCurve(
  loc: number,
  scale: number,
  lambdas: readonly [number, number, number],
  domain: Domain,
  n = 160,
): Pt[] {
  const [lo, hi] = domain;
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const x = lo + ((hi - lo) * i) / n;
    out.push({ x, y: genExactPdf(x, loc, scale, lambdas) });
  }
  return out;
}

export interface PdfComponent {
  pi: number;
  mu: number;
  sigma: number;
}

// Mixture density Σ π_k N(x; μ_k, σ_k²) — the multi-bump belief curve.
export function mixturePdf(x: number, components: readonly PdfComponent[]): number {
  let d = 0;
  for (const c of components) d += c.pi * gaussianPdf(x, c.mu, c.sigma);
  return d;
}

export function mixturePdfCurve(
  components: readonly PdfComponent[],
  domain: Domain,
  n = 160,
): Pt[] {
  const [lo, hi] = domain;
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const x = lo + ((hi - lo) * i) / n;
    out.push({ x, y: mixturePdf(x, components) });
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
    case 'TRAPEZOID':
      return clip(spec.lower, spec.upper); // the flat-top core
    case 'GAUSSIAN': {
      const hw = spec.width * Math.sqrt(2 * Math.LN2); // half-width at half-max
      return clip(spec.center - hw, spec.center + hw);
    }
    case 'SKEW_GAUSSIAN': {
      // FWHM band, asymmetric: each side uses its own width.
      const k = Math.sqrt(2 * Math.LN2);
      return clip(spec.center - spec.widthLeft * k, spec.center + spec.widthRight * k);
    }
    case 'TENT': {
      const hw = spec.width / 2; // half-max at half the base
      return clip(spec.center - hw, spec.center + hw);
    }
    case 'SIGMOID':
      return clip(spec.center, hi); // "above c, softly"
    case 'EXPONENTIAL':
      // monotone: rate>0 pays more above the center, rate<0 below it.
      return spec.rate >= 0 ? clip(spec.center, hi) : clip(lo, spec.center);
    // POLYNOMIAL has no single "winning" ray (both tails can pay) — no shading.
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

// interactive view: pan / zoom math (pure, so it can be unit-tested) -----

export const VIEW_MUL_MIN = 0.2;
export const VIEW_MUL_MAX = 8;
export const clampViewMul = (m: number): number =>
  Math.min(VIEW_MUL_MAX, Math.max(VIEW_MUL_MIN, m));

// Apply a user view transform to an auto-derived base domain
// `xMul` scales the visible RANGE about its centre (>1 widens, <1 tightens)
// `xOff` slides the window without changing its span.
// The result is kept inside [min, max] (slide the window in first, then clamp the
// span if it is wider than the bounds) and is never degenerate.
export function viewDomain(
  base: Domain,
  view: { xMul: number; xOff: number },
  min: number | null = null,
  max: number | null = null,
): Domain {
  const [lo0, hi0] = base;
  const c = (lo0 + hi0) / 2;
  const half = ((hi0 - lo0) / 2) * view.xMul;
  let lo = c + view.xOff - half;
  let hi = c + view.xOff + half;
  if (min != null && lo < min) {
    const d = min - lo;
    lo += d;
    hi += d;
  }
  if (max != null && hi > max) {
    const d = hi - max;
    lo -= d;
    hi -= d;
  }
  if (min != null) lo = Math.max(lo, min);
  if (max != null) hi = Math.min(hi, max);
  if (!(hi > lo)) hi = lo + Math.max(1, Math.abs(lo) * 1e-3);
  return [lo, hi];
}

// New range-multiplier after an exp-scaled pixel drag (so zooming feels uniform), clamped.
export function zoomMul(baseMul: number, exponent: number): number {
  return clampViewMul(baseMul * Math.exp(exponent));
}

// New x-offset (data units) after dragging the plot `dxPx` pixels: the content
// follows the finger, so dragging left (dxPx < 0) slides the window to higher θ.
export function panOffset(
  baseOff: number,
  dxPx: number,
  dataSpan: number,
  plotPxWidth: number,
): number {
  return baseOff - (dxPx * dataSpan) / Math.max(1, plotPxWidth);
}

// Which handle a plot-interior press grabs: the index of the nearest handle whose
// pixel x is within `radiusPx`, or -1 for none. Ties resolve to the LAST handle
// (it is drawn on top — e.g. a GAUSSIAN's width handle when it coincides with the
// centre handle at minimum width), so an overlapping handle is always grabbable.
export function pickHandle(handleXs: number[], pressX: number, radiusPx: number): number {
  let best = -1;
  let bestDist = radiusPx;
  for (let i = 0; i < handleXs.length; i++) {
    const xi = handleXs[i];
    if (xi === undefined) continue;
    const d = Math.abs(xi - pressX);
    if (d <= bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

// Widen a base domain just enough to keep a point `p` in view, extending only the
// side `p` overshoots and adding a small fractional margin so the point never sits
// flush against the edge. A no-op when `p` is already inside — used by the price-
// vs-strike chart so the composed-parameter dot follows a drag past the auto range.
export function fitPointDomain(base: Domain, p: number, margin = 0.06): Domain {
  let [lo, hi] = base;
  const m = Math.max(Math.abs(hi - lo) * margin, 1e-6);
  if (p < lo) lo = p - m;
  if (p > hi) hi = p + m;
  return [lo, hi];
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

// How many fraction digits an axis label needs at the current zoom, derived from
// the tick spacing: a step of 1 needs 0 decimals, 0.5/0.2 need 1, 0.05 needs 2
// etc. So as the x-window is zoomed into a narrow range, labels (and the hover
// readout) gain precision instead of all collapsing to the same rounded integer.
// Pure; clamped to [0, 6]. Falls back to a quarter-span step if <2 ticks.
export function tickDecimals(ticks: number[], lo: number, hi: number): number {
  const step =
    ticks.length >= 2 ? Math.abs((ticks[1] as number) - (ticks[0] as number)) : (hi - lo) / 4;
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  return Math.min(6, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
}

export function toPath(pts: Pt[], sx: (x: number) => number, sy: (y: number) => number): string {
  if (pts.length === 0) return '';
  return pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(2)} ${sy(p.y).toFixed(2)}`)
    .join(' ');
}

// Smooth SVG path through points using a SHAPE-PRESERVING monotone cubic (Fritsch–
// Carlson tangents), emitted as cubic béziers. Unlike a plain Catmull-Rom it never
// overshoots between samples — so a belief bump or a CDF's S never bulges below 0 or
// past 1 — which makes it safe for the smooth curves (belief / CDF / price). Points
// must be x-increasing (they are: every smoothed curve is sampled left→right). Falls
// back to a straight segment for <3 points. Operates on the pixel-mapped points.
export function smoothPath(
  pts: Pt[],
  sx: (x: number) => number,
  sy: (y: number) => number,
): string {
  const n = pts.length;
  if (n === 0) return '';
  const X = pts.map((p) => sx(p.x));
  const Y = pts.map((p) => sy(p.y));
  if (n < 3) return toPath(pts, sx, sy);

  // Secant slopes between consecutive points.
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = (X[i + 1] as number) - (X[i] as number);
    dx.push(h);
    slope.push(h !== 0 ? ((Y[i + 1] as number) - (Y[i] as number)) / h : 0);
  }
  // Tangents: average of adjacent secants, then the Fritsch–Carlson monotonicity clamp.
  const m: number[] = new Array(n);
  m[0] = slope[0] as number;
  m[n - 1] = slope[n - 2] as number;
  for (let i = 1; i < n - 1; i++) {
    const s0 = slope[i - 1] as number;
    const s1 = slope[i] as number;
    m[i] = s0 * s1 <= 0 ? 0 : (s0 + s1) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    const s = slope[i] as number;
    if (s === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = (m[i] as number) / s;
    const b = (m[i + 1] as number) / s;
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * s;
      m[i + 1] = t * b * s;
    }
  }

  let d = `M${(X[0] as number).toFixed(2)} ${(Y[0] as number).toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] as number;
    const x1 = (X[i] as number) + h / 3;
    const y1 = (Y[i] as number) + ((m[i] as number) * h) / 3;
    const x2 = (X[i + 1] as number) - h / 3;
    const y2 = (Y[i + 1] as number) - ((m[i + 1] as number) * h) / 3;
    d += ` C${x1.toFixed(2)} ${y1.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)} ${(X[i + 1] as number).toFixed(2)} ${(Y[i + 1] as number).toFixed(2)}`;
  }
  return d;
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

// belief ghost trail ----------------------------------------------

export interface GhostInput {
  // Stable label/key for the snapshot (an ISO timestamp in practice).
  t: string;
  pdf: (x: number) => number;
}

export interface GhostPolyline {
  t: string;
  // Stroke opacity: a monotone ramp from `minOpacity` (oldest) … `maxOpacity` (newest).
  opacity: number;
  newest: boolean;
  pts: Pt[];
}

export interface GhostTrailOpts {
  samples?: number;
  maxGhosts?: number;
  minOpacity?: number;
  maxOpacity?: number;
}

// Build the belief "ghost trail": N faded PDF polylines from a time-ordered snapshot
// series (oldest → newest), so the bump visibly drifts/narrows over the market's life
// with time encoded as opacity. Pure — no React, no IO, no mutation of the input.
// **Thinning:** the series is reduced to at most `maxGhosts` snapshots, evenly
// spaced by index and ALWAYS keeping the newest (and, when >1, the oldest).
// **Shared normalisation:** every selected curve is divided by the SAME peak (the
// max density across the selected set — the current/narrowest belief in the usual
// narrowing case), so a past *wider* belief draws as a *lower, broader* bump and the
// shrink-and-sharpen is visible as height, not just width. Nothing exceeds 1.
// **Opacity:** a monotone non-decreasing ramp old→new; a lone snapshot gets `maxOpacity`.
export function ghostTrail(
  series: readonly GhostInput[],
  domain: Domain,
  opts: GhostTrailOpts = {},
): GhostPolyline[] {
  const { samples = 120, maxGhosts = 8, minOpacity = 0.1, maxOpacity = 0.85 } = opts;
  const n = series.length;
  if (n === 0) return [];

  // Thin to ≤ maxGhosts evenly-spaced indices, endpoints included (0 … n-1).
  const k = Math.min(maxGhosts, n);
  const picks: number[] = [];
  if (k === 1) {
    picks.push(n - 1); // a lone ghost is the newest snapshot
  } else {
    for (let j = 0; j < k; j++) picks.push(Math.round((j * (n - 1)) / (k - 1)));
  }
  const idxs = [...new Set(picks)].sort((a, b) => a - b); // dedupe + ascending
  const m = idxs.length;

  const [lo, hi] = domain;
  const curves = idxs.map((si) => {
    const s = series[si] as GhostInput;
    const pts: Pt[] = [];
    for (let i = 0; i <= samples; i++) {
      const x = lo + ((hi - lo) * i) / samples;
      pts.push({ x, y: s.pdf(x) });
    }
    return pts;
  });

  // One shared denominator so relative heights (shrinkage) are honest across ghosts.
  let peak = 0;
  for (const c of curves) for (const p of c) if (p.y > peak) peak = p.y;
  const denom = peak > 0 ? peak : 1;

  return curves.map((pts, j) => {
    const newest = j === m - 1;
    const frac = m === 1 ? 1 : j / (m - 1);
    return {
      t: (series[idxs[j] as number] as GhostInput).t,
      opacity: minOpacity + (maxOpacity - minOpacity) * frac,
      newest,
      pts: pts.map((p) => ({ x: p.x, y: p.y / denom })),
    };
  });
}

// Linearly blend two index-aligned polylines (same x-grid) on their y-values
// `(1−f)·a + f·b`. The two ghost curves from `ghostTrail` share an x-grid and a
// common peak-normalisation, so blending them yields a valid in-between belief
// shape — the basis for the timeline's smooth snapshot-to-snapshot morph. `f` is
// clamped to [0,1]; x is taken from `a`. No mutation.
export function lerpPolyline(a: readonly Pt[], b: readonly Pt[], f: number): Pt[] {
  const t = f < 0 ? 0 : f > 1 ? 1 : f;
  const n = Math.min(a.length, b.length);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const pa = a[i] as Pt;
    const pb = b[i] as Pt;
    out.push({ x: pa.x, y: pa.y + (pb.y - pa.y) * t });
  }
  return out;
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
