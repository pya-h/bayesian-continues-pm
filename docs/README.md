# Documentation Index — Web2 BMM Continuous Prediction Market

| Doc | What it is |
|---|---|
| [MODEL.md](MODEL.md) | The mathematical & functional **specification** (source of truth for the math). |
| [v1/TDD.md](v1/TDD.md) | **V1 engineering design** — Gaussian beliefs, user-composable contracts, LP, 1× cash-collateralized. Includes the corrections to `MODEL.md` (see §2). |
| [v1/TASKS.md](v1/TASKS.md) | **V1 phased build plan** (Phases 0–11). |
| [v2/TDD.md](v2/TDD.md) | **V2 engineering design** — multi-modal beliefs, adaptive params, hedging, robust oracles/disputes, compliance, scale. **(Stays 1× cash-collateralized.)** |
| [v2/TASKS.md](v2/TASKS.md) | **V2 phased build plan** (Phases V2-1 … V2-12). Prereq: V1 shipped. |
| [v3/TDD.md](v3/TDD.md) | **V3 engineering design** — **leverage, margin, shorting, liquidation engine, insurance fund** (the borrowed-exposure stack moved out of V2). |
| [v3/TASKS.md](v3/TASKS.md) | **V3 phased build plan** (Phases V3-1 … V3-5). Prereq: V1 + V2 shipped (needs V2-2 tiers). |
| [v3/shorting-and-leverage.md](v3/shorting-and-leverage.md) | **Concepts explainer** — how shorting/leverage/margin/liquidation work, their pros & cons, and why a prediction market wants them. |
| [capacity/](capacity/README.md) | **Market capacity & the solvency gate** — why buys get gated, the options to relax it, the chosen **soft-cap** design, and its build plan. See the folder index. |

**Precedence:** where a TDD disagrees with `MODEL.md`, the TDD wins (deviations are documented in each TDD's §1 / §2). V2 and V3 are additive — V1 markets keep behaving as V1, and V2 markets keep behaving at 1× under V3.

**Reading order:** `MODEL.md` → `v1/TDD.md` → `v1/TASKS.md`, then (later) `v2/TDD.md` → `v2/TASKS.md`, then (later still) `v3/TDD.md` → `v3/TASKS.md`. **Collateral axis:** V1 and V2 are 1× cash-collateralized; **leverage/shorting first appear in V3**.
