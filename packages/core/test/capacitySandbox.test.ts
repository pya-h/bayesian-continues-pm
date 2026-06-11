// Capacity-sandbox fidelity tests.
// The math doc ships an interactive capacity sandbox whose engine lives in
// .js, built on.js (the browser port of
// this package). These tests load BOTH of those browser files headlessly and
// assert that the sandbox computes the SAME thing the real server engine does
// • its stratified reserve matches @bmm/core's Monte-Carlo requiredReserve
// • the default market really sits in the no-buy band (risk-opening buys frozen)
// • an offsetting trade still fills while the crowded side is gated
// • each capacity fix (A–G) bends the gate the way describes
// • the soft-cap congestion ramp actually rises with size (regression for the
// size-0-quote bug that hid congestion from the price chart).
// Loading note: both browser files end with an IIFE invoked as `(window)` /
// `(typeof window …)`. We bind `window` as a Function parameter so they run
// outside a browser and attach `BMM` / `CapEngine` to our stand-in object.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GaussianBelief, requiredReserve } from '@bmm/core';

// biome-ignore lint/suspicious/noExplicitAny: ad-hoc browser-global stand-in
type AnyObj = any;

function loadBrowserFile(relPath: string, win: AnyObj): void {
  const src = readFileSync(new URL(relPath, import.meta.url), 'utf8');
  // `window` param satisfies the trailing `(window)` IIFE call in each file.
  new Function('window', src)(win);
}

const win: AnyObj = {};
loadBrowserFile('../../../docs/math/math.js', win);
loadBrowserFile('../../../docs/math/capacity-engine.js', win);
const BMM = win.BMM;
const CAP = win.CapEngine.makeCapEngine(BMM);

const CALL100 = { type: 'CALL', strike: 100 };
const CALL_KEY = 'CALL:100';

function freshBlocked() {
  const tape = CAP.buildTape(5000);
  return { tape, st: CAP.replay(tape, 5000, CAP.modifierFor('none')) };
}

describe('sandbox reserve matches the server engine', () => {
  test("stratified VaR ≈ core's Monte-Carlo requiredReserve (within 4%)", () => {
    const belief = new BMM.Belief(108, 7);
    const book = [{ spec: CALL100, key: CALL_KEY, mmShort: 420 }];
    const sandbox = CAP.reserveBook(book, belief, 0.99);
    const core = requiredReserve([{ spec: CALL100, mmShort: 420 }], new GaussianBelief(108, 49), {
      alpha: 0.99,
      samples: 50_000,
    });
    expect(core).toBeGreaterThan(0);
    expect(Math.abs(sandbox - core) / core).toBeLessThan(0.04);
  });

  test('reserve is monotone in the short position', () => {
    const b = new BMM.Belief(108, 6);
    const r300 = CAP.reserveBook([{ spec: CALL100, key: CALL_KEY, mmShort: 300 }], b, 0.99);
    const r600 = CAP.reserveBook([{ spec: CALL100, key: CALL_KEY, mmShort: 600 }], b, 0.99);
    expect(r600).toBeGreaterThan(r300);
  });

  test('a lower α (95%) reserves strictly less than 99%', () => {
    const b = new BMM.Belief(108, 6);
    const book = [{ spec: CALL100, key: CALL_KEY, mmShort: 400 }];
    expect(CAP.reserveBook(book, b, 0.95)).toBeLessThan(CAP.reserveBook(book, b, 0.99));
  });
});

describe('the default market really is at the gate', () => {
  test('it rests in the no-buy band (solvent, risk-opening buys frozen)', () => {
    const { st } = freshBlocked();
    const g = CAP.gateInfo(st, CAP.modifierFor('none'));
    expect(g.blocked).toBe(true);
    // ρ = reserve/cash pinned at ≈ 1/1.2 = 0.833 (cash = 1.2·reserve).
    expect(g.rho).toBeGreaterThan(0.8);
    expect(g.rho).toBeLessThanOrEqual(1.0);
  });

  test('a risk-opening CALL buy is rejected, but an offsetting PUT fills', () => {
    const { st } = freshBlocked();
    const none = CAP.modifierFor('none');
    const call = CAP.quoteBuy(CALL100, CALL_KEY, 1, st, none);
    expect(call.admit).toBe(false); // crowded side: opens risk ⇒ gated

    const putSpec = { type: 'PUT', strike: 100 };
    const put = CAP.quoteBuy(putSpec, CAP.keyOf(putSpec), 40, st, none);
    expect(put.admit).toBe(true); // opposite side: does not raise the binding tail
    expect(put.Ra).toBeLessThanOrEqual(put.Rb + 1e-9); // risk-reducing ⇒ margin 1
  });
});

describe('each fix bends the gate as documented', () => {
  test('A — lower open-margin (1.05×) reopens the frozen buy', () => {
    const { st } = freshBlocked();
    expect(CAP.quoteBuy(CALL100, CALL_KEY, 1, st, CAP.modifierFor('none')).admit).toBe(false);
    expect(CAP.quoteBuy(CALL100, CALL_KEY, 1, st, CAP.modifierFor('A')).admit).toBe(true);
  });

  test('B — lower reserve confidence shrinks the reserve and reopens the buy', () => {
    const { st } = freshBlocked();
    const rNone = CAP.reserveMod(st.book, st.belief, CAP.modifierFor('none'));
    const rB = CAP.reserveMod(st.book, st.belief, CAP.modifierFor('B'));
    expect(rB).toBeLessThan(rNone);
    expect(CAP.quoteBuy(CALL100, CALL_KEY, 1, st, CAP.modifierFor('B')).admit).toBe(true);
  });

  test('C — soft cap prices congestion on the crowded side, zero on the offset', () => {
    const { st } = freshBlocked();
    const modC = CAP.modifierFor('C');
    const call = CAP.quoteBuy(CALL100, CALL_KEY, 5, st, modC);
    expect(call.admit).toBe(true); // backstop 1.05 leaves headroom at ρ≈0.833
    expect(call.congestion).toBeGreaterThan(0);
    const putSpec = { type: 'PUT', strike: 100 };
    expect(CAP.quoteBuy(putSpec, CAP.keyOf(putSpec), 5, st, modC).congestion).toBe(0);
  });

  test('C — the marginal price ramp rises with size (congestion regression)', () => {
    // Regression: the chart used to quote size 0, leaving Ra==Rb so congestion was
    // always 0 and the ramp was flat. marginalAsk quotes the next unit, so it shows.
    const { st } = freshBlocked();
    const modC = CAP.modifierFor('C');
    const near = CAP.marginalAsk(CALL100, CALL_KEY, 0, st, modC);
    const far = CAP.marginalAsk(CALL100, CALL_KEY, 60, st, modC);
    expect(near.congestion).toBeGreaterThan(0);
    expect(far.congestion).toBeGreaterThan(near.congestion);
    expect(far.exec).toBeGreaterThan(near.exec);
  });

  test('E — an insurance top-up adds backing and reopens the buy', () => {
    const { st } = freshBlocked();
    const modE = CAP.modifierFor('E');
    expect(CAP.backing(st.cash, modE)).toBeGreaterThan(st.cash);
    expect(CAP.quoteBuy(CALL100, CALL_KEY, 1, st, modE).admit).toBe(true);
  });

  test('F — hedging scales the reserve by (1−h) and reopens the buy', () => {
    const { st } = freshBlocked();
    const modF = CAP.modifierFor('F'); // default h = 0.3
    const rNone = CAP.reserveMod(st.book, st.belief, CAP.modifierFor('none'));
    const rF = CAP.reserveMod(st.book, st.belief, modF);
    expect(rF / rNone).toBeCloseTo(0.7, 5);
    expect(CAP.quoteBuy(CALL100, CALL_KEY, 1, st, modF).admit).toBe(true);
  });

  test('D — the haircut removes the gate; over-buying drives the solvency factor < 1', () => {
    const { tape } = freshBlocked();
    const modD = CAP.modifierFor('D');
    const st = CAP.replay(tape, 5000, modD);
    // The gate is gone — a large buy fills regardless of reserve.
    const r = CAP.stepBuy(st, CALL100, 3000, 'You', modD);
    expect(r.fill).toBeGreaterThan(0);
    const W = CAP.reserveMod(st.book, st.belief, modD);
    const s = Math.min(1, st.cash / Math.max(W, 1e-9));
    expect(s).toBeLessThan(1); // pool now short in the tail ⇒ winners haircut
  });

  test('G — auto-deleverage force-closes the crowd to seat an otherwise-gated buy', () => {
    const { st } = freshBlocked();
    const r = CAP.stepBuy(st, CALL100, 50, 'You', CAP.modifierFor('G'));
    expect(r.forcedNow).toBeGreaterThan(0); // reclaimed reserve from holders
    expect(r.fill).toBeGreaterThan(0); // …so the buy seats
  });
});

describe('congestion premium guards', () => {
  const modC = CAP.modifierFor('C');
  test('zero when the trade reduces (or does not raise) the reserve', () => {
    expect(CAP.congestionOf(100, 90, 1000, 5, modC)).toBe(0);
    expect(CAP.congestionOf(100, 100, 1000, 5, modC)).toBe(0);
  });
  test('positive and rising as the reserve grows under soft cap', () => {
    const low = CAP.congestionOf(100, 110, 1000, 5, modC);
    const high = CAP.congestionOf(100, 130, 1000, 5, modC);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);
  });
  test('zero without the soft-cap modifier, even when the reserve rises', () => {
    expect(CAP.congestionOf(100, 130, 1000, 5, CAP.modifierFor('none'))).toBe(0);
  });
});
