# Documentation Index — Web2 BMM Continuous Prediction Market

| Doc | What it is |
|---|---|
| [MODEL.md](MODEL.md) | The mathematical & functional **specification** (source of truth for the math). |
| [v1/TDD.md](v1/TDD.md) | **V1 engineering design** — Gaussian beliefs, user-composable contracts, LP, 1× cash-collateralized. Includes the corrections to `MODEL.md` (see §2). |
| [v1/TASKS.md](v1/TASKS.md) | **V1 phased build plan** (Phases 0–11). |
| [v2/TDD.md](v2/TDD.md) | **V2 engineering design** — multi-modal beliefs, adaptive params, robust oracles/disputes, scale. **(Stays 1× cash-collateralized.)** |
| [v2/TASKS.md](v2/TASKS.md) | **V2 phased build plan** (Phases V2-1 … V2-8). Prereq: V1 shipped. |
| [v3/TDD.md](v3/TDD.md) | **V3 engineering design** — **leverage, margin, shorting, liquidation engine, insurance fund** (the borrowed-exposure stack moved out of V2) plus **hedging** (MM reserve reduction). |
| [v3/TASKS.md](v3/TASKS.md) | **V3 phased build plan** (Phases V3-1 … V3-6). Prereq: V1 + V2 shipped. |
| [v3/shorting-and-leverage.md](v3/shorting-and-leverage.md) | **Concepts explainer** — how shorting/leverage/margin/liquidation work, their pros & cons, and why a prediction market wants them. |
| [v3/HEDGING.md](v3/HEDGING.md) | **Hedging explainer** (Phase V3-4 / Workstream D) — how the MM lays off tail risk to cut the reserve; companion to the V3 plan. |
| [v2/belief-and-exposure.md](v2/belief-and-exposure.md) | **Explainer** — why two-sided expression (incl. selling) matters for belief quality. |
| [v2/trade-to-signal.md](v2/trade-to-signal.md) | **Explainer** — how a fill becomes a belief signal (extractSignal → Bayes update). |
| [capacity/](capacity/README.md) | **Market capacity & the solvency gate** — why buys get gated, the options to relax it, the chosen **soft-cap** design, and its build plan. See the folder index. |
| [multi model/](multi%20model/README.md) | **Flexible-beliefs track** — generalizing beyond Gaussian/mixture/Student-t (parametric families, general belief form), with its own plan (G0…G6). |
| [math/](math/index.html) | **Interactive math doc** — every formula of the engine as a live widget (open `math/index.html` in a browser). |
| [REVIEW-FINDINGS.md](REVIEW-FINDINGS.md) | **Audit findings & fix log** — the full-project review results and the phased bug-fix progress (all 48 items fixed). |
| [REVIEW-FINDINGS-2.md](REVIEW-FINDINGS-2.md) | **Round-3 closing review** — verification that all prior fixes hold, plus the new (open) findings C42–C56. |

**Precedence:** where a TDD disagrees with `MODEL.md`, the TDD wins (deviations are documented in each TDD's §1 / §2). V2 and V3 are additive — V1 markets keep behaving as V1, and V2 markets keep behaving at 1× under V3.

**Reading order:** `MODEL.md` → `v1/TDD.md` → `v1/TASKS.md`, then (later) `v2/TDD.md` → `v2/TASKS.md`, then (later still) `v3/TDD.md` → `v3/TASKS.md`. **Collateral axis:** V1 and V2 are 1× cash-collateralized; **leverage/shorting first appear in V3**.
