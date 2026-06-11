// Model fair price vs the contract's primary parameter (strike / center), swept
// across the visible domain at the current belief. Computed client-side with the
// same `core.price` the server uses, drawn as a proper x–y chart with a dot at the
// composed contract's value.

import { GaussianBelief, price } from '@bmm/core';
import { useRef, useState } from 'react';
import { fmt, fmtCompact } from '../lib/format.ts';
import type { ContractSpec } from '../lib/types.ts';
import { type Domain, niceTicks, scale, toPath } from '../lib/viz.ts';

const W = 360;
const H = 140;
const P = { l: 34, r: 10, t: 12, b: 22 };

// Build a spec with its primary parameter set to x (or null if not applicable).
function withParam(spec: ContractSpec, x: number): ContractSpec | null {
  switch (spec.type) {
    case 'CALL':
    case 'PUT':
    case 'BINARY_CALL':
    case 'BINARY_PUT':
      return { ...spec, strike: x };
    case 'GAUSSIAN':
      return { ...spec, center: x };
    case 'SPREAD': {
      const half = (spec.upper - spec.lower) / 2;
      return { type: 'SPREAD', lower: x - half, upper: x + half };
    }
    default:
      return null; // LINEAR has no strike-like parameter
  }
}

function currentParam(spec: ContractSpec): number | null {
  switch (spec.type) {
    case 'CALL':
    case 'PUT':
    case 'BINARY_CALL':
    case 'BINARY_PUT':
      return spec.strike;
    case 'GAUSSIAN':
      return spec.center;
    case 'SPREAD':
      return (spec.lower + spec.upper) / 2;
    default:
      return null;
  }
}

function paramLabel(type: ContractSpec['type']): string {
  return type === 'GAUSSIAN' ? 'c' : type === 'SPREAD' ? 'mid' : 'K';
}

export function PriceCurveChart({
  spec,
  mu,
  sigma,
  domain,
}: {
  spec: ContractSpec;
  mu: number;
  sigma: number;
  domain: Domain;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const param = currentParam(spec);
  if (param == null) {
    return <p className="p-4 text-sm text-muted">Linear pays θ — no strike to sweep.</p>;
  }

  const belief = new GaussianBelief(mu, sigma * sigma);
  const [lo, hi] = domain;
  const n = 80;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const x = lo + ((hi - lo) * i) / n;
    const s = withParam(spec, x);
    if (s) pts.push({ x, y: price(s, belief) });
  }

  const sx = scale(lo, hi, P.l, W - P.r);
  const yMax = Math.max(...pts.map((p) => p.y), 1e-9);
  const yMin = Math.min(...pts.map((p) => p.y), 0);
  const sy = scale(yMin, yMax * 1.08, H - P.b, P.t);
  const here = withParam(spec, param);
  const herePrice = here ? price(here, belief) : 0;

  const yTicks = niceTicks(yMin, yMax, 3);
  const xTicks = niceTicks(lo, hi, 4);
  const xLabel = paramLabel(spec.type);

  const onMove = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const frac = (vx - P.l) / (W - P.r - P.l);
    const idx = Math.round(frac * n);
    setHoverIdx(idx >= 0 && idx <= n ? idx : null);
  };

  const hp = hoverIdx != null ? pts[hoverIdx] : null;
  const cross = hp
    ? (() => {
        const px = sx(hp.x);
        const py = sy(hp.y);
        const cardW = 104;
        const cardH = 32;
        let cx = px + 8;
        if (cx + cardW > W - P.r) cx = px - 8 - cardW;
        if (cx < P.l) cx = P.l;
        let cy = py - cardH - 6;
        if (cy < P.t) cy = py + 8;
        return { px, py, cx, cy, cardW, cardH };
      })()
    : null;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full touch-none select-none"
      role="img"
      aria-label="Fair price vs strike"
      onPointerMove={onMove}
      onPointerLeave={() => setHoverIdx(null)}
    >
      <title>Model fair price across the strike/center parameter</title>

      {/* y gridlines + left-gutter labels */}
      {yTicks.map((t) => (
        <g key={`y-${t}`}>
          <line
            x1={P.l}
            x2={W - P.r}
            y1={sy(t)}
            y2={sy(t)}
            stroke="var(--color-edge)"
            opacity={0.4}
          />
          <text
            x={P.l - 5}
            y={sy(t) + 3}
            textAnchor="end"
            fontSize={9}
            className="fill-[var(--color-muted)]"
          >
            {fmt(t, 0)}
          </text>
        </g>
      ))}

      {/* axis spines */}
      <line x1={P.l} x2={P.l} y1={P.t} y2={H - P.b} stroke="var(--color-edge)" opacity={0.8} />
      <line
        x1={P.l}
        x2={W - P.r}
        y1={H - P.b}
        y2={H - P.b}
        stroke="var(--color-edge)"
        opacity={0.8}
      />

      {/* x ticks (strike / center in θ units) */}
      {xTicks.map((t) => (
        <g key={`x-${t}`}>
          <line x1={sx(t)} x2={sx(t)} y1={H - P.b} y2={H - P.b + 3} stroke="var(--color-muted)" />
          <text
            x={sx(t)}
            y={H - P.b + 13}
            textAnchor="middle"
            fontSize={9}
            className="fill-[var(--color-muted)]"
          >
            {fmt(t, 0)}
          </text>
        </g>
      ))}

      <path d={toPath(pts, sx, sy)} fill="none" stroke="var(--color-buy)" strokeWidth={2} />
      <line
        x1={sx(param)}
        x2={sx(param)}
        y1={P.t}
        y2={H - P.b}
        stroke="var(--color-buy)"
        strokeDasharray="3 3"
        opacity={0.6}
      />
      <circle cx={sx(param)} cy={sy(herePrice)} r={3.5} fill="var(--color-buy)" />

      {/* hover crosshair + readout */}
      {cross && hp && (
        <g pointerEvents="none">
          <line
            x1={P.l}
            x2={W - P.r}
            y1={cross.py}
            y2={cross.py}
            stroke="var(--color-fg)"
            strokeWidth={1}
            strokeDasharray="3 4"
            opacity={0.35}
          />
          <line
            x1={cross.px}
            x2={cross.px}
            y1={P.t}
            y2={H - P.b}
            stroke="var(--color-fg)"
            strokeWidth={1}
            strokeDasharray="3 4"
            opacity={0.35}
          />
          <circle
            cx={cross.px}
            cy={cross.py}
            r={3.5}
            fill="var(--color-buy)"
            stroke="var(--color-ink)"
            strokeWidth={1.5}
          />
          <rect
            x={cross.cx}
            y={cross.cy}
            width={cross.cardW}
            height={cross.cardH}
            rx={5}
            fill="var(--color-panel)"
            stroke="var(--color-edge)"
            strokeWidth={1}
            opacity={0.92}
          />
          <text
            x={cross.cx + 8}
            y={cross.cy + 14}
            fontSize={10}
            className="fill-[var(--color-buy)] font-semibold"
          >
            price {fmtCompact(hp.y)}
          </text>
          <text
            x={cross.cx + 8}
            y={cross.cy + 26}
            fontSize={9}
            className="fill-[var(--color-muted)]"
          >
            {xLabel} {fmt(hp.x, 0)}
          </text>
        </g>
      )}
    </svg>
  );
}
