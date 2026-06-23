// the belief "ghost trail", in its own modal so it never crowds the trading
// chart. Overlays faded snapshots of the market's past belief PDFs on the shared θ
// (outcome) axis: older = fainter, newest = solid, so disagreement-then-consensus
// reads as two bumps drifting and fading into one. Time is encoded as opacity (the
// main chart has no spare axis for it). A scrubber walks the snapshots, highlighting
// one at a time, and a play button animates past → present.
// Pure presentation: every curve is the snapshot's true belief density redrawn from
// the persisted `belief_state` (multi-modal shape included), via `beliefFromSnapshot`
// → core `.pdf`; the faded-polyline geometry comes from the pure `ghostTrail` helper.

import { useEffect, useMemo, useRef, useState } from 'react';
import { beliefFromSnapshot } from '../lib/beliefFromView.ts';
import { fmt, timeAgo } from '../lib/format.ts';
import type { BeliefHistoryPoint } from '../lib/types.ts';
import { type GhostInput, ghostTrail, niceTicks, scale, smoothPath } from '../lib/viz.ts';
import { Modal } from './ui.tsx';

const W = 720;
const H = 320;
const P = { l: 16, r: 16, t: 18, b: 30 };
const MAX_GHOSTS = 8;

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
  const sx = scale(lo, hi, P.l, W - P.r);
  // Shared y: every ghost is already peak-normalised to ≤1 by ghostTrail.
  const sy = scale(0, 1.06, H - P.b, P.t);

  const g = ghosts.length;
  // Scrubber selects one ghost to spotlight; defaults to the newest (present).
  const [sel, setSel] = useState(g - 1);
  const selIdx = Math.min(sel, g - 1);
  useEffect(() => setSel(g - 1), [g]); // re-anchor when the data changes

  // Play: a rAF clock that walks past → present, then stops at the present.
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number | null>(null);
  const lastStep = useRef(0);
  useEffect(() => {
    if (!playing) return;
    const tick = (ts: number) => {
      if (ts - lastStep.current > 650) {
        lastStep.current = ts;
        setSel((s) => {
          if (s >= g - 1) {
            setPlaying(false);
            return s;
          }
          return s + 1;
        });
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
    };
  }, [playing, g]);

  const togglePlay = () => {
    // Restart from the oldest if we're at (or past) the present.
    if (!playing && selIdx >= g - 1) setSel(0);
    setPlaying((p) => !p);
  };

  const selGhost = ghosts[selIdx];
  const selPoint = selGhost ? byT.get(selGhost.t) : undefined;
  const xTicks = niceTicks(lo, hi, 6);

  const enough = points.length >= 2 && g > 0;

  return (
    <Modal title="Belief timeline" onClose={onClose}>
      <div className="flex flex-col gap-3 p-4">
        <p className="text-xs text-muted">
          How the consensus got here — each faded curve is the market's belief at an earlier moment,
          on the same outcome axis. Older snapshots are <span className="text-fg">fainter</span> and
          the <span className="text-accent">solid</span> curve is now. Watch the bump drift and
          sharpen as trades land.
        </p>

        {!enough ? (
          <div className="surface-2 rounded-xl border border-edge p-8 text-center text-sm text-muted">
            Not enough history yet — the timeline appears once the belief has moved a few times.
          </div>
        ) : (
          <>
            <div className="surface-2 rounded-xl border border-edge p-2">
              <svg
                viewBox={`0 0 ${W} ${H}`}
                className="w-full"
                role="img"
                aria-label="Belief ghost trail over the market's life"
              >
                <title>Belief PDF snapshots over time (older = fainter)</title>
                <defs>
                  <filter id="bt-glow" x="-20%" y="-20%" width="140%" height="140%">
                    <feGaussianBlur stdDeviation={2.2} result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>

                {/* baseline */}
                <line
                  x1={P.l}
                  x2={W - P.r}
                  y1={sy(0)}
                  y2={sy(0)}
                  stroke="var(--color-edge)"
                  opacity={0.7}
                />

                {/* x (θ) ticks */}
                {xTicks.map((t) => (
                  <g key={`xt-${t}`}>
                    <line
                      x1={sx(t)}
                      x2={sx(t)}
                      y1={sy(0)}
                      y2={sy(0) + 4}
                      stroke="var(--color-muted)"
                    />
                    <text
                      x={sx(t)}
                      y={sy(0) + 15}
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

                {/* ghost trail: older snapshots first (under), newest last (on top) */}
                {ghosts.map((gh, i) => {
                  const spotlight = i === selIdx;
                  return (
                    <path
                      key={`ghost-${i}`}
                      d={smoothPath(gh.pts, sx, sy)}
                      fill="none"
                      stroke="var(--color-accent)"
                      strokeWidth={gh.newest || spotlight ? 2.4 : 1.6}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={spotlight ? 1 : gh.opacity * 0.6}
                      filter={gh.newest || spotlight ? 'url(#bt-glow)' : undefined}
                    />
                  );
                })}

                {/* spotlighted snapshot's mean marker */}
                {selPoint && selPoint.mu >= lo && selPoint.mu <= hi && (
                  <line
                    x1={sx(selPoint.mu)}
                    x2={sx(selPoint.mu)}
                    y1={P.t}
                    y2={sy(0)}
                    stroke="var(--color-accent)"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    opacity={0.8}
                  />
                )}

                {/* resolution marker */}
                {thetaStar != null && thetaStar >= lo && thetaStar <= hi && (
                  <g>
                    <line
                      x1={sx(thetaStar)}
                      x2={sx(thetaStar)}
                      y1={P.t}
                      y2={sy(0)}
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
                aria-label={playing ? 'Pause' : 'Play timeline'}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-accent bg-grad-accent text-ink glow-accent transition-transform hover:scale-105"
              >
                {playing ? '❚❚' : '▶'}
              </button>
              <input
                type="range"
                min={0}
                max={Math.max(0, g - 1)}
                value={selIdx}
                onChange={(e) => {
                  setPlaying(false);
                  setSel(Number(e.target.value));
                }}
                aria-label="Scrub belief history"
                className="h-1.5 w-full cursor-pointer accent-[var(--color-accent)]"
              />
              <div className="w-28 shrink-0 text-right text-xs">
                <span className="font-semibold text-accent">
                  {selIdx === g - 1 ? 'now' : timeAgo(selGhost?.t ?? null)}
                </span>
                {selPoint && (
                  <span className="block text-muted">
                    μ {fmt(selPoint.mu)} · σ {fmt(selPoint.sigma)}
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
