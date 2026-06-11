import { describe, expect, test } from 'bun:test';
import {
  auditCategory,
  auditDetail,
  auditLabel,
  filterAudit,
  sortAudit,
} from '../src/lib/auditView.ts';
import type { AuditEvent } from '../src/lib/types.ts';

// Minimal event factory — only the fields the view helpers read matter.
function ev(over: Partial<AuditEvent>): AuditEvent {
  return {
    eventId: 'e1',
    actorId: 'u1',
    actor: 'admin',
    action: 'topup',
    targetId: 'u2',
    targetType: 'user',
    targetLabel: 'alice',
    payload: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

describe('auditCategory', () => {
  test('maps actions to buckets', () => {
    expect(auditCategory('topup')).toBe('funding');
    expect(auditCategory('market_create')).toBe('market');
    expect(auditCategory('market_resolve')).toBe('market');
    expect(auditCategory('trade_execute')).toBe('trade');
    expect(auditCategory('trade_sell_all')).toBe('trade');
    expect(auditCategory('something_else')).toBe('all'); // unknown
  });
});

describe('auditLabel', () => {
  test('known actions get friendly labels', () => {
    expect(auditLabel('topup')).toBe('Top-up');
    expect(auditLabel('market_create')).toBe('Market created');
    expect(auditLabel('market_resolve')).toBe('Market resolved');
    expect(auditLabel('trade_sell_all')).toBe('Sell-all');
  });

  test('unknown actions fall back to a prettified key', () => {
    expect(auditLabel('weird_new_action')).toBe('Weird new action');
  });
});

describe('auditDetail', () => {
  test('null payload yields empty string', () => {
    expect(auditDetail('topup', null)).toBe('');
  });

  test('topup shows the signed amount (+ infinite marker)', () => {
    expect(auditDetail('topup', { amount: 1000 })).toContain('+$');
    expect(auditDetail('topup', { amount: 1000 })).toContain('1,000');
    expect(auditDetail('topup', { amount: 5, infinite: true })).toContain('∞');
  });

  test('market_create shows the title; market_resolve shows θ*', () => {
    expect(auditDetail('market_create', { title: 'BTC EOY' })).toContain('BTC EOY');
    expect(auditDetail('market_resolve', { thetaStar: 64800 })).toContain('θ*');
  });

  test('trade actions summarise side/contract and counts', () => {
    expect(auditDetail('trade_execute', { side: 'buy', contractKey: 'CALL@100' })).toBe(
      'buy CALL@100',
    );
    const sa = auditDetail('trade_sell_all', { count: 2, totalProceeds: 300 });
    expect(sa).toContain('2 positions');
    expect(sa).toContain('$');
  });

  test('unknown action lists primitive payload fields', () => {
    const d = auditDetail('mystery', { foo: 'bar', n: 3, nested: { x: 1 } });
    expect(d).toContain('foo=bar');
    expect(d).toContain('n=3');
    expect(d).not.toContain('nested'); // objects skipped
  });
});

describe('filterAudit', () => {
  const events = [
    ev({ action: 'topup', actor: 'admin', targetLabel: 'alice' }),
    ev({ action: 'market_create', actor: 'admin', targetLabel: 'BTC market' }),
    ev({ action: 'trade_execute', actor: 'bob', targetLabel: 'BTC market' }),
    ev({ action: 'market_resolve', actor: 'admin', targetLabel: 'ETH market' }),
  ];

  test('category filter narrows to the bucket', () => {
    expect(filterAudit(events, { category: 'funding' })).toHaveLength(1);
    expect(filterAudit(events, { category: 'market' })).toHaveLength(2);
    expect(filterAudit(events, { category: 'trade' })).toHaveLength(1);
    expect(filterAudit(events, { category: 'all' })).toHaveLength(4);
  });

  test('text query matches actor, target label, or action label', () => {
    expect(filterAudit(events, { query: 'bob' })).toHaveLength(1); // actor
    expect(filterAudit(events, { query: 'BTC' })).toHaveLength(2); // target label
    expect(filterAudit(events, { query: 'resolved' })).toHaveLength(1); // action label
  });

  test('category + query compose', () => {
    expect(filterAudit(events, { category: 'market', query: 'BTC' })).toHaveLength(1);
    expect(filterAudit(events, { category: 'trade', query: 'alice' })).toHaveLength(0);
  });
});

describe('sortAudit', () => {
  const a = ev({ eventId: 'a', createdAt: '2026-06-01T00:00:00.000Z' });
  const b = ev({ eventId: 'b', createdAt: '2026-06-03T00:00:00.000Z' });
  const c = ev({ eventId: 'c', createdAt: '2026-06-02T00:00:00.000Z' });

  test('recent = newest first; oldest = reverse', () => {
    expect(sortAudit([a, b, c], 'recent').map((r) => r.eventId)).toEqual(['b', 'c', 'a']);
    expect(sortAudit([a, b, c], 'oldest').map((r) => r.eventId)).toEqual(['a', 'c', 'b']);
  });

  test('does not mutate the input', () => {
    const input = [a, b, c];
    sortAudit(input, 'oldest');
    expect(input.map((r) => r.eventId)).toEqual(['a', 'b', 'c']);
  });
});
