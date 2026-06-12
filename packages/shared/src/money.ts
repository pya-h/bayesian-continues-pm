// Money helpers. Play money stored as numeric(20,8); all arithmetic that touches
// balances goes through here and rounds to 8 dp (round-half-even / banker's
// rounding) so repeated float ops don't drift.
// Precision ceiling (documented limitation): amounts ride on float64, so `x·1e8`
// exceeds 2^53 once |x| > ~9.007e7 — past that, 8-dp rounding silently coarsens
// even though numeric(20,8) advertises 12 integer digits. Keep balances below ~9e7
// (the seeded economy is orders of magnitude under this) or move to scaled integers
// before raising that cap. Ties are also only approximately half-even: a tie that
// isn't exactly representable in binary (e.g. 1.5e-8 ≈ 1.4999…e-8) resolves by its
// float neighbor, not the even rule.

export const MONEY_DP = 8;
const SCALE = 10 ** MONEY_DP;

export function round8(x: number): number {
  if (!Number.isFinite(x)) throw new Error(`round8: non-finite value ${x}`);
  const scaled = x * SCALE;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  if (diff > 0.5) rounded = floor + 1;
  else if (diff < 0.5) rounded = floor;
  else rounded = floor % 2 === 0 ? floor : floor + 1; // tie → even
  return rounded / SCALE;
}

export function addMoney(a: number, b: number): number {
  return round8(a + b);
}

export function subMoney(a: number, b: number): number {
  return round8(a - b);
}

export function mulMoney(a: number, b: number): number {
  return round8(a * b);
}

export function sumMoney(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return round8(s);
}

export function formatMoney(x: number, dp = 2): string {
  return round8(x).toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}
