// the belief "ghost trail", in its own modal so it never crowds the trading
// chart. Overlays faded snapshots of the market's past belief PDFs on the shared θ
// (outcome) axis: older = fainter, newest = solid, so disagreement-then-consensus
// reads as two bumps drifting and fading into one. Time is encoded as opacity (the
// main chart has no spare axis for it).
// The faded snapshots form a static "comet tail"; on top of them rides a single
// bright **spotlight** curve that the scrubber/▶ walk through time. Because every
// snapshot is sampled on the same x-grid, the spotlight is the
// eased blend of the two snapshots it sits between (`lerpPolyline`) — so playing
// morphs the bump smoothly from one belief to the next instead of snapping. A
// glowing "head" tracks the live mode, and a gradient fill gives the bump body.
// Pure presentation: every curve is the snapshot's true belief density redrawn from
// the persisted `belief_state` (multi-modal shape included), via `beliefFromSnapshot`
// → core `.pdf`; the faded-polyline geometry comes from the pure `ghostTrail` helper.

import { useEffect, useMemo, useRef, useState } from 'react';
import { beliefFromSnapshot } from '../lib/beliefFromView.ts';
import { fmt, timeAgo } from '../lib/format.ts';
import type { BeliefHistoryPoint } from '../lib/types.ts';
import {
  type GhostInput,
  type Pt,
  ghostTrail,
  lerpPolyline,
  niceTicks,
  scale,
  smoothPath,
} from '../lib/viz.ts';
import { usePrefs } from '../prefs/PrefsContext.tsx';
import { Modal } from './ui.tsx';

const W = 760;
const H = 340;
const P = { l: 18, r: 18, t: 22, b: 32 };
const MAX_GHOSTS = 8;
const SEG_MS = 900;

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function BeliefTimeline({
  points,
  outcomeUnit,
  outcomeMin,
  outcomeMax,
  thetaStar,
  onClose,
}: {
  points: BeliefHistoryPoint[];
  outcomeUnit: string;
  outcomeMin: number | null;
  outcomeMax: number | null;
  thetaStar?: number | null;
  onClose: () => void;
}) {
  const { prefs } = usePrefs();
  const animate = prefs.animations;

  // A θ-domain wide enough to hold EVERY snapshot's bump (μ ± 4σ over the whole life)
  // clamped to the market's outcome bounds — so a belief that has since drifted/narrowed
  // is still framed where it used to sit.
  const domain = useMemo<[number, number]>(() => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const p of points) {
      lo = Math.min(lo, p.mu - 4 * p.sigma);
      hi = Math.max(hi, p.mu + 4 * p.sigma);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
    if (outcomeMin != null) lo = Math.max(lo, outcomeMin);
    if (outcomeMax != null) hi = Math.min(hi, outcomeMax);
    if (!(hi > lo)) hi = lo + Math.max(1, Math.abs(lo) * 1e-3);
    return [lo, hi];
  }, [points, outcomeMin, outcomeMax]);

  // Reconstruct each snapshot's real belief and sample it — the ghost trail itself
  // plus a timestamp→point lookup so the scrubber can read off μ/σ/time.
  const ghosts = useMemo(() => {
    const series: GhostInput[] = points.map((p) => {
      const model = beliefFromSnapshot(p.belief, p.mu, p.sigma);
      return { t: p.t, pdf: (x: number) => model.pdf(x) };
    });
    return ghostTrail(series, domain, { samples: 160, maxGhosts: MAX_GHOSTS });
  }, [points, domain]);

  const byT = useMemo(() => new Map(points.map((p) => [p.t, p])), [points]);

  const [lo, hi] = domain;
  const sx = useMemo(() => scale(lo, hi, P.l, W - P.r), [lo, hi]);
  // Shared y: every ghost is already peak-normalised to ≤1 by ghostTrail.
  const sy = useMemo(() => scale(0, 1.08, H - P.b, P.t), []);

  const g = ghosts.length;
  const span = Math.max(1, g - 1);

  // Continuous play-head in [0, g-1]. Integer = exactly on a snapshot; a fraction =
  // mid-morph. The scrubber and ▶ both drive it; the curve interpolates from it.
  const [pos, setPos] = useState(g - 1);
  const [playing, setPlaying] = useState(false);
  // Re-anchor to the present whenever the data changes (the snapshot count g).
  useEffect(() => {
    setPos(g - 1);
    setPlaying(false);
  }, [g]);

  // Play: a rAF clock advancing the head at one snapshot per SEG_MS, past → present.
  const prevTs = useRef<number | null>(null);
  useEffect(() => {
    if (!playing) return;
    prevTs.current = null;
    let raf = 0;
    const tick = (ts: number) => {
      if (prevTs.current == null) prevTs.current = ts;
      const dt = ts - prevTs.current;
      prevTs.current = ts;
      setPos((p) => Math.min(g - 1, p + dt / SEG_MS));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, g]);

  // Stop at the present.
  useEffect(() => {
    if (playing && pos >= g - 1) setPlaying(false);
  }, [playing, pos, g]);

  const togglePlay = () => {
    if (!playing && pos >= g - 1 - 1e-6) setPos(0); // restart from the oldest
    setPlaying((p) => !p);
  };

  // The two snapshots the head sits between, and the eased blend fraction.
  const i0 = Math.max(0, Math.min(Math.floor(pos), g - 1));
  const i1 = Math.min(i0 + 1, g - 1);
  const fracRaw = Math.max(0, Math.min(1, pos - i0));
  // With motion off, snap to the nearer snapshot instead of morphing.
  const frac = animate ? easeInOut(fracRaw) : fracRaw >= 0.5 ? 1 : 0;

  const spotPts: Pt[] =
    g > 0 ? lerpPolyline(ghosts[i0]?.pts ?? [], ghosts[i1]?.pts ?? [], frac) : [];
  const spotD = smoothPath(spotPts, sx, sy);
  const areaD =
    spotPts.length > 1
      ? `${spotD} L${sx((spotPts.at(-1) as Pt).x).toFixed(2)} ${sy(0).toFixed(2)} L${sx((spotPts[0] as Pt).x).toFixed(2)} ${sy(0).toFixed(2)} Z`
      : '';

  // The "comet head": the live mode (tallest point) of the spotlighted curve.
  let head: Pt | undefined = spotPts[0];
  for (const p of spotPts) if (head && p.y > head.y) head = p;

  // Interpolated readout (μ/σ glide with the morph), plus the nearest snapshot's time.
  const m0 = byT.get(ghosts[i0]?.t ?? '');
  const m1 = byT.get(ghosts[i1]?.t ?? '');
  const muNow = m0 && m1 ? lerp(m0.mu, m1.mu, frac) : (m0?.mu ?? m1?.mu);
  const sigNow = m0 && m1 ? lerp(m0.sigma, m1.sigma, frac) : (m0?.sigma ?? m1?.sigma);
  const selRound = Math.round(pos);
  const atNow = selRound >= g - 1;

  // Static comet-tail paths (memoised — they don't change as the head moves).
  const trail = useMemo(
    () => ghosts.map((gh) => ({ t: gh.t, d: smoothPath(gh.pts, sx, sy), opacity: gh.opacity })),
    [ghosts, sx, sy],
  );
  const xTicks = useMemo(() => niceTicks(lo, hi, 6), [lo, hi]);

  const enough = points.length >= 2 && g > 0;
  const headFill = head && head.x >= lo && head.x <= hi;
  const baselineY = sy(0);

  return (
    <Modal title="Belief timeline" onClose={onClose}>
      <div className="flex flex-col gap-3 p-4">
        <p className="text-xs text-muted">
          How the consensus got here — each faded curve is the market's belief at an earlier moment,
          on the same outcome axis. Older snapshots are <span className="text-fg">fainter</span> and
          the <span className="text-accent">glowing</span> curve is the moment you're viewing. Press
          play to watch the bump drift and sharpen as trades land.
        </p>

        {!enough ? (
          <div className="surface-2 rounded-xl border border-edge p-8 text-center text-sm text-muted">
            Not enough history yet — the timeline appears once the belief has moved a few times.
          </div>
        ) : (
          <>
            <div className="surface-2 relative overflow-hidden rounded-xl border border-edge p-2">
              <svg
                viewBox={`0 0 ${W} ${H}`}
                className="w-full"
                role="img"
                aria-label="Belief ghost trail over the market's life"
              >
                <title>Belief PDF snapshots over time (older = fainter)</title>
                <defs>
                  <filter id="bt-glow" x="-30%" y="-30%" width="160%" height="160%">
                    <feGaussianBlur stdDeviation={2.6} result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                  <filter id="bt-head-glow" x="-150%" y="-150%" width="400%" height="400%">
                    <feGaussianBlur stdDeviation={3.4} />
                  </filter>
                  <linearGradient id="bt-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.34} />
                    <stop offset="55%" stopColor="var(--color-accent)" stopOpacity={0.12} />
                    <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
                  </linearGradient>
                  <radialGradient id="bt-bg" cx="50%" cy="2%" r="95%">
                    <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.07} />
                    <stop offset="70%" stopColor="var(--color-accent)" stopOpacity={0} />
                  </radialGradient>
                </defs>

                {/* a soft accent wash from the top, for depth */}
                <rect x={0} y={0} width={W} height={H} fill="url(#bt-bg)" />

                {/* baseline */}
                <line
                  x1={P.l}
                  x2={W - P.r}
                  y1={baselineY}
                  y2={baselineY}
                  stroke="var(--color-edge)"
                  opacity={0.7}
                />

                {/* x (θ) ticks */}
                {xTicks.map((t) => (
                  <g key={`xt-${t}`}>
                    <line
                      x1={sx(t)}
                      x2={sx(t)}
                      y1={baselineY}
                      y2={baselineY + 4}
                      stroke="var(--color-muted)"
                    />
                    <text
                      x={sx(t)}
                      y={baselineY + 16}
                      textAnchor="middle"
                      fontSize={10}
                      className="fill-[var(--color-muted)]"
                    >
                      {fmt(t)}
                    </text>
                  </g>
                ))}
                <text
                  x={W - P.r}
                  y={H - 4}
                  textAnchor="end"
                  fontSize={10}
                  className="fill-[var(--color-muted)]"
                >
                  {outcomeUnit}
                </text>

                {/* comet tail: the faded static snapshots (older under, newer over) */}
                {trail.map((tr) => (
                  <path
                    key={`ghost-${tr.t}`}
                    d={tr.d}
                    fill="none"
                    stroke="var(--color-accent)"
                    strokeWidth={1.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={tr.opacity * 0.45}
                  />
                ))}

                {/* spotlight: gradient bump body + glowing crest, the moment in focus */}
                {areaD && <path d={areaD} fill="url(#bt-fill)" stroke="none" />}
                <path
                  d={spotD}
                  fill="none"
                  stroke="var(--color-accent)"
                  strokeWidth={2.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  filter="url(#bt-glow)"
                />

                {/* comet head: a glowing dot riding the live mode, with a faint drop guide */}
                {head && headFill && (
                  <g>
                    <line
                      x1={sx(head.x)}
                      x2={sx(head.x)}
                      y1={sy(head.y)}
                      y2={baselineY}
                      stroke="var(--color-accent)"
                      strokeWidth={1}
                      strokeDasharray="2 4"
                      opacity={0.35}
                    />
                    <circle
                      cx={sx(head.x)}
                      cy={sy(head.y)}
                      r={9}
                      fill="var(--color-accent)"
                      opacity={0.5}
                      filter="url(#bt-head-glow)"
                    />
                    {/* a gentle radar pulse — motion-gated so reduced-motion stays still */}
                    {animate && (
                      <circle
                        cx={sx(head.x)}
                        cy={sy(head.y)}
                        r={4}
                        fill="none"
                        stroke="var(--color-accent)"
                        strokeWidth={1.5}
                      >
                        <animate
                          attributeName="r"
                          values="4;13"
                          dur="1.8s"
                          repeatCount="indefinite"
                        />
                        <animate
                          attributeName="opacity"
                          values="0.5;0"
                          dur="1.8s"
                          repeatCount="indefinite"
                        />
                      </circle>
                    )}
                    <circle
                      cx={sx(head.x)}
                      cy={sy(head.y)}
                      r={3.4}
                      fill="var(--color-accent)"
                      stroke="var(--color-panel)"
                      strokeWidth={1.4}
                    />
                  </g>
                )}

                {/* resolution marker */}
                {thetaStar != null && thetaStar >= lo && thetaStar <= hi && (
                  <g>
                    <line
                      x1={sx(thetaStar)}
                      x2={sx(thetaStar)}
                      y1={P.t}
                      y2={baselineY}
                      stroke="var(--color-warn)"
                      strokeWidth={2}
                    />
                    <text
                      x={sx(thetaStar) + 4}
                      y={P.t + 11}
                      fontSize={11}
                      className="fill-[var(--color-warn)]"
                    >
                      θ* {fmt(thetaStar)}
                    </text>
                  </g>
                )}
              </svg>
            </div>

            {/* scrubber + play */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={togglePlay}
                aria-label={playing ? 'Pause' : atNow ? 'Replay timeline' : 'Play timeline'}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-accent bg-grad-accent text-ink glow-accent transition-transform duration-150 [transition-timing-function:var(--ease-spring)] hover:scale-110 active:scale-95"
              >
                {playing ? '❚❚' : atNow ? '↻' : '▶'}
              </button>

              {/* custom track: progress fill + snapshot dots + thumb, native range overlaid for input */}
              <div className="relative h-5 flex-1">
                <div className="pointer-events-none absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-edge/70" />
                <div
                  className="pointer-events-none absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-grad-accent"
                  style={{ width: `${(pos / span) * 100}%` }}
                />
                {ghosts.map((gh, i) => (
                  <span
                    key={`dot-${gh.t}`}
                    className={`pointer-events-none absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors ${
                      i <= selRound ? 'bg-accent' : 'bg-edge'
                    }`}
                    style={{ left: `${(i / span) * 100}%` }}
                  />
                ))}
                <span
                  className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-panel glow-accent"
                  style={{ left: `${(pos / span) * 100}%` }}
                />
                <input
                  type="range"
                  min={0}
                  max={g - 1}
                  step="any"
                  value={pos}
                  onChange={(e) => {
                    setPlaying(false);
                    setPos(Number(e.target.value));
                  }}
                  aria-label="Scrub belief history"
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                />
              </div>

              <div className="w-28 shrink-0 text-right text-xs">
                <span className="font-semibold text-accent">
                  {atNow ? 'now' : timeAgo(ghosts[selRound]?.t ?? null)}
                </span>
                {muNow != null && (
                  <span className="block tnum text-muted">
                    μ {fmt(muNow)} · σ {fmt(sigNow ?? 0)}
                  </span>
                )}
              </div>
            </div>
            <p className="text-center text-[11px] text-muted">
              {g} of {points.length} snapshots shown, evenly spaced over the market's life.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
