# Technical Design Document — BMM Continuous Prediction Market **V2**

> Builds on **V1** (`TDD.md`, `TASKS.md`) and the spec (`MODEL.md`). V1 must be shipped and in use first. V2 adds the parts intentionally deferred from V1: richer beliefs, adaptive parameters, hedging, robust oracles/disputes, real compliance, and horizontal scale. Where this doc disagrees with `MODEL.md`, this doc wins; deviations are called out.
>
> **Scope boundary (V2 ↔ V3):** V2 stays **1× cash-collateralized**, exactly like V1, on the collateral axis. **Leverage, margin, shorting, the liquidation engine, and the full insurance fund moved to V3** (`docs/v3/TDD.md`). They were originally V2 Workstreams **B** and **H**; this doc no longer covers them. Nothing in V2 lets a user owe more than the premium they paid.

---

## 1. V2 Scope & Theme

V1 is a correct, runnable, **Gaussian, 1×-cash-collateralized, single-instance** market. V2 turns it into a **richer, more realistic, production-shaped** system without rewriting the V1 core — every V2 feature slots into a V1 extension point.

| # | V2 Workstream | V1 extension point it plugs into | `MODEL.md` ref |
|---|---|---|---|
| A | **Multi-modal beliefs** (Gaussian Mixture, Student-t) | `BeliefModel` interface (already abstract in V1 core) | §2.3.2, §2.3.3, §5.4 |
| C | **Adaptive parameters** (EWMA σ_ε, regime spreads) | per-market `cfg`, spread/signal modules | §14.2 |
| D | **Hedging** (internal + external) | inventory/solvency, `TradeEngine` | §6.4 |
| E | **Robust oracles & dispute resolution** | `OracleSvc`, resolve flow | §11 |
| F | **Compliance** (KYC tiers, geofencing, limits, audit) | auth/user, position limits | §9.3, §19 |
| G | **Scale & ops** (Redis, read replicas, shard by market) | api topology | §18.2 |

Each workstream is independently shippable; **A (multi-modal beliefs)** is the headline feature. *(The original Workstreams **B** — leverage/margin/shorting/liquidation — and **H** — insurance fund — are now **V3**; see `docs/v3/TDD.md`. Workstream letters C–G are kept as-is to avoid churn against earlier references.)*

---

## 2. Workstream A — Multi-modal Beliefs

### 2.1 Goal
Replace "Gaussian only" with selectable belief kinds per market: `gaussian` (V1), `mixture` (K-component Gaussian), `student_t`. The whole point of the V1 `BeliefModel` interface (`TDD.md §4.1`) was to make this a drop-in.

### 2.2 `BeliefModel` implementations
```ts
GaussianBelief    // V1, unchanged
MixtureBelief     // { components: {pi, mu, sigma2}[] }, Σpi=1
StudentTBelief    // { nu, mu, sigma2 }
```
All satisfy the same `mean/variance/pdf/cdf/sample/quantile/serialize` contract, so pricing/solvency/stats callers are untouched.

### 2.3 Pricing
- **Mixture:** by linearity of expectation, `Price(f, Σπ_k N_k) = Σ_k π_k · Price(f, N_k)` — reuse V1 closed forms per component, weight-sum. **Exact, no new integration.** This is the elegant payoff of the mixture choice.
- **Student-t:** no general closed forms; use **Gauss–Hermite / adaptive quadrature** (the V1 numerical fallback already exists in `pricing.ts`). Cache nodes per ν.
- `dPrice_dMu` generalizes to per-component weighting (mixture) / numerical (t).

### 2.4 Bayesian update — Mixture (`MODEL.md §5.4`)
- Per-component conjugate update of `(μ_k, σ_k²)`; weight update `π_k ∝ π_k · N(s; μ_k, σ_k²+σ_ε²)`, renormalize.
- **Component management** (new module `mixture_ops.ts`):
  - **Prune:** drop `π_k < π_min`, renormalize.
  - **Merge:** if `|μ_i−μ_j| < τ_merge·(σ_i+σ_j)` → moment-match merge into one component.
  - **Split (optional/advanced):** when a single component's posterior predictive badly underfits recent signals (residual test), split into two seeded ±σ. Off by default; behind cfg flag.
- Student-t: update via EM-style / moment-matching on (ν, μ, σ²); ν adapts slowly to observed tail heaviness. Keep simple: fixed ν per market by default, μ/σ² updated; adaptive ν behind a flag.

### 2.5 Solvency with non-Gaussian
`requiredReserve` already supports the seeded Monte-Carlo path (`solvency.ts`); for mixture/t we **always** use MC (or quadrature on `L(θ)` over the belief), since the analytic kink fast-path assumed unimodality. Sampling from a mixture = pick component by π then sample Gaussian; from t = standard t-sampler.

### 2.6 UI
- Belief chart renders general `pdf(θ)` (multi-bump curve for mixtures, fat tails for t) — it already calls `belief.pdf`, so mostly free.
- Market creation: choose belief kind + initial components (for mixture, an admin "add a mode at μ_k with weight π_k" editor).
- Show per-component weights/means as a small legend; animate weight shifts on trades.

### 2.7 Tests
Mixture price = weighted sum of component prices (cross-check vs MC); merge/prune preserve total mass and mean within tolerance; t-pricing matches MC; mixture update concentrates weight on the component nearest a stream of consistent signals.

---

## 3. ~~Workstream B — Leverage, Margin, Shorting, Liquidation~~ → **moved to V3**

Leverage, margin, shorting, the liquidation engine, and the insurance-fund backstop that pairs with them are **no longer part of V2**. They are designed in full in **`docs/v3/TDD.md`** (with the build plan in `docs/v3/TASKS.md` and a concepts explainer in `docs/v3/shorting-and-leverage.md`).

Why the split: V2's other workstreams (richer beliefs, adaptive params, hedging, oracles, compliance, scale) are all orthogonal to the collateral model and ship fine at 1×. Borrowed exposure, by contrast, drags in a whole safety subsystem — maintenance margin, an event-driven liquidation engine, and an insurance fund to absorb gap loss and bankruptcy. Bundling that into V2 would have made the headline belief work wait on it. So V2 stays **1× cash-collateralized** (a user can never owe more than the premium paid), and the entire borrowed-exposure stack — including the **insurance fund** (was Workstream H) — lands together in V3 where it has a coherent job.

---

## 4. Workstream C — Adaptive Parameters (`MODEL.md §14.2`)

Make the market self-tune instead of static `cfg`.
- **Adaptive `σ_ε`:** `σ_ε,t = EWMA(σ_ε, |signal_error_t|, λ=0.1)` where `signal_error = |s_inferred − realized_drift|` proxy; widens when traders are noisy, tightens when informative.
- **Regime-scaled base spread:** `s₀,t = max(s₀_min, s₀ × (1 + volatility_regime))`, where `volatility_regime` from recent realized belief volatility (rolling σ of μ-increments).
- **Adaptive `α/β` signal strength:** optional, EWMA toward values that best explained recent post-trade belief moves.
- Stored as a `market_cfg_history` time series; admin can pin/override. Backtest harness (V1 sim tool) extended to compare adaptive vs static calibration.
- Guardrails: all adaptive params clamped to the `MODEL.md §14.1` ranges; circuit breaker if a param hits a rail repeatedly.

---

## 5. Workstream D — Hedging (`MODEL.md §6.4`)

Reduce required reserve / free capital for LPs.
- **Internal hedge:** when `required_reserve > cash × 0.8`, the MM opens an **offsetting internal position** (a synthetic contract whose payoff cancels net exposure curvature) — bookkeeping-only, lowers `L(θ)` variance. Implemented as `find_best_hedge(exposure)` choosing the contract (from a candidate basis: a strip of binaries/spreads tiling Θ) that most reduces reserve per unit.
- **External hedge (optional/plug-in):** an adapter interface `ExternalHedgeProvider` (e.g. a mock correlated market) so a real venue could be wired later. Default: a **mock** provider for demos.
- All hedges logged, shown in admin overview (hedge book, reserve-before/after).

---

## 6. Workstream E — Robust Oracles & Disputes (`MODEL.md §11`)

V1 oracle = manual admin entry. V2 adds:
- **Source adapters:** `OracleSource` interface with implementations — `ApiFeed` (Coinbase/Binance-style price pull), `WeatherApi`, `Manual`, `Aggregated` (median/weighted across N sources with confidence). Pluggable, async, retried.
- **Auto-resolve:** at `resolves_at`, pull from configured source(s); if no update within `2×expected` → **SUSPEND + alert** (`§15.1`).
- **Dispute window:** after RESOLVED, a configurable window where users can flag `disputed=true`. Resolution options (`§11.3`): admin override, secondary-oracle redundancy, or time-delayed finality. V2 ships **admin override + secondary oracle**; token-vote is out of scope (no chain).
- Settlement waits for dispute window to close before claims open.

---

## 7. Workstream F — Compliance & Tiers (`MODEL.md §9.3, §19`)

Real (but still play-money) account tiers and limits.
- **KYC tiers:** Anonymous → Verified → Advanced → Institutional. Mock KYC flow (upload stub / admin approval) advances tiers; each tier unlocks deposit/withdraw limits and position limits (§9.3 table). *(The same tier table also carries a per-tier **leverage cap**, but leverage itself is a **V3** feature — the cap column and its enforcement land in `docs/v3/` alongside margin. V2 leaves every account at 1×.)*
- **Geofencing:** IP-based country check + blocklist (`§19.2`); configurable, mockable for local dev.
- **Audit log:** immutable append-only `audit_events` for admin actions, top-ups, tier changes, disputes.
- Position/deposit/withdraw limits enforced centrally in a `LimitsSvc` keyed on tier.

---

## 8. Workstream G — Scale & Ops (`MODEL.md §18.2`)

V1 is single-instance with an in-process per-market queue. V2 makes it horizontally scalable.
- **Redis:** (a) pub/sub fan-out for WS across API instances, (b) per-market **distributed lock** replacing the in-process queue (Redlock), (c) hot read cache for belief/price snapshots and quotes.
- **Trade engine = single leader per market:** market ownership assigned to one API node (consistent-hash on `market_id`) so the BMM stays sequentially consistent under multi-node; others proxy/forward writes. Reads served anywhere.
- **Postgres read replicas** for `GET` endpoints + history/stats; **shard by `market_id`** when needed.
- **Rate limiting** at gateway (`§18.1`).
- Observability: structured logs, metrics (trade latency, reserve utilization, trade throughput), health/readiness probes.

---

## 9. ~~Workstream H — Insurance Fund~~ → **moved to V3**

The full insurance-fund mechanics (`MODEL.md §15.2`) are deferred to **V3** and designed in `docs/v3/TDD.md`. Its draw paths — user bankruptcy on negative-payoff exposure, liquidation **gap loss**, socialized loss — only become reachable once **shorting and leverage** exist (in 1× cash-collateralized V2 a holder can never owe more than the premium already paid, so there is nothing for the fund to absorb). It therefore ships with the leverage stack in V3 rather than standing alone in V2.

*(V1 already carries a stub protocol account as a pure safety net; V3 turns it into the full fund with a ledger, fee accrual, and a coverage dashboard.)*

---

## 10. Data Model Deltas (vs V1 `TDD.md §9`)
```
users           + kyc_tier, kyc_status, country          -- (leverage_cap → V3)
markets.cfg     + belief_kind, adaptive flags, dispute_window, hedge_enabled
beliefs         positions/serialization generalized to mixture/student_t (jsonb already flexible)
hedges          (id, market_id, contract_ref, qty, reserve_before, reserve_after, created_at)
oracle_sources  (id, market_id, kind, config jsonb, weight)
oracle_reports  (id, market_id, source_id, value, confidence, reported_at)
disputes        (id, market_id, user_id, reason, status, resolution, created_at, resolved_at)
audit_events    (id, actor_id, action, target, payload jsonb, created_at)
market_cfg_history (market_id, cfg jsonb, created_at)   -- adaptive params over time
```
*(Moved to V3: `positions.quantity` going negative, `margin_accounts`, `liquidations`, `insurance_fund`/`insurance_ledger`, `markets.cfg.margin_rates`, and `users.leverage_cap` — see `docs/v3/TDD.md §`Data Model.)*

## 11. API Deltas
```
# beliefs
POST /admin/markets            + belief_kind, components[], nu, adaptive cfg
# oracles / disputes
POST /admin/markets/:id/oracle-sources     configure sources
POST /markets/:id/dispute                  open dispute (in window)
POST /admin/markets/:id/disputes/:d/resolve
# compliance
POST /users/me/kyc                         submit (mock); POST /admin/users/:id/kyc/approve
```
New WS events: `belief_components_update`, `oracle_report`, `dispute_opened`, `param_adapted`.
*(The margin/leverage/liquidation and insurance endpoints + `margin_call`/`liquidation`/`insurance_update` WS events move to V3 — see `docs/v3/TDD.md §`API.)*

## 12. Frontend Deltas
- **Belief chart:** general multi-modal PDF, component legend, fat-tail rendering.
- **Admin:** belief-kind + component editor at creation; oracle-source config; dispute queue; adaptive-param charts; hedge book.
- **KYC:** mock tier-upgrade flow.

*(The trade-panel leverage selector / margin / liquidation preview / short toggle, the portfolio margin-health / liquidation-distance / short views, and the insurance-fund dashboard are **V3** — see `docs/v3/TDD.md §`Frontend.)*

## 13. Testing (additions)
- Mixture/t pricing vs MC; component merge/prune/split invariants.
- Adaptive params stay in `§14.1` rails; regime detection sane.
- Oracle aggregation/median, missing-feed suspend, dispute window blocks claims.
- Multi-node consistency: concurrent trades across 2 API nodes via Redis lock stay sequentially consistent (no double-spend of reserve).

*(Margin-gate / liquidation-trigger / gap-loss→insurance / short-settlement / insurance-accounting tests live in V3.)*

## 14. Migration / Rollout from V1
- All V1 markets keep working (`belief_kind='gaussian'`, 1× cash-collateralized ⇒ behaves exactly as V1). New features are opt-in per market via `cfg`.
- Ship order: **A (beliefs)** and **F (tiers)** → **C, D, E** (adaptive, hedging, oracles) → **G (scale)** last. (See `V2-TASKS.md`.) Leverage/margin/liquidation + insurance are a separate **V3** track that builds on shipped V2 (it needs the V2-2 tier table for leverage caps).
- DB migrations are additive (new columns nullable/defaulted, new tables); no destructive changes to V1 data.
