import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  fmt,
  fmtCompact,
  fmtPct,
  fmtSigned,
  getNumberPrecision,
  setCompactNumbers,
  setNumberPrecision,
  specLabel,
  statusTone,
  timeAgo,
} from '../src/lib/format.ts';

// format.ts holds two process-wide display prefs (precision + compact). Restore
// them around every test so cases that flip the prefs can't leak into others.
let savedPrecision: number;
beforeEach(() => {
  savedPrecision = getNumberPrecision();
});
afterEach(() => {
  setNumberPrecision(savedPrecision);
  setCompactNumbers(true); // module default
});

// The fmtSigned/specLabel minus is U+2212 (MINUS SIGN), not ASCII '-'.
const MINUS = '−';

describe('setNumberPrecision / getNumberPrecision', () => {
  test('round-trips a plain value', () => {
    setNumberPrecision(3);
    expect(getNumberPrecision()).toBe(3);
  });
  test('clamps to [0, 6]', () => {
    setNumberPrecision(-2);
    expect(getNumberPrecision()).toBe(0);
    setNumberPrecision(99);
    expect(getNumberPrecision()).toBe(6);
  });
  test('rounds a fractional request to the nearest integer', () => {
    setNumberPrecision(2.4);
    expect(getNumberPrecision()).toBe(2);
    setNumberPrecision(2.6);
    expect(getNumberPrecision()).toBe(3);
  });
});

describe('fmt', () => {
  test('thousands separators with the default 2 decimals', () => {
    setNumberPrecision(2);
    expect(fmt(1234567.5)).toBe('1,234,567.50');
  });
  test('honours an explicit decimals argument over the default', () => {
    setNumberPrecision(2);
    expect(fmt(5.43219, 4)).toBe('5.4322');
    expect(fmt(5.43219, 0)).toBe('5');
  });
  test('zero and negatives', () => {
    expect(fmt(0, 2)).toBe('0.00');
    expect(fmt(-1234.5, 2)).toBe('-1,234.50');
  });
  test('rounds at the half boundary (banker-free toLocaleString)', () => {
    // 2.5 → "2" or "3" is engine-dependent for round-half; use an unambiguous case.
    expect(fmt(2.555, 2)).toBe('2.56');
    expect(fmt(2.554, 2)).toBe('2.55');
  });
  test('null / undefined / NaN / ±Infinity render the em-dash', () => {
    expect(fmt(null)).toBe('—');
    expect(fmt(undefined)).toBe('—');
    expect(fmt(Number.NaN)).toBe('—');
    expect(fmt(Number.POSITIVE_INFINITY)).toBe('—');
    expect(fmt(Number.NEGATIVE_INFINITY)).toBe('—');
  });
  test('the default decimals tracks the user precision pref', () => {
    setNumberPrecision(0);
    expect(fmt(12.9)).toBe('13');
    setNumberPrecision(4);
    expect(fmt(1.5)).toBe('1.5000');
  });
  test('very large and very small magnitudes', () => {
    expect(fmt(1e21, 0)).toBe('1,000,000,000,000,000,000,000');
    expect(fmt(0.0001, 4)).toBe('0.0001');
  });
});

describe('fmtCompact', () => {
  test('millions collapse to M with 2 decimals', () => {
    setCompactNumbers(true);
    expect(fmtCompact(1_200_000)).toBe('1.20M');
    expect(fmtCompact(34_500_000)).toBe('34.50M');
  });
  test('thousands collapse to k with 1 decimal', () => {
    setCompactNumbers(true);
    expect(fmtCompact(34_500)).toBe('34.5k');
    expect(fmtCompact(1_000)).toBe('1.0k');
  });
  test('below 1000 falls through to plain fmt at the current precision', () => {
    setCompactNumbers(true);
    setNumberPrecision(2);
    expect(fmtCompact(812.4)).toBe('812.40');
  });
  test('the 1e6 / 1e3 thresholds are inclusive (>=)', () => {
    setCompactNumbers(true);
    expect(fmtCompact(1_000_000)).toBe('1.00M');
    expect(fmtCompact(999_999)).toBe('1000.0k'); // 999999/1000 = 999.999 → "1000.0k"
  });
  test('negatives collapse with the sign preserved (abs drives the bucket)', () => {
    setCompactNumbers(true);
    expect(fmtCompact(-2_500_000)).toBe('-2.50M');
    expect(fmtCompact(-7_500)).toBe('-7.5k');
  });
  test('compact disabled defers entirely to fmt', () => {
    setCompactNumbers(false);
    setNumberPrecision(2);
    expect(fmtCompact(1_200_000)).toBe(fmt(1_200_000));
    expect(fmtCompact(1_200_000)).toBe('1,200,000.00');
  });
  test('null / NaN / Infinity render the em-dash regardless of compact flag', () => {
    setCompactNumbers(true);
    expect(fmtCompact(null)).toBe('—');
    expect(fmtCompact(undefined)).toBe('—');
    expect(fmtCompact(Number.NaN)).toBe('—');
    expect(fmtCompact(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('fmtSigned', () => {
  test('gains get an explicit ASCII +', () => {
    expect(fmtSigned(12.5, 2)).toBe('+12.50');
    expect(fmtSigned(0, 2)).toBe('+0.00'); // zero is non-negative → +
  });
  test('losses get a U+2212 minus (not ASCII -)', () => {
    expect(fmtSigned(-12.5, 2)).toBe(`${MINUS}12.50`);
    expect(fmtSigned(-12.5, 2).charCodeAt(0)).toBe(0x2212);
  });
  test('the magnitude is the absolute value (no double sign)', () => {
    expect(fmtSigned(-1234.5, 2)).toBe(`${MINUS}1,234.50`);
  });
  test('honours explicit decimals and the precision default', () => {
    expect(fmtSigned(5.43219, 3)).toBe('+5.432');
    setNumberPrecision(0);
    expect(fmtSigned(-5.6)).toBe(`${MINUS}6`);
  });
  test('null / NaN / Infinity render the em-dash', () => {
    expect(fmtSigned(null)).toBe('—');
    expect(fmtSigned(Number.NaN)).toBe('—');
    expect(fmtSigned(Number.NEGATIVE_INFINITY)).toBe('—');
  });
});

describe('fmtPct', () => {
  test('multiplies by 100 with a default 1 decimal', () => {
    expect(fmtPct(0.1234)).toBe('12.3%');
    expect(fmtPct(1)).toBe('100.0%');
    expect(fmtPct(0)).toBe('0.0%');
  });
  test('honours an explicit decimal count', () => {
    expect(fmtPct(0.1234, 2)).toBe('12.34%');
    expect(fmtPct(0.5, 0)).toBe('50%');
  });
  test('negatives keep the native sign', () => {
    expect(fmtPct(-0.05, 1)).toBe('-5.0%');
  });
  test('null / NaN / Infinity render the em-dash', () => {
    expect(fmtPct(null)).toBe('—');
    expect(fmtPct(undefined)).toBe('—');
    expect(fmtPct(Number.NaN)).toBe('—');
    expect(fmtPct(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('specLabel', () => {
  test('LINEAR is a fixed label', () => {
    expect(specLabel({ type: 'LINEAR' })).toBe('Linear (θ)');
  });
  test('CALL / PUT show the strike (axis precision, trailing zeros trimmed)', () => {
    expect(specLabel({ type: 'CALL', strike: 3.5 })).toBe('Call · K=3.5');
    expect(specLabel({ type: 'CALL', strike: 4 })).toBe('Call · K=4');
    expect(specLabel({ type: 'PUT', strike: 40 })).toBe('Put · K=40');
  });
  test('binary directions', () => {
    expect(specLabel({ type: 'BINARY_CALL', strike: 55 })).toBe('Binary ≥ 55');
    expect(specLabel({ type: 'BINARY_PUT', strike: 50 })).toBe('Binary ≤ 50');
  });
  test('SPREAD / TRAPEZOID show the interval', () => {
    expect(specLabel({ type: 'SPREAD', lower: 45, upper: 65 })).toBe('Spread [45, 65]');
    expect(specLabel({ type: 'TRAPEZOID', lower: 10, upper: 20, width: 3 })).toBe(
      'Trapezoid [10, 20] w=3',
    );
  });
  test('bell family carries centre and width(s)', () => {
    expect(specLabel({ type: 'GAUSSIAN', center: 50, width: 8 })).toBe('Bell · c=50 w=8');
    expect(specLabel({ type: 'SKEW_GAUSSIAN', center: 50, widthLeft: 4, widthRight: 6 })).toBe(
      'Skew bell · c=50 wL=4 wR=6',
    );
    expect(specLabel({ type: 'TENT', center: 12.5, width: 2 })).toBe('Tent · c=12.5 w=2');
    expect(specLabel({ type: 'SIGMOID', center: 0, width: 1 })).toBe('Sigmoid · c=0 w=1');
  });
  test('POLYNOMIAL renders non-zero coeffs only, with θ powers', () => {
    // [1, 0, 2] → "1.00 + 2.00θ^2" (the zero θ¹ term is skipped, k=2 → ^2).
    expect(specLabel({ type: 'POLYNOMIAL', coeffs: [1, 0, 2] })).toBe(
      'Polynomial · 1.00 + 2.00θ^2',
    );
    // a₁ term has no exponent suffix.
    expect(specLabel({ type: 'POLYNOMIAL', coeffs: [0, 3] })).toBe('Polynomial · 3.00θ');
    // all-zero (or empty) coeffs collapse to "0".
    expect(specLabel({ type: 'POLYNOMIAL', coeffs: [0, 0, 0] })).toBe('Polynomial · 0');
    expect(specLabel({ type: 'POLYNOMIAL', coeffs: [] })).toBe('Polynomial · 0');
  });
  test('EXPONENTIAL embeds the rate (3 dp) and centre with a U+2212 minus', () => {
    expect(specLabel({ type: 'EXPONENTIAL', center: 50, rate: 0.05 })).toBe(
      `Exponential · e^(0.050·(θ${MINUS}50))`,
    );
  });
  test('missing optional fields default to 0', () => {
    expect(specLabel({ type: 'CALL' })).toBe('Call · K=0');
    expect(specLabel({ type: 'SPREAD' })).toBe('Spread [0, 0]');
    expect(specLabel({ type: 'GAUSSIAN' })).toBe('Bell · c=0 w=0');
  });
  test('an unknown type echoes the raw type', () => {
    expect(specLabel({ type: 'MYSTERY' })).toBe('MYSTERY');
  });
});

describe('statusTone', () => {
  // The exact class strings are load-bearing for the UI theme.
  const KNOWN: Record<string, string> = {
    OPEN: 'text-buy bg-buy-soft',
    CREATED: 'text-accent bg-accent-soft',
    SUSPENDED: 'text-warn bg-[#2c2614]',
    RESOLVED: 'text-accent bg-accent-soft',
    SETTLED: 'text-muted bg-panel-2',
    CLOSED: 'text-muted bg-panel-2',
    CANCELLED: 'text-sell bg-sell-soft',
  };
  for (const [status, tone] of Object.entries(KNOWN)) {
    test(`maps ${status}`, () => {
      expect(statusTone(status)).toBe(tone);
    });
  }
  test('an unknown status falls back to the muted tone', () => {
    expect(statusTone('WAT')).toBe('text-muted bg-panel-2');
    expect(statusTone('')).toBe('text-muted bg-panel-2');
    expect(statusTone('open')).toBe('text-muted bg-panel-2'); // case-sensitive
  });
});

describe('timeAgo', () => {
  // timeAgo reads Date.now internally, so anchor inputs to a freshly captured
  // now and assert the stable shape / ordering rather than brittle exact strings.
  test('null / empty render the empty string', () => {
    expect(timeAgo(null)).toBe('');
    expect(timeAgo('')).toBe('');
  });
  test('seconds bucket just-now', () => {
    const now = Date.now();
    expect(timeAgo(new Date(now - 5_000).toISOString())).toBe('5s ago');
    expect(timeAgo(new Date(now).toISOString())).toBe('0s ago');
  });
  test('future timestamps clamp to 0s (no negative ages)', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(timeAgo(future)).toBe('0s ago');
  });
  test('minute / hour / day buckets', () => {
    const now = Date.now();
    expect(timeAgo(new Date(now - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(timeAgo(new Date(now - 3 * 3_600_000).toISOString())).toBe('3h ago');
    expect(timeAgo(new Date(now - 2 * 86_400_000).toISOString())).toBe('2d ago');
  });
  test('boundaries round into the next unit (60s→1m, 60m→1h, 24h→1d)', () => {
    const now = Date.now();
    expect(timeAgo(new Date(now - 60_000).toISOString())).toBe('1m ago');
    expect(timeAgo(new Date(now - 3_600_000).toISOString())).toBe('1h ago');
    expect(timeAgo(new Date(now - 86_400_000).toISOString())).toBe('1d ago');
  });
  test('59s stays in seconds, 90s rounds to 2m', () => {
    const now = Date.now();
    expect(timeAgo(new Date(now - 59_000).toISOString())).toBe('59s ago');
    expect(timeAgo(new Date(now - 90_000).toISOString())).toBe('2m ago');
  });
  test('monotonic: older inputs never report a smaller unit count within a bucket', () => {
    const now = Date.now();
    const a = timeAgo(new Date(now - 10_000).toISOString());
    const b = timeAgo(new Date(now - 20_000).toISOString());
    expect(Number.parseInt(a, 10)).toBeLessThan(Number.parseInt(b, 10));
  });
  test('an unparseable date string yields a NaN-derived "ago" rather than throwing', () => {
    // new Date('nope').getTime is NaN → (now-NaN) is NaN → Math.round(NaN)=NaN
    // Math.max(0, NaN)=NaN. The shape is "NaNs ago"; assert it does not throw and is a string.
    const out = timeAgo('not-a-date');
    expect(typeof out).toBe('string');
    expect(out.endsWith('ago')).toBe(true);
  });
});
