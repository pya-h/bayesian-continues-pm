# Project & docs review — findings (finalized 2026-06-12, pass 2)

Two review passes, same day. **Pass 1**: automated checks + manual cross-check of the core
engine, API trade pipeline, web app, math-doc widgets, and all documentation. **Pass 2**
(this finalization): an independent fresh review of every area, a re-verification of every
pass-1 finding, and — to kill false positives — an adversarial pass in which every new
High/Medium finding was handed to a second, independent verifier instructed to *refute* it,
reproducing all numeric claims against the actual package code. Nothing was refuted; two
severities were adjusted (one up-front correction is owed: **pass 1's headline "no
Critical/High *code* bug was found" was wrong** — pass 2 found two High items, C9 and C10).

## Baseline — automated checks (re-run in pass 2, all green)

| Check | Result |
|---|---|
| `bun run typecheck` (core, shared, api, web) | **0 errors** |
| `bun run test:core` | **183 pass / 0 fail** (17 files) |
| `bun run test:shared` | **9 pass / 0 fail** |
| `bun run test:api` | **127 pass / 0 fail** (19 files) |
| `bun run test:web` | **161 pass / 0 fail** (9 files) |
| `bun run lint` (biome) | only **style** diagnostics, concentrated in the hand-written `docs/math/*.js` |
| `node --check docs/math/*.js` | all parse |

Closed-form prices still match numerical integration to ~1e-7 (Gaussian/mixture),
`∂Price/∂μ` matches finite differences (Gaussian/mixture), special functions to ~1e-15.
The tests are green *and* C9/C10 are real — see each finding for exactly why the suite
doesn't catch it.

---

## Status of pass-1 findings — all re-verified

**C1–C8: every one CONFIRMED, none fixed yet.** Three corrections to the records:

- **C1** — magnitudes reproduce exactly (−2.14% at ν=3, −8.36% at ν=2.1, both at sd=20,
  matching the original table) and are *conservative*: at sd=10 the CALL errors grow to
  **−4.3% (ν=3) / −16.2% (ν=2.1)**. Put-call parity drift confirms independently.
- **C6** — the unclamped `intensity` is at `signal.ts:32` (was cited as 33); the `weight`
  cite (`:73`) and the `bayes.ts:30` exposure are correct as written.
- **C7** — the suggested fix `${outcomeUnit ?? ''}` was itself wrong: `outcomeUnit` is a
  *required string* prop, and line 522 shows the unit was meant to be *displayed*. Correct
  fix is plain `${outcomeUnit}`.

**D1–D3: all verified landed** (§21 references in the four multi-model docs; NAV =
cash − E_p[L(θ)] and the v1/TDD.md §6 cite in `capacity/solvency-and-capacity.md`).

---

## Fixed in this pass (documentation — unambiguous, verified)

### D4 · [Medium → fixed] Stale V3 phase range + missing Workstream D
`v3/shorting-and-leverage.md:189-190` was the one file the V2/V3 renumber missed: it said
"Phases V3-1 … V3-5" (the plan is now **V3-1 … V3-6**, hedging inserted as V3-4) and its
v3/TDD workstream list omitted **D (hedging)**. Both corrected.

### D5 · [Nit → fixed] Misplaced backtick × 3
`v2/TDD.md:128,140,146` — `` `docs/v3/TDD.md §`Data Model `` (and §API, §Frontend) had the
closing backtick before the section name, splitting the rendered reference. All three fixed
to `` `docs/v3/TDD.md` §… ``.

### D6 · [Low → fixed] §20 "BMM today" baseline drawn unclamped
`docs/math/app.js:806` — in the slippage chart the bold BMM line is clamped to the plot max
(`clampS`) but the faint soft-cap-ON baseline was not; at the thin end of the liquidity
slider (L ≈ $400–474) with the toggle on it overdrew the plot top by up to ~22 px into the
tick-label band (verified: `bmmSlip(1200, Q=800) = 0.607 > smax = 0.56`). Now wrapped in
`clampS`. No NaN/Infinity was ever involved — pure overdraw.

---

## New — Open, High

### C9 · [High] Cancelling a market permanently strands all LP funds
`apps/api/src/services/marketSvc.ts:210-214` — the `cancel` branch calls `refundPositions`
(traders' cost basis, `settleSvc.ts:73-114`) and patches `cash`, but never touches
`lp_positions`/`lp_ledger`. There is **no code path out**: `lpSvc.withdraw` requires
`status === 'OPEN'` (`lpSvc.ts:264-266`), `lpSvc.claim` requires `'SETTLED'`
(`lpSvc.ts:405-407`), and the `ACTIONS` state machine (`marketSvc.ts:35-43`) has no
transition leaving `CANCELLED`. Pool cash is unreachable forever.

This violates the spec — `v1/TDD.md:228`: *"CANCELLED: trades unwound at cost basis; LP
refunded deposits; everyone made whole."* The gap was acknowledged at `v1/TASKS.md:115` and
deferred "into the Phase 11 cancel-refund integration" — but Phase 11 was marked DONE
without it (its cancel test, `hardening.test.ts:191-217`, asserts trader refunds only).
The deferral rationale ("v1's sole guaranteed LP is the infinite admin") is false as an
invariant: `POST /markets/:id/lp/deposit` is plain `requireAuth` (`routes/lp.ts:14`), so
any user (e.g. seeded alice/bob with real 10k balances) can be an LP today.

**Fix:** in the cancel branch, after `refundPositions`, distribute remaining pool cash to
LPs pro-rata by shares (or allow `lp/claim` on CANCELLED with `cashFinal` = post-refund
cash), with ledger rows.

### C10 · [High] Student-t binary/spread priced by quadrature across a discontinuity → `∂P/∂μ` noise up to ±234% → adverse-selection spread 3× too wide (or zero)
`packages/core/src/pricing.ts:104-105` routes `student_t` BINARY_CALL/BINARY_PUT/SPREAD
through `expectF` (Simpson quadrature) even though exact closed forms exist via
`belief.cdf` — and `expectF`'s own docstring (`:139-143`) says discontinuous payoffs must
not go through it. Known C1 covers only the *unbounded* CALL/PUT tails; this is the bounded
case, with a worse knock-on. All numbers independently reproduced (ν=5, μ=100, sd=10,
stock `makeEngineConfig` defaults):

1. **Fair price**: error up to 8.4e-4 (binaries), **1.6e-3** (SPREAD) on contracts priced
   in [0,1] — the jump lands inside a Simpson cell, error O(h).
2. **`dPriceDMu`** (`pricing.ts:124-131`) central-differences that noisy price with
   h ≈ σ·1e-3 = 0.01, far smaller than the 0.05 quadrature cell. The numeric derivative
   comes out piecewise-constant in {0, ≈5/3·pdf, ≈10/3·pdf}: over strikes K ∈ [80,120],
   **relative error vs the exact `pdf(K)` spans −100% to +234%**, and for a large fraction
   of strikes it is *exactly 0*.
3. **Live impact**: the adverse-selection half-spread (`spread.ts:45-46`,
   `λ·intensity·|∂P/∂μ|·σ`) on a Student-t binary at K=99.25, q=245 came out **0.406 vs
   exact 0.127 (3.2×)** — ask quoted near 1.0 on a fair of 0.535. At the zero-derivative
   strikes the MM conversely charges *no* adverse-selection protection at all. Fully
   reachable: stock defaults, q ≤ qMax, `student_t` creatable via `createBeliefSchema`.

**Why tests miss it:** `pricing.test.ts:56-59` explicitly *excludes* discontinuous payoffs
from quadrature cross-checks; `studentT.test.ts` prices vs Monte-Carlo with tol ≥ 0.01 and
asserts only `isFinite(d) && d > 0` for the derivative. Mixtures are NOT affected (exact
per-component closed forms, `pricing.ts:95-99,118-122`).

**Fix:** special-case binary/spread for `student_t` to `1 − cdf(K)` / `cdf(K)` /
`cdf(b) − cdf(a)`, and use the location-family identities for the derivative
(`pdf(K)`, `−pdf(K)`, `pdf(a) − pdf(b)`) — the t pdf/cdf are already implemented and
test-validated. (Same change makes the C1 fix easier to scope: CALL/PUT central-difference
is fine — verified 2.5e-5 worst error.)

---

## New — Open, Medium

### C11 · [Medium] Last LP can withdraw everything and permanently brick an OPEN market
With no open MM shorts, `requiredReserve = 0` so `maxCashOut = cash` (`lpSvc.ts:292-297`)
and the last LP (including the creator burning the genesis R₀ shares — no carve-out, no
min-remaining floor) can take the pool to `cash = 0, lpSharesTotal = 0, nav = 0` on an OPEN
market. From there: every deposit is rejected forever by the `navBefore <= 0` guard
(`lpSvc.ts:159-162` — there is no genesis/re-genesis branch; `lpSharePrice`'s S_total=0
price of 1 in `lpMath.ts:19-21` is used only for display), and every trade fails the
solvency gate (`effectiveCash = 0`). Only an admin lifecycle action (cancel, or
resolve→settle) can end the market; users cannot recover it.

Latent companion: `sharesForDeposit` (`lpMath.ts:24-26`) returns `amount·0/nav = 0` shares
if `S_total = 0 ∧ nav > 0` is ever reached — the depositor would be debited and minted
nothing. The file header (`lpMath.ts:12-13`) claims callers guard S_total = 0; `deposit`
guards only NAV ≤ 0.

**Fix:** treat `lpSharesTotal === 0` as genesis in `deposit` (mint ΔS = amount at price 1)
and gate on `nav < 0` instead of `<= 0` when the pool is empty.

### C12 · [Medium] Market page shows an infinite spinner on load failure
`apps/web/src/pages/MarketPage.tsx:72` — `if (market.isLoading || !spec) return <Spinner/>`
precedes the error check (`:73-78`), and `spec` is only ever seeded from `market.data`
(`:59-61`). On a failed initial fetch (bad id, API down): react-query v5 settles with
`isLoading` false, `data` undefined → `!spec` stays true → "Loading market…" forever; the
404 "Market not found." branch is unreachable on first load (no error boundary,
`retry: 1`, `refetchOnWindowFocus: false`, so it never self-heals). The error branch only
renders in the secondary case where the page loaded once and a background refetch later
fails. **Fix:** check `market.error` before the `!spec` spinner guard.

### C13 · [Medium] Trade can be submitted with no (or a stale) quote — slippage guard silently dropped
`apps/web/src/components/QuotePanel.tsx:548` — the Buy/Sell button's `disabled` checks
`!tradable || qty <= 0 || trade.isPending || sellWithoutHolding`, never whether a quote
exists. The mutation (`:148-156`) computes `maxPrice = slippageOn && quote ? … : undefined`,
and the API only applies the guard `if (dto.maxPrice !== undefined)` (`tradeSvc.ts:259-266`,
`maxPrice` optional in `dto.ts:171`) — so with the "Slippage guard ±2%" checkbox visibly
checked, the order posts **unguarded**. Reachable two ways: on mount the button is enabled
(qty defaults to 1) while the first quote is in flight, and the quote query has
`retry: false` (`:123`), so one failed quote leaves the panel showing "Quote failed." with
the Buy button still live. Secondary: `placeholderData: keepPreviousData` (`:122`) means for
one fetch round-trip after editing qty/strike, `quote` belongs to the *previous*
spec/size, so `maxPrice` can be computed from the wrong contract. **Fix:** disable the
trade button when `!quote || quoteQ.isError || quoteQ.isFetching` (or visibly warn that the
guard is inactive).

---

## New — Open, Low

### C14 · [Low — downgraded from Medium] Mixture `secondMoment` window can drop a far low-weight mode entirely
`packages/core/src/stats.ts:40` — non-Gaussian CALL/PUT second moments use `expectF` with
window mean ± 10·*total* stddev; a component with π ≲ 1% contributes ~√π·d to total σ, so a
far mode can sit wholly outside. Repro: {π=.995, μ=0, σ²=1} + {π=.005, μ=60, σ²=1}, CALL
K=10 → `secondMoment` = 1.4e-25 vs exact 12.505 (`payoutStd` 0 vs 35.3). **Why Low:** the
adversarial check showed it is unreachable through the live flow today — `manageMixture`
(π_min = 0.02) prunes inside `bayesUpdateMixture` on every trade, and the only consumer
chain (`positionStats` → position detail) requires a prior trade; at π = 0.02 the window
is fine (verified exact). Fair *price* is NOT affected (closed-form per component). Latent:
re-armed by any pre-trade consumer, a lowered π_min, or configurable ops. **Fix:** set the
window from min/max component μ ± 10·component σ (as `MixtureBelief.quantile` already
does), or compute per-component closed forms. (Side observation: the first trade's prune
silently deletes a 0.5% far mode, moving that market's fair from 0.25 to ~0.0008 — an
authoring footgun worth a creation-time π floor.)

### C15 · [Low] Cancel can drive `markets.cash` negative
`marketSvc.ts:212-213` — `patch.cash = subMoney(m.cash, refunded)` has no floor, and
refunds (cost basis at avg entry) can exceed pool cash, e.g. when the belief moved against
traders (reserve ≈ 0) and an LP withdrew mark-to-model profit before the cancel. Users are
still credited, so the pool record goes negative — unbacked balance, and it compounds C9
(the escaped LP is made whole at everyone else's expense). **Fix:** clamp at 0 and surface
the shortfall, or cap refunds pro-rata by available cash.

### C16 · [Low] Seed never refreshes the admin password despite saying it does
`apps/api/src/db/seed.ts:28-32` — comment says "refresh password" but `onConflictDoUpdate`'s
`set` omits `passwordHash` (computed at `:18`, used only on insert). Rotating
`ADMIN_PASSWORD` + reseeding silently keeps the old hash (TDD §12 says the admin is
upserted "from .env"). **Fix:** include `passwordHash` in the conflict `set`.

### C17 · [Low] Concurrent duplicate registration → 500 instead of 409
`apps/api/src/routes/auth.ts:18-23` is check-then-insert on a unique `username`; the pg
23505 from the race isn't an `HttpError`, so `index.ts` onError returns "Internal error".
**Fix:** catch unique-violation and map to 409.

### C18 · [Low] Post-commit audit failure misreports an executed trade; no idempotency key
`tradeSvc.ts` — the tx commits at `:441`, WS events publish, then `await writeAudit(…)` at
`:495-505` (`lib/audit.ts` has no try/catch). If the audit insert fails, the client gets a
5xx for a trade that executed and was broadcast — and `POST /markets/:id/trade` has no
idempotency key (`tradeSchema` carries only `{spec, q, maxPrice?}`), so a natural retry
double-trades. Same pattern in `transitionMarket` (`marketSvc.ts:228-233`). **Fix:** write
the audit row inside the transaction, or fire-and-forget post-commit side effects.

### C19 · [Low] Server price history / mark path are Gaussian-only on non-Gaussian markets
`statsSvc.ts:189-192` and `:373-375` reconstruct historical fairs with
`new GaussianBelief(mu, σ²)` regardless of `beliefKind`, so the charted price series and
`positionDetail.markPath` (peak/drawdown) won't match the prices actually traded on
mixture/student_t markets. Server-side companion to C2/C3. Partially structural —
`belief_updates` stores only μ/σ, so exact reconstruction needs a schema change. Not
documented as an approximation anywhere. **Fix:** persist a belief snapshot per update, or
label the series Gaussian-approximate.

### C20 · [Low] `Phi(±∞)`, `erf(±∞)`, `erfc(±∞)` return NaN
`packages/core/src/numerics.ts:39-57` — with z = ∞ the Lentz iteration computes
`∞·0 = NaN` and never converges; verified `Phi(Infinity) = NaN`. So `cdf(±Infinity)` on the
exported beliefs is NaN instead of 0/1. Large *finite* args are fine (exact 0/1 from
z ≈ 27). Latent — no current caller passes ±∞ — but it's exported API. **Fix:**
early-return `erfc(∞) = 0`, `erfc(−∞) = 2`.

### C21 · [Low] `StudentTBelief.quantile` bracket caps at μ ± 60·sd — wrong in extreme tails
`packages/core/src/student_t.ts:170-172` — t tails are polynomial; for ν=3 the true
1−1e-7 quantile is ≈224 standard units vs the 103.9 cap (verified: `cdf(quantile(1−1e-7))`
= 0.9999990 ≠ 1−1e-7). Gets worse as ν→2. Currently latent (no callers outside the class),
but part of the `BeliefModel` contract. **Fix:** expand the bracket geometrically until
`cdf(hi) ≥ p` before bisecting.

### C22 · [Low] Float money: `round8` degrades above ~9×10⁷ and ties round inexactly
`packages/shared/src/money.ts:14-20` — `x·1e8` exceeds 2^53 once |x| > 90,071,992.54, so
8-dp arithmetic silently coarsens (verified `round8(1e11 + 1e-8) === 1e11`) while
`numeric(20,8)` advertises 12 integer digits (and the driver maps it through `Number()`,
`db/schema.ts:33-43`). The banker's-rounding tie branch also misfires on
non-representable ties: `round8(1.5e-8)` → 1e-8 (float is 1.4999999999999998) but
`round8(2.5e-8)` → 2e-8. Inherent to float money — worth documenting a balance cap (or
scaled integers) rather than a point fix.

### C23 · [Low] `JSON.parse` runs before the `res.ok` check
`apps/web/src/lib/api.ts:76-78` — a non-JSON error body (proxy/gateway HTML 502) throws a
raw `SyntaxError` instead of `ApiError`; every `instanceof ApiError` site degrades to its
generic message and the status code is lost. **Fix:** try/catch the parse and fall back to
`new ApiError(res.status, …)`.

### C24 · [Low] Deep-link redirect target captured but never used
`RequireAuth.tsx:15`/`:29` pass `state={{ from: location.pathname }}` ("preserving the
target"), but `LoginPage.tsx` hardcodes `/` in **both** redirect paths (`:21` `<Navigate
to="/">` when already authed, `:30` `navigate('/')` after login/register). Shared deep
links always dump on the markets list. **Fix:** read `location.state.from ?? '/'` in both.

---

## New — Open, Nits & info

**Core / shared**
- **C25** `mixture_ops.ts:123-130` — `splitComponent` docstring says split "at μ ± σ" but
  code seeds at μ ± σ/2; and the split is not moment-preserving (combined variance
  0.75·σ², a silent 25% shrink), unlike `mergeTwo` which is exact. Off-by-default feature.
  Fix the comment, or use ±σ/√2 offsets to preserve variance.
- **C26** `shared/src/enums.ts:31-35` — shared `BeliefKind` still exposes only `GAUSSIAN`
  ("v2: MIXTURE, STUDENT_T" commented out) while dto/core ship all three. Unreferenced
  today (grep-verified) — a dormant trap for anyone importing it for validation.
- **C27** `shared/src/money.ts:42-48` — `formatMoney` docstring claims "trims trailing
  zeros beyond 2"; `min = max = dp` renders fixed dp, nothing is trimmed.

**API**
- **C28** `statsSvc.ts:94` — `spreadIncome += spreadTotal·|q|` overstates MM income when a
  sell's bid was floored at 0 (`tradeMath.ts:33`): recorded spread > captured spread.
- **C29** `tradeSvc.ts:810-815` — `sellAllPositions` calls `evalBreakers` with
  `priceMovePct: 0`, so the rapid-move breaker can never fire on a sell-all.
- **C30** `marketQueue.ts:9` — per-market promise-chain map never pruned (unbounded, tiny).
- **C31** `fundingSvc.ts:57-65` — a grant from a hypothetical non-infinite admin records
  `−amount` with an unchanged `balanceAfter` and never debits the admin (row doesn't
  balance). Benign while all admins are infinite.
- **C32** Spec drift vs TDD §10 (mismatches, not bugs): route is `POST /markets/:id/trade`
  not `/trades`; claim takes no `{positionId}` body (claims all); `position_update` WS
  event documented but never emitted; `/quote` requires auth though TDD marks only trades.
- **C33** `config.ts:18` — `JWT_SECRET` silently falls back to a hardcoded dev secret in
  any environment; should fail hard outside dev.
- **C34** `ws.ts:46-56` — WS identity captured at upgrade; role demotion/user deletion not
  reflected until reconnect (an ex-admin keeps the `system` topic for the socket lifetime).

**Web**
- **C35** `BeliefHistoryChart.tsx:54,141` — with exactly 2 history points the x-tick index
  list is `[0, 0, 1]` → duplicate React keys, double-drawn tick. Dedupe the indices.
- **C36** `BeliefChart.tsx:672-677` — mixture mode markers placed at the *component's own*
  density `π·N(μ;μ,σ)`, not the mixture pdf the curve draws; dots float off the curve when
  bumps overlap. Use `mixturePdf(c.mu, components)` (or document as a contribution marker).
- **C37** `BeliefChart.tsx:643-655` — the μ mean line/label draw at raw `sx(mu)` even when
  μ is panned/zoomed out of the visible domain (θ* and the handles are guarded/clamped;
  μ is not). Hide when outside `[lo, hi]` like θ*.
- **C38** `hooks/queries.ts:10` — `qk.history(id)` = `['history', id, null]` is *not* a
  prefix of contract-keyed history queries, so the invalidations in `useMarketSocket:127` /
  `QuotePanel:164` can't match them. Latent (only the keyless variant is used today);
  invalidate with `['history', marketId]`.
- **C39** `QuotePanel.tsx:348` — the "max" button does `Math.floor(quote.maxExecutable)`,
  so a fractional sell position (e.g. 2.5 held, label prints "max ≈ 2.50") can never be
  fully closed via the button. Floor only on buys.
- **C40** `PrefsContext`/`format.ts` — precision/compact prefs mutate module globals and
  rely on re-render; `memo`-ized components (BeliefChart tick labels) keep old formatting
  until their data props change. Cosmetic, self-corrects on the next belief tick.

**Math doc**
- **C41** `docs/math/index.html:1690` — the §20 legend always shows the "BMM today
  (soft-cap baseline)" swatch even though that curve only renders when the default-off
  toggle is on. Cosmetic.

**Docs (open)**
- **O1** [Low] `docs/README.md` presents itself as the documentation index but omits
  `v3/HEDGING.md` (the official hedging companion, linked from four other docs), the
  active `multi model/` track, the v2 explainers (`belief-and-exposure.md`,
  `trade-to-signal.md`), and `docs/math/`.
- *(Info, verified OK: `v3/TASKS.md:78` "multi-node (V2-7)" is correct under the new
  numbering — V2-7 Hardening holds the multi-node load/chaos items — though the multi-node
  infrastructure itself is built in V2-4 Scale & ops.)*

---

## Verified correct (both passes — checks that found nothing)

- **Pricing**: all Gaussian closed forms (LINEAR/CALL/PUT/BINARY/SPREAD/GAUSSIAN incl.
  put-call parity and `priceGaussianPayoff`) re-derived by hand and matched numerically;
  mixture pricing by linearity exact; all Gaussian/mixture `∂Price/∂μ` match finite
  differences. (Student-t binary/spread is C10.)
- **Bayes / mixture / Student-t**: precision-weighted updates match the spec; mixture
  log-sum-exp responsibilities conserve information (Σw·r_k = w); law of total variance,
  prune/merge/cap, K=1→Gaussian reduction, `s²ν/(ν−2)` + ν>2 guards, Marsaglia–Tsang
  sampler all correct. `numerics.ts` series/CF boundary continuous to 4e-9; `Phi`, `normInv`
  exact to ~1e-16 at finite args.
- **Spread / solvency / signal**: term structure matches MODEL.md §4.3 with the documented
  TDD corrections; inventory uses the corrected `|mmShort+q|` convention; 99% VaR MC matches
  analytic Gaussian VaR; breakers, config defaults vs MODEL.md §14.1, sim accounting all
  check out.
- **API**: consistent lock ordering everywhere (market `FOR UPDATE` before user — no
  deadlock); money signs per TDD §2.1 across tradeSvc/tradeMath/ledger/reconciliation;
  `solveFill` and the accept gate share the same pre-update belief and 1e-6 slack (quote
  and commit can't disagree); buy premium correctly excluded from backing; trader/LP
  claims, resolve, and seed-upsert idempotent; auth guards + WS topic ACL sound; JWT role
  re-read per request; password hash never leaks; migrations 0000–0003 match `schema.ts`;
  WS events publish after commit inside per-market serialization (order = commit order).
- **Web**: `clientQuote.estimateQuote` exactly matches `tradeMath.execPriceFor`; sell
  `maxPrice`-as-floor semantics correct end-to-end; `projectBelief`'s cfg cast safe (API
  stores fully-defaulted cfg); viz math (FWHM, t-scale conversion, Z₈₀, LP previews)
  matches core; socket topic discrimination matches server payloads; PriceCurveChart memo
  keys genuinely invariant; pointer-capture makes BeliefChart drag-leave safe.
- **Math doc**: math.js engine port is **bit-exact (0 relative diff)** vs `packages/core`
  across all 7 contract types × 9 (μ,σ) points × 6 trade sizes for price, dPriceDMu,
  extractSignal, bayesUpdate, computeSpread, bayesUpdateMixture (incl. merge/prune); §20
  widget swept over all 673 log-slider steps × toggle × full curve sampling with **zero
  NaN/Infinity**; congestion ≈0 below u=0.02, finite at the wall; every DOM id referenced
  resolves uniquely; dev sections 0–21 and trader sections 1–12 contiguous, TOC/anchors
  consistent; KaTeX 469/469 `\(\)`, 41/41 `$$` pairs; §20 prose formulas match the code.
- **Docs**: exhaustive V2-n/V3-n grep over docs + source — every reference matches the
  final numbering (V2-1…V2-8, V3-1…V3-6, hedging = V3-4 = Workstream D); zero V2-9/10/11
  orphans; zero hedging-as-V2; all relative links + anchors in all 24 md files resolve;
  all ~60 MODEL.md §-references map to real headings; params (`gamma=0.0005`,
  `reserveAlpha=0.99`, `OPEN_MARGIN=1.2`, `qMax=500`, `s0=0.01`, MC=50000,
  `numeric(20,8)`) consistent across docs and code; the MODEL.md §7.2/§6.2 sign
  inconsistency remains explicitly flagged-and-corrected in `v1/TDD.md §2.1` (accepted).

---

## Methodology note

Pass 2 ran six independent reviewers (one per area + one dedicated to re-verifying pass-1
findings), then an adversarial round: every High/Medium candidate went to a fresh verifier
instructed to refute it, reproducing numbers against the real package code (`bun` harnesses
in /tmp). Outcomes: 0 refuted, C14 downgraded Medium→Low (unreachable today), C13's
unguarded-trade path upgraded within Low/Medium to Medium (contradicts visible UI state in
a trading flow). Low/Nit items were verified by direct code reads and spot-run snippets
(`Phi(∞)`, `round8` ties, line refs). Tests were re-run after the D4–D6 fixes: all green.
