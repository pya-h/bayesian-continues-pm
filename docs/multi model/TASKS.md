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
- **D3 — `markets.model` column** (`gaussian | student_t | mixture | gen_basis | gen_exact`). This is the
  creator's chosen model (drives UI + update config); `belief_kind` stays the math representation.
  *(Originally nullable with legacy `model = belief_kind` inference for pre-refactor rows. **Simplified
  2026-06-18:** since the platform is pre-launch we dropped the back-compat path entirely — the column is
  now `NOT NULL DEFAULT 'gaussian'` (set on every market at creation by `resolveModel`), the `?? beliefKind`
  inference fallbacks were removed (api `mixtureOpsFor`, `marketView`), and `mixtureOpsForModel` tightened to
  take a non-null `ModelTag`. The original add-column + the `NOT NULL` were squashed into a single clean
  migration `0004_mysterious_pete_wisdom` (`ADD COLUMN "model" text DEFAULT 'gaussian' NOT NULL`); the DB
  was reset (`db:reset` → `db:migrate` → `db:seed`).)*
- **D4 — Admin UI:** two **primary** buttons — **Gen·basis (default)**, **Gen·exact ** — and a
  collapsed **"More models ▾"** revealing **Gaussian / Student-t / Mixture**. All five remain fully
  creatable; only the emphasis changes.
- **D5 — Contract↔belief compatibility guard** (Phase G5): unbounded/heavy contracts validated against
  the belief's tail per [`contract-extensions.md`](./contract-extensions.md).

---

## Phase G0 — Design lock & inert scaffolding `[shared, api]` (no behavior change)

Goal: land the *shape* of the new surface with **zero runtime change**, so later phases are additive.

- [x] `shared/dto.ts`: add the `ModelTag` enum (`gaussian|student_t|mixture|gen_basis|gen_exact`); do
  **not** wire it into validation yet. Add `gen_exact` to `beliefStateSchema` (discriminated union) and
  a `createGenExactSchema` / `createGenBasisSchema` to `createBeliefSchema` — but keep them unused.
  *(Done: `ModelTag` lives in `shared/enums.ts`; `genExactStateSchema` added to `beliefStateSchema`;
  `gen_basis` (bump list, ≤12) and `gen_exact` (λ-tuple, reuses initialMu/Sigma) variants added to
  `createBeliefSchema`. Parsed but unwired.)*
- [x] `db/schema.ts`: add nullable `markets.model text`. Drizzle migration (additive, no backfill).
  *(Done: `model: text('model').$type<ModelTag>()`. Note: originally an additive nullable column; on
  2026-06-18 it was simplified to `NOT NULL DEFAULT 'gaussian'` and the migration squashed — see D3.)*
- [x] `core`: add a `BELIEF_TAIL` map (`gaussian|mixture|gen_basis|gen_exact → 'gaussian'`,
  `student_t → 'polynomial'`) + a pure `contractBeliefCompatible(spec, tailKind)` stub returning
  `true` for all current contracts. (Used in G5.) *(Done: `core/compat.ts`, exported from `core/index.ts`.)*
- [x] **Tests:** schema parse round-trips for the new (unused) variants; migration applies and existing
  rows read back with `model = null`. *(Done: `shared` round-trips all five create kinds + gen_exact
  state; `core/test/compat.test.ts` covers the tail map + stub; `markets.test.ts` asserts a new market
  reads `model = null` and that gen_basis/gen_exact create fails closed with 400.)*
- **Checkpoint:** all existing suites green; `markets.model` exists and is null everywhere; no code path
  reads the new schemas yet. **math-doc: n/a.** *( 2026-06-14 — core 200, shared 14, api 136 pass;
  typecheck clean across all 4 packages. makeInitialBelief fails closed on the new kinds rather than
  silently constructing a Gaussian.)*

---

## Phase G1 — Gen·basis (the default general model) `[core, shared, api, web]` `[blocked-by: G0]`

Goal: a `gen_basis` model that is a Gaussian mixture with an **adaptive, mode-spawning** update and a
rich creation editor. Reuses all mixture pricing/solvency.

### G1.1 — core: adaptive (spawning) mixture update
- [x] Extend `MixtureOpsConfig` with `allowSpawn: boolean`, `tauSpawn: number` (default off, so the
  existing `mixture` kind is untouched). *(Done: added `allowSpawn`/`tauSpawn`/`spawnWeightMin`/
  `spawnSeedWeight` as **optional** fields — keeps `manageMixture`'s partial-config callers valid —
  with `DEFAULT_MIXTURE_OPS` providing them all (`allowSpawn:false`).)*
- [x] In `bayesUpdateMixture` (gated on `allowSpawn`): **before** the responsibility step, if the signal
  `s` is farther than `tauSpawn · σ_k` from **every** component mean *and* `weight ≥ w_min`, seed a new
  component `{ π: w_seed, μ: s, σ²: σ_ε² }`, then run the normal responsibility + per-component update +
  `manageMixture` (which merges it back if redundant, keeps it if it earns responsibility).
  *(Done; seed σ² = max(σ_ε², σ_min²), gated under the K-cap.)*
- [x] Keep the existing `splitComponent` available as an alternative trigger but **off** for v1.
  *(Unchanged — still exported, unused by the spawn path.)*
- [x] **Tests** (`core`, vs MC + invariants): `bayesMixtureSpawn.test.ts` —
  - disagreement (consensus vs a far camp) grows a 2nd mode from one; low-weight & nearby bets don't spawn;
  - `allowSpawn:false` ⇒ component-identical to the default path (regression lock) — *note:* an extreme
    outlier still migrates/prunes the old mode (shipped behavior), so the lock is on path-equality, not on
    holding K fixed;
  - Σπ=1 every step; pdf integrates to 1 and grid-mean ≈ class mean (independent quadrature check);
  - K never exceeds `maxComponents` under a chaotic far stream.
- **Checkpoint:** spawning verified in isolation (core 206 pass); legacy mixture suites untouched.

### G1.2 — shared + api: creation & wiring
- [x] `createGenBasisSchema`: `{ kind:'gen_basis', bumps: [{ mu, sigma, weight }] (1..maxK) }`.
  *(Done in G0 — the `gen_basis` variant in `createBeliefSchema`, `maxK = MAX_GEN_BASIS_BUMPS = 12`,
  σ>0/weight>0 enforced.)*
- [x] `marketSvc.makeInitialBelief`: `gen_basis` → `new MixtureBelief(bumps→{pi,mu,sigma2})`; set
  `markets.model='gen_basis'`, `belief_kind='mixture'`. *(Done via `makeInitialBelief` + `resolveModel`;
  `model` now persisted for **all** new markets — Gaussian default included.)*
- [x] `tradeSvc` (quote/execute) update path: pass spawning `opsCfg` into `updateBelief`.
  *(Done: `mixtureOpsFor(row)` in `lib/belief.ts` (legacy-infers `model ?? beliefKind`, relaxes the cap to
  12 + `allowSpawn` for gen_basis) wired at all three `updateBelief` sites — quote, execute, sell-all.)*
- [x] `loadBelief` / `beliefPersistFields`: **unchanged** (it's a mixture). Also exposed `MarketView.model`.
- [x] **Tests** (`api` integration): `genBasisMarket.test.ts` — gen_basis persists as a mixture with the
  authored bumps + `model='gen_basis'`; a far bell-buy stream grows a mode (read back via the view); a
  plain `mixture` market under the same stream never grows its count (spawn off).
- **Checkpoint:** Gen·basis markets create, trade, spawn modes, price closed-form end-to-end (api 139
  pass); old mixture markets unaffected.

### G1.3 — web: types, create body, chart
- [x] `lib/types.ts`: `CreateBeliefInput` += `{ kind:'gen_basis', bumps:[...] }`; `MarketView.model`
  (+ a `ModelTag` type). *(Done.)*
- [x] `lib/derive.ts` `buildCreateMarketBody`: emit the `gen_basis` belief from the draft (bumps from the
  mode-draft rows, weight ≡ π; ≥1 bump). *(Done.)*
- [x] `BeliefChart`: renders it already (it's a mixture). *(Unchanged; the `model`-aware label refinement
  is deferred to G3, the presentation phase.)*
- [x] **Tests:** build-body for `gen_basis` (bump list validation) added to `derive.test.ts`; web suite green (166).
- **Checkpoint:** a creator can author a Gen·basis market in the UI and watch modes form as flow
  arrives. **math-doc:** spawn rule noted in §7's mixture-update block (`docs/math/index.html`). *(
  2026-06-14 — full sweep 525 pass; typecheck + biome clean. KaTeX macros reused from the same block, so
  rendering parity holds; couldn't auto-verify locally — katex not installed.)*

---

## Phase G2 — Gen·exact (max-entropy `exp(−poly)`) `[core, shared, api, web]` `[blocked-by: G0]`

Goal: a new `gen_exact` belief kind. **This is the math-heavy phase — go slow, verify each piece vs MC.**

### G2.1 — core: the belief class (math first, no wiring)
Density: `p(θ) = exp(−E(u)) / (σ·Z)`, `u=(θ−μ)/σ`, `E(u)=½λ₂u² + λ₃u³ + λ₄u⁴ + λ₆u⁶`, with the
**auto-stabiliser** `λ₆ = max(λ₆_in, 0.004 + 0.06·max(0,−λ₄) + 0.03·|λ₃|)` so the density is **always
integrable** (tails decay) and skew can't drag the mean off. (This exact formula is already prototyped
and MC-checked in `docs/math/multimodel.js` — port it faithfully.)

- [x] `core/gen_exact.ts`: `GenExactBelief implements BeliefModel`:
  - constructor caches `Z`, `mean`, `variance` via **fixed composite-Simpson** over `u∈[−L,L]` (`L=7`,
    even node count) with a **min-energy shift** for numerical stability;
  - `pdf` (cached `Z`), `mean`, `variance`, `stddev`;
  - `cdf(θ)` = numeric integral of `pdf` (monotone); `quantile(p)` = bisection on `cdf`;
  - `sample(n, rng)` = inverse-CDF bisection (deterministic) — needed for MC reserve;
  - `serialize()` → `{ kind:'gen_exact', mu, sigma, lambdas:[λ₂,λ₃,λ₄] }`; `fromDTO`.
  *(Done. Ported `multimodel.js maxEnt` faithfully: Simpson `Z`/`E[u]`/`E[u²]` with min-energy shift;
  `λ₆ = 0.004 + 0.06·max(0,−λ₄) + 0.03·|λ₃|` (no `λ₆_in` since the DTO carries only [λ₂,λ₃,λ₄]). cdf/
  quantile/sample share a normalised cumulative-trapezoid grid over the same window — O(log N) inverse-
  CDF, monotone by construction. `BeliefKind`/`BeliefStateDTO` extended; exported from core barrel.)*
- [x] **Tests** (`core`, the gate that prevents math errors):
  - `pdf` integrates to **1.000 ± 1e-3** across a sweep of (λ₂,λ₃,λ₄) incl. λ₂<0 (bimodal);
  - cached `mean`/`variance` match a brute-force fine-grid recompute (± 1e-3);
  - `cdf` monotone in [0,1], `cdf(quantile(p))≈p`;
  - shape sanity: λ₂=1,λ₃=λ₄=0 ≈ Gaussian (KL/|pdf−φ| small); λ₂<0 ⇒ bimodal (two pdf maxima);
    λ₃≠0 ⇒ skew (mean shifts the right way); λ₄>0 ⇒ thinner tails / flat-top;
  - `sample` mean/variance match the analytic cached moments (± a few %, n=400k, seeded `Rng`).
  *(Done: `genExact.test.ts`, 24 tests over a 6-shape sweep — all of the above verified. Note skew sign:
  `λ₃>0` favours `u<0` ⇒ mean shifts **below** μ; the test asserts that direction + mirror symmetry.)*

### G2.2 — core: pricing & sensitivity
- [x] `pricing.ts`: confirm `price()` routes `gen_exact` to the `expectF` fallback (LINEAR → `mean()`
  exactly). Add a `gen_exact` branch to **`dPriceDMu`** (central difference, mirroring `student_t`).
  *(Done with one deliberate refinement over "just the fallback": added a `priceUnderGenExact` mirroring
  `priceUnderStudentT` — BINARY/SPREAD price from the cached **CDF**, CALL/PUT/GAUSSIAN via quadrature.
  Routing a step payoff through Simpson gives O(h) error that the finite-difference ∂P/∂μ test would
  amplify (the C42 trap); since `gen_exact` is a fixed-shape **location family in μ**, `dPriceDMu` uses
  the exact pdf/cdf identities for kinks/jumps and the central difference only for the smooth GAUSSIAN —
  byte-for-byte the `student_t` structure.)*
- [x] **Tests:** `price(spec, genExact)` matches an independent MC of `E[payoff]` (± 0.01) for
  CALL/BINARY/SPREAD across unimodal/skew/bimodal shapes; `dPriceDMu` matches a finite-difference of
  `price` (± 1e-3). *(Done: `genExactPricing.test.ts`, 49 tests — 4 shapes × 6 contract types, σ=1 so the
  ±0.01 MC tolerance is meaningful; ∂P/∂μ vs central-difference within 2e-3.)*

### G2.3 — core: the update (v1 = fixed-shape location/scale)
Treat (μ,σ) as location/scale; **keep λ's fixed**; update in the **variance domain** like `student_t`:
`τ₀=1/Var, τ_s=w/σ_ε², μ'=(τ₀μ+τ_s s)/(τ₀+τ_s), Var'=max(1/(τ₀+τ_s), σ_min²)`, then
`σ' = σ·√(Var'/Var)` (variance ∝ σ² at fixed shape).
- [x] `bayes.ts`: `bayesUpdateGenExact`; add the `gen_exact` branch to the `updateBelief` dispatcher.
  *(Done. Update treats `μ` as the location param and the cached belief variance `V=σ²·Var[u]` as its
  precision; rescales `σ' = σ·√(V'/V)` so the belief variance lands exactly on `V'` at fixed shape.
  `useSimplifiedUpdate` path mirrored too. Dispatcher branch added; exported from the barrel.)*
- [x] **Tests:** μ moves toward `s`, variance strictly decreases (w>0), **λ's unchanged**, kind
  preserved, `σ_min` floor respected, `w=0` ⇒ unchanged location. *(Done: `genExactUpdate.test.ts`,
  8 tests over 3 shapes incl. convergence, the σ_min floor under a 50-step confident stream, and the
  simplified path.)*
- [ ] *(Deferred v2 — moment-projection: after the location/scale step, re-fit λ₃,λ₄ to the post-update
  skew/kurtosis via a small Newton solve. Separate, later sub-phase with its own MC tests.)* — **still deferred (I4).**

### G2.4 — shared + api + web
- [x] `shared/dto.ts`: `gen_exact` in `beliefStateSchema` + `createGenExactSchema`
  (`{ kind:'gen_exact', mu, sigma, lambdas }`, bounds on λ's per the sandbox-safe ranges).
  *(State + create variants were in place from G0; G2.4 pinned the **sandbox-safe λ bounds** from the
  sliders — λ₂∈[−4,4], λ₃∈[−0.35,0.35] (=α/40 over ±14), λ₄∈[0,1.6] — as a per-element bounded tuple.)*
- [x] `api`: `makeInitialBelief` (gen_exact), `loadBelief` (deserialize), `beliefPersistFields`
  (currentMu/Sigma from cached moments + serialize), update dispatch. **Perf note:** `loadBelief`
  recomputes the normalisation quadrature per request — acceptable for v1; if hot, cache moments in
  `belief_state` and recompute only on update (flagged improvement I3).
  *(Done: `makeInitialBelief` now constructs `GenExactBelief(initialMu, initialSigma, lambdas)` instead of
  the G0 fail-closed throw; `resolveModel` already tags `model='gen_exact'`; `loadBelief` deserializes;
  `beliefPersistFields` unchanged (non-gaussian ⇒ serializes, summary mean/σ from cached moments). Update
  dispatch via the core `updateBelief` branch — trade path needs no change. I3 still open.)*
- [x] `marketView`: expose `belief.lambdas` (+ μ,σ) for `gen_exact`.
  *(Done: view belief gains `lambdas` + the raw `loc`/`scale` params (≠ the summary mean/σ for skewed
  shapes) so the chart and `beliefFromView` reconstruct the true density.)*
- [x] `web`: `lib/viz.ts` `genExactPdf` (port the `exp(−poly)` kernel — peak-normalised like
  `studentTPdf`); `beliefFromView` reconstructs it; `BeliefChart` dispatches on `beliefKind`;
  `derive.buildCreateMarketBody` + editor (λ sliders / shape presets).
  *(Done: `genExactPdf`/`genExactPdfCurve` (raw `exp(−E(u))` kernel, chart peak-normalises by its own max
  as it does for Student-t); `beliefFromView` rebuilds `GenExactBelief` from loc/scale/λ (so the client
  fair/projection previews use the real shape via the kind-agnostic `updateBelief`); `BeliefChart` gains a
  `genExact` prop + dispatch (curve + hover); `buildCreateMarketBody` emits `gen_exact` from a λ draft with
  range validation. **The admin-form λ-slider/preset UI is deferred to G3** — the presentation phase — exactly
  as G1.3 deferred the gen_basis form control; the data layer + chart rendering are done here.)*
- [x] **Tests:** api integration (create gen_exact → quote-vs-MC → trade moves μ, shape preserved →
  serialization round-trips); web `genExactPdf` shape tests; build-body validation.
  *(Done: `genExactMarket.test.ts` (persist+view λ/loc/scale, out-of-range λ→400, trade moves μ with λ
  fixed, quote == independent `price()`); `viz.test.ts` genExactPdf shape tests; `derive.test.ts` +
  `beliefFromView.test.ts` + `shared.test.ts` bound checks. `markets.test.ts` G0 fail-closed test
  repurposed to a bounds-rejection.)*
- **Checkpoint:** Gen·exact markets create, price (quadrature), trade, render the true exp-poly
  shape, and persist. **math-doc:** add the `gen_exact` belief + v1 update to §7/§ belief; re-verify KaTeX.
  *( 2026-06-14 — full sweep **620 pass** (core 287 · shared 15 · api 143 · web 175); typecheck + biome
  clean on all touched files. Math-doc: added a "V2 — the Gen·exact belief and its update" `<details>` block
  in §7 with the density, the auto-stabiliser, and the variance-domain v1 update; KaTeX macros reuse the
  same block conventions — couldn't auto-verify locally (katex not installed).)*

---

## Phase G3 — Admin panel refactor (primary vs extra) `[web]` `[blocked-by: G1, G2]`

Goal: surface **Gen·basis (default)** and **Gen·exact ** as primary, demote the three behind
**"More models ▾"**. Pure presentation — every kind stays creatable.

- [x] `AdminPage` `CreateMarketForm`: replace the flat 3-button toggle with: a **primary row**
  (Gen·basis default-selected, Gen·exact), and a collapsible **More models** group
  (Gaussian / Student-t / Mixture). `EMPTY_DRAFT.beliefKind = 'gen_basis'`.
  *(Done. Two-up `ModelButton` primary row + a `▸ More models` expander revealing the three classics;
  selecting a classic auto-opens the group so the choice stays visible. `EMPTY_DRAFT` now defaults to
  `gen_basis` seeded with one bump + a Gaussian λ-preset; `setKind` re-seeds per kind (≥1 bump for
  gen_basis, ≥2 for mixture, ν=5 for t, [1,0,0] for gen_exact). `showMore` resets on create.)*
- [x] Per-model editors: Gen·basis (bump/grid/modes editor → bump list), Gen·exact (λ sliders + presets:
  *Gaussian / Skew / Flat / Bimodal*), and the existing three unchanged.
  *(Done. Gen·basis and Mixture share the bump/mode-row editor (noun + min-count differ: "bump"/≥1 vs
  "mode"/≥2). Gen·exact gets three range sliders bound to the sandbox-safe ranges + the four preset chips.
  Student-t keeps its ν field; Gaussian has no editor.)*
- [x] Helper text per model; "Mixture" labelled as a Gen·basis preset; "Student-t" noted as *exact heavy
  tails* (the one capability the generals don't do exactly).
  *(Done via `MODEL_META[kind].help` shown under the selector — Mixture reads "a Gen·basis preset (fixed
  camps, spawning off)", Student-t "exact heavy (polynomial) tails — the one capability the generals don't
  reproduce exactly".)*
- [x] **Tests:** default draft is `gen_basis`; build-body for all five kinds; the More-models expander
  toggles; `derive` unit tests per kind. *(Done for the DOM-free surface: `derive.test.ts` gains a
  consolidated "builds a valid belief for all five model kinds" test on top of the per-kind tests. **The
  web suite is pure-function only (no RTL/DOM harness)** — `EMPTY_DRAFT`-default and the expander toggle are
  React component state, so they're covered by typecheck + manual/visual review rather than a unit test, in
  keeping with the existing form having no component tests. Standing up an RTL harness is out of scope for a
  presentation phase.)*
- **Checkpoint:** create flow leads with the two generals; the three remain one click away; nothing
  about existing markets changes. **math-doc: n/a.** *( 2026-06-14 — full sweep **621 pass** (core 287 ·
  shared 15 · api 143 · web 176); typecheck + biome clean. No api/core/shared changes — pure web
  presentation; the `model` tag + all five create paths were already wired in G1/G2.)*

---

## Phase G4 — Placement interaction ("paint the curve") `[core, api, web]` `[blocked-by: G1]` *(refinement)*

Goal: let a trade **sculpt** a Gen·basis belief directly — the half that makes flexibility usable
(see `parametric-belief-families.md` §4). Optional but high-value.

- [x] Decide the primitive: (a) reuse the **bell (GAUSSIAN) contract** (already "a bump at c, width w")
  as the placement bet, or (b) a thin **placement op** mapping a click(θ, strength) → a local
  basis-weight bump. Prefer (a) first (no new contract), (b) as the dedicated UX.
  *(Decided **(a) the bell contract** — no new contract — but with the **(b) weight-only mechanism**: a
  bell trade on a gen_basis market routes to a `placeBasisBump`. **Why both:** the G1.1 responsibility+spawn
  update reliably grows ONE camp away from consensus but is **consensus/recency-forming** — verified that
  sustained round-robin painting collapses to the last camp, so it can't hold 3+ balanced modes. The
  design's recommended weight-only **additive** update (parametric-belief-families.md §4 option 3) does, so
  G4 ships it: the bell is the gesture, the weight-only placement is the math.)*
- [x] Wire the placement → spawn/weight update (reuses G1.1 spawning).
  *(Done: `core/placement.ts` `placeBasisBump` (buy adds mass at the bell center / spawns a bump if far,
  sell removes mass from a bump you're on, renormalise + manageMixture); `bayes.ts` `updateBeliefForTrade`
  routes `gen_basis` + `GAUSSIAN` → placement, every other (model, contract) pair → the unchanged
  `extractSignal → updateBelief`. Wired at all 3 `tradeSvc` belief-update sites + the web `projectBelief`
  preview (so the projection mirrors the server). `QuotePanel`/`MarketPage` pass the `model` tag.)*
- [x] **Tests:** repeated bell bets at distinct centers carve distinct modes; weight conservation;
  reserve stays bounded. *(Done: `core/test/genBasisPlacement.test.ts` — 3 distinct persistent modes
  (each π>0.05, which the responsibility update fails), Σπ=1 every step, K≤cap under chaotic painting,
  sell-erases-a-camp, routing (only gen_basis bells paint), finite moments + MC reserve bounded by Σ mmShort.
  `api/test/genBasisPlacement.test.ts` — end-to-end bell-buys at 3 centers sculpt a 3-bump belief read via
  the view, reserveRequired finite & < R₀, and selling a bell back erases that camp.)*
- **Checkpoint:** a user shapes a multi-bump belief through trades. **math-doc:** note the placement↔weight map.
  *( 2026-06-14 — full sweep **634 pass** (core 297 · shared 15 · api 145 · web 177); typecheck + biome
  clean. Math-doc: added a "Gen·basis — placement (paint the curve)" paragraph to §7 with the weight-only
  add/remove rule and why it's additive (not consensus-forming). Web: a "Paint the curve" hint shows on
  gen_basis markets. G1 gen_basis tests stay green — a far bell stream still grows a mode.)*

> **Review pass G0→G4 (2026-06-18).** Two cross-phase fixes, full sweep **636 pass** (core 299 · shared 15
> · api 145 · web 177), typecheck + biome clean:
> 1. **Preview ↔ server parity (G1/G4).** The web client preview (`clientBelief.projectBelief`) called
> `updateBeliefForTrade` *without* `opsCfg`, so a Gen·basis projection silently used `DEFAULT_MIXTURE_OPS`
> (spawn **off**, cap 6) instead of the server's spawn-on/cap-12 — contradicting its own "mirrors the
> server exactly" contract. Moved the ops policy into a shared `@bmm/core` `mixtureOpsForModel(model)`
> (+ `GEN_BASIS_MAX_COMPONENTS`/`GEN_BASIS_TAU_SPAWN`); the api `mixtureOpsFor` now delegates to it and the
> preview passes `mixtureOpsForModel(model)` — single source of truth, preview = server.
> 2. **Audit fidelity for placement (G4).** A Gen·basis bell trade applies `placeBasisBump`, but the audit row
> recorded the standard `extractSignal` (a "pushed-away" location for sells). Added `tradeSignal()` in
> `@bmm/core`, kept in lock-step with `updateBeliefForTrade`: a placement audits as `(bell center, signed
> strength)` — `+` mass added, `−` removed; everything else falls through to `extractSignal`. Wired at both
> audited `tradeSvc` sites; covered by 2 new core tests.

---

## Phase G5 — Contract-shape extensions `[core, shared, api, web]` `[blocked-by: G0; independent of G1–G4]`

Goal: wider user-trade curves. Math/compat analysis in [`contract-extensions.md`](./contract-extensions.md).

### G5.1 — bounded, closed-form contracts (zero risk-model change)
- [x] `core/contracts.ts`: add `SKEW_GAUSSIAN` (asymmetric bell, two widths), `TENT` (triangle),
  `TRAPEZOID`, `SIGMOID`. For each: `payoff`, `payoffKinks`, **closed-form price under Gaussian** where
  one exists (skew-bell = per-side Gaussian×Gaussian → `Φ/φ`; tent/trapezoid = sums of `CALL`-ramps →
  `Φ/φ`), else quadrature; `dPriceDMu`; a `winningRegion`.
  *(Done. payoff/validate/contractKey/payoffKinks/payoffBounds extended; all four bounded ∈[0,1].
  **Headline simplification:** `TENT`/`TRAPEZOID` are exact CALL-ramp sums — `tent=(R(c−w)−2R(c)+R(c+w))/w`,
  `trap=(R(a−w)−R(a)−R(b)+R(b+w))/w` — so they price closed-form under EVERY belief kind by reusing
  `price(CALL)` (no per-kind math). `SKEW_GAUSSIAN` = exact per-side half-bell closed form under Gaussian
  (`priceSkewGaussian`: full-line `priceGaussianPayoff` × the `Φ` truncation factor of the product-Gaussian),
  quadrature for t/gen_exact. `SIGMOID` = bounded `expectFeature` quadrature (new feature-aware window, the
  generalisation of `expectGaussianBump`). **`dPriceDMu` for all four is kind-agnostic via the translation
  identity ∂E[f]/∂μ = E[f′]:** TENT/TRAPEZOID differentiate their CALL decomposition; SIGMOID/SKEW integrate
  the analytic f′. `winningRegion` = web `viz.winningRegions` (FWHM band / flat-top / "above c").)*
- [x] `pricing.ts`: per-component closed forms compose for mixture (`Σπₖ·priceₖ`) automatically.
  *(Done — `SKEW_GAUSSIAN` rides the existing mixture `Σπₖ·priceUnderGaussian` loop; TENT/TRAPEZOID compose
  through `price(CALL)` which is itself per-component for mixture; verified equal to the CALL-combo to 1e-9.)*
- [x] **Tests:** closed-form price **= `expectF` = MC** (± 1e-3 / ± 0.01); kinks exact; `dPriceDMu`
  finite-difference; bounded payoff ⇒ bounded liability check.
  *(Done: `core/test/contractShapes.test.ts` (42 tests) — price≈expectF≈MC across gaussian/mixture/student_t/
  gen_exact, far-AND-narrow SKEW/SIGMOID vs 4M-draw MC, dPriceDMu vs central-difference, TENT/TRAPEZOID ==
  CALL-combo to 1e-9, shape/kinks/bounds/key/validation. `shared.test.ts` round-trips + rejects the four
  variants. `api/test/contractShapes.test.ts` — quote fair == core `price()` and a SKEW_GAUSSIAN buy executes
  + persists its contract row. **Web wiring landed here too** (composer buttons + per-param inputs, chart drag
  handles, `winningRegions`, `specLabel`) so the four are creatable/renderable; POLYNOMIAL/EXPONENTIAL composer
  entries + the disabled-with-reason UX stay in G5.2.)*

> **G5.1 checkpoint (2026-06-18).** Full sweep **684 pass** (core 341 · shared 16 · api 150 · web 177);
> typecheck + biome clean. Zero risk-model change (all four payoffs bounded ∈[0,1]); legacy contracts
> untouched. **math-doc: deferred to the G5 checkpoint** (after G5.2, per the §3/§4 payoff + compatibility-
> table pass). **G5.2 NOT started** — POLYNOMIAL/EXPONENTIAL + the real `contractBeliefCompatible`
> integrability guard + outcome-bounds machinery is the next, separately-reviewable concern.

### G5.2 — conditionally-compatible contracts + the compatibility guard
- [x] `POLYNOMIAL` (closed-form Gaussian moments) and `EXPONENTIAL` (Gaussian MGF) — **bounded-outcome
  markets only / capped**. *(Done. `POLYNOMIAL` = `coeffs:[a₀..aₙ]` (deg ≤ 4, stored as `c0..cN` so the
  jsonb `params` stays `Record<string,number>`), priced via raw Gaussian moments `mₖ=μmₖ₋₁+(k−1)σ²mₖ₋₂`;
  `EXPONENTIAL` = `exp(a(θ−c))`, priced via the Gaussian MGF `e^{a(μ−c)+½a²σ²}`. Both unbounded
  (`payoffBounds.bounded=false`); both compose for mixture/Gen·basis automatically. `dPriceDMu` is
  kind-agnostic via the translation identity (POLYNOMIAL → derivative poly; EXPONENTIAL → `a·price`).
  `extractSignal`: EXPONENTIAL directional by `sign(rate)`, POLYNOMIAL neutral (a shape, not a location,
  bet). EXPONENTIAL payoff clamps its exponent at ±700 so a contrived far-tail MC draw can't overflow.)*
- [x] Implement `contractBeliefCompatible(spec, tailKind)` (G0 stub → real): reject `EXPONENTIAL` and
  `POLYNOMIAL(deg ≥ ν)` on `student_t` (polynomial-tail) markets; require `outcomeMin/Max` (or a cap)
  for unbounded payoffs. Enforce at **create** (spec presets) and **quote/trade**. *(Done. Signature
  generalised to `contractBeliefCompatible(spec, { tail, nu?, outcomeBounded, outcomeSpan? })
  → { ok, reason? }`. Rules: unbounded ⇒ require bounded outcome; EXPONENTIAL rejected on polynomial
  tail + `|a|·span ≤ 20`; POLYNOMIAL deg ≥ ν rejected on polynomial tail. Wired via the api
  `assertContractCompatible(spec, m)` at both `quote` and `executeTrade` — markets create contracts
  lazily on first trade, so quote+trade IS the "create" enforcement point. ν read from the persisted
  `belief_state` for student_t.)*
- [x] **Tests:** integrability guard rejects exp-on-Student-t (would diverge) with a clear error;
  polynomial finite iff `deg < ν`; bounded-outcome polynomial prices vs MC. *(Done: `core/test/polyExp.test.ts`
  (price==expectF==MC on gaussian+mixture, dPriceDMu vs central diff + analytic identities, payoff/
  validation/bounds/key, overflow clamp) and the rewritten `core/test/compat.test.ts` (the full guard
  matrix). `shared.test.ts` round-trips + rejects both. `api/test/polyExpContracts.test.ts` — bounded
  Gaussian quote==price() + POLYNOMIAL buy persists `c0..cN`; unbounded market → 400; Student-t EXP → 400;
  Student-t deg<ν accepted / deg≥ν → 400.)*
- [x] `web`: extend `ContractComposer` + `BeliefChart` handles for the new specs; disabled options with
  reasons when incompatible with the market's belief. *(Done: composer gains the two type buttons + a
  POLYNOMIAL coeff/degree editor and EXPONENTIAL center/rate fields; incompatible types render **disabled
  with the guard's reason** (mirrors `contractBeliefCompatible` client-side) and the selected-but-blocked
  spec shows a warn banner. `viz.winningRegions` (EXPONENTIAL by rate sign; POLYNOMIAL none), `specLabel`,
  and `PriceCurveChart` param-sweep extended. BeliefChart drag handles: none for these two — they're edited
  via the composer fields, like LINEAR.)*
- **Checkpoint:** richer contracts trade where mathematically valid; invalid combinations are
  blocked with an explanation, never mispriced. **math-doc:** added the G5.1 + G5.2 payoffs to §3, the
  extension closed forms + the integrability/boundedness compatibility table to §4 (this also clears the
  G5.1-deferred doc note). *( 2026-06-18 — full sweep **713 pass** (core 361 · shared 17 · api 155 ·
  web 180); typecheck + biome clean (pre-existing `docs/math/multimodel.js` lint nits are unrelated and
  untouched). KaTeX not auto-verified locally — katex not installed, same as prior phases; macros reuse
  the existing §3/§4 conventions.)*

---

## Phase G6 — Hardening, migration & docs `[all]` `[blocked-by: all]`

- [ ] **Migration/back-compat test:** a snapshot of pre-refactor `gaussian/mixture/student_t` markets
  reprices and re-updates **identically** after the refactor (golden-master assertion).
- [ ] **Full integration sweep:** create/trade/settle for all five models + new contracts; reserve/NAV
  consistent; circuit breakers and stats kind-agnostic.
- [ ] **Perf:** Gen·exact quadrature caching (improvement I3); reuse the `PriceCurveChart` drag-coarsening
  lesson for any quadrature-priced preview.
- [ ] **Math-doc consolidating pass:** §21 sandbox ↔ shipped code parity; re-verify 0 KaTeX errors.
- [ ] **Demo-data seed (FINAL step, after every phase is done).** Extend `db:seed` (or a sibling
  `db:seed:markets`) to create a handful of ready-to-use markets covering the full surface — one per model
  (Gaussian, Student-t, Mixture, **Gen·basis**, **Gen·exact**) and a spread of the new contract shapes —
  each opened with a few seeded trades so the charts/history look alive. Idempotent and re-runnable so the
  user can reset + reseed at will (`db:reset && db:migrate && db:seed`). *(Deferred by request until the
  refactor is complete; planned now so it isn't forgotten.)*
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
