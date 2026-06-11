# Contract-shape extensions — what's compatible with a continuous market

Companion to [`TASKS.md`](./TASKS.md) (Phase G5). The user's goal: support **wider user-trade
curves** — asymmetric Gaussians, polynomials, exponentials, and friends. This doc works out which
are compatible with our continuous, belief-priced market, and **why** the incompatible ones are.

## What "compatible" means here

A contract is a payoff function `f(θ)` of the outcome `θ`. The engine needs four things to hold:

1. **Priceable** — `Fair = E_belief[f(θ)] = ∫ f(θ)·p(θ) dθ` must be **finite**. Quadrature
   (`expectF`) prices *any* `f` that's integrable against the belief; a closed form is a bonus.
2. **Bounded liability (reserve)** — the MM reserves the α-quantile of `Σ mmShort·f(θ)`. If `f` is
   **unbounded**, liability is unbounded and the reserve/solvency gate can't bound risk.
3. **A sensible direction** — `∂Price/∂μ` and `extractSignal` need a well-defined "which way is a buy
   betting." Smooth or piecewise-monotone payoffs are fine; pathological ones aren't.
4. **Renderable** — `payoffKinks(spec)` for crisp chart corners; a `winningRegion` for shading.

The decisive constraints are **(1) integrability** (belief-dependent!) and **(2) boundedness**.

## The integrability subtlety — it depends on the belief's tails

`∫ f(θ)·p(θ) dθ` finite is a race between how fast `f` grows and how fast `p` decays:

| Belief tail | `p(θ)` decays like | Safe `f(θ)` growth |
|---|---|---|
| Gaussian / **Gen·basis** / **Gen·exact** | `e^{-θ²}` (or thinner) | **anything sub-`e^{θ²}`** — polynomials *and* exponentials integrate fine |
| Student-t (ν) | `θ^{-(ν+1)}` (polynomial) | only `f` whose growth has finite `E` — i.e. `E[\|θ\|^n]<∞ ⇔ n<ν` |

**Consequences:**
- Under **Gaussian-tailed beliefs (our two generals)**, exponential `e^{aθ}` has a finite price
  (the Gaussian MGF: `E[e^{aθ}] = e^{aμ + a²σ²/2}`), and every polynomial moment is closed-form.
- Under **Student-t**, an **exponential contract has infinite price** (`e^{aθ}` outruns polynomial
  decay), and a degree-`n` polynomial is finite **only if `n < ν`** (the t has finite moments of order
  below ν). So these contracts must be
  **disallowed on Student-t markets** — a hard, kind-dependent validation rule.

This is a real, precise compatibility matrix the refactor must enforce, not a nicety.

## The candidates

### Fully compatible — bounded, closed-form under Gaussian/mixture (best first additions)
- **Asymmetric (skew) Gaussian bell** — `exp(−(θ−c)²/2σ_L²)` for `θ<c`, `exp(−(θ−c)²/2σ_R²)` for
  `θ≥c`. Bounded in `[0,1]`. Closed-form under a Gaussian belief: each side is a half-Gaussian×Gaussian
  integral → a difference of `Φ`'s and one `exp` term (same machinery as the existing `GAUSSIAN`
  bell, evaluated per side). Two width handles. **The headline new contract.**
- **Sigmoid / logistic step** — `1/(1+e^{−k(θ−c)})`, a *smoothed* binary. Bounded `[0,1]`, monotone,
  great "is it above c, softly" bet. No Gaussian closed form → quadrature (cheap, bounded).
- **Tent / triangle** — piecewise-linear bump, peak at `c`, zero outside `[c−w, c+w]`. Bounded;
  **closed-form** under Gaussian (it's a sum of `CALL`-like ramps → `Φ`/`φ` terms). Kinks at the corners.
- **Trapezoid** — flat-topped tent (a "range with soft edges"); same closed-form family.
- **Double-bell / multi-bump** — sum of two skew-bells; pairs naturally with multi-modal beliefs.

### Conditionally compatible — unbounded; bounded-outcome or capped only
- **Polynomial** `f(θ)=Σ aₖθᵏ` (e.g. quadratic `(θ−c)²`) — **closed-form under Gaussian/mixture**
  (Gaussian moments are closed-form), but **unbounded** ⇒ unbounded liability. Allow **only** when the
  market has `outcomeMin/Max` set (bounded support caps the payoff), or with an explicit payoff cap.
  **Disallow on Student-t** unless `degree < ν−1`.
- **Exponential** `f(θ)=e^{aθ}` — **closed-form under Gaussian** (MGF), but **unbounded** and tail-heavy
  ⇒ severe liability. Allow only bounded-outcome / small-`a` / capped, and **never on Student-t**
  (infinite price).

### Incompatible (and why)
- **Anything non-integrable against the chosen belief** — e.g. exponential on a Student-t market
  (price diverges). Not a code limit; a *mathematical* one. Enforced by validation.
- **Discontinuous-everywhere / non-measurable payoffs** — no meaningful expectation. (Not requested;
  noted for completeness.)
- **Payoffs that aren't a function of `θ` alone** (path-dependent, time-dependent) — the market prices
  a single terminal outcome `θ`; anything needing a path is outside this market type.

## Why this is *possible* at all

Our market never needed per-outcome bins to support rich payoffs: pricing is `E_belief[f]`, so the
**belief carries the shape and the contract carries the bet** — they compose by integration. Adding a
contract is "add a `payoff` (+ kinks, + a closed form where one exists)"; the belief side is untouched.
That orthogonality is exactly why bounded smooth contracts drop in cleanly.

## Recommendation (feeds Phase G5)

1. Ship the **bounded, closed-form** set first — **skew-bell**, **tent**, **trapezoid**, **sigmoid** —
   maximum expressive gain, zero risk-model change (all bounded).
2. Add **polynomial/exponential** as **bounded-outcome-only** contracts with a **kind-compatibility
   guard** (`f`×belief integrability table above), surfaced as a validation error on creation/trade.
3. Every contract ships with tests: closed-form price vs `expectF` vs Monte-Carlo; kinks exact;
   boundedness/integrability guard; `∂Price/∂μ` finite-difference check; chart render.
