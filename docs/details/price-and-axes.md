# Price, the belief graph, and the dual y-axis

Plain-language notes on three things people find surprising the first time they read
the market UI:

1. what **price** means in this system (it is *not* the same object as a Polymarket-style
   per-outcome share price),
2. **why the price curve is contract-specific** and not "synced" to the belief graph the
   way an AMM's prices are,
3. how the belief chart's **left/right y-axes** relate (shared zero, shared scaling).

---

## 1. What "price" means here

### The AMM mental model you're bringing in

In a discrete-outcome AMM (Polymarket, a YES/NO or A/B/C market) there is a **fixed list
of buckets**. Each bucket has a price between 0 and 1 that *is* its probability, and you
pay `price × shares` for a share that pays **$1 if that bucket wins**. "The price of an
outcome" is a well-defined single number per bucket.

### Why that doesn't directly transfer

This is a **continuous-outcome** market. The outcome θ is a *number on a line* — a GDP
figure, a final score, a temperature — not a short list of buckets. That breaks the
"price per outcome" idea in one specific way:

> There are infinitely many points on the line, and any **single exact point** carries
> essentially **zero probability**. So "buy one unit of outcome = 3.5" can't be priced —
> the honest answer is ≈ 0.

So instead of selling a share *per outcome*, the market sells **contracts** — payoff
rules over θ. A contract says *"here is what I pay you depending on where θ lands"*:

| Contract | Pays |
| --- | --- |
| **Binary ≥ K** | `$1` if the outcome is ≥ K, else `$0` |
| **Binary ≤ K** | `$1` if the outcome is ≤ K, else `$0` |
| **Call K** | `θ − K` when θ is above K (else 0) |
| **Linear** | `θ` itself |
| **Bell @ c** | most when θ lands near c, fading away from it |
| **Spread [a, b]** | `$1` if θ falls inside [a, b] |

And **price = the expected payoff** of that contract under the market's current belief
distribution `p(θ)`:

```
price(contract) = Σ over all θ of   payoff(θ) × probability(θ)        ( = ∫ f(θ)·p(θ) dθ )
```

This single definition is behind every "fair price" the UI shows. In code it is
`price(spec, belief)` in [`packages/core/src/pricing.ts`](../../packages/core/src/pricing.ts),
`E_p[f_C(θ)]`.

### It's not a different concept — it's a *generalization*

Take a **Binary ≥ θ** contract. Its expected payoff is

```
price = $1 · P(outcome ≥ θ)  +  $0 · P(outcome < θ)  =  P(outcome ≥ θ)
```

— a number between **0 and 1, which is exactly the classic AMM "price of that outcome."**
Buy 10 of them, you pay ≈ `price × 10` (plus spread), each pays $1 if it comes true.
**Identical to Polymarket.**

A binary is just *one* kind of contract. The engine looks different only because it also
prices Calls, Bells, Linears, etc., whose payoffs aren't a clean $1 — so their price comes
out in **outcome units** instead of 0–1. The quote panel reflects this: a Call/Linear
"fair" carries the outcome unit, while *binary/spread/bell fairs are unitless 0–1 prices*.

> **"Price" = expected payoff. Its units follow the contract's payoff units.** For a $1
> binary that's a 0–1 probability (the AMM sense); for a Call it's outcome-units; for
> Linear it's just `E[θ] = μ`.

### So how do I see "unit cost of an outcome" / what I'd pay?

Three places, all already in the UI:

1. **"Price of ≥ / ≤ θ" for every θ → the CDF chart.** `P(≥θ)` *is* the price of a $1
   binary at θ. The belief-chart hover card now also prints this directly as a unit price
   (e.g. `≥ θ · $1 if so → 62% · $0.62`).
2. **Price of any contract as you slide it → the Price overlay/panel.** Select a
   `Binary ≥` contract and turn Price on: the magenta curve becomes literally *"what it
   costs to buy the '≥ θ' outcome, for every θ"* — the AMM price curve. With a Call
   selected it instead shows the cost of a call struck at each θ.
3. **Exact cost for a specific size → the Quote panel.** Pick the contract, type a
   quantity, and it shows **"You pay" = exec price × qty** including the spread, plus max
   payout, win chance and breakeven.

---

## 2. Why the price curve is contract-specific, not "synced" to the belief graph

In an AMM the price curve and the probability are the *same object*: price(outcome) =
probability(outcome). They move together by definition.

Here they are **two different functions**:

- The **belief graph** is `p(θ)` — one fixed probability distribution for the whole
  market. There is exactly one of it, and every contract is priced against it.
- The **price curve** ("fair price vs strike") is `K ↦ price(contract_K)` — it asks *"as I
  slide this contract's strike/centre to K, what does THAT contract cost?"* This depends
  on **which contract you picked**:
  - a **Binary ≥ K** sweeps out `P(θ ≥ K)` — the CDF, monotone falling 1 → 0;
  - a **Call K** sweeps out `E[(θ−K)⁺]` — a different, convex curve;
  - a **Bell @ K** sweeps out roughly how much probability mass sits near K — a bump.

All three are priced against the *same* belief `p(θ)`, yet they are different curves,
because **price = expected payoff and the payoff differs per contract.** There is no single
"the price curve" to sync to the belief — there is one price curve **per contract shape**.

That's also why the price overlay shares the belief chart's **x-axis** (both live on the
outcome line θ) but rides its **own y-scale**: its height is a money/probability amount
specific to the chosen contract, not the belief's density.

The CDF is the one special case where the two *do* coincide: the price curve of a **$1
binary** is the CDF, which is a direct transform of the belief. That's the bridge back to
the AMM picture.

---

## 3. The belief chart's left and right y-axes

The chart shows two quantities on one outcome (θ) x-axis:

- **left axis** — the belief, as relative likelihood (peak = 1) or absolute density,
- **right axis** — the composed contract's **payoff** `f(θ)` (in outcome units).

These have **different units**, so equal *values* on the two axes are not meant to sit at
the same height. What *is* enforced (so the picture reads honestly) is:

- **A single shared zero.** Both axes put `0` on the same horizontal line — drawn dead
  centre — so neither curve looks "lifted" relative to the other.
- **One shared vertical scale.** Dragging the **left** gutter scales *both* axes' value
  ranges by the same factor, so their span ratio is preserved — every curve grows or
  shrinks together about the shared zero.
- **One shared vertical shift.** Dragging the **right** gutter slides *every* curve up or
  down together by the same pixels, without rescaling (shape preserved).
- The bottom gutter still zooms the x-axis; dragging inside the plot pans x; double-click
  resets.

The CDF and fair-price overlays obey the same shared scale/shift, so the whole plot moves
as one.

### Where two curves coincide: two-colour segments

Because zero is shared, the belief and payoff lines can now genuinely sit on top of each
other over a stretch. Rather than hide one behind the other, any stretch where the two
lines coincide (within a couple of pixels, sustained over a short run — a bare crossing
doesn't count) is drawn **dashed with complementary phase**: the shared line tiles
accent ↔ green, so you can see *both* curves are there. Where the lines are apart, each is
a normal solid stroke.

### "Same height for the same value" — when does it apply?

Only if the two axes ever shared a *unit*. In this chart they never do (likelihood vs
payoff; density mode changes the left unit but not into payoff units), so the rule reduces
to **aligned zeros + proportional scaling + shape-preserving shifts**, which is what the
implementation does. If a future view did put the same unit on both sides, the same shared
mapping would automatically place equal values at equal heights.
