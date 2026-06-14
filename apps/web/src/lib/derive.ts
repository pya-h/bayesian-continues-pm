// Pure derivations for the Phase-10 surfaces — no React, no IO. Kept here (and
// unit-tested) so the portfolio roll-ups, LP preview math, and the create-market
// request assembly are verifiable without a DOM.

import type {
  CreateMarketInput,
  LpPool,
  MarketCfgInput,
  MarketView,
  PortfolioPosition,
} from './types.ts';

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
    // Payouts stay claimable on CLOSED too — archival doesn't revoke winnings.
    if (
      (p.marketStatus === 'SETTLED' || p.marketStatus === 'CLOSED') &&
      p.final &&
      !p.final.claimed
    )
      g.claimable = true;
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

export interface MixtureModeDraft {
  pi: number | '';
  mu: number | '';
  sigma: number | '';
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
  beliefKind?: 'gaussian' | 'mixture' | 'student_t';
  // Mixture modes (only used when beliefKind === 'mixture').
  components?: MixtureModeDraft[];
  // Degrees of freedom ν (only used when beliefKind === 'student_t'; >2).
  nu?: number | '';
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

  if (draft.beliefKind === 'mixture') {
    const modes = (draft.components ?? [])
      .filter((c) => c.pi !== '' && c.mu !== '' && c.sigma !== '')
      .map((c) => ({ pi: Number(c.pi), mu: Number(c.mu), sigma: Number(c.sigma) }));
    if (modes.length < 2) {
      throw new Error('A mixture belief needs at least 2 modes (weight, center, σ each).');
    }
    for (const m of modes) {
      if (!(m.pi > 0)) throw new Error('Each mixture mode weight must be positive.');
      if (!(m.sigma > 0)) throw new Error('Each mixture mode σ must be positive.');
      if (!Number.isFinite(m.mu)) throw new Error('Each mixture mode needs a finite center μ.');
    }
    body.belief = { kind: 'mixture', components: modes };
  } else if (draft.beliefKind === 'student_t') {
    const nu = Number(draft.nu);
    if (!(nu > 2)) throw new Error('Student-t ν (degrees of freedom) must be greater than 2.');
    body.belief = { kind: 'student_t', nu };
  }

  const cfg = cleanCfg(draft.cfg);
  if (cfg) body.cfg = cfg;
  return body;
}

// markets browser (filter + sort) ---

export type MarketSort = 'activity' | 'nav' | 'uncertainty' | 'consensus' | 'title';
export const MARKET_SORTS: { id: MarketSort; label: string }[] = [
  { id: 'activity', label: 'Newest' },
  { id: 'nav', label: 'Pool size' },
  { id: 'uncertainty', label: 'Most uncertain' },
  { id: 'consensus', label: 'Consensus' },
  { id: 'title', label: 'A–Z' },
];

export const MARKET_STATUS_FILTERS = [
  'ALL',
  'OPEN',
  'CREATED',
  'SUSPENDED',
  'RESOLVED',
  'SETTLED',
] as const;
export type MarketStatusFilter = (typeof MARKET_STATUS_FILTERS)[number];

// Filter a market list by a free-text query (title / description / unit) and a
// status bucket, then sort. Pure + stable: ties fall back to title so the grid
// doesn't reshuffle across refetches.
export function filterSortMarkets(
  markets: MarketView[],
  opts: { query?: string; status?: MarketStatusFilter; sort?: MarketSort },
): MarketView[] {
  const q = (opts.query ?? '').trim().toLowerCase();
  const status = opts.status ?? 'ALL';
  const sort = opts.sort ?? 'activity';

  const filtered = markets.filter((m) => {
    if (status !== 'ALL' && m.status !== status) return false;
    if (!q) return true;
    return (
      m.title.toLowerCase().includes(q) ||
      (m.description ?? '').toLowerCase().includes(q) ||
      m.outcomeUnit.toLowerCase().includes(q)
    );
  });

  const byTitle = (a: MarketView, b: MarketView) => a.title.localeCompare(b.title);
  const cmp: Record<MarketSort, (a: MarketView, b: MarketView) => number> = {
    activity: (a, b) => b.createdAt.localeCompare(a.createdAt) || byTitle(a, b),
    nav: (a, b) => b.pool.nav - a.pool.nav || byTitle(a, b),
    uncertainty: (a, b) => b.belief.sigma - a.belief.sigma || byTitle(a, b),
    consensus: (a, b) => b.belief.mu - a.belief.mu || byTitle(a, b),
    title: byTitle,
  };
  return [...filtered].sort(cmp[sort]);
}

export function statusCounts(markets: MarketView[]): Record<string, number> {
  const counts: Record<string, number> = { ALL: markets.length };
  for (const m of markets) counts[m.status] = (counts[m.status] ?? 0) + 1;
  return counts;
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
