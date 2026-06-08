// Numerics — special functions and a seedable RNG.
// Accuracy target: Phi/phi accurate to ≥ 1e-7. The implementations
// here are good to ~1e-12 or better, validated in numerics.test.ts against known
// values. No `Math.random` anywhere — all randomness flows through a seeded Rng so
// Monte-Carlo reserve and tests are reproducible.

export const SQRT2 = Math.SQRT2; // √2
export const SQRT2PI = Math.sqrt(2 * Math.PI); // √(2π)
export const INV_SQRT2PI = 1 / SQRT2PI;

// Standard normal PDF φ(x).
export function phi(x: number): number {
  return INV_SQRT2PI * Math.exp(-0.5 * x * x);
}

// Standard normal CDF Φ(x) = ½·erfc(-x/√2).
export function Phi(x: number): number {
  return 0.5 * erfc(-x / SQRT2);
}

// Maclaurin series for erf, used for |z| < 2 (no catastrophic cancellation there).
function erfSeries(z: number): number {
  // erf(z) = (2/√π) Σ_{n≥0} (-1)^n z^{2n+1} / (n!(2n+1))
  let term = z; // n=0: z^{1}/0! (sign folded in via the *= -z²/(n+1) step)
  let sum = z; // contribution at n=0 is term/(2·0+1) = z
  for (let n = 0; n < 100; n++) {
    term *= (-z * z) / (n + 1);
    const contribution = term / (2 * n + 3);
    sum += contribution;
    if (Math.abs(contribution) < 1e-18 * Math.abs(sum)) break;
  }
  return (2 / Math.sqrt(Math.PI)) * sum;
}

// Continued fraction for erfc, used for z ≥ 2 (fast, no cancellation). Modified Lentz.
function erfcCF(z: number): number {
  const tiny = 1e-300;
  let f = tiny;
  let c = f;
  let d = 0;
  for (let n = 1; n < 300; n++) {
    const an = n === 1 ? 1 : (n - 1) / 2;
    const bn = z;
    d = bn + an * d;
    if (d === 0) d = tiny;
    c = bn + an / c;
    if (c === 0) c = tiny;
    d = 1 / d;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return (Math.exp(-z * z) / Math.sqrt(Math.PI)) * f;
}

export function erf(x: number): number {
  if (x === 0) return 0;
  const z = Math.abs(x);
  const r = z < 2 ? erfSeries(z) : 1 - erfcCF(z);
  return x < 0 ? -r : r;
}

export function erfc(x: number): number {
  if (x >= 2) return erfcCF(x);
  if (x <= -2) return 2 - erfcCF(-x);
  return 1 - erf(x);
}

// Inverse standard normal CDF (probit). Peter Acklam's rational approximation
// (~1.15e-9) refined with one Halley step → full double precision.
export function normInv(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;

  // Coefficients for Acklam's algorithm (as-const tuples → defined element types
  // under noUncheckedIndexedAccess).
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ] as const;
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ] as const;
  const cc = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ] as const;
  const dd = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
  ] as const;

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((cc[0] * q + cc[1]) * q + cc[2]) * q + cc[3]) * q + cc[4]) * q + cc[5]) /
      ((((dd[0] * q + dd[1]) * q + dd[2]) * q + dd[3]) * q + 1);
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((cc[0] * q + cc[1]) * q + cc[2]) * q + cc[3]) * q + cc[4]) * q + cc[5]) /
      ((((dd[0] * q + dd[1]) * q + dd[2]) * q + dd[3]) * q + 1);
  }

  // One Halley refinement step. At ~37σ the exp overflows to Infinity, which
  // would poison the step to NaN — skip it there and keep the rational estimate
  // (already accurate to ~1e-9), so extreme-tail quantiles stay finite.
  const e = Phi(x) - p;
  const u = e * SQRT2PI * Math.exp(0.5 * x * x);
  if (!Number.isFinite(u)) return x;
  x = x - u / (1 + (x * u) / 2);
  return x;
}

// Seedable PRNG (mulberry32). Deterministic stream → reproducible Monte-Carlo.
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Force to uint32; avoid 0-only degenerate seed.
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  nextOpen(): number {
    return this.next() * (1 - 2 ** -32) + 2 ** -33;
  }

  // Standard normal sample via inverse-CDF (deterministic given the stream).
  nextNormal(): number {
    return normInv(this.nextOpen());
  }
}
