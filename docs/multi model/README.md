# Multi-model beliefs — flexible parametric shapes (design study)

> Status: **exploration / design**, not shipped. Captures the options for making the
> belief curve more expressive **without leaving the parametric, contract-composition,
> Bayesian-update structure** of the current engine (i.e. *not* going bin-based / LMSR).

## The question

V2 ships three belief kinds — **Gaussian**, **Gaussian mixture**, **Student-t**. A user
asked: other markets let traders *paint* almost any curve by clicking to place
predictions (a non-parametric, per-bucket market). Can we get that flexibility while
keeping our structure? And if we add **new parametric families**, what are the choices
and their costs?

## The one-line answer

In a parametric world, **flexibility = how many shape degrees of freedom (DOF) the family
has, and whether trades can excite them.** There is a continuous spectrum between
"Gaussian (2 DOF)" and "bins (∞ DOF)", and you choose where to sit. You do **not** have to
go bin-based to get expressive curves.

```
Gaussian(2) → skew/peaked(3) → skew-t / gen-hyperbolic(4) → mixture(3K) →
fixed-basis density(N weights) → … → bins(∞)
   less flexible, cheaper, more on-chain-friendly  ←→  more flexible, costlier
```

## The verdict

- **Sweet spot for "this structure, but flexible":** a **fixed-basis Gaussian density** —
  a grid of narrow Gaussian bumps at fixed centers with learnable **weights**. Near-arbitrary
  smooth shapes, **closed-form pricing** (so no quadrature lag, and the most on-chain-feasible
  flexible option), and a trivial **weight-only** update that maps naturally onto a
  "click near θ → raise nearby weights" interaction.
- **Narrower needs:** *skew-normal / skew-t* for asymmetry, *generalized-normal* for a
  sharp-spike-↔-flat-top peakedness knob, *Beta* for **bounded** outcomes (%, ranges).
- **The half nobody mentions:** a flexible family is inert unless the **interaction** can
  excite its DOF. Today a trade collapses to one scalar signal, which can only slide/reweight.
  To let users *sculpt*, enable mixture **component split/spawn**, richer contract→belief
  mappings (the bell contract already bets "a bump at c"), or a thin placement primitive.

## Can one general form cover them all?

**Yes.** A market creator can't know which shape the crowd will pick, so the ideal is a single
**"general" belief** that supports (almost) any shape with as many parameters as the data demands.
Two such forms exist — and [`general-belief-form.md`](./general-belief-form.md) covers both:

- **Adaptive Gaussian mixture / fixed-basis** — a *universal approximator* (every other family is
  a special case), closed-form priced, on-chain-feasible, and **self-adapting its parameter count**
  via split/merge. The one to ship: the creator picks `general`, the order flow sculpts the shape.
- **Max-entropy / moment-expansion** `p(θ)∝exp(−Σλₖuᵏ)` — the principled "N params = N shape terms"
  dial (skew → fat tails → bimodal as you add terms); always valid, but quadrature-priced and
  off-chain only. The vivid "one formula, many shapes" demo (**General ** in the sandbox).

## Files

- [`parametric-belief-families.md`](./parametric-belief-families.md) — the full study: each
  family, what shapes it makes, how it fits our `BeliefModel` interface (pdf/cdf/mean/var/sample +
  pricing + update + solvency), and **off-chain vs on-chain** implementation difficulty.
- [`general-belief-form.md`](./general-belief-form.md) — the **single general form**: the adaptive
  mixture (ship this) vs the max-entropy moments dial, how each works, and their effects.
- Interactive companion: the math doc's **§19 "Flexible parametric beliefs (design study)"**
  ([`docs/math/index.html`](../math/index.html)) — a live sandbox to morph each family and
  read its flexibility-vs-difficulty scorecard.
