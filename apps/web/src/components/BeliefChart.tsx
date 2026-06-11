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
// units. They are colour-keyed to their curves (accent = belief, green = payoff).
// Hovering the plot shows a crosshair + a translucent readout of the exact
// (θ, belief-likelihood, payoff) under the cursor, with a dot on each curve.

import { payoff } from '@bmm/core';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmt, fmtCompact } from '../lib/format.ts';
import { setLiveSpec } from '../lib/liveSpec.ts';
import type { BeliefComponent, ContractSpec } from '../lib/types.ts';
import {
  type Domain,
  gaussianPdf,
  mixturePdf,
  mixturePdfCurve,
  niceDomain,
  niceTicks,
  panOffset,
  payoffCurve,
  pdfCurve,
  pickHandle,
  scale,
  studentTPdf,
  studentTPdfCurve,
  tickDecimals,
  toPath,
  viewDomain,
  winningRegions,
  zoomMul,
} from '../lib/viz.ts';

const W = 720;
const H = 340;
const M = { top: 30, right: 56, bottom: 34, left: 52 };
const PLOT = { l: M.left, r: W - M.right, t: M.top, b: H - M.bottom };

const LIKE_TICKS = [0, 0.25, 0.5, 0.75, 1] as const;

// Press-to-handle grab radius (viewBox px): a press this close to a handle grabs
// it instead of starting a plot pan — keeps overlapping/narrow handles reachable.
const GRAB_PX = 16;

interface Handle {
  id: string;
  value: number;
  label: string;
}

// The draggable parameters for a spec, in data (θ) units.
function handlesFor(spec: ContractSpec): Handle[] {
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
      return [
        { id: 'center', value: spec.center, label: 'c' },
        { id: 'width', value: spec.center + spec.width, label: 'w' },
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
    case 'GAUSSIAN': {
      if (id === 'center') return { ...spec, center: x };
      return { ...spec, width: Math.max(1e-6, Math.abs(x - spec.center)) };
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
}: {
  x: number;
  color: string;
  label: string;
  block?: boolean;
}) {
  return (
    <g>
      {block ? (
        <rect x={x} y={9} width={14} height={9} rx={2} fill={color} opacity={0.18} />
      ) : (
        <line x1={x} x2={x + 14} y1={13.5} y2={13.5} stroke={color} strokeWidth={2.5} />
      )}
      <text x={x + 19} y={17} fontSize={11} className="fill-[var(--color-muted)]">
        {label}
      </text>
    </g>
  );
}

function BeliefChartImpl({
  mu,
  sigma,
  components,
  beliefKind,
  nu,
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
  // Belief kind, so a Student-t belief draws its fat-tailed curve (not a Gaussian).
  beliefKind?: 'gaussian' | 'mixture' | 'student_t';
  // Degrees of freedom ν, present (and used) only for a Student-t belief.
  nu?: number;
  spec: ContractSpec;
  onSpecChange: (s: ContractSpec) => void;
  outcomeUnit: string;
  outcomeMin: number | null;
  outcomeMax: number | null;
  thetaStar?: number | null;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragId = useRef<string | null>(null);
  const [hover, setHover] = useState<{ theta: number; vy: number } | null>(null);

  // User view transform layered on the auto-derived domain. xMul/yMul widen (>1)
  // or tighten (<1) the visible value RANGE of each axis; xOff slides the x-window
  // without changing its span. Defaults are the identity view; double-click resets.
  const [view, setView] = useState({ xMul: 1, xOff: 0, yMul: 1 });
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

  // Belief PDF scale (unitless density, scaled to its own peak × yMul). A mixture
  // belief draws its true multi-bump curve, a Student-t its fat-tailed curve
  // otherwise the single Gaussian.
  const isMixture = !!components && components.length > 1;
  const isStudentT = beliefKind === 'student_t' && !!nu && nu > 2;
  const compKey = components?.map((c) => `${c.pi},${c.mu},${c.sigma}`).join('|') ?? '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: compKey encodes components
  const pdf = useMemo(() => {
    if (isMixture && components) return mixturePdfCurve(components, domain, samples);
    if (isStudentT && nu) return studentTPdfCurve(nu, mu, sigma, domain, samples);
    return pdfCurve(mu, sigma, domain, samples);
  }, [isMixture, isStudentT, nu, compKey, mu, sigma, domain, samples]);
  const pdfMax = Math.max(...pdf.map((p) => p.y), 1e-12);
  const syPdf = scale(0, pdfMax * 1.12 * view.yMul, PLOT.b, PLOT.t);

  // Payoff scale (its own min/max across the visible domain, scaled by yMul about
  // its midpoint so the zero baseline keeps its position as you scale).
  const pay = useMemo(() => payoffCurve(spec, domain, samples), [spec, domain, samples]);
  const payMin = Math.min(...pay.map((p) => p.y));
  let payMax = Math.max(...pay.map((p) => p.y));
  if (payMax - payMin < 1e-9) payMax = payMin + 1; // flat payoff guard
  const pad = (payMax - payMin) * 0.08;
  const payMid = (payMin + payMax) / 2;
  const payHalf = ((payMax - payMin) / 2 + pad) * view.yMul;
  const payAxisLo = payMid - payHalf;
  const payAxisHi = payMid + payHalf;
  const syPay = scale(payAxisLo, payAxisHi, PLOT.b, PLOT.t);

  const regions = winningRegions(spec, domain);
  const xTicks = niceTicks(lo, hi, 6);
  // θ-axis label precision tracks the zoom: integers when wide, decimals when the
  // window is tight. The live hover readout gets one extra digit (it's a precise
  // pointer value, not a round tick).
  const xDec = tickDecimals(xTicks, lo, hi);
  const xDecHover = Math.min(6, xDec + 1);
  const payTicks = niceTicks(payAxisLo, payAxisHi, 5);
  const payZeroInRange = 0 >= payAxisLo && 0 <= payAxisHi;

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
    kind: 'panx' | 'scalex' | 'scaley';
    startX: number;
    startY: number;
    base: { xMul: number; xOff: number; yMul: number };
    dataSpan: number;
    plotPxW: number;
  } | null>(null);
  // A handle drag is absolute too: apply the pointer-x to the spec captured at
  // press time. `dragLatest` is what we commit to the parent on release.
  const dragBaseSpec = useRef<ContractSpec | null>(null);
  const dragLatest = useRef<ContractSpec | null>(null);
  const raf = useRef<number | null>(null);
  const lastPt = useRef<{ x: number; y: number } | null>(null);

  const beginGesture = (kind: 'panx' | 'scalex' | 'scaley', e: React.PointerEvent) => {
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
    };
    setHover(null);
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
    } else {
      // Drag up → tighten the y range (curve grows); drag down → widen it.
      setView({ ...g.base, yMul: zoomMul(g.base.yMul, dy / 200) });
    }
  };

  const updateHover = (clientX: number, clientY: number) => {
    const v = pointerToView(clientX, clientY);
    if (!v || v.vx < PLOT.l - 2 || v.vx > PLOT.r + 2 || v.vy < PLOT.t - 2 || v.vy > PLOT.b + 2) {
      setHover((h) => (h ? null : h));
      return;
    }
    const theta = Math.min(
      hi,
      Math.max(lo, lo + ((v.vx - PLOT.l) / (PLOT.r - PLOT.l)) * (hi - lo)),
    );
    setHover({ theta, vy: v.vy });
  };

  // Begin dragging a contract handle. The drag stays local (dragSpec) until release.
  const startHandleDrag = (id: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragId.current = id;
    dragBaseSpec.current = spec;
    dragLatest.current = null;
    setHover(null);
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
    setHover(null);
  };
  const resetView = () => setView({ xMul: 1, xOff: 0, yMul: 1 });

  // Drop any pending frame on unmount, and clear any live-preview drag spec.
  useEffect(
    () => () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
      setLiveSpec(null);
    },
    [],
  );

  // Crosshair / readout geometry, derived from the hovered θ.
  const cross = (() => {
    if (!hover) return null;
    const theta = Math.min(hi, Math.max(lo, hover.theta));
    const tpx = sx(theta);
    const pdfV =
      isMixture && components
        ? mixturePdf(theta, components)
        : isStudentT && nu
          ? studentTPdf(theta, nu, mu, sigma)
          : gaussianPdf(theta, mu, sigma);
    const payV = payoff(spec, theta);
    const hv = Math.min(PLOT.b, Math.max(PLOT.t, hover.vy));
    const cardW = 138;
    const cardH = 66;
    let tx = tpx + 12;
    if (tx + cardW > PLOT.r) tx = tpx - 12 - cardW;
    if (tx < PLOT.l + 2) tx = PLOT.l + 2;
    const ty = Math.min(PLOT.b - cardH, Math.max(PLOT.t, hv - cardH / 2));
    return {
      theta,
      tpx,
      like: Math.min(1, pdfV / pdfMax),
      payV,
      by: syPdf(pdfV),
      py: syPay(payV),
      hv,
      tx,
      ty,
      cardW,
      cardH,
    };
  })();

  return (
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
      onDoubleClick={resetView}
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
      <LegendItem x={PLOT.l} color="var(--color-accent)" label="Belief (likelihood)" />
      <LegendItem x={PLOT.l + 168} color="var(--color-buy)" label="Payoff" />
      <LegendItem x={PLOT.l + 268} color="var(--color-buy)" label="In-the-money" block />

      {/* horizontal likelihood gridlines (left-axis reference) */}
      {LIKE_TICKS.map((r) => (
        <line
          key={`hgrid-${r}`}
          x1={PLOT.l}
          x2={PLOT.r}
          y1={syPdf(r * pdfMax)}
          y2={syPdf(r * pdfMax)}
          stroke="var(--color-edge)"
          strokeWidth={1}
          opacity={r === 0 ? 0.7 : 0.22}
        />
      ))}

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

      {/* left y-axis: belief relative likelihood (peak = 1.0) */}
      <line
        x1={PLOT.l}
        x2={PLOT.l}
        y1={PLOT.t}
        y2={PLOT.b}
        stroke="var(--color-accent)"
        strokeWidth={1}
        opacity={0.45}
      />
      {LIKE_TICKS.map((r) => (
        <g key={`lyt-${r}`}>
          <line
            x1={PLOT.l - 4}
            x2={PLOT.l}
            y1={syPdf(r * pdfMax)}
            y2={syPdf(r * pdfMax)}
            stroke="var(--color-accent)"
            strokeWidth={1}
            opacity={0.6}
          />
          <text
            x={PLOT.l - 7}
            y={syPdf(r * pdfMax) + 3.5}
            textAnchor="end"
            className="fill-[var(--color-muted)]"
            fontSize={10}
          >
            {r.toFixed(2)}
          </text>
        </g>
      ))}

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

      {/* belief PDF: filled area + outline */}
      <path
        d={`${toPath(pdf, sx, syPdf)} L${sx(hi).toFixed(2)} ${syPdf(0).toFixed(2)} L${sx(lo).toFixed(2)} ${syPdf(0).toFixed(2)} Z`}
        fill="url(#bc-belief-fill)"
      />
      <path
        d={toPath(pdf, sx, syPdf)}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={2}
        filter={dragging ? undefined : 'url(#bc-glow)'}
      />

      {/* mean line */}
      <line
        x1={sx(mu)}
        x2={sx(mu)}
        y1={PLOT.t}
        y2={PLOT.b}
        stroke="var(--color-accent)"
        strokeWidth={1.5}
        strokeDasharray="4 3"
      />
      <text x={sx(mu) + 4} y={PLOT.t + 11} className="fill-[var(--color-accent)]" fontSize={11}>
        μ {fmt(mu, xDec)}
      </text>

      {/* mixture component modes — a tick at each μ_k labelled with its weight %, so
          the camps and how the order flow re-weights them are visible at a glance */}
      {isMixture &&
        components?.map((c, k) => (
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
              cy={syPdf(c.pi * gaussianPdf(c.mu, c.mu, c.sigma))}
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

      {/* payoff overlay */}
      <path
        d={toPath(pay, sx, syPay)}
        fill="none"
        stroke="var(--color-buy)"
        strokeWidth={2}
        filter={dragging ? undefined : 'url(#bc-glow)'}
      />

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

      {/* axis pan/scale hit-zones — transparent; the cursor hints the gesture.
          Left/right gutters scale Y (vertical drag); the bottom axis scales X
          (horizontal drag). They stop propagation so the plot-pan never fires. */}
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
        className="cursor-ns-resize"
        onPointerDown={(e) => beginGesture('scaley', e)}
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
          {/* translucent readout card */}
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

            <circle cx={cross.tx + 15} cy={cross.ty + 33} r={3.5} fill="var(--color-accent)" />
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
              {cross.like.toFixed(2)}
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
          </g>
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
  );
}

// Memoised so the live trades tape / stats refreshing the parent don't re-render
// the (heavy) chart unless its own inputs — belief, spec, or bounds — change.
export const BeliefChart = memo(BeliefChartImpl);
