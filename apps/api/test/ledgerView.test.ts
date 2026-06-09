import { describe, expect, test } from 'bun:test';
import { TransactionKind } from '@bmm/shared';
import { summarizeTransactions } from '../src/services/ledgerView.ts';

const K = TransactionKind;

describe('summarizeTransactions', () => {
  test('empty → all zero', () => {
    const s = summarizeTransactions([]);
    expect(s.count).toBe(0);
    expect(s.net).toBe(0);
    expect(s.funded).toBe(0);
    expect(s.claimed).toBe(0);
  });

  test('categorises each kind and reports magnitudes', () => {
    const rows = [
      { kind: K.ADMIN_CREDIT, amount: 1000 }, // funded +1000
      { kind: K.TRADE_BUY, amount: -120 }, // buy magnitude 120
      { kind: K.TRADE_SELL, amount: 40 }, // proceeds 40
      { kind: K.LP_DEPOSIT, amount: -500 }, // lpDeposited 500
      { kind: K.MARKET_CREATE, amount: -10000 }, // lpDeposited += 10000 (genesis)
      { kind: K.LP_WITHDRAW, amount: 300 }, // lpWithdrawn 300
      { kind: K.LP_CLAIM, amount: 250 }, // claimed += 250
      { kind: K.CLAIM, amount: 600 }, // claimed += 600
      { kind: K.REFUND, amount: 80 }, // refunded 80
    ];
    const s = summarizeTransactions(rows);
    expect(s.count).toBe(9);
    expect(s.funded).toBe(1000);
    expect(s.tradeBuy).toBe(120);
    expect(s.tradeSell).toBe(40);
    expect(s.lpDeposited).toBe(10500); // 500 + 10000 genesis
    expect(s.lpWithdrawn).toBe(300);
    expect(s.claimed).toBe(850); // 250 + 600
    expect(s.refunded).toBe(80);
    // net = sum of all signed amounts
    expect(s.net).toBeCloseTo(1000 - 120 + 40 - 500 - 10000 + 300 + 250 + 600 + 80, 8);
  });

  test('admin_grant counts toward net but no category', () => {
    const s = summarizeTransactions([{ kind: K.ADMIN_GRANT, amount: -1234 }]);
    expect(s.net).toBe(-1234);
    expect(s.funded).toBe(0);
    expect(s.claimed).toBe(0);
  });
});
