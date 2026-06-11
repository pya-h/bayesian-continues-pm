import { describe, expect, test } from 'bun:test';
import {
  buildCreateMarketBody,
  cleanCfg,
  filterSortMarkets,
  groupPositionsByMarket,
  groupTotalPnl,
  lifecycleActions,
  lpDepositPreview,
  lpWithdrawPreview,
  statusCounts,
} from '../src/lib/derive.ts';
import type { CreateMarketDraft } from '../src/lib/derive.ts';
import type { LpPool, MarketView, PortfolioPosition } from '../src/lib/types.ts';

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

// A minimal PortfolioPosition factory — only the fields the roll-up reads matter.
function pos(over: Partial<PortfolioPosition>): PortfolioPosition {
  return {
    marketId: 'm1',
    marketTitle: 'Market One',
    marketStatus: 'OPEN',
    contractId: 'c1',
    contractKey: 'CALL:60',
    spec: { type: 'CALL', strike: 60 },
    quantity: 10,
    avgEntryPrice: 5,
    costBasis: 50,
    fair: 6,
    bid: 5.5,
    positionValue: 55,
    unrealizedPnl: 5,
    realizedPnl: 0,
    peakProfit: 8,
    drawdownFromPeak: 3,
    final: null,
    ...over,
  };
}

const POOL: LpPool = {
  cash: 12_000,
  reserveRequired: 4000,
  nav: 10_000,
  sharesTotal: 8000,
  sharePrice: 1.25,
};

describe('groupPositionsByMarket', () => {
  test('sums P&L fields per market and orders by title', () => {
    const groups = groupPositionsByMarket([
      pos({
        marketId: 'b',
        marketTitle: 'Beta',
        unrealizedPnl: 2,
        realizedPnl: 1,
        positionValue: 20,
      }),
      pos({
        marketId: 'a',
        marketTitle: 'Alpha',
        unrealizedPnl: 3,
        realizedPnl: 4,
        positionValue: 30,
      }),
      pos({
        marketId: 'a',
        marketTitle: 'Alpha',
        contractId: 'c2',
        unrealizedPnl: 1,
        realizedPnl: 2,
        positionValue: 10,
        costBasis: 8,
        peakProfit: 5,
        drawdownFromPeak: 1,
      }),
    ]);
    expect(groups.map((g) => g.marketTitle)).toEqual(['Alpha', 'Beta']);
    const alpha = groups[0];
    expect(alpha?.positions.length).toBe(2);
    expect(alpha?.unrealized).toBe(4);
    expect(alpha?.realized).toBe(6);
    expect(alpha?.value).toBe(40);
    expect(groupTotalPnl(alpha!)).toBe(10);
  });

  test('claimable only when SETTLED with an unclaimed final', () => {
    const settledUnclaimed = groupPositionsByMarket([
      pos({
        marketStatus: 'SETTLED',
        final: { thetaStar: 70, payout: 100, finalPnl: 50, claimed: false },
      }),
    ]);
    expect(settledUnclaimed[0]?.claimable).toBe(true);

    const settledClaimed = groupPositionsByMarket([
      pos({
        marketStatus: 'SETTLED',
        final: { thetaStar: 70, payout: 100, finalPnl: 50, claimed: true },
      }),
    ]);
    expect(settledClaimed[0]?.claimable).toBe(false);

    const resolvedNotSettled = groupPositionsByMarket([
      pos({
        marketStatus: 'RESOLVED',
        final: { thetaStar: 70, payout: 100, finalPnl: 50, claimed: false },
      }),
    ]);
    expect(resolvedNotSettled[0]?.claimable).toBe(false);
  });

  test('empty input yields no groups', () => {
    expect(groupPositionsByMarket([])).toEqual([]);
  });
});

describe('lpDepositPreview', () => {
  test('mints pro-rata at NAV_before: ΔS = D·S/NAV', () => {
    const { minted } = lpDepositPreview(1000, POOL); // 1000 * 8000 / 10000
    expect(close(minted, 800)).toBe(true);
  });
  test('genesis pool mints 1 share per unit', () => {
    const { minted, sharePctAfter } = lpDepositPreview(500, {
      cash: 0,
      reserveRequired: 0,
      nav: 0,
      sharesTotal: 0,
      sharePrice: 1,
    });
    expect(minted).toBe(500);
    expect(sharePctAfter).toBe(1);
  });
  test('ownership fraction reflects the mint', () => {
    const { sharePctAfter } = lpDepositPreview(1000, POOL); // 800 / (8000+800)
    expect(close(sharePctAfter, 800 / 8800)).toBe(true);
  });
  test('non-positive amount mints nothing', () => {
    expect(lpDepositPreview(0, POOL).minted).toBe(0);
    expect(lpDepositPreview(-5, POOL).minted).toBe(0);
  });
});

describe('lpWithdrawPreview', () => {
  test('cash out is pro-rata of NAV: ΔS/S·NAV', () => {
    const { cashOut, sharesAfter } = lpWithdrawPreview(2000, POOL, 4000); // 2000/8000 * 10000
    expect(close(cashOut, 2500)).toBe(true);
    expect(sharesAfter).toBe(2000);
  });
  test('clamps the burn to the shares actually held', () => {
    const { cashOut, sharesAfter } = lpWithdrawPreview(9999, POOL, 4000); // capped at 4000
    expect(close(cashOut, 5000)).toBe(true);
    expect(sharesAfter).toBe(0);
  });
});

describe('cleanCfg', () => {
  test('keeps finite numbers and booleans, drops blanks', () => {
    expect(cleanCfg({ s0: 0.02, gamma: '', lambda: undefined, useSimplifiedUpdate: true })).toEqual(
      {
        s0: 0.02,
        useSimplifiedUpdate: true,
      },
    );
  });
  test('drops NaN/Infinity', () => {
    expect(cleanCfg({ alpha: Number.NaN, beta: Number.POSITIVE_INFINITY })).toBeUndefined();
  });
  test('all-blank cfg is undefined', () => {
    expect(cleanCfg({ s0: '', gamma: null })).toBeUndefined();
  });
});

describe('buildCreateMarketBody', () => {
  const base: CreateMarketDraft = {
    title: '  Temp 2026  ',
    description: '   ',
    outcomeUnit: ' °C ',
    outcomeMin: '',
    outcomeMax: '',
    initialMu: 14,
    initialSigma: 3,
    initialReserve: 5000,
    cfg: {},
  };

  test('trims, drops blank optionals, omits empty cfg', () => {
    const body = buildCreateMarketBody(base);
    expect(body).toEqual({
      title: 'Temp 2026',
      outcomeUnit: '°C',
      initialMu: 14,
      initialSigma: 3,
      initialReserve: 5000,
    });
    expect('description' in body).toBe(false);
    expect('outcomeMin' in body).toBe(false);
    expect('cfg' in body).toBe(false);
  });

  test('includes bounds, description, and cleaned cfg when present', () => {
    const body = buildCreateMarketBody({
      ...base,
      description: 'Avg June temp',
      outcomeMin: 0,
      outcomeMax: 40,
      cfg: { reserveAlpha: 0.95, lambda: '' },
    });
    expect(body.description).toBe('Avg June temp');
    expect(body.outcomeMin).toBe(0);
    expect(body.outcomeMax).toBe(40);
    expect(body.cfg).toEqual({ reserveAlpha: 0.95 });
  });

  test('rejects an empty title', () => {
    expect(() => buildCreateMarketBody({ ...base, title: '   ' })).toThrow('Title is required');
  });
  test('rejects non-positive σ / R₀', () => {
    expect(() => buildCreateMarketBody({ ...base, initialSigma: 0 })).toThrow('σ must be positive');
    expect(() => buildCreateMarketBody({ ...base, initialReserve: -1 })).toThrow(
      'must be positive',
    );
  });
  test('rejects inverted outcome bounds', () => {
    expect(() => buildCreateMarketBody({ ...base, outcomeMin: 40, outcomeMax: 0 })).toThrow(
      'below outcome max',
    );
  });

  test('emits a mixture belief when beliefKind is mixture', () => {
    const body = buildCreateMarketBody({
      ...base,
      beliefKind: 'mixture',
      components: [
        { pi: 1, mu: 10, sigma: 2 },
        { pi: 2, mu: 18, sigma: 3 },
      ],
    });
    expect(body.belief).toEqual({
      kind: 'mixture',
      components: [
        { pi: 1, mu: 10, sigma: 2 },
        { pi: 2, mu: 18, sigma: 3 },
      ],
    });
  });

  test('drops blank mixture rows and requires ≥ 2 complete modes', () => {
    expect(() =>
      buildCreateMarketBody({
        ...base,
        beliefKind: 'mixture',
        components: [
          { pi: 1, mu: 10, sigma: 2 },
          { pi: '', mu: '', sigma: '' },
        ],
      }),
    ).toThrow('at least 2 modes');
  });

  test('rejects a non-positive mixture weight or σ', () => {
    expect(() =>
      buildCreateMarketBody({
        ...base,
        beliefKind: 'mixture',
        components: [
          { pi: 0, mu: 10, sigma: 2 },
          { pi: 1, mu: 18, sigma: 3 },
        ],
      }),
    ).toThrow('weight must be positive');
  });

  test('gaussian beliefKind emits no belief field', () => {
    const body = buildCreateMarketBody({ ...base, beliefKind: 'gaussian', components: [] });
    expect('belief' in body).toBe(false);
  });
});

describe('lifecycleActions', () => {
  test('CREATED can open or cancel', () => {
    expect(lifecycleActions('CREATED').map((a) => a.action)).toEqual(['open', 'cancel']);
  });
  test('OPEN can suspend/resolve/cancel (no close — server allows close only from SETTLED)', () => {
    expect(lifecycleActions('OPEN').map((a) => a.action)).toEqual(['suspend', 'resolve', 'cancel']);
  });
  test('SUSPENDED can resume/resolve/cancel', () => {
    expect(lifecycleActions('SUSPENDED').map((a) => a.action)).toEqual([
      'resume',
      'resolve',
      'cancel',
    ]);
  });
  test('RESOLVED can only settle', () => {
    expect(lifecycleActions('RESOLVED').map((a) => a.action)).toEqual(['settle']);
  });
  test('SETTLED can only close', () => {
    expect(lifecycleActions('SETTLED').map((a) => a.action)).toEqual(['close']);
  });
  test('terminal states have no actions', () => {
    expect(lifecycleActions('CANCELLED')).toEqual([]);
    expect(lifecycleActions('CLOSED')).toEqual([]);
  });
});

// A minimal MarketView factory — only fields the browser filter/sort reads.
function mkt(over: Partial<MarketView> & { marketId: string }): MarketView {
  return {
    title: over.marketId,
    description: null,
    outcomeUnit: 'USD',
    outcomeMin: null,
    outcomeMax: null,
    status: 'OPEN',
    creatorId: 'admin',
    belief: { kind: 'gaussian', mu: 100, sigma: 10, sigma2: 100 },
    cfg: {},
    cash: 0,
    reserveRequired: 0,
    pool: { nav: 1000, sharesTotal: 0, sharePrice: 1 },
    thetaStar: null,
    opensAt: null,
    closesAt: null,
    resolvesAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as MarketView;
}

describe('filterSortMarkets', () => {
  const markets: MarketView[] = [
    mkt({ marketId: 'a', title: 'BTC close', status: 'OPEN', createdAt: '2026-03-01T00:00:00Z' }),
    mkt({
      marketId: 'b',
      title: 'ETH gas',
      description: 'average gas price',
      status: 'SETTLED',
      createdAt: '2026-02-01T00:00:00Z',
      pool: { nav: 5000, sharesTotal: 0, sharePrice: 1 },
      belief: { kind: 'gaussian', mu: 30, sigma: 40, sigma2: 1600 },
    }),
    mkt({ marketId: 'c', title: 'June temp', status: 'OPEN', createdAt: '2026-01-15T00:00:00Z' }),
  ];

  test('text query matches title / description / unit', () => {
    expect(filterSortMarkets(markets, { query: 'gas' }).map((m) => m.marketId)).toEqual(['b']);
    expect(filterSortMarkets(markets, { query: 'temp' }).map((m) => m.marketId)).toEqual(['c']);
  });
  test('status filter narrows to the bucket', () => {
    expect(filterSortMarkets(markets, { status: 'SETTLED' }).map((m) => m.marketId)).toEqual(['b']);
    expect(filterSortMarkets(markets, { status: 'OPEN' }).length).toBe(2);
    expect(filterSortMarkets(markets, { status: 'ALL' }).length).toBe(3);
  });
  test('sort by newest, pool size, and uncertainty', () => {
    expect(filterSortMarkets(markets, { sort: 'activity' }).map((m) => m.marketId)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(filterSortMarkets(markets, { sort: 'nav' })[0]?.marketId).toBe('b');
    expect(filterSortMarkets(markets, { sort: 'uncertainty' })[0]?.marketId).toBe('b');
  });
  test('does not mutate the input array', () => {
    const before = markets.map((m) => m.marketId);
    filterSortMarkets(markets, { sort: 'title' });
    expect(markets.map((m) => m.marketId)).toEqual(before);
  });
});

describe('statusCounts', () => {
  test('counts ALL plus per-status buckets', () => {
    const c = statusCounts([
      mkt({ marketId: 'a', status: 'OPEN' }),
      mkt({ marketId: 'b', status: 'OPEN' }),
      mkt({ marketId: 'c', status: 'SETTLED' }),
    ]);
    expect(c.ALL).toBe(3);
    expect(c.OPEN).toBe(2);
    expect(c.SETTLED).toBe(1);
  });
});
