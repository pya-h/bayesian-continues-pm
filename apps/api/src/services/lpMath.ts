// Pure LP math (no DB, no IO) — NAV-share accounting for the reserve pool
// . The pool is the MM's cash reserve; LPs own pro-rata shares of its NAV.
// NAV = cash − E_p[L(θ)] (cash minus mark-to-model liability)
// sharePrice = NAV / S_total
// deposit ΔS = D · S_total / NAV_before (mint at the pre-deposit price)
// withdraw $ = ΔS / S_total · NAV (burn at the current price)
// cash_final = cash − Σ user_payouts (residual pool value at settlement)
// LP claim = shares / S_total · cash_final
// Callers guard the degenerate cases (NAV_before ≤ 0 for deposits, S_total = 0)
// these helpers assume valid inputs and just do the arithmetic.

import { round8 } from '@bmm/shared';

export function lpSharePrice(nav: number, sharesTotal: number): number {
  return sharesTotal > 0 ? round8(nav / sharesTotal) : 1;
}

export function sharesForDeposit(amount: number, sharesTotal: number, navBefore: number): number {
  return round8((amount * sharesTotal) / navBefore);
}

export function cashOutForShares(shares: number, sharesTotal: number, nav: number): number {
  return sharesTotal > 0 ? round8((shares / sharesTotal) * nav) : 0;
}

export function lpCashFinal(cash: number, totalPayouts: number): number {
  return round8(cash - totalPayouts);
}

export function lpClaimAmount(shares: number, sharesTotal: number, cashFinal: number): number {
  return sharesTotal > 0 ? round8((shares / sharesTotal) * cashFinal) : 0;
}
