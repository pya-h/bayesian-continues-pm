// AdaptiveParamsView — admin-only per-market view of the self-tuning engine
// parameters. Shows the live σ_ε/s₀/α/β vs their static baseline, the
// controller state + which rail (if any) is bound, sparklines of how σ_ε and
// s₀ have moved over the market's life, and controls to enable/disable adaptation
// or pin a parameter to a fixed value. Read paths via `useAdminMarketCfg`; writes
// via the PATCH endpoint, invalidating the query on success.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { qk, useAdminMarketCfg } from '../hooks/queries.ts';
import { useMarketSocket } from '../hooks/useMarketSocket.ts';
import { ApiError, api } from '../lib/api.ts';
import { CFG_SOURCE_LABEL, cfgSeries, railSummary, sparkPoints } from '../lib/cfgView.ts';
import { fmt } from '../lib/format.ts';
import type { AdaptiveControl, MarketCfg } from '../lib/types.ts';
import { Button, ErrorNote, Spinner, Stat, Toggle } from './ui.tsx';

const SOURCE_TONE: Record<MarketCfg['source'], 'muted' | 'accent' | 'warn'> = {
  static: 'muted',
  adapt: 'accent',
  pin: 'warn',
};

export function AdaptiveParamsView({ marketId }: { marketId: string }) {
  const cfg = useAdminMarketCfg(marketId);
  const qc = useQueryClient();
  // Live updates: a `param_adapted` tick (a trade moved the controller, or a rail
  // bound) invalidates this query via useMarketSocket's handler.
  useMarketSocket(marketId);
  const mutate = useMutation({
    mutationFn: (body: AdaptiveControl) => api.adminSetMarketCfg(marketId, body).then((r) => r.cfg),
    onSuccess: (next) => qc.setQueryData(qk.adminCfg(marketId), next),
  });

  if (cfg.isLoading)
    return (
      <div className="mt-3">
        <Spinner label="Loading adaptive parameters…" />
      </div>
    );
  if (cfg.error || !cfg.data)
    return (
      <div className="mt-3">
        <ErrorNote>
          {cfg.error instanceof ApiError
            ? cfg.error.message
            : 'Failed to load adaptive parameters.'}
        </ErrorNote>
      </div>
    );

  const d = cfg.data;
  const enabled = d.control.enabled !== false;
  const rails = railSummary(d);

  return (
    <div className="surface-2 mt-3 flex flex-col gap-4 rounded-lg border border-edge bg-panel-2 p-3">
      {/* Status row */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={`rounded-md px-2 py-0.5 font-semibold ${
            SOURCE_TONE[d.source] === 'accent'
              ? 'bg-grad-accent text-[var(--color-on-accent)]'
              : SOURCE_TONE[d.source] === 'warn'
                ? 'bg-warn/15 text-warn'
                : 'bg-panel text-muted'
          }`}
        >
          {d.source === 'static' ? 'Static (V1)' : d.source === 'adapt' ? 'Adapting' : 'Pinned'}
        </span>
        <span className="text-muted">
          {d.state.count} obs · σ₀ {fmt(d.initialSigma, 2)} · regime {fmt(d.adapted.regime, 2)}
        </span>
        {rails && (
          <span className="rounded-md bg-warn/15 px-2 py-0.5 font-semibold text-warn">
            rail: {rails}
          </span>
        )}
      </div>

      {/* Live vs base parameter cards */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <ParamStat
          label="σ_ε (signal noise)"
          live={d.live.sigmaEps}
          base={d.base.sigmaEps}
          dp={3}
        />
        <ParamStat label="s₀ (base spread)" live={d.live.s0} base={d.base.s0} dp={4} />
        <ParamStat label="α (signal strength)" live={d.live.alpha} base={d.base.alpha} dp={2} />
        <ParamStat label="β (linear strength)" live={d.live.beta} base={d.base.beta} dp={2} />
      </div>

      {/* History sparklines */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Spark
          title="σ_ε over time"
          values={cfgSeries(d.history, 'sigmaEps')}
          tone="var(--color-accent)"
        />
        <Spark title="s₀ over time" values={cfgSeries(d.history, 's0')} tone="var(--color-price)" />
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-3 border-t border-edge pt-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Adaptation</p>
            <p className="text-xs text-muted">
              Off freezes σ_ε/s₀/α/β at the static baseline (or current pins).
            </p>
          </div>
          <Toggle
            checked={enabled}
            label="Toggle adaptation"
            onChange={(v) => mutate.mutate({ enabled: v })}
          />
        </div>

        <PinControls
          cfg={d}
          onApply={(pinned) => mutate.mutate({ pinned })}
          pending={mutate.isPending}
        />

        {mutate.isError && (
          <ErrorNote>
            {mutate.error instanceof ApiError ? mutate.error.message : 'Update failed.'}
          </ErrorNote>
        )}
      </div>
    </div>
  );
}

function ParamStat({
  label,
  live,
  base,
  dp,
}: {
  label: string;
  live: number;
  base: number;
  dp: number;
}) {
  const moved = Math.abs(live - base) > 10 ** -(dp + 1);
  return (
    <Stat
      label={label}
      value={fmt(live, dp)}
      tone={moved ? 'accent' : 'fg'}
      sub={moved ? `base ${fmt(base, dp)}` : 'at baseline'}
    />
  );
}

function Spark({ title, values, tone }: { title: string; values: number[]; tone: string }) {
  const W = 220;
  const H = 44;
  const pts = sparkPoints(values, W, H, 3);
  return (
    <div className="rounded-lg border border-edge bg-panel p-2">
      <p className="mb-1 text-xs text-muted">
        {title}
        {values.length > 0 && <span className="ml-1 tnum">({values.length})</span>}
      </p>
      {values.length < 2 ? (
        <p className="flex h-[44px] items-center text-xs text-muted">Not enough history yet.</p>
      ) : (
        <svg
          width="100%"
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={title}
        >
          <title>{title}</title>
          <polyline
            points={pts}
            fill="none"
            stroke={tone}
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  );
}

// σ_ε / s₀ manual-pin inputs. Empty input ⇒ that param is left unpinned (adapts).
function PinControls({
  cfg,
  onApply,
  pending,
}: {
  cfg: MarketCfg;
  onApply: (pinned: NonNullable<AdaptiveControl['pinned']>) => void;
  pending: boolean;
}) {
  const p = cfg.control.pinned ?? {};
  const [sigmaEps, setSigmaEps] = useState(p.sigmaEps != null ? String(p.sigmaEps) : '');
  const [s0, setS0] = useState(p.s0 != null ? String(p.s0) : '');

  const parse = (s: string): number | undefined => {
    const v = Number(s);
    return s.trim() !== '' && Number.isFinite(v) && v > 0 ? v : undefined;
  };

  const apply = () => {
    const pinned: NonNullable<AdaptiveControl['pinned']> = {};
    const se = parse(sigmaEps);
    const ss = parse(s0);
    if (se !== undefined) pinned.sigmaEps = se;
    if (ss !== undefined) pinned.s0 = ss;
    onApply(pinned);
  };

  const hasPins = Object.keys(p).length > 0;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-semibold">Manual pins</p>
      <p className="text-xs text-muted">
        Pin a value to override adaptation; leave blank to let it adapt. Applying replaces all pins.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <PinInput
          label="σ_ε"
          value={sigmaEps}
          onChange={setSigmaEps}
          placeholder={fmt(cfg.live.sigmaEps, 3)}
        />
        <PinInput label="s₀" value={s0} onChange={setS0} placeholder={fmt(cfg.live.s0, 4)} />
        <Button
          variant="primary"
          className="px-3 py-1.5 text-xs"
          disabled={pending}
          onClick={apply}
        >
          Apply pins
        </Button>
        {hasPins && (
          <Button
            variant="ghost"
            className="px-3 py-1.5 text-xs"
            disabled={pending}
            onClick={() => {
              setSigmaEps('');
              setS0('');
              onApply({});
            }}
          >
            Clear pins
          </Button>
        )}
      </div>
    </div>
  );
}

function PinInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      <input
        type="number"
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="input-glow tnum w-28 rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-sm text-fg outline-none focus:border-accent"
      />
    </label>
  );
}
