// Market / trade page — the centerpiece. Owns the composed-contract spec
// and renders the live belief-PDF chart, the contract composer (chart-draggable)
// the quote+execute panel, this-market positions, belief history, price-vs-strike
// and a live trades tape. Belief μ/σ stream in via the market socket.

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.tsx';
import { BeliefChart } from '../components/BeliefChart.tsx';
import { BeliefHistoryChart } from '../components/BeliefHistoryChart.tsx';
import { ContractComposer, defaultSpec } from '../components/ContractComposer.tsx';
import { PositionPanel } from '../components/PositionPanel.tsx';
import { PriceCurveChart } from '../components/PriceCurveChart.tsx';
import { QuotePanel } from '../components/QuotePanel.tsx';
import { TradesTape } from '../components/TradesTape.tsx';
import { ErrorNote, Panel, Spinner, Stat, StatusBadge } from '../components/ui.tsx';
import { useMarket, useMarketHistory, useMarketStats } from '../hooks/queries.ts';
import { useMarketSocket } from '../hooks/useMarketSocket.ts';
import { ApiError } from '../lib/api.ts';
import { fmt, fmtCompact, fmtPct } from '../lib/format.ts';
import type { ContractSpec } from '../lib/types.ts';
import { niceDomain } from '../lib/viz.ts';

export function MarketPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const market = useMarket(id);
  const stats = useMarketStats(id);
  const history = useMarketHistory(id);
  const { connected, tape } = useMarketSocket(id, user?.userId);

  const [spec, setSpec] = useState<ContractSpec | null>(null);

  // Seed the composer with a Call once the belief is known (once only).
  const mu = market.data?.belief.mu ?? 0;
  const sigma = market.data?.belief.sigma ?? 1;
  useEffect(() => {
    if (market.data && !spec) setSpec(defaultSpec('CALL', mu, sigma));
  }, [market.data, spec, mu, sigma]);

  const domain = useMemo(
    () =>
      niceDomain(mu, sigma, {
        min: market.data?.outcomeMin ?? null,
        max: market.data?.outcomeMax ?? null,
      }),
    [mu, sigma, market.data?.outcomeMin, market.data?.outcomeMax],
  );

  if (market.isLoading || !spec) return <Spinner label="Loading market…" />;
  if (market.error || !market.data)
    return (
      <ErrorNote>
        {market.error instanceof ApiError ? market.error.message : 'Market not found.'}
      </ErrorNote>
    );

  const m = market.data;
  const tradable = m.status === 'OPEN';

  return (
    <div className="flex flex-col gap-4">
      {/* header */}
      <div>
        <Link to="/" className="text-sm text-muted hover:text-fg">
          ← Markets
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{m.title}</h1>
          <StatusBadge status={m.status} />
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <span className={`h-2 w-2 rounded-full ${connected ? 'bg-buy' : 'bg-muted'}`} />
            {connected ? 'live' : 'offline'}
          </span>
        </div>
        {m.description && <p className="mt-1 max-w-3xl text-sm text-muted">{m.description}</p>}
      </div>

      {/* stat strip */}
      <div className="grid grid-cols-2 gap-4 rounded-xl border border-edge bg-panel p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Consensus μ" value={`${fmt(mu, 0)} ${m.outcomeUnit}`} tone="accent" />
        <Stat label="Uncertainty σ" value={fmt(sigma, 0)} />
        <Stat label="Pool NAV" value={fmtCompact(m.pool.nav)} />
        <Stat label="Cash" value={fmtCompact(m.cash)} />
        <Stat
          label="Reserve"
          value={fmtCompact(m.reserveRequired)}
          sub={`util ${fmtPct(m.cash > 0 ? m.reserveRequired / m.cash : 0)}`}
        />
        <Stat
          label="Volume"
          value={fmtCompact(stats.data?.volume ?? 0)}
          sub={`${stats.data?.trades ?? 0} trades`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* left: chart + composer + sub-charts */}
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Panel
            title="Belief & payoff"
            right={<span className="text-xs text-muted">drag the handles ↔</span>}
          >
            <div className="p-3">
              <BeliefChart
                mu={mu}
                sigma={sigma}
                spec={spec}
                onSpecChange={setSpec}
                outcomeUnit={m.outcomeUnit}
                outcomeMin={m.outcomeMin}
                outcomeMax={m.outcomeMax}
                thetaStar={m.thetaStar}
              />
            </div>
            <div className="border-t border-edge p-4">
              <ContractComposer spec={spec} onSpecChange={setSpec} mu={mu} sigma={sigma} />
            </div>
          </Panel>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Panel title="Belief μ over time">
              <BeliefHistoryChart points={history.data?.beliefHistory ?? []} />
            </Panel>
            <Panel title="Fair price vs strike">
              <div className="p-2">
                <PriceCurveChart spec={spec} mu={mu} sigma={sigma} domain={domain} />
              </div>
            </Panel>
          </div>
        </div>

        {/* right: quote + positions + tape */}
        <div className="flex flex-col gap-4">
          <Panel title="Quote & trade">
            <QuotePanel
              marketId={id}
              spec={spec}
              tradable={tradable}
              mu={mu}
              sigma={sigma}
              outcomeUnit={m.outcomeUnit}
            />
          </Panel>
          <Panel title="Your positions">
            <PositionPanel marketId={id} />
          </Panel>
          <Panel title="Recent trades">
            <TradesTape tape={tape} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
