# Solvency & Market Capacity — why buys get gated

> Why a trade can be rejected with **"insufficient capacity or balance (solvency
> gate)"** even though the market looks open and healthy, what the gate is
> protecting, and what a trader/operator should do about it.
>
> Companion to [MODEL.md](../MODEL.md) §7 (spread, reserve, partial fills). The
> engine code lives in [`apps/api/src/services/tradeMath.ts`](../../apps/api/src/services/tradeMath.ts)
> and [`apps/api/src/services/tradeSvc.ts`](../../apps/api/src/services/tradeSvc.ts);
> the reserve itself in [`packages/core/src/solvency.ts`](../../packages/core/src/solvency.ts).

---

## 1. The one idea that makes it click: a buy creates a *liability*

It's natural to think *"every buy flows cash into the pool, and claims are paid
out of the pool, so how could the pool ever run short?"* The missing piece is
that **a buy is two things at once**:

1. **Cash in** — the trader pays the premium. Pool cash goes **up**.
2. **A liability out** — the pool becomes the **counterparty** (it is now *short*
   that contract). At resolution it must **pay the holder** `payoff(θ*) × qty`.

The catch is that those two numbers are wildly different sizes. **The premium
collected is small; the payout that may be owed is large.**

### A concrete example

The pool starts with **$1,000** cash. A trader buys 100 units of a binary
"θ ≥ 30":

| | amount |
|---|---|
| Premium they pay in (fair ≈ $0.05 × 100) | **+$5** → pool cash $1,005 |
| What the pool **owes** if θ ≥ 30 happens ($1 × 100) | **−$100** liability |

The pool took in **$5** and took on a **$100** obligation. Now 50 traders pile
into the same bet: the pool collects ~**$250** in premiums (cash ≈ $1,250) but
now owes up to **~$5,000** if that outcome lands. Premium inflow **never keeps
pace** with the liability it creates. That asymmetry is structural — it's how
*every* market maker / underwriter works, not a quirk of this market.

---

## 2. Why final claims *force* the gate to exist

At resolution the market settles at the true outcome `θ*`, and **every winning
position claims `payoff(θ*) × qty` out of the pool's cash**. So:

> If the pool ever writes more exposure than its cash can cover, some winners
> simply **cannot be paid** — the pool is insolvent and the claim guarantee is
> broken.

To prevent that, the pool continuously estimates **how much it would owe when
this resolves** — the **required reserve**. It's the 99%-worst-case payout of the
entire open book, computed by Monte-Carlo over the current belief
(`requiredReserve`, controlled by `cfg.reserveAlpha`, default **0.99**). The
reserve is cash the pool **holds back** to honour claims; it is not spendable.

The **solvency gate** is then just the underwriter's golden rule:

```
keep enough cash to pay what you'd owe   →   cash ≥ OPEN_MARGIN × reserve
```

with `OPEN_MARGIN = 1.2` — a **20% headroom buffer** the pool insists on before
it will take on *new* risk. This is exactly what guarantees that winners' claims
are always payable.

---

## 3. How the gate actually fires (the mechanics)

On every order the engine sizes the largest fill that stays solvent
(`solveFill` → `feasible(size)` in [`tradeMath.ts`](../../apps/api/src/services/tradeMath.ts)).
A buy **always increases** the pool's short exposure, so it **raises the reserve**;
the moment it does, the `1.2×` margin applies:

```
effectiveCash  ≥  margin × reserve_after
  where  effectiveCash = cash + min(0, totalCost)      // see note below
         margin        = 1.2  if the trade raises the reserve (opening risk)
                       = 1.0  if it lowers the reserve (reducing risk)
```

If not even a sliver of size fits, `solveFill` returns ~0 and the trade is
rejected with **"insufficient capacity or balance (solvency gate)."** The same
gate is re-checked at commit time in
[`tradeSvc.ts`](../../apps/api/src/services/tradeSvc.ts) so quoting and execution
can never disagree.

**Why `effectiveCash` excludes a buy's own premium.** A buy's premium inflow
(`min(0, totalCost)` is 0 for a buy) is deliberately **not** counted as backing
for the risk that same trade creates — otherwise a trade could "self-fund"
unbounded exposure out of its own spread. The premium is still banked into pool
cash and becomes LP profit; it just can't pledge itself as collateral. (A
**sell** has `totalCost < 0`, so its payout outflow **is** subtracted — selling
must remain solvent on the way out too.)

---

## 4. The "no-buy band": open, solvent… and still refusing every buy

This explains the surprising symptom — *every* buy rejected, even a tiny one,
while the market still shows cash > reserve:

- The pool is **solvent** whenever `cash ≥ reserve` (ratio ≥ 1.0).
- But it will only **open new risk** when `cash ≥ 1.2 × reserve` (ratio ≥ 1.2).

So when the cash/reserve ratio sits in the band **[1.0, 1.2)**, the market is
solvent but has **no headroom to add exposure**. Any risk-increasing buy — *at
any size*, because the `1.2×` margin kicks in the instant the reserve ticks up —
is refused. The market looks open and healthy, yet buys are frozen. Only things
that **shrink** the reserve (sells, or offsetting trades) can pull the ratio back
above 1.2 and thaw it.

This is why **"after some sells it works again"**: each sell reduces the pool's
short exposure → reserve drops → headroom returns.

---

## 5. So what should a trader / operator do?

A blocked buy means **"this market has underwritten all the risk its capital can
cover."** It's *full*, like an insurer that's hit its book limit. Three real
options:

| Option | Effect |
|---|---|
| **Add liquidity** (LP → *Manage liquidity* → deposit) | Raises pool cash → raises the ceiling → buys reopen. **This is the intended way to grow a market's capacity.** |
| **Sell / let holders exit** | Reduces the pool's short exposure → reserve drops → headroom returns. |
| **Trade the offsetting side** | A bet that *reduces* net exposure has `margin = 1` and is **not** gated even when same-direction buys are. |

Smaller size *sometimes* helps (partial fills are how `solveFill` normally
degrades gracefully), but inside the [1.0, 1.2) band even tiny buys are blocked,
so the real levers are **add capital** or **reduce exposure**.

---

## 6. Worked field case (market `267dcbd7…720c`)

A real market that produced this report, inspected live:

| Field | Value |
|---|---|
| status | OPEN |
| belief σ | **1.2** — pinned at the floor (`sigmaMin = 1.2`, down from initial 12) |
| book | 13 contracts, several with enormous one-sided `mmShort` (a Bell @275 ≈ **1,000,000**, Call @276 ≈ 101,000, Bell @114 ≈ 200,000) |
| required reserve (99% VaR) | **≈ $17.7M** |

Heavy one-sided buying had (a) collapsed σ to its floor (over-confident belief)
and (b) piled up huge same-direction exposure, driving the reserve up toward the
pool's cash. While the cash/reserve ratio sat in the no-buy band, **every** buy
was refused; the user's sells released exposure and reopened it. By the time of
inspection the pool had recovered to **cash ≈ $44.5M vs the $21.2M gate (+$23M
headroom)**, and the stored reserve matched a fresh recompute to nine digits —
confirming the gate was working exactly as designed, **not a bug**.

---

## 7. Relationship to LP NAV

The same reserve drives LP capacity: LP **NAV = cash − E_p[L(θ)]** (cash minus the
*expected* liability — the LP's claimable equity), while the **reserve** is the 99%
VaR the pool must hold back. They are different cuts of `L(θ)` (mean vs 99th
percentile), but both grow with the book, so the reserve is simultaneously *the LP's
locked risk backing* and *the trader's capacity ceiling*. Growing one (more LP
deposits) grows the other (more buy capacity) — two views of the same capital.
See [v1/TDD.md](../v1/TDD.md) §6 (LP/NAV) and
[`packages/core/src/solvency.ts`](../../packages/core/src/solvency.ts).

---

## 8. Is the engine doing anything wrong? (No — but the UX could be clearer)

The logic is correct and intentional: it is the mechanism that guarantees the
pool can always pay claims. The only genuinely improvable part is **presentation**:

- The rejection message lumps three different causes (your balance, pool
  capacity, the 1.2× buffer) into one opaque string.
- The no-buy band is invisible — the market looks open but silently refuses buys.

A future UX pass could surface a **"capacity X% used"** indicator, pre-emptively
disable buying (with the "add liquidity" path) when headroom is gone, and make
the error name the constraint that actually bit. None of that changes the engine
— it just stops users from guessing.
