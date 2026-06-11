# TASKS — Soft-Cap Refactor (capacity ramp instead of a cliff)

Phased plan to refactor the trade engine from a **hard solvency cliff** into a
**soft capacity ramp** (a congestion premium that prices out buying smoothly as a
market fills). Design rationale and math: [soft-cap.md](soft-cap.md). Background:
[solvency-and-capacity.md](solvency-and-capacity.md),
[expanding-capacity.md](expanding-capacity.md).

**Scheduled after V2 ships.** This is additive and gated: with the feature off, or
on a market with plenty of headroom, behaviour is **identical to today**.

Legend: `core` = `@bmm/core`, `shared` = `@bmm/shared`, `api`, `web` (as in the V1/V2
plans). Each phase ends with a runnable checkpoint. `[blocked-by]` = hard deps.

---

## Design invariants (must hold after every phase)

These are the guardrails for the whole refactor — a phase that violates one is not
done:

1. **Solvency is never weakened.** The hard `cash ≥ hardMargin · reserve` gate
   stays as a final backstop. The congestion premium only makes that wall
   economically unreachable; it never lets the pool reach resolution under-funded.
   Payouts remain fully backed (this is *not* the §3.D haircut).
2. **Quote == Execute.** The price a user is quoted and the price they fill at use
   the *same* congestion computation (as `solveFill` already guarantees for the
   hard gate today).
3. **Healthy markets are untouched.** When utilisation is low, `congestion ≈ 0`;
   markets far from capacity behave exactly as before (regression-tested).
4. **Only risk-increasing trades pay it.** Sells and offsetting trades (which
   *reduce* the reserve) pay zero congestion.
5. **Backward compatible.** Markets whose stored `cfg` predates these fields run on
   safe defaults with no migration required.

> ** Math-doc sync (standing rule).** `docs/math/index.html` is the public
> source-of-truth explainer. Any phase that changes the math (the spread/price
> formula, the gate) is **not complete** until the math doc is updated to match:
> add the congestion term to the spread section, refresh affected worked examples
> (re-compute numbers), keep Trader and Developer modes consistent with shipped
> code, and verify it renders with 0 tag / 0 KaTeX errors. Phases with no math
> change note "math-doc: n/a".

**Recommended order:** SC-0 → SC-1 → SC-2 → SC-3 → SC-4, then SC-5 (calibrate) →
SC-6 (compat) → SC-7 (rollout + docs). SC-0..SC-2 are the load-bearing core; the
rest are surface, tuning, and safety.

---

## Phase SC-0 — Config scaffolding; lift the hard margin into `cfg` `[core, shared, api]`
**Goal:** add the soft-cap knobs and make the existing hard margin configurable, with **zero behaviour change** (feature off, `hardMargin = 1.2` reproduces today).
- [ ] `core/config.ts` + `EngineConfig` (`types.ts`): add fields — `hardMargin` (default **1.2**), and a `softCap` group: `{ enabled: false, kappa, power, refMargin }`. All optional with defaults.
- [ ] Add a single defaulting accessor (e.g. `resolveCapacityCfg(cfg)`) so stored market `cfg` JSON lacking the new fields resolves to the safe defaults — no migration needed.
- [ ] Replace the hard-coded `OPEN_MARGIN = 1.2` constant in [`tradeSvc.ts`](../../apps/api/src/services/tradeSvc.ts) and the `openMargin` plumbed into [`tradeMath.ts`](../../apps/api/src/services/tradeMath.ts) with `cfg.hardMargin` (via the accessor). No numeric change.
- [ ] **Tests:** existing trade/solvency suites pass unchanged; a legacy `cfg` (no new fields) resolves to `hardMargin 1.2`, `softCap.enabled=false`.
**Checkpoint:** full api + core test suites green; quoting/execution numerically identical to pre-change on every existing fixture. **math-doc: n/a.**

---

## Phase SC-1 — Core congestion premium (pure) `[core]` `[blocked-by: SC-0]`
**Goal:** the pure, unit-tested price term — the heart of the soft cap.
- [ ] Add `congestionPremium({ reserveBefore, reserveAfter, cash, fair, cfg })` (in `spread.ts` or a new `congestion.ts`); export from `index.ts`. Reference form (see [soft-cap.md](soft-cap.md) §3):
      `u = refMargin·reserveAfter / cash`; `premium = κ·|fair|·u^a/(1−min(u,1−ε))` when `reserveAfter > reserveBefore`, else `0`.
- [ ] Extend `SpreadBreakdown` with a `congestion` field. `computeSpread` (which has no pool context) sets it to `0`; add a small fold helper that merges a congestion value into a breakdown and recomputes `total`.
- [ ] **Tests:** `congestion = 0` when `reserveAfter ≤ reserveBefore` or `u` small; strictly increasing & convex in `u`; finite (ε floor) and large as `u→1`; increasing in fill size `q` (so the solver stays monotone); disabled flag ⇒ always 0.
**Checkpoint:** `bun test` core green, including the new congestion property tests. **math-doc:** stage the formula (full doc update lands in SC-7).

---

## Phase SC-2 — Wire congestion into quote & execute `[api]` `[blocked-by: SC-1]`
**Goal:** the price now ramps with utilisation, while the hard gate remains a backstop.
- [ ] [`tradeMath.ts`](../../apps/api/src/services/tradeMath.ts) `solveFill`/`feasible`: keep the hard solvency gate at `cfg.hardMargin` (unchanged sizing for solvency), but compute `congestion` from `reserveBefore`/`reserveAfter(size)`/`cash` and **add it to `execPrice` → `totalCost`**. Buyer affordability (`balance ≥ totalCost`) now reflects congestion. Both constraints remain monotone in size, so the binary search is still valid.
- [ ] [`tradeSvc.ts`](../../apps/api/src/services/tradeSvc.ts) execute path: compute the same congestion and include it in `execPrice`; keep the post-rounding acceptance gate (backstop). Ensure the quote path uses the identical fold so **quote == execute**.
- [ ] **Tests:** near-capacity market quotes a steep `congestion` and *fills* (no hard rejection) instead of `409`; price rises with size; a de-risking sell pays `0` congestion; **solvency never breached** (hard gate intact); a high-headroom market is bit-identical to SC-0.
**Checkpoint:** on a near-full market, a buy that used to be rejected now fills at a visibly higher price; solvency invariants hold. **math-doc:** staged.

---

## Phase SC-3 — Quote DTO & API surface `[shared, api]` `[blocked-by: SC-2]`
**Goal:** expose the new term (and utilisation) to clients.
- [ ] Add `spread.congestion` and an optional `utilization` (0..1) to the quote DTO/types in `shared`; populate them in the quote service.
- [ ] **Tests:** DTO shape & serialization; `congestion`/`utilization` present and consistent with the engine.
**Checkpoint:** `GET /…/quote` returns `spread.congestion` and `utilization`. **math-doc: n/a.**

---

## Phase SC-4 — Web surface `[web]` `[blocked-by: SC-3]`
**Goal:** make the ramp legible — no more silent freeze.
- [ ] [`QuotePanel.tsx`](../../apps/web/src/components/QuotePanel.tsx): add a **"congestion"** row to the spread breakdown (shown only when `> 0`), styled like the existing `base/inventory/adverse-sel/volatility` rows.
- [ ] [`MarketPage.tsx`](../../apps/web/src/pages/MarketPage.tsx): a small **capacity meter** (utilisation %) + a "near capacity — pricing in congestion" hint; only fall back to a disabled Buy at the hard backstop, with a clear message (replaces the opaque "insufficient capacity" wall).
- [ ] **Tests:** breakdown row renders when present and is hidden at `0`; capacity meter reflects `utilization`.
**Checkpoint:** trading a near-full market visibly ramps the quote and shows the capacity meter; healthy markets look unchanged. **math-doc: n/a.**

---

## Phase SC-5 — Calibration & double-count cleanup `[core, api]` `[blocked-by: SC-2]`
**Goal:** pick constants that bite *before* the wall without taxing healthy flow.
- [ ] Tune `kappa`/`power`/`refMargin` using [`sim.ts`](../../packages/core/src/sim.ts) scenarios: a healthy market stays within ε of today; a crowded book ramps smoothly and demand dies before `u=1`.
- [ ] Re-evaluate the existing **inventory** term (`gamma`): the pool-level congestion may overlap the per-contract inventory skew — down-weight `gamma` if double-counting, keeping inventory as the *per-contract* skew and congestion as the *pool-level* scarcity signal.
- [ ] Add a sim scenario reproducing a crowded one-sided book (cf. the field case in `solvency-and-capacity.md` §6) and assert a graceful ramp, not a freeze.
- [ ] **Tests:** sim assertions for ramp shape; healthy-market regression bound.
**Checkpoint:** simulation shows a smooth approach to the limit; healthy markets unchanged. **math-doc:** record the final constants.

---

## Phase SC-6 — Backward-compat & (optional) migration `[api]` `[blocked-by: SC-2]`
**Goal:** existing markets keep working; enabling soft cap is safe.
- [ ] Confirm markets whose stored `cfg` predates SC-0 resolve to defaults (`softCap.enabled=false`, `hardMargin=1.2`) and run unchanged.
- [ ] Optional idempotent migration to backfill `cfg` jsonb with the new fields (or rely solely on the runtime accessor — decide and document).
- [ ] Verify that *enabling* soft cap on a pre-existing market changes **only** near-capacity behaviour (ramp), not healthy-market pricing.
- [ ] **Tests:** legacy-cfg resolution; migration idempotency (if shipped).
**Checkpoint:** a pre-existing market (incl. the V1 fixtures) trades correctly with and without soft cap enabled. **math-doc: n/a.**

---

## Phase SC-7 — Rollout, docs & math-doc sync `[all]` `[blocked-by: SC-4, SC-5, SC-6]`
**Goal:** ship safely and keep the source-of-truth docs in lockstep.
- [ ] Rollout via the flag: ship **off** → enable on **new** markets → flip the **global default** after calibration holds in practice. The hard gate stays as a backstop in every mode.
- [ ] Update [`MODEL.md`](../MODEL.md): §4.3 spread gains the `congestion` component; the §7 reserve/gate section notes it is now a *backstop* behind the price ramp.
- [ ] Update this folder: mark soft cap as **implemented**, and reconcile [soft-cap.md](soft-cap.md) §3 with the shipped formula/constants.
- [ ] Update `docs/math/index.html` (Trader + Developer modes): add the congestion premium to the spread derivation and a worked **near-capacity** example; verify **0 tag / 0 KaTeX errors**.
- [ ] **Tests:** end-to-end — a near-capacity market ramps in a full stack run; breakdown + capacity meter visible; all invariants from the top of this file asserted.
**Checkpoint:** docs match shipped code; production market near capacity ramps smoothly with the congestion row and capacity meter visible. **math-doc:** complete (congestion formula + worked example, both modes, renders clean).

---

## Out of scope (deliberately)

Soft cap makes the limit **graceful**; it does **not** raise the absolute ceiling
(capacity is still `capital ÷ risk`). Genuinely *expanding* capacity — the
insurance-fund backstop (§3.E), hedging/reinsurance (§3.F), or the deliberate
pro-rata **solvency-factor haircut** (§3.D, which changes payouts) — are tracked
separately in [expanding-capacity.md](expanding-capacity.md) and layered on *after*
this refactor. Keep them out of these phases.
