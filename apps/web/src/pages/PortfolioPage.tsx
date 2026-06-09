// Portfolio — every market the user has touched, grouped, with per-market P&L
// peak/drawdown, the resolved outcome, and a market-level Claim. Each position
// draws its own payoff diagram (P&L vs outcome) and expands into deeper stats.
// Two layouts: an *inline* mode (markets expand to show their positions in place)
// and a *compact* mode (markets are tiles; clicking one opens a positions modal).
// A status / profit-loss filter bar and a shared position sort apply to both.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.tsx';
import {
  type PositionBelief,
  PositionRow,
  PositionSortSelect,
} from '../components/PositionPanel.tsx';
import {
  Button,
  ErrorNote,
  Modal,
  Panel,
  Spinner,
  Stat,
  StatusBadge,
  Toggle,
} from '../components/ui.tsx';
import { qk, useMarkets, usePortfolio } from '../hooks/queries.ts';
import { ApiError, api } from '../lib/api.ts';
import { type MarketGroup, groupPositionsByMarket, groupTotalPnl } from '../lib/derive.ts';
import { fmt, fmtSigned } from '../lib/format.ts';
import { type PositionSortKey, isClosedPosition, sortPositions } from '../lib/positionView.ts';

type PnlFilter = 'all' | 'profit' | 'loss';
// Canonical status order; only buckets actually present become chips.
const STATUS_ORDER = ['OPEN', 'SUSPENDED', 'RESOLVED', 'SETTLED', 'CREATED'] as const;

export function PortfolioPage() {
  const portfolio = usePortfolio();
  const markets = useMarkets();

  const [sort, setSort] = useState<PositionSortKey>('recent');
  const [inline, setInline] = useState(true);
  const [showClosed, setShowClosed] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [pnlFilter, setPnlFilter] = useState<PnlFilter>('all');
  const [modalId, setModalId] = useState<string | null>(null);

  // marketId → live belief context, so each position can draw its payoff curve.
  const beliefs = useMemo(() => {
    const map = new Map<string, PositionBelief>();
    for (const m of markets.data ?? []) {
      map.set(m.marketId, {
        mu: m.belief.mu,
        sigma: m.belief.sigma,
        outcomeUnit: m.outcomeUnit,
        outcomeMin: m.outcomeMin,
        outcomeMax: m.outcomeMax,
      });
    }
    return map;
  }, [markets.data]);

  const groups = useMemo(
    () => groupPositionsByMarket(portfolio.data?.positions ?? []),
    [portfolio.data],
  );

  // Status buckets present, in canonical order, for the filter chips.
  const statuses = useMemo(() => {
    const present = new Set(groups.map((g) => g.marketStatus));
    return STATUS_ORDER.filter((s) => present.has(s));
  }, [groups]);

  // How many fully-exited (zero-size) positions exist, so the toggle can advertise itself.
  const closedCount = useMemo(
    () => (portfolio.data?.positions ?? []).filter(isClosedPosition).length,
    [portfolio.data],
  );

  const visible = useMemo(
    () =>
      groups.filter((g) => {
        if (statusFilter !== 'ALL' && g.marketStatus !== statusFilter) return false;
        const total = groupTotalPnl(g);
        if (pnlFilter === 'profit' && total < 0) return false;
        if (pnlFilter === 'loss' && total >= 0) return false;
        // Hiding closed positions can empty a market entirely — drop those cards.
        if (!showClosed && !g.positions.some((p) => !isClosedPosition(p))) return false;
        return true;
      }),
    [groups, statusFilter, pnlFilter, showClosed],
  );

  if (portfolio.isLoading) return <Spinner label="Loading portfolio…" />;
  if (portfolio.error)
    return (
      <ErrorNote>
        {portfolio.error instanceof ApiError
          ? portfolio.error.message
          : 'Failed to load portfolio.'}
      </ErrorNote>
    );

  const totals = portfolio.data?.totals;
  const claimable = groups.filter((g) => g.claimable).length;
  const modalGroup = modalId ? (groups.find((g) => g.marketId === modalId) ?? null) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-gradient text-2xl font-semibold tracking-tight">Portfolio</h1>
        <span className="text-sm text-muted">
          {visible.length === groups.length
            ? `${groups.length} market${groups.length === 1 ? '' : 's'}`
            : `${visible.length} of ${groups.length} markets`}
        </span>
      </div>

      {totals && (
        <div className="overflow-hidden rounded-xl border border-edge bg-panel">
          <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
            <Stat label="Market value" value={fmt(totals.marketValue)} />
            <Stat
              label="Unrealized PnL"
              value={fmtSigned(totals.unrealized)}
              tone={totals.unrealized >= 0 ? 'buy' : 'sell'}
            />
            <Stat
              label="Realized PnL"
              value={fmtSigned(totals.realized)}
              tone={totals.realized >= 0 ? 'buy' : 'sell'}
            />
            <Stat
              label="Total PnL"
              value={fmtSigned(totals.total)}
              tone={totals.total >= 0 ? 'buy' : 'sell'}
            />
          </div>
          <PnlBar realized={totals.realized} unrealized={totals.unrealized} />
        </div>
      )}

      {claimable > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft px-4 py-2.5 text-sm text-accent animate-fade-in">
          <span className="text-base">🎉</span>
          You have payouts to claim in {claimable} settled market{claimable === 1 ? '' : 's'}.
        </div>
      )}

      {groups.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-panel px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {/* status filter */}
            <div className="flex flex-wrap items-center gap-1">
              <Chip active={statusFilter === 'ALL'} onClick={() => setStatusFilter('ALL')}>
                All
              </Chip>
              {statuses.map((s) => (
                <Chip key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)}>
                  {s}
                </Chip>
              ))}
            </div>
            {/* profit / loss filter */}
            <div className="flex items-center gap-1">
              <Chip active={pnlFilter === 'all'} onClick={() => setPnlFilter('all')}>
                Any P&L
              </Chip>
              <Chip
                active={pnlFilter === 'profit'}
                onClick={() => setPnlFilter('profit')}
                tone="buy"
              >
                In profit
              </Chip>
              <Chip active={pnlFilter === 'loss'} onClick={() => setPnlFilter('loss')} tone="sell">
                At a loss
              </Chip>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {closedCount > 0 && (
              <span className="flex items-center gap-1.5 text-[11px] text-muted">
                <span>Closed</span>
                <Toggle
                  checked={showClosed}
                  onChange={setShowClosed}
                  label="Show closed positions"
                />
              </span>
            )}
            <PositionSortSelect value={sort} onChange={setSort} />
            <span className="flex items-center gap-1.5 text-[11px] text-muted">
              <span>Expand</span>
              <Toggle checked={inline} onChange={setInline} label="Expand positions inline" />
            </span>
          </div>
        </div>
      )}

      {groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-edge p-10 text-center text-muted">
          You haven't traded yet.{' '}
          <Link to="/" className="text-accent hover:underline">
            Browse markets →
          </Link>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-edge p-10 text-center text-muted">
          No markets match the current filters.
        </div>
      ) : inline ? (
        visible.map((g) => (
          <GroupCard
            key={g.marketId}
            group={g}
            belief={beliefs.get(g.marketId)}
            sort={sort}
            showClosed={showClosed}
          />
        ))
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((g) => (
            <MarketTile
              key={g.marketId}
              group={g}
              showClosed={showClosed}
              onOpen={() => setModalId(g.marketId)}
            />
          ))}
        </div>
      )}

      {modalGroup && (
        <PositionsModal
          group={modalGroup}
          sort={sort}
          showClosed={showClosed}
          onClose={() => setModalId(null)}
        />
      )}
    </div>
  );
}

function PnlBar({ realized, unrealized }: { realized: number; unrealized: number }) {
  const mag = Math.abs(realized) + Math.abs(unrealized);
  if (mag < 1e-9) return null;
  const rPct = (Math.abs(realized) / mag) * 100;
  const uPct = (Math.abs(unrealized) / mag) * 100;
  return (
    <div className="border-t border-edge px-4 py-3">
      <div className="flex h-2 overflow-hidden rounded-full bg-panel-2">
        <span
          className={realized >= 0 ? 'bg-buy' : 'bg-sell'}
          style={{ width: `${rPct}%` }}
          title={`Realized ${fmtSigned(realized)}`}
        />
        <span
          className={unrealized >= 0 ? 'bg-buy/60' : 'bg-sell/60'}
          style={{ width: `${uPct}%` }}
          title={`Unrealized ${fmtSigned(unrealized)}`}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] uppercase tracking-wide text-muted">
        <span>realized {fmtSigned(realized, 0)}</span>
        <span>unrealized {fmtSigned(unrealized, 0)}</span>
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  tone = 'fg',
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone?: 'fg' | 'buy' | 'sell';
  children: ReactNode;
}) {
  const activeCls =
    tone === 'buy'
      ? 'border-buy/50 bg-buy/15 text-buy'
      : tone === 'sell'
        ? 'border-sell/50 bg-sell/15 text-sell'
        : 'border-accent/50 bg-accent-soft text-accent';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
        active ? activeCls : 'border-edge bg-panel-2 text-muted hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}

// Settled-market claim banner + button. Encapsulates the claim mutation so both
// the inline card and the modal can offer it. Renders nothing if not claimable.
function ClaimBanner({ marketId, claimable }: { marketId: string; claimable: boolean }) {
  const qc = useQueryClient();
  const { user, setUser } = useAuth();
  const claim = useMutation({
    mutationFn: () => api.claim(marketId).then((r) => r.claim),
    onSuccess: (c) => {
      if (user && c.credited && !user.isInfinite)
        setUser({ ...user, balance: user.balance + c.credited });
      qc.invalidateQueries({ queryKey: qk.portfolio });
    },
  });
  if (!claimable) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-b border-edge bg-accent-soft px-4 py-2 text-sm">
      <span className="text-accent">This market is settled — claim your payouts.</span>
      <div className="flex items-center gap-2">
        {claim.isError && (
          <span className="text-xs text-sell">
            {claim.error instanceof ApiError ? claim.error.message : 'Claim failed.'}
          </span>
        )}
        <Button
          variant="primary"
          className="px-3 py-1.5 text-xs"
          disabled={claim.isPending}
          onClick={() => claim.mutate()}
        >
          {claim.isPending ? 'Claiming…' : 'Claim payouts'}
        </Button>
      </div>
    </div>
  );
}

function GroupSummary({ group: g }: { group: MarketGroup }) {
  const total = groupTotalPnl(g);
  return (
    <span className="flex items-center gap-3 text-xs">
      <span className="tnum text-muted">
        value {fmt(g.value)} · peak {fmtSigned(g.peakProfit)} · dd {fmt(g.drawdownFromPeak)}
      </span>
      <span className={`tnum font-semibold ${total >= 0 ? 'text-buy' : 'text-sell'}`}>
        {fmtSigned(total)}
      </span>
    </span>
  );
}

function viewPositions(g: MarketGroup, sort: PositionSortKey, showClosed: boolean) {
  const rows = showClosed ? g.positions : g.positions.filter((p) => !isClosedPosition(p));
  return sortPositions(rows, sort);
}

function GroupCard({
  group: g,
  belief,
  sort,
  showClosed,
}: {
  group: MarketGroup;
  belief?: PositionBelief;
  sort: PositionSortKey;
  showClosed: boolean;
}) {
  const [open, setOpen] = useState(true);
  const positions = viewPositions(g, sort, showClosed);

  return (
    <Panel
      className="animate-fade-up"
      title={
        <span className="flex items-center gap-2">
          <Link to={`/markets/${g.marketId}`} className="hover:text-accent">
            {g.marketTitle}
          </Link>
          <StatusBadge status={g.marketStatus} />
        </span>
      }
      right={
        <div className="flex items-center gap-3">
          <GroupSummary group={g} />
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? 'Collapse' : 'Expand'}
            className="text-muted transition-colors hover:text-fg"
          >
            {open ? '▾' : '▸'}
          </button>
        </div>
      }
    >
      <ClaimBanner marketId={g.marketId} claimable={g.claimable} />
      {open && (
        <div className="grid grid-cols-1 items-start gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">
          {positions.map((p, i) => (
            <div
              key={p.contractId}
              style={{ animationDelay: `${Math.min(i, 6) * 40}ms` }}
              className="animate-fade-up rounded-lg border border-edge bg-panel-2/30"
            >
              <PositionRow pos={p} belief={belief} hideClaim />
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function MarketTile({
  group: g,
  showClosed,
  onOpen,
}: {
  group: MarketGroup;
  showClosed: boolean;
  onOpen: () => void;
}) {
  const total = groupTotalPnl(g);
  const shown = showClosed
    ? g.positions.length
    : g.positions.filter((p) => !isClosedPosition(p)).length;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="animate-fade-up flex flex-col gap-3 rounded-xl border border-edge bg-panel p-4 text-left transition-colors hover:border-muted hover:bg-panel-2/40"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-semibold text-fg">{g.marketTitle}</span>
        <StatusBadge status={g.marketStatus} />
      </div>
      <div className="flex items-end justify-between gap-2">
        <span className="text-xs text-muted">
          {shown} position{shown === 1 ? '' : 's'} · value {fmt(g.value)}
        </span>
        <span className={`tnum text-base font-semibold ${total >= 0 ? 'text-buy' : 'text-sell'}`}>
          {fmtSigned(total)}
        </span>
      </div>
      <span className="flex items-center gap-2 text-[11px] text-accent">
        {g.claimable && <span className="text-accent">🎉 payouts to claim</span>}
        <span className="ml-auto">View positions →</span>
      </span>
    </button>
  );
}

// Modal listing one market's positions, with a jump to its trading page. Cards
// are compact (no payoff chart — that lives on the full market page); each row
// still expands into its deeper stats.
function PositionsModal({
  group: g,
  sort,
  showClosed,
  onClose,
}: {
  group: MarketGroup;
  sort: PositionSortKey;
  showClosed: boolean;
  onClose: () => void;
}) {
  const positions = viewPositions(g, sort, showClosed);
  return (
    <Modal
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          {g.marketTitle}
          <StatusBadge status={g.marketStatus} />
        </span>
      }
      right={
        <Link
          to={`/markets/${g.marketId}`}
          className="rounded-lg border border-edge bg-panel-2 px-3 py-1.5 text-xs font-semibold text-fg transition-colors hover:border-accent hover:text-accent"
        >
          Open market →
        </Link>
      }
    >
      <ClaimBanner marketId={g.marketId} claimable={g.claimable} />
      <div className="border-b border-edge px-4 py-2 text-xs">
        <GroupSummary group={g} />
      </div>
      <div className="grid grid-cols-1 items-start gap-3 p-3 md:grid-cols-2">
        {positions.map((p) => (
          <div key={p.contractId} className="rounded-lg border border-edge bg-panel-2/30">
            <PositionRow pos={p} hideClaim />
          </div>
        ))}
      </div>
    </Modal>
  );
}
