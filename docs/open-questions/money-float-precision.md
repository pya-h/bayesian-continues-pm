# Money precision on float64 — do we need scaled integers?

Balances are `numeric(20,8)` in Postgres but ride on JS `number` (float64) everywhere
in between, and every balance-touching op goes through `round8` in `packages/shared/src/money.ts`.
That rounding multiplies by `1e8`, so once `|amount| > 2^53 / 1e8 ≈ 9.007e7` the scaled
value loses integer precision and 8-dp rounding silently coarsens — even though
`numeric(20,8)` advertises 12 integer digits. The limitation is noted in `money.ts`; this
is where I decide whether it's worth acting on.

## Is it reachable?
Not in the seeded economy. The admin is infinite (balance checks skipped, `balanceAfter`
null), demo users start at 10k, and pool cash grows only with LP deposits and premiums —
all orders of magnitude under 9e7. So today it's latent, not live. It becomes reachable only
if a single account or pool is funded past ~90M play-dollars, which nothing in the current
flows does.

## Options

**A. Leave it, keep the documented cap.** Cheapest. The `money.ts` note already states the
ceiling; add an assertion in the admin top-up path that rejects a single grant that would push
a balance over, say, 1e7, so the rail is enforced rather than merely documented. Pro: zero
churn, no perf cost, matches the play-money scope. Con: the invariant lives in a guard, not the
type — a future feature that sums many balances could still drift.

**B. Scaled BigInt integers (store minor units).** Represent money as `bigint` in units of
1e-8 end to end; format only at the display edge. Exact for any value `numeric(20,8)` can hold,
kills the whole class of drift. Pro: correct by construction. Con: touches every arithmetic site
(`add/sub/mul/sum` and every service that does balance math), `mul` by a fractional price needs a
rounding policy on the integer product, and the DB↔JS boundary has to carry bigint. Real work for
a limitation that isn't currently reachable.

**C. A decimal library (decimal.js / big.js).** Drop-in-ish behind the `money.ts` facade. Pro:
arbitrary precision without hand-rolling bigint scaling. Con: a runtime dep on a hot path, and the
`core` math (belief/θ) deliberately stays float64 — mixing a decimal type into the money layer only,
while pricing returns floats, still needs a float→decimal boundary at every premium/payout.

## Leaning
A, for now — enforce the cap in the top-up path so the documented invariant is actually held, and
revisit B only if the product ever needs balances in the tens of millions. The money facade
(`money.ts`) already isolates every arithmetic site, so a later switch to B is a contained change;
that's the reason to keep all math funnelled through it rather than inlining `+`/`-` on balances.
