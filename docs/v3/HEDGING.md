# Phase V3-4 — Hedging, explained

> Plain-language companion to [`docs/v3/TASKS.md`](./TASKS.md) Phase V3-4. What hedging is,
> why our market would want it, how necessary it is, and which phases it touches.
>
> **Note on the V2 → V3 move.** Hedging was originally scoped for V2 (Workstream D). It has been **deferred to
> V3**, where it sits beside the other MM/protocol risk machinery (the leverage stack, the
> liquidation engine, and the insurance fund). Its one hard prerequisite — multi-modal beliefs and
> the reserve machinery — already shipped in **V2-1**, so V3 can pick it up directly.

## What hedging is (plain terms)

**Hedging = taking an offsetting position so that if one bet goes against you, another bet pays
you back.** You give up a little upside in exchange for capping your downside. It is insurance you
buy by making a second, opposite trade.

**Everyday example.** You are a bookmaker and you have taken **£10,000 of bets on Team A to win**.
If A wins, you owe £10,000 — a scary, lopsided risk. So you go to *another* bookmaker and put
**£4,000 on A yourself**. Now:

- If **A wins**: you owe £10k on the bets you took, but you collect on your own £4k bet — net loss
  much smaller.
- If **A loses**: you keep the bets you took, but lose your £4k stake.

You traded a slice of profit for a **much smaller worst case**. That is a hedge.

## What it is in *our* market

Our market-maker (MM) is the counterparty to every trade, so over time it builds up a **one-sided
book**. The risk it must survive is the **liability curve**

```
L(θ) = Σ mmShort[C] · f_C(θ)
```

— what it would owe at each possible outcome θ (see the math doc §10, *Reserve & solvency*). To stay
solvent, the MM must lock up a **reserve** equal to the 99th-percentile of `L(θ)` (a Value-at-Risk).
A lopsided book ⇒ a tall, spiky `L(θ)` ⇒ a **big reserve** ⇒ capital frozen, and eventually the
**solvency gate trips and the market stops accepting trades**.

**Hedging here means the MM takes its own offsetting position** — built from a basis of
binaries/spreads tiling the outcome axis Θ — that **flattens the peaks of `L(θ)`**. Concretely, per
the plan:

- `find_best_hedge(exposure)` searches a binary/spread basis for the position that most reduces
  `L(θ)`'s variance / peak.
- It **triggers when `reserve > cash × 0.8`** — the book has become dangerously capital-heavy.
- A `hedges` table does the bookkeeping; crucially it is **neutral to user payouts** — users are
  unaffected, only the MM's reserve shrinks.
- An `ExternalHedgeProvider` interface (with a **mock** for now) is where a real external venue
  would later absorb the offset risk.

**Concrete effect:** a market that has filled up — where the 99% reserve ≈ its whole liability —
**auto-hedges**, `L(θ)` flattens, the required reserve drops, and the **freed capital lets the
market keep trading**. The phase checkpoint is literally *"a high-reserve market auto-hedges and
frees capital; admin sees the hedge book."*

## How necessary is this phase?

**Medium — it is a capital-efficiency / scale feature, not a correctness one.**

Nothing is *wrong* without it: the reserve gate (§10, already shipped) keeps the MM solvent no
matter what. The cost of skipping it is that **popular, lopsided markets hit capacity early** and
either stop accepting trades or demand more LP cash than strictly necessary. So it matters most once
markets get real volume — which is exactly why it travels with the V3 risk machinery rather than
gating the V2 belief work. For a V1 / V2 system it is deferrable, and the
[soft-cap](../capacity/soft-cap.md) ramp already softens the same capacity wall from the price side.

> **Important boundary — hedging is *not* leverage, even though both now live in V3.** Hedging only
> **reduces the MM's existing** reserve by offsetting its own book; it does **not** let a *user*
> borrow exposure. User trading stays **1× cash-collateralized** under hedging alone. Leverage,
> margin, shorting, and liquidation are the *separate* V3 workstreams (V3-1/V3-3), and the insurance
> fund (V3-2) absorbs *their* gap losses. Hedging is the MM-side, payout-neutral risk tool; the
> leverage stack is the user-side, collateral-changing one. They share the V3 release but are
> independent — hedging has no dependency on leverage and could ship at 1×.

## Which phases relate to it

| Phase | Relationship |
|---|---|
| **V2-1 Multi-modal beliefs** ( done, in V2) | **Hard blocker** (`[blocked-by: V2-1]`). Hedging reasons over `L(θ)` and the reserve, both computed from the belief — it needs the multi-belief reserve machinery, which already shipped in V2. |
| **V3-2 Insurance fund** | **Closest sibling** — the other protocol-risk tool. Hedging *prevents* reserve blow-up on the MM book; the insurance fund *absorbs* residual gap/bankruptcy losses from the leverage stack. Complementary, not overlapping. |
| **V3-1 Leverage/shorting core**, **V3-3 Liquidation engine** | **Release-mates, not dependencies** — hedging ships in the same V3 track but is independent of borrowed exposure (it works at 1×). |
| **V2-4 Scale & ops**, **V3-6 Hardening** | **Downstream beneficiaries** — hedging is part of what lets markets scale without freezing capital, and it needs hardening before production. |
| **Math doc §10 — Reserve & solvency** | **Conceptual parent** — hedging exists purely to lower the reserve that §10 defines. The phase calls for a math-doc addition with a before/after reserve worked example. |

## One natural follow-on

Phase V3-4 also asks for a **math-doc section** showing how an offsetting basis position lowers
`L(θ)` variance and the reserve, with a **before/after reserve worked example** — which would pair
naturally with the existing §10 (Reserve & solvency) and the §19 (Price impact) widgets.
</content>
