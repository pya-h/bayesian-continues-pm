// PriceCurvePanel — the fair-price-vs-strike sweep as a full-size companion to the
// belief chart (the "Price · panel" mode). At each θ it prices THIS contract with its
// strike/center moved to θ, using the same `core.price` the server uses, against the
// market's real belief — so it reads identically to the belief chart's price overlay.
// Like CdfChart it shares the belief chart's x-axis: same `base` domain + the shared
// pan/zoom and hovered-θ from the chartSync store, so the two line up and a hover on
// either marks the same outcome on both. A live handle drag is mirrored via `liveSpec`
// (so the dot tracks the drag), exactly as the mini price chart does.

import { price } from '@bmm/core';
import { useMemo, useRef, useSyncExternalStore } from 'react';
import { beliefFromView } from '../lib/beliefFromView.ts';
import { useChartView, useHoverTheta, useXAxisSync } from '../lib/chartSync.ts';
import { fmt, fmtCompact } from '../lib/format.ts';
import { getLiveSpec, subscribeLiveSpec } from '../lib/liveSpec.ts';
import {
  currentParam,
  paramLabel,
  reshapesWhileDragging,
  sweepKey,
  withParam,
} from '../lib/priceParam.ts';
import type { Belief, ContractSpec } from '../lib/types.ts';
import {
  type Domain,
  type Pt,
  niceTicks,
  scale,
  tickDecimals,
  toPath,
  viewDomain,
} from '../lib/viz.ts';

const W = 720;
const H = 220;
const M = { top: 16, right: 20, bottom: 30, left: 52 };
const PLOT = { l: M.left, r: W - M.right, t: M.top, b: H - M.bottom };

function PriceCurvePanelImpl({
  spec: specProp,
  belief: beliefView,
  base,
  outcomeUnit,
  outcomeMin = null,
  outcomeMax = null,
  thetaStar = null,
}: {
  spec: ContractSpec;
  belief: Belief;
  // Pre-view base x-domain — the SAME one the belief chart uses, so the axes align.
  base: Domain;
  outcomeUnit: string;
  outcomeMin?: number | null;
  outcomeMax?: number | null;
  thetaStar?: number | null;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Mirror the belief chart during a handle drag: read the in-progress spec from the
  // live store.
  const liveSpec = useSyncExternalStore(subscribeLiveSpec, getLiveSpec);
  const spec = liveSpec ?? specProp;
  const belief = useMemo(() => beliefFromView(beliefView), [beliefView]);

  // Shared pan/zoom + hovered θ.
  const view = useChartView();
  const hoverTheta = useHoverTheta();
  const domain = useMemo<Domain>(
    () => viewDomain(base, view, outcomeMin, outcomeMax),
    [base, view, outcomeMin, outcomeMax],
  );
  const [lo, hi] = domain;
  const sx = scale(lo, hi, PLOT.l, PLOT.r);
  const sync = useXAxisSync({ svgRef, W, plotL: PLOT.l, plotR: PLOT.r, domain });

  const param = currentParam(spec);
  // Coarsen the sweep whenever the curve must re-price every frame: a width-handle
  // drag that reshapes it, OR a pan/zoom that shifts the window — both costly on a
  // quadrature-priced Student-t. Full resolution at rest.
  const dragging = liveSpec != null;
  const expensive = beliefView.kind === 'student_t';
  const busy = (dragging && reshapesWhileDragging(spec.type)) || sync.panning;
  const n = busy && expensive ? 22 : busy ? 64 : 120;
  const shapeKey = sweepKey(spec);

  // biome-ignore lint/correctness/useExhaustiveDependencies: shapeKey encodes the spec shape
  const pts = useMemo<Pt[]>(() => {
    const out: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const x = lo + ((hi - lo) * i) / n;
      const s = withParam(spec, x);
      if (s) out.push({ x, y: price(s, belief) });
    }
    return out;
  }, [shapeKey, belief, lo, hi, n]);

  const yMax = pts.length ? Math.max(...pts.map((p) => p.y), 1e-9) : 1;
  const yMin = pts.length ? Math.min(...pts.map((p) => p.y), 0) : 0;
  const sy = scale(yMin, yMax * 1.08, PLOT.b, PLOT.t);
  const yTicks = niceTicks(yMin, yMax, 4);
  const xTicks = niceTicks(lo, hi, 6);
  const xDec = tickDecimals(xTicks, lo, hi);
  const xLabel = paramLabel(spec.type);

  const here = param != null ? withParam(spec, param) : null;
  const herePrice = here ? price(here, belief) : 0;
  const paramInView = param != null && param >= lo && param <= hi;

  // Marker at the shared hovered θ (from here OR the belief chart), if in-window.
  const hover =
    hoverTheta != null && hoverTheta >= lo && hoverTheta <= hi
      ? (() => {
          const s = withParam(spec, hoverTheta);
          return s ? { theta: hoverTheta, y: price(s, belief) } : null;
        })()
      : null;

  if (param == null) {
    return (
      <p className="p-6 text-center text-sm text-muted">Linear pays θ — no strike to sweep.</p>
    );
  }

  const hx = hover ? sx(hover.theta) : 0;
  const hy = hover ? sy(hover.y) : 0;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full touch-none select-none"
      role="img"
      aria-label="Fair price across the strike/center parameter"
      onPointerMove={sync.onPointerMove}
      onPointerUp={sync.onPointerUp}
      onPointerLeave={sync.onPointerLeave}
      onDoubleClick={sync.onDoubleClick}
    >
      <title>Model fair price across the strike/center parameter</title>

      <defs>
        <linearGradient id="pcp-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-price)" stopOpacity={0.26} />
          <stop offset="70%" stopColor="var(--color-price)" stopOpacity={0.07} />
          <stop offset="100%" stopColor="var(--color-price)" stopOpacity={0.02} />
        </linearGradient>
        <filter id="pcp-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation={2.2} result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <rect
        x={PLOT.l}
        y={PLOT.t}
        width={PLOT.r - PLOT.l}
        height={PLOT.b - PLOT.t}
        rx={5}
        fill="var(--color-panel-2)"
        opacity={0.35}
      />

      {/* y gridlines + price labels */}
      {yTicks.map((t) => (
        <g key={`y-${t}`}>
          <line
            x1={PLOT.l}
            x2={PLOT.r}
            y1={sy(t)}
            y2={sy(t)}
            stroke="var(--color-edge)"
            strokeWidth={1}
            opacity={0.3}
          />
          <text
            x={PLOT.l - 6}
            y={sy(t) + 3.5}
            textAnchor="end"
            fontSize={10}
            className="fill-[var(--color-muted)]"
          >
            {fmtCompact(t)}
          </text>
        </g>
      ))}

      {/* x ticks (strike / center in θ units) */}
      {xTicks.map((t) => (
        <g key={`x-${t}`}>
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
            fontSize={11}
            className="fill-[var(--color-muted)]"
          >
            {fmt(t, xDec)}
          </text>
        </g>
      ))}

      {/* resolution marker */}
      {thetaStar != null && thetaStar >= lo && thetaStar <= hi && (
        <line
          x1={sx(thetaStar)}
          x2={sx(thetaStar)}
          y1={PLOT.t}
          y2={PLOT.b}
          stroke="var(--color-warn)"
          strokeWidth={2}
        />
      )}

      {/* price curve: gradient area fill + glowing stroke */}
      <path
        d={`${toPath(pts, sx, sy)} L${sx(hi).toFixed(2)} ${sy(yMin).toFixed(2)} L${sx(lo).toFixed(2)} ${sy(yMin).toFixed(2)} Z`}
        fill="url(#pcp-fill)"
      />
      <path
        d={toPath(pts, sx, sy)}
        fill="none"
        stroke="var(--color-price)"
        strokeWidth={2}
        filter="url(#pcp-glow)"
      />

      {/* composed-contract marker: where the live spec's parameter sits on the curve */}
      {paramInView && (
        <>
          <line
            x1={sx(param)}
            x2={sx(param)}
            y1={PLOT.t}
            y2={PLOT.b}
            stroke="var(--color-price)"
            strokeDasharray="3 3"
            opacity={0.6}
          />
          <circle cx={sx(param)} cy={sy(herePrice)} r={4} fill="var(--color-price)" />
        </>
      )}

      {/* x-axis zoom hit-zone (bottom gutter) */}
      <rect
        x={PLOT.l}
        y={PLOT.b}
        width={PLOT.r - PLOT.l}
        height={H - PLOT.b}
        fill="transparent"
        className="cursor-ew-resize"
        onPointerDown={sync.onAxisZoomDown}
      />
      {/* plot-interior pan hit-zone (on top) */}
      <rect
        x={PLOT.l}
        y={PLOT.t}
        width={PLOT.r - PLOT.l}
        height={PLOT.b - PLOT.t}
        fill="transparent"
        className="cursor-grab"
        onPointerDown={sync.onPlotPanDown}
      />

      {/* hover crosshair + readout — driven by the SHARED θ */}
      {hover && (
        <g pointerEvents="none">
          <line
            x1={hx}
            x2={hx}
            y1={PLOT.t}
            y2={PLOT.b}
            stroke="var(--color-fg)"
            strokeWidth={1}
            strokeDasharray="3 4"
            opacity={0.35}
          />
          <line
            x1={PLOT.l}
            x2={PLOT.r}
            y1={hy}
            y2={hy}
            stroke="var(--color-fg)"
            strokeWidth={1}
            strokeDasharray="3 4"
            opacity={0.35}
          />
          <circle
            cx={hx}
            cy={hy}
            r={3.5}
            fill="var(--color-price)"
            stroke="var(--color-ink)"
            strokeWidth={1.5}
          />
          <text
            x={hx > (PLOT.l + PLOT.r) / 2 ? hx - 8 : hx + 8}
            y={Math.max(PLOT.t + 12, hy - 8)}
            textAnchor={hx > (PLOT.l + PLOT.r) / 2 ? 'end' : 'start'}
            fontSize={11}
            className="fill-[var(--color-fg)] font-semibold"
          >
            {xLabel} {fmt(hover.theta, Math.min(6, xDec + 1))} · price {fmtCompact(hover.y)}
          </text>
        </g>
      )}

      {/* axis captions */}
      <text x={PLOT.l} y={H - 2} fontSize={10} className="fill-[var(--color-muted)]">
        fair price
      </text>
      <text
        x={PLOT.r}
        y={H - 2}
        textAnchor="end"
        fontSize={10}
        className="fill-[var(--color-muted)]"
      >
        {xLabel} ({outcomeUnit})
      </text>
    </svg>
  );
}

export const PriceCurvePanel = PriceCurvePanelImpl;
