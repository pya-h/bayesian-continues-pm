# Technical Design Document — BMM Continuous Prediction Market **V3**

> Builds on **V1** (`docs/v1/`) and **V2** (`docs/v2/`) and the spec (`MODEL.md`). **V1 and V2 must be shipped and in use first.** V3 adds the one axis both earlier versions deliberately left out: **borrowed exposure** — leverage, margin, shorting — and the safety machinery that makes it solvent: a **liquidation engine** and a full **insurance fund**. Where this doc disagrees with `MODEL.md`, this doc wins; deviations are called out.
>
> **One-line scope.** V1/V2 are **1× cash-collateralized**: a trader can never owe more than the premium already paid. V3 lets an account post a fraction of its exposure as **margin**, hold **negative** (short) positions, and so take on risk it has not fully pre-funded — which means the protocol must now be able to **liquidate** an account before it goes underwater and **absorb** the residual when it can't. That whole subsystem is V3.

---

## 1. V3 Scope & Theme

V2 made the market *richer* (multi-modal beliefs, adaptive params, robust oracles, scale) but kept the **collateral model identical to V1**. V3 changes only the collateral model — and everything that change forces. It is **additive and opt-in per market**: a V3 deployment still runs every existing market at 1× with byte-identical behavior; leverage/shorting are unlocked **per-market** via `cfg` (there is no per-account legal/identity class — this is play-money).

| # | V3 Workstream | Earlier extension point it plugs into | `MODEL.md` ref |
|---|---|---|---|
| B | **Margin, leverage & shorting** (the core) | V1 trade engine, `positions`, V1 solvency | §9.2, §9.3 |
| H | **Insurance fund** (full mechanics) | V1 settlement / bankruptcy path; V1 stub fund | §8.2, §15.2 |
| L | **Liquidation engine** | belief/price-update hook, quote engine | §9.3, §15 |
| D | **Hedging** (MM reserve reduction, internal + external) | inventory/solvency, `TradeEngine` | §6.4 |
| R | **Risk UX** (trade-panel previews, portfolio health) | web trade panel + portfolio | §9.2 |

Letters **B**, **D** and **H** keep the identifiers they carried while these were V2 Workstreams (so older cross-references still resolve); **L** and **R** are new and split out of the original monolithic phase for clean checkpoints. **D (hedging)** is collateral-neutral — unlike the rest of V3 it changes nothing about the collateral model and works at 1× — but it ships here because this is where the MM/protocol-risk machinery lives.

**These two markets coexist.** Crucially, V3 does **not** touch the **market-maker solvency** model from V1 (the α-quantile reserve / capacity gate in `docs/capacity/`). That governs whether the *MM/LP pool* can back the book. V3 adds a *second, orthogonal* solvency layer governing whether an individual *trader's account* can back its leveraged positions. Reserve ⟂ margin: the MM reserve still covers net `L(θ)` exactly as before; margin covers the trader's slice of it.

---

## 2. Workstream B — Margin, Leverage & Shorting

This is the realization of `MODEL.md §9.2/§9.3`. V1/V2 were 1× cash-collateralized; V3 introduces borrowed exposure and the bookkeeping to keep it bounded.

### 2.1 Concepts
- **Leverage `L`:** an account may hold open notional up to `L × equity`. `L` is capped **per market** by `cfg.max_leverage` — every account trading a market shares the same ceiling (no per-account leverage class).
- **Margin:** collateral locked against open positions.
  `margin_required = Σ_C |position[C]| × margin_rate[C] × price[C]` (`§9.2`).
  `margin_rate[C] ∈ (0,1]` is **per-contract-type** — riskier (unbounded-tail) payoffs carry a higher rate than capped ones. Equivalently the **per-contract max leverage is `1/margin_rate`**. Examples (defaults, tunable in `cfg.margin_rates`): binary 0.10 (≤10×), spread 0.15, call/put 0.20 (≤5×), linear 0.25 (≤4×). A capped binary needs less margin than an unbounded linear because its worst case is bounded.
- **Equity:** `equity = cash_balance + Σ_C position[C] × (mark[C] − avgEntry[C])` — i.e. cash plus unrealized PnL, marking each position at the current **bid** for longs / **ask** for shorts (conservative, the close-out price).
- **Free margin:** `free_margin = equity − margin_used`. Opening trades require `free_margin ≥ 0` post-trade.
- **Shorting:** V3 allows selling a contract you don't hold (position goes **negative**). The MM takes the other side; the short holder is paid the premium now and **owes `f_C(θ*)`** at settlement, collateralized by margin in the interim. (See `shorting-and-leverage.md` for the worked intuition.)

### 2.2 Two margin levels
- **Initial margin** `IM = margin_required` at the contract's `margin_rate` — the bar to **open or increase** a position.
- **Maintenance margin** `MM_maint = m_maint × margin_required`, `m_maint ∈ (0,1)` (default 0.5) — the bar to **stay open**. `MM_maint < IM` always, so there is a buffer between "can't add" and "gets liquidated."
- **Health ratio** `H = equity / MM_maint`. `H ≥ 1` healthy; `H < 1` ⇒ liquidation (Workstream L). The pre-trade UI surfaces `H` and the implied liquidation point.

### 2.3 Position & account model changes
- `positions.quantity` may now be **negative** (short). Average-entry accounting (V1 `applyFill`) generalizes: a short's "entry" is the premium received; PnL is `qty × (mark − entry)` with `qty < 0`, so a short profits when the mark falls.
- New per-user, per-market **margin account** row: `margin_used`, `equity_snapshot`, `maintenance`, `health`, `updated_at` (a cache/audit of the derived figures; the authoritative numbers are recomputed from positions + marks on each touch).
- Per-contract `margin_rate` lives in `markets.cfg.margin_rates`; the leverage ceiling lives in `markets.cfg.max_leverage` (per market).

### 2.4 Trade-engine changes (open / increase)
The V1 pipeline (fair → spread → exec → slippage → balance/position check → tentatively apply → recompute reserve → **MM solvency gate** → commit) gains a **margin gate** in the per-account check step, *before* the existing MM-solvency gate:

1. Compute post-trade `margin_required`, `equity`, `free_margin` for the **acting account**.
2. **Reject/​partial-fill** if `margin_required > equity × max_leverage` **or** `free_margin < 0` (`§9.2`). Sizing reuses the V1 `solveFill` monotone search, now on the *account-margin* frontier in addition to the MM frontier — the fill is the **min** of the two feasible sizes.
3. **Position-limit** check vs the per-market cap (`§9.3`).
4. The existing **MM solvency** gate is unchanged: the MM's reserve must still cover net `L(θ)`. Shorting *reduces* `mmShort` for that contract (the user takes the long-tail risk off the MM), longs *increase* it; net book risk drives the reserve exactly as in V1. **Margin and reserve are independent gates; a trade must pass both.**

Reducing/closing trades (incl. buy-to-cover a short, sell-to-close a long) only ever *lower* `margin_required`, so they bypass the initial-margin gate (margin 1×, mirroring V1's reduce-side reserve rule).

### 2.5 Settlement with shorts (`§8.2`)
At resolution θ*, each position settles at `f_C(θ*)`:
- **Long** `qty > 0`: receives `qty × f_C(θ*)` (V1, unchanged).
- **Short** `qty < 0`: **pays** `|qty| × f_C(θ*)` out of margin/balance; keeps the premium taken at entry. A short of a call that finishes ITM pays out; a short of an OTM contract keeps the full premium. If the owed amount exceeds the account's equity (a **gap** that liquidation didn't catch — e.g. an instant resolution jump), the shortfall is drawn from the **insurance fund** (Workstream H), else socialized (`§15.2`).
- Margin is released back to free balance as positions settle.

### 2.6 Tests
Margin gate opens/closes correctly (an over-leveraged open is rejected or partial-filled to the cap); reduce-side trades bypass the initial-margin gate; `margin_rate` ordering holds (binary needs less than linear for equal notional); shorts make `mmShort` go down and settle by *paying* `f(θ*)`; equity/free-margin/health arithmetic matches hand calculations; a flat account has zero margin; **no account can exceed the market's `max_leverage`**; 1× markets are byte-identical to V2 (regression).

---

## 3. Workstream H — Insurance Fund (`MODEL.md §8.2, §15.2`)

A protocol-level backstop with real accounting. (V1 ships a stub safety-net account; V3 turns it into the full fund.) It exists to absorb the losses that *only become possible* once accounts can owe more than they pre-funded.

- **Accrual (inflows):** `insurance_fund += fee_pct × volume` on every trade (default 0.1–0.5% of premium volume) **plus** liquidation **penalty** fees (Workstream L).
- **Draws (outflows):** (a) **liquidation gap loss** — a liquidation that couldn't close fast enough to keep `equity ≥ 0`; (b) **settlement gap** — a short that owes more than its equity at resolution (§2.5); (c) **socialized loss** when the fund itself is exhausted (last resort, `§15.2`).
- **Ledger:** `insurance_ledger(kind, amount, ref, created_at)` — append-only, signed; the single-row `insurance_fund.balance` equals `Σ ledger.amount` (an invariant the tests assert, mirroring the V2-5 transaction-ledger discipline).
- **Admin dashboard:** balance, inflows/outflows, **coverage ratio** = `balance / Σ at-risk gap exposure` across leveraged accounts; alert when coverage < threshold.

### 3.1 Tests
Ledger balances (`Σ inflows − Σ outflows = balance`); fee accrual matches volume × rate; a forced gap-loss draws exactly the shortfall and writes one ledger row; coverage alert fires under threshold; fund never goes negative without emitting a socialized-loss event.

---

## 4. Workstream L — Liquidation Engine (new service `LiquidationSvc`)

Keeps leveraged accounts solvent **before** settlement.

- **Triggers:** event-driven on every belief/price update for a market (a move marks every open position to a new equity), **plus** a periodic sweep as a backstop for quiet markets.
- **Per account:** recompute `equity` (mark longs at bid, shorts at ask). If `equity < maintenance` → **margin call → liquidate**:
  1. Emit `margin_call` (WS) — the user/admin sees the warning.
  2. **Close positions** at the current quote (sell-to-close longs / buy-to-cover shorts), largest-margin-contributor first, until `equity ≥ maintenance` **or** the account is flat.
  3. Charge a **liquidation penalty** (default 1% of closed notional) → **insurance fund**.
  4. If closing can't restore `equity ≥ 0` (a **gap**: the market jumped past the maintenance buffer faster than we could act), the residual negative equity is the **gap loss** → **insurance fund** (§3), else socialized.
  5. Emit `liquidation` (WS) + write a `liquidations` row.
- **Ordering vs the MM:** a liquidation is just a forced trade through the *same* quote/engine, so it respects MM solvency and updates belief like any trade. Penalties and gap draws are the only new cash paths.
- **Partial liquidation** is preferred (close only enough to restore the maintenance buffer) so a single tick doesn't flatten a recoverable account.

### 4.1 Tests
A price move into the liquidation region triggers liquidation; partial liquidation restores `equity ≥ maintenance` and stops; a gap move draws the shortfall from insurance and emits a socialized-loss event when the fund can't cover; penalty lands in the fund ledger; an account at `H ≥ 1` is never liquidated; liquidation of a short buys to cover (raising `mmShort` back).

---

## 5. Workstream D — Hedging (`MODEL.md §6.4`)

Reduce the MM's required reserve and free LP capital — **collateral-neutral**, independent of the leverage stack (works at 1×), payout-neutral to users. Plain-language companion: `docs/v3/HEDGING.md`.
- **Internal hedge:** when `required_reserve > cash × 0.8`, the MM opens an **offsetting internal position** (a synthetic contract whose payoff cancels net exposure curvature) — bookkeeping-only, lowers `L(θ)` variance. Implemented as `find_best_hedge(exposure)` choosing the contract (from a candidate basis: a strip of binaries/spreads tiling Θ) that most reduces reserve per unit.
- **External hedge (optional/plug-in):** an adapter interface `ExternalHedgeProvider` (e.g. a mock correlated market) so a real venue could be wired later. Default: a **mock** provider for demos.
- All hedges logged, shown in the admin overview (hedge book, reserve-before/after). Gated by `markets.cfg.hedge_enabled` (default off ⇒ existing markets unchanged).
- **Boundary:** hedging only *reduces* the MM's own reserve; it never enables user leverage/shorting and changes no user payout. Independent of Workstreams B/L — no leverage prerequisite (only V2-1 beliefs/reserve, already shipped).

### 5.1 Tests
A hedge reduces the required reserve; bookkeeping stays neutral to user payouts; a hedge-disabled market behaves byte-identically to V2; the MM-solvency / capacity model (`docs/capacity/`) is untouched.

---

## 6. Workstream R — Risk UX

Pure presentation over the B/L data; no engine math here.
- **Trade panel:** leverage selector (bounded to the market's `max_leverage`), **short toggle**, and a live **margin / liquidation preview** — resulting leverage, margin locked, health ratio, and the belief/price level at which this position would be liquidated, shown *before* confirming.
- **Portfolio:** per-position leverage, margin used, **liquidation distance** (how far θ/price can move before a margin call), health bars, **short positions** rendered distinctly, and a **liquidation history** tab fed by the `liquidations` rows + `margin_call`/`liquidation` WS events.
- **Admin:** insurance-fund dashboard (§3) and a per-market liquidation feed.

### 6.1 Tests
The pure preview helpers (liquidation-point solver, health-ratio, distance-to-liquidation) match the engine for a battery of positions; the panel renders for long/short/flat and 1×/N× without layout breakage; the short toggle is hidden when the market disallows it.

---

## 7. Data Model Deltas (vs V2)
```
markets.cfg     + margin_rates{<type>:rate}, max_leverage, maint_margin_frac, liq_penalty_frac, hedge_enabled
positions       quantity may be negative (short)            -- avg-entry accounting generalized
margin_accounts (user_id, market_id, margin_used, equity_snapshot, maintenance, health, updated_at)
liquidations    (id, user_id, market_id, trigger, closed_qty, penalty, gap_loss, created_at)
hedges          (id, market_id, contract_ref, qty, reserve_before, reserve_after, created_at)
insurance_fund  (single row: balance)
insurance_ledger(id, kind, amount, ref, created_at)         -- balance == Σ amount (invariant)
```
All additive — new nullable/defaulted columns and new tables; existing V1/V2 markets read back identically (no `margin_rates`/`max_leverage`/`hedge_enabled` ⇒ 1× fully collateralized, no hedging).

## 8. API Deltas
```
# margin / leverage
GET  /users/me/margin/:marketId           margin account, equity, free margin, health, liquidation point
POST /markets/:id/trades                   now accepts leverage + short (negative q); margin-gated (§2.4)
GET  /users/me/liquidations                this user's liquidation history
# insurance / ops
GET  /admin/insurance                      fund balance + ledger + coverage ratio
```
New WS events: `margin_call`, `liquidation`, `insurance_update`.
*(Trade creation stays the same endpoint; the leverage/short fields are optional and default to 1×/long, so V2 clients keep working.)*

## 9. Frontend Deltas
- **Trade panel:** leverage selector, short toggle, margin/liquidation preview (Workstream R).
- **Portfolio:** margin-health bars, liquidation distance, short positions, liquidation history.
- **Admin:** insurance-fund dashboard; per-market liquidation feed; **hedge book** (reserve before/after) for hedge-enabled markets (Workstream D).

## 10. Testing (V3 additions, consolidated)
- **Margin gates** open/close; reduce-side bypass; per-type `margin_rate` ordering; leverage never exceeds the market's `max_leverage`.
- **Liquidation** triggers on a price move; partial liquidation restores the buffer; gap loss → insurance; penalty → insurance ledger.
- **Shorting** lowers `mmShort`, settles by paying `f(θ*)`, gap → insurance.
- **Insurance accounting** balances (`inflows − outflows = balance`); coverage alert fires.
- **Hedging** reduces the required reserve and is payout-neutral; a hedge-disabled market is unchanged.
- **Regression:** every V1/V2 market at 1× behaves byte-identically (no leverage cap ⇒ untouched code path).
- **Math-doc:** margin/equity/health formulas, the liquidation trigger (`equity < maintenance`), penalty/gap-loss flow, short-payout settlement, and the hedging reserve before/after example all added to `docs/math/index.html`, verified rendering.

## 11. Migration / Rollout from V2
- **Prereq:** V2 shipped.
- **All V1/V2 markets keep working:** absent `cfg.margin_rates`/`max_leverage`, a market is 1× cash-collateralized ⇒ the margin gate is a no-op and behavior is exactly V2. Leverage/shorting (and hedging) are **opt-in per market** (`cfg`).
- **Ship order (see `TASKS.md`):** **V3-1 (margin/leverage/shorting core)** → **V3-2 (insurance fund)** → **V3-3 (liquidation engine, needs both)** → **V3-4 (hedging)** → **V3-5 (risk UX)** → **V3-6 (hardening + math-doc)**.
- DB migrations are additive; no destructive changes to V1/V2 data.

---

### Definition of done (V3)
Accounts can trade with **market-bounded leverage** and hold **short** positions under an **initial/maintenance margin** system; an automated **liquidation engine** closes failing accounts before they go underwater, charging penalties to and drawing gap losses from a fully-accounted **insurance fund**; shorts settle correctly at resolution; the **trade panel and portfolio** show margin, health, liquidation distance, and history; and **every pre-V3 market still runs at 1× with identical behavior**. The MM α-quantile reserve / capacity model (`docs/capacity/`) is untouched and continues to govern pool solvency independently of account margin.
