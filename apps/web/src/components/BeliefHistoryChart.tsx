// A compact μ-over-time line with a ±σ band, drawn as a proper x–y chart.

import { useRef, useState } from 'react';
import { fmt, timeAgo } from '../lib/format.ts';
import type { BeliefHistoryPoint } from '../lib/types.ts';
import { niceTicks, scale, toPath } from '../lib/viz.ts';

const W = 360;
const H = 140;
const P = { l: 34, r: 10, t: 12, b: 22 };

export function BeliefHistoryChart({ points }: { points: BeliefHistoryPoint[] }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hi, setHi] = useState<number | null>(null);

  if (points.length < 2) {
    return <p className="p-4 text-sm text-muted">Not enough history yet — make a trade.</p>;
  }

  const n = points.length;
  const sx = scale(0, n - 1, P.l, W - P.r);

  let lo = Number.POSITIVE_INFINITY;
  let hiY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    lo = Math.min(lo, p.mu - p.sigma);
    hiY = Math.max(hiY, p.mu + p.sigma);
  }
  const padY = (hiY - lo) * 0.1 || 1;
  const sy = scale(lo - padY, hiY + padY, H - P.b, P.t);

  const muLine = points.map((p, i) => ({ x: i, y: p.mu }));
  const upper = points.map((p, i) => ({ x: i, y: p.mu + p.sigma }));
  const lower = points.map((p, i) => ({ x: i, y: p.mu - p.sigma }));
  const bandPath = `${toPath(upper, sx, sy)} ${lower
    .slice()
    .reverse()
    .map((p) => `L${sx(p.x).toFixed(2)} ${sy(p.y).toFixed(2)}`)
    .join(' ')} Z`;

  const yTicks = niceTicks(lo, hiY, 3);
  const xIdx = [0, Math.floor((n - 1) / 2), n - 1];

  const onMove = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const frac = (vx - P.l) / (W - P.r - P.l);
    const idx = Math.round(frac * (n - 1));
    setHi(idx >= 0 && idx <= n - 1 ? idx : null);
  };

  // crosshair geometry for the hovered sample
  const hp = hi != null ? points[hi] : null;
  const cross =
    hp && hi != null
      ? (() => {
          const px = sx(hi);
          const py = sy(hp.mu);
          const cardW = 108;
          const cardH = 32;
          let cx = px + 8;
          if (cx + cardW > W - P.r) cx = px - 8 - cardW;
          if (cx < P.l) cx = P.l;
          let cy = py - cardH - 6;
          if (cy < P.t) cy = py + 8;
          return { px, py, cx, cy, cardW, cardH, label: hi === n - 1 ? 'now' : timeAgo(hp.t) };
        })()
      : null;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full touch-none select-none"
      role="img"
      aria-label="Belief μ over time"
      onPointerMove={onMove}
      onPointerLeave={() => setHi(null)}
    >
      <title>Belief μ ± σ over time</title>

      <defs>
        <filter id="bh-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation={1.8} result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

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

      {/* x time ticks */}
      {xIdx.map((i, k) => (
        <g key={`x-${i}`}>
          <line x1={sx(i)} x2={sx(i)} y1={H - P.b} y2={H - P.b + 3} stroke="var(--color-muted)" />
          <text
            x={sx(i)}
            y={H - P.b + 13}
            textAnchor={k === 0 ? 'start' : k === xIdx.length - 1 ? 'end' : 'middle'}
            fontSize={9}
            className="fill-[var(--color-muted)]"
          >
            {i === n - 1 ? 'now' : timeAgo(points[i]?.t ?? null)}
          </text>
        </g>
      ))}

      <path d={bandPath} fill="var(--color-accent)" opacity={0.12} />
      <path
        d={toPath(muLine, sx, sy)}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={2}
        filter="url(#bh-glow)"
      />
      <circle cx={sx(n - 1)} cy={sy(points[n - 1]?.mu ?? 0)} r={3} fill="var(--color-accent)" />

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
            fill="var(--color-accent)"
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
            className="fill-[var(--color-accent)] font-semibold"
          >
            μ {fmt(hp.mu, 0)}
          </text>
          <text
            x={cross.cx + 8}
            y={cross.cy + 26}
            fontSize={9}
            className="fill-[var(--color-muted)]"
          >
            ±σ {fmt(hp.sigma, 0)} · {cross.label}
          </text>
        </g>
      )}
    </svg>
  );
}
