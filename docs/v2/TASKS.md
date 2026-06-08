# TASKS — BMM Continuous Prediction Market **V2**

Phased plan for V2. Companion to `V2-TDD.md`. **Prerequisite: V1 shipped and in use** (`TDD.md` / `TASKS.md` done). All V2 work is additive — V1 markets keep behaving exactly as before (`belief_kind='gaussian'`, leverage 1×).

Legend: `core`/`shared`/`api`/`web` as in V1. Each phase ends with a runnable checkpoint. `[blocked-by]` = hard deps.

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
**Checkpoint:** create a bimodal-mixture market, trade it, watch component weights shift live and prices stay consistent with MC.

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
**Checkpoint:** open a 5× leveraged position, push the belief against it, watch margin call → liquidation → insurance-fund draw; short a call and settle it correctly.

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
**Checkpoint:** in a volatile simulated run, spreads/σ_ε adapt within rails and calibration improves vs static.

---

## Phase V2-6 — Hedging `[core, api, web]` (Workstream D) `[blocked-by: V2-1]`
**Goal:** reduce reserve via offsetting positions (`MODEL.md §6.4`).
- [ ] `find_best_hedge(exposure)` over a binary/spread basis tiling Θ; trigger when `reserve > cash×0.8`.
- [ ] Internal hedge bookkeeping (lowers `L(θ)` variance); `hedges` table.
- [ ] `ExternalHedgeProvider` interface + **mock** provider.
- [ ] `web`: admin hedge book + reserve before/after.
- [ ] **Tests:** hedge reduces reserve; bookkeeping neutral to user payouts.
**Checkpoint:** a high-reserve market auto-hedges and frees capital; admin sees the hedge book.

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

## Phase V2-9 — Hardening & polish `[all]` `[blocked-by: all]`
- [ ] Full V2 integration suite across workstreams; migration test (V1 data → V2 unchanged behavior).
- [ ] Extended Monte-Carlo sim covering leverage/liquidation cascades and multi-modal calibration.
- [ ] Load test (multi-node + Redis); chaos test (node loss mid-trade).
- [ ] Docs refresh; ops runbook (oracle failure, mass liquidation, insurance depletion).
**Checkpoint:** `bun test` green; load/chaos pass; V1 markets verified unchanged; demo script exercises beliefs + leverage + liquidation + disputes + insurance end-to-end.

---

### Definition of done (V2)
Markets run on Gaussian / Mixture / Student-t beliefs with correct pricing and component management; users trade with tier-based **leverage and shorting** under margin gates, with an automated **liquidation engine** and an **insurance fund** backstop; parameters **self-tune** within spec rails; the MM **hedges** to free reserve; markets resolve from **aggregated oracles** with a **dispute** process; **KYC tiers/limits/geofencing/audit** enforce compliance; the system scales **horizontally** while preserving per-market sequential consistency. All V1 behavior is preserved for existing markets.
