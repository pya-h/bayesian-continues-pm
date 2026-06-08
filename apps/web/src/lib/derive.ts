// Pure derivations for the Phase-10 surfaces — no React, no IO. Kept here (and
// unit-tested) so the portfolio roll-ups, LP preview math, and the create-market
// request assembly are verifiable without a DOM.

import type { CreateMarketInput, LpPool, MarketCfgInput, PortfolioPosition } from './types.ts';

export interface MarketGroup {
  marketId: string;
  marketTitle: string;
  marketStatus: PortfolioPosition['marketStatus'];
  positions: PortfolioPosition[];
  realized: number;
  unrealized: number;
  value: number;
  costBasis: number;
  peakProfit: number;
  drawdownFromPeak: number;
  claimable: boolean;
}

// Group a flat portfolio into one entry per market, summing the per-position
// P&L fields. Groups are returned most-recently-touched-ish, ordered by title
// so the list is stable across refetches.
export function groupPositionsByMarket(positions: PortfolioPosition[]): MarketGroup[] {
  const byId = new Map<string, MarketGroup>();
  for (const p of positions) {
    let g = byId.get(p.marketId);
    if (!g) {
      g = {
        marketId: p.marketId,
        marketTitle: p.marketTitle,
        marketStatus: p.marketStatus,
        positions: [],
        realized: 0,
        unrealized: 0,
        value: 0,
        costBasis: 0,
        peakProfit: 0,
        drawdownFromPeak: 0,
        claimable: false,
      };
      byId.set(p.marketId, g);
    }
    g.positions.push(p);
    g.realized += p.realizedPnl;
    g.unrealized += p.unrealizedPnl;
    g.value += p.positionValue;
    g.costBasis += p.costBasis;
    g.peakProfit += p.peakProfit;
    g.drawdownFromPeak += p.drawdownFromPeak;
    if (p.marketStatus === 'SETTLED' && p.final && !p.final.claimed) g.claimable = true;
  }
  return [...byId.values()].sort((a, b) => a.marketTitle.localeCompare(b.marketTitle));
}

export function groupTotalPnl(g: MarketGroup): number {
  return g.realized + g.unrealized;
}

// What a deposit of `amount` mints, mirroring `lpMath.sharesForDeposit`
// ΔS = D · S_total / NAV_before, with a genesis price of 1 when the pool is empty.
// Returns the minted shares and the resulting ownership fraction.
export function lpDepositPreview(
  amount: number,
  pool: LpPool,
): { minted: number; sharePctAfter: number } {
  if (!(amount > 0)) return { minted: 0, sharePctAfter: 0 };
  const minted =
    pool.sharesTotal > 0 && pool.nav > 0 ? (amount * pool.sharesTotal) / pool.nav : amount;
  const totalAfter = pool.sharesTotal + minted;
  return { minted, sharePctAfter: totalAfter > 0 ? minted / totalAfter : 0 };
}

// What burning `shares` returns, mirroring `lpMath.cashOutForShares`
// ΔS/S_total · NAV. This is the *gross* estimate; the server may PARTIAL-fill if
// the 1.2× reserve buffer would be breached, so callers should label it "est.".
export function lpWithdrawPreview(
  shares: number,
  pool: LpPool,
  yourShares: number,
): { cashOut: number; sharesAfter: number; pctAfter: number } {
  const burn = Math.max(0, Math.min(shares, yourShares));
  const cashOut = pool.sharesTotal > 0 ? (burn / pool.sharesTotal) * pool.nav : 0;
  const sharesAfter = yourShares - burn;
  const totalAfter = pool.sharesTotal - burn;
  return { cashOut, sharesAfter, pctAfter: totalAfter > 0 ? sharesAfter / totalAfter : 0 };
}

// Keep only finite numbers / booleans, dropping blanks; returns undefined if nothing survives.
export function cleanCfg(
  cfg: Record<string, number | boolean | '' | null | undefined>,
): MarketCfgInput | undefined {
  const out: Record<string, number | boolean> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? (out as MarketCfgInput) : undefined;
}

export interface CreateMarketDraft {
  title: string;
  description: string;
  outcomeUnit: string;
  outcomeMin: number | '';
  outcomeMax: number | '';
  initialMu: number;
  initialSigma: number;
  initialReserve: number;
  cfg: Record<string, number | boolean | '' | null | undefined>;
}

// Assemble the `POST /admin/markets` body from a form draft, dropping blank
// optionals (description, bounds, empty cfg). Throws a human message on the few
// things the form can't express away (so the page can surface it inline).
export function buildCreateMarketBody(draft: CreateMarketDraft): CreateMarketInput {
  const title = draft.title.trim();
  const outcomeUnit = draft.outcomeUnit.trim();
  if (!title) throw new Error('Title is required.');
  if (!outcomeUnit) throw new Error('Outcome unit is required (e.g. "USD", "°C", "%").');
  if (!(draft.initialSigma > 0)) throw new Error('Initial σ must be positive.');
  if (!(draft.initialReserve > 0)) throw new Error('Initial reserve R₀ must be positive.');
  if (
    draft.outcomeMin !== '' &&
    draft.outcomeMax !== '' &&
    Number(draft.outcomeMin) >= Number(draft.outcomeMax)
  ) {
    throw new Error('Outcome min must be below outcome max.');
  }

  const body: CreateMarketInput = {
    title,
    outcomeUnit,
    initialMu: draft.initialMu,
    initialSigma: draft.initialSigma,
    initialReserve: draft.initialReserve,
  };
  const description = draft.description.trim();
  if (description) body.description = description;
  if (draft.outcomeMin !== '') body.outcomeMin = Number(draft.outcomeMin);
  if (draft.outcomeMax !== '') body.outcomeMax = Number(draft.outcomeMax);
  const cfg = cleanCfg(draft.cfg);
  if (cfg) body.cfg = cfg;
  return body;
}

export function lifecycleActions(status: string): { action: string; label: string }[] {
  switch (status) {
    case 'CREATED':
      return [
        { action: 'open', label: 'Open' },
        { action: 'cancel', label: 'Cancel' },
      ];
    case 'OPEN':
      return [
        { action: 'suspend', label: 'Suspend' },
        { action: 'resolve', label: 'Resolve…' },
        { action: 'cancel', label: 'Cancel' },
      ];
    case 'SUSPENDED':
      return [
        { action: 'resume', label: 'Resume' },
        { action: 'resolve', label: 'Resolve…' },
        { action: 'cancel', label: 'Cancel' },
      ];
    case 'RESOLVED':
      return [{ action: 'settle', label: 'Settle' }];
    case 'SETTLED':
      return [{ action: 'close', label: 'Close' }];
    default:
      return [];
  }
}
