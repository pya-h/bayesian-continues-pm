// The trading centerpiece. A single SVG that overlays three things on a shared
// outcome (θ) axis
// 1. the maker's live belief PDF N(μ, σ²) — filled area + mean + ±1σ band
// 2. the composed contract's payoff f(θ) — line on its own right-hand scale
// 3. the shaded "winning region" — where a holder is in-the-money
// plus draggable handles for the contract's parameters (strike / bounds / center
// / width). Belief μ/σ stream in live via props, so the curve breathes as trades
// land. All geometry comes from the pure helpers in lib/viz.ts.
// Two y-axes share the θ x-axis: the LEFT axis reads the belief as a relative
// likelihood (peak-normalised to 1.0 — its absolute density is unit-dependent and
// not meaningful to a trader), the RIGHT axis reads the contract payoff in outcome
// units. They are colour-keyed to their curves (accent = belief, green = payoff) and
// share ONE vertical transform: a common zero (centre line), one scale (left-gutter
// drag) and one shift (right-gutter drag), so the axes stay proportional and their
// zeros always coincide. Where the two lines then sit on top of each other they draw
// as complementary two-colour dashes so both stay visible. See
// .md.
// Hovering the plot shows a crosshair + a translucent readout of the exact
// (θ, belief-likelihood, payoff, plus the $1-binary unit price) under the cursor
// with a dot on each curve. The whole vertical view + hovered θ are shared with the
// CDF / price panels via the chartSync store.

import { payoff, price } from '@bmm/core';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { beliefFromView } from '../lib/beliefFromView.ts';
import {
  type ChartView,
  setChartView,
  setHoverTheta,
  useChartView,
  useHoverTheta,
} from '../lib/chartSync.ts';
import { fmt, fmtCompact, fmtPct } from '../lib/format.ts';
import { setLiveSpec } from '../lib/liveSpec.ts';
import { sweepKey, withParam } from '../lib/priceParam.ts';
import type { BeliefComponent, ContractSpec } from '../lib/types.ts';
import {
  type Domain,
  type Pt,
  clampViewMul,
  mixturePdf,
  niceDomain,
  niceTicks,
  panOffset,
  payoffCurve,
  pickHandle,
  scale,
  smoothPath,
  tickDecimals,
  toPath,
  viewDomain,
  winningRegions,
  zoomMul,
} from '../lib/viz.ts';
import { usePrefs } from '../prefs/PrefsContext.tsx';

// Axis-scale mode for the left (belief) axis. `relative` peak-normalises the curve
// to 1.0 (the unit-independent shape a trader reads); `density` shows the true
// probability density p(θ) in per-outcome-unit values (∫p dθ = 1).
type AxisMode = 'relative' | 'density';

function fmtDensity(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1000 || a < 1e-3) return v.toExponential(1);
  return v.toPrecision(3).replace(/\.?0+$/, '');
}

const W = 720;
const H = 340;
const M = { top: 30, right: 56, bottom: 34, left: 52 };
const PLOT = { l: M.left, r: W - M.right, t: M.top, b: H - M.bottom };

// Press-to-handle grab radius (viewBox px): a press this close to a handle grabs
// it instead of starting a plot pan — keeps overlapping/narrow handles reachable.
const GRAB_PX = 16;

interface Handle {
  id: string;
  value: number;
  label: string;
}

// The draggable parameters for a spec, in data (θ) units.
export function handlesFor(spec: ContractSpec): Handle[] {
  switch (spec.type) {
    case 'CALL':
    case 'PUT':
    case 'BINARY_CALL':
    case 'BINARY_PUT':
      return [{ id: 'strike', value: spec.strike, label: 'K' }];
    case 'SPREAD':
      return [
        { id: 'lower', value: spec.lower, label: 'lo' },
        { id: 'upper', value: spec.upper, label: 'hi' },
      ];
    case 'GAUSSIAN':
    case 'TENT':
    case 'SIGMOID':
      return [
        { id: 'center', value: spec.center, label: 'c' },
        { id: 'width', value: spec.center + spec.width, label: 'w' },
      ];
    case 'SKEW_GAUSSIAN':
      return [
        { id: 'center', value: spec.center, label: 'c' },
        { id: 'widthLeft', value: spec.center - spec.widthLeft, label: 'wL' },
        { id: 'widthRight', value: spec.center + spec.widthRight, label: 'wR' },
      ];
    case 'TRAPEZOID':
      return [
        { id: 'lower', value: spec.lower, label: 'lo' },
        { id: 'upper', value: spec.upper, label: 'hi' },
      ];
    default:
      return [];
  }
}

function applyHandle(spec: ContractSpec, id: string, x: number): ContractSpec {
  switch (spec.type) {
    case 'CALL':
    case 'PUT':
    case 'BINARY_CALL':
    case 'BINARY_PUT':
      return { ...spec, strike: x };
    case 'SPREAD': {
      if (id === 'lower') return { ...spec, lower: Math.min(x, spec.upper - 1e-6) };
      return { ...spec, upper: Math.max(x, spec.lower + 1e-6) };
    }
    case 'GAUSSIAN':
    case 'TENT':
    case 'SIGMOID': {
      if (id === 'center') return { ...spec, center: x };
      return { ...spec, width: Math.max(1e-6, Math.abs(x - spec.center)) };
    }
    case 'SKEW_GAUSSIAN': {
      if (id === 'center') return { ...spec, center: x };
      if (id === 'widthLeft') return { ...spec, widthLeft: Math.max(1e-6, spec.center - x) };
      return { ...spec, widthRight: Math.max(1e-6, x - spec.center) };
    }
    case 'TRAPEZOID': {
      if (id === 'lower') return { ...spec, lower: Math.min(x, spec.upper - 1e-6) };
      return { ...spec, upper: Math.max(x, spec.lower + 1e-6) };
    }
    default:
      return spec;
  }
}

function LegendItem({
  x,
  color,
  label,
  block,
  dash,
}: {
  x: number;
  color: string;
  label: string;
  block?: boolean;
  dash?: boolean;
}) {
  return (
    <g>
      {block ? (
        <rect x={x} y={9} width={14} height={9} rx={2} fill={color} opacity={0.18} />
      ) : (
        <line
          x1={x}
          x2={x + 14}
          y1={13.5}
          y2={13.5}
          stroke={color}
          strokeWidth={2.5}
          strokeDasharray={dash ? '4 2.5' : undefined}
        />
      )}
      <text x={x + 19} y={17} fontSize={11} className="fill-[var(--color-muted)]">
        {label}
      </text>
    </g>
  );
}

// Two-colour overlap: where the belief and payoff lines coincide (within TOL px) over a
// sustained run (≥ MIN_RUN samples — a bare crossing is ignored), each line is drawn
// dashed with complementary phase, so the shared stretch tiles accent/green and the
// trader can see both curves are there. Elsewhere each line is a normal solid stroke.
const OVERLAP_TOL = 2.5; // viewBox px: closer than this counts as "the same line"
const OVERLAP_MIN_RUN = 3; // samples: shorter coincidences are crossings, not overlaps
const OVERLAP_DASH = '5 5'; // 5 on / 5 off → period 10
const OVERLAP_PHASE = 5; // half a period: offsets the green line into the accent's gaps

function coalesceMask(mask: boolean[], minRun: number): boolean[] {
  const out = mask.slice();
  let i = 0;
  while (i < out.length) {
    if (!out[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && out[j]) j++;
    if (j - i < minRun) for (let k = i; k < j; k++) out[k] = false;
    i = j;
  }
  return out;
}

// Split a polyline into contiguous runs tagged by their overlap flag, seeding each new
// run with the previous point so the rendered segments join seamlessly.
function splitRuns(points: Pt[], mask: boolean[]): { over: boolean; pts: Pt[] }[] {
  const runs: { over: boolean; pts: Pt[] }[] = [];
  const first = points[0];
  if (!first) return runs;
  let curOver = mask[0] ?? false;
  let cur: Pt[] = [first];
  for (let i = 1; i < points.length; i++) {
    const o = mask[i] ?? false;
    const p = points[i];
    if (!p) continue;
    if (o !== curOver) {
      runs.push({ over: curOver, pts: cur });
      cur = [points[i - 1] as Pt, p]; // boundary point joins the runs
      curOver = o;
    } else {
      cur.push(p);
    }
  }
  runs.push({ over: curOver, pts: cur });
  return runs;
}

function BeliefChartImpl({
  mu,
  sigma,
  components,
  beliefKind,
  nu,
  genExact,
  showCdf = false,
  showPrice = false,
  spec: specProp,
  onSpecChange,
  outcomeUnit,
  outcomeMin,
  outcomeMax,
  thetaStar,
}: {
  mu: number;
  sigma: number;
  components?: BeliefComponent[];
  // Belief kind, so a Student-t / Gen·exact belief draws its true curve (not a Gaussian).
  beliefKind?: 'gaussian' | 'mixture' | 'student_t' | 'gen_exact';
  // Degrees of freedom ν, present (and used) only for a Student-t belief.
  nu?: number;
  // Gen·exact location/scale + exponent shape, present only for a Gen·exact belief.
  genExact?: { loc: number; scale: number; lambdas: [number, number, number] };
  // Overlay the cumulative-probability curve P(≤θ) on the same axes (0→1, peak-normalised height).
  showCdf?: boolean;
  // Overlay the fair-price-vs-strike curve on its own scale (what the contract costs if its strike/center sat at θ).
  showPrice?: boolean;
  spec: ContractSpec;
  onSpecChange: (s: ContractSpec) => void;
  outcomeUnit: string;
  outcomeMin: number | null;
  outcomeMax: number | null;
  thetaStar?: number | null;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const dragId = useRef<string | null>(null);
  // The hovered outcome θ is SHARED (chartSync store) so a hover here marks the same
  // θ on the CDF / price panels and vice-versa. `hoverVy` is local — the pointer's
  // y, used only to place THIS chart's readout card; it's null when the hover
  // originated on another (panel) chart, in which case we draw the marker but no card.
  const hoverTheta = useHoverTheta();
  const [hoverVy, setHoverVy] = useState<number | null>(null);
  // Left-axis scale: relative likelihood (peak = 1, default) vs absolute density.
  const [axisMode, setAxisMode] = useState<AxisMode>('relative');
  // Right-click context menu (fit / reset / manual ranges) + the help popover, both
  // HTML overlays positioned over the SVG. `menu` carries its host-relative position.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [help, setHelp] = useState(false);

  // User view transform layered on the auto-derived domain. xMul/yMul widen (>1)
  // or tighten (<1) the visible value RANGE of each axis; xOff slides the x-window
  // without changing its span. SHARED via chartSync so the panels pan/zoom in
  // lock-step. Defaults are the identity view; double-click resets.
  const view = useChartView();
  const setView = setChartView;
  // Subscribe to display prefs: the formatters (fmt/fmtCompact) read module-level
  // precision/compact globals that memo can't see — context bypasses the memo
  // so a prefs change re-renders the chart's tick labels immediately.
  usePrefs();
  // True while any drag (handle OR axis pan/scale) is live — used to shed the
  // costly glow filter and coarsen the curves so dragging stays smooth.
  const [dragging, setDragging] = useState(false);
  // While a handle is dragged we render from this LOCAL spec and only push the
  // result to the parent on release — so a drag re-renders the chart, not the
  // whole market page (which is what made dragging lag).
  const [dragSpec, setDragSpec] = useState<ContractSpec | null>(null);
  const spec = dragSpec ?? specProp;

  const handles = handlesFor(spec);
  const kinks = handles.map((h) => h.value);
  const kinkKey = kinks.join(',');

  // Auto domain from the belief (+ contract kinks), then the user view transform.
  // biome-ignore lint/correctness/useExhaustiveDependencies: kinkKey encodes kinks
  const base = useMemo(
    () => niceDomain(mu, sigma, { kinks, min: outcomeMin, max: outcomeMax }),
    [mu, sigma, kinkKey, outcomeMin, outcomeMax],
  );
  const domain = useMemo<Domain>(
    () => viewDomain(base, view, outcomeMin, outcomeMax),
    [base, view, outcomeMin, outcomeMax],
  );
  const [lo, hi] = domain;
  const sx = scale(lo, hi, PLOT.l, PLOT.r);

  // Coarser sampling mid-drag keeps re-renders cheap; full detail at rest.
  const samples = dragging ? 96 : 160;

  // Reconstruct the market's REAL belief (any kind) so the curve is the true
  // probability density p(θ) — not a peak-normalised kernel. This makes the
  // absolute-density axis mode meaningful for every kind (mixture / Student-t /
  // Gen·exact included), and the relative mode renders identically (the peak
  // normalisation below is a constant rescale).
  const isMixture = !!components && components.length > 1;
  const compKey = components?.map((c) => `${c.pi},${c.mu},${c.sigma}`).join('|') ?? '';
  const genExactKey = genExact
    ? `${genExact.loc},${genExact.scale},${genExact.lambdas.join(',')}`
    : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: compKey/genExactKey encode components/genExact
  const beliefModel = useMemo(
    () =>
      beliefFromView({
        kind: beliefKind ?? 'gaussian',
        mu,
        sigma,
        sigma2: sigma * sigma,
        components,
        nu,
        lambdas: genExact?.lambdas,
        loc: genExact?.loc,
        scale: genExact?.scale,
      }),
    [beliefKind, mu, sigma, compKey, nu, genExactKey],
  );
  const pdf = useMemo<Pt[]>(() => {
    const [plo, phi] = domain;
    const out: Pt[] = [];
    for (let i = 0; i <= samples; i++) {
      const x = plo + ((phi - plo) * i) / samples;
      out.push({ x, y: beliefModel.pdf(x) });
    }
    return out;
  }, [beliefModel, domain, samples]);
  const pdfMax = Math.max(...pdf.map((p) => p.y), 1e-12);

  // Optional cumulative-probability overlay P(≤θ): shares the x-domain (so it pans /
  // zooms / re-units with everything else) and the shared vertical transform below, on
  // its own 0→1 probability calibration. Sampled only when shown.
  const cdf = useMemo<Pt[]>(() => {
    if (!showCdf) return [];
    const [plo, phi] = domain;
    const out: Pt[] = [];
    for (let i = 0; i <= samples; i++) {
      const x = plo + ((phi - plo) * i) / samples;
      out.push({ x, y: Math.min(1, Math.max(0, beliefModel.cdf(x))) });
    }
    return out;
  }, [showCdf, beliefModel, domain, samples]);

  // Payoff curve and its value range across the visible domain.
  const pay = useMemo(() => payoffCurve(spec, domain, samples), [spec, domain, samples]);
  const payMin = Math.min(...pay.map((p) => p.y));
  let payMax = Math.max(...pay.map((p) => p.y));
  if (payMax - payMin < 1e-9) payMax = payMin + 1; // flat payoff guard

  // Optional fair-price overlay: at each θ, the model price of THIS contract with its
  // strike/center moved to θ — the same sweep the price-vs-strike panel draws, priced
  // against the real belief. Memoised on the spec
  // SHAPE (sweepKey) + belief + domain. During ANY drag (handle OR pan/zoom) the domain
  // shifts every frame, so the sweep re-prices each frame; we coarsen it then — hard for
  // a Student-t where each price is a 4000-node quadrature — and snap back at rest.
  const expensive = beliefKind === 'student_t';
  const priceN = dragging ? (expensive ? 24 : 64) : samples;
  const priceShapeKey = sweepKey(spec);
  // biome-ignore lint/correctness/useExhaustiveDependencies: priceShapeKey/spec.type encode the spec shape
  const priceCurve = useMemo<Pt[]>(() => {
    if (!showPrice) return [];
    const [plo, phi] = domain;
    const out: Pt[] = [];
    for (let i = 0; i <= priceN; i++) {
      const x = plo + ((phi - plo) * i) / priceN;
      const s = withParam(spec, x);
      if (s) out.push({ x, y: price(s, beliefModel) });
    }
    return out;
  }, [showPrice, priceShapeKey, spec.type, beliefModel, domain, priceN]);
  const hasPrice = showPrice && priceCurve.length > 0; // LINEAR has no strike param
  const priceMin = hasPrice ? Math.min(...priceCurve.map((p) => p.y)) : 0;
  let priceMax = hasPrice ? Math.max(...priceCurve.map((p) => p.y)) : 1;
  if (priceMax - priceMin < 1e-9) priceMax = priceMin + 1; // flat-price guard

  // ── unified vertical mapping ───────────────────────────────────────────────
  // ONE shared zero + ONE scale (view.yMul) + ONE shift (view.yOff, viewBox px) drive
  // EVERY curve, so the left (belief) and right (payoff) axes stay proportional and their
  // ZEROS always coincide. By DEFAULT zero sits on the bottom axis (0-based, positive
  // values only); the right gutter shifts it (sliding negative payoff into view below
  // zero) and the left gutter scales every curve together. Each curve is normalised by
  // its own full-scale magnitude, so at the identity view it fills the plot from the zero
  // line up. Double-click "fit" picks a scale/shift framing every curve (negatives too).
  // Units differ (likelihood vs payoff), so equal VALUES needn't share a height — but
  // their zeros do, and both react identically to any scale/shift. See
  // .md.
  const PLOT_H = PLOT.b - PLOT.t;
  const yZero = PLOT.b + view.yOff; // zero line — default: the bottom axis
  const gain = PLOT_H / view.yMul; // px that one full magnitude spans (yMul>1 = zoom out)
  const vAxis = (mag: number) => {
    const m = Math.max(mag, 1e-12);
    return (v: number) => yZero - (v / m) * gain;
  };
  const axisValueAt = (mag: number, ypx: number) => ((yZero - ypx) / gain) * Math.max(mag, 1e-12);

  // Each curve's full-scale magnitude (a little headroom so the extreme isn't flush to an
  // edge). Belief & CDF are ≥0; payoff & price normalise by their largest absolute reach
  // so a sign change straddles zero (its negative side appears once zero is shifted up).
  const beliefMag = pdfMax * 1.06;
  const cdfMag = 1.04;
  const payMag = Math.max(Math.abs(payMin), Math.abs(payMax), 1e-9) * 1.06;
  const priceMag = Math.max(Math.abs(priceMin), Math.abs(priceMax), 1e-9) * 1.06;
  const syPdf = vAxis(beliefMag);
  const syCdf = vAxis(cdfMag);
  const syPay = vAxis(payMag);
  const syPrice = vAxis(priceMag);

  // Where do the belief and payoff lines coincide on screen? (For the two-colour render.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: syPdf/syPay/payoff are pure in (yZero, gain, mags, spec, beliefModel)
  const overlap = useMemo(() => {
    const bMask = pdf.map((p) => Math.abs(syPdf(p.y) - syPay(payoff(spec, p.x))) < OVERLAP_TOL);
    const pMask = pay.map((p) => Math.abs(syPay(p.y) - syPdf(beliefModel.pdf(p.x))) < OVERLAP_TOL);
    return {
      bMask: coalesceMask(bMask, OVERLAP_MIN_RUN),
      pMask: coalesceMask(pMask, OVERLAP_MIN_RUN),
    };
  }, [pdf, pay, yZero, gain, beliefMag, payMag, spec, beliefModel]);

  const regions = winningRegions(spec, domain);
  const xTicks = niceTicks(lo, hi, 6);
  // θ-axis label precision tracks the zoom: integers when wide, decimals when the
  // window is tight. The live hover readout gets one extra digit (it's a precise
  // pointer value, not a round tick).
  const xDec = tickDecimals(xTicks, lo, hi);
  const xDecHover = Math.min(6, xDec + 1);
  // Right-axis ticks span the payoff values currently visible (bottom px → top px)
  // so they re-label correctly as the shared scale/shift moves the curve.
  const payAxisLo = axisValueAt(payMag, PLOT.b);
  const payAxisHi = axisValueAt(payMag, PLOT.t);
  const payTicks = niceTicks(payAxisLo, payAxisHi, 5);
  const payZeroInRange = payAxisLo <= 0 && 0 <= payAxisHi;

  // Left-axis (belief) ticks are likewise computed over the VISIBLE range so the whole
  // axis is numbered at every scale/shift (not just a fixed 0…1) — in relative mode the
  // labels are peak-likelihood fractions, in density mode the true density values.
  const beliefTicks = (() => {
    const densTop = axisValueAt(beliefMag, PLOT.t);
    const densBot = axisValueAt(beliefMag, PLOT.b);
    if (axisMode === 'density') {
      return niceTicks(densBot, densTop, 5).map((d) => ({ y: syPdf(d), label: fmtDensity(d) }));
    }
    return niceTicks(densBot / pdfMax, densTop / pdfMax, 5).map((t) => ({
      y: syPdf(t * pdfMax),
      label: t.toFixed(2),
    }));
  })();

  // viewBox-space pointer position (so we can map both x→θ and keep the cursor y).
  const pointerToView = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return {
      vx: ((clientX - rect.left) / rect.width) * W,
      vy: ((clientY - rect.top) / rect.height) * H,
    };
  }, []);

  const pointerToData = useCallback(
    (clientX: number): number => {
      const v = pointerToView(clientX, 0);
      if (!v) return 0;
      const dataX = lo + ((v.vx - PLOT.l) / (PLOT.r - PLOT.l)) * (hi - lo);
      return Math.min(hi, Math.max(lo, dataX));
    },
    [lo, hi, pointerToView],
  );

  // gestures: handle drag, plus pan / scale on the axes and plot ----------
  // A pan/scale gesture captures the view + geometry at press time and is applied
  // as an absolute delta from there, so coalesced (rAF-batched) moves stay correct.
  const gesture = useRef<{
    kind: 'panx' | 'scalex' | 'scaley' | 'shifty';
    startX: number;
    startY: number;
    base: ChartView;
    dataSpan: number;
    plotPxW: number;
    vbPerPxY: number;
  } | null>(null);
  // A handle drag is absolute too: apply the pointer-x to the spec captured at
  // press time. `dragLatest` is what we commit to the parent on release.
  const dragBaseSpec = useRef<ContractSpec | null>(null);
  const dragLatest = useRef<ContractSpec | null>(null);
  const raf = useRef<number | null>(null);
  const lastPt = useRef<{ x: number; y: number } | null>(null);

  const beginGesture = (kind: 'panx' | 'scalex' | 'scaley' | 'shifty', e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = svg.getBoundingClientRect();
    gesture.current = {
      kind,
      startX: e.clientX,
      startY: e.clientY,
      base: { ...view },
      dataSpan: hi - lo,
      plotPxW: (rect.width * (PLOT.r - PLOT.l)) / W,
      vbPerPxY: H / Math.max(1, rect.height),
    };
    clearHover();
    setDragging(true);
    svg.setPointerCapture?.(e.pointerId);
  };

  const applyGesture = (clientX: number, clientY: number) => {
    const g = gesture.current;
    if (!g) return;
    const dx = clientX - g.startX;
    const dy = clientY - g.startY;
    if (g.kind === 'panx') {
      // Content follows the finger: drag left → the window slides to higher θ.
      setView({ ...g.base, xOff: panOffset(g.base.xOff, dx, g.dataSpan, g.plotPxW) });
    } else if (g.kind === 'scalex') {
      // Drag right → tighten the x range (zoom in); drag left → widen it.
      setView({ ...g.base, xMul: zoomMul(g.base.xMul, -dx / 220) });
    } else if (g.kind === 'scaley') {
      // LEFT gutter: drag up → tighten the (shared) y range, every curve grows together.
      setView({ ...g.base, yMul: zoomMul(g.base.yMul, dy / 200) });
    } else {
      // RIGHT gutter: drag vertically → shift every curve together (content follows the
      // finger), preserving shape. Clamped so the plot can't be slid fully off-screen.
      const limit = PLOT.b - PLOT.t;
      const yOff = Math.max(-limit, Math.min(limit, g.base.yOff + dy * g.vbPerPxY));
      setView({ ...g.base, yOff });
    }
  };

  // Clear BOTH the shared hovered-θ and this chart's local card anchor.
  const clearHover = () => {
    setHoverTheta(null);
    setHoverVy(null);
  };

  const updateHover = (clientX: number, clientY: number) => {
    const v = pointerToView(clientX, clientY);
    if (!v || v.vx < PLOT.l - 2 || v.vx > PLOT.r + 2 || v.vy < PLOT.t - 2 || v.vy > PLOT.b + 2) {
      clearHover();
      return;
    }
    const theta = Math.min(
      hi,
      Math.max(lo, lo + ((v.vx - PLOT.l) / (PLOT.r - PLOT.l)) * (hi - lo)),
    );
    setHoverTheta(theta); // publish to the panels
    setHoverVy(v.vy); // local: where to anchor THIS chart's readout card
  };

  // Begin dragging a contract handle. The drag stays local (dragSpec) until release.
  const startHandleDrag = (id: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragId.current = id;
    dragBaseSpec.current = spec;
    dragLatest.current = null;
    clearHover();
    setDragging(true);
    svgRef.current?.setPointerCapture?.(e.pointerId);
  };
  const onPointerDown = (id: string) => (e: React.PointerEvent) => startHandleDrag(id, e);

  // A press on the plot interior (handles and axis zones stop propagation, so they
  // never reach here). If it lands near a handle, grab that handle — this keeps
  // overlapping/narrow handles (e.g. a min-width bell) reachable instead of the
  // press falling through to a pan. Otherwise start an x-pan.
  const onBackgroundDown = (e: React.PointerEvent) => {
    const v = pointerToView(e.clientX, e.clientY);
    if (!v || v.vx < PLOT.l || v.vx > PLOT.r || v.vy < PLOT.t || v.vy > PLOT.b) return;
    const idx = pickHandle(
      handles.map((h) => sx(Math.min(hi, Math.max(lo, h.value)))),
      v.vx,
      GRAB_PX,
    );
    const picked = handles[idx];
    if (picked) startHandleDrag(picked.id, e);
    else beginGesture('panx', e);
  };

  // All movement is coalesced to at most one update per animation frame.
  const onPointerMove = (e: React.PointerEvent) => {
    lastPt.current = { x: e.clientX, y: e.clientY };
    if (raf.current != null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      const p = lastPt.current;
      if (!p) return;
      if (dragId.current && dragBaseSpec.current) {
        const next = applyHandle(dragBaseSpec.current, dragId.current, pointerToData(p.x));
        dragLatest.current = next;
        setDragSpec(next);
        setLiveSpec(next); // feed the live-preview panel without re-rendering the page
      } else if (gesture.current) applyGesture(p.x, p.y);
      else updateHover(p.x, p.y);
    });
  };

  const endDrag = () => {
    // Commit a handle drag to the parent once, on release.
    if (dragId.current && dragLatest.current) onSpecChange(dragLatest.current);
    dragId.current = null;
    dragBaseSpec.current = null;
    dragLatest.current = null;
    gesture.current = null;
    setDragging(false);
    setDragSpec(null);
    setLiveSpec(null); // drag over → preview falls back to the committed spec
  };
  const onPointerUp = () => endDrag();
  const onLeave = () => {
    endDrag();
    clearHover();
  };
  // Reset to the default 0-based view (zero on the bottom axis, identity scale/shift).
  const resetView = () => setView({ xMul: 1, xOff: 0, yMul: 1, yOff: 0 });

  // Fit Y: pick a shared scale + shift that frames every visible curve — including any
  // negative payoff/price the 0-based default hides below the axis. Each curve's reach
  // is taken in its own normalised units (value / magnitude), the union of those is
  // mapped into the plot with a small margin, and we back out (yMul, yOff). X is left as
  // the user set it. Bound to double-click and the context menu.
  const fitY = () => {
    const margin = 0.06;
    const reach: { hi: number; lo: number }[] = [
      { hi: pdfMax / beliefMag, lo: 0 },
      { hi: payMax / payMag, lo: payMin / payMag },
    ];
    if (showCdf) reach.push({ hi: 1 / cdfMag, lo: 0 });
    if (hasPrice) reach.push({ hi: priceMax / priceMag, lo: priceMin / priceMag });
    let U = Number.NEGATIVE_INFINITY;
    let L = Number.POSITIVE_INFINITY;
    for (const r of reach) {
      U = Math.max(U, r.hi);
      L = Math.min(L, r.lo, 0); // always keep the zero line in view
    }
    const span = U - L;
    if (!(span > 0)) return resetView();
    const nextMul = clampViewMul(span / (1 - 2 * margin));
    const g = PLOT_H / nextMul;
    const yZeroFit = PLOT.t + PLOT_H * margin + g * U;
    setView({ ...view, yMul: nextMul, yOff: yZeroFit - PLOT.b });
  };

  // Apply manual axis ranges from the context menu: an x-window [x0,x1] in θ and a
  // y-window [y0,y1] in PAYOFF (right-axis) units — the belief/CDF/price axes follow
  // proportionally off the shared transform. Solved back into (xMul,xOff,yMul,yOff).
  const applyRanges = (x0: number, x1: number, y0: number, y1: number) => {
    const [bx0, bx1] = base;
    const bspan = bx1 - bx0;
    const xMul = bspan > 0 ? clampViewMul(Math.abs(x1 - x0) / bspan) : 1;
    const xOff = (x0 + x1) / 2 - (bx0 + bx1) / 2;
    const yMul = clampViewMul(Math.max(Math.abs(y1 - y0), 1e-9) / payMag);
    const g = PLOT_H / yMul;
    const yOff = (Math.min(y0, y1) / payMag) * g;
    setView({ xMul, xOff, yMul, yOff });
    setMenu(null);
  };

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const host = hostRef.current;
    if (!host) return;
    const r = host.getBoundingClientRect();
    setMenu({ x: e.clientX - r.left, y: e.clientY - r.top });
  };

  // Drop any pending frame on unmount, and clear any live-preview drag spec.
  useEffect(
    () => () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
      setLiveSpec(null);
    },
    [],
  );

  // Crosshair / readout geometry, derived from the SHARED hovered θ (which may come
  // from this chart or from a synced panel). The marker (crosshair + curve dots) shows
  // for any in-domain θ; the readout CARD only when the pointer is over THIS chart
  // (hoverVy set) — a panel-originated hover gets the marker but not our card.
  const cross = (() => {
    if (hoverTheta == null || hoverTheta < lo || hoverTheta > hi) return null;
    const theta = hoverTheta;
    const tpx = sx(theta);
    const pdfV = beliefModel.pdf(theta); // true density at θ (any belief kind)
    // The market's assessed chance the outcome lands at-or-below / at-or-above θ.
    const cdfBelow = Math.min(1, Math.max(0, beliefModel.cdf(theta)));
    const payV = payoff(spec, theta);
    const priceSpec = hasPrice ? withParam(spec, theta) : null;
    const priceV = priceSpec ? price(priceSpec, beliefModel) : null;
    const card = hoverVy != null; // self-hover → draw the readout card
    const cardW = 172; // wider: the P(≤/≥θ) rows also show the implied $1-binary unit price
    const cardH = (showPrice && priceV != null ? 114 : 96) as number;
    // Anchor vertically to the pointer when self-hovering, else to the belief curve.
    const anchorY = hoverVy != null ? hoverVy : syPdf(pdfV);
    const hv = Math.min(PLOT.b, Math.max(PLOT.t, anchorY));
    let tx = tpx + 12;
    if (tx + cardW > PLOT.r) tx = tpx - 12 - cardW;
    if (tx < PLOT.l + 2) tx = PLOT.l + 2;
    const ty = Math.min(PLOT.b - cardH, Math.max(PLOT.t, hv - cardH / 2));
    return {
      theta,
      tpx,
      like: Math.min(1, pdfV / pdfMax),
      density: pdfV,
      cdfBelow,
      cdfAbove: 1 - cdfBelow,
      payV,
      priceV,
      by: syPdf(pdfV),
      py: syPay(payV),
      pyPrice: priceV != null ? syPrice(priceV) : 0,
      card,
      tx,
      ty,
      cardW,
      cardH,
    };
  })();

  return (
    <div ref={hostRef} className="relative" onContextMenu={openMenu}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className={`w-full touch-none select-none ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        role="img"
        aria-label="Belief density and contract payoff"
        onPointerDown={onBackgroundDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onLeave}
        onDoubleClick={fitY}
      >
        <title>Belief PDF and payoff overlay</title>

        <defs>
          {/* vertical glow gradient for the belief area fill */}
          <linearGradient id="bc-belief-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.34} />
            <stop offset="55%" stopColor="var(--color-accent)" stopOpacity={0.12} />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
          </linearGradient>
          {/* soft neon glow for the curve strokes */}
          <filter id="bc-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation={2.4} result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* framed plot area */}
        <rect
          x={PLOT.l}
          y={PLOT.t}
          width={PLOT.r - PLOT.l}
          height={PLOT.b - PLOT.t}
          rx={5}
          fill="var(--color-panel-2)"
          opacity={0.35}
        />

        {/* legend */}
        <LegendItem
          x={PLOT.l}
          color="var(--color-accent)"
          label={axisMode === 'density' ? 'Belief (density)' : 'Belief (likelihood)'}
        />
        <LegendItem x={PLOT.l + 168} color="var(--color-buy)" label="Payoff" />
        <LegendItem x={PLOT.l + 268} color="var(--color-buy)" label="In-the-money" block />
        {showCdf && <LegendItem x={PLOT.l + 392} color="var(--color-warn)" label="P(≤θ)" dash />}
        {hasPrice && (
          <LegendItem
            x={PLOT.l + (showCdf ? 452 : 392)}
            color="var(--color-price)"
            label="Price"
            dash
          />
        )}

        {/* left-axis scale toggle (icons, in the top margin so curves never sit on it):
          outline hump = relative likelihood (shape, peak = 1); filled hump = absolute
          density (area = probability mass). Hover each for a tooltip. */}
        <g transform={`translate(${PLOT.r - 52}, 1)`}>
          {(
            [
              ['relative', 'Relative likelihood — peak normalised to 1'],
              ['density', 'Absolute probability density (∫ p dθ = 1)'],
            ] as const
          ).map(([m, tip], i) => {
            const active = axisMode === m;
            const bx = i * 20;
            const ink = active ? 'var(--color-ink)' : 'var(--color-muted)';
            return (
              <g
                key={m}
                className="cursor-pointer"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setAxisMode(m);
                }}
              >
                <title>{tip}</title>
                <rect
                  x={bx}
                  y={0}
                  width={18}
                  height={16}
                  rx={4}
                  fill={active ? 'var(--color-accent)' : 'var(--color-panel-2)'}
                  opacity={active ? 0.9 : 0.5}
                  stroke="var(--color-edge)"
                  strokeWidth={1}
                />
                {m === 'relative' ? (
                  <path
                    d={`M${bx + 4} 12 Q${bx + 9} 3 ${bx + 14} 12`}
                    fill="none"
                    stroke={ink}
                    strokeWidth={1.5}
                    strokeLinecap="round"
                  />
                ) : (
                  <path
                    d={`M${bx + 4} 12 Q${bx + 9} 3 ${bx + 14} 12 Z`}
                    fill={ink}
                    opacity={0.85}
                  />
                )}
              </g>
            );
          })}
        </g>

        {/* horizontal gridlines at the (dynamic) left-axis ticks, clipped to the plot */}
        {beliefTicks.map((t) =>
          t.y >= PLOT.t - 0.5 && t.y <= PLOT.b + 0.5 ? (
            <line
              key={`hgrid-${t.label}`}
              x1={PLOT.l}
              x2={PLOT.r}
              y1={t.y}
              y2={t.y}
              stroke="var(--color-edge)"
              strokeWidth={1}
              opacity={Math.abs(t.y - yZero) < 0.5 ? 0.7 : 0.22}
            />
          ) : null,
        )}

        {/* winning-region shading */}
        {regions.map(([a, b]) => (
          <rect
            key={`win-${a}-${b}`}
            x={sx(a)}
            y={PLOT.t}
            width={Math.max(0, sx(b) - sx(a))}
            height={PLOT.b - PLOT.t}
            fill="var(--color-buy)"
            opacity={0.1}
          />
        ))}

        {/* ±1σ band */}
        <rect
          x={sx(Math.max(lo, mu - sigma))}
          y={PLOT.t}
          width={Math.max(0, sx(Math.min(hi, mu + sigma)) - sx(Math.max(lo, mu - sigma)))}
          height={PLOT.b - PLOT.t}
          fill="var(--color-accent)"
          opacity={0.07}
        />

        {/* x-axis ticks */}
        {xTicks.map((t) => (
          <g key={`tick-${t}`}>
            <line
              x1={sx(t)}
              x2={sx(t)}
              y1={PLOT.t}
              y2={PLOT.b}
              stroke="var(--color-edge)"
              strokeWidth={1}
              opacity={0.35}
            />
            <line
              x1={sx(t)}
              x2={sx(t)}
              y1={PLOT.b}
              y2={PLOT.b + 4}
              stroke="var(--color-muted)"
              strokeWidth={1}
            />
            <text
              x={sx(t)}
              y={PLOT.b + 16}
              textAnchor="middle"
              className="fill-[var(--color-muted)]"
              fontSize={11}
            >
              {fmt(t, xDec)}
            </text>
          </g>
        ))}

        {/* left y-axis: belief likelihood / density — dynamically numbered over the view */}
        <line
          x1={PLOT.l}
          x2={PLOT.l}
          y1={PLOT.t}
          y2={PLOT.b}
          stroke="var(--color-accent)"
          strokeWidth={1}
          opacity={0.45}
        />
        {beliefTicks.map((t) =>
          t.y >= PLOT.t - 0.5 && t.y <= PLOT.b + 0.5 ? (
            <g key={`lyt-${t.label}`}>
              <line
                x1={PLOT.l - 4}
                x2={PLOT.l}
                y1={t.y}
                y2={t.y}
                stroke="var(--color-accent)"
                strokeWidth={1}
                opacity={0.6}
              />
              <text
                x={PLOT.l - 7}
                y={t.y + 3.5}
                textAnchor="end"
                className="fill-[var(--color-muted)]"
                fontSize={10}
              >
                {t.label}
              </text>
            </g>
          ) : null,
        )}

        {/* right y-axis: contract payoff (outcome units) */}
        <line
          x1={PLOT.r}
          x2={PLOT.r}
          y1={PLOT.t}
          y2={PLOT.b}
          stroke="var(--color-buy)"
          strokeWidth={1}
          opacity={0.45}
        />
        {payTicks.map((t) => (
          <g key={`ryt-${t}`}>
            <line
              x1={PLOT.r}
              x2={PLOT.r + 4}
              y1={syPay(t)}
              y2={syPay(t)}
              stroke="var(--color-buy)"
              strokeWidth={1}
              opacity={0.6}
            />
            <text
              x={PLOT.r + 7}
              y={syPay(t) + 3.5}
              textAnchor="start"
              className="fill-[var(--color-muted)]"
              fontSize={10}
            >
              {fmtCompact(t)}
            </text>
          </g>
        ))}

        {/* payoff zero baseline (where the contract pays nothing) */}
        {payZeroInRange && (
          <line
            x1={PLOT.l}
            x2={PLOT.r}
            y1={syPay(0)}
            y2={syPay(0)}
            stroke="var(--color-buy)"
            strokeWidth={1}
            strokeDasharray="2 4"
            opacity={0.4}
          />
        )}

        {/* belief PDF: smooth filled area + outline. The outline is split into runs so any
          stretch coinciding with the payoff line draws dashed (two-colour with payoff). */}
        <path
          d={`${smoothPath(pdf, sx, syPdf)} L${sx(hi).toFixed(2)} ${syPdf(0).toFixed(2)} L${sx(lo).toFixed(2)} ${syPdf(0).toFixed(2)} Z`}
          fill="url(#bc-belief-fill)"
        />
        {splitRuns(pdf, overlap.bMask).map((run) => (
          <path
            key={`belief-${run.pts[0]?.x}`}
            d={smoothPath(run.pts, sx, syPdf)}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={run.over ? OVERLAP_DASH : undefined}
            filter={dragging ? undefined : 'url(#bc-glow)'}
          />
        ))}

        {/* cumulative-probability overlay P(≤θ): a dashed S-curve on the same axes
          (0→1, sharing the vertical zoom), so it tracks every pan / zoom / unit change */}
        {showCdf && (
          <path
            className="animate-fade-in"
            d={smoothPath(cdf, sx, syCdf)}
            fill="none"
            stroke="var(--color-warn)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="5 3"
            opacity={0.9}
            filter={dragging ? undefined : 'url(#bc-glow)'}
          />
        )}

        {/* fair-price overlay: the price-vs-strike sweep on its own value scale — a
          dashed magenta curve tracking every pan / zoom, matching the price panel exactly */}
        {hasPrice && (
          <path
            className="animate-fade-in"
            d={smoothPath(priceCurve, sx, syPrice)}
            fill="none"
            stroke="var(--color-price)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="5 3"
            opacity={0.9}
            filter={dragging ? undefined : 'url(#bc-glow)'}
          />
        )}

        {/* mean line — hidden when panned/zoomed out of the visible domain (same
          guard as the θ* marker), so it never draws into the axis gutters */}
        {mu >= lo && mu <= hi && (
          <>
            <line
              x1={sx(mu)}
              x2={sx(mu)}
              y1={PLOT.t}
              y2={PLOT.b}
              stroke="var(--color-accent)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
            <text
              x={sx(mu) + 4}
              y={PLOT.t + 11}
              className="fill-[var(--color-accent)]"
              fontSize={11}
            >
              μ {fmt(mu, xDec)}
            </text>
          </>
        )}

        {/* mixture component modes — a tick at each μ_k labelled with its weight %, so
          the camps and how the order flow re-weights them are visible at a glance */}
        {isMixture &&
          components
            ?.filter((c) => c.mu >= lo && c.mu <= hi) // same visibility guard as μ/θ*
            .map((c, k) => (
              <g key={`comp-${k}-${c.mu}`} pointerEvents="none">
                <line
                  x1={sx(c.mu)}
                  x2={sx(c.mu)}
                  y1={PLOT.t + 14}
                  y2={PLOT.b}
                  stroke="var(--color-accent)"
                  strokeWidth={1}
                  strokeDasharray="2 4"
                  opacity={0.4 + 0.5 * c.pi}
                />
                <circle
                  cx={sx(c.mu)}
                  cy={syPdf(mixturePdf(c.mu, components))}
                  r={2.5}
                  fill="var(--color-accent)"
                  opacity={0.7}
                />
                <text
                  x={sx(c.mu)}
                  y={PLOT.b - 4}
                  textAnchor="middle"
                  fontSize={9}
                  className="fill-[var(--color-muted)]"
                >
                  {Math.round(c.pi * 100)}%
                </text>
              </g>
            ))}

        {/* payoff overlay — split into runs; stretches coinciding with the belief line draw
          dashed with a half-period phase, so the shared line tiles green ↔ accent */}
        {splitRuns(pay, overlap.pMask).map((run) => (
          <path
            key={`payoff-${run.pts[0]?.x}`}
            d={toPath(run.pts, sx, syPay)}
            fill="none"
            stroke="var(--color-buy)"
            strokeWidth={2}
            strokeDasharray={run.over ? OVERLAP_DASH : undefined}
            strokeDashoffset={run.over ? OVERLAP_PHASE : undefined}
            filter={dragging ? undefined : 'url(#bc-glow)'}
          />
        ))}

        {/* resolution marker */}
        {thetaStar != null && thetaStar >= lo && thetaStar <= hi && (
          <g>
            <line
              x1={sx(thetaStar)}
              x2={sx(thetaStar)}
              y1={PLOT.t}
              y2={PLOT.b}
              stroke="var(--color-warn)"
              strokeWidth={2}
            />
            <text
              x={sx(thetaStar) + 4}
              y={PLOT.b - 6}
              className="fill-[var(--color-warn)]"
              fontSize={11}
            >
              θ* {fmt(thetaStar, xDec)}
            </text>
          </g>
        )}

        {/* axis hit-zones — transparent; the cursor hints the gesture. The LEFT gutter
          scales Y (both axes together); the RIGHT gutter SHIFTS Y (slides every curve
          together); the bottom axis scales X. All stop propagation so the plot-pan never
          fires. Zero stays aligned across both axes under either y-gesture. */}
        <rect
          x={0}
          y={PLOT.t}
          width={PLOT.l}
          height={PLOT.b - PLOT.t}
          fill="transparent"
          className="cursor-ns-resize"
          onPointerDown={(e) => beginGesture('scaley', e)}
        />
        <rect
          x={PLOT.r}
          y={PLOT.t}
          width={W - PLOT.r}
          height={PLOT.b - PLOT.t}
          fill="transparent"
          className="cursor-grab"
          onPointerDown={(e) => beginGesture('shifty', e)}
        />
        <rect
          x={PLOT.l}
          y={PLOT.b}
          width={PLOT.r - PLOT.l}
          height={H - PLOT.b}
          fill="transparent"
          className="cursor-ew-resize"
          onPointerDown={(e) => beginGesture('scalex', e)}
        />

        {/* draggable handles */}
        {handles.map((h) => {
          const x = sx(Math.min(hi, Math.max(lo, h.value)));
          return (
            <g key={h.id} className="cursor-ew-resize" onPointerDown={onPointerDown(h.id)}>
              <line
                x1={x}
                x2={x}
                y1={PLOT.t}
                y2={PLOT.b}
                stroke="var(--color-buy)"
                strokeWidth={1.5}
              />
              {/* fat invisible hit-target for easy grabbing */}
              <rect x={x - 9} y={PLOT.t} width={18} height={PLOT.b - PLOT.t} fill="transparent" />
              <circle
                cx={x}
                cy={PLOT.t + 6}
                r={6}
                fill="var(--color-buy)"
                stroke="var(--color-ink)"
                strokeWidth={1.5}
              />
              <text
                x={x}
                y={PLOT.t + 9.5}
                textAnchor="middle"
                fontSize={8}
                className="fill-white font-bold"
              >
                {h.label}
              </text>
            </g>
          );
        })}

        {/* hover crosshair + readout (non-interactive, drawn on top) */}
        {cross && (
          <g pointerEvents="none">
            <line
              x1={PLOT.l}
              x2={PLOT.r}
              y1={cross.by}
              y2={cross.by}
              stroke="var(--color-fg)"
              strokeWidth={1}
              strokeDasharray="3 4"
              opacity={0.35}
            />
            <line
              x1={cross.tpx}
              x2={cross.tpx}
              y1={PLOT.t}
              y2={PLOT.b}
              stroke="var(--color-fg)"
              strokeWidth={1}
              strokeDasharray="3 4"
              opacity={0.35}
            />
            {/* θ chip on the x-axis */}
            <g>
              <rect
                x={cross.tpx - 26}
                y={PLOT.b + 3}
                width={52}
                height={15}
                rx={3}
                fill="var(--color-fg)"
                opacity={0.85}
              />
              <text
                x={cross.tpx}
                y={PLOT.b + 13.5}
                textAnchor="middle"
                fontSize={10}
                className="fill-[var(--color-ink)] font-semibold"
              >
                {fmt(cross.theta, xDecHover)}
              </text>
            </g>
            {/* curve dots */}
            <circle
              cx={cross.tpx}
              cy={cross.by}
              r={3.5}
              fill="var(--color-accent)"
              stroke="var(--color-ink)"
              strokeWidth={1.5}
            />
            <circle
              cx={cross.tpx}
              cy={cross.py}
              r={3.5}
              fill="var(--color-buy)"
              stroke="var(--color-ink)"
              strokeWidth={1.5}
            />
            {showCdf && (
              <circle
                cx={cross.tpx}
                cy={syCdf(cross.cdfBelow)}
                r={3.5}
                fill="var(--color-warn)"
                stroke="var(--color-ink)"
                strokeWidth={1.5}
              />
            )}
            {hasPrice && cross.priceV != null && (
              <circle
                cx={cross.tpx}
                cy={cross.pyPrice}
                r={3.5}
                fill="var(--color-price)"
                stroke="var(--color-ink)"
                strokeWidth={1.5}
              />
            )}
            {/* translucent readout card — only when the pointer is over THIS chart */}
            {cross.card &&
              (() => {
                const priceRow = showPrice && cross.priceV != null ? 18 : 0;
                return (
                  <g>
                    <rect
                      x={cross.tx}
                      y={cross.ty}
                      width={cross.cardW}
                      height={cross.cardH}
                      rx={6}
                      fill="var(--color-panel)"
                      stroke="var(--color-edge)"
                      strokeWidth={1}
                      opacity={0.92}
                    />
                    <text
                      x={cross.tx + 12}
                      y={cross.ty + 18}
                      fontSize={10.5}
                      className="fill-[var(--color-muted)]"
                    >
                      θ
                    </text>
                    <text
                      x={cross.tx + cross.cardW - 12}
                      y={cross.ty + 18}
                      textAnchor="end"
                      fontSize={11}
                      className="fill-[var(--color-fg)] font-semibold"
                    >
                      {fmt(cross.theta, xDecHover)}
                    </text>

                    <circle
                      cx={cross.tx + 15}
                      cy={cross.ty + 33}
                      r={3.5}
                      fill="var(--color-accent)"
                    />
                    <text
                      x={cross.tx + 24}
                      y={cross.ty + 36.5}
                      fontSize={10.5}
                      className="fill-[var(--color-muted)]"
                    >
                      Belief
                    </text>
                    <text
                      x={cross.tx + cross.cardW - 12}
                      y={cross.ty + 36.5}
                      textAnchor="end"
                      fontSize={11}
                      className="fill-[var(--color-accent)] font-semibold"
                    >
                      {axisMode === 'density' ? fmtDensity(cross.density) : cross.like.toFixed(2)}
                    </text>

                    <circle cx={cross.tx + 15} cy={cross.ty + 51} r={3.5} fill="var(--color-buy)" />
                    <text
                      x={cross.tx + 24}
                      y={cross.ty + 54.5}
                      fontSize={10.5}
                      className="fill-[var(--color-muted)]"
                    >
                      Payoff
                    </text>
                    <text
                      x={cross.tx + cross.cardW - 12}
                      y={cross.ty + 54.5}
                      textAnchor="end"
                      fontSize={11}
                      className="fill-[var(--color-buy)] font-semibold"
                    >
                      {fmtCompact(cross.payV)}
                    </text>

                    {/* fair price of the contract re-struck at θ (matches the price overlay/panel) */}
                    {priceRow > 0 && cross.priceV != null && (
                      <>
                        <circle
                          cx={cross.tx + 15}
                          cy={cross.ty + 69}
                          r={3.5}
                          fill="var(--color-price)"
                        />
                        <text
                          x={cross.tx + 24}
                          y={cross.ty + 72.5}
                          fontSize={10.5}
                          className="fill-[var(--color-muted)]"
                        >
                          Price
                        </text>
                        <text
                          x={cross.tx + cross.cardW - 12}
                          y={cross.ty + 72.5}
                          textAnchor="end"
                          fontSize={11}
                          className="fill-[var(--color-price)] font-semibold"
                        >
                          {fmtCompact(cross.priceV)}
                        </text>
                      </>
                    )}

                    {/* Unit cost: a $1 binary at θ costs its probability. P(≤θ)/P(≥θ) are
                      both the market's odds AND the price to buy $1 of "below"/"above θ". */}
                    <line
                      x1={cross.tx + 12}
                      x2={cross.tx + cross.cardW - 12}
                      y1={cross.ty + 63 + priceRow}
                      y2={cross.ty + 63 + priceRow}
                      stroke="var(--color-edge)"
                      strokeWidth={1}
                      opacity={0.6}
                    />
                    <text
                      x={cross.tx + 12}
                      y={cross.ty + 77 + priceRow}
                      fontSize={10.5}
                      className="fill-[var(--color-muted)]"
                    >
                      ≤ θ · $1 if so
                    </text>
                    <text
                      x={cross.tx + cross.cardW - 12}
                      y={cross.ty + 77 + priceRow}
                      textAnchor="end"
                      fontSize={11}
                      className="fill-[var(--color-warn)] font-semibold"
                    >
                      {`${fmtPct(cross.cdfBelow)} · $${cross.cdfBelow.toFixed(2)}`}
                    </text>
                    <text
                      x={cross.tx + 12}
                      y={cross.ty + 90 + priceRow}
                      fontSize={10.5}
                      className="fill-[var(--color-muted)]"
                    >
                      ≥ θ · $1 if so
                    </text>
                    <text
                      x={cross.tx + cross.cardW - 12}
                      y={cross.ty + 90 + priceRow}
                      textAnchor="end"
                      fontSize={11}
                      className="fill-[var(--color-warn)] font-semibold"
                    >
                      {`${fmtPct(cross.cdfAbove)} · $${cross.cdfAbove.toFixed(2)}`}
                    </text>
                  </g>
                );
              })()}
          </g>
        )}

        {/* axis captions */}
        <text
          x={PLOT.r}
          y={H - 2}
          textAnchor="end"
          className="fill-[var(--color-muted)]"
          fontSize={10}
        >
          outcome θ ({outcomeUnit})
        </text>
      </svg>

      {/* top-right help — replaces the inline gesture hint */}
      <button
        type="button"
        onClick={() => {
          setHelp((v) => !v);
          setMenu(null);
        }}
        aria-label="Chart controls help"
        className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full border border-edge bg-panel-2/80 text-[11px] font-semibold text-muted backdrop-blur transition-colors hover:border-accent/60 hover:text-fg"
      >
        ?
      </button>
      {help && <HelpPopover onClose={() => setHelp(false)} />}

      {menu && (
        <ChartMenu
          x={menu.x}
          y={menu.y}
          ranges={{ x0: lo, x1: hi, y0: payAxisLo, y1: payAxisHi }}
          outcomeUnit={outcomeUnit}
          onFit={() => {
            fitY();
            setMenu(null);
          }}
          onReset={() => {
            resetView();
            setMenu(null);
          }}
          onApply={applyRanges}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function HelpPopover({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['Drag plot', 'pan the outcome (θ) axis'],
    ['Bottom axis', 'drag to zoom θ in / out'],
    ['Left axis', 'drag to scale Y (both axes together)'],
    ['Right axis', 'drag to shift Y (slide all curves; reveals negatives)'],
    ['Double-click', 'fit every curve into view'],
    ['Right-click', 'menu — fit, reset, manual ranges'],
  ];
  return (
    <>
      <button
        type="button"
        aria-label="Close help"
        className="fixed inset-0 z-10 cursor-default"
        onClick={onClose}
      />
      <div className="surface absolute right-2 top-9 z-20 w-64 rounded-lg border border-edge bg-panel/95 p-3 text-xs shadow-soft backdrop-blur animate-pop">
        <div className="mb-1.5 font-semibold text-fg">Chart controls</div>
        <dl className="flex flex-col gap-1">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="shrink-0 font-medium text-accent">{k}</dt>
              <dd className="text-right text-muted">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  );
}

function ChartMenu({
  x,
  y,
  ranges,
  outcomeUnit,
  onFit,
  onReset,
  onApply,
  onClose,
}: {
  x: number;
  y: number;
  ranges: { x0: number; x1: number; y0: number; y1: number };
  outcomeUnit: string;
  onFit: () => void;
  onReset: () => void;
  onApply: (x0: number, x1: number, y0: number, y1: number) => void;
  onClose: () => void;
}) {
  const [manual, setManual] = useState(false);
  const f = (n: number) => (Number.isFinite(n) ? Number(n.toFixed(4)).toString() : '0');
  const [x0, setX0] = useState(f(ranges.x0));
  const [x1, setX1] = useState(f(ranges.x1));
  const [y0, setY0] = useState(f(ranges.y0));
  const [y1, setY1] = useState(f(ranges.y1));

  const apply = () => onApply(Number(x0), Number(x1), Number(y0), Number(y1));

  // Keep the menu on-screen (it's positioned host-relative; clamp the right/bottom edge).
  const left = Math.max(4, Math.min(x, 560));
  const top = Math.max(4, y);

  return (
    <>
      <button
        type="button"
        aria-label="Close menu"
        className="fixed inset-0 z-10 cursor-default"
        onClick={onClose}
      />
      <div
        className="surface absolute z-20 w-56 rounded-lg border border-edge bg-panel/95 p-1.5 text-xs shadow-soft backdrop-blur animate-pop"
        style={{ left, top }}
      >
        {!manual ? (
          <div className="flex flex-col">
            <MenuItem
              label="Fit all curves"
              hint="frame everything, incl. negatives"
              onClick={onFit}
            />
            <MenuItem label="Reset (0-based)" hint="zero on the bottom axis" onClick={onReset} />
            <MenuItem label="Manual ranges…" onClick={() => setManual(true)} />
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-1.5">
            <RangeRow label={`θ (${outcomeUnit})`} a={x0} b={x1} setA={setX0} setB={setX1} />
            <RangeRow label="payoff Y" a={y0} b={y1} setA={setY0} setB={setY1} />
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={apply}
                className="flex-1 rounded-md bg-grad-accent px-2 py-1 font-semibold text-on-accent"
              >
                Apply
              </button>
              <button
                type="button"
                onClick={() => setManual(false)}
                className="rounded-md border border-edge px-2 py-1 text-muted hover:text-fg"
              >
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function MenuItem({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-start rounded-md px-2 py-1.5 text-left transition-colors hover:bg-panel-2"
    >
      <span className="font-medium text-fg">{label}</span>
      {hint && <span className="text-[10px] text-muted">{hint}</span>}
    </button>
  );
}

function RangeRow({
  label,
  a,
  b,
  setA,
  setB,
}: {
  label: string;
  a: string;
  b: string;
  setA: (s: string) => void;
  setB: (s: string) => void;
}) {
  const cls =
    'tnum w-full rounded border border-edge bg-panel-2 px-1.5 py-1 text-xs text-fg outline-none focus:border-accent';
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <div className="flex items-center gap-1">
        <input type="number" value={a} onChange={(e) => setA(e.target.value)} className={cls} />
        <span className="text-muted">→</span>
        <input type="number" value={b} onChange={(e) => setB(e.target.value)} className={cls} />
      </div>
    </label>
  );
}

// Memoised so the live trades tape / stats refreshing the parent don't re-render
// the (heavy) chart unless its own inputs — belief, spec, or bounds — change.
export const BeliefChart = memo(BeliefChartImpl);
