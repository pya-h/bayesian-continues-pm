# Project & docs review — findings (2026-06-12)

Whole-project correctness pass: automated checks (typecheck, all test suites, lint)
plus a manual cross-check of the core engine, the API trade pipeline, the web app,
the interactive math-doc widgets, and all documentation.

## Baseline — automated checks (all green)

| Check | Result |
|---|---|
| `bun run typecheck` (core, shared, api, web) | **0 errors** |
| `bun run test:core` | **183 pass / 0 fail** |
| `bun run test:shared` | **9 pass / 0 fail** |
| `bun run test:api` | **127 pass / 0 fail** |
| `bun run test:web` | **161 pass / 0 fail** |
| `bun run lint` (biome) | only **style** diagnostics (template-literal-over-concat, single-var-declarator, redundant `'use strict'`) — no correctness issues; concentrated in the hand-written `docs/math/*.js` |

The engine is mathematically sound where it counts: closed-form prices match numerical
integration to ~1e-7, `∂Price/∂μ` matches finite differences to ~1e-10, special functions
to ~1e-15, and the Bayesian / mixture / reserve / solvency-gate paths behave correctly on
edge cases. The findings below are the residue of a deep manual audit — **no Critical/High
*code* bug was found**; the two High items are documentation.

---

## Fixed in this pass (documentation)

These were unambiguous and verified against the source of truth, so they are already corrected.

### D1 · [High → fixed] Stale "§19" math-doc references (regression)
Inserting the new **§20** "Slippage & price impact vs standard prediction markets" last
session pushed *Flexible parametric beliefs* from §19 to **§21**, but five references in the
multi-model docs still pointed at "§19" (now the Price-impact section):
`multi model/README.md:81`, `parametric-belief-families.md:204`, `general-belief-form.md:124`,
`TASKS.md` (×2). **Fix:** all five updated to **§21**.

### D2 · [High → fixed] Wrong LP-NAV formula
`capacity/solvency-and-capacity.md:163` stated **`NAV = cash − reserve`**. NAV marks against
the *expected* liability, not the 99% VaR reserve — every other source agrees
(`apps/api/src/services/lpMath.ts:5`, `v1/TDD.md §6.1`, math-doc §12):
**`NAV = cash − E_p[L(θ)]`**. Reserve (99th-percentile VaR) and `E_p[L(θ)]` (mean) are
different cuts of `L(θ)`. **Fix:** corrected the formula and clarified reserve vs expected
liability.

### D3 · [Low → fixed] Mis-cited LP/NAV section
Same file (`:167`) pointed to "MODEL.md §8 (LP/NAV)", but MODEL.md §8 is *Settlement and
Resolution* and MODEL.md has no LP concept (LP is a v1/TDD addition). **Fix:** now cites
`v1/TDD.md §6 (LP/NAV)`.

---

## Open — recommended, awaiting your go-ahead (code)

None of these are caught by the current tests; each touches engine/runtime behaviour, so I
left them for a decision rather than changing behaviour unprompted.

### C1 · [Medium] Student-t over-prices the tail truncation → under-prices CALL/PUT
`packages/core/src/pricing.ts:153` — `expectF` integrates over a fixed `±10σ` window. A
Student-t with low ν has polynomial tails, so an unbounded payoff (CALL/PUT) keeps
accumulating mass past 10σ and is systematically **under-priced**:

| contract | ν | quadrature | converged | error |
|---|---|---|---|---|
| CALL K=110 | 3 | 2.7811 | 2.8418 | **−2.1%** |
| CALL K=110 | 2.1 | 0.7075 | 0.7696 | **−8.1%** |

`LINEAR` is already special-cased to `belief.mean()` for exactly this reason; CALL/PUT have
the same exposure and no protection. The mispriced fair propagates into spread, adverse
selection, stats and NAV marks for any Student-t market. **Fix options:** widen `L`/`nodes`
sharply as ν→2 when `belief.kind === 'student_t'`, or add an analytic tail correction for
unbounded payoffs. Bounded payoffs (binary/spread/gaussian) are unaffected.

### C2 · [Medium] Web "win chance" is Gaussian-only on non-Gaussian markets
`apps/web/src/lib/tradeStats.ts:153` (`probInRegions(mu, sd, …)` integrates a plain
`N(μ,σ)`), surfaced as the headline win-chance in `QuotePanel.tsx:483`. Every *other* preview
in the panel was upgraded to price against the real `beliefFromView(...)` model, but this one
only receives `mu`/`sigma`, so on a `mixture`/`student_t` market the displayed profit
probability is wrong (same μ/σ, very different tail/mode mass). **Fix:** thread the
`BeliefModel` into `tradeStats` and compute `pProfit` from `belief.cdf` over the profit
intervals.

### C3 · [Medium] Mixture/Student-t belief *shape* goes stale after others' trades
`apps/web/src/hooks/useMarketSocket.ts` `belief_update` handler patches only `mu`/`sigma`
(all the server event carries), leaving `components`/`nu` at the page-load snapshot. Your own
trade refetches the market, but *other* traders' fills only invalidate `stats`/`history`, so
`BeliefChart` and the client-side previews keep using the stale shape until refresh.
**Fix:** on `belief_update`, also invalidate `qk.market(marketId)` when the cached belief kind
≠ gaussian (or have the server include `components`/`ν` in the event — an API-contract change).

### C4 · [Low] Admin top-up is not concurrency-safe (lost update)
`apps/api/src/services/fundingSvc.ts:37-42` computes `balanceAfter = target.balance + amount`
from the request-time snapshot and writes it absolutely, with no `FOR UPDATE` re-read inside
the tx. Two concurrent top-ups (or a top-up racing a trade/claim that read-modify-writes
balance) can clobber each other. Every *other* money write either locks the row `FOR UPDATE`
or uses an atomic SQL delta. **Fix:** re-select the row `.for('update')` inside the tx, or
write with an atomic delta `set({ balance: sql\`${users.balance} + ${amount}::numeric\` })`
and read `.returning()` — as `refundPositions`/`claimPayout` already do.

### C5 · [Nit] Mixture second-moment routed through quadrature on a step function
`packages/core/src/stats.ts:39-57` — for a mixture belief, `secondMoment` of `BINARY_*`/`SPREAD`
falls through to `expectF` on a discontinuous payoff (which `expectF`'s own docstring warns
against): binary-call gives 0.47757 vs exact 0.47816 (~6e-4), feeding a slightly wrong
`payoutStd`. **Fix:** extend the `f²=f` shortcut + mixture closed form to binary/spread for
non-Gaussian beliefs.

### C6 · [Nit] `extractSignal` intensity/weight unbounded above `qMax`
`packages/core/src/signal.ts:33,73` — `intensity = |q|/qMax` isn't clamped, so `weight` can
exceed 1 when `|q| > qMax`; in `bayes.ts:30` `σ²·(1 − decay·weight)` could go negative (rescued
only by the σ_min² floor). Latent footgun, not live at default params. **Fix:** clamp
`intensity = min(1, |q|/qMax)`.

### C7 · [Nit] Dead expression in the quote panel
`apps/web/src/components/QuotePanel.tsx:404` — `${outcomeUnit && ''}` always renders empty
(and appends a stray space); the outcome unit on the Fair (mid) row never shows. Likely meant
`${outcomeUnit ?? ''}`.

### C8 · [Info] Dead code
`packages/core/src/solvency.ts:94` `maxExecutable` is superseded by the API's `solveFill` and
only referenced from tests. Safe to remove or mark internal.

---

## Verified correct (spot-checks that found nothing)

- **Pricing**: LINEAR/CALL/PUT/BINARY/SPREAD/GAUSSIAN closed forms match numerical integration;
  put-call parity holds; matches MODEL.md §4.2 incl. the Put convention. All `∂Price/∂μ` match
  finite differences.
- **Bayesian update / mixture / Student-t**: precision-weighted μ',σ' matches the spec vector;
  mixture weight update (log-sum-exp), responsibility-weighted component update, law-of-total-
  variance, prune/merge/cap all correct; K=1 reduces to Gaussian exactly; Student-t variance
  `s²ν/(ν−2)`, ν>2 guard present.
- **Spread / solvency**: inventory uses the corrected `|mmShort+q|` convention; 99% VaR MC
  matches analytic Gaussian VaR; empty/zero/MM-long books return 0; seeded & deterministic.
- **API gate & fills**: `effectiveCash ≥ margin·reserve_after` with the buy-excludes-own-premium
  rule; `solveFill` monotone (mmShort ≥ 0) with matched 1e-6 slack so quote and commit can't
  disagree; sign handling of buy/sell `totalCost`, cash, ledger, `mmShort` all consistent;
  `numeric(20,8)` money with round-half-even; resolution/claims idempotent under `FOR UPDATE`;
  LP deposit mints at pre-deposit price, withdraw capped at `cash − 1.2·reserve`.
- **Web**: sign convention end-to-end (ask=fair+spread / bid=max(0,fair−spread)); sell
  `maxPrice` floor; kind-aware `price()` previews; formatters and null/NaN guards; socket seq
  monotonicity, state reset on market switch, reconnect/cleanup.
- **Math doc**: §20 `vizMechCompare` log-liquidity slider ($400 → $2.00e9), default-off soft-cap
  toggle, congestion `κ|fair|u^a/(1−min(u,1−ε))` (≈0 with headroom, finite at the wall),
  impact clamp [0,1], slippage clamp to `smax`, baseline+capacity drawn only when on — all
  verified through the real engine, no NaN. Every app.js selector resolves to a unique
  index.html id; sections 0–21 contiguous; TOC + anchors consistent; KaTeX delimiters balanced
  (`$$` 82, `\(`/`\)` 469/469).
- **Docs**: no broken links — every relative markdown/HTML link and every cited code path
  exists and contains what's claimed; default params (`gamma=0.0005`, `reserveAlpha=0.99`,
  `OPEN_MARGIN=1.2`, `qMax=500`, …) consistent across docs and `config.ts`; the MODEL.md §7.2/§6.2
  sign inconsistency is explicitly flagged and corrected in `v1/TDD.md §2.1` (acknowledged, not
  an unflagged bug).
</content>
</invoke>
