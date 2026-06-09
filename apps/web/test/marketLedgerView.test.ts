import { describe, expect, test } from 'bun:test';
import {
  filterMarketLedger,
  mlCategory,
  mlLabel,
  sortMarketLedger,
} from '../src/lib/marketLedgerView.ts';
import type { MarketLedgerEvent } from '../src/lib/types.ts';

// Minimal event factory — only the fields the view helpers read matter.
function ev(over: Partial<MarketLedgerEvent>): MarketLedgerEvent {
  return {
    at: '2026-06-01T00:00:00.000Z',
    kind: 'trade_buy',
    delta: 10,
    affectsCash: true,
    cashAfter: 100,
    userId: 'u1',
    username: 'alice',
    ref: { type: 'trade', id: 't1' },
    ...over,
  };
}

describe('mlCategory + mlLabel', () => {
  test('maps kinds to buckets', () => {
    expect(mlCategory('genesis')).toBe('liquidity');
    expect(mlCategory('lp_deposit')).toBe('liquidity');
    expect(mlCategory('lp_withdraw')).toBe('liquidity');
    expect(mlCategory('trade_buy')).toBe('trades');
    expect(mlCategory('trade_sell')).toBe('trades');
    expect(mlCategory('trader_payout')).toBe('settlement');
    expect(mlCategory('lp_claim')).toBe('settlement');
    expect(mlCategory('refund')).toBe('settlement');
    expect(mlCategory('???')).toBe('all'); // unknown
  });

  test('labels are human-friendly with a fallback', () => {
    expect(mlLabel('genesis')).toBe('Genesis reserve');
    expect(mlLabel('trade_sell')).toBe('Trade sell');
    expect(mlLabel('trader_payout')).toBe('Trader payout');
    expect(mlLabel('mystery')).toBe('mystery');
  });
});

describe('filterMarketLedger', () => {
  const events = [
    ev({ kind: 'genesis', username: 'admin' }),
    ev({ kind: 'trade_buy', username: 'alice' }),
    ev({ kind: 'lp_deposit', username: 'bob' }),
    ev({ kind: 'trader_payout', username: 'alice' }),
  ];

  test('category filter narrows to the bucket', () => {
    expect(filterMarketLedger(events, { category: 'liquidity' })).toHaveLength(2);
    expect(filterMarketLedger(events, { category: 'trades' })).toHaveLength(1);
    expect(filterMarketLedger(events, { category: 'settlement' })).toHaveLength(1);
    expect(filterMarketLedger(events, { category: 'all' })).toHaveLength(4);
  });

  test('text query matches username or kind label', () => {
    expect(filterMarketLedger(events, { query: 'alice' })).toHaveLength(2); // username
    expect(filterMarketLedger(events, { query: 'genesis' })).toHaveLength(1); // kind label
    expect(filterMarketLedger(events, { query: 'payout' })).toHaveLength(1); // kind label
  });

  test('category + query compose', () => {
    expect(filterMarketLedger(events, { category: 'settlement', query: 'alice' })).toHaveLength(1);
    expect(filterMarketLedger(events, { category: 'trades', query: 'bob' })).toHaveLength(0);
  });
});

describe('sortMarketLedger', () => {
  const a = ev({ delta: -5, at: '2026-06-01T00:00:00.000Z' });
  const b = ev({ delta: 50, at: '2026-06-03T00:00:00.000Z' });
  const c = ev({ delta: -20, at: '2026-06-02T00:00:00.000Z' });

  test('recent = newest first; oldest = reverse', () => {
    expect(sortMarketLedger([a, b, c], 'recent').map((r) => r.at)).toEqual([b.at, c.at, a.at]);
    expect(sortMarketLedger([a, b, c], 'oldest').map((r) => r.at)).toEqual([a.at, c.at, b.at]);
  });

  test('amount sorts by magnitude', () => {
    expect(sortMarketLedger([a, b, c], 'amount').map((r) => Math.abs(r.delta))).toEqual([
      50, 20, 5,
    ]);
    expect(sortMarketLedger([a, b, c], 'amountAsc').map((r) => Math.abs(r.delta))).toEqual([
      5, 20, 50,
    ]);
  });

  test('does not mutate the input', () => {
    const input = [a, b, c];
    sortMarketLedger(input, 'amount');
    expect(input.map((r) => r.delta)).toEqual([-5, 50, -20]);
  });
});
