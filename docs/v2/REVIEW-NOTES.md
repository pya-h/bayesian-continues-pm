# V2 — Review Notes (minor, non-blocking)

Full correctness audit of the non-deferred V2 phases (V2-1/multi-model, V2-2 adaptive, V2-3 oracles, V2-5/V2-6 ledgers, V2-7 hardening, V2-8 ghost trail) on **2026-06-24**.

**Outcome: no bugs, mistakes, or conflicts found.** Baseline suite green — `core 443 · shared 23 · api 178 · web 214 = 858 tests, 0 fail`. The two prior documented fixes (`validateAdaptiveConfig` for V2-2, the `decentralized` 501 guard for V2-3) were verified genuinely present and correct.

The items below are **minor cosmetic / consistency observations only** — none change a result or alter behaviour. Recorded here so they aren't lost; left unfixed pending a deliberate call (touching tested code for non-bugs is intentional scope, not a drive-by).

---

## 1. `bayesUpdateMixture` ignores `cfg.useSimplifiedUpdate`
- **Where:** `packages/core/src/bayes.ts` (mixture update branch).
- **What:** Gaussian, Student-t, and gen_exact all branch on `useSimplifiedUpdate` (the lr/decay path); the mixture update does not — it always runs the precision-weighted responsibility update. A `mixture`/`gen_basis` market created with `useSimplifiedUpdate: true` silently gets the full Bayes update instead.
- **Severity:** minor inconsistency. The precision update is well-defined, so the result is correct either way — only the inter-kind contract differs.
- **Options:** document that mixture always uses the full update, or add a simplified branch for parity.

## 2. Dispute-filed admin alert reuses `kind: 'oracle_failure'`
- **Where:** `apps/api/src/services/disputeSvc.ts` (dispute-filed alert).
- **What:** A filed dispute publishes an admin alert with `kind: 'oracle_failure'`, `severity: 'warning'`. A dispute is not a feed failure, so the alert kind is slightly overloaded (it renders fine — the banner and breaker kind exist).
- **Severity:** cosmetic / label clarity. An operator filtering on `oracle_failure` would see disputes mixed in.
- **Options:** add a dedicated `dispute` alert kind (touches `core/breakers.ts`, the web `SystemAlert` union, `AlertsBanner` labels, and tests) — only worth it if a distinct alert taxonomy is wanted.

## 3. Cancel LP-claim writes `balanceAfter: null` when `credited === 0`
- **Where:** `apps/api/src/services/marketSvc.ts:339` (cancel-time LP claim).
- **What:** The balance update is guarded by `&& credited > 0`, so a zero-credit claim records `balanceAfter: null` for a tracked (non-infinite) LP. The other zero-amount claim sites (`lpSvc.claim`, `settleSvc`) still record the real unchanged balance.
- **Severity:** cosmetic. No balance moved, so the ledger is not wrong — just the one place a tracked user can get a `null` `balanceAfter`.
- **Options:** read/return the unchanged balance instead of `null` for parity.

## 4. Coarse central-difference step in the smooth-payoff `dPrice_dMu`
- **Where:** `packages/core/src/pricing.ts` (Student-t / gen_exact GAUSSIAN-payoff derivative, ~lines 429 and 456).
- **What:** `h = max(1e-3, stddev · 1e-3)`. The `1e-3` floor is ~10% of σ for a σ≈0.01 market, large enough to admit visible O(h²) error in the central difference. Only affects the GAUSSIAN-payoff adverse-selection **spread** term (second-order).
- **Severity:** minor numeric. Not observed to misprice in tests.
- **Options:** scale `h` purely off σ (e.g. `stddev · 1e-3` without the absolute floor, guarded for σ→0).

---

### Also noted (investigated, not actionable)
- **gen_exact `expectF` window** (`mean ± 10σ`) can graze the `[μ ± 7σ]` support edge for strongly thin-tailed shapes where `Var[u]` drops toward ~0.49. Not observed to fail for in-range λ; a support-clamped window (like `expectGaussianBump`) would be marginally safer. Edge-of-envelope, not a defect.
