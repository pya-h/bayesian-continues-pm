// Pure trade-math helpers (no DB, no IO) — the deterministic core of the trade
// engine, kept separate so it can be unit-tested in isolation
// • execPriceFor — ask/bid from fair ± half-spread (sell bid floored at 0).
// • applyFill — average-entry position accounting (long-only) + realized PnL.
// • solveFill — largest feasible |size| ≤ target under the solvency gate and
// (for buys) the trader's balance. Used by both quote (preview)
// and execute (commit) so they agree.
// Sign convention: q > 0 BUY, q < 0 SELL; mmShort[C] = Σ user
// positions, so a fill of `q` moves mmShort by `q`. `totalCost = execPrice·q` is
// signed (buy > 0 = user pays, sell < 0 = user receives); MM cash moves by +totalCost.

import {
  type BeliefModel,
  type BookEntry,
  type EngineConfig,
  type ReserveOpts,
  computeSpread,
  contractKey,
  requiredReserve,
  withMmShort,
} from '@bmm/core';
import type { ContractSpec } from '@bmm/core';
import { round8 } from '@bmm/shared';

export type Side = 'buy' | 'sell';

export function execPriceFor(side: Side, fair: number, spreadTotal: number): number {
  return side === 'buy' ? fair + spreadTotal : Math.max(0, fair - spreadTotal);
}

export interface PositionState {
  quantity: number;
  avgEntryPrice: number;
  realizedPnl: number;
}

// Apply a signed fill to a long-only position with average-entry accounting.
// Buy (q>0): blends avg entry. Sell (q<0): realizes PnL at avg entry, keeps avg
// for the remainder; a full close resets avg to 0. Callers must enforce
// sell-only-what-you-hold (q≥−quantity) upstream.
export function applyFill(pos: PositionState, q: number, execPrice: number): PositionState {
  if (q >= 0) {
    const newQty = round8(pos.quantity + q);
    const avg =
      newQty > 0 ? round8((pos.quantity * pos.avgEntryPrice + q * execPrice) / newQty) : 0;
    return { quantity: newQty, avgEntryPrice: avg, realizedPnl: pos.realizedPnl };
  }
  const sellQty = -q;
  const realized = round8(pos.realizedPnl + sellQty * (execPrice - pos.avgEntryPrice));
  const newQty = round8(pos.quantity - sellQty);
  return {
    quantity: newQty,
    avgEntryPrice: newQty > 0 ? pos.avgEntryPrice : 0,
    realizedPnl: realized,
  };
}

const EPS = 1e-6;

export interface FillSolveInput {
  spec: ContractSpec;
  side: Side;
  targetSize: number; // |q| desired, > 0
  mmShort: number; // MM's current short in this contract
  book: BookEntry[]; // full book (this contract included if it exists)
  belief: BeliefModel;
  cfg: EngineConfig;
  fair: number;
  cash: number; // MM cash before the trade
  balance: number; // trader balance (ignored if isInfinite)
  isInfinite: boolean;
  reserveOpts: ReserveOpts;
  openMargin: number; // circuit-breaker margin to OPEN new risk (e.g. 1.2)
}

export interface FillSolveResult {
  fillSize: number; // largest feasible |size| in [0, targetSize]
  reserveBefore: number;
}

// Solve the largest feasible fill size under two monotone constraints (both
// tighten as size grows, so a binary search is valid)
// 1. solvency gate: effectiveCash ≥ margin · reserve_after, where margin =
// openMargin when the trade raises the reserve (opening risk) and 1 when it
// lowers it. effectiveCash = cash + min(0, totalCost): a BUY's premium inflow
// is NOT counted as backing for the risk it creates (so a trade can't
// self-fund unbounded exposure via its own spread), while a SELL's payout
// outflow IS subtracted. Past accumulated cash backs risk; this trade's
// premium is profit, banked but not pledged.
// 2. buyer affordability: balance ≥ totalCost (buys only; sells credit the trader).
// Uses the pre-trade belief for sizing; the engine re-checks at the post-update
// belief before committing.
export function solveFill(input: FillSolveInput): FillSolveResult {
  const { spec, side, targetSize, mmShort, book, belief, cfg, fair, cash } = input;
  const key = contractKey(spec);
  const reserveBefore = requiredReserve(book, belief, input.reserveOpts);

  const feasible = (size: number): boolean => {
    if (size <= 0) return true;
    const signed = side === 'buy' ? size : -size;
    const spread = computeSpread(spec, signed, mmShort, belief, cfg);
    const execPrice = execPriceFor(side, fair, spread.total);
    const totalCost = execPrice * signed; // signed: buy > 0
    const effectiveCash = cash + Math.min(0, totalCost);
    const nextBook = withMmShort(book, spec, key, contractKey, mmShort + signed);
    const reserveAfter = requiredReserve(nextBook, belief, input.reserveOpts);
    const margin = reserveAfter > reserveBefore ? input.openMargin : 1;
    const solvent = effectiveCash + EPS >= margin * reserveAfter;
    const affordable = side === 'sell' || input.isInfinite || input.balance + EPS >= totalCost;
    return solvent && affordable;
  };

  if (feasible(targetSize)) return { fillSize: targetSize, reserveBefore };

  let lo = 0;
  let hi = targetSize;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (feasible(mid)) lo = mid;
    else hi = mid;
  }
  // Leave a hair of slack below the frontier so the engine's post-rounding gate
  // (which re-derives the reserve) doesn't reject what we just sized.
  return { fillSize: round8(lo * (1 - 1e-6)), reserveBefore };
}
