# Expanding Capacity — ways to relax the solvency gate, and what each costs

> Follow-up to [solvency-and-capacity.md](solvency-and-capacity.md). That doc
> explains **why** buys get gated (the pool must hold a 99% reserve so it can
> always pay claims). This doc answers the next question: **can we bypass the
> limit** — e.g. with a "solvency factor" that scales final payouts — **and what
> are the consequences of each option?**
>
> This is a design/options memo, not a committed plan. Nothing here is
> implemented in V1. Several items map onto existing V2 workstreams (noted).

---

## 1. The one law you can't repeal

> **Capacity = capital ÷ risk.** A pool can only promise to pay what its cash can
> cover. The solvency gate doesn't *create* the limit — it just *enforces* it
> early, so the pool never reaches resolution owing more than it holds.

That means **every "bypass" is really a choice about who absorbs the shortfall**
when exposure outruns cash. There is no option that conjures capacity for free;
each one routes the tail risk to a different party:

| Bypass routes the shortfall to… | Mechanism family |
|---|---|
| **Nobody** (just less buffer) | tune the margin / reserve knobs (§3.A, §3.B) |
| **The price** (piling on gets costly, never blocked) | soft cap via inventory skew (§3.C) |
| **Winning traders** (payouts get haircut) | **solvency factor / pro-rata haircut (§3.D — your idea)** |
| **A shared fund** | insurance-fund backstop (§3.E) |
| **An external counterparty** | hedging / reinsurance (§3.F) |
| **Opposing traders** (forced to close) | auto-deleveraging (§3.G) |
| **The product itself** (smaller/known tails, or endogenous payouts) | bounded contracts (§3.H), parimutuel (§3.I) |

The rest of the doc is those rows, each with **how it works · what it buys ·
consequences · V1/V2 fit**.

---

## 2. Quick recap of the current rule

On every buy (which always *raises* the pool's short exposure), the engine
requires (`tradeMath.ts` / `tradeSvc.ts`):

```
cash ≥ OPEN_MARGIN × requiredReserve_after      OPEN_MARGIN = 1.2,  reserveAlpha = 0.99
```

So two dials already exist (`OPEN_MARGIN`, `reserveAlpha`) and the rest of this
doc adds structural mechanisms.

---

## 3. The options

### A. Lower the open-margin buffer (1.2 → 1.0)

**How.** Drop `OPEN_MARGIN` toward 1.0, so the pool opens risk right up to the
hard solvency line instead of insisting on 20% headroom.

**Buys.** A little more capacity — the "no-buy band" [1.0, 1.2) disappears, so a
solvent market stops freezing buys.

**Consequences.** Removes the safety cushion. The reserve is a *Monte-Carlo
estimate* with sampling error, and the belief moves between sizing and
resolution; the 1.2× exists to absorb both. At 1.0× a market can tip into actual
insolvency on estimation noise or an adverse belief drift. **Low effort, but it
trades a real safety margin for a modest capacity bump — it doesn't lift the
ceiling, only removes the cushion.**

**Fit.** V1-tunable today (one constant). Recommended floor ~1.05–1.1, not 1.0.

---

### B. Lower the reserve confidence (`reserveAlpha`, 0.99 → 0.95)

**How.** Reserve the 95th-percentile worst case instead of the 99th. Smaller
reserve for the same book → more headroom.

**Buys.** Directly more capacity (reserve shrinks).

**Consequences.** A pure **capacity-for-ruin-probability** trade: at α=0.95 the
pool is, by construction, under-reserved in the worst ~5% of resolutions instead
of ~1%. You're choosing to be insolvent more often. Honest only if paired with a
backstop (§3.E) or a haircut (§3.D) to handle the cases you stopped reserving for.

**Fit.** V1-tunable (one config value), but changing it silently weakens the
claim guarantee — should be a deliberate, disclosed policy.

---

### C. Soft cap via dynamic pricing / inventory skew recommended

**How.** Replace the hard wall with **economics**: as the pool's exposure to one
side grows, steepen the inventory component of the spread (raise `gamma`) so each
additional unit of the crowded side costs more, asymptotically approaching
"infinitely expensive" near the capacity frontier. Buys are *never blocked* —
they just get priced out.

**Buys.** The market never "freezes"; it always quotes. Piling onto an already
crowded bet simply becomes a bad deal, which is the correct economic signal.

**Consequences.** Preserves the payout guarantee **and** solvency — the best of
both. The cost is UX/calibration: prices near capacity get steep, which can
surprise traders, and you must tune the skew so it bites *before* the hard gate
would. It doesn't raise the absolute ceiling (capital still bounds it); it just
converts a cliff into a smooth, self-limiting ramp.

**Fit.** V1-feasible — the inventory term already exists in `computeSpread`; this
is mostly a re-tuning + keeping a hard gate only as a final backstop. **This is
the cleanest "bypass" because it removes the *freeze* without breaking any
guarantee.**

---

### D. Solvency factor / pro-rata payout haircut ← your proposal

**How.** Stop blocking buys. Let exposure exceed cash. At resolution, compute the
total owed to winners `W = Σ payoff(θ*)·qty`, the pool cash `C`, and a **solvency
factor**

```
s = min(1, C / W)          # 1 in normal times; < 1 only when the pool is short
```

Then **every winning position is paid `payoff·qty·s`**. The pool pays out exactly
`min(C, W)` and **can never go insolvent by construction** — the shortfall is
absorbed by the winners, pro-rata.

**Buys.** Removes the capacity ceiling almost entirely: the gate is no longer
needed to *protect* solvency (the haircut does), so buys flow freely.

**Consequences — this is the option with the most strings attached:**

1. **It changes the product.** A contract no longer pays a *fixed* amount; it
   pays a *contingent* amount. "Binary pays \$1" becomes "pays **up to** \$1." The
   credit guarantee that makes a prediction market feel like a real instrument is
   replaced by counterparty risk on the pool.
2. **Mispricing unless quotes are discounted.** Fair price today = `E[payoff]`. If
   the realized payout is `payoff·s`, the *fair* price is `E[payoff·s] <
   E[payoff]`. If you keep charging the full fair price but pay a haircut, the
   house systematically overcharges and **LPs profit at winners' expense** — a
   hidden tax. Pricing it correctly requires forecasting `s`, which depends on the
   *final aggregate* exposure (not known at trade time) — circular and hard.
3. **Bank-run dynamics near capacity.** Sells are *not* haircut (they transact at
   current cash). So a rational holder of the crowded side races to **exit before
   resolution** to bank full value. First movers get 100%, stragglers eat the
   haircut. That stampede is unfair and volatile — though it *does* self-correct
   exposure (everyone selling reduces the pool's short).
4. **Cross-contract contagion.** `W` aggregates the *whole* market's payouts from
   one shared cash pot. A blowup in one crowded contract haircuts winners in
   *unrelated* contracts too. Someone holding a "safe," clearly-winning bet still
   gets 60¢ on the dollar because a different bet drained the pool. Independent
   trades become correlated through `s`.
5. **Moral hazard for LPs.** The haircut caps LP downside (the shortfall lands on
   winners, not LPs), so LPs have *less* incentive to hold adequate capital — the
   very mechanism meant to handle under-capitalization quietly rewards it.
6. **Settlement complexity & disputes.** `s` must be computed atomically at
   resolution with careful rounding and a clear audit trail; "why did I only get
   60%?" becomes a support/legal surface. Must be disclosed up-front.

**Net:** it *works* to remove the block, but it silently converts fixed-odds into
"fixed-odds-minus-a-pro-rata-haircut" and **moves the tail risk onto winning
traders**. Defensible as an explicit, disclosed last-resort backstop; dangerous
as a routine capacity source unless quotes are discounted for expected haircut
and the run dynamics are managed.

**Fit.** Implementable in V1 settlement, but it's a product/policy decision, not
just a code change. Best used as a **last-resort floor under §3.C**, not as the
primary lever.

---

### E. Insurance-fund backstop (→ V2-H)

**How.** A shared fund (protocol treasury / pooled fees) tops up any market that
reaches resolution short. Effectively raises each market's cash with mutualized
capital.

**Buys.** More real capacity, *without* haircutting winners (the fund pays the
gap).

**Consequences.** The fund is finite and mutualizes risk **across** markets — one
market's blowup can drain it and weaken others. Needs a funding policy (fee
skim), draw rules, and replenishment. It's the "right" way to socialize tail risk
because it's *capitalized in advance* rather than taken from winners after the
fact.

**Fit.** Already a planned V2 workstream (insurance fund). The principled upgrade
path.

---

### F. Hedging / reinsurance (→ V2-D)

**How.** The pool offloads tail exposure to an external counterparty/instrument,
lowering the *required reserve* for the same book — so the same cash backs more
exposure.

**Buys.** Genuinely lifts the ceiling (less reserve per unit of risk), with no
guarantee broken.

**Consequences.** Needs real hedging instruments/counterparties and introduces
**basis risk** (the hedge doesn't track the liability perfectly) and counterparty
risk. Operationally heavy.

**Fit.** V2 hedging workstream. Powerful but the most infrastructure.

---

### G. Auto-deleveraging (forced unwind)

**How.** When capacity is exhausted, *forcibly* close the most-profitable
opposing positions (as crypto perp exchanges do) to free reserve, instead of
blocking new buys.

**Buys.** Keeps the market open by reclaiming capacity from existing holders.

**Consequences.** Brutal UX — users get their winning positions closed against
their will; widely disliked even where it's standard. Complex selection logic and
audit trail. Effectively transfers the squeeze to opposing traders.

**Fit.** Possible but high-friction; not recommended for a retail prediction
market.

---

### H. Restrict to bounded-payout contracts

**How.** Disallow (or cap) unbounded-payout types (Linear, deep Call) whose tail
liability explodes the reserve; favour Binary/Spread/capped contracts with a
**known maximum** payout.

**Buys.** Smaller, predictable reserves → more effective capacity for the same
cash, and tighter MC estimates.

**Consequences.** Shrinks the product menu and the expressiveness of the market.
A policy/menu choice rather than a mechanism; complements the others.

**Fit.** V1-feasible (a contract-type allowlist or a payoff cap per contract).

---

### I. Parimutuel restructuring (endogenous payouts)

**How.** Change the game: instead of fixed-odds vs. a pool, make it a **closed
parimutuel** — winners split the losers' stakes. The pool then *never owes more
than was staked*, so solvency risk vanishes entirely.

**Buys.** Eliminates the capacity limit by construction (no fixed liability).

**Consequences.** It's a **different product** — payouts/odds are endogenous and
only known at settlement, the live "fair price" loses its current meaning, and the
whole Bayesian-belief + spread engine would be re-conceived. Your §3.D haircut is
really a *soft step* in this direction (parimutuel is the limit where the haircut
binds by design). A big architectural pivot, not a tweak.

**Fit.** Not V1/V2 as designed; noted for completeness as the logical endpoint.

---

## 4. Comparison

| Option | Capacity gain | Breaks payout guarantee? | Who bears the tail | Effort | V1-feasible |
|---|---|---|---|---|---|
| A. Lower open-margin → 1.0 | small | no (until it fails) | nobody (thinner cushion) | trivial | |
| B. Lower `reserveAlpha` | medium | no (until it fails) | nobody (more ruin events) | trivial | |
| **C. Soft cap (inventory skew)** | medium | **no** | the price | low–med | |
| **D. Solvency-factor haircut** | large | **yes** (contingent payout) | **winning traders** | med (policy-heavy) | (policy) |
| E. Insurance fund | large | no | shared fund (pre-funded) | high | V2 |
| F. Hedging/reinsurance | large | no | external counterparty | high | V2 |
| G. Auto-deleverage | large | no | opposing traders (forced) | high | |
| H. Bounded contracts | small–med | no | nobody (menu shrinks) | low | |
| I. Parimutuel | unlimited | n/a (redefines payout) | nobody (endogenous) | very high | |

---

## 5. Recommendation

1. **First, remove the *freeze* without breaking anything:** adopt **§3.C soft
   inventory skew** as the primary mechanism, and lower **§3.A** to ~1.05–1.1.
   Markets then always quote, pile-ons get economically priced out, and a hard
   gate remains only as a final backstop. No payout guarantee is touched. This
   resolves the "every buy rejected" UX directly.
2. **For real capacity growth, add capital, don't move the risk to winners:**
   prefer **§3.E insurance fund** (and later **§3.F hedging**) over the haircut.
   These keep contracts trustworthy.
3. **Treat your §3.D solvency factor as a disclosed last-resort floor**, not a
   routine lever. If used, it *must* be paired with (a) quotes discounted for
   expected haircut so LPs don't quietly tax winners, (b) prominent "pays up to"
   disclosure, and (c) acceptance of the run/contagion dynamics in §3.D. It is the
   easiest to ship and the most expensive in trust.

**Bottom line:** you can absolutely stop blocking buys — but capacity is capital
over risk, so every method either adds capital (§E/§F), shrinks risk (§C/§H), or
hands the shortfall to someone (your §D → winners, §G → opponents). The gate's
current job is to make that "someone" *no one*; relaxing it is a deliberate choice
of whom to expose, and should be made on purpose, with disclosure, not silently.
