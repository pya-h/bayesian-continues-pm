# LP pool re-genesis when the share count hits zero

The LP pool tracks ownership by shares over `NAV = cash − E_p[L(θ)]`, share price = `NAV/S_total`.
The normal withdraw-all → re-deposit → trade cycle is value-exact (verified). Two corners remain
when `S_total` reaches 0 while the market still has open MM shorts — reachable only on a heavy-tail
book where `1.2·VaR₉₉ ≤ E[L]`, i.e. the reserve buffer sits below the expected liability, so the
last LP can fully exit while obligations are still open:

1. **Unearned capture.** After a full exit with shorts still live, a later positive NAV is captured
   entirely by the first re-depositor (they mint against a pool that already had value). Victimless —
   no existing LP is diluted, since there are none — but the re-depositor gets value they didn't
   fund.
2. **Negative-NAV re-brick.** If NAV is negative at the moment `S_total = 0`, the mint formula
   `ΔS = D·S_total/NAV` divides by a negative/zero base, so re-deposits are blocked until settlement.

This is the residual of the earlier re-genesis fix (logged as C54, info-only). It's not a
value leak on the normal path; it's a fairness/definedness gap in a rare book state.

## Options

**A. Leave it as a known note.** It needs a heavy-tail book AND the last LP fully exiting past the
solvency buffer — a corner the solvency gate already makes hard to reach, and no test economy hits.
Pro: no added complexity on the LP hot path. Con: the corner stays undefined if someone engineers it.

**B. Freeze the pool at zero shares.** When a withdrawal would take `S_total` to 0 while shorts are
open, block that last slice (leave a dust share outstanding), so the pool never enters the
shareless state. Pro: keeps share price defined at all times. Con: the last LP can't fully exit
while risk is open — a real (if small) liquidity restriction, and "dust share" accounting to get right.

**C. Re-genesis at re-deposit.** When `S_total = 0`, treat the next deposit as a fresh genesis:
mint `ΔS = D` at price 1 regardless of standing NAV, and socialize the pre-existing NAV into the
pool (so the re-depositor neither captures nor eats it — it accrues to all future shares pro-rata).
Handles both the positive and negative case uniformly. Pro: fully defined, fair. Con: most logic
for the least-reachable state; needs its own tests.

## Leaning
A. The gate makes the trigger state hard to reach, the normal cycle is already value-exact, and the
failure mode is "re-deposits pause until settlement" (safe) or "an unfunded gain to a re-depositor"
(victimless), not a loss to anyone. If a market design ever makes the heavy-tail shortfall state
routine, C is the principled fix; B is the cheaper stopgap. Not worth the code today.
