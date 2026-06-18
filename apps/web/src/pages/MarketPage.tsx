// Market / trade page — the centerpiece. Owns the composed-contract spec
// and renders the live belief-PDF chart, the contract composer (chart-draggable)
// the quote+execute panel, this-market positions, belief history, price-vs-strike
// and a live trades tape. Belief μ/σ stream in via the market socket.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.tsx';
import { BeliefChart } from '../components/BeliefChart.tsx';
import { BeliefHistoryChart } from '../components/BeliefHistoryChart.tsx';
import { CdfChart } from '../components/CdfChart.tsx';
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
import type { ContractSpec, PortfolioPosition } from '../lib/types.ts';
import { niceDomain } from '../lib/viz.ts';

export function MarketPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const market = useMarket(id);
  const stats = useMarketStats(id);
  const history = useMarketHistory(id);
  const { connected, tape } = useMarketSocket(id, user?.userId);

  const [spec, setSpec] = useState<ContractSpec | null>(null);
  const [sellRequest, setSellRequest] = useState<{ qty: number; nonce: number } | null>(null);
  // Cumulative-probability P(≤θ) view: off | overlaid on the belief chart | a panel below.
  const [cdfMode, setCdfMode] = useState<'off' | 'overlay' | 'panel'>('off');

  // Click a held position → load its contract into the composer, ask the trade
  // panel to switch to Sell pre-filled, and bring the panel into view.
  const handleSell = useCallback((p: PortfolioPosition) => {
    setSpec(p.spec);
    setSellRequest((r) => ({ qty: Math.abs(p.quantity), nonce: (r?.nonce ?? 0) + 1 }));
    document.getElementById('quote-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Reset per-market UI state when navigating market→market. The app shell keys
  // <main> on the first path segment, which is "markets" for every market page
  // so this page is NOT remounted between two markets — without this, the prior
  // market's composed spec / sell request would leak into the new one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on id change
  useEffect(() => {
    setSpec(null);
    setSellRequest(null);
  }, [id]);

  // Seed the composer with a Call once the belief is known.
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

  // Error must be checked BEFORE the spinner: `spec` is only ever seeded from
  // market.data, so on a failed initial fetch (bad id, API down) `!spec` stays
  // true forever and a spinner-first guard spins infinitely instead of erroring.
  // Scoped to `!market.data`: a transient background-refetch failure with data
  // already on screen keeps rendering the (stale) page rather than nuking it.
  if (!market.data && (market.error || !market.isLoading))
    return (
      <ErrorNote>
        {market.error instanceof ApiError ? market.error.message : 'Market not found.'}
      </ErrorNote>
    );
  if (market.isLoading || !spec || !market.data) return <Spinner label="Loading market…" />;

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
      <div className="hero-glow gradient-border surface relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-edge bg-panel p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold">{m.title}</h1>
            <StatusBadge status={m.status} />
            <span className="flex items-center gap-1.5 text-xs text-muted">
              {connected ? (
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-buy/60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-buy" />
                </span>
              ) : (
                <span className="h-2 w-2 rounded-full bg-muted" />
              )}
              {connected ? 'live' : 'offline'}
            </span>
          </div>
          {m.description && <p className="max-w-2xl text-sm text-muted">{m.description}</p>}
          <div className="mt-1 flex flex-wrap items-end gap-x-6 gap-y-2">
            <div>
              <div className="text-xs text-muted">
                {m.thetaStar != null ? 'Resolved θ*' : 'Consensus μ'}
              </div>
              <div className="text-3xl font-bold tracking-tight text-accent">
                <FlashNumber value={m.thetaStar ?? mu}>
                  <span className="text-gradient">{fmt(m.thetaStar ?? mu, 0)}</span>
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
        <div className="relative flex flex-col items-stretch gap-3 sm:w-72">
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
      <div className="surface grid grid-cols-2 gap-4 rounded-xl border border-edge bg-panel p-4 shadow-soft sm:grid-cols-3 lg:grid-cols-6">
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
            right={
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 text-[11px] text-muted">
                  <span className="font-medium">CDF</span>
                  <div className="surface-2 flex overflow-hidden rounded-md border border-edge p-0.5">
                    {(['off', 'overlay', 'panel'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setCdfMode(mode)}
                        aria-pressed={cdfMode === mode}
                        className={`rounded px-2 py-0.5 transition-all duration-200 ${
                          cdfMode === mode
                            ? 'btn-glow-warn bg-warn font-semibold text-ink'
                            : 'text-muted hover:text-fg'
                        }`}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                </div>
                <span className="hidden text-xs text-muted lg:inline">
                  drag plot to pan · drag axes to zoom · dbl-click resets
                </span>
              </div>
            }
          >
            <div className="p-3">
              <BeliefChart
                key={id}
                mu={mu}
                sigma={sigma}
                components={m.belief.components}
                beliefKind={m.belief.kind}
                nu={m.belief.nu}
                genExact={
                  m.belief.lambdas && m.belief.loc != null && m.belief.scale != null
                    ? { loc: m.belief.loc, scale: m.belief.scale, lambdas: m.belief.lambdas }
                    : undefined
                }
                showCdf={cdfMode === 'overlay'}
                spec={spec}
                onSpecChange={setSpec}
                outcomeUnit={m.outcomeUnit}
                outcomeMin={m.outcomeMin}
                outcomeMax={m.outcomeMax}
                thetaStar={m.thetaStar}
              />
            </div>
            {cdfMode === 'panel' && (
              <div className="animate-fade-up border-t border-edge p-3">
                <div className="mb-1 flex items-center gap-1.5 text-xs text-muted">
                  <span className="inline-block h-2 w-2 rounded-full bg-warn" />
                  Cumulative probability — P(outcome ≤ θ)
                </div>
                <CdfChart
                  belief={m.belief}
                  outcomeUnit={m.outcomeUnit}
                  outcomeMin={m.outcomeMin}
                  outcomeMax={m.outcomeMax}
                  thetaStar={m.thetaStar}
                />
              </div>
            )}
            {m.model === 'gen_basis' && (
              <div className="surface-2 animate-fade-in mx-4 mt-3 flex items-start gap-2 rounded-lg border border-accent/30 px-3 py-2 text-xs text-muted">
                <span className="text-accent">⛓</span>
                <span>
                  <span className="font-medium text-fg">Paint the curve:</span> place a{' '}
                  <span className="font-medium text-fg">Bell</span> bet at a price to sculpt a mode
                  there — repeated bells at different prices grow distinct camps; sell a bell back
                  to erase one.
                </span>
              </div>
            )}
            <div className="border-t border-edge p-4">
              <ContractComposer
                spec={spec}
                onSpecChange={setSpec}
                mu={mu}
                sigma={sigma}
                model={m.model}
                outcomeMin={m.outcomeMin}
                outcomeMax={m.outcomeMax}
                nu={m.belief.nu}
              />
            </div>
          </Panel>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Panel title="Belief μ over time">
              <BeliefHistoryChart points={history.data?.beliefHistory ?? []} />
            </Panel>
            <Panel title="Fair price vs strike">
              <div className="p-2">
                <PriceCurveChart spec={spec} belief={m.belief} domain={domain} />
              </div>
            </Panel>
          </div>
        </div>

        {/* right: quote + positions + tape */}
        <div className="flex flex-col gap-4">
          <div id="quote-panel" className="scroll-mt-4">
            <Panel title="Quote & trade">
              <QuotePanel
                key={id}
                marketId={id}
                spec={spec}
                tradable={tradable}
                mu={mu}
                sigma={sigma}
                belief={m.belief}
                model={m.model}
                outcomeUnit={m.outcomeUnit}
                outcomeMin={m.outcomeMin}
                outcomeMax={m.outcomeMax}
                cfg={m.cfg}
                sellRequest={sellRequest}
              />
            </Panel>
          </div>
          <Panel title="Recent trades">
            <TradesTape tape={tape} />
          </Panel>
        </div>
      </div>

      {/* full-width positions ledger — clicking a holding jumps to Sell above */}
      <Panel
        title="Your positions"
        right={<span className="text-xs text-muted">click a holding to sell ↑</span>}
      >
        <PositionPanel
          marketId={id}
          onSell={handleSell}
          grid
          belief={{
            mu,
            sigma,
            outcomeUnit: m.outcomeUnit,
            outcomeMin: m.outcomeMin,
            outcomeMax: m.outcomeMax,
          }}
        />
      </Panel>
    </div>
  );
}
