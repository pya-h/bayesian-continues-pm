import { describe, expect, test } from 'bun:test';
import { Phi, payoff } from '@bmm/core';
import type { ContractSpec } from '../src/lib/types.ts';
import {
  type GhostInput,
  type Pt,
  VIEW_MUL_MAX,
  VIEW_MUL_MIN,
  clampViewMul,
  fitPointDomain,
  gaussianPdf,
  genExactPdf,
  genExactPdfCurve,
  ghostTrail,
  lerpPolyline,
  mixturePdf,
  mixturePdfCurve,
  niceDomain,
  niceTicks,
  panOffset,
  payoffCurve,
  pdfCurve,
  pickHandle,
  pnlCurve,
  probInRegions,
  scale,
  smoothPath,
  studentTPdf,
  studentTPdfCurve,
  tickDecimals,
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

describe('genExactPdf (Gen·exact exp(−poly) chart kernel)', () => {
  test('λ₂=1,λ₃=λ₄=0 peaks at the location and is ~symmetric', () => {
    // raw kernel: exp(−(½u²+λ₆u⁶)), peak (=1) at u=0
    expect(close(genExactPdf(70, 70, 10, [1, 0, 0]), 1)).toBe(true);
    expect(close(genExactPdf(80, 70, 10, [1, 0, 0]), genExactPdf(60, 70, 10, [1, 0, 0]))).toBe(
      true,
    );
    // decays away from the centre
    expect(genExactPdf(90, 70, 10, [1, 0, 0])).toBeLessThan(genExactPdf(75, 70, 10, [1, 0, 0]));
  });

  test('zero outside the standardised support |u|>7', () => {
    expect(genExactPdf(70 + 7.1 * 10, 70, 10, [1, 0, 0])).toBe(0);
    expect(genExactPdf(70 - 8 * 10, 70, 10, [1, 0, 0])).toBe(0);
  });

  test('λ₂<0 is bimodal — the centre is a valley below the side peaks', () => {
    const lam: [number, number, number] = [-1, 0, 0];
    const atCentre = genExactPdf(50, 50, 8, lam);
    const atSide = genExactPdf(50 + 2.5 * 8, 50, 8, lam);
    expect(atSide).toBeGreaterThan(atCentre);
  });

  test('λ₃≠0 breaks symmetry', () => {
    const lam: [number, number, number] = [1, 0.3, 0];
    expect(genExactPdf(80, 70, 10, lam)).not.toBeCloseTo(genExactPdf(60, 70, 10, lam), 6);
  });

  test('genExactPdfCurve spans the domain with n+1 points', () => {
    const pts = genExactPdfCurve(50, 10, [1, 0, 0], [20, 80], 60);
    expect(pts.length).toBe(61);
    expect(pts[0]?.x).toBe(20);
    expect(pts[pts.length - 1]?.x).toBe(80);
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

describe('studentTPdf / studentTPdfCurve (V2-1 fat-tail rendering)', () => {
  test('peak-normalised: =1 at μ, symmetric, monotone away from μ', () => {
    expect(close(studentTPdf(50, 5, 50, 10), 1)).toBe(true);
    expect(close(studentTPdf(58, 5, 50, 10), studentTPdf(42, 5, 50, 10))).toBe(true);
    expect(studentTPdf(55, 5, 50, 10)).toBeLessThan(studentTPdf(52, 5, 50, 10));
    expect(studentTPdf(70, 5, 50, 10)).toBeLessThan(studentTPdf(55, 5, 50, 10));
  });

  test('fatter tails than a Gaussian of equal σ (both peak-normalised)', () => {
    const mu = 50;
    const sigma = 10;
    const far = mu + 4 * sigma;
    const tNorm = studentTPdf(far, 5, mu, sigma); // peak already 1
    const gNorm = gaussianPdf(far, mu, sigma) / gaussianPdf(mu, mu, sigma);
    expect(tNorm).toBeGreaterThan(gNorm);
  });

  test('→ Gaussian shape as ν grows large', () => {
    const mu = 50;
    const sigma = 10;
    const x = 63;
    const tNorm = studentTPdf(x, 2000, mu, sigma);
    const gNorm = gaussianPdf(x, mu, sigma) / gaussianPdf(mu, mu, sigma);
    expect(close(tNorm, gNorm, 5e-3)).toBe(true);
  });

  test('curve spans the domain with n+1 points and peaks at μ', () => {
    const pts = studentTPdfCurve(5, 50, 10, [20, 80], 60);
    expect(pts.length).toBe(61);
    expect(pts[0]?.x).toBe(20);
    const ymax = Math.max(...pts.map((p) => p.y));
    const atMu = pts.reduce((best, p) => (Math.abs(p.x - 50) < Math.abs(best.x - 50) ? p : best));
    expect(close(atMu.y, ymax, 1e-3)).toBe(true);
  });
});

describe('mixturePdf / mixturePdfCurve (V2-1)', () => {
  const comps = [
    { pi: 0.5, mu: 60, sigma: 5 },
    { pi: 0.5, mu: 80, sigma: 5 },
  ];

  test('equals the weighted sum of component Gaussians', () => {
    const x = 62;
    const expected = 0.5 * gaussianPdf(x, 60, 5) + 0.5 * gaussianPdf(x, 80, 5);
    expect(close(mixturePdf(x, comps), expected)).toBe(true);
  });

  test('integrates to ~1 over a wide window', () => {
    let area = 0;
    const dx = 0.05;
    for (let x = 20; x < 120; x += dx) area += mixturePdf(x, comps) * dx;
    expect(close(area, 1, 1e-3)).toBe(true);
  });

  test('is genuinely bimodal — dips between the two modes', () => {
    expect(mixturePdf(60, comps) > mixturePdf(70, comps)).toBe(true);
    expect(mixturePdf(80, comps) > mixturePdf(70, comps)).toBe(true);
  });

  test('a single-weight component matches the plain Gaussian curve', () => {
    const curve = mixturePdfCurve([{ pi: 1, mu: 50, sigma: 10 }], [20, 80], 40);
    const gauss = pdfCurve(50, 10, [20, 80], 40);
    expect(curve.length).toBe(gauss.length);
    for (let i = 0; i < curve.length; i++) {
      expect(close(curve[i]?.y ?? 0, gauss[i]?.y ?? -1, 1e-12)).toBe(true);
    }
  });

  test('curve spans the domain endpoints', () => {
    const curve = mixturePdfCurve(comps, [30, 110], 80);
    expect(curve[0]?.x).toBe(30);
    expect(curve[curve.length - 1]?.x).toBe(110);
    expect(curve.length).toBe(81);
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
    { type: 'POLYNOMIAL', coeffs: [0, 0, 1] },
    { type: 'EXPONENTIAL', center: 50, rate: 0.05 },
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
  test('EXPONENTIAL shades by rate sign; POLYNOMIAL has no single region', () => {
    expect(winningRegions({ type: 'EXPONENTIAL', center: 50, rate: 0.05 }, [10, 90])).toEqual([
      [50, 90],
    ]);
    expect(winningRegions({ type: 'EXPONENTIAL', center: 50, rate: -0.05 }, [10, 90])).toEqual([
      [10, 50],
    ]);
    expect(winningRegions({ type: 'POLYNOMIAL', coeffs: [0, 0, 1] }, [10, 90])).toEqual([]);
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
    // ±100σ covers essentially all the mass ⇒ ≈1 (not just "somewhere in [0,1]")
    expect(p).toBeCloseTo(1, 6);
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

describe('tickDecimals (axis precision tracks zoom)', () => {
  test('wide integer-step domains need no decimals', () => {
    expect(tickDecimals(niceTicks(0, 100, 6), 0, 100)).toBe(0);
    expect(tickDecimals(niceTicks(0, 1000, 6), 0, 1000)).toBe(0);
  });
  test('tight domains gain decimals as the step shrinks below 1', () => {
    // ~0.1 step → 1 decimal; ~0.01 step → 2 decimals.
    expect(tickDecimals(niceTicks(64, 66, 6), 64, 66)).toBeGreaterThanOrEqual(1);
    expect(tickDecimals(niceTicks(0.2, 0.3, 6), 0.2, 0.3)).toBeGreaterThanOrEqual(2);
  });
  test('derives directly from explicit tick steps', () => {
    expect(tickDecimals([0, 1, 2], 0, 2)).toBe(0);
    expect(tickDecimals([0, 0.5, 1], 0, 1)).toBe(1);
    expect(tickDecimals([0, 0.05, 0.1], 0, 0.1)).toBe(2);
  });
  test('clamps to [0, 6] and falls back to a quarter-span step with < 2 ticks', () => {
    expect(tickDecimals([5], 0, 40)).toBe(0); // span/4 = 10 → 0 decimals
    expect(tickDecimals([], 0, 0.4)).toBe(1); // span/4 = 0.1 → 1 decimal
    expect(tickDecimals([0, 1e-9, 2e-9], 0, 2e-9)).toBeLessThanOrEqual(6);
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

describe('fitPointDomain', () => {
  test('a point already inside leaves the domain unchanged', () => {
    expect(fitPointDomain([0, 100], 50)).toEqual([0, 100]);
    expect(fitPointDomain([0, 100], 0)).toEqual([0, 100]);
    expect(fitPointDomain([0, 100], 100)).toEqual([0, 100]);
  });
  test('a point above extends only the upper edge, past it by the margin', () => {
    // span 100, margin 6% → 6, so hi = 130 + 6 = 136; lo untouched.
    expect(fitPointDomain([0, 100], 130, 0.06)).toEqual([0, 136]);
  });
  test('a point below extends only the lower edge', () => {
    expect(fitPointDomain([0, 100], -30, 0.06)).toEqual([-36, 100]);
  });
  test('the margin scales with the domain span', () => {
    const [lo, hi] = fitPointDomain([0, 10], 20, 0.1); // margin = 1
    expect([lo, hi]).toEqual([0, 21]);
  });
  test('a degenerate domain still gets a positive margin', () => {
    const [lo, hi] = fitPointDomain([5, 5], 9);
    expect(hi).toBeGreaterThan(9);
    expect(lo).toBe(5);
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

describe('smoothPath (shape-preserving monotone cubic)', () => {
  const id = (v: number) => v;
  const pathYs = (d: string): number[] => {
    const nums = (d.match(/-?\d+\.?\d*/g) ?? []).map(Number);
    return nums.filter((_, i) => i % 2 === 1); // x y x y … → keep the y's
  };

  test('never overshoots the data envelope (no dip below 0 or bulge past the peak)', () => {
    const pts: Pt[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0.4 },
      { x: 2, y: 1 },
      { x: 3, y: 0.4 },
      { x: 4, y: 0 },
    ];
    const lo = Math.min(...pts.map((p) => p.y));
    const hi = Math.max(...pts.map((p) => p.y));
    for (const y of pathYs(smoothPath(pts, id, id))) {
      expect(y).toBeGreaterThanOrEqual(lo - 1e-6);
      expect(y).toBeLessThanOrEqual(hi + 1e-6);
    }
  });

  test('passes through every data anchor', () => {
    const d = smoothPath(
      [
        { x: 0, y: 0 },
        { x: 1, y: 2 },
        { x: 2, y: 1 },
      ],
      id,
      id,
    );
    expect(d.startsWith('M0.00 0.00')).toBe(true);
    expect(d).toContain('1.00 2.00');
    expect(d.trimEnd().endsWith('2.00 1.00')).toBe(true);
  });

  test('falls back to a straight polyline below 3 points', () => {
    expect(
      smoothPath(
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        id,
        id,
      ),
    ).toBe('M0.00 0.00 L1.00 1.00');
    expect(smoothPath([], id, id)).toBe('');
  });
});

describe('ghostTrail (V2-8 belief comet trail)', () => {
  const domain = [-5, 5] as const;
  // A narrowing belief: wide (σ=2) → … → sharp (σ=0.5), oldest-first.
  const series: GhostInput[] = [2, 1.5, 1, 0.75, 0.5].map((sigma, i) => ({
    t: `2026-01-0${i + 1}T00:00:00.000Z`,
    pdf: (x: number) => gaussianPdf(x, 0, sigma),
  }));

  test('empty series → no polylines', () => {
    expect(ghostTrail([], domain)).toEqual([]);
  });

  test('caps the count and keeps both endpoints, evenly spaced', () => {
    const many: GhostInput[] = Array.from({ length: 40 }, (_, i) => ({
      t: `p${i}`,
      pdf: (x: number) => gaussianPdf(x, 0, 1),
    }));
    const out = ghostTrail(many, domain, { maxGhosts: 8 });
    expect(out.length).toBeLessThanOrEqual(8);
    expect(out[0]?.t).toBe('p0'); // oldest kept
    expect(out.at(-1)?.t).toBe('p39'); // newest kept
    expect(out.at(-1)?.newest).toBe(true);
  });

  test('opacity ramps monotonically old → new', () => {
    const out = ghostTrail(series, domain);
    for (let i = 1; i < out.length; i++) {
      expect((out[i] as { opacity: number }).opacity).toBeGreaterThanOrEqual(
        (out[i - 1] as { opacity: number }).opacity,
      );
    }
    // bounds: oldest at the floor, newest at the ceiling
    expect(out[0]?.opacity).toBeCloseTo(0.1, 6);
    expect(out.at(-1)?.opacity).toBeCloseTo(0.85, 6);
  });

  test('shared normalisation: tallest (newest, narrowest) peaks at 1, older below', () => {
    const out = ghostTrail(series, domain);
    const peakOf = (pts: Pt[]) => Math.max(...pts.map((p) => p.y));
    const newestPeak = peakOf(out.at(-1)?.pts ?? []);
    const oldestPeak = peakOf(out[0]?.pts ?? []);
    expect(newestPeak).toBeCloseTo(1, 6); // current belief sets the scale
    expect(oldestPeak).toBeLessThan(newestPeak); // wider past belief draws shorter
    // nothing exceeds the shared peak
    for (const gh of out) for (const p of gh.pts) expect(p.y).toBeLessThanOrEqual(1 + 1e-9);
  });

  test('a lone snapshot is the newest, at full ramp opacity', () => {
    const out = ghostTrail([series[0] as GhostInput], domain);
    expect(out).toHaveLength(1);
    expect(out[0]?.newest).toBe(true);
    expect(out[0]?.opacity).toBeCloseTo(0.85, 6);
  });

  test('does not mutate the input series', () => {
    const snap = series.map((s) => ({ t: s.t }));
    ghostTrail(series, domain);
    expect(series.map((s) => ({ t: s.t }))).toEqual(snap);
    expect(series).toHaveLength(5);
  });
});

describe('lerpPolyline (V2-8 snapshot morph)', () => {
  const a: Pt[] = [
    { x: 0, y: 0 },
    { x: 1, y: 10 },
    { x: 2, y: 4 },
  ];
  const b: Pt[] = [
    { x: 0, y: 2 },
    { x: 1, y: 0 },
    { x: 2, y: 8 },
  ];

  test('f=0 returns a, f=1 returns b (y-values)', () => {
    expect(lerpPolyline(a, b, 0).map((p) => p.y)).toEqual([0, 10, 4]);
    expect(lerpPolyline(a, b, 1).map((p) => p.y)).toEqual([2, 0, 8]);
  });

  test('f=0.5 is the midpoint, x taken from a', () => {
    const mid = lerpPolyline(a, b, 0.5);
    expect(mid.map((p) => p.y)).toEqual([1, 5, 6]);
    expect(mid.map((p) => p.x)).toEqual([0, 1, 2]);
  });

  test('clamps f to [0,1]', () => {
    expect(lerpPolyline(a, b, -3).map((p) => p.y)).toEqual([0, 10, 4]);
    expect(lerpPolyline(a, b, 5).map((p) => p.y)).toEqual([2, 0, 8]);
  });

  test('uses the shorter length and does not mutate inputs', () => {
    const short: Pt[] = [{ x: 0, y: 100 }];
    expect(lerpPolyline(a, short, 0.5)).toHaveLength(1);
    expect(a).toHaveLength(3);
    expect(a[1]?.y).toBe(10);
  });
});
