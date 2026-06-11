import { describe, expect, test } from 'bun:test';
import { type BookEntry, makeEngineConfig, price, requiredReserve } from '@bmm/core';
import { GaussianBelief } from '@bmm/core';
import { applyFill, execPriceFor, solveFill } from '../src/services/tradeMath.ts';

describe('execPriceFor', () => {
  test('buy pays the ask (fair + spread)', () => {
    expect(execPriceFor('buy', 100, 2)).toBe(102);
  });
  test('sell receives the bid (fair − spread)', () => {
    expect(execPriceFor('sell', 100, 2)).toBe(98);
  });
  test('sell bid is floored at 0', () => {
    expect(execPriceFor('sell', 1, 5)).toBe(0);
  });
});

describe('applyFill — average-entry accounting', () => {
  test('first buy sets avg entry to exec price', () => {
    const p = applyFill({ quantity: 0, avgEntryPrice: 0, realizedPnl: 0 }, 10, 5);
    expect(p.quantity).toBe(10);
    expect(p.avgEntryPrice).toBe(5);
    expect(p.realizedPnl).toBe(0);
  });

  test('second buy blends the average', () => {
    const a = applyFill({ quantity: 10, avgEntryPrice: 5, realizedPnl: 0 }, 10, 7);
    // (10*5 + 10*7) / 20 = 6
    expect(a.quantity).toBe(20);
    expect(a.avgEntryPrice).toBe(6);
  });

  test('partial sell realizes PnL at avg entry, keeps avg for the rest', () => {
    const a = applyFill({ quantity: 20, avgEntryPrice: 6, realizedPnl: 0 }, -5, 9);
    // realized = 5 * (9 - 6) = 15
    expect(a.quantity).toBe(15);
    expect(a.avgEntryPrice).toBe(6);
    expect(a.realizedPnl).toBe(15);
  });

  test('full close zeroes quantity and avg, accumulates realized', () => {
    const a = applyFill({ quantity: 15, avgEntryPrice: 6, realizedPnl: 15 }, -15, 4);
    // realized += 15 * (4 - 6) = -30 → 15 - 30 = -15
    expect(a.quantity).toBe(0);
    expect(a.avgEntryPrice).toBe(0);
    expect(a.realizedPnl).toBe(-15);
  });
});

describe('solveFill', () => {
  const cfg = makeEngineConfig(100, 10);
  const belief = new GaussianBelief(100, 100);
  const reserveOpts = { alpha: cfg.reserveAlpha, samples: 4000 };

  test('full fill when capacity is ample', () => {
    const r = solveFill({
      spec: { type: 'BINARY_CALL', strike: 100 },
      side: 'buy',
      targetSize: 10,
      mmShort: 0,
      book: [],
      belief,
      cfg,
      fair: 0.5,
      cash: 1_000_000,
      balance: Number.POSITIVE_INFINITY,
      isInfinite: true,
      reserveOpts,
      openMargin: 1.2,
    });
    expect(r.fillSize).toBe(10);
  });

  test('partial fill when cash caps the reserve (binary payout = size units of risk)', () => {
    // A binary pays ≤ 1 per unit, so reserve for q units ≈ q at the tail. With cash
    // only ~50 and a 1.2 margin, the feasible buy size is well under the 1000 target.
    const r = solveFill({
      spec: { type: 'BINARY_CALL', strike: 100 },
      side: 'buy',
      targetSize: 1000,
      mmShort: 0,
      book: [],
      belief,
      cfg,
      fair: 0.5,
      cash: 50,
      balance: Number.POSITIVE_INFINITY,
      isInfinite: true,
      reserveOpts,
      openMargin: 1.2,
    });
    expect(r.fillSize).toBeGreaterThan(0);
    expect(r.fillSize).toBeLessThan(1000);
  });

  test('buyer balance caps the fill', () => {
    const r = solveFill({
      spec: { type: 'BINARY_CALL', strike: 100 },
      side: 'buy',
      targetSize: 1000,
      mmShort: 0,
      book: [],
      belief,
      cfg,
      fair: 0.5,
      cash: 1_000_000,
      balance: 10, // can only afford ~ 10 / execPrice units
      isInfinite: false,
      reserveOpts,
      openMargin: 1.2,
    });
    expect(r.fillSize).toBeGreaterThan(0);
    expect(r.fillSize).toBeLessThan(1000);
  });
});

describe('solveFill — capacity gate invariants (the no-buy band)', () => {
  // A one-sided CALL book (unbounded payoff) is parked so cash sits inside the
  // [reserve, 1.2·reserve) band: solvent, but with no headroom to open new risk.
  const cfg = makeEngineConfig(100, 10);
  const belief = new GaussianBelief(100, 100); // σ = 10
  const reserveOpts = { alpha: cfg.reserveAlpha, samples: 8000 };
  const crowd = { type: 'CALL' as const, strike: 100 };
  const book: BookEntry[] = [{ spec: crowd, mmShort: 300 }];
  const reserve0 = requiredReserve(book, belief, reserveOpts);
  const fair = price(crowd, belief);
  const bandCash = reserve0 * 1.05; // ρ = 0.95⁻¹ headroom gone for a 1.2× margin

  const base = {
    spec: crowd,
    mmShort: 300,
    book,
    belief,
    cfg,
    fair,
    balance: Number.POSITIVE_INFINITY,
    isInfinite: true,
    reserveOpts,
    openMargin: 1.2,
  };

  test('a risk-opening buy is frozen at any size inside the band', () => {
    // The 1.2× margin trips the instant the reserve ticks up, so even a tiny buy fails.
    const big = solveFill({ ...base, side: 'buy', targetSize: 50, cash: bandCash });
    const tiny = solveFill({ ...base, side: 'buy', targetSize: 1, cash: bandCash });
    expect(big.fillSize).toBeLessThan(0.5);
    expect(tiny.fillSize).toBeLessThan(0.5);
  });

  test('a sell still fills fully while buys are frozen (offsetting ⇒ margin 1)', () => {
    // Reducing exposure lowers the reserve, so the 1.0× margin clears it.
    const r = solveFill({ ...base, side: 'sell', targetSize: 50, cash: bandCash });
    expect(r.fillSize).toBeGreaterThan(49.5);
  });

  test('the frozen buy clears once cash rises above the 1.2× buffer', () => {
    const r = solveFill({ ...base, side: 'buy', targetSize: 50, cash: reserve0 * 5 });
    expect(r.fillSize).toBeGreaterThan(0);
  });

  test('a healthy market (cash ≫ 1.2·reserve) is never gated — full fill', () => {
    const r = solveFill({ ...base, side: 'buy', targetSize: 50, cash: reserve0 * 100 });
    expect(r.fillSize).toBe(50);
  });

  test('an empty book has no gate — a buy fills to the target (no spurious freeze)', () => {
    const r = solveFill({
      ...base,
      book: [],
      mmShort: 0,
      side: 'buy',
      targetSize: 50,
      cash: reserve0 * 100,
    });
    expect(r.fillSize).toBe(50);
  });
});
