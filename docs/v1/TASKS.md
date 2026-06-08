# TASKS — Web2 BMM Continuous Prediction Market (v1)

Phased, step-by-step build plan. Companion to `TDD.md` (design) and `MODEL.md` (spec).
**Convention:** each phase ends with a runnable/verifiable checkpoint. Do phases in order; `[blocked-by]` notes hard deps. Check boxes as you go.

Legend: `core`=`packages/core` · `shared`=`packages/shared` · `api`=`apps/api` · `web`=`apps/web`.

---

## Phase 0 — Scaffold & tooling
**Goal:** monorepo boots, lints, type-checks; Postgres reachable.
- [ ] Root `package.json` with **Bun workspaces** `["apps/*","packages/*"]`; scripts: `dev`, `build`, `test`, `db:up`, `db:migrate`, `db:seed`.
- [ ] `tsconfig.base.json` (strict) + per-package `tsconfig` with project refs.
- [ ] ESLint + Prettier (or Biome) at root.
- [ ] `docker-compose.yml` with Postgres 16; `.env.example` (all keys from `TDD.md §13`); `.env` gitignored.
- [ ] Empty package skeletons: `core`, `shared`, `api`, `web` with index + build.
- [ ] `README.md` quickstart: `bun install` → `bun db:up` → `bun db:migrate` → `bun db:seed` → `bun dev`.
**Checkpoint:** `bun install && bun run build && bun test` succeed (no real tests yet); `docker compose up` gives a live Postgres.

---

## Phase 1 — Core math engine (the heart) `[core]`
**Goal:** every `MODEL.md §17.1` number reproduced; invariants hold. No IO.
- [ ] `numerics.ts`: `phi`, `Phi` (erf, ≥1e-7), seedable `Rng` (mulberry32), `erfinv`/`quantile` helper.
- [ ] `gaussian.ts`: `GaussianBelief implements BeliefModel` (`mean/variance/pdf/cdf/sample/quantile/serialize`).
- [ ] `BeliefModel` interface + `kind` discriminator (v2-ready, `TDD.md §4.1`).
- [ ] `contracts.ts`: contract types + payoff `f(θ)` for linear/call/put/binaryCall/binaryPut/spread/gaussian; param normalization + `contract_key` hash.
- [ ] `pricing.ts`: closed-form `price()` per `MODEL.md §4.2`; `dPrice_dMu()`; Gauss–Hermite fallback.
- [ ] `spread.ts`: `MODEL.md §4.3` with breakdown object; uses corrected `mmShort` (`TDD.md §2.1`).
- [ ] `signal.ts` + `bayes.ts`: `MODEL.md §5.2/5.3`, σ²≥σ_min² clamp; `lr/decay` variant flag.
- [ ] `solvency.ts`: `liability`, `expectedLiability`, `requiredReserve` (analytic kink+quantile fast-path **and** seeded MC), `maxExecutable`.
- [ ] `stats.ts`: payout distribution stats (`TDD.md §8`) — expected/var/maxOrP99/P(profit)/VaR/CVaR/breakeven.
- [ ] **Tests:** §17.1 table; put-call parity; binary prob sum; price monotonic in μ; reserve ≥ expected liability; precision-monotone update; `Phi/phi` property tests; MC reproducibility under fixed seed.
**Checkpoint:** `bun test packages/core` fully green; call/put/gaussian/bayes numbers match the spec table.

---

## Phase 2 — Shared contracts & DB foundation `[shared, api]` `[blocked-by: 1]`
**Goal:** typed DTOs + schema + migrations + admin seed.
- [ ] `shared`: enums (MarketStatus, ContractType, …), zod DTOs for every API body/response, `money.ts` (numeric round-half-even, add/sub/mul guards), re-export `BeliefStateDTO`.
- [ ] `api`: Drizzle schema for all tables (`TDD.md §9`) + relations + indexes.
- [ ] `drizzle-kit` migrations; `db:migrate` script.
- [ ] `db:seed`: upsert admin (`ADMIN_USERNAME/PASSWORD`, `role=admin`, `is_infinite=true`); a couple demo users.
- [ ] DB access layer / repositories (thin) per entity.
**Checkpoint:** migrate + seed against Postgres; admin row present; `bun test` (shared zod round-trips) green.

---

## Phase 3 — API skeleton, auth, admin user mgmt `[api]` `[blocked-by: 2]`
**Goal:** server boots; auth works; admin can top up.
- [ ] Elysia app: cors, swagger, jwt, error handler, request logging; health route.
- [ ] `AuthSvc` + routes: register/login (`Bun.password` hash), `/auth/me`; JWT bearer guard; `requireAdmin` guard.
- [ ] `/admin/users` list; `POST /admin/users/:id/topup` (credits balance, audit row); admin infinite-balance handling.
- [ ] WS plugin mounted at `/ws` with subscribe/topic plumbing (no domain events yet).
**Checkpoint:** register→login→/me; admin token tops up a user (visible balance change); Swagger UI lists routes.

---

## Phase 4 — Market lifecycle & admin market mgmt `[api]` `[blocked-by: 3]`
**Goal:** admin creates and drives markets through states.
- [ ] `MarketSvc`: create market (validate cfg, defaults from `MODEL.md §14.1`, set `μ₀/σ₀`, seed `cash=R₀`, mint creator LP shares `=R₀`, init pool).
- [ ] Lifecycle transitions (`TDD.md §7`): open/suspend/resume/resolve(θ*)/cancel/close with guards + state machine; persist + emit `market_status`.
- [ ] `OracleSvc`: manual θ* entry on resolve; store `oracles` row.
- [ ] Public reads: `GET /markets`, `/markets/:id` (belief, cfg, pool NAV via `core`).
- [ ] Per-market serialization queue scaffold (`TDD.md §5.5`) + `markets FOR UPDATE` in txns.
**Checkpoint:** admin creates a market with R₀, opens it; `GET /markets/:id` shows consensus μ/σ and pool NAV; can suspend/resume.

---

## Phase 5 — Quoting & trade engine `[api]` `[blocked-by: 4]`
**Goal:** real buy/sell with belief updates and solvency gating.
- [ ] `POST /markets/:id/quote`: pure `core` quote w/ spread breakdown + projected belief/reserve (no state).
- [ ] `TradeEngine.execute` (`MODEL.md §7.2` corrected, `TDD.md §5.2`): fair→spread→exec→slippage→balance/position checks→tentative apply→reserve recompute→solvency gate (`cash≥1.2×Reserve` to open)→commit txn→emit events.
- [ ] Contract upsert by `contract_key`; update `mm_short`, `positions` (avg-entry accounting), `cash`, belief; write `trades` + `belief_updates`.
- [ ] Sell-only-what-you-hold; "close position" = sell full holding at bid.
- [ ] Partial fill via `maxExecutable` (`MODEL.md §7.3`).
- [ ] WS emit: `trade_executed`, `belief_update`, `price_change`, `reserve_update`.
- [ ] Insolvency-rejection + circuit breakers subset (`TDD.md §15`).
**Checkpoint (integration test):** create→open→several buys/sells move μ correctly, cash/reserve update, a deliberately oversized trade is rejected for insolvency, a partial fill works.

---

## Phase 6 — Settlement & trader claims `[api]` `[blocked-by: 5]`
**Goal:** resolve a market and let traders claim.
- [ ] On `resolve(θ*)`: compute every position payout `Σ position·f(θ*)` (`MODEL.md §8`), record `claims` rows (computed, uncredited), transition RESOLVED→ payouts ready.
- [ ] `POST /markets/:id/claim` (SETTLED): idempotent credit of recorded payout to balance; mark claimed.
- [ ] Optional per-contract proximity/tiered settlement config (`MODEL.md §8.3`), off by default.
- [ ] CANCELLED path: unwind trades at cost basis, refund.
**Checkpoint:** full trade→resolve→claim crediting verified; double-claim is a no-op; cancel refunds.

---

## Phase 7 — Liquidity provision `[api]` `[blocked-by: 5]`
**Goal:** LP deposit/withdraw/claim with NAV share accounting (`TDD.md §6`).
- [ ] `LpSvc`: NAV = `cash − Σ mmShort·price`; share price; deposit (mint pro-rata), withdraw (solvency-gated burn), records to `lp_positions`/`lp_ledger`.
- [ ] Routes: `GET /markets/:id/lp`, `POST …/lp/deposit|withdraw`; serialized on market queue.
- [ ] LP settlement: `cash_final = cash − Σ user_payouts`; `POST …/lp/claim` credits `share% · cash_final`; LP PnL.
- [ ] WS `lp_update`.
**Checkpoint (integration):** LP deposits → capacity rises → trades occur → resolve → LP claim reflects MM PnL (spread income minus payout losses), creator's R₀ included.

---

## Phase 8 — Stats services `[api]` `[blocked-by: 5,6,7]`
**Goal:** all the "proper statistics" endpoints.
- [ ] `StatsSvc`: market stats (volume, #trades/#traders, spread income, E[L], reserve util, creator/MM PnL, belief drift, calibration) → `GET /markets/:id/stats`, `GET /admin/markets/:id/overview`.
- [ ] Portfolio: `GET /users/me/portfolio` (per-market state, position value, PnL, peak profit, drawdown; resolved→final outcome+payout).
- [ ] Position detail `GET /users/me/positions/:contractId` with payout distribution + per-position stats (`TDD.md §8`).
- [ ] Belief/price history endpoints for charts.
**Checkpoint:** endpoints return correct, formula-backed numbers (cross-checked against `core` and hand calc on a seeded scenario).

---

## Phase 9 — Frontend: auth, markets, trade centerpiece `[web]` `[blocked-by: 5]`
**Goal:** interactive trading UI.
- [ ] Vite+React+TS+Tailwind; TanStack Query; WS hook merging live ticks; auth (token storage, guarded routes).
- [ ] Markets list page (status, consensus μ, σ band, your-position badge).
- [ ] Market/Trade page:
  - [ ] **BeliefPDF** Gaussian chart (mean line + CI band), live via WS.
  - [ ] **Contract composer**: pick type; drag strike/center/width/bounds on chart; payoff overlay + shaded winning region.
  - [ ] **Quote panel**: live fair/spread breakdown/exec price/total cost, slippage (maxPrice), Buy/Sell, projected belief+reserve.
  - [ ] Price-vs-strike mini-chart; belief history (μ±σ over time); recent-trades tape.
  - [ ] Position stats panel for holdings in this market.
**Checkpoint:** log in, open a market, compose a contract on the chart, see live quote, execute a trade, watch belief/PDF/price update live.

---

## Phase 10 — Frontend: portfolio, LP, admin panel `[web]` `[blocked-by: 6,7,8,9]`
**Goal:** complete the user/admin surfaces.
- [ ] **Portfolio**: all markets touched; per-market state/PnL/peak/drawdown; RESOLVED→outcome+payout+**Claim**; expand→positions, belief snapshot, payout distribution.
- [ ] **LP page**: pool NAV/share price/your shares+%/est. value; Deposit/Withdraw; post-resolution **Claim** (separate); LP PnL.
- [ ] **Admin Panel**: create market (full cfg + R₀); list own markets; per-market overview (trades, traders, volume, exposure curve, reserve util, **creator/MM PnL**); lifecycle buttons incl. resolve(θ*); user list + **top-up**.
**Checkpoint:** end-to-end demo: admin creates+funds market & tops up a user → user trades → admin resolves → user claims → portfolio & LP reflect final PnL; admin overview shows creator-side profitability.

---

## Phase 11 — Hardening, sim, polish `[all]` `[blocked-by: 10]`
- [ ] Integration suite: lifecycle, LP, solvency rejection, partial fill, concurrency (parallel trades stay consistent), claim idempotency, cancel refund.
- [ ] Monte-Carlo simulation tool (`MODEL.md §17.3`): belief accuracy, 80%-CI calibration, MM/LP profitability — also tunes default params.
- [ ] Circuit breakers wired to WS `system:alert`; admin sees alerts.
- [ ] Playwright smoke (trade→resolve→claim). Error states, empty states, loading skeletons. Final README + run instructions.
**Checkpoint:** `bun test` (core+api) green; sim reports sane calibration; manual demo script passes start-to-finish.

---

### Suggested execution order
0 → 1 → 2 → 3 → 4 → 5 → (6 ∥ 7) → 8 → 9 → 10 → 11.
Phases 6 and 7 both depend only on 5 and can be built in parallel. Frontend (9) can start against 5's endpoints while 6/7/8 land.

### Definition of done (v1)
Admin (from `.env`) creates/funds/resolves markets and tops up users; users register, trade user-composed continuous-outcome contracts against a live Gaussian BMM with correct closed-form pricing, spreads, and Bayesian belief updates; solvency is enforced; LPs provide/withdraw/claim with pro-rata NAV accounting; resolved markets pay out via explicit Claim; portfolio and admin panel show formula-backed statistics; interactive charts drive trading. All `MODEL.md §17.1` numbers reproduced in tests.
