// AuditLogView — the admin-only audit-trail viewer. Fetches the append-only
// `audit_events` log (admin top-ups, market lifecycle, trades) and shows a
// filterable / sortable table: each row is an action chip (category-coloured
// rail), who did it, what it targeted, a concise payload detail, and when.
// Read-only. View choices (category + sort) persist across reloads.

import { type ReactNode, useMemo, useState } from 'react';
import { useAdminAudit } from '../hooks/queries.ts';
import { ApiError } from '../lib/api.ts';
import {
  AUDIT_CATEGORIES,
  AUDIT_SORTS,
  type AuditCategory,
  type AuditSortKey,
  auditCategory,
  auditDetail,
  auditLabel,
  filterAudit,
  sortAudit,
} from '../lib/auditView.ts';
import { timeAgo } from '../lib/format.ts';
import type { AuditEvent } from '../lib/types.ts';
import { oneOf, usePersistentState } from '../lib/usePersistentState.ts';
import { ErrorNote, Modal, Panel, Spinner } from './ui.tsx';

export function AuditLogView() {
  const audit = useAdminAudit();

  const [category, setCategory] = usePersistentState<AuditCategory>(
    'admin.audit.category',
    'all',
    oneOf(
      AUDIT_CATEGORIES.map((c) => c.key),
      'all',
    ),
  );
  const [sort, setSort] = usePersistentState<AuditSortKey>(
    'admin.audit.sort',
    'recent',
    oneOf(
      AUDIT_SORTS.map((s) => s.key),
      'recent',
    ),
  );
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<AuditEvent | null>(null);

  const events = useMemo(() => audit.data ?? [], [audit.data]);
  const visible = useMemo(
    () => sortAudit(filterAudit(events, { category, query }), sort),
    [events, category, query, sort],
  );

  return (
    <>
      <Panel title="Audit log" right={<span className="text-xs text-muted">{events.length}</span>}>
        <div className="flex flex-col gap-3 p-4">
          <p className="text-xs text-muted">
            Every recorded admin action, market lifecycle change, and trade — newest first.
          </p>
          {audit.isLoading ? (
            <Spinner label="Loading audit log…" />
          ) : audit.error ? (
            <ErrorNote>
              {audit.error instanceof ApiError
                ? audit.error.message
                : 'Failed to load the audit log.'}
            </ErrorNote>
          ) : (
            <div className="flex flex-col gap-3">
              {/* filters */}
              {events.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1">
                    {AUDIT_CATEGORIES.map((c) => (
                      <Chip
                        key={c.key}
                        active={category === c.key}
                        onClick={() => setCategory(c.key)}
                      >
                        {c.label}
                      </Chip>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search actor / target…"
                      className="w-44 rounded-lg border border-edge bg-panel px-2.5 py-1 text-xs text-fg placeholder:text-muted outline-none transition-colors focus:border-accent"
                    />
                    <select
                      value={sort}
                      onChange={(e) => setSort(e.target.value as AuditSortKey)}
                      className="rounded-lg border border-edge bg-panel px-2 py-1 text-xs text-fg outline-none transition-colors focus:border-accent"
                    >
                      {AUDIT_SORTS.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {/* table */}
              {events.length === 0 ? (
                <div className="rounded-lg border border-dashed border-edge p-6 text-center text-xs text-muted">
                  No audit events recorded yet.
                </div>
              ) : visible.length === 0 ? (
                <div className="rounded-lg border border-dashed border-edge p-5 text-center text-xs text-muted">
                  No events match this filter.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-edge surface-2">
                  <table className="w-full text-xs tnum">
                    <thead className="border-b border-edge text-muted">
                      <tr className="text-left">
                        <th className="px-3 py-2 font-medium">Action</th>
                        <th className="px-2 py-2 font-medium">Actor</th>
                        <th className="px-2 py-2 font-medium">Target</th>
                        <th className="px-2 py-2 font-medium">Detail</th>
                        <th className="px-3 py-2 text-right font-medium">When</th>
                        <th className="px-2 py-2">
                          <span className="sr-only">Details</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((e, i) => (
                        <Row key={e.eventId} e={e} index={i} onOpen={() => setSelected(e)} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </Panel>
      {selected && <AuditEventModal e={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

type CatMeta = { rail: string; chip: string };
const CAT_FALLBACK: CatMeta = { rail: 'bg-edge', chip: 'border-edge bg-panel-2 text-muted' };
const CAT_META: Record<string, CatMeta> = {
  funding: { rail: 'bg-accent', chip: 'border-accent/40 bg-accent-soft text-accent' },
  market: { rail: 'bg-buy', chip: 'border-buy/40 bg-buy/10 text-buy' },
  trade: { rail: 'bg-muted/60', chip: 'border-edge bg-panel-2 text-fg' },
};

function Row({ e, index, onOpen }: { e: AuditEvent; index: number; onOpen: () => void }) {
  const meta = CAT_META[auditCategory(e.action)] ?? CAT_FALLBACK;
  const detail = auditDetail(e.action, e.payload);
  return (
    <tr
      style={{ animationDelay: `${Math.min(index, 14) * 18}ms` }}
      className="animate-fade-up border-t border-edge/60 transition-colors hover:bg-panel-2/40"
    >
      <td className="py-1.5 pr-2 pl-0">
        <div className="flex items-center">
          <span
            className={`mr-2.5 h-6 w-0.5 shrink-0 rounded-full ${meta.rail}`}
            aria-hidden="true"
          />
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.chip}`}
          >
            {auditLabel(e.action)}
          </span>
        </div>
      </td>
      <td className="px-2 py-1.5 text-muted">{e.actor ?? '—'}</td>
      <td className="px-2 py-1.5">
        {e.targetLabel ? (
          <span className="inline-flex items-center gap-1.5">
            {e.targetType && (
              <span className="rounded bg-panel-2 px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                {e.targetType}
              </span>
            )}
            <span className="text-fg">{e.targetLabel}</span>
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="px-2 py-1.5 text-muted">{detail || '—'}</td>
      <td
        className="whitespace-nowrap px-3 py-1.5 text-right text-muted"
        title={new Date(e.createdAt).toLocaleString()}
      >
        {timeAgo(e.createdAt)}
      </td>
      <td className="px-2 py-1.5 text-right">
        <button
          type="button"
          onClick={onOpen}
          aria-label="View full event"
          title="View full event"
          className="rounded-md px-1.5 py-0.5 text-muted transition-colors hover:bg-panel-2 hover:text-fg"
        >
          ⋯
        </button>
      </td>
    </tr>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
        active
          ? 'bg-grad-accent text-[var(--color-on-accent)] btn-glow-accent border-transparent'
          : 'border-edge bg-panel-2 text-muted hover:text-fg hover:border-accent/40'
      }`}
    >
      {children}
    </button>
  );
}

function AuditEventModal({ e, onClose }: { e: AuditEvent; onClose: () => void }) {
  const meta = CAT_META[auditCategory(e.action)] ?? CAT_FALLBACK;
  const payloadJson =
    e.payload && Object.keys(e.payload).length > 0 ? JSON.stringify(e.payload, null, 2) : null;
  return (
    <Modal
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.chip}`}
          >
            {auditLabel(e.action)}
          </span>
          <span className="text-muted">audit event</span>
        </span>
      }
    >
      <div className="flex flex-col gap-4 p-5 text-sm">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <Field label="Action">
            <code className="text-fg">{e.action}</code>
          </Field>
          <Field label="When">
            {new Date(e.createdAt).toLocaleString()}
            <div className="font-mono text-[11px] text-muted">{e.createdAt}</div>
          </Field>
          <Field label="Actor">
            {e.actor ?? <span className="text-muted">— (unknown / system)</span>}
            {e.actorId && <div className="font-mono text-[11px] text-muted">{e.actorId}</div>}
          </Field>
          <Field label="Target">
            {e.targetLabel ? (
              <span className="inline-flex items-center gap-1.5">
                {e.targetType && (
                  <span className="rounded bg-panel-2 px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                    {e.targetType}
                  </span>
                )}
                <span className="text-fg">{e.targetLabel}</span>
              </span>
            ) : (
              <span className="text-muted">—</span>
            )}
            {e.targetId && <div className="font-mono text-[11px] text-muted">{e.targetId}</div>}
          </Field>
          <Field label="Event ID">
            <span className="font-mono text-[11px] text-muted">{e.eventId}</span>
          </Field>
        </dl>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Payload</span>
          {payloadJson ? (
            <pre className="surface-2 overflow-x-auto rounded-lg border border-edge bg-panel-2 p-3 font-mono text-[12px] leading-relaxed text-fg">
              {payloadJson}
            </pre>
          ) : (
            <div className="rounded-lg border border-dashed border-edge p-3 text-center text-xs text-muted">
              No payload recorded for this event.
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="tnum text-fg">{children}</dd>
    </div>
  );
}
