// Per-position payoff diagram: the trade's settlement P&L as a function of the
// outcome θ — pnl(θ) = quantity · payoff(spec, θ) − costBasis. The curve is
// shaded green where the position profits and red where it loses, with markers
// for breakeven(s), the current consensus μ (and the P&L there), and — once the
// market has resolved — the realised outcome θ* and its P&L. All geometry comes
// from the pure helpers in lib/viz.ts + core's exact `payoff`.

import { payoff, payoffKinks } from '@bmm/core';
import { useId } from 'react';
import { fmt, fmtSigned } from '../lib/format.ts';
import type { ContractSpec } from '../lib/types.ts';
import {
  type Domain,
  niceDomain,
  niceTicks,
  pnlCurve,
  scale,
  toPath,
  zeroCrossings,
} from '../lib/viz.ts';

const W = 320;
const H = 132;
const P = { l: 10, r: 10, t: 16, b: 26 };

export function PositionPnlChart({
  spec,
  quantity,
  costBasis,
  mu,
  sigma,
  outcomeUnit,
  outcomeMin = null,
  outcomeMax = null,
  thetaStar = null,
  finalPnl = null,
}: {
  spec: ContractSpec;
  quantity: number;
  costBasis: number;
  mu: number;
  sigma: number;
  outcomeUnit: string;
  outcomeMin?: number | null;
  outcomeMax?: number | null;
  thetaStar?: number | null;
  finalPnl?: number | null;
}) {
  const domain: Domain = niceDomain(mu, sigma, {
    sigmas: 3,
    kinks: payoffKinks(spec),
    min: outcomeMin,
    max: outcomeMax,
  });
  const [lo, hi] = domain;
  const pts = pnlCurve(spec, quantity, costBasis, domain, 160);

  const ys = pts.map((p) => p.y);
  const yMin = Math.min(0, ...ys);
  let yMax = Math.max(0, ...ys);
  if (yMax - yMin < 1e-9) yMax = yMin + 1;
  const padY = (yMax - yMin) * 0.12;

  const sx = scale(lo, hi, P.l, W - P.r);
  const sy = scale(yMin - padY, yMax + padY, H - P.b, P.t);
  const y0 = sy(0);

  const line = toPath(pts, sx, sy);
  const area = `${line} L${sx(hi).toFixed(2)} ${y0.toFixed(2)} L${sx(lo).toFixed(2)} ${y0.toFixed(2)} Z`;

  // Split-colour gradient: green above the zero line, red below it.
  const span = H - P.b - P.t;
  const zeroFrac = Math.min(1, Math.max(0, (y0 - P.t) / span));
  const gid = useId();

  const breaks = zeroCrossings(pts).filter((x) => x > lo && x < hi);
  const muClamped = Math.min(hi, Math.max(lo, mu));
  const pnlAtMu = quantity * payoff(spec, mu) - costBasis;
  const xTicks = niceTicks(lo, hi, 4);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      role="img"
      aria-label="Position payoff vs outcome"
    >
      <title>Settlement P&L as a function of the outcome θ</title>
      <defs>
        <linearGradient id={gid} x1="0" y1={P.t} x2="0" y2={H - P.b} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--color-buy)" stopOpacity={0.22} />
          <stop offset={zeroFrac} stopColor="var(--color-buy)" stopOpacity={0.05} />
          <stop offset={zeroFrac} stopColor="var(--color-sell)" stopOpacity={0.05} />
          <stop offset="1" stopColor="var(--color-sell)" stopOpacity={0.22} />
        </linearGradient>
      </defs>

      {/* profit/loss shaded area */}
      <path d={area} fill={`url(#${gid})`} />

      {/* zero (breakeven) baseline */}
      <line
        x1={P.l}
        x2={W - P.r}
        y1={y0}
        y2={y0}
        stroke="var(--color-muted)"
        strokeWidth={1}
        strokeDasharray="3 3"
        opacity={0.7}
      />

      {/* x-axis outcome ticks */}
      {xTicks.map((t) => (
        <text
          key={`t-${t}`}
          x={sx(t)}
          y={H - 8}
          textAnchor="middle"
          fontSize={9}
          className="fill-[var(--color-muted)]"
        >
          {fmt(t, 0)}
        </text>
      ))}

      {/* breakevens */}
      {breaks.map((x) => (
        <g key={`be-${x.toFixed(2)}`}>
          <line
            x1={sx(x)}
            x2={sx(x)}
            y1={y0 - 4}
            y2={y0 + 4}
            stroke="var(--color-fg)"
            strokeWidth={1.25}
          />
          <text
            x={sx(x)}
            y={P.t - 5}
            textAnchor="middle"
            fontSize={8.5}
            className="fill-[var(--color-muted)]"
          >
            BE {fmt(x, 0)}
          </text>
        </g>
      ))}

      {/* the P&L curve */}
      <path d={line} fill="none" stroke="var(--color-fg)" strokeWidth={1.75} opacity={0.85} />

      {/* current consensus μ + P&L there */}
      <line
        x1={sx(muClamped)}
        x2={sx(muClamped)}
        y1={P.t}
        y2={H - P.b}
        stroke="var(--color-accent)"
        strokeWidth={1.25}
        strokeDasharray="4 3"
      />
      <circle cx={sx(muClamped)} cy={sy(pnlAtMu)} r={3} fill="var(--color-accent)" />
      <text
        x={sx(muClamped)}
        y={P.t - 5}
        textAnchor="middle"
        fontSize={8.5}
        className="fill-[var(--color-accent)]"
      >
        now {fmtSigned(pnlAtMu, 0)}
      </text>

      {/* realised outcome (settled) */}
      {thetaStar != null && thetaStar >= lo && thetaStar <= hi && (
        <g>
          <line
            x1={sx(thetaStar)}
            x2={sx(thetaStar)}
            y1={P.t}
            y2={H - P.b}
            stroke="var(--color-warn)"
            strokeWidth={1.5}
          />
          <circle
            cx={sx(thetaStar)}
            cy={sy(finalPnl ?? quantity * payoff(spec, thetaStar) - costBasis)}
            r={3.5}
            fill="var(--color-warn)"
            stroke="var(--color-ink)"
            strokeWidth={1}
          />
        </g>
      )}

      {/* unit caption */}
      <text
        x={W - P.r}
        y={H - 8}
        textAnchor="end"
        fontSize={8.5}
        className="fill-[var(--color-muted)]"
      >
        {outcomeUnit || 'θ'}
      </text>
    </svg>
  );
}
