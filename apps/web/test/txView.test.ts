import { describe, expect, test } from 'bun:test';
import { filterTransactions, sortTransactions, txCategory, txLabel } from '../src/lib/txView.ts';
import type { Transaction } from '../src/lib/types.ts';

// Minimal Transaction factory — only the fields the view helpers read matter.
function tx(over: Partial<Transaction>): Transaction {
  return {
    txId: Math.random().toString(36).slice(2),
    kind: 'trade_buy',
    amount: -10,
    balanceAfter: 100,
    marketId: 'm1',
    marketTitle: 'Temp 2026',
    counterpartyId: null,
    counterparty: null,
    refType: 'trade',
    refId: 't1',
    metadata: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

describe('txCategory + txLabel', () => {
  test('maps kinds to buckets', () => {
    expect(txCategory('trade_buy')).toBe('trades');
    expect(txCategory('trade_sell')).toBe('trades');
    expect(txCategory('lp_deposit')).toBe('liquidity');
    expect(txCategory('market_create')).toBe('liquidity');
    expect(txCategory('claim')).toBe('settlement');
    expect(txCategory('refund')).toBe('settlement');
    expect(txCategory('admin_credit')).toBe('funding');
    expect(txCategory('admin_grant')).toBe('funding');
    expect(txCategory('???')).toBe('all'); // unknown
  });

  test('labels are human-friendly with a fallback', () => {
    expect(txLabel('trade_buy')).toBe('Buy');
    expect(txLabel('lp_withdraw')).toBe('LP withdraw');
    expect(txLabel('admin_credit')).toBe('Funded');
    expect(txLabel('mystery')).toBe('mystery');
  });
});

describe('filterTransactions', () => {
  const rows = [
    tx({ kind: 'trade_buy', marketTitle: 'BTC price' }),
    tx({ kind: 'lp_deposit', marketTitle: 'ETH price' }),
    tx({ kind: 'admin_credit', marketTitle: null, counterparty: 'admin' }),
    tx({ kind: 'claim', marketTitle: 'BTC price' }),
  ];

  test('category filter narrows to the bucket', () => {
    expect(filterTransactions(rows, { category: 'trades' })).toHaveLength(1);
    expect(filterTransactions(rows, { category: 'liquidity' })).toHaveLength(1);
    expect(filterTransactions(rows, { category: 'all' })).toHaveLength(4);
  });

  test('text query matches market, counterparty, or kind label', () => {
    expect(filterTransactions(rows, { query: 'btc' })).toHaveLength(2);
    expect(filterTransactions(rows, { query: 'admin' })).toHaveLength(1); // counterparty
    expect(filterTransactions(rows, { query: 'buy' })).toHaveLength(1); // kind label
  });

  test('category + query compose', () => {
    expect(filterTransactions(rows, { category: 'settlement', query: 'btc' })).toHaveLength(1);
    expect(filterTransactions(rows, { category: 'trades', query: 'eth' })).toHaveLength(0);
  });
});

describe('sortTransactions', () => {
  const a = tx({ amount: -5, createdAt: '2026-06-01T00:00:00.000Z' });
  const b = tx({ amount: 50, createdAt: '2026-06-03T00:00:00.000Z' });
  const c = tx({ amount: -20, createdAt: '2026-06-02T00:00:00.000Z' });

  test('recent = newest first; oldest = reverse', () => {
    expect(sortTransactions([a, b, c], 'recent').map((r) => r.createdAt)).toEqual([
      b.createdAt,
      c.createdAt,
      a.createdAt,
    ]);
    expect(sortTransactions([a, b, c], 'oldest').map((r) => r.createdAt)).toEqual([
      a.createdAt,
      c.createdAt,
      b.createdAt,
    ]);
  });

  test('amount sorts by magnitude', () => {
    expect(sortTransactions([a, b, c], 'amount').map((r) => Math.abs(r.amount))).toEqual([
      50, 20, 5,
    ]);
    expect(sortTransactions([a, b, c], 'amountAsc').map((r) => Math.abs(r.amount))).toEqual([
      5, 20, 50,
    ]);
  });

  test('does not mutate the input', () => {
    const input = [a, b, c];
    sortTransactions(input, 'amount');
    expect(input.map((r) => r.amount)).toEqual([-5, 50, -20]);
  });
});
