import { describe, expect, test } from 'bun:test';
import { Phi, payoff } from '@bmm/core';
import type { ContractSpec } from '../src/lib/types.ts';
import {
  gaussianPdf,
  niceDomain,
  niceTicks,
  payoffCurve,
  pdfCurve,
  probInRegions,
  scale,
  winningRegions,
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
