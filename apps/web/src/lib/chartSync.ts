// Cross-chart sync for the market page. The belief chart and the optional panel
// charts below it (CDF, fair-price) all read the SAME x-axis view transform and the
// SAME hovered outcome θ from this tiny external store — so panning/zooming or
// hovering on any one of them is reflected on the others, letting a trader line a
// single outcome up across every view.
// Why a store and not page state: routing per-frame pan/zoom/hover through the
// market page would re-render the whole (heavy) page every animation frame — the
// exact lag the drag path already avoids via `liveSpec`. Here only the subscribed
// chart components re-render; the page stays out of the loop. A single market page
// is mounted at a time, so a module singleton is sufficient; `resetChartSync`
// clears it on market change / unmount.

import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { type Domain, panOffset, zoomMul } from './viz.ts';

export interface ChartView {
  xMul: number;
  xOff: number;
  yMul: number;
}
const IDENTITY: ChartView = { xMul: 1, xOff: 0, yMul: 1 };

let view: ChartView = IDENTITY;
let hoverTheta: number | null = null;
const listeners = new Set<() => void>();
function emit(): void {
  for (const fn of listeners) fn();
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getChartView(): ChartView {
  return view;
}
export function setChartView(next: ChartView): void {
  if (next.xMul === view.xMul && next.xOff === view.xOff && next.yMul === view.yMul) return;
  view = next;
  emit();
}
export function getHoverTheta(): number | null {
  return hoverTheta;
}
export function setHoverTheta(t: number | null): void {
  if (t === hoverTheta) return;
  hoverTheta = t;
  emit();
}
export function resetChartSync(): void {
  let changed = false;
  if (view !== IDENTITY) {
    view = IDENTITY;
    changed = true;
  }
  if (hoverTheta !== null) {
    hoverTheta = null;
    changed = true;
  }
  if (changed) emit();
}

export function useChartView(): ChartView {
  return useSyncExternalStore(subscribe, getChartView);
}
// Subscribe to the shared hovered outcome θ (null when nothing is hovered).
export function useHoverTheta(): number | null {
  return useSyncExternalStore(subscribe, getHoverTheta);
}

// Pointer geometry + pan/zoom/hover wiring for a SECONDARY (panel) chart that
// shares the belief chart's x-axis. Returns SVG handlers that
// pan the shared x-window when the plot interior is dragged horizontally
// zoom the shared x-range when the bottom axis gutter is dragged
// publish the hovered θ to the store as the pointer moves
// all rAF-coalesced and writing only to the store (never to page state). The belief
// chart owns the same math inline (it also drives the y-axis + handle drags); this
// hook is the x-only subset the panels need. `domain` is the panel's CURRENT visible
// [lo, hi] (already `viewDomain(base, view)`), used to map pixels↔θ for this frame.
export function useXAxisSync(opts: {
  svgRef: React.RefObject<SVGSVGElement | null>;
  W: number;
  plotL: number;
  plotR: number;
  domain: Domain;
}) {
  const { svgRef, W, plotL, plotR, domain } = opts;
  const [lo, hi] = domain;
  // True while a pan/zoom drag is live on THIS chart — lets a panel coarsen an
  // expensive (quadrature-priced) sweep per frame and snap back to full at rest.
  const [panning, setPanning] = useState(false);

  const gesture = useRef<{
    kind: 'panx' | 'zoomx';
    startX: number;
    base: ChartView;
    dataSpan: number;
    plotPxW: number;
  } | null>(null);
  const raf = useRef<number | null>(null);
  const lastX = useRef<number | null>(null);

  const thetaAt = useCallback(
    (clientX: number): number | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      const vx = ((clientX - rect.left) / rect.width) * W;
      if (vx < plotL || vx > plotR) return null;
      return lo + ((vx - plotL) / (plotR - plotL)) * (hi - lo);
    },
    [svgRef, W, plotL, plotR, lo, hi],
  );

  const beginGesture = (kind: 'panx' | 'zoomx', e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = svg.getBoundingClientRect();
    gesture.current = {
      kind,
      startX: e.clientX,
      base: getChartView(),
      dataSpan: hi - lo,
      plotPxW: (rect.width * (plotR - plotL)) / W,
    };
    setHoverTheta(null);
    setPanning(true);
    svg.setPointerCapture?.(e.pointerId);
  };

  const onPlotPanDown = (e: React.PointerEvent) => beginGesture('panx', e);
  const onAxisZoomDown = (e: React.PointerEvent) => beginGesture('zoomx', e);

  const onPointerMove = (e: React.PointerEvent) => {
    lastX.current = e.clientX;
    if (raf.current != null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      const x = lastX.current;
      if (x == null) return;
      const g = gesture.current;
      if (g) {
        const dx = x - g.startX;
        if (g.kind === 'panx') {
          setChartView({
            ...g.base,
            xOff: panOffset(g.base.xOff, dx, g.dataSpan, g.plotPxW),
          });
        } else {
          setChartView({ ...g.base, xMul: zoomMul(g.base.xMul, -dx / 220) });
        }
      } else {
        setHoverTheta(thetaAt(x));
      }
    });
  };

  const endGesture = () => {
    if (gesture.current) {
      gesture.current = null;
      setPanning(false);
    }
  };
  const onPointerUp = () => endGesture();
  const onPointerLeave = () => {
    endGesture();
    setHoverTheta(null);
  };
  const onDoubleClick = () => setChartView(IDENTITY);

  return {
    panning,
    onPlotPanDown,
    onAxisZoomDown,
    onPointerMove,
    onPointerUp,
    onPointerLeave,
    onDoubleClick,
  };
}
