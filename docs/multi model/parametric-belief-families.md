# Parametric belief families — choices, effects, and implementation cost

Companion to [`README.md`](./README.md). This is the detailed menu of parametric belief
families we could add to make the curve more expressive while staying inside the current
engine's structure (continuous θ, contract-composition, Bayesian-from-inferred-signal,
closed-form-or-quadrature pricing, MC reserve).

---

## 0. What "fits the engine" means

A new belief kind plugs in if it can supply the `BeliefModel` interface and an update:

| Need | Interface | Notes |
|---|---|---|
| Draw / price | `pdf(θ)` | Pricing of a contract = `E_belief[payoff]`. Closed form if available, else `expectF` (Simpson over ±L·σ) prices **any** pdf with finite variance. |
| Tails / quantiles | `cdf(θ)`, `quantile(p)` | For credible intervals, calibration. |
| Summary | `mean()`, `variance()`, `stddev()` | Drive spread, breakers, the ±σ band, the integration window. |
| Reserve | `sample(n, rng)` | MC α-quantile of liability. Any family with a sampler works. |
| Persist | `serialize()` | `markets.belief_state` is jsonb — arbitrary params already supported. |
| **Learn** | an **update rule** | The genuinely hard part (see §6). |

So the question is **which family**, not *whether* — every family below can be priced and
reserved. The differentiators are **shape power**, **pricing cost**, **update difficulty**,
and **on-chain feasibility**.

---

## 1. The candidates

### 1.1 Skew-normal / skew-t
`p(θ) = (2/ω)·φ(z)·Φ(α z)`, `z=(θ−ξ)/ω`. Adds a **skew** parameter α — the bump can lean
left or right. Skew-**t** adds fat tails on top (skew + kurtosis + location/scale, 4 DOF).
- **Shapes:** one asymmetric bump. Good when "up-moves and down-moves aren't symmetric."
- **Pricing:** no general closed form → **quadrature** (the integrand carries a Φ).
- **Update:** no conjugate → **moment-matched / assumed-density** projection (§6).
- **Effect on markets:** prices directional/tail contracts asymmetrically; a call and the
  mirror-image put no longer price off the same number.

### 1.2 Generalized normal (exponential-power)
`p(θ) ∝ exp(−(|θ−μ|/α)^β)`. The **β knob** controls peakedness: β=2 → Gaussian, β=1 →
Laplace (sharp spike), β→∞ → flat-top / near-uniform.
- **Shapes:** symmetric, but **sharp-spike ↔ flat-top** — the closest single-bump answer to
  the "spiky peak" look, with one extra parameter.
- **Pricing:** quadrature; normalization needs Γ(1/β).
- **Update:** moment-matched.
- **Effect:** concentrates/disperses mass near the mode without changing μ/σ — changes how
  confidently the market prices at-the-money vs wings.

### 1.3 Beta (rescaled to [min, max])
On a **bounded** outcome interval, the Beta family is hugely flexible: unimodal, U-shaped,
J-shaped, skewed, flat, peaked — all from two shape params (a, b).
- **Shapes:** the most expressive **two-parameter** family, *if* the outcome is bounded
  (percentages, ranges, probabilities — exactly when `outcomeMin/Max` are set).
- **Pricing:** contract expectations reduce to **incomplete-beta** evaluations (closed-ish).
- **Update:** **near-conjugate** for natural likelihoods — among the cleaner updates here.
- **Effect:** respects hard bounds (no mass leaks past min/max, unlike a clipped Gaussian).

### 1.4 Generalized-hyperbolic / NIG / variance-gamma
Four-parameter finance families covering **skew + kurtosis + semi-heavy tails** in one bump.
- **Shapes:** "everything at once" single bump.
- **Pricing:** characteristic-function based → quadrature / FFT.
- **Update:** moment-matched; heavier bookkeeping.
- **Effect:** the most general *single-mode* family; overkill unless you specifically need all
  of skew+kurtosis+tails simultaneously.

### 1.5 Mixture, less aggressively managed
We already ship the mixture, but `manageMixture` **caps K at 6 and merges nearby/​drops small
components** — it pulls toward consensus by design. Raising K, lowering `tauMerge`, and
**enabling `splitComponent`** turns it into a genuine multi-modal, multi-camp belief.
- **Shapes:** K distinct, persistent camps.
- **Pricing:** **closed-form** — `Σ πₖ · (closed-form price of component k)`. Fast.
- **Update:** the shipped responsibility + per-component conjugate step; *split* lets a stream
  of bets at a new location **grow** a mode instead of being averaged away.
- **Effect:** disagreement stays as separate bumps; order flow reweights the camps live.

### 1.6 Fixed-basis Gaussian density (recommended sweet spot)
Place N narrow Gaussian "basis" bumps at **fixed** centers across the axis; the free params
are just their **weights**: `p(θ) = Σ wₖ·N(θ; cₖ, σ²) / Σ wₖ`.
- **Shapes:** **near-arbitrary smooth** curves as the grid densifies — "soft bins," but
  continuous and differentiable. Universal approximation.
- **Pricing:** **closed-form** (`Σ wₖ · closed-formₖ`) — *no quadrature, no per-frame lag*, and
  **linear in the weights**, which is what makes it the most **on-chain-friendly** flexible option.
- **Update:** **weight-only** — the mixture's responsibility step *without* the per-component
  mean/variance drift. Simple and stable.
- **Interaction fit:** a "click near θ" maps directly to "raise the weights of nearby basis
  bumps" — the parametric way to get the *feel* of the paint-the-curve markets.
- **Cost:** it's a *smoothed* free-form curve at a chosen resolution (set by grid spacing and
  σ), not infinitely jagged. Usually exactly what you want.

---

## 2. Flexibility ↔ cost at a glance

| Family | Shape DOF | What it adds | Pricing | Update | Off-chain | On-chain |
|---|---|---|---|---|---|---|
| Gaussian | 2 | baseline bump | closed-form (Φ,φ) | conjugate (exact) | shipped | moderate — needs Φ approx |
| Skew-normal | 3 | asymmetry | quadrature | moment-match | low | hard — Φ inside ∫ |
| Generalized-normal | 3 | peak ↔ flat | quadrature + Γ | moment-match | low | hard — Γ, fractional powers |
| Student-t | 3 | fat tails | quadrature + Γ | variance-domain (shipped) | shipped | hard — Γ, pow |
| Beta (bounded) | 2–3 | U/J/skew/flat/peak | incomplete-β | near-conjugate | low–med | hard — incomplete-β |
| Gen-hyperbolic / NIG | 4 | skew+kurtosis+tails | quadrature/FFT | moment-match | med–high | very hard |
| Mixture (managed) | 3K | K camps | **closed-form Σ** | responsibility + manage (shipped) | shipped | moderate — K·Φ |
| **Fixed-basis** | N weights | **near-arbitrary smooth** | **closed-form Σ (fast)** | **weight-only** | low | **moderate — N·Φ, linear** |

Flexibility (subjective, 1–5): Gaussian 1 · skew/gen-normal/t 2 · Beta 3 · mixture 4 ·
fixed-basis 5.

---

## 3. Off-chain vs on-chain difficulty (why it matters)

**Off-chain** (our current TS engine, IEEE-754 floats): every family above is tractable.
The work is the **update rule** and a faithful pdf; special functions (Γ, erf/Φ, incomplete-β)
are library-level. Quadrature pricing is fine if cached/coarsened during interaction (we
already hit and fixed this for Student-t in `PriceCurveChart`).

**On-chain** (fixed-point, no floats, gas-metered, determinism-critical) is a different bar:

- **What's cheap:** addition, multiplication, and a *rational/polynomial approximation of Φ*
  in fixed point. So anything whose price is **`Σ wₖ · Φ(...)`** — Gaussian, **mixture**,
  **fixed-basis** — is feasible: bounded loops over components, each a Φ eval.
- **What's hard:** `Γ`, `lgamma`, the **incomplete beta**, fractional `pow`, and *numerical
  integration* (`expectF`) — all needed by skew-normal, generalized-normal, Student-t, Beta,
  and the generalized-hyperbolic families. Implementing these in deterministic fixed point is
  expensive in code, gas, and audit surface.
- **Determinism:** any quadrature or iterative special function must produce **bit-identical**
  results across nodes — much easier when the formula is a finite `Σ` of one well-approximated
  function (Φ) than a 4000-node Simpson sweep or a continued-fraction beta.

**Consequence:** if on-chain settlement/pricing is ever a goal, the families with **closed-form,
Φ-only** pricing — **fixed-basis** and **mixture** — are the *only* flexible options that stay
realistic. That is a strong, independent reason the fixed-basis density is the recommended path:
it is simultaneously the most flexible *and* among the most on-chain-feasible.

---

## 4. The interaction is half the problem

A flexible representation is **inert** unless trades can excite its degrees of freedom. Today:

`trade → extractSignal → (one scalar signal s + weight w) → parametric update`

A single scalar can only **slide or reweight**; it cannot grow a bump where a user is betting.
To let users actually *sculpt* the curve (the thing those screenshots do), pick one or more:

1. **Enable component split/spawn** (`splitComponent`, currently off) so repeated bets at a new
   location grow a mode there.
2. **Richer contract→belief mapping** — the **bell (GAUSSIAN) contract** already expresses "a
   bump at center c, width w"; with a fixed-basis or split-enabled belief, repeated bell bets
   carve distinct bumps.
3. **A thin placement primitive** — map a click/region to a localized **basis-weight** update.
   Still parametric, still closed-form priced, still MC-reserved — no bins.

Option 3 over a fixed-basis density is the cleanest route to the paint-the-curve UX **without**
abandoning the engine: the weights *are* the picture, a click nudges nearby weights, and pricing
stays `Σ wₖ·Φ`.

---

## 5. How each plugs into the engine (checklist per family)

| Concern | Closed-form families (Gaussian, mixture, fixed-basis) | Quadrature families (skew, gen-normal, t, beta, GH) |
|---|---|---|
| `pdf/cdf` | direct | direct (special functions) |
| pricing | `Σ` closed forms — fast, on-chain-able | `expectF` — cache/coarsen during drag |
| `dPrice/dμ` | per-component closed form | central difference |
| update | weight / responsibility / conjugate | moment-matched / ADF projection (§6) |
| reserve | `sample()` → MC | `sample()` → MC |
| persistence | weights / components jsonb | params jsonb |
| breakers/stats | mean/var as usual | mean/var as usual |

---

## 6. The update problem (the real work)

Pricing and reserve are nearly free to extend. The **update** is where each family earns its
keep, because our trades arrive as a noisy point-observation `(s, w)`, not as direct mass:

- **Conjugate** (exact, cheap): Gaussian (Normal-Normal), Beta with the right likelihood.
- **Decomposed** (shipped pattern): mixture = membership responsibilities + per-component
  conjugate; Student-t = the conjugate step done in the **variance domain** with ν fixed.
- **Moment-matched / assumed-density filtering (ADF)** (the general fallback): apply the exact
  Bayes step against the family-free posterior, then **project back onto the family by matching
  moments**. This lets *any* of skew-normal, generalized-normal, generalized-hyperbolic slot in.
  It is exactly the spirit of what we already do for the mixture and t.
- **Weight-only** (fixed-basis): no mean/variance drift — just re-weight the fixed basis by the
  signal's responsibility. The simplest update of all, and the most placement-UX-friendly.

---

## 7. Recommendation

1. If outcomes are **bounded** → add **Beta** (max expressiveness for 2 params; cleanest update).
2. If you want **near-arbitrary smooth shapes + the paint-the-curve feel + fast/on-chain-feasible
   pricing** → add a **fixed-basis Gaussian density** with a **weight-placement** interaction.
   This is the headline recommendation: most flexible, closed-form priced, Φ-only on-chain,
   trivial update.
3. If you only need **asymmetry or peakedness** on one bump → **skew-normal** or
   **generalized-normal** (cheap shape upgrades, quadrature pricing).
4. Keep **Gaussian / mixture / Student-t** as the staples; **enable mixture split** to make the
   existing mixture track genuine multi-camp sentiment.

The interactive scorecard in the math doc (§19) lets you feel each of these and read its
flexibility-vs-difficulty tradeoff live.
