// CdfChart — the market's belief as a CUMULATIVE probability curve: P(outcome ≤ θ)
// across θ, the monotone S-curve rising 0 → 1. It answers "what chance does the
// market give the outcome being at-or-below this point?" directly, complementing the
// density (PDF) view. Reconstructs the real belief (any kind) via `beliefFromView`
// so the curve is the true CDF — exact for Gaussian / mixture / Student-t / Gen·exact.
// Static auto-domain (μ ± k·σ, clamped to outcome bounds) with a hover readout; the
// pan/zoom-shared variant lives as an overlay inside BeliefChart (the "overlay" mode).

import { memo, useMemo, useRef, useState } from 'react';
import { beliefFromView } from '../lib/beliefFromView.ts';
import { fmt, fmtPct } from '../lib/format.ts';
import type { Belief } from '../lib/types.ts';
import {
  type Domain,
  type Pt,
  niceDomain,
  niceTicks,
  scale,
  tickDecimals,
  toPath,
} from '../lib/viz.ts';

const W = 720;
const H = 220;
const M = { top: 16, right: 20, bottom: 30, left: 44 };
const PLOT = { l: M.left, r: W - M.right, t: M.top, b: H - M.bottom };
const PROB_TICKS = [0, 0.25, 0.5, 0.75, 1] as const;

function CdfChartImpl({
  belief,
  outcomeUnit,
  outcomeMin = null,
  outcomeMax = null,
  thetaStar = null,
}: {
  belief: Belief;
  outcomeUnit: string;
  outcomeMin?: number | null;
  outcomeMax?: number | null;
  thetaStar?: number | null;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);

  const model = useMemo(() => beliefFromView(belief), [belief]);
  const mu = belief.mu;
  const sigma = belief.sigma > 0 ? belief.sigma : 1e-6;

  const domain = useMemo<Domain>(
    () => niceDomain(mu, sigma, { sigmas: 4, min: outcomeMin, max: outcomeMax }),
    [mu, sigma, outcomeMin, outcomeMax],
  );
  const [lo, hi] = domain;
  const sx = scale(lo, hi, PLOT.l, PLOT.r);
  const sy = scale(0, 1, PLOT.b, PLOT.t); // probability 0 → 1

  const curve = useMemo<Pt[]>(() => {
    const out: Pt[] = [];
    const n = 200;
    for (let i = 0; i <= n; i++) {
      const x = lo + ((hi - lo) * i) / n;
      out.push({ x, y: Math.min(1, Math.max(0, model.cdf(x))) });
    }
    return out;
  }, [model, lo, hi]);

  const xTicks = niceTicks(lo, hi, 6);
  const xDec = tickDecimals(xTicks, lo, hi);

  const hover = useMemo(() => {
    if (hoverX == null) return null;
    const theta = Math.min(hi, Math.max(lo, hoverX));
    const below = Math.min(1, Math.max(0, model.cdf(theta)));
    return { theta, below, above: 1 - below };
  }, [hoverX, model, lo, hi]);

  const onMove = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    if (vx < PLOT.l || vx > PLOT.r) {
      setHoverX(null);
      return;
    }
    setHoverX(lo + ((vx - PLOT.l) / (PLOT.r - PLOT.l)) * (hi - lo));
  };

  const hx = hover ? sx(hover.theta) : 0;
  const hy = hover ? sy(hover.below) : 0;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full select-none"
      role="img"
      aria-label="Cumulative belief probability P(outcome ≤ θ)"
      onPointerMove={onMove}
      onPointerLeave={() => setHoverX(null)}
    >
      <title>Cumulative probability P(≤ θ)</title>

      <rect
        x={PLOT.l}
        y={PLOT.t}
        width={PLOT.r - PLOT.l}
        height={PLOT.b - PLOT.t}
        rx={5}
        fill="var(--color-panel-2)"
        opacity={0.35}
      />

      {/* y gridlines + probability labels */}
      {PROB_TICKS.map((p) => (
        <g key={`pg-${p}`}>
          <line
            x1={PLOT.l}
            x2={PLOT.r}
            y1={sy(p)}
            y2={sy(p)}
            stroke="var(--color-edge)"
            strokeWidth={1}
            opacity={p === 0 ? 0.6 : 0.2}
          />
          <text
            x={PLOT.l - 6}
            y={sy(p) + 3.5}
            textAnchor="end"
            fontSize={10}
            className="fill-[var(--color-muted)]"
          >
            {Math.round(p * 100)}%
          </text>
        </g>
      ))}

      {/* x ticks */}
      {xTicks.map((t) => (
        <g key={`xt-${t}`}>
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

      {/* mean line */}
      {mu >= lo && mu <= hi && (
        <line
          x1={sx(mu)}
          x2={sx(mu)}
          y1={PLOT.t}
          y2={PLOT.b}
          stroke="var(--color-accent)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          opacity={0.7}
        />
      )}

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

      {/* the cumulative curve */}
      <path d={toPath(curve, sx, sy)} fill="none" stroke="var(--color-warn)" strokeWidth={2} />

      {/* hover crosshair + readout */}
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
            fill="var(--color-warn)"
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
            θ {fmt(hover.theta, Math.min(6, xDec + 1))} · P(≤) {fmtPct(hover.below)} · P(≥){' '}
            {fmtPct(hover.above)}
          </text>
        </g>
      )}

      {/* axis captions */}
      <text x={PLOT.l} y={H - 2} fontSize={10} className="fill-[var(--color-muted)]">
        P(outcome ≤ θ)
      </text>
      <text
        x={PLOT.r}
        y={H - 2}
        textAnchor="end"
        fontSize={10}
        className="fill-[var(--color-muted)]"
      >
        outcome θ ({outcomeUnit})
      </text>
    </svg>
  );
}

export const CdfChart = memo(CdfChartImpl);
