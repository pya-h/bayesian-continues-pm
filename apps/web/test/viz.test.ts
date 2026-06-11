import { describe, expect, test } from 'bun:test';
import { Phi, payoff } from '@bmm/core';
import type { ContractSpec } from '../src/lib/types.ts';
import {
  VIEW_MUL_MAX,
  VIEW_MUL_MIN,
  clampViewMul,
  gaussianPdf,
  niceDomain,
  niceTicks,
  panOffset,
  payoffCurve,
  pdfCurve,
  pickHandle,
  pnlCurve,
  probInRegions,
  scale,
  viewDomain,
  winningRegions,
  zeroCrossings,
  zoomMul,
} from '../src/lib/viz.ts';

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

describe('gaussianPdf', () => {
  test('peak at the mean equals 1/(σ√2π)', () => {
    expect(close(gaussianPdf(5, 5, 2), 1 / (2 * Math.sqrt(2 * Math.PI)))).toBe(true);
  });
  test('symmetric about the mean', () => {
    expect(close(gaussianPdf(3, 5, 2), gaussianPdf(7, 5, 2))).toBe(true);
  });
  test('integrates to ~1 over a wide grid', () => {
    const mu = 100;
    const sigma = 8;
    let area = 0;
    const lo = mu - 8 * sigma;
    const hi = mu + 8 * sigma;
    const n = 20_000;
    const dx = (hi - lo) / n;
    for (let i = 0; i < n; i++) area += gaussianPdf(lo + (i + 0.5) * dx, mu, sigma) * dx;
    expect(close(area, 1, 1e-4)).toBe(true);
  });
});

describe('pdfCurve', () => {
  test('spans the domain with n+1 points and is max at μ', () => {
    const pts = pdfCurve(50, 10, [20, 80], 60);
    expect(pts.length).toBe(61);
    expect(pts[0]?.x).toBe(20);
    expect(pts[pts.length - 1]?.x).toBe(80);
    const ymax = Math.max(...pts.map((p) => p.y));
    const atMu = pts.reduce((best, p) => (Math.abs(p.x - 50) < Math.abs(best.x - 50) ? p : best));
    expect(close(atMu.y, ymax, 1e-3)).toBe(true);
  });
});

describe('payoffCurve faithfulness to core.payoff', () => {
  const specs: ContractSpec[] = [
    { type: 'LINEAR' },
    { type: 'CALL', strike: 60 },
    { type: 'PUT', strike: 40 },
    { type: 'BINARY_CALL', strike: 55 },
    { type: 'SPREAD', lower: 45, upper: 65 },
    { type: 'GAUSSIAN', center: 50, width: 8 },
  ];
  for (const spec of specs) {
    test(`every sample equals core.payoff — ${spec.type}`, () => {
      for (const p of payoffCurve(spec, [10, 90], 50)) {
        expect(close(p.y, payoff(spec, p.x), 1e-12)).toBe(true);
      }
    });
  }
  test('injects exact kink samples for a CALL strike', () => {
    const xs = payoffCurve({ type: 'CALL', strike: 60 }, [10, 90], 40).map((p) => p.x);
    expect(xs.some((x) => x === 60)).toBe(true);
  });
});

describe('winningRegions', () => {
  test('CALL is the in-the-money ray clipped to domain', () => {
    expect(winningRegions({ type: 'CALL', strike: 60 }, [10, 90])).toEqual([[60, 90]]);
  });
  test('PUT is the lower ray', () => {
    expect(winningRegions({ type: 'PUT', strike: 40 }, [10, 90])).toEqual([[10, 40]]);
  });
  test('SPREAD is the box interior', () => {
    expect(winningRegions({ type: 'SPREAD', lower: 45, upper: 65 }, [10, 90])).toEqual([[45, 65]]);
  });
  test('BINARY_PUT is the lower ray', () => {
    expect(winningRegions({ type: 'BINARY_PUT', strike: 50 }, [10, 90])).toEqual([[10, 50]]);
  });
  test('GAUSSIAN is the full-width-half-max band centred on c', () => {
    const w = 8;
    const hw = w * Math.sqrt(2 * Math.LN2);
    const [[a, b]] = winningRegions({ type: 'GAUSSIAN', center: 50, width: w }, [0, 100]);
    expect(close(a, 50 - hw)).toBe(true);
    expect(close(b, 50 + hw)).toBe(true);
  });
  test('LINEAR has no discrete winning region', () => {
    expect(winningRegions({ type: 'LINEAR' }, [10, 90])).toEqual([]);
  });
});

describe('probInRegions matches the normal CDF', () => {
  test('BINARY_CALL win-prob equals 1 − Φ((K−μ)/σ)', () => {
    const mu = 50;
    const sigma = 10;
    const regions = winningRegions({ type: 'BINARY_CALL', strike: 55 }, [
      mu - 6 * sigma,
      mu + 6 * sigma,
    ]);
    const p = probInRegions(mu, sigma, regions);
    expect(close(p, 1 - Phi((55 - mu) / sigma), 1e-6)).toBe(true);
  });
  test('clamped to [0,1]', () => {
    const p = probInRegions(0, 1, [[-100, 100]]);
    expect(p).toBeLessThanOrEqual(1);
    expect(p).toBeGreaterThanOrEqual(0);
  });
});

describe('niceDomain', () => {
  test('defaults to μ ± 4σ', () => {
    expect(niceDomain(100, 10)).toEqual([60, 140]);
  });
  test('widens to include an out-of-band kink', () => {
    const [lo, hi] = niceDomain(100, 10, { kinks: [200] });
    expect(hi).toBeGreaterThanOrEqual(200);
    expect(lo).toBe(60);
  });
  test('clamps to outcome bounds', () => {
    const [lo, hi] = niceDomain(100, 10, { min: 70, max: 130 });
    expect(lo).toBe(70);
    expect(hi).toBe(130);
  });
  test('never degenerate', () => {
    const [lo, hi] = niceDomain(5, 0);
    expect(hi).toBeGreaterThan(lo);
  });
});

describe('niceTicks & scale', () => {
  test('ticks are round and within range', () => {
    const ticks = niceTicks(0, 100, 5);
    expect(ticks.length).toBeGreaterThan(2);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(100);
    }
  });
  test('scale maps endpoints to the pixel range', () => {
    const s = scale(0, 10, 100, 200);
    expect(close(s(0), 100)).toBe(true);
    expect(close(s(10), 200)).toBe(true);
    expect(close(s(5), 150)).toBe(true);
  });
});

describe('pnlCurve', () => {
  test('pnl(θ) = q·payoff − costBasis, exactly on the kinks', () => {
    const spec: ContractSpec = { type: 'CALL', strike: 100 };
    const q = 10;
    const cost = 30; // total premium paid
    const pts = pnlCurve(spec, q, cost, [80, 130], 100);
    for (const p of pts) {
      expect(close(p.y, q * payoff(spec, p.x) - cost, 1e-9)).toBe(true);
    }
    // Below the strike the call expires worthless → flat at −costBasis.
    const belowStrike = pts.filter((p) => p.x < 99);
    for (const p of belowStrike) expect(close(p.y, -cost)).toBe(true);
  });
});

describe('zeroCrossings', () => {
  test('finds the breakeven of a long call by interpolation', () => {
    // pnl crosses zero where 10·max(θ−100,0) = 30 → θ = 103.
    const spec: ContractSpec = { type: 'CALL', strike: 100 };
    const pts = pnlCurve(spec, 10, 30, [90, 130], 400);
    const zeros = zeroCrossings(pts);
    expect(zeros.length).toBe(1);
    expect(close(zeros[0] ?? 0, 103, 0.1)).toBe(true);
  });
  test('a curve that never changes sign has no crossings', () => {
    expect(
      zeroCrossings([
        { x: 0, y: 1 },
        { x: 1, y: 2 },
        { x: 2, y: 3 },
      ]).length,
    ).toBe(0);
  });
});

// interactive view: pan / zoom math --------------------------------------

describe('clampViewMul', () => {
  test('clamps to the per-axis multiplier bounds', () => {
    expect(clampViewMul(1)).toBe(1);
    expect(clampViewMul(0.01)).toBe(VIEW_MUL_MIN);
    expect(clampViewMul(1000)).toBe(VIEW_MUL_MAX);
  });
});

describe('zoomMul', () => {
  test('a zero exponent leaves the multiplier unchanged', () => {
    expect(close(zoomMul(1, 0), 1)).toBe(true);
    expect(close(zoomMul(2.5, 0), 2.5)).toBe(true);
  });
  test('positive exponent widens, negative tightens', () => {
    expect(zoomMul(1, 0.5)).toBeGreaterThan(1);
    expect(zoomMul(1, -0.5)).toBeLessThan(1);
  });
  test('result is clamped to the multiplier bounds', () => {
    expect(zoomMul(1, 100)).toBe(VIEW_MUL_MAX);
    expect(zoomMul(1, -100)).toBe(VIEW_MUL_MIN);
  });
});

describe('viewDomain', () => {
  test('the identity view returns the base domain', () => {
    expect(viewDomain([300, 400], { xMul: 1, xOff: 0 })).toEqual([300, 400]);
  });
  test('scaling up widens the range about its centre (300–400 → 200–500)', () => {
    expect(viewDomain([300, 400], { xMul: 3, xOff: 0 })).toEqual([200, 500]);
  });
  test('scaling down tightens the range about its centre', () => {
    expect(viewDomain([300, 400], { xMul: 0.5, xOff: 0 })).toEqual([325, 375]);
  });
  test('offset slides the window without changing its span', () => {
    const [lo, hi] = viewDomain([300, 400], { xMul: 1, xOff: 100 });
    expect([lo, hi]).toEqual([400, 500]);
    expect(hi - lo).toBe(100); // span preserved
  });
  test('a pan is slid back inside the outcome bounds, keeping its span', () => {
    // window [2,4] pushed far right, bounds [0,10] → slides to [8,10] (span 2).
    expect(viewDomain([2, 4], { xMul: 1, xOff: 100 }, 0, 10)).toEqual([8, 10]);
  });
  test('a window wider than the bounds is clamped to the full bounds', () => {
    expect(viewDomain([0, 10], { xMul: 2, xOff: 0 }, 0, 10)).toEqual([0, 10]);
  });
  test('a degenerate base domain is never returned as zero-width', () => {
    const [lo, hi] = viewDomain([5, 5], { xMul: 1, xOff: 0 });
    expect(hi).toBeGreaterThan(lo);
  });
});

describe('panOffset', () => {
  test('dragging left (dx < 0) increases the offset → window slides to higher θ', () => {
    expect(panOffset(0, -50, 100, 500)).toBe(10);
  });
  test('dragging right (dx > 0) decreases the offset', () => {
    expect(panOffset(0, 50, 100, 500)).toBe(-10);
  });
  test('accumulates from the base offset', () => {
    expect(panOffset(10, -50, 100, 500)).toBe(20);
  });
  test('never divides by zero on a zero-width plot', () => {
    expect(Number.isFinite(panOffset(0, 50, 100, 0))).toBe(true);
  });
});

describe('pickHandle', () => {
  test('grabs the nearest handle within the radius', () => {
    expect(pickHandle([100, 200], 105, 16)).toBe(0);
    expect(pickHandle([100, 200], 190, 16)).toBe(1);
  });
  test('returns -1 when the press is beyond every handle', () => {
    expect(pickHandle([100, 200], 150, 16)).toBe(-1);
    expect(pickHandle([], 50, 16)).toBe(-1);
  });
  test('the radius is inclusive', () => {
    expect(pickHandle([100], 116, 16)).toBe(0);
    expect(pickHandle([100], 117, 16)).toBe(-1);
  });
  test('coincident handles resolve to the last (top-drawn) one — the min-width bell', () => {
    // center & width handles both at x=100: a press grabs width (index 1).
    expect(pickHandle([100, 100], 100, 16)).toBe(1);
  });
});
