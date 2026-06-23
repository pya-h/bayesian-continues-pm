import { describe, expect, test } from 'bun:test';
import {
  currentParam,
  paramLabel,
  reshapesWhileDragging,
  sweepKey,
  withParam,
} from '../src/lib/priceParam.ts';
import type { ContractSpec } from '../src/lib/types.ts';

const STRIKE_KINDS = ['CALL', 'PUT', 'BINARY_CALL', 'BINARY_PUT'] as const;
const CENTER_KINDS = ['GAUSSIAN', 'SKEW_GAUSSIAN', 'TENT', 'SIGMOID', 'EXPONENTIAL'] as const;

describe('withParam', () => {
  test('strike-family kinds set strike to x and keep other fields', () => {
    for (const type of STRIKE_KINDS) {
      const out = withParam({ type, strike: 1 } as ContractSpec, 42);
      expect(out).toEqual({ type, strike: 42 } as ContractSpec);
    }
  });

  test('centre-family kinds set center to x and keep width fields', () => {
    expect(withParam({ type: 'GAUSSIAN', center: 0, width: 8 }, 50)).toEqual({
      type: 'GAUSSIAN',
      center: 50,
      width: 8,
    });
    expect(
      withParam({ type: 'SKEW_GAUSSIAN', center: 0, widthLeft: 4, widthRight: 6 }, 12),
    ).toEqual({ type: 'SKEW_GAUSSIAN', center: 12, widthLeft: 4, widthRight: 6 });
    expect(withParam({ type: 'TENT', center: 0, width: 2 }, 7)).toEqual({
      type: 'TENT',
      center: 7,
      width: 2,
    });
    expect(withParam({ type: 'SIGMOID', center: 0, width: 2 }, 7)).toEqual({
      type: 'SIGMOID',
      center: 7,
      width: 2,
    });
    expect(withParam({ type: 'EXPONENTIAL', center: 0, rate: 0.05 }, 9)).toEqual({
      type: 'EXPONENTIAL',
      center: 9,
      rate: 0.05,
    });
  });

  test('SPREAD recentres on x, preserving its width (upper-lower)', () => {
    // half = (65-45)/2 = 10 → [40-... ] no: x=100 → [90,110], span 20 preserved.
    const out = withParam({ type: 'SPREAD', lower: 45, upper: 65 }, 100);
    expect(out).toEqual({ type: 'SPREAD', lower: 90, upper: 110 });
    if (out) expect(out.type === 'SPREAD' && out.upper - out.lower).toBe(20);
  });

  test('TRAPEZOID recentres on x, preserving width and the flat-top w field', () => {
    const out = withParam({ type: 'TRAPEZOID', lower: 10, upper: 30, width: 4 }, 0);
    // half = 10 → [-10, 10]; the width (4) is carried...spec.
    expect(out).toEqual({ type: 'TRAPEZOID', lower: -10, upper: 10, width: 4 });
  });

  test('LINEAR has no primary parameter → null', () => {
    expect(withParam({ type: 'LINEAR' }, 5)).toBeNull();
  });

  test('POLYNOMIAL has no swept parameter → null', () => {
    expect(withParam({ type: 'POLYNOMIAL', coeffs: [0, 0, 1] }, 5)).toBeNull();
  });

  test('does not mutate the input spec', () => {
    const spec: ContractSpec = { type: 'CALL', strike: 60 };
    const snap = { ...spec };
    withParam(spec, 999);
    expect(spec).toEqual(snap);

    const spread: ContractSpec = { type: 'SPREAD', lower: 45, upper: 65 };
    const spreadSnap = { ...spread };
    withParam(spread, -5);
    expect(spread).toEqual(spreadSnap);
  });

  test('a degenerate (zero-width) SPREAD stays zero-width, just recentred', () => {
    const out = withParam({ type: 'SPREAD', lower: 5, upper: 5 }, 20);
    expect(out).toEqual({ type: 'SPREAD', lower: 20, upper: 20 });
  });
});

describe('currentParam', () => {
  test('strike family returns the strike', () => {
    for (const type of STRIKE_KINDS) {
      expect(currentParam({ type, strike: 33 } as ContractSpec)).toBe(33);
    }
  });
  test('centre family returns the center', () => {
    for (const type of CENTER_KINDS) {
      const spec = { type, center: 17, width: 1, widthLeft: 1, widthRight: 1, rate: 0.1 };
      expect(currentParam(spec as ContractSpec)).toBe(17);
    }
  });
  test('SPREAD / TRAPEZOID return the interval midpoint', () => {
    expect(currentParam({ type: 'SPREAD', lower: 45, upper: 65 })).toBe(55);
    expect(currentParam({ type: 'TRAPEZOID', lower: 10, upper: 30, width: 4 })).toBe(20);
  });
  test('LINEAR / POLYNOMIAL have no parameter → null', () => {
    expect(currentParam({ type: 'LINEAR' })).toBeNull();
    expect(currentParam({ type: 'POLYNOMIAL', coeffs: [0, 0, 1] })).toBeNull();
  });

  test('currentParam is the inverse fixpoint of withParam for the swept value', () => {
    // withParam(s, x) then currentParam should return x exactly (round trip).
    const specs: ContractSpec[] = [
      { type: 'CALL', strike: 1 },
      { type: 'BINARY_PUT', strike: 1 },
      { type: 'GAUSSIAN', center: 0, width: 8 },
      { type: 'SPREAD', lower: 45, upper: 65 },
      { type: 'TRAPEZOID', lower: 10, upper: 30, width: 4 },
    ];
    for (const s of specs) {
      const moved = withParam(s, 73.5);
      expect(moved).not.toBeNull();
      expect(currentParam(moved as ContractSpec)).toBeCloseTo(73.5, 12);
    }
  });
});

describe('paramLabel', () => {
  test('centre family → "c"', () => {
    for (const type of CENTER_KINDS) expect(paramLabel(type)).toBe('c');
  });
  test('interval family → "mid"', () => {
    expect(paramLabel('SPREAD')).toBe('mid');
    expect(paramLabel('TRAPEZOID')).toBe('mid');
  });
  test('everything else (strike family, LINEAR, POLYNOMIAL) → "K"', () => {
    for (const type of STRIKE_KINDS) expect(paramLabel(type)).toBe('K');
    expect(paramLabel('LINEAR')).toBe('K');
    expect(paramLabel('POLYNOMIAL')).toBe('K');
  });
});

describe('sweepKey', () => {
  test('strike family keys only on type — the curve is strike-independent', () => {
    for (const type of STRIKE_KINDS) {
      expect(sweepKey({ type, strike: 10 } as ContractSpec)).toBe(type);
      // sliding the strike does NOT change the key
      expect(sweepKey({ type, strike: 999 } as ContractSpec)).toBe(type);
    }
    expect(sweepKey({ type: 'LINEAR' })).toBe('LINEAR');
    expect(sweepKey({ type: 'POLYNOMIAL', coeffs: [0, 0, 1] })).toBe('POLYNOMIAL');
  });

  test('width-bearing kinds fold their non-swept shape params into the key', () => {
    expect(sweepKey({ type: 'GAUSSIAN', center: 0, width: 8 })).toBe('G:8');
    expect(sweepKey({ type: 'TENT', center: 0, width: 3 })).toBe('T:3');
    expect(sweepKey({ type: 'SIGMOID', center: 0, width: 2 })).toBe('SG:2');
    expect(sweepKey({ type: 'SKEW_GAUSSIAN', center: 0, widthLeft: 4, widthRight: 6 })).toBe(
      'SK:4:6',
    );
    expect(sweepKey({ type: 'SPREAD', lower: 45, upper: 65 })).toBe('S:20'); // upper-lower
    expect(sweepKey({ type: 'TRAPEZOID', lower: 10, upper: 30, width: 4 })).toBe('TR:20:4');
  });

  test('the key changes when a width changes but is stable when only the centre moves', () => {
    const narrow = sweepKey({ type: 'GAUSSIAN', center: 0, width: 8 });
    const wide = sweepKey({ type: 'GAUSSIAN', center: 0, width: 9 });
    const moved = sweepKey({ type: 'GAUSSIAN', center: 50, width: 8 });
    expect(wide).not.toBe(narrow); // width change → new key
    expect(moved).toBe(narrow); // centre slide → same key
  });

  test('SKEW_GAUSSIAN distinguishes left vs right width swaps', () => {
    expect(sweepKey({ type: 'SKEW_GAUSSIAN', center: 0, widthLeft: 4, widthRight: 6 })).not.toBe(
      sweepKey({ type: 'SKEW_GAUSSIAN', center: 0, widthLeft: 6, widthRight: 4 }),
    );
  });
});

describe('reshapesWhileDragging', () => {
  test('true exactly for the width-bearing kinds', () => {
    for (const type of [
      'SPREAD',
      'GAUSSIAN',
      'SKEW_GAUSSIAN',
      'TENT',
      'TRAPEZOID',
      'SIGMOID',
    ] as const) {
      expect(reshapesWhileDragging(type)).toBe(true);
    }
  });
  test('false for strike family and parameterless kinds', () => {
    for (const type of [...STRIKE_KINDS, 'LINEAR', 'POLYNOMIAL', 'EXPONENTIAL'] as const) {
      expect(reshapesWhileDragging(type)).toBe(false);
    }
  });

  test('agrees with sweepKey: kinds that reshape are exactly those whose key folds in widths', () => {
    // A reshaping kind is one whose sweepKey embeds more than just the type string.
    const allTypes = [
      ...STRIKE_KINDS,
      ...CENTER_KINDS,
      'SPREAD',
      'TRAPEZOID',
      'LINEAR',
      'POLYNOMIAL',
    ] as const;
    for (const type of allTypes) {
      const spec = {
        type,
        strike: 1,
        center: 1,
        width: 1,
        widthLeft: 1,
        widthRight: 1,
        lower: 0,
        upper: 2,
        rate: 0.1,
        coeffs: [0, 0, 1],
      } as unknown as ContractSpec;
      const keyEncodesShape = sweepKey(spec) !== type;
      // EXPONENTIAL is the one centre-family kind that does NOT reshape (no width)
      // and its sweepKey is just the type — so the two predicates line up.
      expect(reshapesWhileDragging(type)).toBe(keyEncodesShape);
    }
  });
});
