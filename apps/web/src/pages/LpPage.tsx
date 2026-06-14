// Liquidity provision for one market: pool NAV / share price / your shares & %
// Deposit and Withdraw (with live pro-rata previews mirroring the engine's LP
// math), and a separate post-resolution Claim of your share of the final cash.

import { type UseMutationResult, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.tsx';
import { Button, ErrorNote, Panel, Spinner, Stat, StatusBadge } from '../components/ui.tsx';
import { qk, useLpView, useMarket } from '../hooks/queries.ts';
import { ApiError, api } from '../lib/api.ts';
import { lpDepositPreview, lpWithdrawPreview } from '../lib/derive.ts';
import { fmt, fmtPct, fmtSigned } from '../lib/format.ts';
import type { LpView } from '../lib/types.ts';

export function LpPage() {
  const { id = '' } = useParams();
  const market = useMarket(id);
  const lp = useLpView(id);

  if (lp.isLoading) return <Spinner label="Loading liquidity pool…" />;
  if (lp.error || !lp.data)
    return (
      <ErrorNote>
        {lp.error instanceof ApiError ? lp.error.message : 'Failed to load the pool.'}
      </ErrorNote>
    );

  const v = lp.data;
  const title = market.data?.title ?? 'Market';

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link to={`/markets/${id}`} className="text-sm text-muted hover:text-fg">
          ← {title}
        </Link>
        <div className="mt-1 flex items-center gap-3">
          <h1 className="text-xl font-semibold">Liquidity pool</h1>
          <StatusBadge status={v.status} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 rounded-xl border border-edge bg-panel surface shadow-soft p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Pool NAV" value={fmt(v.pool.nav)} tone="accent" />
        <Stat label="Share price" value={fmt(v.pool.sharePrice, 4)} />
        <Stat label="Total shares" value={fmt(v.pool.sharesTotal)} />
        <Stat label="Cash" value={fmt(v.pool.cash)} />
        <Stat label="Reserve" value={fmt(v.pool.reserveRequired)} />
        <Stat
          label="Your stake"
          value={v.your ? fmtPct(v.your.sharePct) : '—'}
          sub={v.your ? `${fmt(v.your.shares)} sh` : 'none'}
        />
      </div>

      <YourPosition view={v} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DepositCard marketId={id} view={v} />
        <WithdrawCard marketId={id} view={v} />
      </div>

      <ClaimCard marketId={id} view={v} />
    </div>
  );
}

function YourPosition({ view: v }: { view: LpView }) {
  if (!v.your || (v.your.shares === 0 && v.your.totalDeposited === 0))
    return (
      <Panel title="Your liquidity">
        <p className="p-4 text-sm text-muted">You have no stake in this pool yet.</p>
      </Panel>
    );
  const pnl = v.your.estValue + v.your.totalWithdrawn - v.your.totalDeposited;
  return (
    <Panel title="Your liquidity">
      <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Stat label="Est. value" value={fmt(v.your.estValue)} />
        <Stat label="Deposited" value={fmt(v.your.totalDeposited)} />
        <Stat label="Withdrawn" value={fmt(v.your.totalWithdrawn)} />
        <Stat label="LP PnL" value={fmtSigned(pnl)} tone={pnl >= 0 ? 'buy' : 'sell'} />
      </div>
    </Panel>
  );
}

function DepositCard({ marketId, view: v }: { marketId: string; view: LpView }) {
  const [amount, setAmount] = useState('');
  const n = Number(amount);
  const valid = amount !== '' && Number.isFinite(n) && n > 0;
  const open = v.status === 'OPEN';
  const preview = valid ? lpDepositPreview(n, v.pool) : null;
  const m = useLpMutation(marketId, (amt: number) =>
    api.lpDeposit(marketId, amt).then((r) => r.deposit.lp),
  );

  return (
    <Panel title="Deposit">
      <div className="flex flex-col gap-3 p-4">
        <NumInput
          value={amount}
          onChange={setAmount}
          placeholder="Amount to provide"
          disabled={!open}
        />
        {preview && (
          <p className="tnum text-xs text-muted">
            ≈ {fmt(preview.minted)} shares · {fmtPct(preview.sharePctAfter)} of the pool
          </p>
        )}
        {!open && (
          <p className="text-xs text-warn">Deposits are only allowed while the market is OPEN.</p>
        )}
        <Button
          variant="buy"
          disabled={!valid || !open || m.isPending}
          onClick={() => m.mutate(n, { onSuccess: () => setAmount('') })}
        >
          {m.isPending ? 'Depositing…' : 'Deposit'}
        </Button>
        <MutationNote m={m} okLabel="Deposited." />
      </div>
    </Panel>
  );
}

function WithdrawCard({ marketId, view: v }: { marketId: string; view: LpView }) {
  const [shares, setShares] = useState('');
  const n = Number(shares);
  const held = v.your?.shares ?? 0;
  const valid = shares !== '' && Number.isFinite(n) && n > 0 && held > 0;
  const open = v.status === 'OPEN';
  const preview = valid ? lpWithdrawPreview(n, v.pool, held) : null;
  const m = useLpMutation(marketId, (sh: number) =>
    api.lpWithdraw(marketId, sh).then((r) => r.withdraw.lp),
  );

  return (
    <Panel title="Withdraw">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <NumInput
            value={shares}
            onChange={setShares}
            placeholder="Shares to burn"
            disabled={!open || held === 0}
          />
          <Button
            variant="ghost"
            className="shrink-0 px-2.5 py-2 text-xs"
            disabled={!open || held === 0}
            onClick={() => setShares(String(held))}
          >
            Max
          </Button>
        </div>
        {preview && (
          <p className="tnum text-xs text-muted">
            ≈ {fmt(preview.cashOut)} cash · {fmt(preview.sharesAfter)} shares left. May partial-fill
            if it would breach the 1.2× reserve buffer.
          </p>
        )}
        {!open && <p className="text-xs text-warn">Withdrawals are only allowed while OPEN.</p>}
        <Button
          variant="sell"
          disabled={!valid || !open || m.isPending}
          onClick={() => m.mutate(n, { onSuccess: () => setShares('') })}
        >
          {m.isPending ? 'Withdrawing…' : 'Withdraw'}
        </Button>
        <MutationNote m={m} okLabel="Withdrawn." />
      </div>
    </Panel>
  );
}

function ClaimCard({ marketId, view: v }: { marketId: string; view: LpView }) {
  const qc = useQueryClient();
  const { user, setUser } = useAuth();
  const claim = useMutation({
    mutationFn: () => api.lpClaim(marketId).then((r) => r.claim),
    onSuccess: async (c) => {
      if (user && c.credited && !user.isInfinite)
        setUser({ ...user, balance: user.balance + c.credited });
      qc.setQueryData(qk.lp(marketId), c.lp);
      qc.invalidateQueries({ queryKey: qk.market(marketId) });
    },
  });

  // CLOSED keeps the LP claim open too — archival doesn't strand the residual.
  if (v.status !== 'SETTLED' && v.status !== 'CLOSED') return null;
  const claimed = v.your?.claimed ?? false;
  const hasStake = (v.your?.shares ?? 0) > 0 || (v.your?.totalDeposited ?? 0) > 0;
  if (!hasStake) return null;

  return (
    <Panel title="LP settlement claim">
      <div className="flex items-center justify-between gap-3 p-4">
        <p className="text-sm text-muted">
          The market is settled. Claim your pro-rata share of the pool's final cash.
        </p>
        <div className="flex items-center gap-2">
          {claim.isError && (
            <span className="text-xs text-sell">
              {claim.error instanceof ApiError ? claim.error.message : 'Claim failed.'}
            </span>
          )}
          {claim.data && (
            <span className="tnum text-xs text-buy">
              +{fmt(claim.data.credited)} ({fmtSigned(claim.data.pnl)} PnL)
            </span>
          )}
          {claimed && !claim.data ? (
            <span className="text-sm text-buy">claimed ✓</span>
          ) : (
            <Button
              variant="primary"
              disabled={claimed || claim.isPending}
              onClick={() => claim.mutate()}
            >
              {claim.isPending ? 'Claiming…' : 'Claim'}
            </Button>
          )}
        </div>
      </div>
    </Panel>
  );
}

function useLpMutation(marketId: string, fn: (n: number) => Promise<LpView>) {
  const qc = useQueryClient();
  const { user, setUser } = useAuth();
  return useMutation({
    mutationFn: fn,
    onSuccess: (lpView) => {
      qc.setQueryData(qk.lp(marketId), lpView);
      qc.invalidateQueries({ queryKey: qk.market(marketId) });
      qc.invalidateQueries({ queryKey: qk.portfolio });
      // balance moved (unless infinite admin) — re-pull the authoritative number.
      // Fire-and-forget: react-query lands the mutation in ERROR state if onSuccess
      // throws, so a hiccup on this refresh must NOT mark a deposit/withdraw that
      // already committed as "failed". The deposit succeeded; the balance just
      // syncs a beat later.
      if (user && !user.isInfinite) {
        api
          .me()
          .then((me) => setUser(me.user))
          .catch(() => {});
      }
    },
  });
}

function MutationNote({
  m,
  okLabel,
}: { m: UseMutationResult<LpView, unknown, number>; okLabel: string }) {
  if (m.isError)
    return (
      <p className="text-xs text-sell">
        {m.error instanceof ApiError ? m.error.message : 'Request failed.'}
      </p>
    );
  if (m.isSuccess) return <p className="text-xs text-buy">{okLabel}</p>;
  return null;
}

function NumInput({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      min={0}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="tnum w-full rounded-lg border border-edge bg-panel-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent input-glow disabled:opacity-50"
    />
  );
}
