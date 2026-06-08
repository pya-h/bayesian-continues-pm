# Technical Design Document — Web2 Bayesian Market Maker (BMM) Continuous Prediction Market

> Companion to `MODEL.md` (the mathematical/functional spec). This document is the **engineering design** for a runnable v1 implementation. Where this document and `MODEL.md` disagree, **this document wins** and the deviation is called out explicitly in §2.

---

## 1. Scope & Decisions (v1)

| Decision | Choice | Rationale |
|---|---|---|
| **Belief model** | **Gaussian single-mode `N(μ, σ²)` only** | All closed-form pricing in `MODEL.md §4.2` is exact for Gaussian. Mixture / Student-t deferred to **v2** behind a `BeliefModel` interface so they slot in without touching callers. |
| **Contract selection** | **User-composable** | User picks type (Linear/Call/Put/BinaryCall/BinaryPut/Spread/Gaussian) + params (strike/center/width/bounds) live, sees the quote, then buys/sells. Matches the "interactive chart" requirement. |
| **Liquidity provision** | **Included in v1** | Reserve-pool LP model (§6). LPs fund the MM's cash reserve, mint pro-rata shares, earn a share of MM PnL, claim separately at settlement. |
| **Datastore** | **PostgreSQL** | Per `MODEL.md §12.2`. Accessed via Drizzle ORM + `drizzle-kit` migrations. |
| **Money** | Play money (no real funds, no blockchain). Admin has infinite balance and can top up users. | Per the brief. |
| **Backend** | **ElysiaJS on Bun** (TypeScript) | Per the brief; Bun is already installed (`bun 1.3.x`). |
| **Frontend** | **React + Vite + TypeScript** | Mature charting ecosystem; "or anything more suitable" → React chosen over Preact for library compatibility. |
| **Monorepo** | **Bun workspaces** | One JS project: `apps/api`, `apps/web`, `packages/core`, `packages/shared`. |

### 1.1 Non-goals (v1)
- No real payments, custody, KYC/AML, geofencing, or tax reporting (the `MODEL.md §19` regulatory layer is **mocked/omitted**).
- No mixture / Student-t beliefs (v2).
- No external hedging or correlated-market hedging (`MODEL.md §6.4` external hedge) — only the reserve buffer.
- No margin/leverage/short beyond "sell what you hold" (see §5.4). Leverage tiers from `MODEL.md §9.3` are **out of scope** for v1; everything is 1× cash-collateralized.
- No dispute-resolution voting; admin is the oracle (manual resolve) plus an optional manual numeric entry.

---

## 2. Corrections & Clarifications to MODEL.md

These are issues found while cross-validating the spec. The implementation follows the corrected version.

### 2.1 Inventory / exposure sign convention (important)
`MODEL.md §7.2` pseudocode does `inventory[C] += q` and `cash += q*exec_price` for a user **buy**, while `§6.2` defines solvency as `cash ≥ -min_θ exposure(θ)` with `exposure(θ)=Σ inventory[C]·f_C(θ)`. These are mutually inconsistent on sign (a user buy makes the MM *short* the contract, i.e. it *owes* `f` at settlement).

**Corrected, internally-consistent convention used throughout the implementation:**
- Let `mmShort[C] = Σ_users position[C]` = number of units the MM is **short** to users (the MM must pay `f_C(θ*)` per unit at settlement).
- **MM liability** at outcome θ: `L(θ) = Σ_C mmShort[C] · f_C(θ)` (always the amount the MM pays out).
- **Cash bookkeeping:** on a user buy of `q>0` at `exec_price`, MM `cash += q·exec_price`, `mmShort[C] += q`. On a user sell (`q<0`), MM `cash += q·exec_price` (i.e. pays the user), `mmShort[C] += q`.
- **Solvency / required reserve:** `cash ≥ Reserve = Quantile_α( L(θ) ; θ~belief )` — the high quantile of what the MM might have to pay. (Equivalent to `MODEL.md §6.2` once the sign is fixed: their `-exposure` becomes our `L`.)
- **Expected liability (for NAV/marks):** `E_p[L(θ)] = Σ_C mmShort[C] · Price_fair(C)` since `Price_fair(C)=E_p[f_C]`.

### 2.2 Pricing-formula validation (all confirmed correct)
- Call `σφ(d)+(μ-K)Φ(d)`, `d=(μ-K)/σ` (numeric check μ=65k,σ=5k,K=70k ⇒ ≈ $416.6, matches doc's ≈$415).
- Put `σφ(d)-(μ-K)Φ(-d)` ; **put-call parity** Call−Put = μ−K holds .
- BinaryCall `Φ(d)`, BinaryPut `Φ(-d)`, Spread `Φ((b-μ)/σ)-Φ((a-μ)/σ)` .
- Gaussian payoff `√(w²/(w²+σ²))·exp(-(c-μ)²/(2(w²+σ²)))` (verified via Gaussian-product identity).
- `∂Price_call/∂μ = Φ(d)`, `∂Price_put/∂μ = -Φ(-d)` (the `±dφ(d)` terms cancel).
- Bayesian precision update (standard conjugate Normal-Normal).

### 2.3 Nature of the mechanism (design-affecting note)
This BMM is **not** an LMSR/cost-function maker where price ≡ belief and trades are arbitrage-free. It **infers a heuristic "signal"** from each trade (`MODEL.md §5.2`) and Bayesian-updates the belief; its economic edge comes from the **spread + inventory + adverse-selection** terms (`§4.3`). Consequences baked into the design:
- The belief is a *consensus estimator driven by order flow*, not a no-arbitrage price. We surface it as "market consensus", and we keep the **raw spread income** and **settlement PnL** as separate, auditable quantities so the MM/LP economics are transparent.
- Because signal extraction is heuristic, all of `α, β, λ, γ, η, lr, σ_ε, ...` are per-market config with the defaults from `MODEL.md §14.1`.

### 2.4 LP is an addition, not in MODEL.md
`MODEL.md` has no LP concept. We define one (§6) that is consistent with the reserve/solvency model: LP = contributing to the MM cash reserve in exchange for pro-rata claims on MM equity.

### 2.5 Unbounded contracts & reserve
Linear/Call/Put have unbounded payoff. `min_θ`/`max_θ` are undefined, so we use **quantile-based reserve** via Monte Carlo over the belief (`MODEL.md §6.3`), with an analytic fast-path for the common cases. Reserve confidence `α` is per-market (default 0.99).

---

## 3. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│ apps/web  (React + Vite + TS)                                       │
│  Pages: Auth · Markets · Market(Trade) · Portfolio · LP · Admin     │
│  Charts: BeliefPDF · PayoffOverlay · Price-vs-Strike · History      │
│  State: TanStack Query (REST) + WS client (live belief/price/trade) │
└───────────────▲───────────────────────────────────┬────────────────┘
                │ REST (JSON)                        │ WebSocket
┌───────────────┴───────────────────────────────────▼────────────────┐
│ apps/api  (ElysiaJS on Bun)                                          │
│  Routes: /auth /markets /trades /positions /lp /admin /users        │
│  Plugins: jwt, cors, swagger, ws                                    │
│  Services: AuthSvc · MarketSvc · TradeEngine · LpSvc · SettleSvc     │
│            · StatsSvc · OracleSvc                                    │
│  Concurrency: per-market serialized queue + DB row lock             │
└───────────────┬───────────────────────────────────┬────────────────┘
                │ uses                               │ Drizzle ORM
┌───────────────▼───────────────┐   ┌───────────────▼────────────────┐
│ packages/core (pure TS)        │   │ PostgreSQL                      │
│  gaussian · pricing · spread   │   │  users markets contracts trades │
│  signal · bayes · solvency     │   │  positions belief_updates       │
│  stats · BeliefModel iface     │   │  lp_positions lp_ledger oracles │
│  (NO io, fully unit-tested)    │   └─────────────────────────────────┘
└────────────────────────────────┘
        ▲ shared types/zod
┌───────┴────────────────────────┐
│ packages/shared (DTOs, enums,  │
│  zod schemas, money utils)     │
└────────────────────────────────┘
```

### 3.1 Monorepo layout
```
bmm-sample/
  package.json            # workspaces: ["apps/*","packages/*"], bun
  tsconfig.base.json
  .env / .env.example
  docker-compose.yml      # postgres only (dev convenience)
  MODEL.md  TDD.md  TASKS.md
  packages/
    core/      # math engine — pure, deterministic, no IO. The "truth".
    shared/    # types, enums, zod DTOs, money/round helpers
  apps/
    api/       # ElysiaJS server, Drizzle schema+migrations, services
    web/        # React+Vite client
```

### 3.2 Dependency direction (strict)
`web → shared`; `api → shared, core`; `core → (nothing)`; `shared → (nothing)`.
`core` must stay IO-free and framework-free so it is trivially testable and reusable in v2.

---

## 4. Core Engine (`packages/core`)

Pure, deterministic TypeScript. This is the literal encoding of `MODEL.md §§2,4,5,6,8,16`, with the §2 corrections.

### 4.1 `BeliefModel` interface (v2-ready)
```ts
interface BeliefModel {
  readonly kind: 'gaussian';            // v2: 'mixture' | 'student_t'
  mean(): number;
  variance(): number;
  pdf(theta: number): number;
  cdf(theta: number): number;
  sample(n: number, rng: Rng): number[];
  quantile(p: number): number;
  serialize(): BeliefStateDTO;
}
```
v1 ships `GaussianBelief implements BeliefModel`. All pricing/solvency code depends only on this interface (plus a `closedFormPricer` fast-path keyed on `kind`), so v2 mixtures drop in.

### 4.2 Numerics
- `phi(x)` standard normal PDF; `Phi(x)` standard normal CDF via high-accuracy erf (Cody/Abramowitz-Stegun 7.1.26 or `erf` series). `Phi` must be accurate to ≥1e-7 (drives all prices).
- `rng`: seedable PRNG (mulberry32 / xoshiro) so Monte-Carlo reserve and tests are reproducible. **No `Math.random` in core** (also: harness forbids it in workflow scripts; we keep core seedable regardless).

### 4.3 Pricing (`pricing.ts`) — `price(contract, belief)`
Closed forms from `MODEL.md §4.2` for `kind==='gaussian'`:
`linear→μ`, `call`, `put`, `binaryCall`, `binaryPut`, `spread`, `gaussian`. Fallback: deterministic numerical integration (Gauss–Hermite, 64 nodes) for any future custom payoff. Also exposes `dPrice_dMu(contract, belief)` for the adverse-selection term.

### 4.4 Spread (`spread.ts`) — `MODEL.md §4.3`
`spread = base + inventoryAdj + adverseSel + volAdj`, each per the doc's formulas, using corrected `mmShort` as `Inventory(C)`. Returns a breakdown object (for UI transparency), not just a scalar.

### 4.5 Signal & Bayesian update (`signal.ts`, `bayes.ts`) — `MODEL.md §5`
- `extractSignal(contract, q, belief, cfg) → {signal, weight}` per §5.2 (`α,β,Q_max,q_threshold`).
- `bayesUpdate(belief, signal, weight, cfg) → belief'` precision-weighted §5.3, clamped `σ² ≥ σ_min²`. (Also expose the simplified `lr/decay` variant behind a config flag for experimentation.)

### 4.6 Solvency (`solvency.ts`) — corrected §2.1 / `MODEL.md §6`
- `liability(mmShort, contracts, theta) → L(θ)`.
- `expectedLiability(mmShort, contracts, belief) = Σ mmShort·price`.
- `requiredReserve(mmShort, contracts, belief, α) → Reserve`:
  - **Analytic fast-path** when the book is a sum of monotone closed-form payoffs: compute `L` at the belief's α-quantile / 1−α-quantile of θ (since each `f` is monotone or unimodal, evaluate `L` at a small set of candidate θ: belief quantiles + payoff kinks (strikes, spread edges, gaussian centers)). Take the max → conservative reserve.
  - **Monte-Carlo path** (general): sample `n=50k` θ, `Reserve = quantile_α( L(θ) )`. Seeded RNG.
- `maxExecutable(...)` for partial fills (`MODEL.md §7.3`).

### 4.7 Statistics (`stats.ts`)
Given a position (or whole portfolio) and current belief, compute (all with explicit formulas — see §8):
expected payout, payout std, max/min payout (bounded) or `pᵗʰ`-percentile payout (unbounded), P(profit), VaR/CVaR of PnL, current mark, unrealized PnL, breakeven θ. Position-history-derived stats (peak profit, drawdown) are computed in `StatsSvc` from time series, not in core.

### 4.8 Core tests (must pass before anything downstream)
Encode `MODEL.md §17.1` table as unit tests, plus parity/identity invariants (put-call parity, `Σ` binary probabilities, monotonicity of price in μ, reserve ≥ expected liability, Bayesian update is precision-monotone). Property tests for `Phi`/`phi`.

---

## 5. Trading Engine (`apps/api` `TradeEngine`)

Implements `MODEL.md §7.2` (corrected) end-to-end.

### 5.1 Quote (read-only, no state change)
`GET quote(marketId, contractSpec, q)` → `{ fair, spread{breakdown}, execPrice, totalCost, projectedBelief, projectedReserve }`. Used by the live chart so the user sees the price *before* trading. Pure call into `core` over the current belief snapshot.

### 5.2 Execute (state-changing, serialized)
Per `MODEL.md §7.2` corrected order: compute fair → spread → exec price → slippage check → balance/position check → tentatively apply (mmShort, cash, belief, position) → recompute reserve → **solvency gate** (`cash ≥ Reserve`, and with circuit-breaker margin `cash ≥ 1.2×Reserve` to *open* new risk, per `§15.1`) → commit in a single DB transaction → emit WS events → return fill (full or partial via §7.3).

### 5.3 Contract identity
A user-composable contract is identified by `(marketId, type, params)`. On first trade with a given spec we **upsert** a `contracts` row (deterministic hash of normalized params → `contract_key`) so positions/inventory aggregate correctly across users and time.

### 5.4 Sell / close semantics (v1, no shorting)
Users may only **sell up to what they hold** of a given contract (`MODEL.md §7.2` step 6b). Selling reduces the user's position and the MM's `mmShort`. No naked shorts in v1 (keeps solvency one-sided and simple). "Close position" = sell entire holding at current bid.

### 5.5 Concurrency & consistency
- One **in-process async queue per `marketId`** serializes execute/settle/LP-mutations → sequential consistency for belief+cash (matches `MODEL.md §18.2` "single leader").
- Plus DB safety: each commit runs in a transaction that does `SELECT ... FOR UPDATE` on the `markets` row, so correctness holds even if a second API instance ever runs.
- Quotes are lock-free reads of the last committed snapshot.

---

## 6. Liquidity Provision (LP) Design

A reserve-pool model consistent with §2.1 solvency. (This is the v1 addition flagged in §2.4.)

### 6.1 Pool & NAV
- The market's MM **cash reserve** is the pool. **NAV** (net asset value of the pool) at belief `p`:
  `NAV = cash − E_p[L(θ)] = cash − Σ_C mmShort[C]·Price_fair(C)`.
  (Cash collected as premiums minus the mark-to-model value of outstanding obligations.)
- **LP shares** `S_total` track ownership. Share price `= NAV / S_total`.

### 6.2 Seeding & deposits
- On market creation the **admin/creator deposits initial reserve `R₀`** → mints `S = R₀` shares to the creator (genesis: share price = 1). The creator is LP #0.
- An LP deposit of `D` while OPEN mints `ΔS = D · S_total / NAV_before` shares; `cash += D`. (Deposit raises capacity for more/larger trades.)

### 6.3 Withdrawals
- While OPEN, an LP may redeem `ΔS` shares for `cash_out = ΔS/S_total · NAV`, **only if** post-withdrawal `cash ≥ 1.2×Reserve` (cannot pull liquidity below the solvency buffer). Otherwise partial/blocked.
- This makes LP P&L *mark-to-model* continuously; the realized portion crystallizes at settlement.

### 6.4 Settlement for LPs
At resolution with θ*: MM pays all user claims `Σ L(θ*)`. Remaining `cash_final = cash − Σ user_payouts`. Each LP claims `share_fraction · cash_final` via a **separate LP claim** flow (distinct from trader claims). LP realized PnL = claimed − total_deposited.

### 6.5 Ledger & transparency
`lp_positions` (per user per market: shares, cost basis) and `lp_ledger` (deposits/withdrawals/claims) make LP economics auditable. UI shows pool NAV, share price, your shares, your share %, est. current value, and (post-resolution) final claim.

---

## 7. Domain Model & Lifecycle

States (`MODEL.md §10`): `CREATED → OPEN → (SUSPENDED ↔ OPEN) → RESOLVED → SETTLED → CLOSED`, plus `SUSPENDED → CANCELLED` (refunds).
- **CREATED**: admin configures `μ₀, σ₀, σ_min, σ_ε, α…η, Q_max`, outcome unit/range, timestamps, initial reserve `R₀`.
- **OPEN**: trading, LP deposit/withdraw, quotes, live belief.
- **SUSPENDED**: circuit breaker (`§15.1`) or admin; no trades; LP frozen.
- **RESOLVED**: oracle θ* recorded; no trades; payouts computed.
- **SETTLED**: trader & LP claims enabled.
- **CLOSED**: archived/read-only.
- **CANCELLED**: trades unwound at cost basis; LP refunded deposits; everyone made whole. (Refund path for emergencies.)

Settlement (`MODEL.md §8`, corrected): payout per user `= Σ_C position[C]·f_C(θ*)`; supports proximity/Gaussian contracts natively (`§8.3.1`). Tiered/post-hoc proximity (`§8.3.2/3`) is **optional per-contract config**, off by default. **Claim model:** payouts are *computed and recorded* at RESOLVED but credited to balance only when the user clicks **Claim** (per the brief) — idempotent, one claim per position.

---

## 8. Statistics & Formulas (the "proper statistics" requirement)

All surfaced numbers come with a defined formula; `θ ~ belief p`, position `q` in contract with payoff `f`.

**Per position (trader):**
- Expected payout: `E_p[q·f] = q·Price_fair(C)`.
- Payout variance: `Var = q²·(E_p[f²] − Price_fair²)`; `E_p[f²]` closed-form for binary/spread (= price, since f∈{0,1}) and Gaussian payoff, else Gauss–Hermite.
- Max payout: bounded `f` → `q·max f` (binary→q, spread→q, gaussian→q); unbounded (linear/call/put) → `q·f(θ_{p99})` reported as "P99 payout" (clearly labeled, since true max is ∞).
- P(profit) = `P_p( q·f(θ) > costBasis )` via cdf on the θ-region where payoff exceeds basis (closed-form for monotone f).
- Unrealized PnL (mark) = `q·bid(C) − costBasis` (mark at exit price).
- Breakeven θ: solve `f(θ) = costBasis/q`.
- VaR/CVaR of PnL at α from sampled payout distribution.

**Per position history (time series):** peak profit (running max of unrealized PnL), max drawdown, holding period, realized PnL (closed lots, average-entry accounting).

**Per market (admin):** total volume, #trades, #traders, spread income (Σ collected spread), current `E_p[L]`, current reserve, reserve utilization `Reserve/cash`, MM/creator PnL = `NAV − R₀ + withdrawn`, belief drift `μ_t−μ₀`, calibration (post-hoc: was θ* in the 80% CI?).

**Per market (trader-facing):** consensus μ (and "implied price"), σ (uncertainty band), belief history, volume, your aggregate position value.

All aggregate payout stats (max/avg/etc.) are computed from the **closed-form/sampled payout distribution under the current belief**, never ad-hoc.

---

## 9. Data Model (PostgreSQL via Drizzle)

Extends `MODEL.md §12.2` with users/auth and LP tables. Money columns `numeric(20,8)`; `theta`/belief columns `double precision`.

```
users(user_id pk, username uniq, password_hash, role['user'|'admin'],
      balance numeric, is_infinite bool, tier, created_at, updated_at)

markets(market_id pk, title, description, outcome_unit, outcome_min, outcome_max,
        status, creator_id fk users,
        initial_mu, initial_sigma, current_mu, current_sigma,
        cfg jsonb,                 -- σ_min,σ_ε,s0,γ,λ,η,α,β,lr,decay,Q_max,reserve_α
        cash numeric, reserve_required numeric, lp_shares_total numeric,
        opens_at, closes_at, resolves_at, created_at, updated_at)

contracts(contract_id pk, market_id fk, contract_key uniq(market_id,key),
          type, params jsonb,      -- strike/center/width/lower/upper
          mm_short numeric default 0, created_at)

positions(position_id pk, user_id fk, contract_id fk, uniq(user_id,contract_id),
          quantity numeric, avg_entry_price numeric, realized_pnl numeric,
          peak_unrealized numeric, created_at, updated_at)

trades(trade_id pk, market_id fk, user_id fk, contract_id fk,
       quantity, exec_price, fair_price, spread_total, total_cost,
       belief_mu_before, belief_sigma_before, belief_mu_after, belief_sigma_after,
       created_at)

belief_updates(update_id pk, market_id fk, prev_mu, prev_sigma, new_mu, new_sigma,
               signal_extracted, signal_weight, trigger_trade_id, created_at)

lp_positions(lp_id pk, market_id fk, user_id fk, uniq(market_id,user_id),
             shares numeric, total_deposited numeric, total_withdrawn numeric,
             claimed bool, created_at, updated_at)

lp_ledger(entry_id pk, market_id fk, user_id fk,
          kind['deposit'|'withdraw'|'claim'], amount numeric, shares_delta numeric,
          nav_before numeric, share_price numeric, created_at)

oracles(oracle_id pk, market_id fk, source, resolved_value double, confidence,
        reported_at, disputed bool)

claims(claim_id pk, market_id fk, user_id fk, position_id fk,
       payout numeric, theta_star double, claimed_at)   -- trader settlement claims
```
Time-series tables (`trades`, `belief_updates`) power history charts and stats. Indexes on `(market_id, created_at)` and `(user_id)`.

---

## 10. API Surface (ElysiaJS)

REST (JSON, JWT bearer). Builds on `MODEL.md §13` + LP/admin/auth.

```
# auth
POST /auth/register            {username,password} -> {token,user}
POST /auth/login               -> {token,user}
GET  /auth/me

# markets (public read)
GET  /markets                              list (+status filter)
GET  /markets/:id                          detail incl. current belief, cfg, pool NAV
GET  /markets/:id/belief-history           time series (μ,σ)
GET  /markets/:id/trades                    recent trades
GET  /markets/:id/stats                     market-level stats (§8)

# quoting & trading
POST /markets/:id/quote        {type,params,q} -> quote w/ spread breakdown (no state)
POST /markets/:id/trades       {type,params,q,maxPrice} -> fill (auth)  [serialized]

# positions / portfolio
GET  /users/me/portfolio                    all markets + positions + PnL + stats
GET  /users/me/positions/:contractId        position detail + payout distribution
POST /markets/:id/claim        {positionId} -> credited payout (SETTLED only)

# LP
GET  /markets/:id/lp                         pool NAV, share price, your position
POST /markets/:id/lp/deposit   {amount}      (OPEN)  [serialized]
POST /markets/:id/lp/withdraw  {shares}      (OPEN, solvency-gated) [serialized]
POST /markets/:id/lp/claim                   (SETTLED) [serialized]

# admin (role=admin only)
POST /admin/markets                          create market (+R0 from creator)
POST /admin/markets/:id/open|suspend|resume|resolve|cancel|close
POST /admin/users/:id/topup    {amount}      grant play money
GET  /admin/markets/:id/overview             creator-side PnL, trades, exposure, reserve
GET  /admin/users                            list/manage
```

**WebSocket** (`/ws`): client subscribes by market/user. Server pushes `belief_update`, `trade_executed`, `price_change`, `reserve_update`, `lp_update`, `position_update`, `market_status`, `system:alert` (`MODEL.md §13.2`).

DTOs validated with **zod** schemas in `packages/shared`, reused by Elysia (`t`/typebox bridge or zod) and the web client.

---

## 11. Frontend (`apps/web`)

React + Vite + TS. Data via **TanStack Query** (REST) + a thin **WS** hook merging live ticks into the query cache. Styling: Tailwind (fast, consistent). Charts: **uPlot** (fast time-series for belief/price history) + a **custom SVG/d3-scale layer** for the interactive belief/payoff composer (drag strike, shade regions). Recharts as fallback for simple stat cards.

### Pages
- **Auth** — register/login.
- **Markets list** — cards: title, status, consensus μ, σ band, volume, your position badge.
- **Market / Trade** (the centerpiece):
  - **BeliefPDF chart**: Gaussian curve `N(μ,σ²)` with mean line + CI band; updates live on WS.
  - **Contract composer**: pick type; drag **strike/center/width/bounds** directly on the chart; payoff `f(θ)` overlaid on the PDF; the shaded "winning region".
  - **Quote panel**: live `fair / spread breakdown / exec price / total cost`, slippage (maxPrice), Buy/Sell, projected belief & reserve after trade.
  - **Price-vs-strike** mini-chart for the chosen type.
  - **Belief history** (μ with σ band over time) + **recent trades** tape.
  - **Position stats** for what you hold here (expected/max/avg payout, P(profit), PnL, breakeven).
- **Portfolio** — every market you touched; per market: state, position value, PnL, peak profit, drawdown; if RESOLVED → final outcome, your payout, **Claim** button; expand → individual positions, their belief snapshot, payout distribution.
- **LP** — per market: pool NAV, share price, your shares/%, est. value; Deposit/Withdraw; post-resolution **Claim** (separate from trader claim); LP PnL.
- **Admin Panel** — create market (all cfg + R₀), list own markets, per-market overview (trades, traders, volume, exposure curve, reserve utilization, **creator/MM PnL**), lifecycle buttons (open/suspend/resume/resolve(enter θ*)/cancel/close), user list + **top-up**.

---

## 12. Auth, Admin, Money

- JWT (`@elysiajs/jwt`), password hash via `Bun.password` (argon2/bcrypt). Bearer token; `role` claim gates admin routes via an Elysia `beforeHandle` guard.
- **Admin seeding**: on boot, upsert a user `ADMIN_USERNAME` / `ADMIN_PASSWORD` (from `.env`) with `role='admin'`, `is_infinite=true`. Infinite balance = balance checks skipped; top-ups don't debit admin.
- **Top-up**: admin → any user, credits `balance`, recorded for audit.
- Money is `numeric(20,8)`; all arithmetic goes through a `shared/money.ts` (round-half-even to 8 dp) to avoid float drift in balances. Belief/θ math stays in `double` inside `core`.

---

## 13. Config (`.env`)
```
DATABASE_URL=postgres://...:5432/bmm
JWT_SECRET=...
ADMIN_USERNAME=admin
ADMIN_PASSWORD=...
PORT=3000
WEB_ORIGIN=http://localhost:5173
RESERVE_MC_SAMPLES=50000     # solvency Monte-Carlo
RESERVE_ALPHA=0.99
```
Per-market params (`σ_min,σ_ε,s0,γ,λ,η,α,β,lr,decay,Q_max`) default to `MODEL.md §14.1` and are editable at create time, stored in `markets.cfg`.

---

## 14. Testing
- **core (unit/property)** — `MODEL.md §17.1` table verbatim; parity/monotonicity/solvency invariants; `Phi/phi` accuracy; seeded MC reproducibility. Gate: green before services.
- **api (integration)** — full lifecycle create→open→trade(s)→resolve→claim; LP deposit→trade→resolve→LP claim; solvency rejection; partial fill; sell-only-what-you-hold; concurrency (parallel trades on one market stay consistent). Spin Postgres via `docker-compose` / testcontainers; transactional rollback per test.
- **sim (optional)** — `MODEL.md §17.3` Monte-Carlo: N traders around θ*, measure belief accuracy, calibration (θ* in 80% CI rate), MM/LP profitability. Doubles as a calibration tool for defaults.
- **web** — component tests for the composer/quote math wiring; a Playwright smoke of the trade→resolve→claim happy path.

---

## 15. Risk / Circuit Breakers (`MODEL.md §15`, v1 subset)
Implemented: insolvency gate (`cash<1.2×Reserve` ⇒ reject opening trades), belief divergence alert (`σ>3σ₀`), rapid-move suspend (`>X%`/min), oracle-missing suspend. Wash-trading/concentration limits: detect + alert only (no auto-ban) in v1. Insurance fund: a single protocol-level play-money account that absorbs any user bankruptcy on negative-payoff custom contracts (none ship enabled by default in v1, so this is a safety net only).

---

## 16. v2 Backlog (designed-for, not built)
Mixture & Student-t beliefs (`BeliefModel` already abstracts this; numerical pricing path already present), component merge/split, multi-modal UI, external hedging, leverage/margin tiers, dispute resolution, adaptive parameters (EWMA `σ_ε`, regime-scaled spread, `MODEL.md §14.2`), real auth/KYC, sharding/read-replicas.
