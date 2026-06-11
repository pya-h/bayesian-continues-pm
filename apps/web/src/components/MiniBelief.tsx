// A tiny belief-density sparkline — the "odds" glyph for a continuous market.
// Shows the N(μ, σ²) curve with its mean tick; reads the live belief so it
// breathes as the consensus moves. Pure geometry from lib/viz.ts.

import { useId } from 'react';
import { type Domain, niceDomain, pdfCurve, scale, toPath } from '../lib/viz.ts';

const W = 240;
const H = 56;

export function MiniBelief({
  mu,
  sigma,
  outcomeMin = null,
  outcomeMax = null,
  thetaStar = null,
}: {
  mu: number;
  sigma: number;
  outcomeMin?: number | null;
  outcomeMax?: number | null;
  thetaStar?: number | null;
}) {
  const fillId = useId();
  const domain: Domain = niceDomain(mu, sigma, {
    sigmas: 3.2,
    min: outcomeMin,
    max: outcomeMax,
    kinks: thetaStar != null ? [thetaStar] : [],
  });
  const [lo, hi] = domain;
  const sx = scale(lo, hi, 2, W - 2);
  const pdf = pdfCurve(mu, sigma, domain, 84);
  const pdfMax = Math.max(...pdf.map((p) => p.y), 1e-12);
  const sy = scale(0, pdfMax * 1.12, H - 3, 3);
  const line = toPath(pdf, sx, sy);
  const area = `${line} L${sx(hi).toFixed(2)} ${sy(0).toFixed(2)} L${sx(lo).toFixed(2)} ${sy(0).toFixed(2)} Z`;
  const muX = sx(Math.min(hi, Math.max(lo, mu)));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-full w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label="Belief density"
    >
      <title>Consensus belief density</title>
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.32} />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${fillId})`} />
      <path d={line} fill="none" stroke="var(--color-accent)" strokeWidth={1.5} />
      <line
        x1={muX}
        x2={muX}
        y1={3}
        y2={H - 3}
        stroke="var(--color-accent)"
        strokeWidth={1}
        strokeDasharray="3 2"
        opacity={0.8}
      />
      {thetaStar != null && thetaStar >= lo && thetaStar <= hi && (
        <line
          x1={sx(thetaStar)}
          x2={sx(thetaStar)}
          y1={3}
          y2={H - 3}
          stroke="var(--color-warn)"
          strokeWidth={1.5}
        />
      )}
    </svg>
  );
}
