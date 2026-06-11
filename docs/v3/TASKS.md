# TASKS — BMM Continuous Prediction Market **V3**

Phased plan for V3. Companion to `docs/v3/TDD.md`. **Prerequisite: V1 and V2 shipped and in use** — in particular **V2-2** (KYC tiers/limits), whose tier table supplies the per-account `leverage_cap`. All V3 work is **additive**: markets without `cfg.margin_rates`/`max_leverage` stay **1× cash-collateralized** and behave exactly as in V2 (no leverage, no shorting, no margin gate).

V3 is the home of the feature deferred out of V2: **leverage, margin, shorting, liquidation** — plus the **insurance fund** that backstops it. (Originally V2 Phases V2-3 and V2-4; see the banner in `docs/v2/TASKS.md`.)

Legend: `core`/`shared`/`api`/`web` as in V1/V2. Each phase ends with a runnable checkpoint. `[blocked-by]` = hard deps.

> ** Math-doc sync (standing rule).** The interactive math documentation (`docs/math/index.html`) is the public source-of-truth explainer for the model. **After every phase that changes the math** — margin/equity/health formulas, the liquidation trigger, penalty/gap-loss flow, short-payout settlement — its checkpoint is **not complete** until `docs/math/index.html` is updated to match: add/derive the new formulas, refresh any affected worked examples (re-compute the numbers), extend the relevant background blocks, and keep both Trader and Developer modes consistent with the shipped code. Verify the doc renders (0 tag errors, 0 KaTeX errors) before closing the phase. Phases that touch no math (pure UX/ops) need no math-doc change — note "math-doc: n/a" in the checkpoint.

> ** Two-solvency invariant (standing rule).** V3 must **never** weaken the V1 MM-solvency / capacity model (`docs/capacity/`). Account **margin** and MM **reserve** are independent gates: every trade passes **both**, and a 1× market's behavior is byte-identical to V2. Every phase adds a regression check asserting this.

**Recommended order:** V3-1 (margin/leverage/shorting core) → V3-2 (insurance fund) → V3-3 (liquidation engine, needs both) → V3-4 (risk UX) → V3-5 (hardening + math-doc). V3-2 is pulled before V3-3 because the liquidation engine draws gap loss from the fund.

---

## Phase V3-1 — Margin, leverage & shorting core `[core, api]` (Workstream B) `[blocked-by: V2-2]`
**Goal:** the `MODEL.md §9.2/§9.3` system — borrowed exposure made safe at the engine level.
- [ ] `core/margin.ts`: pure helpers — `marginRequired(positions, marks, rates)`, `equity`, `freeMargin`, `maintenance(margin, frac)`, `health = equity/maintenance`, and `liquidationLevel(pos)` (the mark at which `equity = maintenance`). No DB, fully unit-tested.
- [ ] `positions.quantity` may be **negative** (short); generalize average-entry `applyFill` so PnL `= qty·(mark − entry)` holds for `qty < 0` (short profits when the mark falls).
- [ ] `markets.cfg` + `margin_rates{<type>:rate}`, `max_leverage`, `maint_margin_frac`, `liq_penalty_frac`; `users` + `leverage_cap` (activate the V2-2 column); `margin_accounts` table; migration (all additive/defaulted ⇒ existing markets read back as 1×).
- [ ] `TradeEngine`: **margin gate** in the per-account check (post-trade `margin_required ≤ equity × min(tier,market) leverage` and `free_margin ≥ 0`), *in addition to* the unchanged MM-solvency gate; `solveFill` returns the **min** of the margin- and reserve-feasible sizes. Reduce/close trades bypass the initial-margin gate. Shorts allowed (negative q) and **lower** `mmShort`.
- [ ] Short settlement at resolution: short **pays** `|q|·f(θ*)` from margin/balance, keeps the entry premium (`§8.2`); release margin as positions settle.
- [ ] **Tests:** margin gate rejects/partials an over-leveraged open; reduce-side bypasses it; `margin_rate` ordering (binary < linear for equal notional); shorts lower `mmShort` and settle by paying `f(θ*)`; equity/free-margin/health match hand calcs; flat ⇒ zero margin; leverage never exceeds `min(tier,market)`; **1× regression** (a no-cap market == V2 byte-for-byte).
**Checkpoint:** open a 5× leveraged long and a short on a CALL in a leverage-enabled market; the margin gate blocks an over-leveraged add; a 1× market is unchanged. **Math-doc:** add `margin_required`, equity, free margin, maintenance, and health-ratio formulas + the per-type `margin_rate`/`1/rate` leverage relation; worked example of margin locked for a 5× position.

---

## Phase V3-2 — Insurance fund `[shared, api, web]` (Workstream H) `[blocked-by: none; needed by V3-3]`
**Goal:** protocol backstop with real, reconciling accounting (V1 ships only a stub account).
- [ ] `shared`: `InsuranceLedgerKind` enum (`fee_accrual, liq_penalty, gap_loss, socialized_loss`).
- [ ] `schema.ts`: `insurance_fund` (single-row balance) + `insurance_ledger(kind, amount signed, ref, created_at)`; migration.
- [ ] `services/insuranceSvc.ts`: `accrue(exec, amount, kind, ref)` written **inside the caller's `db.transaction()`** (same discipline as V2-10 `ledgerSvc`); `+= fee_pct × volume` wired into the trade path; invariant `balance == Σ ledger.amount`.
- [ ] Draw path API for bankruptcy / liquidation gap / socialized loss (consumed by V3-3); never let `balance` go negative without writing a `socialized_loss` row.
- [ ] `GET /admin/insurance`: balance, inflows/outflows, **coverage ratio** = balance / Σ at-risk gap exposure; alert under threshold.
- [ ] `web`: admin insurance-fund dashboard (balance, in/out, coverage, alert).
- [ ] **Tests:** ledger balances (`Σ inflows − Σ outflows = balance`); fee accrual = volume × rate; a draw writes exactly one signed row; coverage alert fires; fund never silently goes negative.
**Checkpoint:** trading accrues the fund; an injected forced draw is recorded and reconciles; admin sees balance, draw, and coverage ratio. **Math-doc:** n/a (accounting, no new market math) — note in checkpoint.

---

## Phase V3-3 — Liquidation engine `[core, api, web]` (Workstream L) `[blocked-by: V3-1, V3-2]`
**Goal:** close failing leveraged accounts before they go underwater; draw the residual from insurance.
- [ ] `services/liquidationSvc.ts`: **event-driven** on every belief/price update for a market + a **periodic sweep**. Per account: recompute equity (longs at bid, shorts at ask); if `equity < maintenance` → **margin call → liquidate**.
- [ ] **Partial liquidation:** close largest-margin-contributor first through the same quote/engine until `equity ≥ maintenance` or flat (don't flatten a recoverable account on one tick).
- [ ] **Penalty** (`cfg.liq_penalty_frac` of closed notional) → insurance fund; **gap loss** (residual negative equity when closing can't restore `equity ≥ 0`) → insurance fund, else socialized (`§15.2`).
- [ ] Emit `margin_call` / `liquidation` WS events; write `liquidations` rows. Liquidating a short **buys to cover** (raises `mmShort` back).
- [ ] `web`: portfolio liquidation history + margin-call banner from the WS events.
- [ ] **Tests:** a price move into the region triggers liquidation; partial liquidation restores the buffer and stops; a gap move draws the shortfall from insurance and emits a socialized-loss event when the fund can't cover; penalty lands in the ledger; `H ≥ 1` is never liquidated; short liquidation buys to cover.
**Checkpoint:** open a 5× leveraged position, push the belief against it, watch **margin call → partial liquidation → (gap) insurance draw**; an account with `H ≥ 1` is left alone. **Math-doc:** add the liquidation trigger (`equity < maintenance`), the penalty/gap-loss flow, and short-payout settlement; worked example of a margin call walking equity below maintenance.

---

## Phase V3-4 — Risk UX `[web]` (Workstream R) `[blocked-by: V3-1, V3-3]`
**Goal:** make the risk visible before and after the trade. Pure presentation over B/L data.
- [ ] `lib/risk.ts` (pure, mirrors `core/margin.ts`): liquidation-point, health ratio, distance-to-liquidation, resulting-leverage for the trade preview.
- [ ] **Trade panel:** leverage selector bounded to `min(tier, market)`, **short toggle** (hidden when market/tier disallow), live **margin/liquidation preview** (resulting leverage, margin locked, health, liquidation level) before confirm.
- [ ] **Portfolio:** per-position leverage, margin used, liquidation distance, health bars, short positions rendered distinctly, liquidation-history tab.
- [ ] **Tests:** pure helpers match the engine across a battery of long/short positions and leverages; panel renders for long/short/flat and 1×/N× without layout breakage; short toggle hidden when disallowed.
**Checkpoint:** a user sets 5×, sees the liquidation level and health update live, opens it, and watches the portfolio health bar + liquidation distance move as the belief drifts. **Math-doc:** n/a (presentation; the formulas shipped in V3-1/V3-3) — note in checkpoint.

---

## Phase V3-5 — Hardening & polish `[all]` `[blocked-by: all]`
- [ ] Full V3 integration suite across B/H/L/R; **migration test** (V1/V2 markets at 1× → unchanged behavior, the two-solvency invariant).
- [ ] Extended Monte-Carlo sim covering **leverage / liquidation cascades** (a belief jump liquidating many accounts; insurance drawdown; socialized-loss path) and margin-rate calibration.
- [ ] Load/chaos test: liquidation sweep under multi-node (V2-8) — no double-liquidation, no reserve/​margin double-spend.
- [ ] Ops runbook: **mass liquidation**, **insurance depletion / socialized loss**, leverage circuit-breaker.
- [ ] **Final math-doc pass:** audit `docs/math/index.html` end-to-end against shipped V3 code (every margin/liquidation/insurance formula, constant, and worked example re-computed; both modes consistent; 0 tag/KaTeX errors) — the per-phase syncs land incrementally; this is the consolidating review.
**Checkpoint:** `bun test` green; load/chaos pass; **V1/V2 markets verified unchanged at 1×**; demo script exercises leverage + shorting + margin call + liquidation + insurance draw end-to-end.

---

### Definition of done (V3)
Accounts trade with **tier-bounded leverage** and hold **short** positions under an **initial/maintenance margin** system; an automated **liquidation engine** closes failing accounts before they go underwater, charging **penalties** to and drawing **gap losses** from a fully-accounted **insurance fund**; shorts **settle** correctly at resolution; the **trade panel and portfolio** surface margin, health, liquidation distance, and history. Every pre-V3 market still runs at **1× with identical behavior**, and the MM α-quantile reserve / capacity model (`docs/capacity/`) is untouched — account margin and pool reserve remain independent gates. See the concepts explainer `docs/v3/shorting-and-leverage.md`.
