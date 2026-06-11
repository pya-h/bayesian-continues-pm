# The Soft-Cap Approach — replacing the capacity cliff with a price ramp

> Deep-dive on option **§3.C** of [expanding-capacity.md](expanding-capacity.md):
> make the *price itself* choke off buying smoothly as a market fills, instead of
> letting trades sail along and then hit a hard rejection at the solvency wall.
>
> Engine references: spread in
> [`packages/core/src/spread.ts`](../../packages/core/src/spread.ts), the gate in
> [`apps/api/src/services/tradeMath.ts`](../../apps/api/src/services/tradeMath.ts)
> and [`apps/api/src/services/tradeSvc.ts`](../../apps/api/src/services/tradeSvc.ts),
> the reserve in [`packages/core/src/solvency.ts`](../../packages/core/src/solvency.ts).
> Build plan: [TASKS.md](TASKS.md).

---

## 1. "But doesn't the price already change when I buy?" — yes, it does

This is the most common confusion, so it's worth nailing first. **Two different
things move when you place a buy, and only one of them is the soft cap.**

### Effect 1 — the fair value moves (belief update)

Every buy is read as a signal and runs a Bayesian update on the consensus
`N(μ, σ²)`: μ shifts toward your bet, σ shrinks. Because every contract's fair
price is `E_belief[payoff]`, moving μ reprices *the whole curve*. Buy a call
struck at K → μ ticks up → that call (and everything in-the-money above it) gets
more expensive.

This is **"the crowd now believes the outcome is higher"** — a permanent mark
move that reflects the consensus, **not a fee**. It is the main price change you
see, and it is symmetric: a later sell pushes μ back down.

### Effect 2 — the spread widens, including an inventory term

Execution price is `fair ± spread`, and the spread already carries an **inventory**
component ([`spread.ts`](../../packages/core/src/spread.ts)):

```
inventory = gamma · |mmShort + q| · |fair|
```

`mmShort` is how much the pool is *already* short that specific contract, so the
more people have bought a given contract, the wider its ask becomes. **This is a
real, per-contract price penalty that exists today** — exactly the effect your
intuition is pointing at.

So: yes, buying a contract raises its price, both through the consensus moving (μ)
and through the inventory skew. The soft cap is **not** introducing
price-responds-to-flow from scratch.

### Why that isn't enough today

- **The inventory penalty is gentle and linear.** `gamma` is tiny (≈ 0.0005 in a
  typical market) and the term grows *linearly* in `mmShort`. Near the capacity
  frontier it's often still small relative to fair, so it doesn't actually *choke
  off* demand — people keep buying.
- **It's blind to capacity.** That inventory term rises the same whether the pool
  has vast headroom or is one dollar from the solvency wall. The thing that
  *actually* stops you — the `cash ≥ 1.2 × reserve` gate — is a **separate, binary
  cliff** bolted on at the end.

So today's shape is **gentle drift, then a brick wall** (the abrupt
"insufficient capacity" rejection).

---

## 2. The idea: cliff → asymptote

The soft cap adds a **capacity-aware congestion premium** to the price: a term
that is ~0 when the pool has plenty of headroom and rises *convexly toward
infinity* as the pool's exposure approaches its solvency frontier. Then the
economics price out further buying **before** the wall — a rational trader slows
to a stop on their own, and the market **never has to issue a hard rejection** in
practice.

```
today:     ▁▁▁▁▁▁▁▁█    flat-ish, then a wall  → "trade rejected"
soft cap:  ▁▁▂▃▅▇███     ramps ever steeper, demand dies on its own
```

Same family of effect you already see (price climbs as people pile in), retuned
so it does the **whole** job of limiting risk smoothly, rather than handing off to
a hard gate at the very end.

---

## 3. Reference design (the math)

All quantities are already available in the trade pipeline — `solveFill` computes
`reserveBefore` and `reserveAfter(q)` for exactly this kind of check, and pool
`cash` is on the market row.

Let, for a candidate fill of size `q`:

- `R₀ = reserveBefore` — the pool's 99% reserve before the trade.
- `R₁ = reserveAfter(q)` — the reserve if the trade fills (monotonically rises
  with a risk-opening buy).
- `C = cash` — pool cash backing the book.
- **Utilisation** `u(q) = (m · R₁) / C`, where `m` is a soft reference margin
  (e.g. 1.0). `u → 1` means "about to exhaust capacity."

Define the **congestion premium** (a price add-on, in payout units, like the
other spread terms):

```
congestion(q) = κ · |fair| · ( u(q)^a / (1 − min(u(q), 1−ε)) )       if R₁ > R₀
              = 0                                                     otherwise
```

- `κ` (kappa) — overall strength.
- `a` — convexity exponent (how late the ramp bites; larger ⇒ flatter until very
  close to the frontier).
- `ε` — a tiny floor so the term stays finite for the solver.
- The `R₁ > R₀` guard means **only risk-increasing trades pay it**; sells and
  offsetting trades (which *free* capacity) pay nothing.

Properties this guarantees:
- **u small → congestion ≈ 0.** Healthy markets are unchanged — important for
  backward compatibility (existing markets keep behaving exactly as today).
- **Monotonic & convex in `u`**, and `→ ∞` as `u → 1`. The closer to the wall, the
  steeper the price — so demand chokes off before the wall.
- **Monotonic in size `q`** (since `R₁` rises with `q`), so `solveFill`'s binary
  search stays valid — the only change is that the marginal price now climbs as
  size grows.

The new execution price for a buy becomes:

```
execPrice = fair + base + inventory + adverseSelection + volatility + congestion
```

i.e. `congestion` is just a **fifth spread component**, surfaced in the same
breakdown the UI already shows.

---

## 4. What soft cap does **NOT** do (read this carefully)

1. **It does not remove the solvency guarantee.** The hard `cash ≥ margin · reserve`
   gate **stays** as a final backstop (at a tighter `hardMargin`, e.g. ~1.05). The
   congestion premium just makes the price so high near the frontier that the hard
   gate is never reached in practice. Payouts remain fully backed — a contract
   still pays exactly what it promises. (Contrast the **§3.D solvency-factor
   haircut**, which *does* change payouts and route risk to winners — a different,
   later option.)
2. **It does not, by itself, raise the absolute ceiling.** Capacity is still
   `capital ÷ risk`. Soft cap converts the *cliff into a ramp*; it does not add
   capital. To genuinely let a market underwrite *more* total risk you still need
   to add capital (**LP deposits / insurance fund §3.E**) or shed risk (**hedging
   §3.F**). Soft cap is about **market quality and UX at the limit**, not a bigger
   limit.
3. **It is not a haircut and not auto-deleveraging.** No existing position is
   touched, closed, or reduced; nobody's payout is scaled. It only affects the
   *price of new risk-increasing trades*.

In short: soft cap makes hitting the wall **graceful, economically honest, and
self-correcting**, while keeping every guarantee the gate currently provides. It's
the right first step; the capacity-*expanding* options (insurance fund, hedging,
or the deliberate haircut) layer on top later.

---

## 5. The V1 nuance: there's no per-range price in a single Gaussian

A natural way to picture this is *"buying a range pushes up the price of that
range."* In **V1 the belief is one Gaussian**, so you can't lift a single range
independently — a buy shifts the whole `μ/σ`, which reprices the entire curve at
once. The only truly *local*, per-contract effect today is the inventory term.

The literal "raise *that specific region's* price" behaviour belongs to **V2
multi-modal beliefs**: there, a range/bell bet can grow a *local* component of the
belief instead of dragging the global mean, so the bump concentrates where you
bet. The soft-cap congestion premium is orthogonal to that and works in both
worlds (it keys off pool-level reserve utilisation, not the belief's shape).

---

## 6. Why this is the recommended first move

- Fixes the actual complaint — markets stop *silently freezing*; they always quote.
- Preserves solvency and payout guarantees (no product change, no trust cost).
- Reuses machinery that already exists (`reserveBefore`/`reserveAfter` in
  `solveFill`, the spread breakdown, the quote/execute agreement path).
- Healthy markets are untouched (`congestion ≈ 0` away from capacity).
- Composes cleanly with the capacity-*expanding* options for later.

See [TASKS.md](TASKS.md) for the phased build plan.
