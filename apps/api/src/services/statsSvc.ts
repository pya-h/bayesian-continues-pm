// StatsSvc — the "proper statistics" surface.
// Every number is formula-backed and computed from the closed-form / sampled
// payout distribution under the current belief (never ad-hoc)
// • marketStats — volume, #trades/#traders, spread income, E_p[L], reserve +
// utilization, MM/pool PnL, belief drift, calibration.
// • marketHistory — belief (μ,σ) time series + optional per-contract fair-price
// series, for the charts.
// • portfolio — the caller's positions: cost basis, bid mark, unrealized /
// realized PnL, peak profit, drawdown, and final outcome/payout
// once resolved.
// • positionDetail — a single position's payout distribution (core.positionStats)
// plus the mark path's peak/drawdown over the belief history.
// Reads only — no locks, no mutations.

import {
  type BeliefModel,
  type ContractSpec,
  type EngineConfig,
  GaussianBelief,
  StudentTBelief,
  computeSpread,
  expectedLiability,
  payoff,
  positionStats,
  price,
} from '@bmm/core';
import { round8 } from '@bmm/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { marketRepo } from '../db/repos.ts';
import {
  beliefUpdates,
  claims,
  contracts,
  lpPositions,
  markets,
  positions,
  trades,
} from '../db/schema.ts';
import { loadBelief } from '../lib/belief.ts';
import { specFromRow } from '../lib/contract.ts';
import { HttpError } from '../lib/errors.ts';
import { loadBook } from './marketView.ts';

// Reconstruct the belief at a historical (μ, σ) point for price-history / mark-path
// charts. `belief_updates` stores only the summary μ/σ, so
// • gaussian — exact
// • student_t — exact too: ν is fixed for the market's life, and (ν, μ, σ) fully
// determine the state (scale² = σ²·(ν−2)/ν)
// • mixture — NOT reconstructible from μ/σ (components aren't stored historically)
// falls back to the same-moments Gaussian, flagged via `gaussianApprox` on the
// series so the client can label it.
function historicalBelief(
  beliefKind: string,
  liveBelief: BeliefModel,
  mu: number,
  sigma: number,
): BeliefModel {
  if (beliefKind === 'student_t') {
    const nu = (liveBelief as StudentTBelief).nu;
    return StudentTBelief.fromVariance(nu, mu, sigma * sigma);
  }
  return new GaussianBelief(mu, sigma * sigma);
}
import { aggregatePnl, ci80, inCi80, seriesStats } from './statsMath.ts';

const LINEAR: ContractSpec = { type: 'LINEAR' };

export interface MarketStats {
  marketId: string;
  status: string;
  belief: { mu: number; sigma: number; sigma2: number };
  // Consensus price of the underlying (LINEAR fair = μ).
  impliedPrice: number;
  volume: number; // Σ |totalCost| (notional traded)
  trades: number;
  traders: number;
  spreadIncome: number; // Σ spread · |q| collected by the MM
  expectedLiability: number; // E_p[L(θ)]
  cash: number;
  nav: number; // cash − E_p[L]
  reserveRequired: number;
  reserveUtil: number; // reserve / cash
  mmPnl: number; // pool value creation = NAV + Σ withdrawn − Σ deposited
  beliefDrift: number; // μ_current − μ_initial
  calibration: { thetaStar: number; ci80: { lo: number; hi: number }; inCi80: boolean } | null;
}

export async function marketStats(marketId: string): Promise<MarketStats> {
  const m = await marketRepo.byId(marketId);
  if (!m) throw new HttpError(404, 'Market not found');

  const belief = loadBelief(m);
  const book = await loadBook(marketId);
  const expLiab = round8(expectedLiability(book, belief));
  const nav = round8(m.cash - expLiab);

  const tradeRows = await db
    .select({
      userId: trades.userId,
      quantity: trades.quantity,
      totalCost: trades.totalCost,
      execPrice: trades.execPrice,
      fairPrice: trades.fairPrice,
    })
    .from(trades)
    .where(eq(trades.marketId, marketId));
  let volume = 0;
  let spreadIncome = 0;
  const traders = new Set<string>();
  for (const t of tradeRows) {
    volume += Math.abs(t.totalCost);
    // What the MM actually captured: |exec − fair|·|q|. Using the quoted
    // spreadTotal overstates income when a sell's bid was floored at 0
    // (exec = max(0, fair − spread) keeps less than the full spread).
    spreadIncome += Math.abs(t.execPrice - t.fairPrice) * Math.abs(t.quantity);
    traders.add(t.userId);
  }

  const lpRows = await db
    .select({
      totalDeposited: lpPositions.totalDeposited,
      totalWithdrawn: lpPositions.totalWithdrawn,
    })
    .from(lpPositions)
    .where(eq(lpPositions.marketId, marketId));
  let deposited = 0;
  let withdrawn = 0;
  for (const l of lpRows) {
    deposited += l.totalDeposited;
    withdrawn += l.totalWithdrawn;
  }
  const mmPnl = round8(nav + withdrawn - deposited);

  const reserveUtil = m.cash > 0 ? round8(m.reserveRequired / m.cash) : 0;
  const beliefDrift = round8(m.currentMu - m.initialMu);
  const calibration =
    m.thetaStar != null
      ? {
          thetaStar: m.thetaStar,
          ci80: ci80(m.currentMu, m.currentSigma),
          inCi80: inCi80(m.currentMu, m.currentSigma, m.thetaStar),
        }
      : null;

  return {
    marketId,
    status: m.status,
    belief: { mu: m.currentMu, sigma: m.currentSigma, sigma2: round8(belief.variance()) },
    impliedPrice: round8(price(LINEAR, belief)),
    volume: round8(volume),
    trades: tradeRows.length,
    traders: traders.size,
    spreadIncome: round8(spreadIncome),
    expectedLiability: expLiab,
    cash: m.cash,
    nav,
    reserveRequired: m.reserveRequired,
    reserveUtil,
    mmPnl,
    beliefDrift,
    calibration,
  };
}

export interface BeliefPoint {
  t: Date;
  mu: number;
  sigma: number;
}
export interface MarketHistory {
  marketId: string;
  beliefHistory: BeliefPoint[];
  priceHistory: {
    contractKey: string;
    points: { t: Date; fair: number }[];
    gaussianApprox: boolean;
  } | null;
}

// Belief (μ,σ) time series + optional fair-price series for one contract.
export async function marketHistory(
  marketId: string,
  contractKey?: string,
): Promise<MarketHistory> {
  const m = await marketRepo.byId(marketId);
  if (!m) throw new HttpError(404, 'Market not found');

  const updates = await db
    .select({
      createdAt: beliefUpdates.createdAt,
      mu: beliefUpdates.newMu,
      sigma: beliefUpdates.newSigma,
    })
    .from(beliefUpdates)
    .where(eq(beliefUpdates.marketId, marketId))
    .orderBy(asc(beliefUpdates.createdAt));

  const beliefHistory: BeliefPoint[] = [
    { t: m.createdAt, mu: m.initialMu, sigma: m.initialSigma },
    ...updates.map((u) => ({ t: u.createdAt, mu: u.mu, sigma: u.sigma })),
  ];

  let priceHistory: MarketHistory['priceHistory'] = null;
  if (contractKey) {
    const crows = await db
      .select()
      .from(contracts)
      .where(and(eq(contracts.marketId, marketId), eq(contracts.contractKey, contractKey)))
      .limit(1);
    if (crows[0]) {
      const spec = specFromRow(crows[0].type, crows[0].params);
      const liveBelief = loadBelief(m);
      priceHistory = {
        contractKey,
        points: beliefHistory.map((p) => ({
          t: p.t,
          fair: round8(price(spec, historicalBelief(m.beliefKind, liveBelief, p.mu, p.sigma))),
        })),
        gaussianApprox: m.beliefKind === 'mixture',
      };
    }
  }

  return { marketId, beliefHistory, priceHistory };
}

export interface PortfolioPosition {
  marketId: string;
  marketTitle: string;
  marketStatus: string;
  contractId: string;
  contractKey: string;
  spec: ContractSpec;
  quantity: number;
  avgEntryPrice: number;
  costBasis: number; // quantity · avgEntryPrice
  fair: number; // mid mark per unit
  bid: number; // exit price per unit (fair − close spread, floored at 0)
  positionValue: number; // quantity · bid (mark at exit)
  unrealizedPnl: number; // positionValue − costBasis
  realizedPnl: number;
  peakProfit: number; // stored running-max unrealized
  drawdownFromPeak: number; // peakProfit − current unrealized (≥ 0)
  openedAt: string; // ISO — when the position was first opened
  lastTradedAt: string; // ISO — last fill against this position (sort key)
  final: { thetaStar: number; payout: number; finalPnl: number; claimed: boolean } | null;
}

export interface Portfolio {
  userId: string;
  positions: PortfolioPosition[];
  totals: { realized: number; unrealized: number; total: number; marketValue: number };
}

export async function portfolio(userId: string): Promise<Portfolio> {
  const rows = await db
    .select({
      quantity: positions.quantity,
      avgEntryPrice: positions.avgEntryPrice,
      realizedPnl: positions.realizedPnl,
      peakUnrealized: positions.peakUnrealized,
      positionId: positions.positionId,
      contractId: contracts.contractId,
      contractKey: contracts.contractKey,
      type: contracts.type,
      params: contracts.params,
      mmShort: contracts.mmShort,
      marketId: markets.marketId,
      marketTitle: markets.title,
      marketStatus: markets.status,
      currentMu: markets.currentMu,
      currentSigma: markets.currentSigma,
      beliefState: markets.beliefState,
      cfg: markets.cfg,
      thetaStar: markets.thetaStar,
      openedAt: positions.createdAt,
      lastTradedAt: positions.updatedAt,
    })
    .from(positions)
    .innerJoin(contracts, eq(positions.contractId, contracts.contractId))
    .innerJoin(markets, eq(positions.marketId, markets.marketId))
    .where(eq(positions.userId, userId))
    // Default order: most recently traded first (updatedAt bumps on every fill).
    // The client can re-sort; this is just a stable, meaningful baseline.
    .orderBy(desc(positions.updatedAt));

  // Which of this user's positions have already been claimed (settled markets)?
  const claimRows = await db
    .select({ positionId: claims.positionId, claimedAt: claims.claimedAt })
    .from(claims)
    .where(eq(claims.userId, userId));
  const claimedByPosition = new Map(claimRows.map((c) => [c.positionId, c.claimedAt !== null]));

  const items: PortfolioPosition[] = [];
  for (const r of rows) {
    const spec = specFromRow(r.type, r.params);
    const belief = loadBelief(r);
    const cfg = r.cfg as unknown as EngineConfig;
    const fair = price(spec, belief);
    // Exit mark (bid): the price the trader would close into right now.
    const closeSpread =
      r.quantity > 0 ? computeSpread(spec, -r.quantity, r.mmShort, belief, cfg).total : 0;
    const bid = Math.max(0, fair - closeSpread);
    const costBasis = round8(r.quantity * r.avgEntryPrice);
    const positionValue = round8(r.quantity * bid);
    const unrealizedPnl = round8(positionValue - costBasis);

    let final: PortfolioPosition['final'] = null;
    if (r.thetaStar != null) {
      const payout = round8(r.quantity * payoff(spec, r.thetaStar));
      final = {
        thetaStar: r.thetaStar,
        payout,
        finalPnl: round8(payout - costBasis + r.realizedPnl),
        claimed: claimedByPosition.get(r.positionId) ?? false,
      };
    }

    items.push({
      marketId: r.marketId,
      marketTitle: r.marketTitle,
      marketStatus: r.marketStatus,
      contractId: r.contractId,
      contractKey: r.contractKey,
      spec,
      quantity: r.quantity,
      avgEntryPrice: r.avgEntryPrice,
      costBasis,
      fair: round8(fair),
      bid: round8(bid),
      positionValue,
      unrealizedPnl,
      realizedPnl: r.realizedPnl,
      peakProfit: r.peakUnrealized,
      drawdownFromPeak: round8(Math.max(0, r.peakUnrealized - unrealizedPnl)),
      openedAt: r.openedAt.toISOString(),
      lastTradedAt: r.lastTradedAt.toISOString(),
      final,
    });
  }

  const agg = aggregatePnl(
    items.map((i) => ({ realized: i.realizedPnl, unrealized: i.unrealizedPnl })),
  );
  const marketValue = round8(items.reduce((s, i) => s + i.positionValue, 0));
  return { userId, positions: items, totals: { ...agg, marketValue } };
}

export interface PositionDetail {
  marketId: string;
  marketStatus: string;
  contractId: string;
  contractKey: string;
  spec: ContractSpec;
  quantity: number;
  avgEntryPrice: number;
  costBasis: number;
  realizedPnl: number;
  stats: ReturnType<typeof positionStats>;
  markPath: { points: number[]; peak: number; maxDrawdown: number; last: number };
  storedPeakUnrealized: number;
  final: { thetaStar: number; payout: number; finalPnl: number } | null;
}

export async function positionDetail(userId: string, contractId: string): Promise<PositionDetail> {
  const prows = await db
    .select()
    .from(positions)
    .where(and(eq(positions.userId, userId), eq(positions.contractId, contractId)))
    .limit(1);
  const p = prows[0];
  if (!p) throw new HttpError(404, 'Position not found');

  const crows = await db
    .select()
    .from(contracts)
    .where(eq(contracts.contractId, contractId))
    .limit(1);
  const c = crows[0];
  if (!c) throw new HttpError(404, 'Contract not found');
  const m = await marketRepo.byId(c.marketId);
  if (!m) throw new HttpError(404, 'Market not found');

  const spec = specFromRow(c.type, c.params);
  const belief = loadBelief(m);
  const costBasis = round8(p.quantity * p.avgEntryPrice);
  const stats = positionStats({ spec, quantity: p.quantity, costBasis }, belief);

  // Reconstruct the mark path: unrealized PnL at the CURRENT size across the
  // belief history (q·fair_t − costBasis), then summarize peak/drawdown.
  const updates = await db
    .select({ mu: beliefUpdates.newMu, sigma: beliefUpdates.newSigma })
    .from(beliefUpdates)
    .where(eq(beliefUpdates.marketId, c.marketId))
    .orderBy(asc(beliefUpdates.createdAt));
  const markPoints = updates.map((u) =>
    round8(
      p.quantity * price(spec, historicalBelief(m.beliefKind, belief, u.mu, u.sigma)) - costBasis,
    ),
  );
  const ss = seriesStats(markPoints);

  let final: PositionDetail['final'] = null;
  if (m.thetaStar != null) {
    const payout = round8(p.quantity * payoff(spec, m.thetaStar));
    final = {
      thetaStar: m.thetaStar,
      payout,
      finalPnl: round8(payout - costBasis + p.realizedPnl),
    };
  }

  return {
    marketId: c.marketId,
    marketStatus: m.status,
    contractId,
    contractKey: c.contractKey,
    spec,
    quantity: p.quantity,
    avgEntryPrice: p.avgEntryPrice,
    costBasis,
    realizedPnl: p.realizedPnl,
    stats,
    markPath: { points: markPoints, peak: ss.peak, maxDrawdown: ss.maxDrawdown, last: ss.last },
    storedPeakUnrealized: p.peakUnrealized,
    final,
  };
}
