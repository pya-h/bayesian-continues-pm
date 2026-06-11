# TASKS — Web2 BMM Continuous Prediction Market (v1)

Phased build plan. Companion to `TDD.md` (design) and `MODEL.md` (spec). Each phase ends with a runnable checkpoint; do phases in order, `[blocked-by]` notes hard deps.

Legend: `core` · `shared` · `api` · `web`.

---

## Testing strategy (every phase)
- **Unit — pure, no IO.** Math engine, money/DTO, and the pure API helpers pulled out of the services (exec price, average-entry accounting, fill sizing). Every pure module ships a sibling test; logic that can be IO-free should be, so it's testable without a DB.
- **Integration — real DB.** `app.handle` against a local Postgres, guarded on env, creating throwaway rows and cleaning them up. Covers the HTTP surface, persistence, and serialization.
- v1 closes (Phase 11) with a cross-cutting integration suite, a Monte-Carlo simulation, and a Playwright smoke.

A phase is DONE when its pure logic has unit tests and its endpoints have integration tests, all green.

---

## Phase 0 — Scaffold & tooling DONE
**Goal:** monorepo boots, lints, type-checks; Postgres reachable.
- [x] Bun workspaces + scripts (dev/build/test/typecheck/lint/db).
- [x] Strict `tsconfig` base (`noUncheckedIndexedAccess`) + per-package extends.
- [x] Biome for lint + format.
- [x] Postgres via docker-compose (optional — dev runs against a local `DATABASE_URL`); `.env.example`, `.env` gitignored.
- [x] Package skeletons: core, shared, api (Elysia health server), web (React + Vite).
- [x] README quickstart.
**Checkpoint:** install/build/test/typecheck/lint green; API serves `/health`; local Postgres connects and is writable.

---

## Phase 1 — Core math engine (the heart) `[core]` DONE
**Goal:** every `MODEL.md §17.1` number reproduced; invariants hold. No IO.
- [x] Numerics: `phi`/`Phi` (erf series + continued fraction, ~1e-12), `erf`/`erfc`, `normInv` (Acklam + Halley), seedable `Rng` (mulberry32).
- [x] `GaussianBelief implements BeliefModel` (mean/variance/stddev/pdf/cdf/quantile/sample/serialize).
- [x] `BeliefModel` interface + `kind` discriminator (v2-ready).
- [x] Payoffs for the seven contract types; `validateContract`, `contractKey`, `payoffKinks`, `payoffBounds`.
- [x] Closed-form `price()` + `dPriceDMu()`; numerical fallback is fixed composite Simpson (bounded cost, can't hang on kinked integrands — not Gauss–Hermite).
- [x] Spread breakdown with corrected `mmShort`; intensity in adverse-selection, relative σ in vol.
- [x] Signal + Bayes update, σ²≥σ_min² clamp; `lr`/`decay` variant behind a flag; SPREAD/GAUSSIAN signal extensions.
- [x] Solvency: `liability`, `expectedLiability`, `requiredReserve` (seeded MC — analytic kink fast-path skipped, MC is correct and fast enough), `maxExecutable`.
- [x] Payout-distribution stats: expected/var/maxOrP99/P(profit)/VaR/CVaR/breakeven; closed-form `secondMoment`.
- [x] Config defaults + barrel.
- [x] Tests: §17.1 rows; put-call parity; binary prob sum; price monotone in μ; reserve ≥ expected liability; precision-monotone update; `Phi`/`phi`/`normInv` accuracy; MC reproducibility under a fixed seed.
**Checkpoint:** core green; call price ≈416.577 and the conjugate update match the spec.

---

## Phase 2 — Shared contracts & DB foundation `[shared, api]` `[blocked-by: 1]` DONE
**Goal:** typed DTOs + schema + migrations + admin seed.
- [x] `shared`: enums, zod DTOs (contract spec, belief, market cfg, register/login, create-market, quote/trade, LP deposit/withdraw, topup), money helpers (round-half-even + add/sub/mul/sum).
- [x] `api`: Drizzle schema for all tables + indexes + uniques; custom `numeric(20,8)`⇄`number` money type; θ/belief as double precision.
- [x] Migration generation + programmatic `db:migrate`; scripts load the root `.env`.
- [x] DB layer: url normalizer (strips Prisma `?schema=`, sets search_path), lazy client, thin user repo.
- [x] `db:seed`: upsert admin (`role=admin`, `is_infinite=true`) + demo users; idempotent.
**Checkpoint:** migrate + seed create all tables and the infinite admin; re-running is idempotent.

---

## Phase 3 — API skeleton, auth, admin user mgmt `[api]` `[blocked-by: 2]` DONE
**Goal:** server boots; auth works; admin can top up.
- [x] Elysia app: cors, swagger, jwt, `onError`, request logging, `/health`.
- [x] Auth routes: register/login (`Bun.password` argon2), `/auth/me`; global `user` derive + `requireAuth`/`requireAdmin` guards.
- [x] `GET /admin/users`; `POST /admin/users/:id/topup` (credits balance + audit row; infinite users untouched). Added the `audit_events` table.
- [x] WS `/ws` (subscribe/unsubscribe/ping) + a publish bus (`market:`/`user:`/`system` topics) for later domain events.
**Checkpoint:** auth integration suite (register/dup/bad-login/me/guards/topup) green.
**Note:** host port 4000 is occupied on this machine — set `PORT` (+ `VITE_API_URL`/`VITE_WS_URL`) to a free port to run the live server.

---

## Phase 4 — Market lifecycle & admin market mgmt `[api]` `[blocked-by: 3]` DONE
**Goal:** admin creates and drives markets through states.
- [x] `createMarket`: resolve `EngineConfig` from (μ₀,σ₀)+overrides, seed `cash=R₀`, mint creator LP shares `=R₀` + genesis ledger entry — one transaction; non-infinite creators debited.
- [x] Lifecycle state machine: open/suspend/resume/resolve(θ*)/cancel/close with validated transitions; `FOR UPDATE` on the market row; persist + emit `market_status` + audit row.
- [x] Oracle: manual θ* recorded on resolve (folded into the transition).
- [x] Public reads: `GET /markets`, `GET /markets/:id` → belief μ/σ, cfg, pool NAV = cash − E[L], share price.
- [x] Per-market serialization queue + `markets FOR UPDATE` in lifecycle txns.
**Checkpoint:** create→CREATED seeded R₀; GET shows belief + NAV + share price + cfg override; open→suspend→resume; illegal transition rejected; resolve records θ*. (api tests run with `--isolate` so per-file `sql.end()` don't cross-close the shared pool.)

---

## Phase 5 — Quoting & trade engine `[api]` `[blocked-by: 4]` DONE
**Goal:** real buy/sell with belief updates and solvency gating.
- [x] `POST /markets/:id/quote`: pure quote with spread breakdown + projected belief/reserve + max feasible fill (no state); auth.
- [x] `TradeEngine.execute` (`MODEL.md §7.2` corrected): fair→spread→exec→slippage→balance/position checks→size fill→tentative apply→reserve recompute→solvency gate→commit→emit. Serialized per market (`withMarketLock` + `FOR UPDATE` on market & trader rows).
- [x] Contract upsert by `contract_key`; update `mm_short`, positions (avg-entry), cash, belief; write trades + belief_updates.
- [x] Sell-only-what-you-hold; "close position" = sell full holding at bid.
- [x] Partial fill via `solveFill` (monotone binary search on the solvency frontier). **Solvency model:** a buy's own premium inflow is not counted as backing for the risk it creates (`effectiveCash = cash + min(0, totalCost)`), so a trade can't self-fund unbounded exposure; margin `effectiveCash ≥ 1.2×Reserve` to open new risk, `≥ 1×` to reduce. Sizing and acceptance share the pre-update belief; the post-update reserve is the live mark.
- [x] WS: `trade_executed`, `belief_update`, `price_change`, `reserve_update`.
- [x] Insolvency rejection + circuit-breaker margin subset.
- [x] Tests: `tradeMath` (exec price, average-entry, `solveFill` full/partial/balance-capped); integration for quote shape, buy lifts μ + collects premium + opens reserve, partial sell realizes PnL, sell-what-you-don't-hold rejected, oversized buy partial-fills at the frontier.
**Checkpoint:** buys/sells move μ correctly, cash/reserve update, oversized trade partial-fills at the frontier, sell-only-what-you-hold enforced.

---

## Phase 6 — Settlement & trader claims `[api]` `[blocked-by: 5]` DONE
**Goal:** resolve a market and let traders claim.
- [x] On `resolve(θ*)`: `recordClaims` computes every open position's payout `quantity·f(θ*)` into uncredited `claims` rows, inside the resolve transaction. Status → RESOLVED.
- [x] New `settle` action RESOLVED → SETTLED (admin) — the gate that opens claiming (payouts computed at resolve, creditable only once settled; also where Phase 7 finalizes LP `cash_final`).
- [x] `POST /markets/:id/claim` (SETTLED): idempotent credit of the trader's recorded payouts; marks `claimedAt`. Serialized on the trader row so a double-submit can't double-pay. WS `claim_paid`.
- [x] CANCELLED path (`refundPositions`): refund each non-infinite trader the open cost basis `quantity·avgEntryPrice`, shrink MM cash by the same total — inside the cancel transaction, atomic SQL increments.
- [~] Optional per-contract proximity/tiered settlement (`MODEL.md §8.3`) — **deferred** (off by default; payoff is the exact `f(θ*)`).
- [x] Tests: `settleMath` (`positionPayout` per type ITM/OTM, `positionRefund`); integration resolve→settle→claim once + double-claim no-op, claim-before-settle rejected, cancel refunds cost basis.
**Checkpoint:** full trade→resolve→settle→claim verified; double-claim is a no-op; cancel refunds the cost basis.

---

## Phase 7 — Liquidity provision `[api]` `[blocked-by: 5]` DONE
**Goal:** LP deposit/withdraw/claim with NAV share accounting (`TDD.md §6`).
- [x] `lpMath` (pure): share price (NAV/S_total, genesis 1), `sharesForDeposit` (ΔS = D·S_total/NAV_before), `cashOutForShares` (ΔS/S_total·NAV), `cash_final` (cash−Σpayouts), `lpClaimAmount` (share%·cash_final).
- [x] `lpSvc`: view (pool NAV/share-price/reserve + your shares/%/estValue/claimed); deposit (OPEN, mint pro-rata, debit); withdraw (OPEN, **solvency-gated** — since Reserve is independent of cash, max cash-out = `cash − 1.2·Reserve` is closed-form, so cap and partial-fill the burn rather than reject). Serialized on the market queue + `FOR UPDATE`.
- [x] Routes: view + deposit/withdraw/claim.
- [x] LP settlement: `claim` (SETTLED) credits `share% · cash_final`; idempotent via `lp_positions.claimed` + trader-row `FOR UPDATE`; `S_total` untouched so concurrent LPs each get the right fraction; limited liability (negative split → credit 0). Returns LP PnL.
- [x] WS `lp_update` (deposit/withdraw) + `lp_claim`.
- [~] CANCELLED → LP refund of deposits — **deferred to Phase 11** (v1's sole guaranteed LP is the infinite admin creator, so nothing is stranded in practice).
- [x] Tests: `lpMath` (share price, pro-rata mint, cash-out, cash_final split); integration deposit mints + grows pool, gated withdraw partials at the buffer, full deposit→trade→resolve→settle→LP-claim reflects MM PnL.
**Checkpoint:** LP deposits raise capacity → trades occur → resolve→settle → LP claim reflects MM PnL, creator's R₀ included.

---

## Phase 8 — Stats services `[api]` `[blocked-by: 5,6,7]` DONE
**Goal:** all the "proper statistics" endpoints.
- [x] `marketStats`: volume, #trades/#traders, spread income, E[L], reserve + utilization, MM/pool PnL, belief drift, calibration (θ*∈80% CI) → public subset at `/markets/:id/stats`, full at `/admin/markets/:id/overview`.
- [x] Portfolio: per-position cost basis, bid-mark exit value, unrealized/realized PnL, stored peak profit, drawdown-from-peak; resolved → final {θ*, payout, finalPnl, claimed}; aggregated totals.
- [x] Position detail: `positionStats` payout distribution + mark-path peak/maxDrawdown reconstructed over the belief history at current size.
- [x] Belief/price history (genesis + belief_updates; optional `?contractKey=` → per-belief fair-price series).
- [x] Tests: `statsMath` (seriesStats peak/trough/maxDrawdown, aggregatePnl, ci80/inCi80 with z₈₀≈1.2816); integration for counts/drift, overview aggregates + admin-guard, history series, portfolio bid-mark + final payout, position detail hand-check.
**Checkpoint:** endpoints return correct, formula-backed numbers, cross-checked against `core` and hand calc on a seeded scenario.

---

## Phase 9 — Frontend: auth, markets, trade centerpiece `[web]` `[blocked-by: 5]` DONE
**Goal:** interactive trading UI.
- [x] Vite + React + Tailwind v4; TanStack Query; WS hook merging live ticks into the cache; auth (localStorage token, `/auth/me` re-hydrate, `RequireAuth` guard).
- [x] Markets list (status badge, consensus μ + σ band, NAV, your-position badge).
- [x] Market/Trade page:
  - [x] BeliefPDF Gaussian chart (custom SVG): filled PDF + mean line + ±1σ band, live via WS.
  - [x] Contract composer + chart handles: pick type; drag strike/center/width/bounds on the chart (pointer-capture, two-way bound to the numeric inputs); payoff overlay + shaded winning region.
  - [x] Quote panel: debounced live fair/spread-breakdown/exec price/total cost, slippage guard (±2%), Buy/Sell, projected belief+reserve, fill receipt; re-quotes on live belief ticks.
  - [x] Price-vs-strike mini-chart (client-side `core.price` sweep); belief history (μ±σ over time); recent-trades tape (WS-fed).
  - [x] Position stats panel for holdings here: bid-mark value, unrealized/realized PnL, expandable payout distribution, Claim when SETTLED.
- [x] Faithfulness: `@bmm/core` is a web dep so the on-chart payoff overlay / price curve are byte-identical to the server engine; chart geometry isolated in pure `viz`.
- [x] Tests (pure, no DOM): `gaussianPdf`, `payoffCurve` equals `core.payoff` for all types + kink injection, `winningRegions`, `probInRegions`, `niceDomain`/`niceTicks`/`scale`. Plus a live wire smoke (create→open→topup→quote→trade→history).
**Checkpoint:** log in, open a market, compose a contract on the chart, see the live quote, execute a trade, watch belief/PDF/price update live. A funded `[DEMO]` OPEN market + topped-up users are seeded for immediate clicking.

---

## Phase 10 — Frontend: portfolio, LP, admin panel `[web]` `[blocked-by: 6,7,8,9]` DONE
**Goal:** complete the user/admin surfaces.
- [x] Portfolio (+ pure `groupPositionsByMarket`): global totals strip; one expandable card per market touched (status, summed PnL, peak, drawdown); SETTLED → market-level Claim; each card expands into its positions reusing the payout-distribution row; the group owns the single claim.
- [x] LP page: pool NAV / share price / total shares / cash / reserve / your stake %; Deposit & Withdraw with live pro-rata previews mirroring `lpMath` (withdraw may partial-fill at the buffer + Max button); your est-value/deposited/withdrawn + LP PnL; separate post-resolution Claim; mutations fold the returned view into the cache.
- [x] Admin Panel (behind `RequireAdmin`): create market (title/desc/unit/bounds/μ/σ/R₀ + collapsible advanced cfg; pure `buildCreateMarketBody` validates + strips blanks); your markets each with lifecycle buttons (open/suspend/resume/close/cancel + resolve with inline θ*, settle) and an expandable overview (volume/trades/traders, spread income, creator/MM PnL, NAV, E[L], reserve util, belief drift, calibration); users list + per-user top-up.
- [x] Client surface + hooks; nav gains Portfolio (all) + Admin (role-gated); MarketPage gains a Manage-liquidity link.
- [x] Tests (pure): `groupPositionsByMarket` sums/orders/claimable-gating, LP deposit/withdraw previews faithful to `lpMath`, `cleanCfg`, `buildCreateMarketBody`, `lifecycleActions`.
**Checkpoint:** live wire smoke — admin create→open→topup→user trade→LP deposit/withdraw→resolve→settle→trader claim (idempotent)→portfolio final→admin overview→LP claim, the LP loss mirroring the trader's gain (faithful zero-sum).

---

## Phase 11 — Hardening, sim, polish `[all]` `[blocked-by: 10]` DONE
- [x] Integration suite for the gaps earlier phases left: solvency rejection (zero-balance buyer → 409, market untouched), concurrency (parallel buys serialize under the lock with no lost updates), cancel refund (OPEN market → trader cost basis fully refunded, MM cash shrinks).
- [x] Monte-Carlo simulation (`MODEL.md §17.3`) — pure, seeded `sim` (`simulateRun`/`runMonteCarlo`): N informed traders around θ*, measuring belief accuracy, 80%-CI calibration, MM profitability, trader welfare. CLI runner + `bun run sim` (σ_obs sweep; tunes defaults).
- [x] Circuit breakers (`MODEL.md §15.1`) — pure `evalBreakers` (belief divergence → alert, rapid move → suspend, insolvency → reject / warn). Wired post-commit → publishes `system:alert` (no auto-suspend in v1; the action field carries the recommendation). Web: `useSystemAlerts` + `AlertsBanner` on the admin panel.
- [x] Playwright smoke in `e2e/` (sign in → markets → open market → composer → portfolio; outside the workspace globs). README rewritten (how-it-works, walkthrough, sim, testing, scripts). Headless `bun run demo` end-to-end (trade→resolve→claim, self-asserting + self-cleaning).
**Checkpoint:** full suite green; `bun run sim` reports sane calibration (informed flow learns, calib₈₀≈0.80 near σ_obs≈σ₀, MM profitable; noise games the MM); `bun run demo` passes start-to-finish on a live server and cleans up.

---

### Suggested execution order
0 → 1 → 2 → 3 → 4 → 5 → (6 ∥ 7) → 8 → 9 → 10 → 11. Phases 6 and 7 both depend only on 5 and can be built in parallel; the frontend (9) can start against 5's endpoints while 6/7/8 land.

### Definition of done (v1)
Admin creates/funds/resolves markets and tops up users; users register and trade user-composed continuous-outcome contracts against a live Gaussian BMM with correct closed-form pricing, spreads, and Bayesian belief updates; solvency is enforced; LPs provide/withdraw/claim with pro-rata NAV accounting; resolved markets pay out via explicit Claim; portfolio and admin panel show formula-backed statistics; interactive charts drive trading. All `MODEL.md §17.1` numbers reproduced in tests.
