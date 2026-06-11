# Documentation Index — Web2 BMM Continuous Prediction Market

| Doc | What it is |
|---|---|
| [MODEL.md](MODEL.md) | The mathematical & functional **specification** (source of truth for the math). |
| [v1/TDD.md](v1/TDD.md) | **V1 engineering design** — Gaussian beliefs, user-composable contracts, LP, 1× cash-collateralized. Includes the corrections to `MODEL.md` (see §2). |
| [v1/TASKS.md](v1/TASKS.md) | **V1 phased build plan** (Phases 0–11). |
| [v2/TDD.md](v2/TDD.md) | **V2 engineering design** — multi-modal beliefs, leverage/margin/shorting/liquidation, adaptive params, hedging, robust oracles/disputes, compliance, scale, insurance fund. |
| [v2/TASKS.md](v2/TASKS.md) | **V2 phased build plan** (Phases V2-1 … V2-9). Prereq: V1 shipped. |
| [capacity/](capacity/README.md) | **Market capacity & the solvency gate** — why buys get gated, the options to relax it, the chosen **soft-cap** design, and its build plan. See the folder index. |

**Precedence:** where a TDD disagrees with `MODEL.md`, the TDD wins (deviations are documented in each TDD's §2 / §1). V2 is additive — V1 markets keep behaving as V1.

**Reading order:** `MODEL.md` → `v1/TDD.md` → `v1/TASKS.md`, then (later) `v2/TDD.md` → `v2/TASKS.md`.
