// Model fair price vs the contract's primary parameter (strike / center), swept
// across the visible domain at the current belief. Computed client-side with the
// same `core.price` the server uses, with a dot at the composed contract's value.

import { GaussianBelief, price } from '@bmm/core';
import { fmt } from '../lib/format.ts';
import type { ContractSpec } from '../lib/types.ts';
import { type Domain, niceTicks, scale, toPath } from '../lib/viz.ts';

const W = 360;
const H = 140;
const P = { l: 8, r: 8, t: 12, b: 18 };

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

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Fair price vs strike">
      <title>Model fair price across the strike/center parameter</title>
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
    </svg>
  );
}
