// The trading centerpiece. A single SVG that overlays three things on a shared
// outcome (θ) axis
// 1. the maker's live belief PDF N(μ, σ²) — filled area + mean + ±1σ band
// 2. the composed contract's payoff f(θ) — line on its own right-hand scale
// 3. the shaded "winning region" — where a holder is in-the-money
// plus draggable handles for the contract's parameters (strike / bounds / center
// / width). Belief μ/σ stream in live via props, so the curve breathes as trades
// land. All geometry comes from the pure helpers in lib/viz.ts.

import { useCallback, useRef } from 'react';
import { fmt } from '../lib/format.ts';
import type { ContractSpec } from '../lib/types.ts';
import {
  type Domain,
  niceDomain,
  niceTicks,
  payoffCurve,
  pdfCurve,
  scale,
  toPath,
  winningRegions,
} from '../lib/viz.ts';

const W = 720;
const H = 330;
const M = { top: 20, right: 18, bottom: 30, left: 18 };
const PLOT = { l: M.left, r: W - M.right, t: M.top, b: H - M.bottom };

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

export function BeliefChart({
  mu,
  sigma,
  spec,
  onSpecChange,
  outcomeUnit,
  outcomeMin,
  outcomeMax,
  thetaStar,
}: {
  mu: number;
  sigma: number;
  spec: ContractSpec;
  onSpecChange: (s: ContractSpec) => void;
  outcomeUnit: string;
  outcomeMin: number | null;
  outcomeMax: number | null;
  thetaStar?: number | null;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragId = useRef<string | null>(null);

  const handles = handlesFor(spec);
  const kinks = handles.map((h) => h.value);
  const domain: Domain = niceDomain(mu, sigma, {
    kinks,
    min: outcomeMin,
    max: outcomeMax,
  });
  const [lo, hi] = domain;
  const sx = scale(lo, hi, PLOT.l, PLOT.r);

  // Belief PDF scale (unitless density, scaled to its own peak).
  const pdf = pdfCurve(mu, sigma, domain);
  const pdfMax = Math.max(...pdf.map((p) => p.y), 1e-12);
  const syPdf = scale(0, pdfMax * 1.12, PLOT.b, PLOT.t);

  // Payoff scale (its own min/max across the visible domain).
  const pay = payoffCurve(spec, domain);
  const payMin = Math.min(...pay.map((p) => p.y));
  let payMax = Math.max(...pay.map((p) => p.y));
  if (payMax - payMin < 1e-9) payMax = payMin + 1; // flat payoff guard
  const pad = (payMax - payMin) * 0.08;
  const syPay = scale(payMin - pad, payMax + pad, PLOT.b, PLOT.t);

  const regions = winningRegions(spec, domain);

  // Pointer → data-x, mapped through the SVG's rendered rect into viewBox units.
  const pointerToData = useCallback(
    (clientX: number): number => {
      const svg = svgRef.current;
      if (!svg) return 0;
      const rect = svg.getBoundingClientRect();
      const vbX = ((clientX - rect.left) / rect.width) * W;
      const dataX = lo + ((vbX - PLOT.l) / (PLOT.r - PLOT.l)) * (hi - lo);
      return Math.min(hi, Math.max(lo, dataX));
    },
    [lo, hi],
  );

  const onPointerDown = (id: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    dragId.current = id;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragId.current) return;
    onSpecChange(applyHandle(spec, dragId.current, pointerToData(e.clientX)));
  };
  const onPointerUp = () => {
    dragId.current = null;
  };

  const xTicks = niceTicks(lo, hi, 6);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full touch-none select-none"
      role="img"
      aria-label="Belief density and contract payoff"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <title>Belief PDF and payoff overlay</title>

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
            opacity={0.5}
          />
          <text
            x={sx(t)}
            y={H - 10}
            textAnchor="middle"
            className="fill-[var(--color-muted)]"
            fontSize={11}
          >
            {fmt(t, 0)}
          </text>
        </g>
      ))}

      {/* belief PDF: filled area + outline */}
      <path
        d={`${toPath(pdf, sx, syPdf)} L${sx(hi).toFixed(2)} ${syPdf(0).toFixed(2)} L${sx(lo).toFixed(2)} ${syPdf(0).toFixed(2)} Z`}
        fill="var(--color-accent)"
        opacity={0.16}
      />
      <path d={toPath(pdf, sx, syPdf)} fill="none" stroke="var(--color-accent)" strokeWidth={2} />

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
        μ {fmt(mu, 0)}
      </text>

      {/* payoff overlay */}
      <path d={toPath(pay, sx, syPay)} fill="none" stroke="var(--color-buy)" strokeWidth={2} />

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
            θ* {fmt(thetaStar, 0)}
          </text>
        </g>
      )}

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

      {/* unit caption */}
      <text
        x={PLOT.r}
        y={H - 10}
        textAnchor="end"
        className="fill-[var(--color-muted)]"
        fontSize={10}
      >
        {outcomeUnit}
      </text>
    </svg>
  );
}
