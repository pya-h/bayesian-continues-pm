// Pure unit tests for the adaptive-params helpers (src/lib/adaptiveCfg.ts).
// These exercise the module DIRECTLY (the integration suite only hits it
// through the trade path + DB). Every function here is pure — no DB, no network
// no clock — so the tests run unconditionally. The api package's bunfig env-guard
// preload still requires `--env-file` to be present, but nothing here opens a
// connection; importing the module does not pull in db/client.ts.
// Expected EWMA / adaptParams values are derived BY HAND below (see the comments
// on each derivation) against the @bmm/core controller semantics, not read back
// from the implementation.

import { describe, expect, test } from 'bun:test';
import {
  type AdaptiveConfig,
  type AdaptiveState,
  DEFAULT_ADAPTIVE,
  initAdaptiveState,
} from '@bmm/core';
import type { AdaptiveControlDTO, MarketCfgState } from '@bmm/shared';
import {
  cfgHistoryRow,
  foldError,
  liveEngineConfig,
  packCfgState,
  resolveAdaptiveConfig,
  validateAdaptiveConfig,
} from '../src/lib/adaptiveCfg.ts';

// A static base EngineConfig-ish row; only the adaptive-relevant fields matter.
function baseRow(over: Partial<Record<string, number | boolean>> = {}) {
  return {
    cfg: {
      sigmaEps: 10,
      s0: 0.01,
      alpha: 1,
      beta: 1,
      sigmaMin: 1,
      gamma: 0.0005,
      lambda: 0.5,
      eta: 0.05,
      qMax: 500,
      qThreshold: 10,
      lr: 0.01,
      decay: 0.05,
      reserveAlpha: 0.99,
      useSimplifiedUpdate: false,
      genExactShapeAdapt: true,
      ...over,
    } as Record<string, number | boolean>,
    initialSigma: 10,
  };
}

function foldSeq(absErrs: number[], acfg: AdaptiveConfig = DEFAULT_ADAPTIVE): AdaptiveState {
  let s = initAdaptiveState();
  // foldError observes |signal − priorMu|; with priorMu = 0 and signal = e ≥ 0 the
  // observation IS the error, so this drives the EWMA with exactly `absErrs`.
  for (const e of absErrs) s = foldError(s, e, 0, acfg);
  return s;
}

const HALF_NORMAL = Math.sqrt(Math.PI / 2); // √(π/2) ≈ 1.25331

// resolveAdaptiveConfig
describe('resolveAdaptiveConfig', () => {
  test('undefined control resolves to the defaults (fresh copy, not aliased)', () => {
    const acfg = resolveAdaptiveConfig(undefined);
    expect(acfg).toEqual(DEFAULT_ADAPTIVE);
    expect(acfg).not.toBe(DEFAULT_ADAPTIVE); // spread copy, mutating it can't corrupt the default
  });

  test('enabled:false flips the master switch off', () => {
    expect(resolveAdaptiveConfig({ enabled: false }).enabled).toBe(false);
  });

  test('enabled:true does NOT force-enable (only false is honored)', () => {
    // The merge only acts on `enabled === false`; true is a no-op over the (already
    // enabled) default — so it stays enabled either way, but importantly an explicit
    // true never *re-enables* a default that was off (it isn't).
    expect(resolveAdaptiveConfig({ enabled: true }).enabled).toBe(true);
  });

  test('whitelisted numeric overrides are applied', () => {
    const acfg = resolveAdaptiveConfig({ cfg: { alphaSlow: 0.2, sigmaEpsHiRatio: 1.5 } });
    expect(acfg.alphaSlow).toBe(0.2);
    expect(acfg.sigmaEpsHiRatio).toBe(1.5);
    expect(acfg.alphaFast).toBe(DEFAULT_ADAPTIVE.alphaFast); // untouched
  });

  test('whitelisted boolean overrides are applied', () => {
    expect(resolveAdaptiveConfig({ cfg: { halfNormalCorrect: false } }).halfNormalCorrect).toBe(
      false,
    );
    expect(resolveAdaptiveConfig({ cfg: { adaptAlphaBeta: true } }).adaptAlphaBeta).toBe(true);
  });

  test('non-finite numeric overrides are ignored (NaN / Infinity skipped)', () => {
    const acfg = resolveAdaptiveConfig({
      cfg: { alphaSlow: Number.NaN, sigmaEpsHiRatio: Number.POSITIVE_INFINITY },
    });
    expect(acfg.alphaSlow).toBe(DEFAULT_ADAPTIVE.alphaSlow);
    expect(acfg.sigmaEpsHiRatio).toBe(DEFAULT_ADAPTIVE.sigmaEpsHiRatio);
  });

  test('type-mismatched overrides are ignored (boolean key given number, vice-versa)', () => {
    const acfg = resolveAdaptiveConfig({
      cfg: {
        halfNormalCorrect: 1 as unknown as boolean, // number for a boolean key → ignored
        alphaSlow: true as unknown as number, // boolean for a number key → ignored
      },
    });
    expect(acfg.halfNormalCorrect).toBe(DEFAULT_ADAPTIVE.halfNormalCorrect);
    expect(acfg.alphaSlow).toBe(DEFAULT_ADAPTIVE.alphaSlow);
  });

  test('keys outside the whitelist are not copied through', () => {
    const acfg = resolveAdaptiveConfig({
      cfg: { enabled: false as unknown as number, bogus: 99 } as Record<string, number | boolean>,
    });
    // `enabled` is not in ADAPTIVE_CFG_KEYS, so a cfg.enabled never leaks in.
    expect(acfg.enabled).toBe(true);
    expect((acfg as Record<string, unknown>).bogus).toBeUndefined();
  });
});

// validateAdaptiveConfig
describe('validateAdaptiveConfig', () => {
  test('the default config is valid (no violations)', () => {
    expect(validateAdaptiveConfig(DEFAULT_ADAPTIVE)).toEqual([]);
  });

  test('a resolved config with valid overrides is valid', () => {
    const acfg = resolveAdaptiveConfig({ cfg: { sigmaEpsHiRatio: 1.5, alphaSlow: 0.2 } });
    expect(validateAdaptiveConfig(acfg)).toEqual([]);
  });

  for (const k of ['alphaSlow', 'alphaFast'] as const) {
    test(`${k} = 0 is rejected (EWMA weight must be in (0,1])`, () => {
      const errs = validateAdaptiveConfig({ ...DEFAULT_ADAPTIVE, [k]: 0 });
      expect(errs.some((e) => e.includes(k))).toBe(true);
    });
    test(`${k} > 1 is rejected (recursion diverges)`, () => {
      const errs = validateAdaptiveConfig({ ...DEFAULT_ADAPTIVE, [k]: 2 });
      expect(errs.some((e) => e.includes(k))).toBe(true);
    });
    test(`${k} = 1 is accepted (closed upper bound)`, () => {
      const errs = validateAdaptiveConfig({ ...DEFAULT_ADAPTIVE, [k]: 1 });
      expect(errs.some((e) => e.includes(k))).toBe(false);
    });
    test(`${k} negative is rejected`, () => {
      const errs = validateAdaptiveConfig({ ...DEFAULT_ADAPTIVE, [k]: -0.1 });
      expect(errs.some((e) => e.includes(k))).toBe(true);
    });
  }

  const railPairs: [keyof AdaptiveConfig, keyof AdaptiveConfig][] = [
    ['sigmaEpsLoRatio', 'sigmaEpsHiRatio'],
    ['s0Lo', 's0Hi'],
    ['alphaLo', 'alphaHi'],
    ['betaLo', 'betaHi'],
  ];
  for (const [lo, hi] of railPairs) {
    test(`inverted rail ${lo} > ${hi} is rejected`, () => {
      const acfg: AdaptiveConfig = { ...DEFAULT_ADAPTIVE, [lo]: 5, [hi]: 1 };
      const errs = validateAdaptiveConfig(acfg);
      expect(errs.some((e) => e.includes(lo) && e.includes(hi))).toBe(true);
    });
    test(`equal rail ${lo} == ${hi} is accepted (lo ≤ hi)`, () => {
      const acfg: AdaptiveConfig = { ...DEFAULT_ADAPTIVE, [lo]: 1, [hi]: 1 };
      const errs = validateAdaptiveConfig(acfg);
      expect(errs.some((e) => e.includes(`${lo} (`) && e.includes(`${hi} (`))).toBe(false);
    });
    test(`negative lo rail ${lo} is rejected`, () => {
      const acfg: AdaptiveConfig = { ...DEFAULT_ADAPTIVE, [lo]: -1 };
      const errs = validateAdaptiveConfig(acfg);
      expect(errs.some((e) => e.includes(`${lo} must be ≥ 0`))).toBe(true);
    });
  }

  test('one-sided override that crosses the default partner rail is caught', () => {
    // Only sigmaEpsHiRatio pushed BELOW the default sigmaEpsLoRatio (0.1) ⇒ inverted.
    const acfg = resolveAdaptiveConfig({ cfg: { sigmaEpsHiRatio: 0.05 } });
    const errs = validateAdaptiveConfig(acfg);
    expect(errs.some((e) => e.includes('sigmaEpsLoRatio') && e.includes('sigmaEpsHiRatio'))).toBe(
      true,
    );
  });

  test('negative regimeCap is rejected', () => {
    expect(validateAdaptiveConfig({ ...DEFAULT_ADAPTIVE, regimeCap: -1 })).toContain(
      'regimeCap must be ≥ 0',
    );
  });

  test('non-integer warmup is rejected', () => {
    expect(validateAdaptiveConfig({ ...DEFAULT_ADAPTIVE, warmup: 2.5 })).toContain(
      'warmup must be a non-negative integer',
    );
  });

  test('negative warmup is rejected', () => {
    expect(validateAdaptiveConfig({ ...DEFAULT_ADAPTIVE, warmup: -1 })).toContain(
      'warmup must be a non-negative integer',
    );
  });

  test('warmup = 0 is accepted', () => {
    expect(validateAdaptiveConfig({ ...DEFAULT_ADAPTIVE, warmup: 0 })).toEqual([]);
  });

  test('multiple violations accumulate into one list', () => {
    const errs = validateAdaptiveConfig({
      ...DEFAULT_ADAPTIVE,
      alphaSlow: 2,
      s0Lo: 5,
      s0Hi: 1,
      warmup: -3,
    });
    expect(errs.length).toBeGreaterThanOrEqual(3);
  });
});

// foldError — EWMA advancement
describe('foldError', () => {
  test('first observation seeds both EWMAs to |signal − μ| and count = 1', () => {
    // |s − μ| = |76 − 70| = 6.
    const s = foldError(initAdaptiveState(), 76, 70, DEFAULT_ADAPTIVE);
    expect(s).toEqual({ emaSlow: 6, emaFast: 6, count: 1 });
  });

  test('advances the slow/fast EWMAs with the configured weights (hand-derived)', () => {
    // Sequence of |error|: [10, 2, 6], alphaSlow=0.1, alphaFast=0.4.
    // obs1 → slow=10, fast=10, count=1
    // obs2 → slow=.9·10+.1·2=9.2 fast=.6·10+.4·2=6.8 count=2
    // obs3 → slow=.9·9.2+.1·6 fast=.6·6.8+.4·6 count=3
    // = 8.28+0.6 = 8.88 = 4.08+2.4 = 6.48
    const s = foldSeq([10, 2, 6]);
    expect(s.count).toBe(3);
    expect(s.emaSlow).toBeCloseTo(8.88, 10);
    expect(s.emaFast).toBeCloseTo(6.48, 10);
  });

  test('uses |s − μ| so the sign of the surprise does not matter', () => {
    const below = foldError(initAdaptiveState(), 64, 70, DEFAULT_ADAPTIVE); // |−6| = 6
    const above = foldError(initAdaptiveState(), 76, 70, DEFAULT_ADAPTIVE); // |+6| = 6
    expect(below).toEqual(above);
  });

  test('a non-finite signal is ignored (state returned unchanged)', () => {
    const seeded = foldSeq([5, 5]);
    expect(foldError(seeded, Number.NaN, 0, DEFAULT_ADAPTIVE)).toEqual(seeded);
    expect(foldError(seeded, Number.POSITIVE_INFINITY, 0, DEFAULT_ADAPTIVE)).toEqual(seeded);
  });

  test('a non-finite priorMu is ignored (|s − μ| non-finite ⇒ unchanged)', () => {
    const seeded = foldSeq([5, 5]);
    expect(foldError(seeded, 5, Number.NaN, DEFAULT_ADAPTIVE)).toEqual(seeded);
  });

  test('custom alpha weights are respected', () => {
    const acfg: AdaptiveConfig = { ...DEFAULT_ADAPTIVE, alphaSlow: 0.5, alphaFast: 0.5 };
    // obs1 → 10/10; obs2(2) →.5·10+.5·2 = 6 for both.
    const s = foldSeq([10, 2], acfg);
    expect(s.emaSlow).toBeCloseTo(6, 10);
    expect(s.emaFast).toBeCloseTo(6, 10);
  });
});

// liveEngineConfig — source resolution + adaptation + pins
describe('liveEngineConfig', () => {
  function rowWith(state: AdaptiveState, control?: AdaptiveControlDTO) {
    const cfgState: MarketCfgState | null = { adaptive: state, ...(control && { control }) };
    return { ...baseRow(), cfgState };
  }

  test('cold (no state) → source "static", live == base', () => {
    const live = liveEngineConfig({ ...baseRow(), cfgState: null });
    expect(live.source).toBe('static');
    expect(live.cfg.sigmaEps).toBe(10);
    expect(live.cfg.s0).toBe(0.01);
    expect(live.state.count).toBe(0);
  });

  test('below warmup → still static even with observations', () => {
    const s = foldSeq([6, 6]); // count = 2 < warmup 3
    const live = liveEngineConfig(rowWith(s));
    expect(live.source).toBe('static');
    expect(live.cfg.sigmaEps).toBe(10);
  });

  test('at/above warmup with enabled → source "adapt", σ_ε from the EWMA', () => {
    // [10,2,6] → emaSlow=8.88, count=3 ≥ warmup. σ_ε = √(π/2)·8.88, inside [1,20].
    const s = foldSeq([10, 2, 6]);
    const live = liveEngineConfig(rowWith(s));
    expect(live.source).toBe('adapt');
    expect(live.cfg.sigmaEps).toBeCloseTo(HALF_NORMAL * 8.88, 8);
    expect(live.adapted.railHit).toBe(false);
  });

  test('disabled controller → static even past warmup', () => {
    const s = foldSeq([10, 2, 6]);
    const live = liveEngineConfig(rowWith(s, { enabled: false }));
    expect(live.source).toBe('static');
    expect(live.cfg.sigmaEps).toBe(10);
  });

  test('a pin overrides adaptation and reports source "pin"', () => {
    const s = foldSeq([10, 2, 6]); // would otherwise adapt
    const live = liveEngineConfig(rowWith(s, { pinned: { sigmaEps: 7, s0: 0.005 } }));
    expect(live.source).toBe('pin');
    expect(live.cfg.sigmaEps).toBe(7);
    expect(live.cfg.s0).toBe(0.005);
    // Unpinned params still take the adapted value (alpha/beta unchanged here = base).
    expect(live.cfg.alpha).toBe(1);
  });

  test('a pin wins even when the controller is cold (below warmup)', () => {
    const live = liveEngineConfig({
      ...baseRow(),
      cfgState: { adaptive: initAdaptiveState(), control: { pinned: { alpha: 1.5 } } },
    });
    expect(live.source).toBe('pin');
    expect(live.cfg.alpha).toBe(1.5);
  });

  test('high σ_ε rail clamps to sigmaEpsHiRatio·σ₀ and flags railHit', () => {
    // Large errors → debiased EWMA ≫ 2·σ₀=20 ⇒ clamp to 20, rails.sigmaEps = 'hi'.
    const s = foldSeq([100, 100, 100, 100]);
    const live = liveEngineConfig(rowWith(s));
    expect(live.cfg.sigmaEps).toBeCloseTo(20, 10); // 2.0 · σ₀(10)
    expect(live.adapted.railHit).toBe(true);
    expect(live.adapted.rails.sigmaEps).toBe('hi');
  });

  test('low σ_ε rail clamps to sigmaEpsLoRatio·σ₀ and flags railHit', () => {
    // Tiny errors → debiased EWMA ≪ 0.1·σ₀=1 ⇒ clamp to 1, rails.sigmaEps = 'lo'.
    const s = foldSeq([0.1, 0.1, 0.1, 0.1]);
    const live = liveEngineConfig(rowWith(s));
    expect(live.cfg.sigmaEps).toBeCloseTo(1, 10); // 0.1 · σ₀(10)
    expect(live.adapted.railHit).toBe(true);
    expect(live.adapted.rails.sigmaEps).toBe('lo');
  });

  test('a rising-surprise stream raises the regime and widens s₀', () => {
    // [2,2,20] → emaSlow=3.8, emaFast=9.2; regime = clamp(9.2/3.8−1, 0, 1) = 1.0
    // so s0 = base.s0·(1+1) = 0.02 (== s0Hi exactly; clamp is a no-op ⇒ no rail flag).
    const s = foldSeq([2, 2, 20]);
    const live = liveEngineConfig(rowWith(s));
    expect(live.adapted.regime).toBeCloseTo(1, 10);
    expect(live.cfg.s0).toBeCloseTo(0.02, 10);
    expect(live.adapted.rails.s0).toBeNull(); // boundary-exact clamp does not flag
  });

  test('the resolved acfg and echoed control are returned for persistence', () => {
    const control: AdaptiveControlDTO = { cfg: { alphaSlow: 0.2 } };
    const live = liveEngineConfig(rowWith(foldSeq([6, 6, 6]), control));
    expect(live.acfg.alphaSlow).toBe(0.2);
    expect(live.control).toEqual(control);
  });
});

// foldError → packCfgState round-trip
describe('packCfgState', () => {
  test('omits control when none is supplied', () => {
    const s = foldSeq([5, 5, 5]);
    const packed = packCfgState(s, undefined);
    expect(packed).toEqual({ adaptive: s });
    expect('control' in packed).toBe(false);
  });

  test('includes control when supplied', () => {
    const s = foldSeq([5, 5, 5]);
    const control: AdaptiveControlDTO = { pinned: { sigmaEps: 8 } };
    expect(packCfgState(s, control)).toEqual({ adaptive: s, control });
  });

  test('round-trips through loadCfgState back into liveEngineConfig', () => {
    // Pack a state, feed it back as a row, and confirm the controller picks it up.
    const s = foldSeq([10, 2, 6]);
    const packed = packCfgState(s, undefined);
    const live = liveEngineConfig({ ...baseRow(), cfgState: packed });
    expect(live.state).toEqual(s);
    expect(live.source).toBe('adapt');
  });
});

// cfgHistoryRow — post-fold snapshot of what the NEXT trade prices at
describe('cfgHistoryRow', () => {
  test('records the adapted snapshot with source "adapt" (no rail, enabled)', () => {
    const next = foldSeq([10, 2, 6]); // count 3, inside rails
    const acfg = resolveAdaptiveConfig(undefined);
    const histRow = cfgHistoryRow(baseRow(), next, acfg, undefined);
    expect(histRow.source).toBe('adapt');
    expect(histRow.railHit).toBe(false);
    expect(histRow.sigmaEps).toBeCloseTo(HALF_NORMAL * 8.88, 8);
    expect(histRow.regime).toBeCloseTo(0, 10); // emaFast<emaSlow ⇒ regime 0
  });

  test('labels a rail-bound snapshot "breaker"', () => {
    const next = foldSeq([100, 100, 100, 100]); // saturates σ_ε hi rail
    const acfg = resolveAdaptiveConfig(undefined);
    const histRow = cfgHistoryRow(baseRow(), next, acfg, undefined);
    expect(histRow.railHit).toBe(true);
    expect(histRow.source).toBe('breaker');
    expect(histRow.sigmaEps).toBeCloseTo(20, 10);
  });

  test('labels a below-warmup / disabled snapshot "static"', () => {
    const acfg = resolveAdaptiveConfig(undefined);
    const belowWarmup = foldSeq([6, 6]); // count 2 < warmup 3
    expect(cfgHistoryRow(baseRow(), belowWarmup, acfg, undefined).source).toBe('static');

    const disabled = resolveAdaptiveConfig({ enabled: false });
    const adapted = foldSeq([10, 2, 6]);
    expect(cfgHistoryRow(baseRow(), adapted, disabled, { enabled: false }).source).toBe('static');
  });

  test('a pin labels the snapshot "pin" and pins the recorded value', () => {
    const next = foldSeq([10, 2, 6]);
    const acfg = resolveAdaptiveConfig(undefined);
    const control: AdaptiveControlDTO = { pinned: { sigmaEps: 5 } };
    const histRow = cfgHistoryRow(baseRow(), next, acfg, control);
    expect(histRow.source).toBe('pin');
    expect(histRow.sigmaEps).toBe(5);
  });

  test('source priority: pin beats breaker even when a rail bound', () => {
    const next = foldSeq([100, 100, 100, 100]); // would be 'breaker' unpinned
    const acfg = resolveAdaptiveConfig(undefined);
    const histRow = cfgHistoryRow(baseRow(), next, acfg, { pinned: { sigmaEps: 9 } });
    expect(histRow.source).toBe('pin');
    expect(histRow.sigmaEps).toBe(9);
    // railHit still reflects the underlying adaptation diagnostic.
    expect(histRow.railHit).toBe(true);
  });
});
