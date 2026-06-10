# TASKS — BMM Continuous Prediction Market **V2**

Phased plan for V2. Companion to `V2-TDD.md`. **Prerequisite: V1 shipped and in use** (`TDD.md` / `TASKS.md` done). All V2 work is additive — V1 markets keep behaving exactly as before (`belief_kind='gaussian'`, leverage 1×).

Legend: `core`/`shared`/`api`/`web` as in V1. Each phase ends with a runnable checkpoint. `[blocked-by]` = hard deps.

> ** Math-doc sync (standing rule).** The interactive math documentation (`docs/math/index.html`) is the public source-of-truth explainer for the model. **After every phase that changes the math** — new belief models, pricing/`dPrice_dMu`, margin/liquidation formulas, adaptive-parameter rules, hedging, reserve/sampler changes — its checkpoint is **not complete** until `docs/math/index.html` is updated to match: add/derive the new formulas, refresh any affected worked examples (re-compute the numbers), extend the relevant background blocks, and keep both Trader and Developer modes consistent with the shipped code. Verify the doc renders (0 tag errors, 0 KaTeX errors) before closing the phase. Phases that touch no math (e.g. KYC tiers, scale/ops, transaction ledger) need no math-doc change — note "math-doc: n/a" in the checkpoint.

**Recommended order:** V2-1 (beliefs) and V2-2 (tiers) in parallel → V2-3 (leverage/margin/liquidation) → V2-4 (insurance) → V2-5/6/7 (adaptive, hedging, oracles) → V2-8 (scale) → V2-9 (hardening). Insurance (V2-4) is pulled before the rest because liquidation gap-loss depends on it.

---

## Phase V2-1 — Multi-modal beliefs `[core, api, web]` (Workstream A)
**Goal:** markets can run on Gaussian Mixture or Student-t, fully priced.
- [ ] `core/mixture.ts`: `MixtureBelief implements BeliefModel` (sample/pdf/cdf/quantile/mean/variance/serialize).
- [ ] `core/student_t.ts`: `StudentTBelief implements BeliefModel`.
- [ ] `pricing.ts`: mixture price = Σ π_k·componentPrice (reuse V1 closed forms); t price via existing Gauss–Hermite fallback; generalize `dPrice_dMu`.
- [ ] `bayes.ts` + new `mixture_ops.ts`: per-component update + weight update (`MODEL.md §5.4`); prune / merge / (optional) split.
- [ ] `solvency.ts`: route mixture/t through seeded MC reserve (sampler per kind).
- [ ] `api`: market creation accepts `belief_kind`, components/ν; persist + serialize via flexible jsonb; belief-update path is kind-agnostic.
- [ ] `web`: belief chart renders general pdf (multi-bump / fat tail) + component legend; creation editor for modes.
- [ ] **Tests:** mixture price = weighted component sum (vs MC); merge/prune conserve mass+mean; t price vs MC; weight concentrates on consistent-signal component.
**Checkpoint:** create a bimodal-mixture market, trade it, watch component weights shift live and prices stay consistent with MC. **Math-doc:** add the Mixture/Student-t belief, `Σ π_k·componentPrice` pricing, generalized `dPrice_dMu`, per-component Bayes + weight update, and the per-kind MC sampler; new worked example for a bimodal price.

---

## Phase V2-2 — KYC tiers, limits, compliance `[api, web]` (Workstream F)
**Goal:** tiered accounts that gate limits & (later) leverage.
- [ ] `users` + `kyc_tier/kyc_status/country/leverage_cap`; migration (defaults = Anonymous, 1×).
- [ ] Mock KYC flow: `POST /users/me/kyc` (submit), `POST /admin/users/:id/kyc/approve` → advances tier.
- [ ] `LimitsSvc`: deposit/withdraw/position limits per tier (`MODEL.md §9.3, §19.1`); enforced centrally.
- [ ] Geofencing middleware (IP→country, blocklist, mockable).
- [ ] `audit_events` append-only + writes on admin/top-up/tier/lifecycle actions; admin audit view.
- [ ] `web`: KYC upgrade flow; tier badge; limit-aware errors.
**Checkpoint:** a user upgrades tier via admin approval, gains higher limits; blocked country is geofenced; admin sees audit trail.

---

## Phase V2-3 — Leverage, margin, shorting, liquidation `[core, api, web]` (Workstream B) `[blocked-by: V2-2, V2-4]`
**Goal:** the `MODEL.md §9.2/§9.3` system — borrowed exposure made safe.
- [ ] `core/margin.ts`: `margin_required = Σ|pos|·margin_rate·price`; equity, free margin, maintenance, health, liquidation region.
- [ ] `positions.quantity` may be negative (short); `margin_accounts` table; per-contract `margin_rate` in cfg.
- [ ] `TradeEngine`: initial-margin gate to open/increase, tier-leverage cap, position-limit check; shorts allowed (negative q); MM reserve still covers net `L(θ)`.
- [ ] `LiquidationSvc`: event-driven (on belief/price update) + periodic sweep; if `equity < maintenance` → close positions to restore; penalty → insurance fund; gap loss → insurance; emit `margin_call`/`liquidation`.
- [ ] Short settlement at resolution (short of ITM contract pays out).
- [ ] `web`: leverage selector + margin/liquidation preview in trade panel; portfolio health bars, liquidation distance, short positions, liquidation history.
- [ ] **Tests:** margin gates; price-move triggers liquidation; gap loss hits insurance; shorts settle; tier leverage never exceeded.
**Checkpoint:** open a 5× leveraged position, push the belief against it, watch margin call → liquidation → insurance-fund draw; short a call and settle it correctly. **Math-doc:** add the margin/equity/health formulas, the liquidation trigger (`equity < maintenance`), penalty/gap-loss flow, and short-payout settlement; worked example of a margin call.

---

## Phase V2-4 — Insurance fund `[api, web]` (Workstream H) `[blocked-by: none; needed by V2-3]`
**Goal:** protocol backstop with real accounting.
- [ ] `insurance_fund` + `insurance_ledger`; `+= fee_pct × volume` on trades; liquidation penalties in.
- [ ] Draw path for bankruptcy / liquidation gap / socialized loss (`MODEL.md §8.2, §15.2`).
- [ ] `GET /admin/insurance` dashboard: balance, inflows/outflows, coverage ratio, alert under threshold.
- [ ] **Tests:** ledger balances (inflows−outflows=balance); coverage alert fires.
**Checkpoint:** trading accrues fund; a forced bankruptcy is absorbed; admin sees the draw and coverage ratio.

---

## Phase V2-5 — Adaptive parameters `[core, api, web]` (Workstream C) `[blocked-by: V2-1]`
**Goal:** self-tuning σ_ε and spreads (`MODEL.md §14.2`).
- [ ] EWMA `σ_ε`, regime-scaled `s₀`, optional adaptive `α/β`; all clamped to `§14.1` rails.
- [ ] `market_cfg_history` time series; admin pin/override; rail-hit circuit breaker.
- [ ] Extend V1 sim/backtest tool to compare adaptive vs static (accuracy, calibration, MM PnL).
- [ ] `web`: admin adaptive-param charts; `param_adapted` WS.
**Checkpoint:** in a volatile simulated run, spreads/σ_ε adapt within rails and calibration improves vs static. **Math-doc:** add the EWMA `σ_ε`, regime-scaled `s₀`, optional adaptive `α/β`, and the `§14.1` clamp rails to the spread/Bayes background; note which V1 constants become dynamic.

---

## Phase V2-6 — Hedging `[core, api, web]` (Workstream D) `[blocked-by: V2-1]`
**Goal:** reduce reserve via offsetting positions (`MODEL.md §6.4`).
- [ ] `find_best_hedge(exposure)` over a binary/spread basis tiling Θ; trigger when `reserve > cash×0.8`.
- [ ] Internal hedge bookkeeping (lowers `L(θ)` variance); `hedges` table.
- [ ] `ExternalHedgeProvider` interface + **mock** provider.
- [ ] `web`: admin hedge book + reserve before/after.
- [ ] **Tests:** hedge reduces reserve; bookkeeping neutral to user payouts.
**Checkpoint:** a high-reserve market auto-hedges and frees capital; admin sees the hedge book. **Math-doc:** add how an offsetting basis position lowers `L(θ)` variance and the reserve, with a before/after reserve worked example.

---

## Phase V2-7 — Robust oracles & disputes `[api, web]` (Workstream E)
**Goal:** real feeds, aggregation, dispute handling (`MODEL.md §11`).
- [ ] `OracleSource` interface + `ApiFeed`, `WeatherApi`, `Manual`, `Aggregated` (median/weighted+confidence) adapters; `oracle_sources`/`oracle_reports`.
- [ ] Auto-resolve at `resolves_at`; missing-feed → SUSPEND+alert (`§15.1`).
- [ ] Dispute window post-RESOLVED; `disputes` table; resolution via admin override + secondary oracle; claims gated until window closes.
- [ ] `web`: admin oracle config + dispute queue; user `dispute` action in window.
- [ ] **Tests:** aggregation/median correct; missing feed suspends; dispute blocks claims, resolves correctly.
**Checkpoint:** a market auto-resolves from an aggregated feed; a disputed resolution is overridden by admin before claims open.

---

## Phase V2-8 — Scale & ops `[api]` (Workstream G) `[blocked-by: V2-3]`
**Goal:** horizontal scale with sequential-consistency preserved (`MODEL.md §18.2`).
- [ ] Redis: WS pub/sub fan-out across nodes; per-market **distributed lock** (Redlock) replacing in-process queue; hot cache for belief/quote snapshots.
- [ ] Single-leader-per-market via consistent-hash on `market_id`; non-owners forward writes; reads anywhere.
- [ ] Postgres read replicas for GET/history/stats; shard-by-`market_id` plan/migration.
- [ ] Gateway rate limiting; structured logs + metrics (trade latency, reserve util, liquidations) + health/readiness probes.
- [ ] **Tests:** concurrent trades on one market across 2 nodes stay sequentially consistent (no reserve double-spend).
**Checkpoint:** run 2 API nodes behind a balancer; parallel trades on the same market remain consistent; reads scale on replicas.

---

## Phase V2-10 — Transaction ledger & history `[shared, api, web]` (Workstream I) `[blocked-by: none]`
**Goal:** a single source-of-truth ledger that records every cash movement, surfaced to each user as a "Transactions" tab with filtering, sorting, and lifetime stats. Additive — no change to how cash actually moves; we just record it.

**Design:** a `transactions` table written **atomically inside the same `db.transaction()`** as each balance/cash mutation (the existing post-commit `audit_events` is incomplete and can't be the source). User-centric: each row belongs to a `userId` (whose history it is) with a signed `amount` (+ into wallet, − out), `balanceAfter` (null for infinite/admin accounts), `marketId`, `counterpartyId`, `refType`/`refId`, and `metadata` jsonb. Admin funding writes **two** rows (`admin_credit` on the target, `admin_grant` on the admin) so it shows in both histories. Kinds: `trade_buy, trade_sell, market_create, lp_deposit, lp_withdraw, lp_claim, claim, refund, admin_credit, admin_grant`.

- **TX-1 — Backend ledger `[shared, api]`:** DONE (2026-06-09)
  - [x] `shared`: `TransactionKind` enum (10 kinds). (`TransactionView` DTO deferred to TX-2 with the read endpoint.)
  - [x] `schema.ts`: `transactions` table (indexed `(user_id, created_at)`, `market_id`); migration `0002_eager_echo.sql` applied; added to `schema` export.
  - [x] `services/ledgerSvc.ts`: `recordTx(exec, entry)` / `recordTxs` — insert inside the caller's transaction (executor = `Tx` or `db`).
  - [x] Wired into every cash path: `tradeSvc.executeTrade` (trade_buy/sell), `marketSvc.createMarket` (market_create) + cancel `settleSvc.refundPositions` (refund), `lpSvc.deposit/withdraw/claim`, `settleSvc.claimPayout` (claim), admin top-up via new `services/fundingSvc.ts` (admin_credit + admin_grant; replaced dead `repos.credit`).
  - [x] **Tests:** `test/ledger.test.ts` — 6 integration cases (topup two-row, market_create, trade_buy, lp_deposit, claim, cancel refund); updated every suite's + `demo` cleanup to delete `transactions` first (FKs are RESTRICT). Suite: api 89, all packages green (shared 9 + core 117 + web 71 + api 89); typecheck 4/4; lint clean.
  - **Checkpoint:** ledger rows written atomically per cash path; new integration tests pass.
- **TX-2 — Read API + stats `[api]`:** DONE (2026-06-09)
  - [x] `GET /users/me/transactions` (`routes/users.ts`) → caller's history newest-first (joined market title + counterparty username) + `summary` (count, funded, claimed, tradeBuy, tradeSell, lpDeposited, lpWithdrawn, refunded, net).
  - [x] `services/ledgerView.ts`: `getUserTransactions` + pure `summarizeTransactions` (response shapes `TransactionView`/`TransactionSummary` defined here, mirrored in web at TX-3 per repo convention).
  - [x] **Tests:** `test/ledgerView.test.ts` (pure summarize, 3) + integration GET case in `ledger.test.ts` (scoping, newest-first ordering, summary ≥ this-suite totals, counterparty/title joins). Purged 72 orphaned `(test)` markets from the dev DB. Suite api 93, all packages green; typecheck 4/4; lint clean.
- **TX-3 — Frontend Transactions tab `[web]`:** DONE (2026-06-09)
  - [x] Route `/transactions` (under `RequireAuth`) + nav link after Portfolio.
  - [x] `TransactionsPage` mirroring `PortfolioPage`: stats header (Entered platform / Claimed / Trade volume / Net), category chips + free-text search + sort select, ledger table (kind badge, market link or funding counterparty, signed amount, balanceAfter (∞ for admin), relative time), persistent `transactions.category`/`transactions.sort`.
  - [x] `lib/txView.ts` (pure: sort keys, category buckets, labels, filter/sort); `lib/types.ts` `Transaction`/`TransactionSummary`/`UserTransactions`; `lib/api.ts` `transactions()` + `hooks/queries.ts` `useTransactions`; formatting via `fmt`/`fmtSigned`/`timeAgo`.
  - [x] **Tests:** `test/txView.test.ts` (8) — category/label maps, filter (category + text + compose), sort (recent/oldest/amount, no-mutate). web 79 pass; build 123 kB gzip.
  - **Checkpoint:** a user opens Transactions and sees every action with lifetime stats; admin's grants and the funded user's credit each appear in their own history.

**V2-10 status:** TX-1/TX-2/TX-3 all — transaction history feature complete end-to-end. (V2-11 admin market history NOT started — awaiting user go-ahead.)

---

## Phase V2-11 — Admin market history & panel restructure `[api, web]` (Workstream I) `[blocked-by: none]`
**Goal:** an **admin-only** per-market cash-flow history (the market pool's "bank statement") plus a reorganized admin panel split into focused tabs. No new write-path: the market ledger is **reconstructed by aggregation** from data we already store — every trade's premium flow (`trades.totalCost` in/out of `markets.cash`), the genesis reserve / LP deposits-withdrawals-claims (`lp_ledger`, including the creator's initial liquidity), trader settlement payouts (`claims`), and cancel refunds. Use whichever of trades vs positions is more efficient and accurate for each figure (trades for flow events, positions for net exposure). User-facing transaction history (V2-10) stays user-side only; this is the complementary admin view.

- **MH-1 — Market ledger read service `[api]`:** DONE (2026-06-09)
  - [x] `services/marketLedgerSvc.ts` (read-only): assembles a time-ordered market cash-flow ledger from `lp_ledger` (genesis via `navBefore=0` + deposits/withdraws/claims) + `trades` (signed `totalCost`) + cancel refunds (the per-trader `transactions` refund rows) + `claims` (trader payouts), each as `{ at, kind, delta (signed on the pool), affectsCash, cashAfter, userId, username, ref, note }`; plus rollups (genesisReserve, premiumIn/Out, lpDeposits/Withdrawals, refunds, traderPayouts, lpClaimsPaid, netPoolChange, currentCash, reserveRequired, nav, cashFinal, `reconciles`). Settlement distributions (trader/LP payouts) carry `affectsCash:false` since by design they don't mutate `markets.cash` (residual computed logically); the cash-affecting deltas sum exactly to `markets.cash`.
  - [x] `GET /admin/markets/:id/ledger` (admin-only) → `{ ledger: { events, rollup } }`.
  - [x] **Tests:** `test/marketLedger.test.ts` — genesis+trades+LP reconstruct & reconcile to `markets.cash`; settlement records payouts without moving cash; cancel refunds reduce the pool & still reconcile; admin-only (403)/404. (api 99 green.)
- **MH-2 — Admin panel restructure `[web]`:** DONE (2026-06-09)
  - [x] Split `/admin` into in-page tabs (persistent `admin.tab`): **Markets** (lifecycle list → per-market Overview / **Cash-flow ledger** sub-tabs), **Users** (list + top-up + each user's tx history via new admin-only `GET /admin/users/:id/transactions`), **Create market**, **System** (alerts + system overview). `RequireAdmin` unchanged.
  - [x] `components/MarketLedgerView.tsx`: rollup `Stat` cards + reconcile badge + filterable/sortable event table; `lib/marketLedgerView.ts` (pure category/label/filter/sort) persisted via `usePersistentState`.
  - [x] **Tests:** `test/marketLedgerView.test.ts` (8) — category/label maps, filter (category + text + compose), sort (recent/oldest/amount, no-mutate). web 87 green; build 126 kB gzip.
  - **Checkpoint:** an admin opens a market and sees its full cash-flow statement reconciling to current pool cash; the admin panel is organized into clear tabs.

**V2-11 status:** MH-1/MH-2 both — admin market-history ledger + tabbed admin panel complete end-to-end.

---

## Phase V2-9 — Hardening & polish `[all]` `[blocked-by: all]`
- [ ] Full V2 integration suite across workstreams; migration test (V1 data → V2 unchanged behavior).
- [ ] Extended Monte-Carlo sim covering leverage/liquidation cascades and multi-modal calibration.
- [ ] Load test (multi-node + Redis); chaos test (node loss mid-trade).
- [ ] Docs refresh; ops runbook (oracle failure, mass liquidation, insurance depletion).
- [ ] **Final math-doc pass:** audit `docs/math/index.html` end-to-end against shipped V2 code (every formula, constant, and worked example re-computed; both modes consistent; 0 tag/KaTeX errors) — the per-phase syncs land incrementally, this is the consolidating review.
**Checkpoint:** `bun test` green; load/chaos pass; V1 markets verified unchanged; demo script exercises beliefs + leverage + liquidation + disputes + insurance end-to-end.

---

## Phase V2-12 — Belief-history visualization in the main chart `[web]` `[blocked-by: all]` (Workstream J)
**Goal:** let the **main belief chart** (`apps/web/src/components/BeliefChart.tsx`) show *how the consensus got here*, not just its current shape — encoding **time without a time axis** (the main chart's x-axis is the outcome θ). Pure presentation: no engine/math change. **Do last**, after the whole V2 build is otherwise done.

**Design (decided):** a **ghost trail** — overlay faded snapshots of recent belief PDFs on the same θ-axis, older = more transparent, newest = solid, so the bump visibly drifts and narrows like a comet tail. Time → opacity. Gated behind a small "show history" toggle so the live chart stays clean by default. For V2 mixtures, the ghost is the general multi-modal `pdf(θ)`, so disagreement-then-consensus reads as two bumps fading into one.

**Data dependency (the gating decision):** the ghost trail needs each history point to carry **both μ and σ** (mixture: the full component set) to redraw the past curve. Today `beliefHistory` powers "Belief μ over time" and may store μ only. So:
- [ ] Confirm/extend the belief-history record to log the full belief **snapshot** (`μ, σ²` for Gaussian; serialized components for mixture/t) per sampled point — reuse the existing `BeliefStateDTO` serialization, sampled/throttled to keep the series light.
- [ ] `lib/viz.ts`: pure helper to build N faded PDF polylines from a snapshot series (newest-first opacity ramp; cap the count, e.g. last ~8 snapshots, evenly spaced over the market's life).
- [ ] `BeliefChart.tsx`: render the ghost layer **under** the live PDF/payoff; "show history" toggle (persisted) defaulting off; reuse the existing left-axis likelihood scale (peak-normalise each ghost to the *current* peak so shrinkage is visible).
- [ ] *(Optional, stretch)* a scrubber / play button that animates the PDF morphing past → present (time as the animation clock) and/or a faint "lifetime μ±σ envelope" showing where belief has wandered.
- [ ] **Tests:** the pure ghost-builder (opacity ramp monotone, snapshot cap, ordering, no-mutate); chart renders with 0/1/many snapshots without layout breakage.
**Checkpoint:** toggling "show history" on a live market shows the belief's comet-tail drifting/narrowing over its life; off by default leaves the chart unchanged. **Math-doc:** n/a (presentation only).

---

### Definition of done (V2)
Markets run on Gaussian / Mixture / Student-t beliefs with correct pricing and component management; users trade with tier-based **leverage and shorting** under margin gates, with an automated **liquidation engine** and an **insurance fund** backstop; parameters **self-tune** within spec rails; the MM **hedges** to free reserve; markets resolve from **aggregated oracles** with a **dispute** process; **KYC tiers/limits/geofencing/audit** enforce compliance; the system scales **horizontally** while preserving per-market sequential consistency. All V1 behavior is preserved for existing markets.
