// Pure view helpers for the admin audit log — action labels, category grouping
// a concise human "detail" summary of each event's payload, and filter/sort over
// the event list. Kept IO-free so they're unit-tested and the panel stays
// declarative. The data comes from `GET /admin/audit`; these only shape it for
// the screen.

import { fmt } from './format.ts';
import type { AuditEvent } from './types.ts';

export type AuditSortKey = 'recent' | 'oldest';

export const AUDIT_SORTS: {
  key: AuditSortKey;
  label: string;
  cmp: (a: AuditEvent, b: AuditEvent) => number;
}[] = [
  { key: 'recent', label: 'Newest first', cmp: (a, b) => b.createdAt.localeCompare(a.createdAt) },
  { key: 'oldest', label: 'Oldest first', cmp: (a, b) => a.createdAt.localeCompare(b.createdAt) },
];

export type AuditCategory = 'all' | 'funding' | 'market' | 'trade';

export const AUDIT_CATEGORIES: { key: AuditCategory; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'funding', label: 'Funding' },
  { key: 'market', label: 'Markets' },
  { key: 'trade', label: 'Trades' },
];

export function auditCategory(action: string): AuditCategory {
  if (action === 'topup') return 'funding';
  if (action.startsWith('market_')) return 'market';
  if (action.startsWith('trade_')) return 'trade';
  return 'all';
}

const ACTION_LABEL: Record<string, string> = {
  topup: 'Top-up',
  market_create: 'Market created',
  market_open: 'Market opened',
  market_suspend: 'Market suspended',
  market_resume: 'Market resumed',
  market_resolve: 'Market resolved',
  market_cancel: 'Market cancelled',
  market_settle: 'Market settled',
  trade_execute: 'Trade',
  trade_sell_all: 'Sell-all',
};

export function auditLabel(action: string): string {
  return ACTION_LABEL[action] ?? action.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// A short, human-readable summary of an event's payload, chosen per action.
// Returns '' when there's nothing worth showing beyond the action label itself.
export function auditDetail(action: string, payload: Record<string, unknown> | null): string {
  if (!payload) return '';
  switch (action) {
    case 'topup': {
      const amt = num(payload.amount);
      return amt != null ? `+$${fmt(amt)}${payload.infinite ? ' · ∞ account' : ''}` : '';
    }
    case 'market_create':
      return typeof payload.title === 'string' ? `“${payload.title}”` : '';
    case 'market_resolve': {
      const t = num(payload.thetaStar);
      return t != null ? `θ* = ${fmt(t)}` : '';
    }
    case 'trade_execute': {
      const side = typeof payload.side === 'string' ? payload.side : '';
      const key = typeof payload.contractKey === 'string' ? payload.contractKey : '';
      const qty = num(payload.qty);
      return [side, key, qty != null ? `× ${fmt(qty)}` : ''].filter(Boolean).join(' ');
    }
    case 'trade_sell_all': {
      const count = num(payload.count);
      const proceeds = num(payload.totalProceeds);
      const parts: string[] = [];
      if (count != null) parts.push(`${count} position${count === 1 ? '' : 's'}`);
      if (proceeds != null) parts.push(`$${fmt(proceeds)}`);
      return parts.join(' · ');
    }
    default: {
      // Unknown action: show a compact key=value list of primitive payload fields.
      const bits = Object.entries(payload)
        .filter(([, v]) => v != null && typeof v !== 'object')
        .map(([k, v]) => `${k}=${typeof v === 'number' ? fmt(v) : String(v)}`);
      return bits.join(' · ');
    }
  }
}

export function filterAudit(
  events: AuditEvent[],
  opts: { category?: AuditCategory; query?: string },
): AuditEvent[] {
  const category = opts.category ?? 'all';
  const q = (opts.query ?? '').trim().toLowerCase();
  return events.filter((e) => {
    if (category !== 'all' && auditCategory(e.action) !== category) return false;
    if (!q) return true;
    return (
      (e.actor ?? '').toLowerCase().includes(q) ||
      (e.targetLabel ?? '').toLowerCase().includes(q) ||
      auditLabel(e.action).toLowerCase().includes(q)
    );
  });
}

export function sortAudit(events: AuditEvent[], key: AuditSortKey): AuditEvent[] {
  const cmp = AUDIT_SORTS.find((s) => s.key === key)?.cmp;
  return cmp ? [...events].sort(cmp) : events;
}
