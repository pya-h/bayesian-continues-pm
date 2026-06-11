# TASKS — General belief models (Gen·basis + Gen·exact) + contract extensions

Implementation plan for promoting **Gen·basis ** (default) and **Gen·exact ** to first-class
belief models, demoting the existing three to "extra" options, and (later) widening the contract
shapes. Companion to [`general-belief-form.md`](./general-belief-form.md),
[`parametric-belief-families.md`](./parametric-belief-families.md), and
[`contract-extensions.md`](./contract-extensions.md).

> **Status: PLAN ONLY. Nothing here is implemented.** Do not start until explicitly told.

---

## Guiding principles (read before any code)

1. **Reuse-first.** Gen·basis *is* a Gaussian mixture — reuse `MixtureBelief`, `bayesUpdateMixture`,
   closed-form mixture pricing, `manageMixture`, MC reserve. **No new pricing/serialization math** for
   it. Only Gen·exact introduces genuinely new math.
2. **Bottom-up, verify-vs-MC at every math step.** Land and test `core` math *before* wiring `api`,
   and `api` before `web`. Every new density/price/update is asserted against an independent
   Monte-Carlo estimate (tolerance stated per test) — this is the single biggest guard against
   silent mathematical error.
3. **Back-compat is sacred.** Existing `gaussian` / `mixture` / `student_t` markets must behave
   **byte-for-byte unchanged**. Every phase ends with the existing suites green and a migration
   assertion. New columns are nullable with legacy inference.
4. **One concern per PR/commit.** Never mix a math change with a UI change. Each checkpoint is
   independently shippable and revertible.
5. **Math-doc sync.** Any phase that changes the math updates `docs/math/index.html` (the §21 sandbox
   already prototypes both general forms — keep it the source of intuition) and re-verifies 0 KaTeX
   errors. Phases that touch no math note "math-doc: n/a".

---

## Locked design decisions (rationale in the companion docs)

- **D1 — Gen·basis representation = Gaussian mixture.** Stored as the existing mixture state
  (`belief_kind = 'mixture'`). Its distinct identity (rich creation editor, split-enabled adaptive
  update, placement interaction) is carried by a **market-level `model` tag**, *not* a new serialized
  belief kind. → zero new pricing math, zero migration of the math path.
- **D2 — Gen·exact = a new belief kind `gen_exact`.** State `{ kind:'gen_exact', mu, sigma, lambdas:[λ₂,λ₃,λ₄] }`.
  Quadrature-priced (routes through the existing `expectF` fallback). **v1 update = fixed-shape
  location/scale** (variance-domain precision rule, like Student-t); **v2 = moment-projection** (shape
  adapts) is deferred.
- **D3 — `markets.model` column** (`gaussian | student_t | mixture | gen_basis | gen_exact`), nullable;
  legacy rows infer `model = belief_kind`. This is the creator's chosen model (drives UI + update
  config); `belief_kind` stays the math representation.
- **D4 — Admin UI:** two **primary** buttons — **Gen·basis (default)**, **Gen·exact ** — and a
  collapsed **"More models ▾"** revealing **Gaussian / Student-t / Mixture**. All five remain fully
  creatable; only the emphasis changes.
- **D5 — Contract↔belief compatibility guard** (Phase G5): unbounded/heavy contracts validated against
  the belief's tail per [`contract-extensions.md`](./contract-extensions.md).

---

## Phase G0 — Design lock & inert scaffolding `[shared, api]` (no behavior change)

Goal: land the *shape* of the new surface with **zero runtime change**, so later phases are additive.

- [ ] `shared/dto.ts`: add the `ModelTag` enum (`gaussian|student_t|mixture|gen_basis|gen_exact`); do
  **not** wire it into validation yet. Add `gen_exact` to `beliefStateSchema` (discriminated union) and
  a `createGenExactSchema` / `createGenBasisSchema` to `createBeliefSchema` — but keep them unused.
- [ ] `db/schema.ts`: add nullable `markets.model text`. Drizzle migration (additive, no backfill).
- [ ] `core`: add a `BELIEF_TAIL` map (`gaussian|mixture|gen_basis|gen_exact → 'gaussian'`,
  `student_t → 'polynomial'`) + a pure `contractBeliefCompatible(spec, tailKind)` stub returning
  `true` for all current contracts. (Used in G5.)
- [ ] **Tests:** schema parse round-trips for the new (unused) variants; migration applies and existing
  rows read back with `model = null`.
- **Checkpoint:** all existing suites green; `markets.model` exists and is null everywhere; no code path
  reads the new schemas yet. **math-doc: n/a.**

---

## Phase G1 — Gen·basis (the default general model) `[core, shared, api, web]` `[blocked-by: G0]`

Goal: a `gen_basis` model that is a Gaussian mixture with an **adaptive, mode-spawning** update and a
rich creation editor. Reuses all mixture pricing/solvency.

### G1.1 — core: adaptive (spawning) mixture update
- [ ] Extend `MixtureOpsConfig` with `allowSpawn: boolean`, `tauSpawn: number` (default off, so the
  existing `mixture` kind is untouched).
- [ ] In `bayesUpdateMixture` (gated on `allowSpawn`): **before** the responsibility step, if the signal
  `s` is farther than `tauSpawn · σ_k` from **every** component mean *and* `weight ≥ w_min`, seed a new
  component `{ π: w_seed, μ: s, σ²: σ_ε² }`, then run the normal responsibility + per-component update +
  `manageMixture` (which merges it back if redundant, keeps it if it earns responsibility).
- [ ] Keep the existing `splitComponent` available as an alternative trigger but **off** for v1.
- [ ] **Tests** (`core`, vs MC + invariants):
  - a stream of bets far from consensus **grows a new mode** (component count increases, then stabilizes
    under the K-cap); nearby bets do **not** spawn;
  - with `allowSpawn:false`, output is **bit-identical** to today's `bayesUpdateMixture` (regression lock);
  - mass stays normalized (Σπ=1) every step; mean/variance match a brute-force recompute;
  - `manageMixture` still merges/prunes/caps (K never exceeds `maxComponents`).
- **Checkpoint:** spawning mixture verified in isolation; legacy mixture untouched.

### G1.2 — shared + api: creation & wiring
- [ ] `createGenBasisSchema`: `{ kind:'gen_basis', bumps: [{ mu, sigma, weight }] (1..maxK) }` — the
  general form (a grid editor or modes/spread UI just *generates* this list). Validate: ≥1 bump, σ>0,
  weight>0.
- [ ] `marketSvc.makeInitialBelief`: `gen_basis` → `new MixtureBelief(bumps→{pi,mu,sigma2})`; set
  `markets.model='gen_basis'`, `belief_kind='mixture'`.
- [ ] `tradeSvc` (quote/execute) update path: pass `opsCfg = { ...DEFAULT_MIXTURE_OPS, allowSpawn: market.model==='gen_basis', tauSpawn, ... }` into `updateBelief`. (Read `market.model`; default-infer for legacy.)
- [ ] `loadBelief` / `beliefPersistFields`: **unchanged** (it's a mixture).
- [ ] **Tests** (`api` integration): create a `gen_basis` market → it persists as a mixture with the
  authored bumps; a far-from-consensus buy stream grows a mode (read back via market view); a
  `mixture` market created the old way still has `allowSpawn:false` and is unchanged.
- **Checkpoint:** Gen·basis markets create, trade, spawn modes, and price (closed-form) end-to-end via
  the API; old mixture markets unaffected.

### G1.3 — web: types, create body, chart
- [ ] `lib/types.ts`: `CreateBeliefInput` += `{ kind:'gen_basis', bumps:[...] }`; `MarketView.model`.
- [ ] `lib/derive.ts` `buildCreateMarketBody`: emit the `gen_basis` belief from the draft.
- [ ] `BeliefChart`: renders it already (it's a mixture). No change beyond reading `model` for labels.
- [ ] **Tests:** build-body for `gen_basis` (bump list validation); web suite green.
- **Checkpoint:** a creator can author a Gen·basis market in the UI and watch modes form as flow
  arrives. **math-doc:** note the spawn rule in §7's mixture-update block.

---

## Phase G2 — Gen·exact (max-entropy `exp(−poly)`) `[core, shared, api, web]` `[blocked-by: G0]`

Goal: a new `gen_exact` belief kind. **This is the math-heavy phase — go slow, verify each piece vs MC.**

### G2.1 — core: the belief class (math first, no wiring)
Density: `p(θ) = exp(−E(u)) / (σ·Z)`, `u=(θ−μ)/σ`, `E(u)=½λ₂u² + λ₃u³ + λ₄u⁴ + λ₆u⁶`, with the
**auto-stabiliser** `λ₆ = max(λ₆_in, 0.004 + 0.06·max(0,−λ₄) + 0.03·|λ₃|)` so the density is **always
integrable** (tails decay) and skew can't drag the mean off. (This exact formula is already prototyped
and MC-checked in `docs/math/multimodel.js` — port it faithfully.)

- [ ] `core/gen_exact.ts`: `GenExactBelief implements BeliefModel`:
  - constructor caches `Z`, `mean`, `variance` via **fixed composite-Simpson** over `u∈[−L,L]` (`L=7`,
    even node count) with a **min-energy shift** for numerical stability;
  - `pdf` (cached `Z`), `mean`, `variance`, `stddev`;
  - `cdf(θ)` = numeric integral of `pdf` (monotone); `quantile(p)` = bisection on `cdf`;
  - `sample(n, rng)` = inverse-CDF bisection (deterministic) — needed for MC reserve;
  - `serialize()` → `{ kind:'gen_exact', mu, sigma, lambdas:[λ₂,λ₃,λ₄] }`; `fromDTO`.
- [ ] **Tests** (`core`, the gate that prevents math errors):
  - `pdf` integrates to **1.000 ± 1e-3** across a sweep of (λ₂,λ₃,λ₄) incl. λ₂<0 (bimodal);
  - cached `mean`/`variance` match a brute-force fine-grid recompute (± 1e-3);
  - `cdf` monotone in [0,1], `cdf(quantile(p))≈p`;
  - shape sanity: λ₂=1,λ₃=λ₄=0 ≈ Gaussian (KL/|pdf−φ| small); λ₂<0 ⇒ bimodal (two pdf maxima);
    λ₃≠0 ⇒ skew (mean shifts the right way); λ₄>0 ⇒ thinner tails / flat-top;
  - `sample` mean/variance match the analytic cached moments (± a few %, n=400k, seeded `Rng`).

### G2.2 — core: pricing & sensitivity
- [ ] `pricing.ts`: confirm `price()` routes `gen_exact` to the `expectF` fallback (LINEAR → `mean()`
  exactly). Add a `gen_exact` branch to **`dPriceDMu`** (central difference, mirroring `student_t`).
- [ ] **Tests:** `price(spec, genExact)` matches an independent MC of `E[payoff]` (± 0.01) for
  CALL/BINARY/SPREAD across unimodal/skew/bimodal shapes; `dPriceDMu` matches a finite-difference of
  `price` (± 1e-3).

### G2.3 — core: the update (v1 = fixed-shape location/scale)
Treat (μ,σ) as location/scale; **keep λ's fixed**; update in the **variance domain** like `student_t`:
`τ₀=1/Var, τ_s=w/σ_ε², μ'=(τ₀μ+τ_s s)/(τ₀+τ_s), Var'=max(1/(τ₀+τ_s), σ_min²)`, then
`σ' = σ·√(Var'/Var)` (variance ∝ σ² at fixed shape).
- [ ] `bayes.ts`: `bayesUpdateGenExact`; add the `gen_exact` branch to the `updateBelief` dispatcher.
- [ ] **Tests:** μ moves toward `s`, variance strictly decreases (w>0), **λ's unchanged**, kind
  preserved, `σ_min` floor respected, `w=0` ⇒ unchanged location.
- [ ] *(Deferred v2 — moment-projection: after the location/scale step, re-fit λ₃,λ₄ to the post-update
  skew/kurtosis via a small Newton solve. Separate, later sub-phase with its own MC tests.)*

### G2.4 — shared + api + web
- [ ] `shared/dto.ts`: `gen_exact` in `beliefStateSchema` + `createGenExactSchema`
  (`{ kind:'gen_exact', mu, sigma, lambdas }`, bounds on λ's per the sandbox-safe ranges).
- [ ] `api`: `makeInitialBelief` (gen_exact), `loadBelief` (deserialize), `beliefPersistFields`
  (currentMu/Sigma from cached moments + serialize), update dispatch. **Perf note:** `loadBelief`
  recomputes the normalisation quadrature per request — acceptable for v1; if hot, cache moments in
  `belief_state` and recompute only on update (flagged improvement I3).
- [ ] `marketView`: expose `belief.lambdas` (+ μ,σ) for `gen_exact`.
- [ ] `web`: `lib/viz.ts` `genExactPdf` (port the `exp(−poly)` kernel — peak-normalised like
  `studentTPdf`); `beliefFromView` reconstructs it; `BeliefChart` dispatches on `beliefKind`;
  `derive.buildCreateMarketBody` + editor (λ sliders / shape presets).
- [ ] **Tests:** api integration (create gen_exact → quote-vs-MC → trade moves μ, shape preserved →
  serialization round-trips); web `genExactPdf` shape tests; build-body validation.
- **Checkpoint:** Gen·exact markets create, price (quadrature), trade, render the true exp-poly
  shape, and persist. **math-doc:** add the `gen_exact` belief + v1 update to §7/§ belief; re-verify KaTeX.

---

## Phase G3 — Admin panel refactor (primary vs extra) `[web]` `[blocked-by: G1, G2]`

Goal: surface **Gen·basis (default)** and **Gen·exact ** as primary, demote the three behind
**"More models ▾"**. Pure presentation — every kind stays creatable.

- [ ] `AdminPage` `CreateMarketForm`: replace the flat 3-button toggle with: a **primary row**
  (Gen·basis default-selected, Gen·exact), and a collapsible **More models** group
  (Gaussian / Student-t / Mixture). `EMPTY_DRAFT.beliefKind = 'gen_basis'`.
- [ ] Per-model editors: Gen·basis (bump/grid/modes editor → bump list), Gen·exact (λ sliders + presets:
  *Gaussian / Skew / Flat / Bimodal*), and the existing three unchanged.
- [ ] Helper text per model; "Mixture" labelled as a Gen·basis preset; "Student-t" noted as *exact heavy
  tails* (the one capability the generals don't do exactly).
- [ ] **Tests:** default draft is `gen_basis`; build-body for all five kinds; the More-models expander
  toggles; `derive` unit tests per kind.
- **Checkpoint:** create flow leads with the two generals; the three remain one click away; nothing
  about existing markets changes. **math-doc: n/a.**

---

## Phase G4 — Placement interaction ("paint the curve") `[core, api, web]` `[blocked-by: G1]` *(refinement)*

Goal: let a trade **sculpt** a Gen·basis belief directly — the half that makes flexibility usable
(see `parametric-belief-families.md` §4). Optional but high-value.

- [ ] Decide the primitive: (a) reuse the **bell (GAUSSIAN) contract** (already "a bump at c, width w")
  as the placement bet, or (b) a thin **placement op** mapping a click(θ, strength) → a local
  basis-weight bump. Prefer (a) first (no new contract), (b) as the dedicated UX.
- [ ] Wire the placement → spawn/weight update (reuses G1.1 spawning).
- [ ] **Tests:** repeated bell bets at distinct centers carve distinct modes; weight conservation;
  reserve stays bounded.
- **Checkpoint:** a user shapes a multi-bump belief through trades. **math-doc:** note the placement↔weight map.

---

## Phase G5 — Contract-shape extensions `[core, shared, api, web]` `[blocked-by: G0; independent of G1–G4]`

Goal: wider user-trade curves. Math/compat analysis in [`contract-extensions.md`](./contract-extensions.md).

### G5.1 — bounded, closed-form contracts (zero risk-model change)
- [ ] `core/contracts.ts`: add `SKEW_GAUSSIAN` (asymmetric bell, two widths), `TENT` (triangle),
  `TRAPEZOID`, `SIGMOID`. For each: `payoff`, `payoffKinks`, **closed-form price under Gaussian** where
  one exists (skew-bell = per-side Gaussian×Gaussian → `Φ/φ`; tent/trapezoid = sums of `CALL`-ramps →
  `Φ/φ`), else quadrature; `dPriceDMu`; a `winningRegion`.
- [ ] `pricing.ts`: per-component closed forms compose for mixture (`Σπₖ·priceₖ`) automatically.
- [ ] **Tests:** closed-form price **= `expectF` = MC** (± 1e-3 / ± 0.01); kinks exact; `dPriceDMu`
  finite-difference; bounded payoff ⇒ bounded liability check.

### G5.2 — conditionally-compatible contracts + the compatibility guard
- [ ] `POLYNOMIAL` (closed-form Gaussian moments) and `EXPONENTIAL` (Gaussian MGF) — **bounded-outcome
  markets only / capped**.
- [ ] Implement `contractBeliefCompatible(spec, tailKind)` (G0 stub → real): reject `EXPONENTIAL` and
  `POLYNOMIAL(deg ≥ ν)` on `student_t` (polynomial-tail) markets; require `outcomeMin/Max` (or a cap)
  for unbounded payoffs. Enforce at **create** (spec presets) and **quote/trade**.
- [ ] **Tests:** integrability guard rejects exp-on-Student-t (would diverge) with a clear error;
  polynomial finite iff `deg < ν`; bounded-outcome polynomial prices vs MC.
- [ ] `web`: extend `ContractComposer` + `BeliefChart` handles for the new specs; disabled options with
  reasons when incompatible with the market's belief.
- **Checkpoint:** richer contracts trade where mathematically valid; invalid combinations are
  blocked with an explanation, never mispriced. **math-doc:** add the new payoffs + the compatibility
  table to §3/§4.

---

## Phase G6 — Hardening, migration & docs `[all]` `[blocked-by: all]`

- [ ] **Migration/back-compat test:** a snapshot of pre-refactor `gaussian/mixture/student_t` markets
  reprices and re-updates **identically** after the refactor (golden-master assertion).
- [ ] **Full integration sweep:** create/trade/settle for all five models + new contracts; reserve/NAV
  consistent; circuit breakers and stats kind-agnostic.
- [ ] **Perf:** Gen·exact quadrature caching (improvement I3); reuse the `PriceCurveChart` drag-coarsening
  lesson for any quadrature-priced preview.
- [ ] **Math-doc consolidating pass:** §21 sandbox ↔ shipped code parity; re-verify 0 KaTeX errors.
- **Checkpoint:** green suites; migration golden-master passes; demo exercises both generals + extras +
  new contracts.

---

## Improvements worth folding in (surfaced during this work)

- **I1 — kind-aware `extractSignal`.** Today the signal uses the belief's *summary* (mean/σ). For
  multi-modal beliefs, a trade near one camp should preferentially inform that camp. The mixture
  responsibility step already localises the *update*, but the *signal* is summary-based — make
  `extractSignal` optionally belief-aware (nearest-mode anchoring). Test vs the current behavior on a
  unimodal belief (must be identical).
- **I2 — `model` vs `belief_kind` clarity.** Document and lint the invariant (`gen_basis ⇒
  belief_kind='mixture'`); add a DB check / assertion so they can't drift.
- **I3 — Gen·exact moment cache.** Persist `{Z, mean, var}` in `belief_state` so `loadBelief` skips the
  normalisation quadrature on hot reads; invalidate on update.
- **I4 — Gen·exact v2 moment-projection** (shape-adapting update) — its own sub-phase with MC tests.
- **I5 — Reserve sample-size audit** for multi-modal/heavy beliefs (ensure the MC α-quantile is stable
  across modes; bump `samples` if needed).
- **I6 — Calibration/stats for multi-modal** — "which mode did θ* land in," per-mode hit rates.
- **I7 — Contract preset library** + a clear "incompatible because…" UX (ties to G5.2).

---

## Risk register (and the mitigation baked into the plan)

| Risk | Mitigation |
|---|---|
| New math is subtly wrong | every density/price/update **MC-verified** in `core` before any wiring (principle 2) |
| Breaking existing markets | `model` nullable + legacy inference; spawn **off** for legacy mixture; **golden-master** migration test (G6) |
| Quadrature pricing lag (Gen·exact) | reuse the shipped drag-coarsening/memoisation pattern; cache moments (I3) |
| Contract divergence (exp on heavy tail) | hard **integrability guard** (G5.2), enforced at create *and* trade |
| Gen·exact normalisation instability | min-energy shift + u⁶ auto-stabiliser (already MC-validated in the sandbox) |
| UI/UX regressions | G3 is pure presentation, separated from all math phases; all five kinds stay creatable |
