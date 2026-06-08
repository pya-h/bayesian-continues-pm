// unit tests — pure LP NAV-share math (no DB). Covers share pricing
// pro-rata deposit mint, withdrawal cash-out, and the settlement cash_final split.

import { describe, expect, test } from 'bun:test';
import {
  cashOutForShares,
  lpCashFinal,
  lpClaimAmount,
  lpSharePrice,
  sharesForDeposit,
} from '../src/services/lpMath.ts';

describe('lpSharePrice', () => {
  test('genesis (no shares) is priced at 1', () => {
    expect(lpSharePrice(0, 0)).toBe(1);
  });
  test('NAV / S_total otherwise', () => {
    expect(lpSharePrice(1500, 1000)).toBe(1.5);
  });
});

describe('sharesForDeposit (mint at the pre-deposit price)', () => {
  test('deposit at price 1 mints 1 share per unit', () => {
    expect(sharesForDeposit(500, 1000, 1000)).toBe(500); // NAV=S ⇒ price 1
  });
  test('after the pool grows, a deposit mints fewer shares', () => {
    // NAV grew to 2000 on 1000 shares (price 2) ⇒ 500 deposit mints 250 shares.
    expect(sharesForDeposit(500, 1000, 2000)).toBe(250);
  });
});

describe('cashOutForShares (burn at the live price)', () => {
  test('redeems pro-rata of NAV', () => {
    expect(cashOutForShares(250, 1000, 2000)).toBe(500); // 25% of 2000
  });
  test('zero total shares returns 0', () => {
    expect(cashOutForShares(10, 0, 2000)).toBe(0);
  });
});

describe('settlement split: cash_final and pro-rata claims', () => {
  test('cash_final = cash − Σ payouts', () => {
    expect(lpCashFinal(10000, 3500)).toBe(6500);
  });
  test('two LPs split cash_final pro-rata and exhaust it', () => {
    const cashFinal = lpCashFinal(10000, 4000); // 6000
    const a = lpClaimAmount(600, 1000, cashFinal); // 60%
    const b = lpClaimAmount(400, 1000, cashFinal); // 40%
    expect(a).toBe(3600);
    expect(b).toBe(2400);
    expect(a + b).toBeCloseTo(cashFinal, 8);
  });
});
