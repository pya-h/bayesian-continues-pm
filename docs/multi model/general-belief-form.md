# A single general belief form — one model for every shape

Companion to [`README.md`](./README.md) and [`parametric-belief-families.md`](./parametric-belief-families.md).

## The creator's dilemma

A market creator **cannot know** how traders will predict — whether the crowd will land on
one consensus, split into camps, fear a fat-tailed surprise, or pile against a hard bound.
Forcing them to pick `gaussian` / `mixture` / `student_t` / `beta` up front is a guess that may
be wrong for the life of the market. The ideal is a **single "general" belief** that supports
(almost) any shape, with **as many parameters as the data demands** — even 10 — so the creator
picks "general" and the order flow sculpts the curve.

**Does such a form exist in a parametric Bayesian market? Yes — two of them.** One is the
practical engineering answer; the other is the principled "moments dial."

---

## Route A — Adaptive Gaussian mixture / fixed-basis (the one to ship)

A finite **Gaussian mixture** `p(θ)=Σ πₖ·𝒩(θ; μₖ, σₖ²)` is a *universal approximator*: finite
mixtures of Gaussians are **dense in the space of probability distributions** — given enough
components you can approximate *any* density to any accuracy. So the mixture is not "one of the
models"; it is **the general model**, and every other family is a special case of it:

| Target shape | How the mixture expresses it |
|---|---|
| Gaussian | one component |
| Skew | two unequal-weight components, offset |
| Sharp spike / cusp | a few narrow components |
| Flat-top | several equal components side by side |
| **Fat tails (Student-t)** | a *scale mixture* of Gaussians — a t **is** an infinite continuous mixture of normals; a few wide components approximate it |
| Multi-modal (K camps) | K separated components |
| Bounded | components confined to `[min, max]`, ~zero weight outside |

Two flavours, both parametric, both closed-form priced:

- **Fixed-basis** — bumps on a *fixed grid*, only the **weights** vary. Simplest; the weights
  *are* the picture; a "click near θ" raises nearby weights. `N` parameters, fixed.
- **Free / adaptive mixture** — components *move*, and **component management** (prune / merge /
  split) **grows the parameter count when the crowd disagrees and shrinks it when they agree.**
  This is the key: the creator never picks a shape or a `K`; complexity is **data-driven**.

**Why it's the engineering answer**

- **Pricing stays closed-form**: `price = Σ πₖ · (closed-form price of component k)`. No quadrature,
  no per-frame lag, and — being a finite `Σ` of `Φ` — the **most on-chain-feasible** flexible form.
- **Update is already shipped**: the V2 `bayesUpdateMixture` (responsibilities + per-component
  conjugate step) + `manageMixture`. Turn **`split` on** and raise the caps and it becomes a true
  general belief that spawns modes on disagreement.
- **Reserve / stats unchanged**: MC `sample()`, mean/variance via the law of total variance.
- **Persistence unchanged**: the component list already serialises to `belief_state` jsonb.

So "the general mode" is **mostly buildable from what we already ship** — an *adaptive mixture
belief kind* (`general`) = mixture + split enabled + relaxed caps + a placement-friendly update.

---

## Route B — Max-entropy / moment-expansion exponential family (the "moments dial")

The literal "*N parameters describe the belief*" idea. Take an exponential family whose exponent
is a **polynomial**:

```
p(θ) ∝ exp( −[ λ₂·u²/2 + λ₃·u³ + λ₄·u⁴ + … ] ),   u = (θ − μ)/σ
```

Each added term is **one more shape knob**, and it is exactly a *maximum-entropy* density
subject to matching that many moments — the least-committal shape consistent with what the
trades have revealed:

| Terms kept | Shape unlocked |
|---|---|
| λ₂ | Gaussian |
| + λ₃ | **skew** |
| + λ₄ (λ₄>0) | **fat tails / flat-top** |
| + λ₄ with **λ₂<0** | **double-well → bimodal** |
| + λ₅, λ₆, … | more asymmetry, more modes |

One formula, a continuum of shapes, dialled purely by how many polynomial terms (parameters)
you keep — precisely the "even 10 parameters" belief the creator wants, with **no model choice**.

**Why it's the principled-but-heavier answer**

- **Always a valid density** (unlike a Gram–Charlier/Edgeworth correction, which can go negative);
  max-entropy guarantees non-negativity.
- **No closed-form price** — the normaliser and every expectation need **numerical integration**
  (quadrature). That's the per-frame-quadrature cost we already met with Student-t.
- **Updates are harder** — no conjugacy; you do **moment-projection** (assumed-density filtering):
  apply the trade's evidence, then re-fit the λ's to the new moments.
- **On-chain: effectively infeasible** — deterministic numerical normalisation + special functions
  in fixed point is a very large surface. This form is an **off-chain** tool.

---

## A vs B — which "general" to use

| | A. Adaptive mixture / basis | B. Max-ent polynomial |
|---|---|---|
| Coverage | universal approximator | universal (more moments) |
| Parameter growth | data-driven (split/merge) | you choose the order M |
| Pricing | **closed-form Σ (fast)** | quadrature |
| Update | shipped (responsibility + manage) | moment-projection (new) |
| On-chain | **feasible (Σ Φ)** | infeasible |
| Interaction fit | **excellent** (weights ↔ clicks) | indirect (moments) |
| Verdict | **ship this as the `general` kind** | keep as an analytical / explanatory model |

The two are complementary: the **mixture** is what you run; the **max-ent** is the cleanest way to
*think about* "how many shape degrees of freedom does this belief have," and it's the more vivid
demo of "one formula, many shapes" (it's the **General ** option in the sandbox, §19).

---

## How the general form lives in our Bayesian market

1. **Representation** — a `general` belief kind backed by an adaptive Gaussian mixture (components
   = the parameters; `K` floats with the data).
2. **Pricing** — `Σ πₖ · closed-form`, exactly as the shipped mixture; nothing new.
3. **Update** — `bayesUpdateMixture` + `manageMixture` with **split enabled**: a stream of bets at
   a new location *grows a mode* there instead of being averaged away; quiet regions *merge* back
   toward consensus. Complexity self-regulates.
4. **Interaction** — the missing half (see `parametric-belief-families.md` §4): trades must be able
   to excite new modes. Options: enable split, lean on the **bell contract** (it already bets "a
   bump at c"), or add a thin **placement primitive** mapping a click to a local weight bump.
5. **Reserve / solvency** — unchanged: MC α-quantile from `sample()`.
6. **Persistence / stats / breakers** — unchanged: serialise components; mean/variance as today.

## Effects

- **One market kind covers the whole life-cycle:** opens as a single bump (consensus prior),
  grows two camps when the crowd splits, widens a tail when uncertainty spikes, collapses back to
  one mode when consensus returns — *without the creator choosing anything*.
- **Pricing stays exact and fast** (closed-form), so the interactive charts don't lag and on-chain
  settlement stays realistic.
- **Risk is still well-defined:** the reserve MC and NAV read the general belief like any other.
- **The honest limits:** a mixture needs more components for truly sharp cusps; the max-ent form
  pays quadrature cost and can't go on-chain; and *neither* reshapes unless the **interaction** can
  excite its degrees of freedom. Flexibility of the *form* and richness of the *input* are two
  halves of the same lever — a general belief is only as expressive as the trades allowed to sculpt it.

## Verdict

**Yes — a single general parametric belief is achievable, and it's a Gaussian mixture.** Ship an
**adaptive-mixture `general` kind** (universal, closed-form, on-chain-feasible, self-adapting its
parameter count); keep the **max-entropy polynomial** as the analytical "moments dial" that makes
the flexibility legible. The creator picks *general*; the order flow does the rest.
