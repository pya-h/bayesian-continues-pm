# Shorting & leverage — what V3 adds, and why a prediction market wants it

> Conceptual companion to `docs/v3/TDD.md` / `TASKS.md`, in the spirit of
> `docs/v2/belief-and-exposure.md`. It answers three questions a reader new to the
> V3 scope keeps asking: *what actually changes when we allow shorting and
> leverage? why does that one change drag in a whole liquidation + insurance
> subsystem? and what does it buy a prediction market that V1/V2 didn't already
> have?*
>
> Short answer: V1/V2 let you bet that an outcome **happens** by paying cash up
> front. V3 lets you bet that an outcome **won't** happen (shorting) and bet with
> **borrowed** size (leverage) — which means, for the first time, an account can
> owe more than it pre-funded. Everything else in V3 exists to make that safe.

---

## 1. The V1/V2 collateral model, in one line

In V1 and V2 a trade is **fully pre-funded**: to hold a contract you pay its premium
now, and the worst thing that can happen to you is the premium going to zero. You can
never owe the house money. That is why V1/V2 need **no** margin, **no** liquidation,
and only a **stub** insurance fund — there is structurally nothing to liquidate and
no shortfall to insure. The only solvency question in V1/V2 is about the **market
maker / LP pool** (can the pool back the book?), handled by the α-quantile reserve and
the capacity gate (`docs/capacity/`). The *trader* side is trivially solvent by
construction.

V3 keeps that pool-side model **exactly** and adds a *second*, independent solvency
question on the **trader** side.

---

## 2. Two new powers — and what each one really is

### 2.1 Shorting — betting an outcome *won't* happen

In V1/V2 you can only **buy** (go long) a contract, then later **sell what you hold**
to close. You cannot express *"I think this CALL is overpriced / this outcome won't
occur"* except by staying out. **Shorting** lets you sell a contract you don't own:
your position goes **negative**.

What a short *is*, mechanically:
- You **receive the premium now** (the MM pays you to take the other side).
- You **owe `f_C(θ*)`** at settlement — the contract's payoff at the realized outcome.
- A short of a CALL struck at `K` that finishes **OTM** (`θ* ≤ K`) owes 0 → you keep
  the whole premium. Finishing **ITM** → you pay the intrinsic value out of collateral.

So a short is the mirror of a long: a long **pays** premium to **receive** `f(θ*)`; a
short **receives** premium to **pay** `f(θ*)`. The MM's book sees this directly — a
short **lowers** `mmShort[C]` (the user has taken that slice of tail risk *off* the
MM), exactly as a long raises it. Shorting is therefore not a bolt-on; it is the
natural negative direction of the position the engine already tracks.

The catch: a long's downside is bounded (premium → 0). A short's downside is bounded
only by how large `f_C(θ*)` can get — for an unbounded payoff (linear, deep-ITM call)
that can **exceed the premium received**. The short can owe more than it was paid.
That is the first time in the system's life an account can go **negative**.

### 2.2 Leverage — betting with borrowed size

In V1/V2, holding `q` units of a contract costs `q ×` premium in cash, locked. **With
leverage**, you instead post only a **fraction** — the **margin** — and control the
full notional:

```
margin_required = Σ_C |position[C]| · margin_rate[C] · price[C]
```

`margin_rate ∈ (0,1]` is the fraction you must post; `1/margin_rate` is the max
leverage for that contract type. A `margin_rate` of 0.2 means 5× — \$200 of margin
controls \$1000 of exposure. **Riskier payoffs carry a higher rate** (less leverage):
a capped binary (worst case bounded) gets more leverage than an unbounded linear,
because the most you can lose per unit is smaller.

Leverage doesn't change *what* you bet on — it amplifies *how much* per dollar of
equity, in both directions. A 5× position gains and loses 5× as fast in equity terms.
Again: the account can lose more than the margin it posted.

---

## 3. Why one change forces a whole subsystem

The instant an account can owe more than it pre-funded, three new failure modes appear
that V1/V2 simply could not have:

| New possibility (V3 only) | Who is exposed | The machinery that answers it |
|---|---|---|
| A leveraged/short account's **equity falls below what it posted** | the protocol (it fronted the rest) | **maintenance margin** + **liquidation engine** |
| A move so fast that liquidation **can't close in time** ⇒ residual **negative equity** (*gap loss*) | the pool / other users | **insurance fund** draw, else socialized |
| A **short** owes more at settlement than its equity covers | the pool | **insurance fund** draw |

This is the answer to *"why is V3 so much bigger than just 'allow negative
positions'?"* — **borrowed exposure is only safe if you can force-close it before it
goes underwater, and absorb the residual when you can't.** Margin without liquidation
is a promise with no enforcement; liquidation without an insurance fund leaves gap loss
nowhere to go. The three are one mechanism:

```
margin  →  the buffer that says "this account has skin in the game"
liquidation  →  the enforcement that closes the account while the buffer still exists
insurance  →  the backstop for when the buffer was crossed faster than we could act
```

### 3.1 The maintenance buffer (why two margin levels)

V3 uses **initial margin** (the bar to *open*) and a lower **maintenance margin** (the
bar to *stay open*). The gap between them is the liquidation runway: an account that
drifts down hits maintenance — and gets liquidated — *before* its equity reaches zero,
so in the normal case the protocol loses nothing. **Health ratio** `H = equity /
maintenance` is the single number that summarizes it: `H ≥ 1` is safe, `H < 1` triggers
the margin call. Gap loss is precisely the case where a jump skips the runway.

---

## 4. The two solvency layers don't interfere

A frequent worry: *does trader margin change the MM reserve / capacity gate?* **No —
they are orthogonal and both always apply.**

| | **MM reserve** (V1, `docs/capacity/`) | **Account margin** (V3) |
|---|---|---|
| Question | can the **pool** back the net book `L(θ)`? | can **this trader** back its own positions? |
| Quantity | α-quantile of `L(θ) = Σ mmShort·f` | `Σ|pos|·margin_rate·price` per account |
| Gate | `cash ≥ margin·Reserve` (capacity gate) | `margin_required ≤ equity·leverage`, `free_margin ≥ 0` |
| Failure mode | pool can't pay winners → capacity gate freezes opens | account underwater → liquidation |
| Changed by V3? | **no** | **new** |

Every V3 trade must pass **both** gates; the fill is the smaller of the two feasible
sizes. A 1× account posts 100% margin, so its margin gate is a no-op and its behavior
collapses to exactly V1/V2 — which is why **leverage is opt-in and pre-V3 markets are
byte-identical**. Shorting interacts with the *reserve* gate only through `mmShort`
(it lowers it, often *freeing* capacity), never by weakening it.

---

## 5. What this buys a prediction market

Leverage and shorting aren't just "more features" — they fix real expressiveness and
quality gaps in the market itself:

1. **Two-sided price discovery.** Without shorting, a trader who thinks a contract is
   *overpriced* can only abstain — their information never reaches the price. Shorting
   lets disagreement push **down**, not just up. Prices stop being biased toward
   whatever the crowd is enthusiastic about; the consensus reflects the *no* camp as
   well as the *yes* camp. (This complements V2-1 multi-modal beliefs: shorting is how
   the bearish mode gets *expressed in price*, not just *represented in the PDF*.)

2. **Capital efficiency / deeper liquidity.** Leverage lets informed traders put more
   weight behind a view per dollar, so the same belief moves price more and the market
   converges to the true probability faster. Thin markets get effectively deeper order
   flow without requiring more cash on the platform.

3. **Hedging and spreads.** Shorting enables real strategies — sell the rich leg, buy
   the cheap leg; hedge an existing long; build calendar/region spreads. That attracts
   sophisticated flow, which is exactly the informative flow a prediction market wants.

4. **Sharper incentives to be right.** A leveraged position that's wrong gets
   **liquidated** — capital is reallocated away from bad predictions quickly and
   automatically, rather than lingering. The liquidation engine is, in effect, the
   market enforcing its own calibration.

### The honest cost / cons

Leverage cuts both ways, and the doc is explicit about the downsides the subsystem is
designed to contain:

- **Tail risk to the protocol.** Gap moves can liquidate many accounts at once
  (cascades) and outrun the maintenance buffer; the insurance fund is the deliberate,
  bounded answer, but a large enough jump can still force **socialized loss**.
- **Liquidation-driven volatility.** Forced closes are themselves trades that move the
  price, which can trigger *more* liquidations — partial liquidation (close only enough
  to restore the buffer) is the mitigation, but the feedback risk is real.
- **Complexity & UX risk.** Users can now lose more than they "spent." V3 leans hard on
  the **risk UX** (pre-trade liquidation preview, health bars, distance-to-liquidation)
  so the danger is visible *before* confirming — but it is genuinely higher-stakes than
  V1/V2's pay-and-forget model.
- **Funding the fund.** The insurance fund only works if it's capitalized ahead of
  need (fee accrual + penalties). Under-capitalize it and the backstop is theatre. The
  coverage-ratio alert exists precisely to watch this.

Net: leverage and shorting make the market **more expressive, more liquid, and more
self-correcting**, at the price of a **real protocol-risk surface** that the
liquidation engine and insurance fund exist to bound. V3 ships the powers and their
safety machinery as one unit, opt-in per market, on top of an unchanged 1× core.

---

## 6. Pointers
- V3 engineering design: `docs/v3/TDD.md` (Workstream **B** margin/leverage/shorting, **H** insurance, **L** liquidation, **R** risk UX)
- V3 build plan: `docs/v3/TASKS.md` (Phases V3-1 … V3-5)
- MM-side solvency it does **not** touch: `docs/capacity/` (reserve, capacity gate, soft cap)
- Spec: `docs/MODEL.md §9.2/§9.3` (margin/leverage/limits), `§8.2` (bankruptcy/negative payoff), `§15.2` (insurance / socialized loss)
- Why two-sided expression matters for belief: `docs/v2/belief-and-exposure.md`
