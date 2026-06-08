# TASKS — Web2 BMM Continuous Prediction Market (v1)

Phased, step-by-step build plan. Companion to `TDD.md` (design) and `MODEL.md` (spec).
**Convention:** each phase ends with a runnable/verifiable checkpoint. Do phases in order; `[blocked-by]` notes hard deps. Check boxes as you go.

Legend: `core`=`packages/core` · `shared`=`packages/shared` · `api`=`apps/api` · `web`=`apps/web`.

---

## Testing strategy (applies to every phase)
Two complementary layers, both run by `bun test` (api uses `--isolate` — see Phase 4 note):
- **Unit tests — pure, no IO, run unconditionally.** Pure functions tested in isolation: `packages/core` (math engine), `packages/shared` (money/DTO), and pure API helpers extracted out of the services (e.g. `apps/api/src/services/tradeMath.ts` — exec price, average-entry accounting, fill sizing). **Rule:** every new pure module ships with a sibling `*.test.ts`; logic that *can* be made IO-free *should* be, so it can be unit-tested without a DB.
- **Integration tests — real DB.** `app.handle(new Request(...))` against local `bmm_db`, guarded by `describe.if(hasEnv)`, each creating throwaway rows and cleaning them up in `afterAll`. Cover the HTTP surface, persistence, and serialization.
- v1 closes (Phase 11) with a cross-cutting integration suite + a Monte-Carlo simulation, plus a Playwright smoke for the UI happy path.

**Definition of "phase DONE" includes:** its pure logic has unit tests and its endpoints have integration tests, all green; `typecheck` + `lint` clean.

---

## Phase 0 — Scaffold & tooling DONE
**Goal:** monorepo boots, lints, type-checks; Postgres reachable.
- [x] Root `package.json` with **Bun workspaces** `["packages/*","apps/*"]`; scripts: `dev`, `build`, `test`, `typecheck`, `lint`, `db:up/down`, `db:migrate`, `db:seed`.
- [x] `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`) + per-package `tsconfig` (via `extends`; project refs not needed — Bun runs TS sources directly).
- [x] **Biome** at root (lint + format, replaces ESLint+Prettier).
- [x] `docker-compose.yml` with Postgres 16; `.env.example` (all keys from `TDD §13`); `.env` gitignored. *(Docker is now optional — dev runs against a local Postgres via `DATABASE_URL`.)*
- [x] Package skeletons: `core`, `shared`, `api` (Elysia health server), `web` (React+Vite) with index + build.
- [x] `README.md` quickstart (local-Postgres-first; Docker optional).
**Checkpoint:** `bun install`, `bun run build`, `bun run test` (69 core tests), `bun run typecheck` (4/4), `bun run lint` all green; API serves `/health`; local Postgres (`bmm_db`) connects + is writable.

---

## Phase 1 — Core math engine (the heart) `[core]` DONE
**Goal:** every `MODEL.md §17.1` number reproduced; invariants hold. No IO.
- [x] `numerics.ts`: `phi`, `Phi` (erf series + continued fraction, ~1e-12), `erf`/`erfc`, `normInv` (Acklam+Halley), seedable `Rng` (mulberry32), `nextNormal`.
- [x] `gaussian.ts`: `GaussianBelief implements BeliefModel` (`mean/variance/stddev/pdf/cdf/quantile/sample/serialize`).
- [x] `BeliefModel` interface + `kind` discriminator (v2-ready, `TDD §4.1`) in `types.ts`.
- [x] `contracts.ts`: payoffs for linear/call/put/binary_call/binary_put/spread/gaussian; `validateContract`, `contractKey`, `payoffKinks`, `payoffBounds`.
- [x] `pricing.ts`: closed-form `price()` per `MODEL.md §4.2`; `dPriceDMu()`; numerical fallback = **fixed composite Simpson** (not Gauss–Hermite — bounded cost, can't hang on kinked integrands).
- [x] `spread.ts`: `MODEL.md §4.3` breakdown; corrected `mmShort` (`TDD §2.1`); dimensional fixes (intensity in adverse-sel, relative σ in vol — `TDD §2.3`).
- [x] `signal.ts` + `bayes.ts`: `MODEL.md §5.2/5.3`, σ²≥σ_min² clamp; `lr/decay` variant flag; SPREAD/GAUSSIAN signal extensions.
- [x] `solvency.ts`: `liability`, `expectedLiability`, `requiredReserve` (**seeded MC**; analytic kink fast-path deferred — MC is correct & fast enough), `withMmShort`, `maxExecutable`.
- [x] `stats.ts`: payout-distribution stats (`TDD §8`) — expected/var/maxOrP99/P(profit)/VaR/CVaR/breakeven; closed-form `secondMoment`.
- [x] `config.ts` (defaults `MODEL.md §14.1`, `makeEngineConfig`) + `index.ts` barrel.
- [x] **Tests (69):** §17.1 call/bayes rows; put-call parity; binary prob sum; price monotonic in μ; reserve ≥ expected liability; precision-monotone update; `Phi/phi`/`normInv` accuracy; MC reproducibility under fixed seed.
**Checkpoint:** `bun test packages/core` fully green (69 pass); call price 416.577 and the conjugate update match the spec.

---

## Phase 2 — Shared contracts & DB foundation `[shared, api]` `[blocked-by: 1]` DONE
**Goal:** typed DTOs + schema + migrations + admin seed.
- [x] `shared`: `enums.ts` (MarketStatus, ContractType, UserRole, BeliefKind, LpLedgerKind, UserTier), `dto.ts` zod schemas (contractSpec, belief, marketCfg, register/login, createMarket, quote/trade, lp deposit/withdraw, topup), `money.ts` (round-half-even + add/sub/mul/sum), barrel.
- [x] `api`: Drizzle schema for all 10 tables (`TDD §9`) + indexes + uniques; custom `numeric(20,8)`⇄`number` money type; θ/belief as double precision.
- [x] `drizzle-kit generate` → `drizzle/0000_*.sql`; programmatic `db:migrate` (postgres.js migrator); scripts load root `.env` via `--env-file`.
- [x] DB layer: `url.ts` (strips Prisma `?schema=`, sets search_path), `client.ts` (lazy postgres.js + Drizzle), `repos.ts` (thin `userRepo`: byUsername/byId/create/credit).
- [x] `db:seed`: upsert admin (`ADMIN_USERNAME/PASSWORD`, `role=admin`, `is_infinite=true`, tier institutional) + demo users alice/bob (hashed, balance 10k). Idempotent.
**Checkpoint:** migrate + seed against `bmm_db` (all 10 tables created, admin row `is_infinite=true`); re-running migrate/seed is idempotent; `bun test` 78 pass (shared 9 + core 69); typecheck 4/4; lint clean.

---

## Phase 3 — API skeleton, auth, admin user mgmt `[api]` `[blocked-by: 2]` DONE
**Goal:** server boots; auth works; admin can top up.
- [x] Elysia app: cors, swagger (`/swagger`), jwt, `onError` handler, request logging, `/health`.
- [x] Auth routes: register/login (`Bun.password` argon2 hash), `/auth/me`; `authPlugin` (global `user` derive) + `requireAuth` / `requireAdmin` scoped guards.
- [x] `GET /admin/users`; `POST /admin/users/:id/topup` (credits balance + `audit_events` row; infinite users left untouched). Added `audit_events` table (migration 0001).
- [x] WS at `/ws` (subscribe/unsubscribe/ping) + `realtime.ts` publish bus (`market:`/`user:`/`system` topics) for later domain events.
**Checkpoint:** 10-test integration suite (register 201 / dup 409 / bad-login 401 / me / no-token 401 / non-admin 403 / admin list / topup→balance / bad-amount 400) + live HTTP smoke (health, swagger 200, register JWT). Full suite **88 pass** (shared 9 + core 69 + api 10); typecheck 4/4; lint clean.
**Note:** host port 4000 is occupied on this machine — set `PORT` (+ `VITE_API_URL`/`VITE_WS_URL`) to a free port to run the live server.

---

## Phase 4 — Market lifecycle & admin market mgmt `[api]` `[blocked-by: 3]` DONE
**Goal:** admin creates and drives markets through states.
- [x] `MarketSvc.createMarket`: resolve `EngineConfig` from (μ₀,σ₀)+overrides (defaults `MODEL.md §14.1`), seed `cash=R₀`, mint creator LP shares `=R₀` + genesis ledger entry — one transaction; non-infinite creators are debited.
- [x] Lifecycle state machine (`TDD §7`): open/suspend/resume/resolve(θ*)/cancel/close with validated transitions; `FOR UPDATE` on the market row; persist + emit `market_status` WS event + audit row.
- [x] Oracle: manual θ* recorded into `oracles` on resolve (folded into `transitionMarket`).
- [x] Public reads: `GET /markets`, `GET /markets/:id` → `marketView` (belief μ/σ, cfg, pool NAV = cash − E[L], share price) via `core`.
- [x] Per-market serialization queue (`marketQueue.withMarketLock`, `TDD §5.5`) + `markets FOR UPDATE` in lifecycle txns.
**Checkpoint:** 8-test integration (non-admin 403, create→CREATED seeded R₀, GET shows μ=65000/σ=5000 + NAV=1e6 + sharePrice=1 + cfg override, list, open→suspend→resume, illegal-transition 409, resolve θ*, resolve-no-θ* 400). Full suite **96 pass** (shared 9 + core 69 + api 18); typecheck 4/4; lint clean. (Fixed: api tests now run with `--isolate` so per-file `sql.end()` don't cross-close the shared pool.)

---

## Phase 5 — Quoting & trade engine `[api]` `[blocked-by: 4]` DONE
**Goal:** real buy/sell with belief updates and solvency gating.
- [x] `POST /markets/:id/quote`: pure `core` quote w/ spread breakdown + projected belief/reserve + max feasible fill (no state); requires auth.
- [x] `TradeEngine.execute` (`MODEL.md §7.2` corrected, `TDD.md §5.2`): fair→spread→exec→slippage→balance/position checks→size fill→tentative apply→reserve recompute→solvency gate→commit txn→emit events. Serialized per market (`withMarketLock` + `FOR UPDATE` on market & trader rows).
- [x] Contract upsert by `contract_key`; update `mm_short`, `positions` (avg-entry accounting), `cash`, belief; write `trades` + `belief_updates`.
- [x] Sell-only-what-you-hold; "close position" = sell full holding at bid.
- [x] Partial fill (`MODEL.md §7.3`) via `solveFill` (monotone binary search on the solvency frontier). **Solvency model:** a buy's own premium inflow is *not* counted as backing for the risk it creates (`effectiveCash = cash + min(0, totalCost)`), so a trade can't self-fund unbounded exposure; circuit-breaker margin `effectiveCash ≥ 1.2×Reserve` to open new risk (`§15.1`), `≥ 1×` to reduce. Sizing & acceptance share the pre-update belief; the post-update reserve is recorded as the live mark.
- [x] WS emit: `trade_executed`, `belief_update`, `price_change`, `reserve_update` (+ per-user `trade_executed`).
- [x] Insolvency-rejection + circuit-breaker margin subset (`TDD.md §15`).
- [x] **Unit tests (10, no DB):** `tradeMath` — exec price (ask/bid, bid floor), average-entry buys/sells/close + realized PnL, `solveFill` full/partial/balance-capped. **Integration (7, real DB):** quote shape; buy lifts μ + collects premium + opens reserve + records avg-entry position + debits balance; partial sell reduces qty + realizes PnL; sell-what-you-don't-hold → 400; oversized buy → partial fill at the frontier; trade on non-OPEN market → 409; unauthenticated → 401.
**Checkpoint (integration test):** create→open→buys/sells move μ correctly, cash/reserve update, an oversized trade partial-fills at the solvency frontier, sell-only-what-you-hold enforced. Full suite **113 pass** (shared 9 + core 69 + api 35); typecheck 4/4; lint clean.

---

## Phase 6 — Settlement & trader claims `[api]` `[blocked-by: 5]` DONE
**Goal:** resolve a market and let traders claim.
- [x] On `resolve(θ*)`: `settleSvc.recordClaims` computes every open position's payout `quantity·f(θ*)` (`MODEL.md §8`) into uncredited `claims` rows (one per position, `claimedAt=null`), inside the resolve transaction. Status → `RESOLVED`.
- [x] New `settle` lifecycle action `RESOLVED → SETTLED` (admin, `POST /admin/markets/:id/settle`) — the gate that opens claiming. (Kept separate from `resolve` so payouts are *computed* at resolve but only *creditable* once settled; it's also the hook where Phase 7 finalizes LP `cash_final`.)
- [x] `POST /markets/:id/claim` (requires `SETTLED`): idempotent credit of the trader's recorded payouts to balance; marks `claimedAt`. Serialized on the trader row (`FOR UPDATE`) so a double-submit can't double-pay — a second call finds nothing pending (`credited: 0, alreadyClaimed: true`). WS `claim_paid` to the user topic.
- [x] CANCELLED path (`settleSvc.refundPositions`): refund each non-infinite trader the open cost basis `quantity·avgEntryPrice`, shrink MM `cash` by the same total — inside the cancel transaction. Atomic SQL `balance + amount` increments (no cross-market read-modify-write race).
- [~] Optional per-contract proximity/tiered settlement config (`MODEL.md §8.3`) — **deferred** (off by default in v1; payoff is the exact `f(θ*)`). Revisit if a market needs graded settlement.
- [x] **Unit tests (8, no DB):** `settleMath` — `positionPayout` for LINEAR/CALL/PUT/BINARY_CALL/SPREAD/GAUSSIAN (ITM + OTM) and `positionRefund` (cost basis, zero-qty). **Integration (4, real DB):** resolve→settle→claim credits the exact payout once + double-claim no-op; claim before settle → 409; claim with no position → 0-credit no-op; cancel refunds the open cost basis.
**Checkpoint:** full trade→resolve→settle→claim crediting verified; double-claim is a no-op; cancel refunds the cost basis. Full suite **125 pass** (shared 9 + core 69 + api 47); typecheck 4/4; lint clean.

---

## Phase 7 — Liquidity provision `[api]` `[blocked-by: 5]` DONE
**Goal:** LP deposit/withdraw/claim with NAV share accounting (`TDD.md §6`).
- [x] `services/lpMath.ts` (PURE): `lpSharePrice` (NAV/S_total, genesis 1), `sharesForDeposit` (ΔS = D·S_total/NAV_before), `cashOutForShares` (ΔS/S_total·NAV), `lpCashFinal` (cash−Σpayouts), `lpClaimAmount` (share%·cash_final).
- [x] `services/lpSvc.ts`: `getLpView` (pool NAV/share-price/reserve + your shares/%/estValue/claimed). `deposit` (OPEN only, mint pro-rata, debit depositor, `lp_positions` + `lp_ledger`). `withdraw` (OPEN only, **solvency-gated**: since `Reserve` is independent of cash, max cash-out = `cash − 1.2·Reserve` is closed-form → cap to that and **partial-fill** the burn rather than reject; credits depositor). Both serialized on the market queue + `FOR UPDATE` on market & trader rows.
- [x] Routes: `GET /markets/:id/lp`, `POST …/lp/deposit|withdraw|claim` (`routes/lp.ts`, requireAuth), wired in index.ts.
- [x] LP settlement: `claim` (SETTLED only) credits `share% · cash_final` where `cash_final = cash − Σ recorded trader payouts`; **idempotent** via `lp_positions.claimed` + trader-row `FOR UPDATE`; `S_total` left untouched so concurrent LPs each get the right fraction; **limited liability** (negative split → credit 0). Returns LP PnL = `credited + totalWithdrawn − totalDeposited`.
- [x] WS `lp_update` (market topic, on deposit/withdraw) + `lp_claim` (user topic).
- [~] **CANCELLED → LP refund of deposits** (`TDD §6.4/§7`) — **deferred to Phase 11**. Phase 6 already refunds *traders* on cancel; LP-side cancel refund (non-infinite LPs) is folded into the Phase 11 cancel-refund integration. v1's sole guaranteed LP is the infinite admin creator, so nothing is stranded in practice.
- [x] **Unit tests (8, no DB):** `lpMath` — share price (genesis + NAV/S), pro-rata mint (price 1 + grown pool), cash-out (pro-rata + zero-shares), `cash_final` split (two LPs exhaust it). **Integration (6, real DB):** deposit mints pro-rata + debits balance + grows pool; free withdraw returns cash/burns shares; gated withdraw → partial at the 1.2× buffer; deposit on non-OPEN → 409; full deposit→trade→resolve→settle→LP-claim reflects MM PnL (credited > deposit, creator R₀ included, two claims exhaust cash_final) + double-claim no-op; claim before settle → 409.
**Checkpoint (integration):** LP deposits → capacity rises → trades occur → resolve→settle → LP claim reflects MM PnL (spread income minus payout losses), creator's R₀ included. Full suite **139 pass** (shared 9 + core 69 + api 61); typecheck 4/4; lint clean.

---

## Phase 8 — Stats services `[api]` `[blocked-by: 5,6,7]` DONE (2026-06-08)
**Goal:** all the "proper statistics" endpoints.
- [x] `StatsSvc` (`services/statsSvc.ts`): `marketStats` (volume=Σ|totalCost|, #trades/#traders, spread income=Σ spread·|q|, E[L], reserve + util=reserve/cash, MM/pool PnL=NAV+Σwithdrawn−Σdeposited, belief drift=μ−μ₀, calibration=θ*∈80% CI) → public subset `GET /markets/:id/stats` + full `GET /admin/markets/:id/overview` (admin-guarded).
- [x] Portfolio: `GET /users/me/portfolio` — per-position cost basis, bid-mark exit value (fair−close-spread), unrealized/realized PnL, stored peak profit, drawdown-from-peak; resolved→final {θ*, payout=q·f(θ*), finalPnl, claimed}. Aggregated totals.
- [x] Position detail `GET /users/me/positions/:contractId` — `core.positionStats` payout distribution (expected/std/maxIsP99/pProfit/var95/cvar95/breakeven) + mark-path peak/maxDrawdown reconstructed over the belief history at current size (`TDD.md §8`).
- [x] Belief/price history `GET /markets/:id/history` (genesis + belief_updates; optional `?contractKey=` → per-belief fair-price series).
- [x] **Unit tests** (`statsMath.test.ts`, pure): seriesStats peak/trough/maxDrawdown (drawdown=worst peak-to-trough, not peak-to-last), aggregatePnl, ci80/inCi80 (z₈₀=normInv(0.9)≈1.2816). **Integration** (`stats.test.ts`, seeded CALL trade): /stats counts+drift, /overview MM aggregates + admin-guard 403, /history belief+price series, portfolio bid-mark + final payout (q·(θ*−K)=800), position detail expectedPayout=q·fair hand-check + maxIsP99 + breakeven>K, 404 on unowned position.
- Pure helpers in `services/statsMath.ts`; mark uses bid (exit) for portfolio value, mid (fair) for impliedPrice. Reads-only (no locks).
**Checkpoint:** endpoints return correct, formula-backed numbers (cross-checked against `core` and hand calc on a seeded scenario). **Suite now 155 (shared 9 + core 69 + api 77); typecheck 4/4; lint clean.**

---

## Phase 9 — Frontend: auth, markets, trade centerpiece `[web]` `[blocked-by: 5]` DONE (2026-06-08)
**Goal:** interactive trading UI.
- [x] Vite+React+TS+**Tailwind v4** (`@tailwindcss/vite`); TanStack Query; WS hook (`useMarketSocket`) merging live ticks into the query cache; auth (`AuthContext`, localStorage token, `/auth/me` re-hydrate, `RequireAuth` guard + guarded `Layout` routes).
- [x] Markets list page (status badge, consensus μ + σ band, NAV, your-position badge from portfolio).
- [x] Market/Trade page (`MarketPage`):
  - [x] **BeliefPDF** Gaussian chart (`BeliefChart`, custom SVG): filled PDF + mean line + ±1σ band, live via WS belief ticks.
  - [x] **Contract composer** (`ContractComposer` + chart handles): pick type; **drag** strike/center/width/bounds on the chart (pointer-capture, two-way bound to the numeric inputs); payoff overlay + shaded winning region (`viz.winningRegions`).
  - [x] **Quote panel** (`QuotePanel`): debounced live fair/spread-breakdown/exec price/total cost, slippage guard (`maxPrice` ±2%), Buy/Sell, projected belief+reserve, fill receipt; re-quotes on live belief ticks.
  - [x] Price-vs-strike mini-chart (`PriceCurveChart`, client-side `core.price` sweep); belief history (`BeliefHistoryChart`, μ±σ over time); recent-trades tape (`TradesTape`, WS-fed).
  - [x] Position stats panel for holdings in this market (`PositionPanel`): bid-mark value, unrealized/realized PnL, expandable `core.positionStats` payout distribution, + Claim when SETTLED.
- [x] **Faithfulness:** added `@bmm/core` as a web dep so the on-chart payoff overlay / price curve are byte-identical to the server's engine. Chart geometry isolated in pure `lib/viz.ts`.
- [x] **Tests (25, pure, no DOM):** `test/viz.test.ts` — `gaussianPdf` (peak/symmetry/∫≈1), `payoffCurve` equals `core.payoff` for all 7 types + kink injection, `winningRegions` per type, `probInRegions` = 1−Φ, `niceDomain` clamp/widen, `niceTicks`/`scale`. **Live wire smoke:** admin create→open→topup→quote→trade (belief moved)→history all green on `http://localhost:4100`.
**Checkpoint:** log in, open a market, compose a contract on the chart, see live quote, execute a trade, watch belief/PDF/price update live. Web typecheck + lint clean; `vite build` succeeds (99 kB gzip); full suite **181 pass** (shared 9 + core 70 + api 77 + web 25). A funded **[DEMO]** OPEN market + topped-up alice/bob are seeded in `bmm_db` for immediate clicking.
**Run:** `bun run dev` (web on :5173, api on :4000 — but **host port 4000 is occupied here**, so start the api with a free `PORT` and point the web client at it via `VITE_API_URL`/`VITE_WS_URL`, e.g. `PORT=4100 bun run --filter '@bmm/api' dev` + `VITE_API_URL=http://localhost:4100 VITE_WS_URL=ws://localhost:4100/ws bun run --filter '@bmm/web' dev`).

---

## Phase 10 — Frontend: portfolio, LP, admin panel `[web]` `[blocked-by: 6,7,8,9]` DONE (2026-06-08)
**Goal:** complete the user/admin surfaces.
- [x] **Portfolio** (`PortfolioPage` + pure `groupPositionsByMarket`): global totals strip (market value / unrealized / realized / total PnL); one expandable card per market touched (status, summed PnL, peak, drawdown-from-peak); SETTLED→market-level **Claim payouts** button; each card expands into its positions reusing `PositionRow` (payout distribution via `core.positionStats`, resolved θ*/payout/finalPnl). `PositionRow` exported + `hideClaim` prop so the group owns the single claim.
- [x] **LP page** (`LpPage` at `/markets/:id/lp`): pool NAV / share price / total shares / cash / reserve / your stake %; **Deposit** & **Withdraw** with live pro-rata previews (pure `lpDepositPreview`/`lpWithdrawPreview` mirroring `lpMath`, withdraw "may partial-fill at the 1.2× buffer" note + Max button); your est-value/deposited/withdrawn + **LP PnL**; separate post-resolution **Claim** (SETTLED only) showing credited + pnl; mutations fold the returned `LpView` into the cache and re-pull balance.
- [x] **Admin Panel** (`AdminPage` at `/admin`, behind new `RequireAdmin` guard): **create market** (title/desc/unit/bounds/μ/σ/R₀ + collapsible advanced cfg — reserveAlpha/s0/gamma/lambda/eta/qMax/qThreshold/lr; pure `buildCreateMarketBody` validates + strips blanks); **your markets** (filtered by `creatorId`) each with `lifecycleActions(status)` buttons (open/suspend/resume/close/cancel + **resolve** with inline θ* input → `{thetaStar}`, settle) and an expandable **overview** (`GET /admin/markets/:id/overview`: volume/trades/traders, spread income, **creator/MM PnL**, NAV, E[liability], reserve util, belief drift, 80%-CI calibration); **users** list + per-user **top-up**.
- [x] Client surface: `api.{lp,lpDeposit,lpWithdraw,lpClaim,adminCreateMarket,adminLifecycle,adminOverview,adminUsers,adminTopup}`; hooks `useLpView`/`useAdminUsers`/`useAdminOverview`; nav gains **Portfolio** (all) + **Admin** (role-gated); MarketPage gains a **Manage liquidity →** link.
- [x] **Tests (21 new, pure → web suite 46):** `test/derive.test.ts` — `groupPositionsByMarket` sums/orders/claimable-gating, `lpDepositPreview`/`lpWithdrawPreview` (genesis + pro-rata + clamp, faithful to `lpMath`), `cleanCfg`, `buildCreateMarketBody` (trim/strip/validate/inverted-bounds), `lifecycleActions` transitions.
**Checkpoint:** live wire smoke on `:4100` — admin create→open→**topup**→user **trade**→LP **deposit/withdraw**→**resolve θ\*=130**→**settle**→trader **claim** (payout 3000, idempotent 2nd=0)→**portfolio** final (finalPnl +2046.26, claimed)→**admin overview** (mmPnl + calibration)→**LP claim** (pnl −2046.26 = faithful zero-sum vs the trader's gain). All green. Web typecheck + lint clean; full repo typecheck 4/4, lint clean; `vite build` ok (105 kB gzip); **full suite 202 pass** (shared 9 + core 70 + api 77 + web 46). Smoke artifacts cleaned from `bmm_db`; the **[DEMO]** market remains.

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
