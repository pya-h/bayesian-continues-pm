# TASKS — BMM Continuous Prediction Market **V2**

Phased plan for V2. Companion to `V2-TDD.md`. **Prerequisite: V1 shipped** (`TDD.md` / `TASKS.md` done). All V2 work is additive — V1 markets keep behaving exactly as before (`belief_kind='gaussian'`, 1× cash-collateralized).

Legend: `core`/`shared`/`api`/`web` as in V1. Each phase ends with a runnable checkpoint. `[blocked-by]` = hard deps.

> **Math-doc sync (standing rule).** The interactive math doc (`docs/math/index.html`) is the public source-of-truth explainer. After every phase that changes the math — new belief models, pricing/`dPrice_dMu`, adaptive-parameter rules, reserve/sampler changes — its checkpoint isn't complete until the doc matches: add/derive the new formulas, refresh affected worked examples, keep both Trader and Developer modes consistent with the shipped code, and verify it renders (0 tag/KaTeX errors). Phases that touch no math (scale/ops, transaction ledger) note "math-doc: n/a".

**Recommended order:** V2-1 (beliefs) → V2-2 (adaptive, builds on beliefs) alongside V2-3 (oracles) → V2-7 (hardening) → V2-8 (belief-history chart, last). The transaction-ledger / admin-history phases (V2-5/V2-6) are independent and already done. Scale & ops (the former V2-4) is moved out to its own `scaling` milestone — not needed at dev stage.

> **Moved to V3.** Leverage, margin, shorting & liquidation, the insurance fund that backstops them, and hedging (MM reserve reduction) are deferred to **V3** (`docs/v3/`). Without shorting/borrowed exposure there is no margin gap-loss or user bankruptcy for the fund to absorb, so those travel together; hedging moves with them as the MM-side risk tool (it lowers the pool's reserve, is independent of leverage, works at 1×). V2 stays 1× cash-collateralized end-to-end.

---

## Phase V2-1 — Multi-modal beliefs `[core, api, web]` (Workstream A) DONE
**Goal:** markets can run on Gaussian Mixture or Student-t, fully priced.
- [x] `MixtureBelief implements BeliefModel` (sample/pdf/cdf/quantile/mean/variance/serialize).
- [x] `StudentTBelief implements BeliefModel` (location-scale t; self-contained lgamma + incomplete-beta CDF + Marsaglia–Tsang gamma sampler).
- [x] Pricing: mixture price = Σ π_k·componentPrice (reuses V1 closed forms, exact); t via the Simpson quadrature fallback; `dPrice_dMu` generalized (mixture = Σ π_k·∂Price_k/∂μ_k, t via central difference); `expectF`/signal/spread/stats all made belief-kind-agnostic.
- [x] Bayes + new `mixture_ops`: `bayesUpdateMixture` (responsibility-weighted per-component update + tempered weight/membership update, log-space) + kind-agnostic `updateBelief` dispatcher; prune / moment-match merge / K-cap / (optional) split.
- [x] Solvency: mixture/t route through `belief.sample()` automatically (sampler per kind).
- [x] `api`: `markets.belief_state` jsonb + `loadBelief`/`beliefPersistFields`; creation accepts a mixture belief; the whole trade path + views + stats + LP + ledger made kind-agnostic; the view exposes components.
- [x] `web`: belief chart renders the general multi-bump pdf + per-component mode markers with live weight %; admin creation editor for mixture modes.
- [x] Tests: mixture price = weighted component sum + vs MC; merge/prune conserve mass+mean; t price vs MC; weight concentrates on the consistent-signal component; mixture create+trade integration.
- [x] Student-t end-to-end: admin creation control (fat-tails toggle + ν editor); `bayesUpdateStudentT` (precision-weighted update in the variance domain, ν held fixed — degrades to the Gaussian update as ν→∞); chart draws the true fat-tailed curve.
- [x] Closed the client-side preview gaps that still assumed Gaussian: `beliefFromView` rebuilds the real model from the view so the live fair estimate, projected belief, and price-vs-strike sweep all price against the market's true belief. Memoised the sweep on what actually shapes the curve so a Student-t drag re-prices only the moving dot, not all 80 points.
- [x] Belief-model sandbox in the math doc (Gaussian/Mixture/Student-t drawn against the equal-(μ,σ) Gaussian so any gap is pure shape); prose on the two reasons markets look Gaussian (kind is fixed at creation; a moderate-ν t differs only in the tails).
**Checkpoint:** create a bimodal-mixture market, trade it, watch component weights shift live and prices stay consistent with MC.

> **Reconciliation — V2-1 was extended out-of-band by the "multi model" track** (`docs/multi model/`, phases G0–G6). Net new since the checkpoint above:
> - **Two more belief models:** Gen·basis (a spawning Gaussian mixture; `model='gen_basis'`, `belief_kind='mixture'`, adaptive mode-spawning + "paint the curve" placement) and Gen·exact (`belief_kind='gen_exact'`, max-entropy `exp(−poly)`, quadrature-priced, v1 location/scale + v2 moment-projection shape-adapting update). A `markets.model` column carries the creator's model; `belief_kind` stays the math representation. Five models total.
> - **Six new contract shapes:** bounded closed-form SKEW_GAUSSIAN / TENT / TRAPEZOID / SIGMOID (G5.1) and conditionally-compatible unbounded POLYNOMIAL / EXPONENTIAL (G5.2), gated by a real `contractBeliefCompatible` integrability/boundedness guard at quote+trade.
> - Admin create-flow refactor (generals primary, classics behind "More models"); placement interaction; demo seed; legacy golden-master; full multi-model lifecycle integration sweep.
>
> **Downstream impact:** V2-2 must tune across all 5 models without colliding with the per-model *shape* adaptivity that already exists (`allowSpawn`/`tauSpawn` for gen_basis, `genExactShapeAdapt` for gen_exact); V2-7 is partially pre-satisfied by G6 (sweep + golden-master + seed); V2-8's ghost-trail snapshot must serialize the general belief forms, which `BeliefStateDTO` already supports.

---

## Phase V2-2 — Adaptive parameters `[core, api, web]` (Workstream C) `[blocked-by: V2-1]` DONE
**Goal:** self-tuning σ_ε and spreads (`MODEL.md §14.2`). Every market's `EngineConfig` is static at creation; make σ_ε, s₀, α/β track the market's realized signal error / volatility within the §14.1 rails, log the trajectory, and let an admin pin overrides.

> **Scope note.** This is MM/pricing-parameter adaptivity and is orthogonal to the per-model *shape* adaptivity that already shipped (gen_basis spawning, gen_exact moment-projection): those adapt the belief density, this adapts the engine constants. But the new σ_ε feeds all five models' Bayesian update (precision `w/σ_ε²`), so the controller must be model-agnostic and verified on a gen_basis / gen_exact market too.

- [x] **core controller** (`adaptive.ts`): pure, belief-kind-agnostic, consuming a stream of scalar signal errors `|s − μ_prior|`. EWMA σ_ε (debiased by the half-normal factor √(π/2), since `E|ε| = σ_ε√(2/π)`), volatility regime from a fast/slow EWMA pair (`regime = clamp(emaFast/emaSlow − 1, 0, cap)`), regime-scaled `s₀ = base·(1+regime)`, optional α/β damping (inverse to the noise ratio; off by default). Every output clamped to the §14.1 rails with per-rail hit flags for the breaker.
- [x] **api wiring + persistence** (`adaptiveCfg.ts`): `liveEngineConfig` derives the live config from the pre-trade controller state; `foldError` advances the EWMAs. Wired into all three trade sites (quote reads live cfg; execute + sell-all price on pre-trade params, then fold → persist `cfg_state` → append `market_cfg_history` → pass the rail-hit to the breaker). Causality: a trade prices on pre-trade params; its surprise tunes the next.
- [x] `markets.cfg_state` jsonb (EWMA state + admin control) + a `market_cfg_history` table (per-fill σ_ε/s₀/α/β/regime/railHit/source).
- [x] Admin pin/override: `GET /admin/markets/:id/cfg` (live + adapted + history) and `PATCH …/cfg` (enable/pin/cfg-overrides, replace-merge).
- [x] Rail-hit circuit breaker: new `param_rail` breaker (info→alert), wired post-commit. Info-only, not auto-SUSPEND — a clamped tuning param is an envelope-edge signal, not a halt condition.
- [x] **sim/backtest**: extended the §17.3 Monte-Carlo with `adaptive`, `strikeAtRead` (traders bet struck at their noisy read so the signal surprise tracks real noise, not the endogenous-to-σ ATM surprise), and `beliefKind` knobs, plus `compareAdaptiveVsStatic`. Defaults preserve the V1 behaviour. Finding: adaptation is ~neutral when σ_obs≈σ₀ but materially improves calibration when σ_obs≳2σ₀ (static overconfident calib≈0.48 → adaptive≈0.79; the σ_ε rides its 2σ₀ rail) — it earns its keep in the volatile regime.
- [x] **web**: an Adaptive-params sub-tab per admin market — live σ_ε/s₀/α/β vs the static baseline, controller state + a rail badge when a clamp binds, σ_ε/s₀ history sparklines, and controls to toggle adaptation or pin σ_ε/s₀. A `param_adapted` WS event refreshes an open view live.
**Checkpoint:** adaptation runs end-to-end (core → api → web), self-tunes within the rails, and the A/B sim shows calibration improving vs static in the volatile regime (incl. a non-Gaussian model).

> **Review fix.** The admin cfg-override PATCH accepted any finite number for any key, so an admin could persist a config that breaks the controller's own invariants — inverted rails (`sigmaEpsLoRatio > sigmaEpsHiRatio`, which pins every value to the wrong edge) or an EWMA weight ≥ 1 (which diverges). Added `validateAdaptiveConfig` and enforced it at ingestion — a malformed override is rejected **400** before persistence (validating the resolved defaults+overrides, so a one-sided override is still caught), keeping the per-trade path free of defensive checks.

---

## Phase V2-3 — Oracle resolution modes & disputes `[shared, api, web]` (Workstream E) DONE
**Goal:** every market resolves through one of three explicit oracle modes (`MODEL.md §11`), replacing the V1 "admin types θ*" path with a first-class, per-market oracle assignment.

> **The three modes** (`market.oracle_mode`):
> 1. **`centralized`** — a specific `role=oracle` account is assigned at creation. After the deadline (`resolves_at`), only that oracle account (or an admin) may resolve it, from a dedicated Oracle panel. No scheduling — a manual human resolution gated by role + deadline. The default/migration mode (assigned to the admin) for non-crypto markets.
> 2. **`api`** — automatic. At the deadline a scheduled job fetches the configured token's price from the in-house **xprices** service (`https://xprices.umbralabs.io`) and resolves with that value as θ*. Crypto-price markets only (gated by a non-null `oracle_token`). A stale/missing/unreachable feed → SUSPEND + oracle-failure alert, retried next tick — never resolve on bad data.
> 3. **`decentralized`** (e.g. UMA) — placeholder only. The enum value + create-form option exist; the resolution path throws not-implemented.
>
> **xprices API:** `GET /prices/{token}` → `{ token_id, price, ema_price, confidence, timestamp, stale? }`; no auth. `stale:true` or an old `timestamp` ⇒ feed failure.
>
> **Scheduler rule:** use the `cron` package (a real scheduled job) — never `setInterval`/`setTimeout` in the backend (front-end timers are fine). Single-node for now; the `scaling` milestone (S-2) replaces it with a leader-elected runner.

- [x] `shared`: `OracleMode` enum; add `oracle` to `UserRole`; oracle/dispute DTOs.
- [x] Schema: `markets` += `oracle_mode`, `oracle_user_id`, `oracle_token`, `resolved_at`, `dispute_window_sec`. Extend the existing `oracles` table as the report log (add `token`, `stale`). New `disputes` table (filer, reason, status open/upheld/rejected, proposed/secondary value, resolver, timestamps).
- [x] Validation: `api` ⇒ `oracle_token` required + market is crypto; `centralized` ⇒ `oracle_user_id` is a `role=oracle` (or admin) user; `decentralized` ⇒ accepted but resolution throws.
- [x] `xprices` client lib (stale/missing detection, timeout, typed result); base-URL via env.
- [x] `cron` job: scan `api`-mode markets past deadline & still OPEN → fetch → resolve (θ* = price). Stale/unreachable → SUSPEND + `oracle_failure` alert; retry next tick. Idempotent under the per-market lock.
- [x] Add the `oracle_failure` breaker kind + wire its alert.
- [x] Admin can grant/revoke the `oracle` role; assign an oracle user at create.
- [x] `GET /oracle/markets` (assigned to the caller, past deadline) + `POST /oracle/markets/:id/resolve`. AuthZ: caller is the assigned oracle or admin; only when `now ≥ resolves_at`.
- [x] On resolve (any mode): status → RESOLVED, `resolved_at = now`, claims computed but credit-gated; the dispute window lives in RESOLVED.
- [x] User `POST /markets/:id/dispute` (holders only, within window) → opens a dispute, blocks auto-settle.
- [x] Admin dispute resolution: uphold (override θ* → re-run `recordClaims`, finalize) or reject. `cron` auto-settles RESOLVED→SETTLED once the window passes and no dispute is open; claiming stays gated on SETTLED, so it falls out of the lifecycle.
- [x] Create-market form: oracle-mode selector (+ oracle-user picker, token field, disabled `decentralized` placeholder). Oracle panel (role-gated). Admin dispute queue.
- [x] Tests: API-mode resolves from a mocked xprices fetch; stale feed suspends + alerts + auto-retries; centralized resolve authZ (assigned oracle, non-oracle 403, before-deadline 409); dispute blocks auto-settle & claims, admin override re-pays, window-pass auto-settles; zero-window auto-settles immediately. Seeded an oracle user + api/centralized demo markets.
**Checkpoint:** an `api` crypto market auto-resolves from the feed at its deadline; a `centralized` market is resolved only by its assigned oracle, not before deadline; a disputed resolution is overridden by an admin before claims open; a stale feed suspends instead of mis-resolving.

> **Review fix.** The `decentralized` placeholder was documented as "cannot resolve yet" but nothing enforced it — an admin could resolve it via the universal manual-override escape hatch, silently treating it like a manual resolve. Added a guard at the resolve chokepoint (`transitionMarket`'s resolve branch) that throws **501 Not Implemented** for `oracle_mode='decentralized'` on every path.

---

## ~~Phase V2-4 — Scale & ops `[api]` (Workstream G)~~ MOVED → `docs/scaling/`
> Horizontal scale isn't needed at the current dev stage, so the whole scale/ops effort was carved into its own `scaling` milestone (`docs/scaling/TASKS.md`), phased there S-1…S-5: Redis-backed per-market distributed lock + WS pub/sub fan-out, leader-per-market routing + leader-elected scheduler, read replicas + hot cache, gateway rate-limiting/metrics/health probes, and multi-node consistency/chaos/load hardening + ops runbook. The single-node in-process implementation stays the default; everything there is opt-in behind config flags.

---

## Phase V2-5 — Transaction ledger & history `[shared, api, web]` (Workstream I) DONE
**Goal:** a single source-of-truth ledger recording every cash movement, surfaced to each user as a Transactions tab with filtering, sorting, and lifetime stats. Additive — no change to how cash moves, we just record it.

**Design:** a `transactions` table written atomically inside the same `db.transaction()` as each balance/cash mutation (the post-commit `audit_events` is incomplete and can't be the source). User-centric: each row belongs to a `userId` with a signed `amount` (+ in, − out), `balanceAfter` (null for infinite/admin), `marketId`, `counterpartyId`, `refType`/`refId`, `metadata`. Admin funding writes two rows (`admin_credit` on the target, `admin_grant` on the admin) so it shows in both histories. Kinds: trade_buy, trade_sell, market_create, lp_deposit, lp_withdraw, lp_claim, claim, refund, admin_credit, admin_grant.

- [x] **Backend ledger:** `TransactionKind` enum; `transactions` table; `recordTx`/`recordTxs` inserting inside the caller's transaction; wired into every cash path (trade, market-create, cancel refund, LP deposit/withdraw/claim, trader claim, admin top-up).
- [x] **Read API + stats:** `GET /users/me/transactions` → caller's history newest-first (joined market title + counterparty) + a summary (funded, claimed, trade buy/sell, LP deposited/withdrawn, refunded, net) via a pure `summarizeTransactions`.
- [x] **Frontend tab:** `/transactions` mirroring Portfolio — stats header, category chips + free-text search + sort, ledger table (kind badge, market link or funding counterparty, signed amount, balanceAfter, relative time); pure `txView` for filter/sort/labels.
**Checkpoint:** a user opens Transactions and sees every action with lifetime stats; an admin's grant and the funded user's credit each appear in their own history.

---

## Phase V2-6 — Admin market history & panel restructure `[api, web]` (Workstream I) DONE
**Goal:** an admin-only per-market cash-flow history (the pool's "bank statement") plus a reorganized admin panel split into focused tabs. No new write-path: the market ledger is reconstructed by aggregation from data already stored — every trade's premium flow, the genesis reserve / LP deposits-withdrawals-claims, trader settlement payouts, and cancel refunds.

- [x] **Market ledger read service** (read-only): a time-ordered cash-flow ledger from `lp_ledger` (genesis + deposits/withdraws/claims) + `trades` (signed `totalCost`) + cancel refunds + `claims`, each `{ at, kind, delta, affectsCash, cashAfter, userId, ref, note }`, plus rollups that reconcile to `markets.cash`. Settlement distributions carry `affectsCash:false` (they don't mutate `markets.cash`; the residual is computed logically). `GET /admin/markets/:id/ledger`.
- [x] **Admin panel restructure:** split `/admin` into tabs — Markets (lifecycle list → per-market Overview / Cash-flow ledger sub-tabs), Users (list + top-up + each user's tx history), Create market, System (alerts + overview). Rollup cards + reconcile badge + filterable/sortable event table.
**Checkpoint:** an admin opens a market and sees its full cash-flow statement reconciling to current pool cash; the admin panel is organized into clear tabs.

---

## Phase V2-7 — Hardening & polish `[all]` `[blocked-by: all]` DONE
> Partially pre-satisfied by G6: the full multi-model lifecycle sweep, the legacy golden-master, and the demo seed already shipped. Remaining: the cross-workstream suite for oracles + adaptive, the adaptive-parameter stability MC, and the ops runbook. (Load/chaos + multi-node scale tests moved with the scale phase to `scaling` S-5.)
- [x] Cross-workstream integration suite (oracles + adaptive): an `api`-oracle crypto market adapts its params as it trades, then the cron tick auto-resolves + auto-settles it, and the adaptive state + history survive the RESOLVED→SETTLED transition; a `centralized` market adapts, is oracle-resolved, disputed, admin-overridden, and settled, with the override re-pay correct. Pins that the cron-oracle and per-fill-adaptive paths compose without interfering. (The V1→V2 behavior-preservation guarantee is pinned by the golden-master, per the no-back-compat stance.)
- [x] Extended Monte-Carlo covering adaptive-parameter stability — a pure characterization on the existing sim: σ_ε stays bounded within the rails across the whole σ_obs spectrum (never diverges); it's a consistent estimator (in an interior regime it walks monotonically toward the true σ_obs as evidence accumulates); a stable saturation in the deeply-volatile regime; and a cross-seed-robust calibration lift. Honest caveat kept: at σ_obs≈σ₀ adaptation is neutral-to-slightly-cautious, so "never harmful" is not claimed — only "bounded everywhere, beneficial in the volatile half".
- [x] Ops runbook (`docs/v2/RUNBOOK.md`): symptom → cause → remediation for oracle feed failure (self-healing sweep + manual escape hatch), the `param_rail` info alert, the three per-trade breakers, disputes, and scheduler stall.
- [x] Final math-doc pass: audit `docs/math/index.html` end-to-end against shipped V2 code (every formula, constant, and worked example re-computed; both modes consistent; 0 tag/KaTeX errors).
**Checkpoint:** full suite green; V1 markets verified unchanged (golden-master + behavior-preservation suites); demo seed exercises beliefs + adaptive params + oracles + disputes end-to-end.

---

## Phase V2-8 — Belief-history visualization (ghost trail) `[web]` `[blocked-by: all]` (Workstream J) DONE
**Goal:** show *how the consensus got here*, not just its current shape — encoding time without a time axis (the belief chart's x-axis is the outcome θ). Pure presentation, no engine change. Done last.

**Design:** a ghost trail — faded snapshots of past belief PDFs overlaid on the same θ-axis, older = more transparent, newest = solid, so the bump visibly drifts and narrows like a comet tail. Time → opacity. For mixtures the ghost is the general multi-modal `pdf(θ)`, so disagreement-then-consensus reads as two bumps fading into one. It lives in its own modal (`BeliefTimeline`), launched from the "Belief μ over time" panel, so the trading chart stays untouched and there's room for a scrubber/play.

**Data dependency:** the trail needs each history point to carry the full belief *shape* (μ/σ alone can't reconstruct a multi-modal PDF), and `belief_updates` stored μ/σ only. So:
- [x] Extended the belief-history record (`belief_updates.belief_state` jsonb) to log the full `BeliefStateDTO` snapshot per update — NULL for Gaussian and the genesis point, the full multi-modal snapshot otherwise.
- [x] `ghostTrail()`: pure helper building N faded PDF polylines from a snapshot series — caps to ~8 evenly-spaced (endpoints kept), monotone old→new opacity ramp, shared peak-normalisation (so a past wider belief draws shorter/broader — shrinkage shows as height, not just width), no input mutation. Reconstruction dispatches on kind via `beliefFromSnapshot` → core `.pdf`.
- [x] `BeliefTimeline`: renders the ghost layer in a modal; scrubber + play walk past → present, spotlighting one snapshot with its μ/σ/time; θ* marker drawn when resolved.
- [x] Tests: the pure ghost-builder (opacity ramp, cap + endpoints, lone-snapshot, shared-normalisation, no-mutate); `beliefFromSnapshot` revival; an API snapshot round-trip (Gaussian → null, gen_basis → mixture snapshots with the spawned mode).
**Checkpoint:** clicking Belief timeline opens the comet-tail drifting/narrowing over the market's life, with a working scrubber/play; the trading chart is untouched.

---

### Definition of done (V2)
Markets run on Gaussian / Mixture / Student-t beliefs with correct pricing and component management; parameters self-tune within spec rails; markets resolve through three oracle modes with a dispute process; every cash movement is captured in a reconciling transaction ledger (user + admin views). Trading stays 1× cash-collateralized — that, MM hedging, the liquidation engine, and the insurance fund are V3. Horizontal scale is its own `scaling` milestone. All V1 behavior is preserved for existing markets.
