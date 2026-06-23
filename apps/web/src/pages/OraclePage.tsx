// Oracle panel — for `role=oracle` (and admin) accounts to resolve the
// `centralized`-mode markets assigned to them, once each market's deadline passes.
// Lists only the caller's due markets (the API enforces assignment + deadline) and
// offers a θ* resolve action per market.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, ErrorNote, Panel, Spinner, StatusBadge } from '../components/ui.tsx';
import { qk, useOracleMarkets } from '../hooks/queries.ts';
import { ApiError, api } from '../lib/api.ts';
import { fmt, timeAgo } from '../lib/format.ts';
import type { MarketView } from '../lib/types.ts';

export function OraclePage() {
  const marketsQ = useOracleMarkets();

  return (
    <div className="flex flex-col gap-5">
      <div className="hero-glow surface gradient-border relative flex flex-col gap-2 overflow-hidden rounded-2xl border border-edge bg-panel p-5">
        <h1 className="text-gradient text-2xl font-semibold tracking-tight">Oracle panel</h1>
        <p className="text-sm text-muted">
          Markets assigned to you that have reached their deadline and await resolution.
        </p>
      </div>

      {marketsQ.isLoading ? (
        <Spinner label="Loading assigned markets…" />
      ) : marketsQ.error || !marketsQ.data ? (
        <ErrorNote>Failed to load your oracle markets.</ErrorNote>
      ) : marketsQ.data.length === 0 ? (
        <Panel title="Nothing to resolve">
          <p className="p-4 text-sm text-muted">
            No assigned markets are past their deadline right now.
          </p>
        </Panel>
      ) : (
        <div className="flex flex-col gap-3">
          {marketsQ.data.map((m) => (
            <OracleMarketCard key={m.marketId} market={m} />
          ))}
        </div>
      )}
    </div>
  );
}

function OracleMarketCard({ market: m }: { market: MarketView }) {
  const qc = useQueryClient();
  const [theta, setTheta] = useState('');
  const resolve = useMutation({
    mutationFn: (thetaStar: number) =>
      api.oracleResolve(m.marketId, thetaStar).then((r) => r.market),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.oracleMarkets });
      qc.invalidateQueries({ queryKey: qk.markets });
      qc.invalidateQueries({ queryKey: qk.market(m.marketId) });
    },
  });

  const v = Number(theta);
  const valid = theta.trim() !== '' && Number.isFinite(v);

  return (
    <Panel title={m.title}>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <StatusBadge status={m.status} />
          <span className="text-muted">
            outcome in {m.outcomeUnit} · belief μ {fmt(m.belief.mu, 3)} · deadline{' '}
            {m.resolvesAt ? timeAgo(m.resolvesAt) : '—'}
          </span>
        </div>
        {m.description && <p className="text-sm text-fg">{m.description}</p>}
        <div className="flex flex-wrap items-end gap-2 border-t border-edge pt-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Resolved outcome θ*
            <input
              type="number"
              inputMode="decimal"
              value={theta}
              onChange={(e) => setTheta(e.target.value)}
              placeholder={`value in ${m.outcomeUnit}`}
              className="input-glow tnum w-44 rounded-lg border border-edge bg-panel-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
            />
          </label>
          <Button
            variant="primary"
            className="px-3 py-2 text-sm"
            disabled={!valid || resolve.isPending}
            onClick={() => resolve.mutate(v)}
          >
            {resolve.isPending ? 'Resolving…' : 'Resolve market'}
          </Button>
        </div>
        {resolve.isError && (
          <ErrorNote>
            {resolve.error instanceof ApiError ? resolve.error.message : 'Failed to resolve.'}
          </ErrorNote>
        )}
      </div>
    </Panel>
  );
}
