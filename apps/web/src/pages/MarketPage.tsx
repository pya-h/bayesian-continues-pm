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
import { MiniBelief } from '../components/MiniBelief.tsx';
import { PositionPanel } from '../components/PositionPanel.tsx';
import { PriceCurveChart } from '../components/PriceCurveChart.tsx';
import { QuotePanel } from '../components/QuotePanel.tsx';
import { TradesTape } from '../components/TradesTape.tsx';
import { ErrorNote, FlashNumber, Panel, Spinner, Stat, StatusBadge } from '../components/ui.tsx';
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

  const Z80 = 1.2815515594; // normInv(0.9) → ±z·σ is the 80% central interval
  const ci80Lo = mu - Z80 * sigma;
  const ci80Hi = mu + Z80 * sigma;

  return (
    <div className="flex flex-col gap-4">
      <Link to="/" className="text-sm text-muted hover:text-fg">
        ← Markets
      </Link>

      {/* hero: identity + live belief */}
      <div className="flex flex-col gap-4 rounded-2xl border border-edge bg-panel p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold">{m.title}</h1>
            <StatusBadge status={m.status} />
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <span
                className={`h-2 w-2 rounded-full ${connected ? 'animate-pulse bg-buy' : 'bg-muted'}`}
              />
              {connected ? 'live' : 'offline'}
            </span>
          </div>
          {m.description && <p className="max-w-2xl text-sm text-muted">{m.description}</p>}
          <div className="mt-1 flex flex-wrap items-end gap-x-6 gap-y-2">
            <div>
              <div className="text-xs text-muted">
                {m.thetaStar != null ? 'Resolved θ*' : 'Consensus μ'}
              </div>
              <div className="text-3xl font-semibold tracking-tight text-accent">
                <FlashNumber value={m.thetaStar ?? mu}>
                  {fmt(m.thetaStar ?? mu, 0)}
                  <span className="ml-1 text-base font-normal text-muted">{m.outcomeUnit}</span>
                </FlashNumber>
              </div>
            </div>
            <div>
              <div className="text-xs text-muted">Uncertainty σ</div>
              <div className="tnum text-lg font-semibold">
                <FlashNumber value={sigma}>±{fmt(sigma, 0)}</FlashNumber>
              </div>
            </div>
            <div>
              <div className="text-xs text-muted">80% interval</div>
              <div className="tnum text-sm font-medium text-fg">
                [{fmt(ci80Lo, 0)}, {fmt(ci80Hi, 0)}]
              </div>
            </div>
          </div>
        </div>
        <div className="flex flex-col items-stretch gap-3 sm:w-72">
          <div className="h-16 overflow-hidden rounded-xl bg-panel-2/60">
            <MiniBelief
              mu={mu}
              sigma={sigma}
              outcomeMin={m.outcomeMin}
              outcomeMax={m.outcomeMax}
              thetaStar={m.thetaStar}
            />
          </div>
          <Link
            to={`/markets/${id}/lp`}
            className="self-end rounded-lg border border-edge bg-panel-2 px-3 py-1.5 text-xs text-muted transition-colors hover:text-fg"
          >
            Manage liquidity →
          </Link>
        </div>
      </div>

      {/* financial stat strip */}
      <div className="grid grid-cols-2 gap-4 rounded-xl border border-edge bg-panel p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Pool NAV" value={fmtCompact(m.pool.nav)} />
        <Stat label="Cash" value={fmtCompact(m.cash)} />
        <Stat
          label="Reserve"
          value={fmtCompact(m.reserveRequired)}
          sub={`util ${fmtPct(m.cash > 0 ? m.reserveRequired / m.cash : 0)}`}
        />
        <Stat label="Volume" value={fmtCompact(stats.data?.volume ?? 0)} />
        <Stat label="Trades" value={fmt(stats.data?.trades ?? 0, 0)} />
        <Stat label="Traders" value={fmt(stats.data?.traders ?? 0, 0)} />
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
            <PositionPanel
              marketId={id}
              belief={{
                mu,
                sigma,
                outcomeUnit: m.outcomeUnit,
                outcomeMin: m.outcomeMin,
                outcomeMax: m.outcomeMax,
              }}
            />
          </Panel>
          <Panel title="Recent trades">
            <TradesTape tape={tape} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
