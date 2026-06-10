# How a trade becomes a signal — "function in, scalar out"

> Conceptual companion to `belief-and-exposure.md`. Settles a natural objection:
> *the trade UI lets the user set a whole payoff **function** (a Call at K, a Spread
> [lo,hi], a Bell at c) — so how is the belief update driven by a single **scalar**?*
>
> Short answer: the function the user picks is the **bet**, not their belief. The
> market **infers** a scalar belief-signal from the *act* of placing that bet. Two
> different objects, two different destinations.

---

## 1. The user actually sets two things

In the composer (`apps/web/src/components/ContractComposer.tsx`) plus the trade
ticket, a trade is:

1. **A payoff function `f_C(θ)`** — contract type + parameters (Call with strike `K`,
   Spread `[lo, hi]`, Bell at `c`, …). This is the "desired function."
2. **A direction + size** — buy / sell and quantity `q`.

Neither of these is a probability distribution. `f_C` is the **shape of the bet** —
what the holder is *paid* at each outcome θ. It is a financial instrument.

---

## 2. The function is the bet; the scalar is an inference about belief

`f_C` does **not** enter the belief as a curve. It enters the **exposure book**
`L(θ) = Σ mmShort·f_C(θ)` exactly (see `belief-and-exposure.md §2`).

The **scalar signal `s`** is something the market *infers* from the *act* of trading
that instrument — implemented in `extractSignal` (`packages/core/src/signal.ts`). The
reasoning is revealed-preference:

> *A rational trader who **buys** a Call struck at `K` with size `q` is revealing they
> think θ is probably **above** `K`.*

So the inferred signal is placed above `K`, further out the larger the size; **selling**
flips the inference the other way (`pointBet`: buy pulls toward the bet's target, sell
pushes away). The trade also yields a **weight** `w` — the reliability of that inference,
scaling with size (tiny trades are mostly noise).

| User picks | What it is | Where it goes |
|---|---|---|
| `f_C(θ)` — the "function" | the bet's **payoff shape** (an action) | into `L(θ)`, exactly |
| `s` — a scalar | the market's **inferred belief**, reverse-engineered from the action | into `p(θ)` via `bayesUpdate` |
| `w` — a scalar | reliability/precision of that inference | weights the Bayes update |

### Real-market analogy

You never hand an exchange your probability distribution. You place an **order** ("buy
100 calls"). The market maker *infers* from the order that you are bullish and moves its
price. Here it is identical: the **contract + size is the observable action**; the
**scalar `s` is the maker's inference** of the trader's private belief from that action.

---

## 3. Why collapse a function to one scalar?

Because V1's belief is a single Gaussian, and the Normal–Normal conjugate update
(`bayes.ts`) consumes a **point-estimate signal** `s` with precision `1/σ_ε²`. So each
contract is summarised to a single location:

- Call / Binary-call → a point above the strike
- Put / Binary-put → a point below the strike
- Spread `[lo, hi]` → its **midpoint**
- Bell at `c` → its **center** `c`
- Linear → `μ ± β·σ·intensity` in the trade's direction

This is a deliberate **modeling simplification**: it throws away the *width/shape* of the
bet and keeps only "where, and how strongly."

---

## 4. Forward pointer — function-shaped signals (pairs with V2-1 mixtures)

The objection has real merit: a Spread bet genuinely carries more than a point — it
asserts *"θ somewhere in `[lo, hi]`,"* and a Bell asserts *"θ concentrated near `c` with
width `w`."* A richer update could treat the contract as a **likelihood function over θ**
instead of collapsing it to a scalar:

```
posterior(θ)  ∝  prior(θ) · likelihood_from_trade(θ)
```

where `likelihood_from_trade` is shaped by `f_C` (a box-ish bump over `[lo, hi]` for a
spread, a Gaussian bump at `c` for a bell, a half-line tilt for a call). Under V1's
single Gaussian this buys little (you would moment-match back to a point anyway). But it
becomes genuinely powerful with **V2-1 multi-modal beliefs**: a region/bell bet could
then **grow or seed a mixture component** in that region rather than merely nudge one
mean — so the belief would reflect the *shape* of each bet, not just its location.

This is an **optional** extension of the signal model, not required by V2-1, but it is
the elegant pairing to keep on the table when V2-1 is implemented.

---

## 5. Pointers

- Signal extraction: `packages/core/src/signal.ts` (`extractSignal`, `pointBet`)
- Belief update: `packages/core/src/bayes.ts` (`bayesUpdate`)
- Exposure book: `packages/core/src/solvency.ts` (`liability`)
- Composer UI: `apps/web/src/components/ContractComposer.tsx`
- Related concept: `docs/v2/belief-and-exposure.md`, `docs/MODEL.md §5.2` (signal model)
