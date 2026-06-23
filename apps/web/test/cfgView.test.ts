import { describe, expect, test } from 'bun:test';
import {
  CFG_SOURCE_LABEL,
  cfgSeries,
  pinnedKeys,
  railSummary,
  sparkPoints,
} from '../src/lib/cfgView.ts';
import type { CfgHistoryRow, MarketCfg } from '../src/lib/types.ts';

function row(over: Partial<CfgHistoryRow>): CfgHistoryRow {
  return {
    cfgHistoryId: 'h',
    marketId: 'm',
    sigmaEps: 10,
    s0: 0.01,
    alpha: 1,
    beta: 1,
    regime: 0,
    railHit: false,
    source: 'adapt',
    triggerTradeId: null,
    createdAt: '2026-06-20T00:00:00Z',
    ...over,
  };
}

function cfg(over: Partial<MarketCfg>): MarketCfg {
  return {
    base: { sigmaEps: 20, s0: 0.01, alpha: 1, beta: 1 },
    initialSigma: 20,
    control: {},
    source: 'adapt',
    state: { emaSlow: 16, emaFast: 16, count: 5 },
    adapted: {
      sigmaEps: 20,
      s0: 0.01,
      alpha: 1,
      beta: 1,
      regime: 0,
      railHit: false,
      rails: { sigmaEps: null, s0: null, alpha: null, beta: null },
    },
    live: { sigmaEps: 20, s0: 0.01, alpha: 1, beta: 1 },
    history: [],
    ...over,
  };
}

describe('cfgSeries', () => {
  test('extracts one field oldest-first', () => {
    const h = [row({ sigmaEps: 10 }), row({ sigmaEps: 12 }), row({ sigmaEps: 15 })];
    expect(cfgSeries(h, 'sigmaEps')).toEqual([10, 12, 15]);
    expect(cfgSeries(h, 's0')).toEqual([0.01, 0.01, 0.01]);
  });
});

describe('sparkPoints', () => {
  test('empty series yields empty string', () => {
    expect(sparkPoints([], 100, 40)).toBe('');
  });

  test('single point is horizontally centred', () => {
    const p = sparkPoints([5], 100, 40, 2);
    expect(p.split(' ')).toHaveLength(1);
    expect(p.startsWith('50,')).toBe(true);
  });

  test('produces one coordinate per value, spanning the padded width', () => {
    const p = sparkPoints([1, 2, 3, 4], 100, 40, 2);
    const pts = p.split(' ').map((s) => s.split(',').map(Number));
    expect(pts).toHaveLength(4);
    expect(pts[0][0]).toBeCloseTo(2, 6); // first at left pad
    expect(pts[3][0]).toBeCloseTo(98, 6); // last at right pad
  });

  test('higher values map to smaller y (drawn higher); within the box', () => {
    const p = sparkPoints([0, 10], 100, 40, 2);
    const [, [, yHi]] = p.split(' ').map((s) => s.split(',').map(Number));
    const [[, yLo]] = p.split(' ').map((s) => s.split(',').map(Number));
    expect(yHi).toBeLessThan(yLo); // value 10 is higher (smaller y) than value 0
    for (const c of p.split(' ')) {
      const [, y] = c.split(',').map(Number);
      expect(y).toBeGreaterThanOrEqual(2 - 1e-6);
      expect(y).toBeLessThanOrEqual(38 + 1e-6);
    }
  });

  test('constant series renders a flat mid-line (no divide-by-zero)', () => {
    const p = sparkPoints([7, 7, 7], 100, 40, 2);
    const ys = p.split(' ').map((s) => Number(s.split(',')[1]));
    expect(new Set(ys).size).toBe(1); // all equal
    expect(ys[0]).toBeCloseTo(20, 6); // middle of the box
  });
});

describe('pinnedKeys', () => {
  test('lists only pinned params', () => {
    expect(pinnedKeys(cfg({ control: {} }))).toEqual([]);
    expect(pinnedKeys(cfg({ control: { pinned: { sigmaEps: 5 } } }))).toEqual(['sigmaEps']);
    expect(pinnedKeys(cfg({ control: { pinned: { sigmaEps: 5, s0: 0.01 } } }))).toEqual([
      'sigmaEps',
      's0',
    ]);
  });
});

describe('railSummary', () => {
  test('empty when no rail is bound', () => {
    expect(railSummary(cfg({}))).toBe('');
  });
  test('lists bound rails with sides', () => {
    const c = cfg({
      adapted: {
        sigmaEps: 40,
        s0: 0.02,
        alpha: 1,
        beta: 1,
        regime: 1,
        railHit: true,
        rails: { sigmaEps: 'hi', s0: 'hi', alpha: null, beta: null },
      },
    });
    expect(railSummary(c)).toBe('σ_ε hi, s₀ hi');
  });
});

describe('CFG_SOURCE_LABEL', () => {
  test('covers every history source', () => {
    for (const k of ['static', 'adapt', 'pin', 'breaker']) {
      expect(CFG_SOURCE_LABEL[k]).toBeTruthy();
    }
  });
});
