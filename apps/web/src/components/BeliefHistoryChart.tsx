// A compact μ-over-time line with a ±σ band, drawn as a proper x–y chart.

import { fmt, timeAgo } from '../lib/format.ts';
import type { BeliefHistoryPoint } from '../lib/types.ts';
import { niceTicks, scale, toPath } from '../lib/viz.ts';

const W = 360;
const H = 140;
const P = { l: 34, r: 10, t: 12, b: 22 };

export function BeliefHistoryChart({ points }: { points: BeliefHistoryPoint[] }) {
  if (points.length < 2) {
    return <p className="p-4 text-sm text-muted">Not enough history yet — make a trade.</p>;
  }

  const n = points.length;
  const sx = scale(0, n - 1, P.l, W - P.r);

  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    lo = Math.min(lo, p.mu - p.sigma);
    hi = Math.max(hi, p.mu + p.sigma);
  }
  const padY = (hi - lo) * 0.1 || 1;
  const sy = scale(lo - padY, hi + padY, H - P.b, P.t);

  const muLine = points.map((p, i) => ({ x: i, y: p.mu }));
  const upper = points.map((p, i) => ({ x: i, y: p.mu + p.sigma }));
  const lower = points.map((p, i) => ({ x: i, y: p.mu - p.sigma }));
  const bandPath = `${toPath(upper, sx, sy)} ${lower
    .slice()
    .reverse()
    .map((p) => `L${sx(p.x).toFixed(2)} ${sy(p.y).toFixed(2)}`)
    .join(' ')} Z`;

  const yTicks = niceTicks(lo, hi, 3);
  // three time ticks across the series (first / middle / last)
  const xIdx = [0, Math.floor((n - 1) / 2), n - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Belief μ over time">
      <title>Belief μ ± σ over time</title>

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
      <path d={toPath(muLine, sx, sy)} fill="none" stroke="var(--color-accent)" strokeWidth={2} />
      <circle cx={sx(n - 1)} cy={sy(points[n - 1]?.mu ?? 0)} r={3} fill="var(--color-accent)" />
    </svg>
  );
}
