# TASKS — General belief models (Gen·basis + Gen·exact) + contract extensions

Implementation plan for promoting **Gen·basis** (default) and **Gen·exact** to first-class belief models, demoting the existing three to "extra" options, and (later) widening the contract shapes. Companion to [`general-belief-form.md`](./general-belief-form.md), [`parametric-belief-families.md`](./parametric-belief-families.md), and [`contract-extensions.md`](./contract-extensions.md).

> **Status: COMPLETE.** All phases G0–G6 shipped — both generals, the admin refactor, placement, the G5.1/G5.2 contract extensions, the demo seed, and the hardening sweep. The two tracked follow-ups I3 (Gen·exact moment cache) and I4 (Gen·exact v2 moment-projection / shape-adapting update) are shipped too.

---

## Guiding principles (read before any code)

1. **Reuse-first.** Gen·basis *is* a Gaussian mixture — reuse `MixtureBelief`, `bayesUpdateMixture`, closed-form mixture pricing, `manageMixture`, MC reserve. No new pricing/serialization math for it. Only Gen·exact introduces genuinely new math.
2. **Bottom-up, verify-vs-MC at every math step.** Land and test `core` math before wiring `api`, and `api` before `web`. Every new density/price/update is asserted against an independent Monte-Carlo estimate — the single biggest guard against silent mathematical error.
3. **Back-compat is sacred.** Existing `gaussian`/`mixture`/`student_t` markets must behave byte-for-byte unchanged. Every phase ends with the existing suites green.
4. **One concern per commit.** Never mix a math change with a UI change. Each checkpoint is independently shippable and revertible.
5. **Math-doc sync.** Any phase that changes the math updates `docs/math/index.html` (the sandbox already prototypes both general forms — keep it the source of intuition). Phases that touch no math note "math-doc: n/a".

---

## Locked design decisions (rationale in the companion docs)

- **D1 — Gen·basis representation = Gaussian mixture.** Stored as the existing mixture state (`belief_kind = 'mixture'`). Its distinct identity (rich creation editor, split-enabled adaptive update, placement interaction) is carried by a market-level `model` tag, not a new serialized belief kind → zero new pricing math, zero migration of the math path.
- **D2 — Gen·exact = a new belief kind `gen_exact`.** State `{ kind:'gen_exact', mu, sigma, lambdas:[λ₂,λ₃,λ₄] }`. Quadrature-priced (routes through the `expectF` fallback). v1 update = fixed-shape location/scale (variance-domain precision rule, like Student-t); v2 = moment-projection (shape adapts).
- **D3 — `markets.model` column** (`gaussian | student_t | mixture | gen_basis | gen_exact`). The creator's chosen model (drives UI + update config); `belief_kind` stays the math representation. Since the platform is pre-launch we dropped the back-compat inference path entirely — the column is `NOT NULL DEFAULT 'gaussian'`, set on every market at creation.
- **D4 — Admin UI:** two primary buttons — Gen·basis (default), Gen·exact — and a collapsed "More models" revealing Gaussian / Student-t / Mixture. All five stay creatable; only the emphasis changes.
- **D5 — Contract↔belief compatibility guard** (Phase G5): unbounded/heavy contracts validated against the belief's tail per [`contract-extensions.md`](./contract-extensions.md).

---

## Phase G0 — Design lock & inert scaffolding `[shared, api]` (no behavior change)
Goal: land the shape of the new surface with zero runtime change, so later phases are additive.
- [x] `shared`: add the `ModelTag` enum; add `gen_exact` to `beliefStateSchema` and `gen_basis`/`gen_exact` variants to `createBeliefSchema` — parsed but unwired.
- [x] Schema: add `markets.model` (additive; later tightened to `NOT NULL DEFAULT 'gaussian'` — see D3).
- [x] `core`: add the `BELIEF_TAIL` map (gaussian/mixture/gen_basis/gen_exact → gaussian, student_t → polynomial) + a pure `contractBeliefCompatible` stub returning true for all current contracts (used in G5).
- [x] Tests: schema round-trips for the new (unused) variants; gen_basis/gen_exact create fails closed with 400 until wired.
- **Checkpoint:** existing suites green; `markets.model` exists; no code path reads the new schemas yet. math-doc: n/a.

---

## Phase G1 — Gen·basis (the default general model) `[core, shared, api, web]` `[blocked-by: G0]`
Goal: a `gen_basis` model that is a Gaussian mixture with an adaptive, mode-spawning update and a rich creation editor. Reuses all mixture pricing/solvency.

### G1.1 — core: adaptive (spawning) mixture update
- [x] Extend `MixtureOpsConfig` with `allowSpawn`/`tauSpawn` (default off, so the existing `mixture` kind is untouched).
- [x] In `bayesUpdateMixture` (gated on `allowSpawn`): before the responsibility step, if the signal `s` is farther than `tauSpawn · σ_k` from every component mean and `weight ≥ w_min`, seed a new component `{ π: w_seed, μ: s, σ²: σ_ε² }`, then run the normal responsibility + per-component update + `manageMixture` (which merges it back if redundant, keeps it if it earns responsibility). Seed σ² = max(σ_ε², σ_min²), gated under the K-cap.
- [x] Keep `splitComponent` available as an alternative trigger but off for v1.
- [x] Tests vs MC + invariants: disagreement grows a 2nd mode; low-weight & nearby bets don't spawn; `allowSpawn:false` ⇒ path-identical to the default; Σπ=1 and pdf integrates to 1 every step; K never exceeds `maxComponents` under a chaotic stream.

### G1.2 — shared + api: creation & wiring
- [x] `createGenBasisSchema`: `{ kind:'gen_basis', bumps: [{ mu, sigma, weight }] }` (1..12).
- [x] `makeInitialBelief`: gen_basis → mixture from the bumps; set `model='gen_basis'`, `belief_kind='mixture'`. `model` is now persisted for all new markets.
- [x] Trade path: pass the spawning `opsCfg` (relaxed cap 12 + `allowSpawn`) into `updateBelief` at quote/execute/sell-all. `loadBelief`/`beliefPersistFields` unchanged (it's a mixture).
- [x] Tests: gen_basis persists as a mixture with the authored bumps; a far bell-buy stream grows a mode; a plain mixture market under the same stream never grows its count.

### G1.3 — web: types, create body, chart
- [x] `CreateBeliefInput` += gen_basis; `MarketView.model`.
- [x] `buildCreateMarketBody` emits the gen_basis belief from the mode-draft rows.
- [x] `BeliefChart` renders it already (it's a mixture).
- **Checkpoint:** a creator can author a Gen·basis market and watch modes form as flow arrives. math-doc: spawn rule noted in the mixture-update block.

---

## Phase G2 — Gen·exact (max-entropy `exp(−poly)`) `[core, shared, api, web]` `[blocked-by: G0]`
Goal: a new `gen_exact` belief kind. This is the math-heavy phase — go slow, verify each piece vs MC.

### G2.1 — core: the belief class (math first, no wiring)
Density: `p(θ) = exp(−E(u)) / (σ·Z)`, `u=(θ−μ)/σ`, `E(u)=½λ₂u² + λ₃u³ + λ₄u⁴ + λ₆u⁶`, with the auto-stabiliser `λ₆ = 0.004 + 0.06·max(0,−λ₄) + 0.03·|λ₃|` so the density is always integrable and skew can't drag the mean off. (Prototyped and MC-checked in `docs/math/multimodel.js` — port it faithfully.)
- [x] `GenExactBelief implements BeliefModel`: constructor caches `Z`/`mean`/`variance` via fixed composite-Simpson over `u∈[−L,L]` (`L=7`) with a min-energy shift; `pdf`/`mean`/`variance`/`stddev`; `cdf` = numeric integral of `pdf`, `quantile` = bisection; `sample` = inverse-CDF bisection (deterministic, for MC reserve); `serialize`/`fromDTO`. cdf/quantile/sample share one normalised cumulative grid over the same window.
- [x] Tests (the gate against math errors): pdf integrates to 1 across a (λ₂,λ₃,λ₄) sweep incl. λ₂<0 (bimodal); cached mean/variance match a fine-grid recompute; cdf monotone, `cdf(quantile(p))≈p`; shape sanity (≈Gaussian at λ₂=1,λ₃=λ₄=0; bimodal at λ₂<0; skew direction for λ₃≠0; thinner tails for λ₄>0); sample moments match the cached analytic moments. Note the skew sign: `λ₃>0` favours `u<0` ⇒ mean shifts below μ.

### G2.2 — core: pricing & sensitivity
- [x] Route `gen_exact` through the `expectF` fallback (LINEAR → `mean()` exactly), plus a `priceUnderGenExact` mirroring `priceUnderStudentT` — BINARY/SPREAD from the cached CDF, CALL/PUT/GAUSSIAN via quadrature (routing a step payoff through Simpson gives O(h) error the ∂P/∂μ test would amplify). Since gen_exact is a fixed-shape location family in μ, `dPriceDMu` uses the exact pdf/cdf identities for kinks/jumps and the central difference only for the smooth GAUSSIAN.
- [x] Tests: `price` matches an independent MC of `E[payoff]` for CALL/BINARY/SPREAD across unimodal/skew/bimodal; `dPriceDMu` matches a finite-difference of `price`.

### G2.3 — core: the update (v1 = fixed-shape location/scale)
Treat (μ,σ) as location/scale, keep λ's fixed, update in the variance domain like Student-t: `τ₀=1/Var, τ_s=w/σ_ε², μ'=(τ₀μ+τ_s s)/(τ₀+τ_s), Var'=max(1/(τ₀+τ_s), σ_min²)`, then `σ' = σ·√(Var'/Var)`.
- [x] `bayesUpdateGenExact` + the `gen_exact` branch in the `updateBelief` dispatcher; the simplified path mirrored.
- [x] Tests: μ moves toward `s`, variance strictly decreases (w>0), λ's unchanged, kind preserved, σ_min floor respected, `w=0` ⇒ unchanged.
- [x] **v2 — moment-projection** (shape adapts): `bayesUpdateGenExactShape` (assumed-density filter) — form the exact posterior `prior(θ)·N(θ; s, σ_ε²/w)`, take its first four moments, hold λ₂ (the creator's unimodal/bimodal choice) and re-fit (λ₃,λ₄) to the posterior skew/kurtosis via damped Gauss-Newton (clamped to the sandbox-safe ranges), then map (μ,σ) to the posterior mean/variance. Gated by `cfg.genExactShapeAdapt` (default on); falls back to the v1 fixed-shape step for the simplified path / zero-weight / numerical degeneracy. MC-verified vs an importance-sampled posterior.

### G2.4 — shared + api + web
- [x] `shared`: `gen_exact` state + create variant with the sandbox-safe λ bounds — λ₂∈[−4,4], λ₃∈[−0.35,0.35], λ₄∈[0,1.6].
- [x] `api`: `makeInitialBelief` (gen_exact), `loadBelief`, `beliefPersistFields` (summary mean/σ from cached moments), update dispatch via `updateBelief`.
- [x] `marketView`: expose `belief.lambdas` + the raw loc/scale (≠ the summary mean/σ for skewed shapes) so the chart and `beliefFromView` reconstruct the true density.
- [x] `web`: `genExactPdf` (peak-normalised `exp(−poly)` kernel); `beliefFromView` reconstructs it; `BeliefChart` dispatches on `beliefKind`; `buildCreateMarketBody` emits gen_exact from a λ draft. (The λ-slider/preset form control is deferred to G3, like G1.3.)
- [x] Tests: api integration (create → quote-vs-MC → trade moves μ, shape preserved → round-trips); web `genExactPdf` shape tests; build-body validation.
- **Checkpoint:** Gen·exact markets create, price (quadrature), trade, render the true exp-poly shape, and persist. math-doc: add the `gen_exact` belief + v1 update.

---

## Phase G3 — Admin panel refactor (primary vs extra) `[web]` `[blocked-by: G1, G2]`
Goal: surface Gen·basis (default) and Gen·exact as primary, demote the three behind "More models". Pure presentation — every kind stays creatable.
- [x] `CreateMarketForm`: a primary row (Gen·basis default-selected, Gen·exact) + a collapsible More-models group (Gaussian / Student-t / Mixture); selecting a classic auto-opens the group. `EMPTY_DRAFT` defaults to gen_basis; `setKind` re-seeds per kind.
- [x] Per-model editors: Gen·basis and Mixture share the bump/mode-row editor (noun + min-count differ); Gen·exact gets three range sliders + preset chips (Gaussian / Skew / Flat / Bimodal); Student-t keeps its ν field; Gaussian has no editor.
- [x] Helper text per model: Mixture labelled a Gen·basis preset; Student-t noted as exact heavy (polynomial) tails — the one capability the generals don't reproduce exactly.
- [x] Tests (pure surface): default draft is gen_basis; build-body for all five kinds. (The web suite is pure-function only; the default and the expander toggle are component state, covered by typecheck + visual review.)
- **Checkpoint:** the create flow leads with the two generals; the three remain one click away; existing markets unchanged. math-doc: n/a.

---

## Phase G4 — Placement interaction ("paint the curve") `[core, api, web]` `[blocked-by: G1]` *(refinement)*
Goal: let a trade sculpt a Gen·basis belief directly — the half that makes flexibility usable (see `parametric-belief-families.md`). Optional but high-value.
- [x] Primitive: the bell (GAUSSIAN) contract is the gesture; a weight-only mechanism is the math. Why both: the G1.1 responsibility+spawn update reliably grows one camp away from consensus but is consensus/recency-forming — sustained round-robin painting collapses to the last camp, so it can't hold 3+ balanced modes. The weight-only additive update does.
- [x] `placeBasisBump` (buy adds mass at the bell center / spawns a bump if far, sell removes mass from a bump you're on, renormalise + `manageMixture`); `updateBeliefForTrade` routes gen_basis + GAUSSIAN → placement, every other (model, contract) pair → the unchanged `extractSignal → updateBelief`. Wired at all trade sites + the web projection preview.
- [x] Tests: repeated bell bets at distinct centers carve distinct persistent modes (which the responsibility update fails); weight conservation; K≤cap under chaotic painting; sell erases a camp; reserve bounded.
- **Checkpoint:** a user shapes a multi-bump belief through trades. math-doc: note the placement↔weight map.

> **Review pass G0→G4.** Two cross-phase fixes:
> 1. **Preview ↔ server parity.** The web preview called `updateBeliefForTrade` without `opsCfg`, so a Gen·basis projection silently used `DEFAULT_MIXTURE_OPS` (spawn off, cap 6) instead of the server's spawn-on/cap-12. Moved the ops policy into a shared `mixtureOpsForModel(model)` so the api and the preview share one source of truth.
> 2. **Audit fidelity for placement.** A bell trade applies `placeBasisBump`, but the audit row recorded the standard `extractSignal` (a "pushed-away" location for sells). Added `tradeSignal()`, kept in lock-step with `updateBeliefForTrade`: a placement audits as (bell center, signed strength); everything else falls through to `extractSignal`.

---

## Phase G5 — Contract-shape extensions `[core, shared, api, web]` `[blocked-by: G0; independent of G1–G4]`
Goal: wider user-trade curves. Math/compat analysis in [`contract-extensions.md`](./contract-extensions.md).

### G5.1 — bounded, closed-form contracts (zero risk-model change)
- [x] Add `SKEW_GAUSSIAN` (asymmetric bell), `TENT` (triangle), `TRAPEZOID`, `SIGMOID` — all bounded ∈[0,1]. `TENT`/`TRAPEZOID` are exact CALL-ramp sums (`tent=(R(c−w)−2R(c)+R(c+w))/w`, `trap=(R(a−w)−R(a)−R(b)+R(b+w))/w`), so they price closed-form under every belief kind by reusing `price(CALL)` — no per-kind math. `SKEW_GAUSSIAN` = exact per-side half-bell under Gaussian (full-line bell × the `Φ` truncation factor of the product-Gaussian), quadrature otherwise. `SIGMOID` = bounded feature-aware quadrature. `dPriceDMu` for all four is kind-agnostic via `∂E[f]/∂μ = E[f′]`.
- [x] Per-component closed forms compose for mixture automatically.
- [x] Tests: closed-form price = `expectF` = MC; kinks exact; `dPriceDMu` vs finite-difference; TENT/TRAPEZOID == CALL-combo; bounded payoff ⇒ bounded liability. Web wiring (composer buttons, chart handles, `winningRegions`, `specLabel`) landed here so the four are creatable/renderable.

### G5.2 — conditionally-compatible contracts + the compatibility guard
- [x] `POLYNOMIAL` (deg ≤ 4, priced via raw Gaussian moments `mₖ=μmₖ₋₁+(k−1)σ²mₖ₋₂`) and `EXPONENTIAL` (`exp(a(θ−c))`, priced via the Gaussian MGF `e^{a(μ−c)+½a²σ²}`) — both unbounded, both compose for mixture. `dPriceDMu` kind-agnostic via the translation identity (POLYNOMIAL → derivative poly; EXPONENTIAL → `a·price`). `extractSignal`: EXPONENTIAL directional by `sign(rate)`, POLYNOMIAL neutral. EXPONENTIAL clamps its exponent at ±700 so a far-tail MC draw can't overflow.
- [x] Implement the real `contractBeliefCompatible(spec, { tail, nu?, outcomeBounded, outcomeSpan? })`: unbounded ⇒ require a bounded outcome; EXPONENTIAL rejected on a polynomial tail + `|a|·span ≤ 20`; POLYNOMIAL deg ≥ ν rejected on a polynomial tail. Enforced at quote and trade (markets create contracts lazily on first trade, so quote+trade is the create-enforcement point).
- [x] Tests: the guard rejects exp-on-Student-t with a clear error; polynomial finite iff deg < ν; bounded-outcome polynomial prices vs MC.
- [x] `web`: composer gains the two type buttons + editors; incompatible types render disabled with the guard's reason (mirrored client-side), and a selected-but-blocked spec shows a warn banner.
- **Checkpoint:** richer contracts trade where mathematically valid; invalid combinations are blocked with an explanation, never mispriced. math-doc: added the G5.1 + G5.2 payoffs and the integrability/boundedness compatibility table.

---

## Phase G6 — Hardening, migration & docs `[all]` `[blocked-by: all]`
> Done the high-value subset per the pre-launch stance: the demo seed, the full integration sweep, and a legacy-stability golden-master. "No back-compat" means don't run hard old-data-support procedures (old data can be dropped) — it does not mean skipping migrations, which version DB structure; migrations were written normally throughout, only the legacy-inference code path was dropped.

- [x] **Legacy-stability golden-master.** With no persisted pre-refactor market to replay, the guarantee is pinned at the math layer: `gaussian`/`mixture`/`student_t` reprice (LINEAR/CALL/BINARY/SPREAD/GAUSSIAN) and re-update to frozen reference values — any silent drift in the legacy math trips the test.
- [x] **Full integration sweep:** for each of the five models × a representative extension contract, drive create → open → trade → resolve(θ*) → settle → claim through the HTTP surface and assert the payout is exactly `filledQ · payoff(spec, θ*)`. Exercises the reserve gate on every fill and the compat guard + unbounded-contract settlement.
- [x] **Perf: Gen·exact moment cache (I3).** `GenExactBelief` caches the standardised moments `{emin, z, E[u], E[u²]}` — a λ-only function, so they survive a fixed-shape v1 update and are propagated through it; persisted in `belief_state.moments` (optional, no migration, recomputed if absent) so `loadBelief` skips the normalisation quadrature. The cdf/quantile/sample grid is built lazily.
- [x] **Demo-data seed (final step).** `db:seed:markets` creates six ready-to-use markets covering the full surface — one per model plus a bounded-outcome market that exercises POLYNOMIAL/EXPONENTIAL — each opened with a few seeded trades spanning the new shapes. Drives the real service layer so seeded markets are identical to user-created ones. Idempotent (keyed by unique title).
- **Checkpoint:** green suites; legacy golden-master passes; the lifecycle sweep + demo seed exercise both generals + the three classics + every new contract.

---

## Improvements worth folding in (surfaced during this work)

- **I1 — kind-aware `extractSignal`.** Today the signal uses the belief's summary (mean/σ). For multi-modal beliefs, a trade near one camp should preferentially inform that camp. The mixture responsibility step already localises the *update*, but the *signal* is summary-based — make `extractSignal` optionally belief-aware (nearest-mode anchoring). Test vs the current behavior on a unimodal belief (must be identical).
- **I2 — `model` vs `belief_kind` clarity.** Document and lint the invariant (`gen_basis ⇒ belief_kind='mixture'`); add a DB check / assertion so they can't drift.
- **I3 — Gen·exact moment cache.** Shipped (see G6).
- **I4 — Gen·exact v2 moment-projection** (shape-adapting update). Shipped (see G2.3 / G6).
- **I5 — Reserve sample-size audit** for multi-modal/heavy beliefs (ensure the MC α-quantile is stable across modes; bump `samples` if needed).
- **I6 — Calibration/stats for multi-modal** — "which mode did θ* land in," per-mode hit rates.
- **I7 — Contract preset library** + a clear "incompatible because…" UX (ties to G5.2).

---

## Risk register (and the mitigation baked into the plan)

| Risk | Mitigation |
|---|---|
| New math is subtly wrong | every density/price/update MC-verified in `core` before any wiring (principle 2) |
| Breaking existing markets | spawn off for legacy mixture; golden-master math test (G6) |
| Quadrature pricing lag (Gen·exact) | reuse the drag-coarsening/memoisation pattern; cache moments (I3) |
| Contract divergence (exp on heavy tail) | hard integrability guard (G5.2), enforced at create and trade |
| Gen·exact normalisation instability | min-energy shift + u⁶ auto-stabiliser (MC-validated in the sandbox) |
| UI/UX regressions | G3 is pure presentation, separated from all math phases; all five kinds stay creatable |
