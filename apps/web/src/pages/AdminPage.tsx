// Admin panel, organised tab by tab (TASKS / MH-2)
// • Markets — your markets' lifecycle, per-market overview, and the admin-only
// cash-flow ledger drill-in (the market pool's bank statement)
// • Users — list + top-up + each user's full transaction history
// • Create — the full market creation form (config + R₀)
// • System — circuit-breaker alerts and a system overview.
// Routed behind RequireAdmin. The active tab persists across reloads.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.tsx';
import { AlertsBanner } from '../components/AlertsBanner.tsx';
import { AuditLogView } from '../components/AuditLogView.tsx';
import { MarketLedgerView } from '../components/MarketLedgerView.tsx';
import { Button, ErrorNote, Panel, Spinner, Stat, StatusBadge } from '../components/ui.tsx';
import {
  qk,
  useAdminOverview,
  useAdminUserTransactions,
  useAdminUsers,
  useMarkets,
} from '../hooks/queries.ts';
import { ApiError, api } from '../lib/api.ts';
import { type CreateMarketDraft, buildCreateMarketBody, lifecycleActions } from '../lib/derive.ts';
import { fmt, fmtCompact, fmtPct, fmtSigned, timeAgo } from '../lib/format.ts';
import { txLabel } from '../lib/txView.ts';
import type { AdminUser, MarketView } from '../lib/types.ts';
import { oneOf, usePersistentState } from '../lib/usePersistentState.ts';

type AdminTab = 'markets' | 'users' | 'create' | 'system' | 'audit';
const TABS: { key: AdminTab; label: string }[] = [
  { key: 'markets', label: 'Markets' },
  { key: 'users', label: 'Users' },
  { key: 'create', label: 'Create market' },
  { key: 'system', label: 'System' },
  { key: 'audit', label: 'Audit' },
];

export function AdminPage() {
  const { user } = useAuth();
  const [tab, setTab] = usePersistentState<AdminTab>(
    'admin.tab',
    'markets',
    oneOf(
      TABS.map((t) => t.key),
      'markets',
    ),
  );

  return (
    <div className="flex flex-col gap-5">
      {/* hero header + tab bar */}
      <div className="hero-glow surface gradient-border relative flex flex-col gap-3 overflow-hidden rounded-2xl border border-edge bg-panel p-5">
        <div className="relative flex items-baseline gap-2">
          <h1 className="text-gradient text-2xl font-semibold tracking-tight">Admin</h1>
          <span className="text-sm text-muted">control room</span>
        </div>
        <nav className="relative flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t.key
                  ? 'bg-grad-accent text-[var(--color-on-accent)] btn-glow-accent'
                  : 'text-muted hover:text-fg hover:bg-panel-2/70'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      <div key={tab} className="animate-fade-up">
        {tab === 'markets' && <MyMarkets creatorId={user?.userId ?? ''} />}
        {tab === 'users' && <UsersSection />}
        {tab === 'create' && <CreateMarketForm />}
        {tab === 'system' && <SystemSection />}
        {tab === 'audit' && <AuditLogView />}
      </div>
    </div>
  );
}

// create market ---

const EMPTY_DRAFT: CreateMarketDraft = {
  title: '',
  description: '',
  outcomeUnit: '',
  outcomeMin: '',
  outcomeMax: '',
  initialMu: 0,
  initialSigma: 1,
  initialReserve: 10_000,
  beliefKind: 'gaussian',
  components: [],
  cfg: {},
};

function CreateMarketForm() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<CreateMarketDraft>(EMPTY_DRAFT);
  const [showCfg, setShowCfg] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.adminCreateMarket(buildCreateMarketBody(draft)).then((r) => r.market),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.markets });
      setDraft(EMPTY_DRAFT);
      setShowCfg(false);
    },
  });

  const set = <K extends keyof CreateMarketDraft>(k: K, v: CreateMarketDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const setCfg = (k: string, v: number | '') =>
    setDraft((d) => ({ ...d, cfg: { ...d.cfg, [k]: v } }));

  // mixture-mode editor helpers ---
  const setKind = (kind: 'gaussian' | 'mixture') =>
    setDraft((d) => ({
      ...d,
      beliefKind: kind,
      // Seed two modes straddling μ on first switch to mixture, so the chart is
      // visibly bimodal out of the box.
      components:
        kind === 'mixture' && (d.components?.length ?? 0) < 2
          ? [
              { pi: 1, mu: d.initialMu - d.initialSigma, sigma: d.initialSigma },
              { pi: 1, mu: d.initialMu + d.initialSigma, sigma: d.initialSigma },
            ]
          : (d.components ?? []),
    }));
  const setMode = (i: number, k: 'pi' | 'mu' | 'sigma', v: number | '') =>
    setDraft((d) => {
      const comps = [...(d.components ?? [])];
      comps[i] = { ...(comps[i] ?? { pi: '', mu: '', sigma: '' }), [k]: v };
      return { ...d, components: comps };
    });
  const addMode = () =>
    setDraft((d) => ({
      ...d,
      components: [...(d.components ?? []), { pi: 1, mu: d.initialMu, sigma: d.initialSigma }],
    }));
  const removeMode = (i: number) =>
    setDraft((d) => ({ ...d, components: (d.components ?? []).filter((_, j) => j !== i) }));

  const submit = () => {
    setFormError(null);
    try {
      buildCreateMarketBody(draft); // validate early for a friendly message
      create.mutate();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Invalid form.');
    }
  };

  return (
    <Panel title="Create market">
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Title" className="sm:col-span-2 lg:col-span-3">
          <Text
            value={draft.title}
            onChange={(v) => set('title', v)}
            placeholder="e.g. June avg temp"
          />
        </Field>
        <Field label="Description" className="sm:col-span-2 lg:col-span-3">
          <Text
            value={draft.description}
            onChange={(v) => set('description', v)}
            placeholder="Optional"
          />
        </Field>
        <Field label="Outcome unit">
          <Text
            value={draft.outcomeUnit}
            onChange={(v) => set('outcomeUnit', v)}
            placeholder="°C / USD / %"
          />
        </Field>
        <Field label="Outcome min (optional)">
          <Num value={draft.outcomeMin} onChange={(v) => set('outcomeMin', v)} />
        </Field>
        <Field label="Outcome max (optional)">
          <Num value={draft.outcomeMax} onChange={(v) => set('outcomeMax', v)} />
        </Field>
        <Field label="Initial μ (prior mean)">
          <Num value={draft.initialMu} onChange={(v) => set('initialMu', v === '' ? 0 : v)} />
        </Field>
        <Field label="Initial σ (prior std)">
          <Num value={draft.initialSigma} onChange={(v) => set('initialSigma', v === '' ? 0 : v)} />
        </Field>
        <Field label="Initial reserve R₀">
          <Num
            value={draft.initialReserve}
            onChange={(v) => set('initialReserve', v === '' ? 0 : v)}
          />
        </Field>
      </div>

      {/* Belief kind: Gaussian (default) or a multi-modal mixture (V2-1). */}
      <div className="border-t border-edge px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs text-muted">Belief shape</span>
          <div className="flex overflow-hidden rounded-lg border border-edge">
            {(['gaussian', 'mixture'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`px-3 py-1 text-xs ${
                  (draft.beliefKind ?? 'gaussian') === k
                    ? 'bg-accent text-ink'
                    : 'bg-panel-2 text-muted hover:text-fg'
                }`}
              >
                {k === 'gaussian' ? 'Gaussian' : 'Mixture (multi-modal)'}
              </button>
            ))}
          </div>
        </div>
        {draft.beliefKind === 'mixture' && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted">
              Each mode is a Gaussian bump (weight π, center μ, spread σ). Weights are normalized
              automatically; you need at least 2 modes.
            </p>
            {(draft.components ?? []).map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: transient form rows, no stable id
              <div key={`mode-${i}`} className="flex items-end gap-2">
                <Field label={`π${i + 1}`} className="w-20">
                  <Num value={c.pi} onChange={(v) => setMode(i, 'pi', v)} />
                </Field>
                <Field label="center μ" className="flex-1">
                  <Num value={c.mu} onChange={(v) => setMode(i, 'mu', v)} />
                </Field>
                <Field label="σ" className="w-24">
                  <Num value={c.sigma} onChange={(v) => setMode(i, 'sigma', v)} />
                </Field>
                <button
                  type="button"
                  onClick={() => removeMode(i)}
                  disabled={(draft.components?.length ?? 0) <= 2}
                  className="mb-1 rounded-md border border-edge px-2 py-1 text-xs text-muted hover:text-sell disabled:opacity-40"
                  title="Remove mode"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addMode}
              className="self-start rounded-md border border-edge px-3 py-1 text-xs text-muted hover:text-fg"
            >
              + Add mode
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-edge px-4 py-2">
        <button
          type="button"
          onClick={() => setShowCfg((s) => !s)}
          className="text-xs text-muted hover:text-fg"
        >
          {showCfg ? '▾' : '▸'} Advanced engine config (optional — sensible defaults apply)
        </button>
        {showCfg && (
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {CFG_FIELDS.map((f) => (
              <Field key={f.key} label={f.label}>
                <Num
                  value={(draft.cfg[f.key] as number | '') ?? ''}
                  onChange={(v) => setCfg(f.key, v)}
                  placeholder={f.hint}
                />
              </Field>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-edge px-4 py-3">
        <Button variant="primary" disabled={create.isPending} onClick={submit}>
          {create.isPending ? 'Creating…' : 'Create market'}
        </Button>
        {create.isSuccess && <span className="text-xs text-buy">Created (status CREATED).</span>}
        {(formError || create.isError) && (
          <span className="text-xs text-sell">
            {formError ??
              (create.error instanceof ApiError ? create.error.message : 'Create failed.')}
          </span>
        )}
      </div>
    </Panel>
  );
}

const CFG_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: 'reserveAlpha', label: 'reserveAlpha', hint: '0.99' },
  { key: 's0', label: 's0 (base spread)', hint: '0.01' },
  { key: 'gamma', label: 'gamma (inventory)', hint: '0.0005' },
  { key: 'lambda', label: 'lambda (adv-sel)', hint: '0.5' },
  { key: 'eta', label: 'eta (vol)', hint: '0.05' },
  { key: 'qMax', label: 'qMax', hint: '500' },
  { key: 'qThreshold', label: 'qThreshold', hint: '10' },
  { key: 'lr', label: 'lr (belief)', hint: '0.01' },
];

// markets tab ---

function MyMarkets({ creatorId }: { creatorId: string }) {
  const markets = useMarkets();
  const mine = useMemo(
    () => (markets.data ?? []).filter((m) => m.creatorId === creatorId),
    [markets.data, creatorId],
  );

  if (markets.isLoading) return <Spinner label="Loading markets…" />;

  return (
    <Panel title="Your markets" right={<span className="text-xs text-muted">{mine.length}</span>}>
      {mine.length === 0 ? (
        <p className="p-4 text-sm text-muted">You haven't created any markets yet.</p>
      ) : (
        <div className="divide-y divide-edge">
          {mine.map((m) => (
            <MarketRow key={m.marketId} market={m} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function MarketRow({ market: m }: { market: MarketView }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'overview' | 'ledger'>('overview');
  const [resolving, setResolving] = useState(false);
  const [theta, setTheta] = useState('');

  const lifecycle = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: unknown }) =>
      api.adminLifecycle(m.marketId, action, body).then((r) => r.market),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.markets });
      qc.invalidateQueries({ queryKey: qk.market(m.marketId) });
      qc.invalidateQueries({ queryKey: qk.adminOverview(m.marketId) });
      qc.invalidateQueries({ queryKey: qk.adminLedger(m.marketId) });
      setResolving(false);
      setTheta('');
    },
  });

  const actions = lifecycleActions(m.status);

  return (
    <div className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 text-left"
        >
          <span className="text-muted">{open ? '▾' : '▸'}</span>
          <span className="font-semibold">{m.title}</span>
          <StatusBadge status={m.status} />
          {m.thetaStar != null && (
            <span className="tnum text-xs text-muted">θ*={fmt(m.thetaStar, 0)}</span>
          )}
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/markets/${m.marketId}`} className="text-xs text-accent hover:underline">
            view
          </Link>
          {actions.map((a) =>
            a.action === 'resolve' ? (
              <Button
                key={a.action}
                variant="ghost"
                className="px-2.5 py-1 text-xs"
                disabled={lifecycle.isPending}
                onClick={() => setResolving((r) => !r)}
              >
                {a.label}
              </Button>
            ) : (
              <Button
                key={a.action}
                variant={a.action === 'cancel' ? 'sell' : 'ghost'}
                className="px-2.5 py-1 text-xs"
                disabled={lifecycle.isPending}
                onClick={() => lifecycle.mutate({ action: a.action })}
              >
                {a.label}
              </Button>
            ),
          )}
        </div>
      </div>

      {resolving && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number"
            inputMode="decimal"
            value={theta}
            placeholder={`Outcome θ* (${m.outcomeUnit})`}
            onChange={(e) => setTheta(e.target.value)}
            className="input-glow tnum w-48 rounded-lg border border-edge bg-panel-2 px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
          <Button
            variant="primary"
            className="px-3 py-1.5 text-xs"
            disabled={theta === '' || !Number.isFinite(Number(theta)) || lifecycle.isPending}
            onClick={() =>
              lifecycle.mutate({ action: 'resolve', body: { thetaStar: Number(theta) } })
            }
          >
            Confirm resolve
          </Button>
        </div>
      )}
      {lifecycle.isError && (
        <p className="mt-1 text-xs text-sell">
          {lifecycle.error instanceof ApiError ? lifecycle.error.message : 'Action failed.'}
        </p>
      )}

      {open && (
        <div className="mt-3">
          <div className="flex items-center gap-1">
            <SubTab active={view === 'overview'} onClick={() => setView('overview')}>
              Overview
            </SubTab>
            <SubTab active={view === 'ledger'} onClick={() => setView('ledger')}>
              Cash-flow ledger
            </SubTab>
          </div>
          {view === 'overview' ? (
            <Overview marketId={m.marketId} />
          ) : (
            <MarketLedgerView marketId={m.marketId} />
          )}
        </div>
      )}
    </div>
  );
}

function SubTab({
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
      className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
        active ? 'bg-grad-accent text-[var(--color-on-accent)]' : 'text-muted hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}

function Overview({ marketId }: { marketId: string }) {
  const o = useAdminOverview(marketId);
  if (o.isLoading)
    return (
      <div className="mt-3">
        <Spinner label="Loading overview…" />
      </div>
    );
  if (o.error || !o.data) return <p className="mt-3 text-xs text-sell">Failed to load overview.</p>;
  const d = o.data;
  return (
    <div className="surface-2 mt-3 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-edge bg-panel-2 p-3 sm:grid-cols-3 lg:grid-cols-4">
      <Stat
        label="Volume"
        value={fmtCompact(d.volume)}
        sub={`${d.trades} trades · ${d.traders} traders`}
      />
      <Stat label="Spread income" value={fmt(d.spreadIncome)} tone="buy" />
      <Stat
        label="Creator / MM PnL"
        value={fmtSigned(d.mmPnl)}
        tone={d.mmPnl >= 0 ? 'buy' : 'sell'}
      />
      <Stat label="Pool NAV" value={fmt(d.nav)} />
      <Stat label="E[liability]" value={fmt(d.expectedLiability)} />
      <Stat label="Reserve" value={fmt(d.reserveRequired)} sub={`util ${fmtPct(d.reserveUtil)}`} />
      <Stat label="Belief drift" value={fmtSigned(d.beliefDrift)} />
      <Stat
        label="Calibration"
        value={d.calibration ? (d.calibration.inCi80 ? 'in 80% CI ✓' : 'outside 80% CI') : '—'}
        sub={
          d.calibration
            ? `θ*=${fmt(d.calibration.thetaStar, 0)} ∈ [${fmt(d.calibration.ci80.lo, 0)}, ${fmt(d.calibration.ci80.hi, 0)}]`
            : 'unresolved'
        }
      />
    </div>
  );
}

// users tab ---

function UsersSection() {
  const users = useAdminUsers();
  if (users.isLoading) return <Spinner label="Loading users…" />;
  if (users.error)
    return (
      <ErrorNote>
        {users.error instanceof ApiError ? users.error.message : 'Failed to load users.'}
      </ErrorNote>
    );
  return (
    <Panel
      title="Users"
      right={<span className="text-xs text-muted">{users.data?.length ?? 0}</span>}
    >
      <div className="divide-y divide-edge">
        {(users.data ?? []).map((u) => (
          <UserRow key={u.userId} user={u} />
        ))}
      </div>
    </Panel>
  );
}

function UserRow({ user: u }: { user: AdminUser }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [open, setOpen] = useState(false);
  const topup = useMutation({
    mutationFn: (amt: number) => api.adminTopup(u.userId, amt).then((r) => r.user),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.adminUsers });
      qc.invalidateQueries({ queryKey: qk.adminUserTx(u.userId) });
      setAmount('');
    },
  });
  const n = Number(amount);
  const valid = amount !== '' && Number.isFinite(n) && n > 0;

  return (
    <div className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={() => setOpen((o) => !o)} className="text-left">
          <span className="mr-1.5 text-muted">{open ? '▾' : '▸'}</span>
          <span className="font-semibold">{u.username}</span>
          <span className="ml-2 rounded bg-panel-2 px-1.5 py-0.5 text-xs text-muted">{u.role}</span>
          <div className="tnum pl-5 text-xs text-muted">
            {u.isInfinite ? '∞ balance' : `$${fmt(u.balance)}`}
          </div>
        </button>
        {!u.isInfinite && (
          <div className="flex items-center gap-2">
            <input
              type="number"
              inputMode="decimal"
              min={0}
              value={amount}
              placeholder="Top-up"
              onChange={(e) => setAmount(e.target.value)}
              className="input-glow tnum w-28 rounded-lg border border-edge bg-panel-2 px-3 py-1.5 text-sm outline-none focus:border-accent"
            />
            <Button
              variant="ghost"
              className="px-3 py-1.5 text-xs"
              disabled={!valid || topup.isPending}
              onClick={() => topup.mutate(n)}
            >
              {topup.isPending ? '…' : 'Top up'}
            </Button>
            {topup.isError && (
              <span className="text-xs text-sell">
                {topup.error instanceof ApiError ? topup.error.message : 'Failed.'}
              </span>
            )}
          </div>
        )}
      </div>

      {open && <UserTransactions userId={u.userId} />}
    </div>
  );
}

// A user's transaction history, fetched on demand (admin-only).
function UserTransactions({ userId }: { userId: string }) {
  const tx = useAdminUserTransactions(userId);
  if (tx.isLoading)
    return (
      <div className="mt-3">
        <Spinner label="Loading history…" />
      </div>
    );
  if (tx.error || !tx.data)
    return <p className="mt-3 text-xs text-sell">Failed to load this user's history.</p>;

  const { transactions, summary } = tx.data;
  if (transactions.length === 0)
    return <p className="mt-3 text-xs text-muted">No transactions yet.</p>;

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="surface-2 grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-edge bg-panel-2 p-3 sm:grid-cols-4">
        <Stat label="Funded in" value={fmt(summary.funded)} tone="buy" />
        <Stat label="Claimed out" value={fmt(summary.claimed)} tone="accent" />
        <Stat label="Trade volume" value={fmt(summary.tradeBuy + summary.tradeSell)} />
        <Stat
          label="Net flow"
          value={fmtSigned(summary.net)}
          tone={summary.net >= 0 ? 'buy' : 'sell'}
          sub={`${summary.count} record${summary.count === 1 ? '' : 's'}`}
        />
      </div>
      <div className="surface-2 max-h-72 overflow-y-auto rounded-lg border border-edge">
        <table className="w-full text-xs tnum">
          <thead className="sticky top-0 border-b border-edge bg-panel text-muted">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-2 py-2 font-medium">Detail</th>
              <th className="px-2 py-2 text-right font-medium">Amount</th>
              <th className="px-3 py-2 text-right font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((t) => (
              <tr key={t.txId} className="border-t border-edge/60">
                <td className="px-3 py-1.5">{txLabel(t.kind)}</td>
                <td className="px-2 py-1.5 text-muted">{t.marketTitle ?? t.counterparty ?? '—'}</td>
                <td
                  className={`px-2 py-1.5 text-right font-semibold ${t.amount >= 0 ? 'text-buy' : 'text-sell'}`}
                >
                  {fmtSigned(t.amount)}
                </td>
                <td
                  className="whitespace-nowrap px-3 py-1.5 text-right text-muted"
                  title={new Date(t.createdAt).toLocaleString()}
                >
                  {timeAgo(t.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// system tab ---

function SystemSection() {
  const markets = useMarkets();
  const users = useAdminUsers();

  const byStatus = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of markets.data ?? []) map.set(m.status, (map.get(m.status) ?? 0) + 1);
    return map;
  }, [markets.data]);

  const totalPool = useMemo(
    () => (markets.data ?? []).reduce((s, m) => s + (m.pool?.nav ?? 0), 0),
    [markets.data],
  );

  return (
    <div className="flex flex-col gap-5">
      <AlertsBanner />
      <Panel title="System overview">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 p-4 sm:grid-cols-3 lg:grid-cols-4">
          <Stat label="Markets" value={markets.data?.length ?? 0} />
          <Stat label="Users" value={users.data?.length ?? 0} />
          <Stat label="Open" value={byStatus.get('OPEN') ?? 0} tone="buy" />
          <Stat label="Resolved" value={byStatus.get('RESOLVED') ?? 0} tone="accent" />
          <Stat label="Settled" value={byStatus.get('SETTLED') ?? 0} />
          <Stat label="Suspended" value={byStatus.get('SUSPENDED') ?? 0} tone="warn" />
          <Stat label="Cancelled" value={byStatus.get('CANCELLED') ?? 0} tone="sell" />
          <Stat label="Total pool NAV" value={fmtCompact(totalPool)} tone="accent" />
        </div>
      </Panel>
    </div>
  );
}

// form primitives ---

function Field({
  label,
  children,
  className = '',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <span className="text-xs text-muted">{label}</span>
      {children}
    </div>
  );
}

function Text({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="input-glow rounded-lg border border-edge bg-panel-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
    />
  );
}

function Num({
  value,
  onChange,
  placeholder,
}: {
  value: number | '';
  onChange: (v: number | '') => void;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      className="input-glow tnum rounded-lg border border-edge bg-panel-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
    />
  );
}
