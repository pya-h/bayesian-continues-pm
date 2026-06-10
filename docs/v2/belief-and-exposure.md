# Belief vs. Exposure — what the "consensus graph" really is

> Conceptual companion to `TDD.md` / `TASKS.md`. Written while scoping V2-1
> (multi-modal beliefs) to settle a recurring question: *is the market's curve the
> sum of everything traders did, and does multi-modal belief "fix" V1?*
>
> Short answer: there are **two** curves in the system. One already is the exact
> aggregate of all positions; the other is a Bayesian posterior. V1's limitation is
> only about the second one, and that is exactly what V2-1 lifts.

---

## 1. There are two curves, not one

A persistent source of confusion is treating "the market's graph" as a single
object. It is two distinct things:

| | **Belief / consensus PDF `p(θ)`** | **MM exposure / liability `L(θ)`** |
|---|---|---|
| What it is | the market's probability distribution over the outcome θ | the aggregate payout surface across every open contract |
| Definition | a **Bayesian posterior**, updated trade-by-trade | `L(θ) = Σ_C mmShort[C] · f_C(θ)` — a **literal sum** |
| Code | `GaussianBelief` (`core/gaussian.ts`), updated by `bayesUpdate` (`core/bayes.ts`) | `liability()` in `core/solvency.ts` |
| Shape in V1 | a single Gaussian bump | already arbitrary / lumpy |
| Shape in V2 | mixture / Student-t (multi-modal) | unchanged |
| Reversible by selling? | **No** — path-dependent | **Yes** — exactly |

The intuition *"the consensus is the sum of all the effects each trader makes — it
can be Gaussian, another parametric shape, or a strange non-standard function"*
describes **`L(θ)`**, not `p(θ)`.

---

## 2. `L(θ)` — the exposure book — already is the aggregate (and is exact in V1)

`L(θ)` is the literal mathematical sum of every position times its payoff function.
If Alice buys a CALL, Bob buys a GAUSSIAN bump at $60k, and Carol shorts a SPREAD,
then `L(θ) = f_call + f_gauss − f_spread` — an arbitrary, multi-cornered shape.
**This was already true in V1.**

It is also fully reversible: a **sell** decreases that contract's `mmShort` by exactly
the amount sold (`withMmShort` in `core/solvency.ts`), so the sum un-adds cleanly.
`L(θ)` is an accounting ledger; buys and sells are `+` and `−` on it, and the current
net positions fully determine it (path-independent).

So if the goal is to *see* "the total of everyone's bets" as a curve, that object
already exists and is faithful — it is the risk book, not the belief.

---

## 3. `p(θ)` — the belief — is a posterior, not a sum

The key correction: **traders never submit a curve.** A trade is reduced to a single
scalar **signal** `s` (a point estimate of where that trader believes θ sits) plus a
reliability **weight** `w` — see `extractSignal` in `core/signal.ts`. The market then
**conditions** its belief on that scalar via Bayes (`bayesUpdate`).

So `p(θ)` is not `signal₁ + signal₂ + …`. It is the prior, repeatedly updated:

```
p_now  =  prior  ∘ update(s₁,w₁)  ∘ update(s₂,w₂)  ∘ … ∘ update(sₙ,wₙ)
```

In V1 the prior is Gaussian and each signal-likelihood is Gaussian, so by
**Normal–Normal conjugacy** the posterior is *always* Gaussian — every update can only
**slide μ and shrink σ²**. That is the V1 limitation: the consensus can only ever be
one symmetric bump. It physically cannot express *"the market is split — half expect
$60k, half expect $80k."*

### "Sum of effects" — the accurate version

The refined intuition — *"the current state is constructed by the cumulative changes
all traders made"* — **is correct, and is already true in V1.** The belief state at any
moment is precisely the composition of every trader's update onto the prior (the
chain above). The graph you see *is* built from everyone's actions.

Two refinements on the word "sum":

1. It is a **composition**, not a linear superposition. Order matters, opposing trades
   partially cancel, and precision (`1/σ²`) only ever grows. The state carries the
   imprint of all actions, but the actions do **not** add up independently.
2. Because of (1), the belief is **path-dependent**: a **sell** emits an
   opposite-direction signal (`pointBet`: buy pulls toward the target, sell pushes
   away) that nudges belief back but does **not** restore the prior — variance never
   un-shrinks, and the mixture updates are nonlinear. Buy-then-sell does **not** return
   `p(θ)` to where it started. This is deliberate: the belief is a *memory of what the
   order flow revealed*, not a reversible function of current inventory. Contrast
   `L(θ)`, where a sell is an exact reversal.

---

## 4. What V1 actually loses — and what V2-1 fixes

V1 does **not** ignore anyone's effect. The limitation is that the Gaussian family has
only **two knobs (μ, σ²)** to record all of them. Every trader's effect, however rich,
is compressed into "shift the one bump / narrow the one bump."

The damage shows up under **disagreement**. A bullish cluster pushing toward $80k and a
bearish cluster pushing toward $60k carry the information *"two camps."* But V1 must end
every update back on a single Gaussian, so it **averages them into one bump at ~$70k** —
a price *nobody* holds. The two effects are not retained side-by-side; they are squashed
and partially cancelled into a mushy middle. Formally, **each V1 update is a lossy
projection back onto one Gaussian**, and multi-modal structure is destroyed at every
step.

**V2-1 (multi-modal beliefs)** gives the accumulator the capacity to keep that shape.
With a mixture, the bullish cluster grows one component's weight/mean and the bearish
cluster grows another, so **both effects persist simultaneously as two visible modes**
instead of collapsing into one. Because mixtures of Gaussians are *universal density
approximators*, `p(θ)` can then approximate essentially any shape the order flow
implies — including the "strange non-standard function" intuition.

### The honest caveat

V2's belief is **not** a lossless transcript of every trade either. To stay tractable
the mixture is **bounded**: `mixture_ops.ts` will **prune** negligible components and
**merge** near-duplicates (moment-matching). That deliberately discards fine structure.
So the V2 belief is best described as *"as much of the accumulated effect of all actions
as a K-component mixture can hold"* — vastly richer than V1's single bump, but still a
compressed, parametric memory.

---

## 5. One-paragraph summary

V1 already accumulates every trader's effect into the consensus — it just forces that
accumulation into a single Gaussian, so genuine disagreement averages away into a price
nobody believes. V2-1 lets the same Bayesian accumulator hold a multi-modal shape, so
the consensus can finally *show* the multi-peaked structure the order flow implies. What
this does **not** change is the mechanism: the belief stays a posterior conditioned on
scalar signals, never a literal pile of user-submitted curves. The object that *is* the
exact sum of everyone's positions — and that a sell exactly reverses — is the exposure
book `L(θ)`, and it has been faithful since V1. If we ever want to surface "the total of
all bets" as a curve in the UI, `L(θ)` (or its mirror, the MM's net position profile) is
the honest thing to plot.

---

## 6. Pointers

- Belief model & update: `packages/core/src/gaussian.ts`, `bayes.ts`, `signal.ts`
- Exposure & reserve: `packages/core/src/solvency.ts` (`liability`, `withMmShort`)
- V2 multi-modal plan: `docs/v2/TDD.md §2`, `docs/v2/TASKS.md` Phase V2-1
- Spec: `docs/MODEL.md §2.3` (belief families), `§5` (Bayesian update), `§6` (reserve)
