// Prospective-trade analytics — the "know your trade" numbers shown live in the
// quote panel as the user tweaks side / size / contract. Pure, IO-free, and unit
// tested. P&L of the order at settlement is
// pnl(θ) = signedQ · payoff(spec, θ) − totalCost
// (totalCost is what the user pays: positive on a buy, negative — a premium
// received — on a sell), so the same formula covers longs and shorts.

import { type BeliefModel, payoff, payoffBounds } from '@bmm/core';
import type { ContractSpec } from './types.ts';
import { type Interval, probInRegions } from './viz.ts';

// Realized result of a *closing sell* — selling contracts the user already holds.
// Unlike the probabilistic max-profit/max-loss framing, a close is deterministic
// you receive `proceeds` now and lock in profit against what you originally paid.
export interface CloseStats {
  qClosed: number;
  proceeds: number;
  costBasis: number;
  realizedProfit: number;
  returnPct: number | null;
}

// Profit/loss locked in by selling `qty` of a holding of `heldQty` bought at
// `avgEntryPrice`, for total `proceeds` received. Only the portion that closes an
// existing long counts; any excess (opening a short) is ignored here.
export function sellCloseStats(args: {
  proceeds: number;
  qty: number;
  heldQty: number;
  avgEntryPrice: number;
}): CloseStats {
  const { proceeds, qty, heldQty, avgEntryPrice } = args;
  const qClosed = Math.max(0, Math.min(qty, heldQty));
  const proceedsClosed = qty > 0 ? proceeds * (qClosed / qty) : 0;
  const costBasis = avgEntryPrice * qClosed;
  const realizedProfit = proceedsClosed - costBasis;
  const returnPct = costBasis > 1e-9 ? realizedProfit / costBasis : null;
  return { qClosed, proceeds: proceedsClosed, costBasis, realizedProfit, returnPct };
}

export interface TradeStats {
  quantity: number;
  // Most the contracts could ever pay a holder: q · max per-unit payoff (∞ if unbounded).
  contractMaxPayout: number;
  // Best-case net P&L of the order (∞ if unbounded upside).
  maxProfit: number;
  // Worst-case loss as a positive number (∞ if unbounded downside).
  maxLoss: number;
  expectedPnl: number;
  pProfit: number;
  // Outcome(s) θ at which the order breaks even.
  breakevens: number[];
  // maxProfit / maxLoss when both are finite and positive, else null.
  riskReward: number | null;
}

// Per-unit payoff range over the achievable outcomes. Bounded contracts
// (binary / spread / bell) are [0, 1]; for the monotone CALL/PUT/LINEAR we
// evaluate the payoff at the outcome bounds (±∞ when the market is unbounded on
// that side), which is exact because each is monotone in θ.
export function payoffRange(
  spec: ContractSpec,
  outcomeMin?: number | null,
  outcomeMax?: number | null,
): { min: number; max: number } {
  const pb = payoffBounds(spec);
  if (pb.bounded && pb.min != null && pb.max != null) return { min: pb.min, max: pb.max };
  const lo = outcomeMin ?? Number.NEGATIVE_INFINITY;
  const hi = outcomeMax ?? Number.POSITIVE_INFINITY;
  const a = payoff(spec, lo);
  const b = payoff(spec, hi);
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

export function tradeStats(args: {
  spec: ContractSpec;
  signedQ: number;
  totalCost: number;
  fair: number;
  mu: number;
  sigma: number;
  outcomeMin?: number | null;
  outcomeMax?: number | null;
  // The market's real belief model. When provided, the win chance integrates the
  // actual shape (mixture modes / Student-t tails) via its CDF; without it the
  // computation falls back to a same-moments Gaussian — wrong on non-Gaussian
  // markets (same μ/σ, very different mass placement).
  belief?: BeliefModel;
}): TradeStats {
  const { spec, signedQ, totalCost, fair, mu, sigma, outcomeMin, outcomeMax, belief } = args;
  const q = Math.abs(signedQ);
  const { min: pMin, max: pMax } = payoffRange(spec, outcomeMin, outcomeMax);

  // P&L is linear in the per-unit payoff with slope signedQ, so its extremes sit
  // at the payoff extremes.
  const pnlAtMax = signedQ * pMax - totalCost;
  const pnlAtMin = signedQ * pMin - totalCost;
  const maxProfit = Math.max(pnlAtMax, pnlAtMin);
  const worstPnl = Math.min(pnlAtMax, pnlAtMin);
  const maxLoss = worstPnl < 0 ? -worstPnl : 0;

  const expectedPnl = signedQ * fair - totalCost;
  const contractMaxPayout = q * pMax;

  // Profit regions + breakevens over ~10σ of belief mass (or the bounded range).
  const sd = sigma > 0 ? sigma : 1;
  const lo = outcomeMin ?? mu - 10 * sd;
  const hi = outcomeMax ?? mu + 10 * sd;
  const pnl = (x: number) => signedQ * payoff(spec, x) - totalCost;

  const n = 480;
  const regions: Interval[] = [];
  const breakevens: number[] = [];
  let inProfit = false;
  let regStart = lo;
  let prevX = lo;
  let prevY = pnl(lo);
  if (prevY > 0) {
    inProfit = true;
    regStart = lo;
  }
  for (let i = 1; i <= n; i++) {
    const x = lo + ((hi - lo) * i) / n;
    const y = pnl(x);
    const crossed = (prevY <= 0 && y > 0) || (prevY > 0 && y <= 0);
    if (crossed) {
      const t = prevY === y ? 0 : prevY / (prevY - y);
      const xc = prevX + t * (x - prevX);
      breakevens.push(xc);
      if (!inProfit) {
        regStart = xc;
        inProfit = true;
      } else {
        regions.push([regStart, xc]);
        inProfit = false;
      }
    }
    prevX = x;
    prevY = y;
  }
  if (inProfit) regions.push([regStart, hi]);

  let pProfit: number;
  if (belief) {
    // Real-shape mass. Regions touching the scan edges on an unbounded market are
    // extended to ±∞ so fat tails (Student-t) aren't clipped at the 10σ window —
    // cdf(±∞) is exact for every belief kind.
    let p = 0;
    for (const [a, b] of regions) {
      const aEff = a === lo && outcomeMin == null ? Number.NEGATIVE_INFINITY : a;
      const bEff = b === hi && outcomeMax == null ? Number.POSITIVE_INFINITY : b;
      p += belief.cdf(bEff) - belief.cdf(aEff);
    }
    pProfit = Math.min(1, Math.max(0, p));
  } else {
    pProfit = probInRegions(mu, sd, regions);
  }
  const riskReward =
    Number.isFinite(maxProfit) && Number.isFinite(maxLoss) && maxLoss > 0
      ? maxProfit / maxLoss
      : null;

  return {
    quantity: q,
    contractMaxPayout,
    maxProfit,
    maxLoss,
    expectedPnl,
    pProfit,
    breakevens,
    riskReward,
  };
}
