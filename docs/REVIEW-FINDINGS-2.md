# Final review — round-3 findings (2026-06-12, HEAD eff4502)

Closing review after all 48 items from [REVIEW-FINDINGS.md](REVIEW-FINDINGS.md) were
fixed. Method: re-ran the full baseline; an independent auditor verified **every**
checklist item against the current code (re-deriving the math fixes in throwaway
harnesses); then four fresh adversarial hunters swept core/shared, the API, the web
app, and the docs + interactive math doc — explicitly told to skip everything already
known and to probe the surfaces earlier rounds covered least (fix interactions, edge
inputs, less-reviewed files). Every finding below was verified by execution or
line-level reading before being listed; nothing here is speculative.

## Baseline (all green)

| Check | Result |
|---|---|
| `bun run typecheck` (core, shared, api, web) | **0 errors** |
| `bun run test:core` | **196 pass / 0 fail** |
| `bun run test:shared` | **9 pass / 0 fail** |
| `bun run test:api` | **130 pass / 0 fail** |
| `bun run test:web` | **164 pass / 0 fail** |
| `bun run lint` | style-only diagnostics (docs/math JS), unchanged |

## Verification of the round-1/2 fixes: 48/48 hold

Every item in REVIEW-FINDINGS.md's fix plan — C1–C41 + O1, doc fixes D1–D6, the
regression tests, and the four documented-as-partial notes — is **present at HEAD and
does what it claims**. The math-heavy fixes were re-derived against the live packages:
Student-t binary/spread prices and `∂P/∂μ` are bit-identical to the cdf/pdf
identities, the CALL closed form is within 5e-7 of a 2M-node reference, the C14
far-mode repro returns 12.505, `Phi(±∞)` and extreme-tail quantiles are exact, and the
C2 win chance is exact on the bimodal-mixture test. Two fixes are mild refinements of
their checklist wording (C13's order-identity gate, C7's θ-denominated unit gating) —
both from the follow-up commit, both strictly satisfying the underlying finding.

---

## New findings — open

The fresh sweep found the items below. None invalidates a prior fix; the two Mediums
are the same *classes* as fixed bugs (C9's stranded-funds shape; C1/C10's quadrature
shape) surfacing in paths the earlier rounds didn't reach.

### C42 · [Medium — fixed 2026-06-14] GAUSSIAN payoff is mispriced on Student-t markets — the one payoff C1/C10 left on quadrature
**Fix:** added a bell-aware quadrature (`expectGaussianBump` in `pricing.ts`) whose
window covers BOTH the payoff bell (`c ± L·w`) and the belief (`μ ± L·σ`) with node
count resolving the narrower scale; wired into `priceUnderStudentT`'s GAUSSIAN branch
and `secondMoment`'s student-t GAUSSIAN path (via `expectGaussianBumpSquared`, width
w/√2). Exact to machine precision vs a 40M-node reference across far-center,
narrow-width, and the contrived far-AND-narrow corner; `dPriceDMu` (central-difference
of the now-exact price) follows. Regression test added.

`packages/core/src/pricing.ts:82-83` — `priceUnderStudentT`'s default branch sends the
GAUSSIAN (bell) payoff through `expectF` (±10σ window, 4000 nodes ⇒ cell h = σ/200),
on the assumption it's "smooth and bounded, so quadrature is fine". Two reachable
regimes break that:

1. **Far center** (|c − μ| ≳ 10σ): the bump sits outside the window entirely.
   Verified at ν=3, sd=10: center at 11σ → priced 1.92e-6 vs true 5.47e-5 (**−96.5%**);
   at 15σ → ~0 vs 1.58e-5 (**−100%**). On a fat-tailed market — whose entire point is
   that tail outcomes stay plausible — a tail point-bet is priced as impossible.
2. **Narrow width** (w ≲ σ/200): the bump fits inside one Simpson cell → O(h) error.
   Verified: w = σ/400 → **−21.8%**.

The knock-ons mirror C10: `dPriceDMu` central-differences the same quadrature
(`pricing.ts:180-184`) and `secondMoment` integrates `payoff²` (effective width w/√2 —
narrower still) via `expectF` (`stats.ts:76`), so the adverse-selection spread and
`payoutStd` inherit the error. Fully schema-reachable (`student_t` belief + GAUSSIAN
spec with any positive width). **Fix:** widen/center the window on the *payoff bump*
(c ± 10w joined with μ ± 10σ) and scale nodes to resolve w; or integrate in the
bump's own coordinates. (No closed form exists under t, so quadrature stays — it just
must see the bump.)

### C43 · [Medium — fixed 2026-06-14] Admin `close` permanently strands all unclaimed trader payouts and LP claims
**Fix:** claims stay open on CLOSED — `claimPayout` (settleSvc) and LP `claim` (lpSvc)
now accept `SETTLED || CLOSED`, and the web claim UI (`derive.ts` claimable,
`PositionPanel`, `LpPage`) mirrors it. Settlement already computed the payouts and
froze the pool, so collecting after archival is safe and idempotent; CLOSED still
blocks trading. Minimal and low-risk vs. an auto-sweep, and it never strands an
abandoned account's winnings. Regression test: claim succeeds after close.

`apps/api/src/services/marketSvc.ts:43` — `close: { from: ['SETTLED'], to: 'CLOSED' }`
and the state machine has **no transition out of CLOSED**. `claimPayout` rejects
non-SETTLED (`settleSvc.ts:142-144`) and LP `claim` likewise (`lpSvc.ts:414-416`), and
the route (`adminMarkets.ts:53-56`) has no pending-claims guard or warning. So:
resolve → settle → some traders/LPs haven't clicked Claim → admin archives the market
("CLOSED: archived/read-only" per TDD §10) → those payouts are permanently
uncreditable. Same stranded-funds-in-a-terminal-state shape as C9, triggered by a
routine admin action with zero feedback. No test covers claim-after-close.
**Fix options:** block `close` while unclaimed claims / unclaimed LP positions exist;
auto-credit on close; or allow claims through on CLOSED.

### C44 · [Medium-Low] A transient outage at page load silently logs the user out
`apps/web/src/auth/AuthContext.tsx:30-34` — the mount-time `api.me()` has a
catch-all `…catch(() => setToken(null))`. The comment says "stale/invalid token →
drop it", but `request()` throws `ApiError(0, 'Network error…')` when fetch itself
fails and 5xx ApiErrors for proxy problems — all of which destroy a perfectly valid
7-day token in localStorage. Repro: valid session, API briefly unreachable (laptop
wakes before Wi-Fi), refresh → logged out for good. **Fix:** drop the token only on
401/403; on status 0/5xx keep it (render logged-out state or retry).

### C45 · [Low — fixed 2026-06-14] Student-t binary ask can exceed the contract's max payout (spread unbounded as ν→2)
**Fix:** `execPriceFor` now clamps to the contract's payoff bounds — ask capped at the
max payout, bid floored at the min (0) — for bounded kinds; unbounded CALL/PUT keep
only the bid's 0 floor. Threaded the spec through all call sites (solveFill + the three
tradeSvc paths) so quote and commit agree, and mirrored in the web `clientQuote`
estimate. Still fully prefunded (collecting ≤ max premium covers the worst-case
per-unit liability). Regression test added.

`packages/core/src/spread.ts:45-46` — `adverseSelection = λ·intensity·|∂P/∂μ|·σ`.
C10 made `|∂P/∂μ| = pdf(K)` exact; under Student-t, `pdf(K)·σ = f_std(d)·√(ν/(ν−2))`
diverges as ν→2⁺. Stock defaults, BINARY_CALL at K=μ, q=qMax: ν=2.5 → ask **1.04**;
ν=2.1 → **1.45**; ν=2.05 → **1.77** — above the binary's max payout of 1 (Gaussian
counterpart is bounded at ask ≤ ~0.83). The MM only overcharges (safe), but the
contract becomes untradeable and the UI shows a nonsensical ask. **Fix:** cap the
ask at the payoff's upper bound for bounded contracts, or cap the AS term's
`|∂P/∂μ|·σ` factor.

### C46 · [Low — fixed 2026-06-14] Astronomically large schema-valid inputs propagate NaN / silent belief corruption
**Fix:** added an outcome-axis magnitude ceiling (`OUTCOME_BOUND = 1e12`) to the shared
zod schemas — strikes/centers/bounds/μ bounded to ±1e12, widths/σ to (0, 1e12],
variances to (0, 1e24] — across `contractSpecSchema`, the belief state/create schemas,
and `createMarketSchema`. Keeps (θ−μ)² ≤ ~4e24 (far from the ~1e155 overflow regime)
while accepting any realistic outcome. Regression test added.

`packages/shared/src/dto.ts:16-21` and `contracts.ts:36-41` only require `finite`, so
strikes/centers up to ~1.8e308 pass validation. Verified: |μ| or strikes at 1e9 are
all fine, but at ≳1e155: mixture `updateBelief` **throws** (`exp(NaN)` responsibilities);
Gaussian **silently** corrupts μ to ~1.7e299 (no error — a market's belief bricked by
one trade quote); Student-t CALL price returns **NaN** (`0·Inf` in the closed form);
GAUSSIAN width < ~1e-162 underflows to a NaN payoff. **Fix:** put a sane magnitude
bound (e.g. |x| ≤ 1e12) on strikes/centers/widths in the shared schemas.

### C47 · [Low — fixed 2026-06-14] Sell-all broadcasts stale `price_change` fairs for all but the last contract
**Fix:** after the close loop (inside the tx, where `liveBelief` is final) every
touched contract's fair is re-marked at the final belief, so the post-commit
`price_change` events agree with the single committed `belief_update`.

`apps/api/src/services/tradeSvc.ts:748` snapshots each closed contract's fair at the
belief *right after that contract's own close*, while later iterations keep moving
the belief; `:817-823` then publishes those per-step fairs post-commit. A 3-position
sell-all emits two `price_change` events inconsistent with the `belief_update` in the
same batch. **Fix:** recompute the fairs from the final `liveBelief` after the loop.

### C48 · [Low — fixed 2026-06-14] Mixture markets: genesis history point and `beliefDrift` trust the authored `initialMu/σ`, which nothing validates
**Fix:** at creation the `initialMu/initialSigma` columns now store the genesis belief
*summary* (`belief.mean()/.stddev()` — Σπμ and total σ for a mixture), not the raw
authored values. The cfg reference scale is still seeded from the authored μ/σ
(computed before the insert), so nothing else shifts; Gaussian/Student-t are unchanged
(summary == authored). Corrects all three readers at once — the history genesis point,
the drift baseline, and the breaker σ₀. Regression test added.

A mixture market is created with both `initialMu/initialSigma` and components, and no
check ties them (`createMarketSchema`); the true genesis mean is Σπ·μ. But
`statsSvc.ts:207-209` prepends `{mu: initialMu, sigma: initialSigma}` as the first
belief-history point and `:143` computes `beliefDrift = currentMu − initialMu`. Author
components averaging 100 with `initialMu: 90` and the chart starts at 90 with +10
"drift" before any trade. **Fix:** use the creation-time belief summary for the
synthetic first point and the drift baseline (or validate consistency at creation).

### C49 · [Low] No mid-session 401 handling — zombie session after token expiry
JWTs expire after 7 days (`auth/plugin.ts:16`) but the web app checks the token only
at mount. A mid-session 401 leaves the header showing user + balance while every
authed call fails with raw "Unauthorized" notes; nothing clears the session or
redirects. **Fix:** on any 401 from `request()`, clear the token and route to /login.

### C50 · [Low] LP deposit/withdraw can report "failed" for a mutation that succeeded
`apps/web/src/pages/LpPage.tsx:240-249` — `onSuccess` ends with `await api.me()`.
Verified against the installed `@tanstack/query-core@5.101.0` source: a throw inside
`onSuccess` lands the mutation in **error** state. So if the balance refresh hiccups,
an executed deposit shows "Request failed." next to already-updated pool numbers, and
the un-cleared amount field invites a double deposit. **Fix:** fire-and-forget the
`api.me()` refresh instead of awaiting it.

### C51 · [Low] WS reconnect never resyncs — stale market state after a disconnect window
`apps/web/src/hooks/useMarketSocket.ts:56-66` — `onopen` only re-subscribes; events
missed while disconnected are simply lost, and with `refetchOnWindowFocus: false`
nothing else self-heals a mounted page. Kill the API for a minute, resolve the market
meanwhile, restore: the page shows "live" again but stays OPEN with old μ/σ until a
manual reload. **Fix:** when a reconnect follows a drop, invalidate
`qk.market/stats/historyAll`. (Nit: fixed 1.5s retry, no backoff/jitter.)

### C52 · [Low — fixed 2026-06-14] math.js `computeSpread` is Gaussian-only; core's is belief-kind-aware
**Fix:** routed `computeSpread`'s `fair`/`∂P/∂μ` through `priceAny`/`dPriceDMuAny`, so
the doc widget dispatches by belief kind exactly like core's `spread.ts`. Gaussian
beliefs fall straight through to the closed forms — verified numerically identical
(`priceAny`==`price`, `dPriceDMuAny`==`dPriceDMu`, maxdiff 0), so every current widget
call site is unchanged; a Student-t `BINARY_CALL` spread now prices its fair at the
kind-aware 0.1955 instead of the wrong Gaussian 0.2819. Companion nit also fixed:
mirrored core's C20 `erfcCF(+∞)=0` guard, so `Phi(±∞)` returns 1/0 instead of NaN.

`docs/math/math.js:212-225` prices `fair`/`dPriceDMu` with the Gaussian closed forms
even for mixture/Student-t beliefs, while core's `spread.ts` dispatches by kind.
Verified divergence: t binary spread −23%, mixture SPREAD fair 2.2× vs core. Latent —
every current widget call site passes a Gaussian — but it contradicts the port's
"kept in lockstep with spread.ts" header. **Fix:** route through
`priceAny`/`dPriceDMuAny`. (Companion nit: math.js `Phi/erf/erfc(±∞)` still return
NaN — the C20 guard wasn't mirrored; no widget passes ±∞ today.)

### C53 · [Low — fixed 2026-06-14] v1/TDD §10 still lists two routes that don't exist
**Fix:** aligned `docs/v1/TDD.md` §10 with the implemented surface — replaced
`GET /markets/:id/belief-history` with the real `GET /markets/:id/history` (noting its
`?contractKey=` series), dropped the non-existent `GET /markets/:id/trades` (recent
trades ride the WS `trade_executed` tape), and added the five implemented-but-undocumented
routes: `POST /markets/:id/sell-all`, `GET /users/me/transactions`,
`GET /admin/markets/:id/ledger`, `GET /admin/users/:id/transactions`, `GET /admin/audit`.

Pre-existing lines the C32 rewrite didn't touch: `GET /markets/:id/belief-history`
(actual: `GET /markets/:id/history`, `routes/stats.ts:25`) and `GET /markets/:id/trades`
(no such route). Also absent from the doc though implemented: `POST /markets/:id/sell-all`,
`GET /markets/:id/ledger`, `GET /users/me/transactions`, `GET /admin/audit`,
`GET /admin/users/:id/transactions`. **Fix:** finish aligning §10.

### Nits / info

- **C54** [Info] Residual corners of the C11 re-genesis fix: if the last LP can fully
  exit while MM shorts remain open (needs `1.2·VaR₉₉ ≤ E[L]` — heavy-tail books only),
  the shareless pool's later positive NAV is captured entirely by the first
  re-depositor (victimless but unearned), and a later *negative* NAV re-bricks
  deposits (`S_total = 0 ∧ nav < 0`). The plain withdraw-all → re-deposit → trade
  cycle is value-exact (verified).
- **C55** [Nit — fixed 2026-06-14] `AdminPage.tsx:343-364` MyMarkets/System sections
  render empty-state text ("You haven't created any markets yet." / zeroed stats) on a
  failed fetch — no error branch. **Fix:** both sections now short-circuit to an
  `ErrorNote` when their query errors (System OR-s the markets/users errors; Alerts
  still render above it), so a failed fetch reads as an error, not "empty".
- **C56** [Nit — fixed 2026-06-14] `PositionPanel.tsx:169-173` — the expanded
  per-position stats query (`qk.position`) is never invalidated by trade/claim
  successes; an open panel stays stale until collapsed/reopened. **Fix:** the trade and
  sell-all mutations (`QuotePanel`) now invalidate the `['position']` prefix, and the
  position-claim mutation (`PositionPanel`) invalidates its own `qk.position(contractId)`
  — so an open detail panel refetches in place.

---

## Verified clean in this round (highlights)

- **sim.ts** zero-sum accounting to 1.5e-11, bit-reproducible MC, engine genuinely
  learns; **breakers.ts** robust to NaN/Inf/exact-threshold inputs.
- `studentTCdfStd` exact at df → 0⁺ and |x| = 1e150; `studentTKinkSecondMoment`
  matches a tail-aware reference to 1.5e-12 at ν=2.001; put-call parity across
  |μ| ≤ 1e9, sd ≤ 1e6; quantile round-trips at ν=2.01.
- **API**: cancel-distribution × concurrency (consistent lock order, atomic deltas),
  settle internals (frozen `cashFinal` denominator, idempotent claims), audit-in-tx
  call sites all pass the tx, WS publishes still strictly post-commit, sell-all
  `priceMovePct` sign semantics match the breaker's `Math.abs`, no IDOR on position
  detail, CORS exact-match origin (verified in the installed package), ledger view
  reconciliation re-derived by hand incl. re-genesis labeling.
- **Web**: `quoteOrderKey` stringify stability across all four spec construction
  sites (and fail-safe by construction), C3 × C13 interactions (debounce starvation
  floored by the 30s refetch), fair-unit gating during drags, `historyAll` prefix
  scope, derive/txView/auditView/marketLedgerView label maps complete against the
  server enums, LP previews mirror lpMath incl. the genesis branch.
- **Docs/math doc**: 0 broken links/anchors across 24 md files; all JS parses; 78
  unique DOM ids all resolve; math.js↔core parity harness — Gaussian/mixture exact,
  Student-t closed forms bit-identical (worst 1.06e-13); §20 widget NaN-free over
  1.1M evaluations; every parameter table matches `config.ts`.

## Status

The original 48 findings remain **all fixed and verified**. This round's new items
(C42–C56) are now **all resolved** except **C54** (info-only — the documented residual
corners of the C11 re-genesis fix, value-exact on the normal cycle, left as a known
note). C42–C53, C55, C56 are fixed and verified; the full suite is green (505 tests)
and typecheck is clean.
