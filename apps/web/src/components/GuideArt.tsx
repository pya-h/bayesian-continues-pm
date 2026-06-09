// GuideArt — small, theme-aware SVG illustrations for the Guide. Pure inline SVG
// (no image files), drawn from the very payoff shapes the engine prices, so the
// pictures match what users actually trade. All static — safe under
// prefers-reduced-motion. Colours come from CSS tokens so they track the theme.

import type { ReactNode } from 'react';
import type { ContractSpec } from '../lib/types.ts';

const W = 144;
const H = 84;
const PAD = 12;

const px = (t: number) => PAD + t * (W - 2 * PAD); // t ∈ [0,1] → x
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const py = (v: number) => H - PAD - clamp01(v) * (H - 2 * PAD); // v ∈ [0,1] → y (0 = baseline)

function line(fn: (t: number) => number, n = 72): string {
  let d = '';
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    d += `${i === 0 ? 'M' : 'L'} ${px(t).toFixed(2)} ${py(fn(t)).toFixed(2)} `;
  }
  return d.trim();
}
const fillUnder = (d: string) =>
  `${d} L ${px(1).toFixed(2)} ${py(0).toFixed(2)} L ${px(0).toFixed(2)} ${py(0).toFixed(2)} Z`;

function Frame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={label}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full"
    >
      <line
        x1={px(0)}
        y1={py(0)}
        x2={px(1)}
        y2={py(0)}
        stroke="var(--color-edge)"
        strokeWidth={1}
      />
      {children}
    </svg>
  );
}

function Shape({ d, label }: { d: string; label: string }) {
  return (
    <Frame label={label}>
      <path d={fillUnder(d)} fill="var(--color-accent)" fillOpacity={0.14} />
      <path d={d} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinejoin="round" />
    </Frame>
  );
}

// ── payoff shapes f(θ), normalised to the unit box ────────────────────────

const call = (t: number) => Math.max(0, (t - 0.42) / 0.58);
const put = (t: number) => Math.max(0, (0.58 - t) / 0.58);
const linear = (t: number) => t;
const bell = (t: number) => Math.exp(-((t - 0.5) ** 2) / (2 * 0.13 ** 2));

const binaryStep = `M ${px(0)} ${py(0)} L ${px(0.5)} ${py(0)} L ${px(0.5)} ${py(0.85)} L ${px(1)} ${py(0.85)}`;
const binaryStepArea = `${binaryStep} L ${px(1)} ${py(0)} Z`;
const spreadHat = `M ${px(0)} ${py(0)} L ${px(0.33)} ${py(0)} L ${px(0.33)} ${py(0.85)} L ${px(0.67)} ${py(0.85)} L ${px(0.67)} ${py(0)} L ${px(1)} ${py(0)}`;
const spreadHatArea = `M ${px(0.33)} ${py(0)} L ${px(0.33)} ${py(0.85)} L ${px(0.67)} ${py(0.85)} L ${px(0.67)} ${py(0)} Z`;

export function PayoffArt({ kind }: { kind: ContractSpec['type'] }) {
  switch (kind) {
    case 'CALL':
      return <Shape d={line(call)} label="Call payoff" />;
    case 'PUT':
      return <Shape d={line(put)} label="Put payoff" />;
    case 'LINEAR':
      return <Shape d={line(linear)} label="Linear payoff" />;
    case 'GAUSSIAN':
      return <Shape d={line(bell)} label="Bell payoff" />;
    case 'BINARY_CALL':
    case 'BINARY_PUT':
      return (
        <Frame label="Binary payoff">
          <path d={binaryStepArea} fill="var(--color-accent)" fillOpacity={0.14} />
          <path d={binaryStep} fill="none" stroke="var(--color-accent)" strokeWidth={2} />
        </Frame>
      );
    case 'SPREAD':
      return (
        <Frame label="Spread payoff">
          <path d={spreadHatArea} fill="var(--color-accent)" fillOpacity={0.14} />
          <path d={spreadHat} fill="none" stroke="var(--color-accent)" strokeWidth={2} />
        </Frame>
      );
    default:
      return <Shape d={line(linear)} label="payoff" />;
  }
}

// The belief picture: a Gaussian density with the μ centre line and a ±σ band —
// the "two numbers that drive a market" made visual.
export function BeliefArt() {
  const d = line(bell);
  // ±σ band in t-space (reads well a touch inside the ±1σ points of the curve).
  const sLo = 0.32;
  const sHi = 0.68;
  return (
    <Frame label="Belief density: consensus μ with a ±σ band">
      {/* σ band */}
      <rect
        x={px(sLo)}
        y={py(1)}
        width={px(sHi) - px(sLo)}
        height={py(0) - py(1)}
        fill="var(--color-accent)"
        fillOpacity={0.1}
      />
      <path d={fillUnder(d)} fill="var(--color-accent)" fillOpacity={0.16} />
      <path d={d} fill="none" stroke="var(--color-accent)" strokeWidth={2} />
      {/* μ line */}
      <line
        x1={px(0.5)}
        y1={py(1)}
        x2={px(0.5)}
        y2={py(0)}
        stroke="var(--color-accent)"
        strokeWidth={1.5}
        strokeDasharray="3 3"
      />
    </Frame>
  );
}

// A profit/loss diagram (a bought Call): flat at a small loss below breakeven
// rising into profit above it. Green where you gain, red where you lose, with a
// dashed zero line and a breakeven marker — exactly what the payoff chart shows.
export function PnlArt() {
  // vertical: map signed P&L in [-0.5, 1] with zero a third of the way up.
  const TOP = 1;
  const BOT = -0.5;
  const vy = (v: number) => PAD + ((TOP - v) / (TOP - BOT)) * (H - 2 * PAD);
  const zeroY = vy(0);
  const be = 0.6; // breakeven in t-space
  const pnl = (t: number) => Math.max(-0.4, Math.min(1, (t - be) / 0.4));

  const sample = (a: number, b: number, n = 40) =>
    Array.from({ length: n + 1 }, (_, i) => {
      const t = a + ((b - a) * i) / n;
      return `${px(t).toFixed(2)} ${vy(pnl(t)).toFixed(2)}`;
    });

  const lossPoly = `${px(0)} ${zeroY} ${sample(0, be).join(' L ')} L ${px(be)} ${zeroY}`;
  const gainPoly = `${px(be)} ${zeroY} ${sample(be, 1).join(' L ')} L ${px(1)} ${zeroY}`;
  const curve = `M ${[...sample(0, 1)].join(' L ')}`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Profit and loss across outcomes"
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full"
    >
      <polygon points={lossPoly} fill="var(--color-sell)" fillOpacity={0.16} />
      <polygon points={gainPoly} fill="var(--color-buy)" fillOpacity={0.16} />
      <line
        x1={px(0)}
        y1={zeroY}
        x2={px(1)}
        y2={zeroY}
        stroke="var(--color-edge)"
        strokeWidth={1}
        strokeDasharray="3 3"
      />
      <path d={curve} fill="none" stroke="var(--color-fg)" strokeWidth={2} strokeLinejoin="round" />
      <circle cx={px(be)} cy={zeroY} r={2.6} fill="var(--color-accent)" />
    </svg>
  );
}
