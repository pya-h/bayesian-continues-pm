// G4 — placement interaction ("paint the curve").
// Decision: the placement primitive is the **bell (GAUSSIAN) contract** (option a —
// no new contract). On a Gen·basis market `updateBeliefForTrade` routes a bell trade
// to the **weight-only** `placeBasisBump`: a BUY adds mass at the bell's center
// (spawning a bump there if none is within `tauSpawn·σ`), a SELL removes mass from a
// bump you're on. Because it's *additive* (no multiplicative reweighting / mean drift
// of the other bumps), repeated bets at distinct centers accumulate into *distinct
// persistent* modes — which the consensus-forming responsibility update cannot hold.

import { describe, expect, test } from 'bun:test';
import { tradeSignal, updateBeliefForTrade } from '../src/bayes.ts';
import { makeEngineConfig } from '../src/config.ts';
import { MixtureBelief } from '../src/mixture.ts';
import { DEFAULT_MIXTURE_OPS, type MixtureOpsConfig } from '../src/mixture_ops.ts';
import { placeBasisBump } from '../src/placement.ts';
import { extractSignal } from '../src/signal.ts';
import { type BookEntry, requiredReserve } from '../src/solvency.ts';
import type { ContractSpec } from '../src/types.ts';

const cfg = makeEngineConfig(70, 10, {});
const ops: MixtureOpsConfig = {
  ...DEFAULT_MIXTURE_OPS,
  allowSpawn: true,
  maxComponents: 12,
  tauSpawn: 3,
};

const bell = (center: number): ContractSpec => ({ type: 'GAUSSIAN', center, width: 6 });
const single = () => new MixtureBelief([{ pi: 1, mu: 70, sigma2: 100 }]);
const sumPi = (b: MixtureBelief) => b.components.reduce((s, c) => s + c.pi, 0);
const hasModeNear = (b: MixtureBelief, x: number, tol = 14) =>
  b.components.some((c) => Math.abs(c.mu - x) < tol);

const paint = (b: MixtureBelief, center: number, q: number): MixtureBelief =>
  updateBeliefForTrade(bell(center), q, b, cfg, 'gen_basis', ops) as MixtureBelief;

describe('placement — distinct centers carve distinct, persistent modes', () => {
  test('painting bells at 30 / 70 / 110 holds three modes (additive, not consensus-forming)', () => {
    let b = single();
    for (let round = 0; round < 4; round++) {
      for (const c of [30, 70, 110]) b = paint(b, c, 100);
    }
    expect(b.components.length).toBeGreaterThanOrEqual(3);
    expect(hasModeNear(b, 30)).toBe(true);
    expect(hasModeNear(b, 70)).toBe(true);
    expect(hasModeNear(b, 110)).toBe(true);
    // each camp keeps a real share — none is starved to a sliver (the responsibility
    // update would collapse two of them; the weight-only update keeps all three).
    for (const c of b.components) expect(c.pi).toBeGreaterThan(0.05);
  });

  test('a single far bell BUY spawns a bump at its center', () => {
    const b = paint(single(), 130, 150); // 6σ above consensus
    expect(hasModeNear(b, 130)).toBe(true);
    expect(b.components.length).toBeGreaterThanOrEqual(2);
  });

  test('weights stay normalised (Σπ = 1) at every placement', () => {
    let b = single();
    for (const c of [110, 30, 70, 150, 30, 110, 70, 190, 30]) {
      b = paint(b, c, 120);
      expect(Math.abs(sumPi(b) - 1)).toBeLessThan(1e-9);
    }
  });

  test('component count never exceeds the Gen·basis cap under chaotic painting', () => {
    const capped: MixtureOpsConfig = { ...ops, maxComponents: 6 };
    let b = single();
    for (const c of [30, 70, 110, 150, 190, 230, 30, 270, 110, 150, 30, 190]) {
      b = updateBeliefForTrade(bell(c), 150, b, cfg, 'gen_basis', capped) as MixtureBelief;
      expect(b.components.length).toBeLessThanOrEqual(6);
      expect(Math.abs(sumPi(b) - 1)).toBeLessThan(1e-9);
    }
  });
});

describe('placement — selling paints a camp down', () => {
  test('selling a bell at a painted camp erases that mode', () => {
    let b = single();
    for (let r = 0; r < 4; r++) for (const c of [30, 70, 110]) b = paint(b, c, 100);
    expect(hasModeNear(b, 30)).toBe(true);
    for (let k = 0; k < 6; k++) b = paint(b, 30, -150); // sell the 30 camp away
    expect(hasModeNear(b, 30)).toBe(false); // erased
    expect(hasModeNear(b, 110)).toBe(true); // the far camp is untouched
    expect(Math.abs(sumPi(b) - 1)).toBeLessThan(1e-9);
  });

  test('selling empty space (no nearby bump) leaves the belief unchanged', () => {
    const b = single(); // one bump at 70
    const after = placeBasisBump(b, 200, -0.3, cfg, ops); // far from the 70 bump
    expect(after.components.length).toBe(1);
    expect(after.components[0]?.mu).toBeCloseTo(70, 6);
  });
});

describe('placement — routing (only Gen·basis bells paint)', () => {
  test('Gen·basis + bell routes to placeBasisBump', () => {
    const b = single();
    const viaTrade = updateBeliefForTrade(bell(120), 150, b, cfg, 'gen_basis', ops);
    const intensity = Math.min(1, 150 / cfg.qMax);
    const reliability = 1 - Math.exp(-150 / cfg.qThreshold);
    const direct = placeBasisBump(b, 120, intensity * reliability, cfg, ops);
    expect((viaTrade as MixtureBelief).components).toEqual(direct.components);
  });

  test('a plain mixture market with a bell does NOT paint (uses the responsibility update)', () => {
    const b = single();
    // a plain `mixture` market gets the shipped ops (spawning off), like the api's mixtureOpsFor
    const mixtureWay = updateBeliefForTrade(bell(120), 150, b, cfg, 'mixture', DEFAULT_MIXTURE_OPS);
    const placementWay = updateBeliefForTrade(bell(120), 150, b, cfg, 'gen_basis', ops);
    // responsibility (no spawn for plain mixture) keeps one mode; placement spawns one
    expect((mixtureWay as MixtureBelief).components.length).toBe(1);
    expect((placementWay as MixtureBelief).components.length).toBeGreaterThanOrEqual(2);
  });

  test('Gen·basis + a non-bell contract keeps the standard update (not placement)', () => {
    const b = single();
    const call: ContractSpec = { type: 'CALL', strike: 90 };
    const out = updateBeliefForTrade(call, 150, b, cfg, 'gen_basis', ops) as MixtureBelief;
    // a CALL still updates via extractSignal→responsibility; it stays a valid mixture
    expect(out.kind).toBe('mixture');
    expect(Math.abs(sumPi(out) - 1)).toBeLessThan(1e-9);
  });
});

describe('placement — audit signal reflects the placement (tradeSignal)', () => {
  test('a Gen·basis bell audits as (center, signed strength), not extractSignal', () => {
    const b = single();
    const intensity = Math.min(1, 150 / cfg.qMax);
    const reliability = 1 - Math.exp(-150 / cfg.qThreshold);

    // BUY: positive strength, signal == the painted center.
    const buy = tradeSignal(bell(120), 150, b, cfg, 'gen_basis');
    expect(buy.signal).toBe(120);
    expect(buy.weight).toBeCloseTo(intensity * reliability, 12);

    // SELL: same center, strength flips sign (mass removed) — faithful to placeBasisBump.
    const sell = tradeSignal(bell(120), -150, b, cfg, 'gen_basis');
    expect(sell.signal).toBe(120);
    expect(sell.weight).toBeCloseTo(-intensity * reliability, 12);
  });

  test('non-placement trades audit identically to extractSignal', () => {
    const b = single();
    const call: ContractSpec = { type: 'CALL', strike: 90 };
    // a non-bell on Gen·basis, and any contract on a non-Gen·basis market, fall through
    expect(tradeSignal(call, 150, b, cfg, 'gen_basis')).toEqual(extractSignal(call, 150, b, cfg));
    expect(tradeSignal(bell(120), 150, b, cfg, 'mixture')).toEqual(
      extractSignal(bell(120), 150, b, cfg),
    );
  });
});

describe('placement — solvency stays well-defined', () => {
  test('moments stay finite and the MC reserve stays bounded as modes multiply', () => {
    let b = single();
    for (let r = 0; r < 4; r++) for (const c of [30, 70, 110]) b = paint(b, c, 100);
    expect(Number.isFinite(b.mean())).toBe(true);
    expect(b.variance()).toBeGreaterThan(0);

    // MM short one bell at each painted camp. Bell payoff ∈ [0,1], so the α-quantile
    // reserve must land in [0, Σ mmShort] — bounded by construction.
    const book: BookEntry[] = [
      { spec: bell(30), mmShort: 50 },
      { spec: bell(70), mmShort: 50 },
      { spec: bell(110), mmShort: 50 },
    ];
    const reserve = requiredReserve(book, b, { samples: 5000 });
    expect(Number.isFinite(reserve)).toBe(true);
    expect(reserve).toBeGreaterThanOrEqual(0);
    expect(reserve).toBeLessThanOrEqual(150);
  });
});
