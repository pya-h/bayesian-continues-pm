// A compact μ-over-time line with a ±σ band, built from the market history.

import { fmt } from '../lib/format.ts';
import type { BeliefHistoryPoint } from '../lib/types.ts';
import { niceTicks, scale, toPath } from '../lib/viz.ts';

const W = 360;
const H = 140;
const P = { l: 8, r: 8, t: 12, b: 18 };

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

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Belief μ over time">
      <title>Belief μ ± σ over time</title>
      {yTicks.map((t) => (
        <g key={t}>
          <line
            x1={P.l}
            x2={W - P.r}
            y1={sy(t)}
            y2={sy(t)}
            stroke="var(--color-edge)"
            opacity={0.5}
          />
          <text x={P.l} y={sy(t) - 2} fontSize={9} className="fill-[var(--color-muted)]">
            {fmt(t, 0)}
          </text>
        </g>
      ))}
      <path d={bandPath} fill="var(--color-accent)" opacity={0.12} />
      <path d={toPath(muLine, sx, sy)} fill="none" stroke="var(--color-accent)" strokeWidth={2} />
      <circle cx={sx(n - 1)} cy={sy(points[n - 1]?.mu ?? 0)} r={3} fill="var(--color-accent)" />
    </svg>
  );
}
