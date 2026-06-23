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
import { AdaptiveParamsView } from '../components/AdaptiveParamsView.tsx';
import { AlertsBanner } from '../components/AlertsBanner.tsx';
import { AuditLogView } from '../components/AuditLogView.tsx';
import { MarketLedgerView } from '../components/MarketLedgerView.tsx';
import { Button, ErrorNote, Panel, Spinner, Stat, StatusBadge } from '../components/ui.tsx';
import {
  qk,
  useAdminDisputes,
  useAdminOverview,
  useAdminUserTransactions,
  useAdminUsers,
  useMarkets,
} from '../hooks/queries.ts';
import { ApiError, api } from '../lib/api.ts';
import { type CreateMarketDraft, buildCreateMarketBody, lifecycleActions } from '../lib/derive.ts';
import { fmt, fmtCompact, fmtPct, fmtSigned, timeAgo } from '../lib/format.ts';
import { txLabel } from '../lib/txView.ts';
import type { AdminUser, Dispute, MarketView } from '../lib/types.ts';
import { oneOf, usePersistentState } from '../lib/usePersistentState.ts';

type AdminTab = 'markets' | 'users' | 'create' | 'disputes' | 'system' | 'audit';
const TABS: { key: AdminTab; label: string }[] = [
  { key: 'markets', label: 'Markets' },
  { key: 'users', label: 'Users' },
  { key: 'create', label: 'Create market' },
  { key: 'disputes', label: 'Disputes' },
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
        {tab === 'disputes' && <DisputesSection />}
        {tab === 'system' && <SystemSection />}
        {tab === 'audit' && <AuditLogView />}
      </div>
    </div>
  );
}

// create market ---

type BeliefKind = NonNullable<CreateMarketDraft['beliefKind']>;
const PRIMARY_KINDS = ['gen_basis', 'gen_exact'] as const;
const MORE_KINDS = ['gaussian', 'student_t', 'mixture'] as const;

const MODEL_META: Record<BeliefKind, { label: string; sub: string; help: string }> = {
  gen_basis: {
    label: 'Gen·basis ⛓',
    sub: 'default · adaptive',
    help: 'The default general model — an adaptive Gaussian mixture. Author one or more bumps (weight π, center μ, spread σ); order flow grows a new mode where the crowd disagrees and merges modes back on consensus, so the shape adapts itself.',
  },
  gen_exact: {
    label: 'Gen·exact ★',
    sub: 'skew · peak · bimodal',
    help: 'Max-entropy exp(−poly) — a few smooth shape dials around μ/σ (above): λ₂ well depth (<0 ⇒ bimodal), λ₃ skew, λ₄ flat-top / thinner tails. Exact analytic shapes in just a handful of parameters.',
  },
  gaussian: {
    label: 'Gaussian',
    sub: 'simple · exact',
    help: 'A single symmetric bump N(μ, σ²) — the cheapest exact unimodal prior. A special case of Gen·basis (one bump).',
  },
  student_t: {
    label: 'Student-t',
    sub: 'exact heavy tails',
    help: 'Like a Gaussian but with exact heavy (polynomial) tails — the one capability the generals do not reproduce exactly, so far-from-consensus outcomes stay plausible. Lower ν ⇒ heavier tails; ν > 2 for finite variance.',
  },
  mixture: {
    label: 'Mixture',
    sub: 'fixed camps · a Gen·basis preset',
    help: 'A fixed set of explicit Gaussian camps (≥2 modes). Mathematically a subset of Gen·basis (the general mixture) with mode-spawning off — kept as a "few explicit camps" preset.',
  },
};

// Gen·exact shape presets → [λ₂, λ₃, λ₄] (within the sandbox-safe ranges).
const GEN_EXACT_PRESETS: { label: string; lambdas: [number, number, number] }[] = [
  { label: 'Gaussian', lambdas: [1, 0, 0] },
  { label: 'Skew', lambdas: [1, 0.3, 0] },
  { label: 'Flat', lambdas: [1, 0, 1.2] },
  { label: 'Bimodal', lambdas: [-1.5, 0, 0] },
];
// λ slider ranges, paired with the coefficient index they drive.
const GEN_EXACT_SLIDERS: {
  idx: 0 | 1 | 2;
  label: string;
  min: number;
  max: number;
  step: number;
}[] = [
  { idx: 0, label: 'λ₂ well depth (<0 ⇒ bimodal)', min: -4, max: 4, step: 0.1 },
  { idx: 1, label: 'λ₃ skew', min: -0.35, max: 0.35, step: 0.01 },
  { idx: 2, label: 'λ₄ flat-top / thin tails', min: 0, max: 1.6, step: 0.05 },
];

const EMPTY_DRAFT: CreateMarketDraft = {
  title: '',
  description: '',
  outcomeUnit: '',
  outcomeMin: '',
  outcomeMax: '',
  initialMu: 0,
  initialSigma: 1,
  initialReserve: 10_000,
  beliefKind: 'gen_basis',
  // Gen·basis (the default) opens with a single bump at the prior; switching kinds
  // re-seeds as needed.
  components: [{ pi: 1, mu: 0, sigma: 1 }],
  nu: 5,
  lambdas: [1, 0, 0],
  cfg: {},
};

function ModelButton({
  meta,
  selected,
  onClick,
}: {
  meta: { label: string; sub: string };
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`sheen relative flex min-w-[8.5rem] flex-col items-start overflow-hidden rounded-lg border px-3 py-2 text-left transition-transform duration-200 [transition-timing-function:var(--ease-spring)] hover:-translate-y-0.5 ${
        selected
          ? 'bg-grad-accent btn-glow-accent border-transparent text-[var(--color-on-accent)]'
          : 'surface-2 border-edge text-fg hover:border-accent'
      }`}
    >
      <span className="text-xs font-semibold tracking-tight">{meta.label}</span>
      <span
        className={`text-[10px] ${selected ? 'text-[var(--color-on-accent)]/80' : 'text-muted'}`}
      >
        {meta.sub}
      </span>
    </button>
  );
}

const SELECT_CLS =
  'input-glow rounded-lg border border-edge bg-panel-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent';

// oracle assignment for the create form: pick the resolution mode + deadline
// and the mode-specific extras — the assigned `oracle`-role account (centralized)
// the xprices token (api), or a disabled placeholder (decentralized).
function OracleSection({
  draft,
  set,
}: {
  draft: CreateMarketDraft;
  set: <K extends keyof CreateMarketDraft>(k: K, v: CreateMarketDraft[K]) => void;
}) {
  const mode = draft.oracleMode ?? 'centralized';
  const usersQ = useAdminUsers();
  const oracleUsers = (usersQ.data ?? []).filter((u) => u.role === 'oracle' || u.role === 'admin');

  return (
    <div className="border-t border-edge px-4 py-3">
      <div className="mb-2 text-xs text-muted">Oracle &amp; resolution</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Resolution mode">
          <select
            className={SELECT_CLS}
            value={mode}
            onChange={(e) => set('oracleMode', e.target.value as CreateMarketDraft['oracleMode'])}
          >
            <option value="centralized">Centralized (assigned oracle)</option>
            <option value="api">API price feed (xprices)</option>
            <option value="decentralized" disabled>
              Decentralized — coming soon
            </option>
          </select>
        </Field>

        <Field label="Resolution deadline">
          <input
            type="datetime-local"
            className={SELECT_CLS}
            value={draft.resolvesAt ?? ''}
            onChange={(e) => set('resolvesAt', e.target.value)}
          />
        </Field>

        <Field label="Dispute window (hours)">
          <Num
            value={draft.disputeWindowHours ?? ''}
            onChange={(v) => set('disputeWindowHours', v)}
            placeholder="24"
          />
        </Field>

        {mode === 'centralized' && (
          <Field label="Assigned oracle">
            <select
              className={SELECT_CLS}
              value={draft.oracleUserId ?? ''}
              onChange={(e) => set('oracleUserId', e.target.value)}
            >
              <option value="">Admin (resolve myself)</option>
              {oracleUsers.map((u) => (
                <option key={u.userId} value={u.userId}>
                  {u.username} ({u.role})
                </option>
              ))}
            </select>
          </Field>
        )}

        {mode === 'api' && (
          <Field label="Price token (xprices)" className="sm:col-span-2">
            <Text
              value={draft.oracleToken ?? ''}
              onChange={(v) => set('oracleToken', v)}
              placeholder="BTC"
            />
          </Field>
        )}

        {mode === 'decentralized' && (
          <div className="sm:col-span-2 self-end text-xs text-muted">
            Decentralized resolution (e.g. UMA) is a placeholder — not yet available.
          </div>
        )}
      </div>
      {mode === 'api' && (
        <p className="mt-2 text-[11px] text-muted">
          At the deadline the scheduler fetches this token's price from xprices and resolves the
          market with it. A stale or unreachable feed suspends the market and alerts instead.
        </p>
      )}
    </div>
  );
}

function CreateMarketForm() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<CreateMarketDraft>(EMPTY_DRAFT);
  const [showCfg, setShowCfg] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.adminCreateMarket(buildCreateMarketBody(draft)).then((r) => r.market),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.markets });
      setDraft(EMPTY_DRAFT);
      setShowCfg(false);
      setShowMore(false);
    },
  });

  const set = <K extends keyof CreateMarketDraft>(k: K, v: CreateMarketDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const setCfg = (k: string, v: number | '') =>
    setDraft((d) => ({ ...d, cfg: { ...d.cfg, [k]: v } }));

  // belief-shape editor helpers ---
  const setKind = (kind: BeliefKind) => {
    if ((MORE_KINDS as readonly string[]).includes(kind)) setShowMore(true);
    setDraft((d) => ({
      ...d,
      beliefKind: kind,
      // Gen·basis opens with ≥1 bump; mixture needs ≥2 straddling modes so it's
      // visibly multi-modal out of the box. Both edit the same `components` rows.
      components:
        kind === 'mixture' && (d.components?.length ?? 0) < 2
          ? [
              { pi: 1, mu: d.initialMu - d.initialSigma, sigma: d.initialSigma },
              { pi: 1, mu: d.initialMu + d.initialSigma, sigma: d.initialSigma },
            ]
          : kind === 'gen_basis' && (d.components?.length ?? 0) < 1
            ? [{ pi: 1, mu: d.initialMu, sigma: d.initialSigma }]
            : (d.components ?? []),
      // Seed a sensible ν (heavier tails than Gaussian, finite variance) on first
      // switch to Student-t; seed a Gaussian λ-preset on first switch to Gen·exact.
      nu: kind === 'student_t' && !(Number(d.nu) > 2) ? 5 : d.nu,
      lambdas: kind === 'gen_exact' && !d.lambdas ? [1, 0, 0] : d.lambdas,
    }));
  };
  const setLambda = (idx: 0 | 1 | 2, v: number) =>
    setDraft((d) => {
      const lam: [number | '', number | '', number | ''] = [...(d.lambdas ?? [1, 0, 0])];
      lam[idx] = v;
      return { ...d, lambdas: lam };
    });
  const applyPreset = (lambdas: [number, number, number]) => setDraft((d) => ({ ...d, lambdas }));
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

      <OracleSection draft={draft} set={set} />

      {/* Belief model: two primary generals lead; the three classics fold away under
          "More models". Every kind stays one click from creatable (multi-model G3). */}
      <div className="border-t border-edge px-4 py-3">
        <div className="mb-2 text-xs text-muted">Belief model</div>
        <div className="flex flex-wrap items-stretch gap-2">
          {PRIMARY_KINDS.map((k) => (
            <ModelButton
              key={k}
              meta={MODEL_META[k]}
              selected={(draft.beliefKind ?? 'gen_basis') === k}
              onClick={() => setKind(k)}
            />
          ))}
          <button
            type="button"
            onClick={() => setShowMore((s) => !s)}
            className="surface-2 rounded-lg border border-edge px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent hover:text-fg"
          >
            <span
              className="inline-block transition-transform duration-200"
              style={{ transform: showMore ? 'rotate(90deg)' : 'none' }}
            >
              ▸
            </span>{' '}
            More models
          </button>
        </div>
        {showMore && (
          <div className="animate-slide-in mt-2 flex flex-wrap items-stretch gap-2">
            {MORE_KINDS.map((k) => (
              <ModelButton
                key={k}
                meta={MODEL_META[k]}
                selected={draft.beliefKind === k}
                onClick={() => setKind(k)}
              />
            ))}
          </div>
        )}

        <p
          key={draft.beliefKind ?? 'gen_basis'}
          className="animate-fade-in mt-3 text-xs leading-relaxed text-muted"
        >
          {MODEL_META[draft.beliefKind ?? 'gen_basis'].help}
        </p>

        {/* Gen·basis bumps / Mixture modes — same editor; Gen·basis allows a single
            bump, Mixture needs ≥2 camps. */}
        {(draft.beliefKind === 'gen_basis' || draft.beliefKind === 'mixture') &&
          (() => {
            const noun = draft.beliefKind === 'gen_basis' ? 'bump' : 'mode';
            const minCount = draft.beliefKind === 'gen_basis' ? 1 : 2;
            return (
              <div key={draft.beliefKind} className="animate-slide-in mt-3 flex flex-col gap-2">
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
                      disabled={(draft.components?.length ?? 0) <= minCount}
                      className="mb-1 rounded-md border border-edge px-2 py-1 text-xs text-muted hover:text-sell disabled:opacity-40"
                      title={`Remove ${noun}`}
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
                  + Add {noun}
                </button>
              </div>
            );
          })()}

        {/* Gen·exact λ shape: presets + sliders. */}
        {draft.beliefKind === 'gen_exact' && (
          <div className="animate-slide-in mt-3 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">Presets</span>
              {GEN_EXACT_PRESETS.map((p) => {
                const active = p.lambdas.every((v, i) => Number(draft.lambdas?.[i]) === v);
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => applyPreset(p.lambdas)}
                    aria-pressed={active}
                    className={`sheen relative overflow-hidden rounded-md border px-2.5 py-1 text-xs transition-colors ${
                      active
                        ? 'bg-grad-accent btn-glow-accent border-transparent text-[var(--color-on-accent)]'
                        : 'border-edge text-muted hover:border-accent hover:text-fg'
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            {GEN_EXACT_SLIDERS.map((s) => {
              const val = Number(draft.lambdas?.[s.idx] ?? 0);
              return (
                <div key={s.idx} className="flex items-center gap-3">
                  <span className="w-52 text-xs text-muted">{s.label}</span>
                  <input
                    type="range"
                    min={s.min}
                    max={s.max}
                    step={s.step}
                    value={val}
                    onChange={(e) => setLambda(s.idx, Number(e.target.value))}
                    className="h-1.5 flex-1 cursor-pointer accent-[var(--color-accent)]"
                    aria-label={s.label}
                  />
                  <span className="tnum w-12 rounded bg-panel-2 px-1.5 py-0.5 text-right text-xs text-fg">
                    {val.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Student-t ν. */}
        {draft.beliefKind === 'student_t' && (
          <div className="animate-slide-in mt-3">
            <Field label="Degrees of freedom ν (> 2)" className="w-40">
              <Num value={draft.nu ?? ''} onChange={(v) => set('nu', v)} placeholder="5" />
            </Field>
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
  // Distinguish a failed fetch from a genuinely empty list — otherwise an API error
  // reads as "you have no markets", hiding the problem.
  if (markets.error)
    return (
      <ErrorNote>
        {markets.error instanceof ApiError ? markets.error.message : 'Failed to load markets.'}
      </ErrorNote>
    );

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
  const [view, setView] = useState<'overview' | 'ledger' | 'cfg'>('overview');
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
            <SubTab active={view === 'cfg'} onClick={() => setView('cfg')}>
              Adaptive params
            </SubTab>
          </div>
          {view === 'overview' ? (
            <Overview marketId={m.marketId} />
          ) : view === 'ledger' ? (
            <MarketLedgerView marketId={m.marketId} />
          ) : (
            <AdaptiveParamsView marketId={m.marketId} />
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
  const setRole = useMutation({
    mutationFn: (role: AdminUser['role']) =>
      api.adminSetUserRole(u.userId, role).then((r) => r.user),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.adminUsers }),
  });
  const n = Number(amount);
  const valid = amount !== '' && Number.isFinite(n) && n > 0;

  return (
    <div className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={() => setOpen((o) => !o)} className="text-left">
          <span className="mr-1.5 text-muted">{open ? '▾' : '▸'}</span>
          <span className="font-semibold">{u.username}</span>
          <div className="tnum pl-5 text-xs text-muted">
            {u.isInfinite ? '∞ balance' : `$${fmt(u.balance)}`}
          </div>
        </button>
        <div className="flex items-center gap-2">
          {/* Role (V2-3: grant `oracle`). Backend blocks self-demotion. */}
          <select
            value={u.role}
            disabled={setRole.isPending}
            onChange={(e) => setRole.mutate(e.target.value as AdminUser['role'])}
            className="input-glow rounded-lg border border-edge bg-panel-2 px-2 py-1.5 text-xs text-fg outline-none focus:border-accent"
          >
            <option value="user">user</option>
            <option value="oracle">oracle</option>
            <option value="admin">admin</option>
          </select>
          {setRole.isError && (
            <span className="text-xs text-sell">
              {setRole.error instanceof ApiError ? setRole.error.message : 'Failed.'}
            </span>
          )}
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

  // A failed markets/users fetch would otherwise render zeroed counts as if the system
  // were empty — surface the error instead. Alerts still render above it.
  const err = markets.error ?? users.error;

  return (
    <div className="flex flex-col gap-5">
      <AlertsBanner />
      {err ? (
        <ErrorNote>
          {err instanceof ApiError ? err.message : 'Failed to load system overview.'}
        </ErrorNote>
      ) : (
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
      )}
    </div>
  );
}

// form primitives ---

// disputes ---

function DisputesSection() {
  const disputesQ = useAdminDisputes();
  if (disputesQ.isLoading) return <Spinner label="Loading disputes…" />;
  if (disputesQ.error || !disputesQ.data) return <ErrorNote>Failed to load disputes.</ErrorNote>;
  const all = disputesQ.data;
  const open = all.filter((d) => d.status === 'open');
  const closed = all.filter((d) => d.status !== 'open');

  return (
    <Panel title={`Disputes (${open.length} open)`}>
      <div className="flex flex-col gap-3 p-4">
        {all.length === 0 && <p className="text-sm text-muted">No disputes filed.</p>}
        {open.map((d) => (
          <DisputeCard key={d.disputeId} dispute={d} />
        ))}
        {closed.length > 0 && (
          <>
            <div className="mt-2 text-xs text-muted">Resolved</div>
            {closed.map((d) => (
              <DisputeCard key={d.disputeId} dispute={d} />
            ))}
          </>
        )}
      </div>
    </Panel>
  );
}

function DisputeCard({ dispute: d }: { dispute: Dispute }) {
  const qc = useQueryClient();
  const [secondary, setSecondary] = useState('');
  const [note, setNote] = useState('');
  const isOpen = d.status === 'open';

  const resolve = useMutation({
    mutationFn: (body: { action: 'uphold' | 'reject'; secondaryValue?: number; note?: string }) =>
      api.adminResolveDispute(d.disputeId, body).then((r) => r.dispute),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'disputes'] });
      qc.invalidateQueries({ queryKey: qk.markets });
      qc.invalidateQueries({ queryKey: qk.market(d.marketId) });
    },
  });

  const uphold = () => {
    const v = Number(secondary);
    if (secondary.trim() === '' || !Number.isFinite(v)) return;
    resolve.mutate({ action: 'uphold', secondaryValue: v, note: note.trim() || undefined });
  };

  return (
    <div className="surface-2 rounded-lg border border-edge bg-panel-2 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <StatusBadge
          status={
            d.status === 'open' ? 'SUSPENDED' : d.status === 'upheld' ? 'RESOLVED' : 'CANCELLED'
          }
        />
        <span className="font-semibold text-fg">{d.marketTitle ?? d.marketId}</span>
        <span className="text-muted">
          by {d.username ?? d.userId} · {timeAgo(d.createdAt)}
        </span>
      </div>
      <p className="mt-2 text-sm text-fg">{d.reason}</p>
      <div className="mt-1 text-xs text-muted">
        {d.proposedValue != null && <span>proposed θ* {fmt(d.proposedValue, 4)} · </span>}
        {d.secondaryValue != null && <span>set θ* {fmt(d.secondaryValue, 4)} · </span>}
        {d.resolutionNote && <span>note: {d.resolutionNote}</span>}
      </div>

      {isOpen && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-edge pt-3">
          <Field label="Corrected θ* (to uphold)">
            <input
              type="number"
              inputMode="decimal"
              value={secondary}
              onChange={(e) => setSecondary(e.target.value)}
              placeholder={d.proposedValue != null ? String(d.proposedValue) : 'θ*'}
              className="input-glow tnum w-32 rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-sm text-fg outline-none focus:border-accent"
            />
          </Field>
          <Field label="Note (optional)" className="flex-1">
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="reason for the decision"
              className="input-glow w-full rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-sm text-fg outline-none focus:border-accent"
            />
          </Field>
          <Button
            variant="primary"
            className="px-3 py-1.5 text-xs"
            disabled={resolve.isPending}
            onClick={uphold}
          >
            Uphold (override θ*)
          </Button>
          <Button
            variant="ghost"
            className="px-3 py-1.5 text-xs"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate({ action: 'reject', note: note.trim() || undefined })}
          >
            Reject
          </Button>
        </div>
      )}
      {resolve.isError && (
        <ErrorNote>
          {resolve.error instanceof ApiError ? resolve.error.message : 'Failed to resolve dispute.'}
        </ErrorNote>
      )}
    </div>
  );
}

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
