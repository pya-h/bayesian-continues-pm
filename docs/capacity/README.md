# Capacity & the Solvency Gate

Everything about *how much risk a market can take on*, why trades get gated, and
how we plan to make that limit graceful instead of a hard wall.

| Doc | What it is |
|---|---|
| [solvency-and-capacity.md](solvency-and-capacity.md) | **Why buys get gated** — the solvency reserve, the 1.2× capacity buffer, the "no-buy band", and what to do about it. (Start here.) |
| [expanding-capacity.md](expanding-capacity.md) | **The full menu of ways to relax the gate** — knob tuning, soft cap, a pro-rata payout "solvency factor", insurance fund, hedging, etc. — and what each one costs. |
| [soft-cap.md](soft-cap.md) | **The soft-cap approach in depth** — how pricing already responds to trades today, the cliff-vs-asymptote idea, exactly what soft cap changes, and what it does *not* change. |
| [TASKS.md](TASKS.md) | **Step-by-step plan** to refactor the engine into soft-cap mode (phases SC-0 … SC-7). Scheduled **after V2**. |

**Reading order:** `solvency-and-capacity.md` → `expanding-capacity.md` → `soft-cap.md` → `TASKS.md`.

**Status:** conceptual / planned. None of this is implemented in V1. The soft-cap
refactor is queued to start **after V2 ships**. The soft cap preserves the
solvency guarantee — it makes the existing limit *graceful*, it does not remove it
(see `soft-cap.md` §"What soft cap does NOT do").
