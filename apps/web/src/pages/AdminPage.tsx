// Admin panel: create a market (full config + R₀), manage your markets'
// lifecycle, inspect per-market overview (creator/MM PnL, exposure, reserve
// util), and list + top-up users. Routed behind RequireAdmin.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.tsx';
import { Button, ErrorNote, Panel, Spinner, Stat, StatusBadge } from '../components/ui.tsx';
import { qk, useAdminOverview, useAdminUsers, useMarkets } from '../hooks/queries.ts';
import { ApiError, api } from '../lib/api.ts';
import { type CreateMarketDraft, buildCreateMarketBody, lifecycleActions } from '../lib/derive.ts';
import { fmt, fmtCompact, fmtPct, fmtSigned } from '../lib/format.ts';
import type { MarketView } from '../lib/types.ts';

export function AdminPage() {
  const { user } = useAuth();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-lg font-semibold">Admin</h1>
      <CreateMarketForm />
      <MyMarkets creatorId={user?.userId ?? ''} />
      <UsersSection />
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

// my markets ---

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
  const [resolving, setResolving] = useState(false);
  const [theta, setTheta] = useState('');

  const lifecycle = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: unknown }) =>
      api.adminLifecycle(m.marketId, action, body).then((r) => r.market),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.markets });
      qc.invalidateQueries({ queryKey: qk.market(m.marketId) });
      qc.invalidateQueries({ queryKey: qk.adminOverview(m.marketId) });
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
            className="tnum w-48 rounded-lg border border-edge bg-panel-2 px-3 py-1.5 text-sm outline-none focus:border-accent"
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

      {open && <Overview marketId={m.marketId} />}
    </div>
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
    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-edge bg-panel-2 p-3 sm:grid-cols-3 lg:grid-cols-4">
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

// users ---

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

function UserRow({ user: u }: { user: import('../lib/types.ts').AdminUser }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const topup = useMutation({
    mutationFn: (amt: number) => api.adminTopup(u.userId, amt).then((r) => r.user),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.adminUsers });
      setAmount('');
    },
  });
  const n = Number(amount);
  const valid = amount !== '' && Number.isFinite(n) && n > 0;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
      <div>
        <span className="font-semibold">{u.username}</span>
        <span className="ml-2 rounded bg-panel-2 px-1.5 py-0.5 text-xs text-muted">{u.role}</span>
        <span className="ml-2 text-xs text-muted">{u.tier}</span>
        <div className="tnum text-xs text-muted">
          {u.isInfinite ? '∞ balance' : `$${fmt(u.balance)}`}
        </div>
      </div>
      {!u.isInfinite && (
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="decimal"
            min={0}
            value={amount}
            placeholder="Top-up"
            onChange={(e) => setAmount(e.target.value)}
            className="tnum w-28 rounded-lg border border-edge bg-panel-2 px-3 py-1.5 text-sm outline-none focus:border-accent"
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
      className="rounded-lg border border-edge bg-panel-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
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
      className="tnum rounded-lg border border-edge bg-panel-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
    />
  );
}
