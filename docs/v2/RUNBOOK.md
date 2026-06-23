# Ops Runbook — BMM V2

Operational playbook for the V2 surface: **oracle resolution**, the **dispute** process, the **adaptive-parameter** controller, and the **circuit breakers**. Each entry: what you see → what it means → how to remediate. (Horizontal-scale failure modes — Redis outage, replica lag, leader flapping — live in the `scaling` milestone runbook, `docs/scaling/` S-5, and are out of scope here.)

> **How alerts surface.** Breakers publish a `system:alert` message to the **`system` WS topic**; the web **AlertsBanner** renders them live (transient — there is no persisted alert store). The durable trails are the **`oracles`** table (one row per feed read / resolution, including stale reads) and **`audit_events`** (every lifecycle transition + admin action). When triaging after the fact, query those, not the banner.

> **Escape hatches (always available to an admin).**
> - **Resolve any *implemented*-mode market, any time:** `POST /admin/markets/:id/resolve` (source `manual_admin`). Bypasses the deadline + assigned-oracle guards for `centralized`/`api` markets — the universal manual override. **Exception:** a `decentralized` market is refused (`501`) here too — that mode is an unimplemented placeholder, so there is no resolution path for it yet (don't create one until V-next ships UMA).
> - **Assigned-oracle resolve:** `POST /oracle/markets/:id/resolve` (role `oracle` or admin, post-deadline).
> - **Dispute queue:** `GET /admin/disputes?status=open` → `POST /admin/disputes/:id/resolve` (`uphold` overrides θ*, `reject` closes it).
> - **Adaptive control:** `GET/PATCH /admin/markets/:id/cfg` (pin σ_ε/s₀, or disable adaptation).

---

## 1. Oracle feed failure (`oracle_failure`) — `api`-mode markets

**Symptom.** An `oracle_failure` alert (severity `warning`, action `suspend`) on the banner; an `api`-mode crypto market flips to **SUSPENDED** at/after its `resolves_at`; trading on it halts.

**What it means.** At resolution time the xprices read was rejected as **bad data** and the market was suspended rather than resolved on a bad price (`MODEL.md §15.1`: *never resolve on a stale/missing feed*). A read is rejected when:
- `stale: true` in the response, **or**
- the reading's `timestamp` is older than `ORACLE_MAX_STALENESS_SEC` (default **300 s**), **or**
- the request failed/timed out (`ORACLE_FETCH_TIMEOUT_MS`, default **8 s**), or the service was unreachable / non-200, **or**
- the market has no `oracle_token` (misconfiguration — an `api` market must carry a token).

**Self-healing.** This is usually transient. The cron sweep (default cadence `ORACLE_CRON = */30 * * * * *`, every 30 s) **re-polls SUSPENDED past-deadline `api` markets**, so once the feed returns fresh data the next tick resolves the market automatically — no operator action needed. Confirm recovery: the market moves SUSPENDED → RESOLVED and a fresh `oracles` row appears with `source='api:xprices'`, `stale=false`.

**Triage / remediation.**
1. **Is it self-healing?** Watch one or two ticks (≤ ~1 min). If it resolves, done.
2. **Check the feed directly:** `GET {XPRICES_URL}/health` and `GET {XPRICES_URL}/prices/{token}`. Look at `stale` and `timestamp` age.
   - Feed healthy but market still stuck → check the **scheduler is running** (§5).
   - Feed down/degraded → it's an upstream xprices incident; the market stays safely SUSPENDED. Escalate to the xprices owner. Do **not** force a resolution on a price you can't trust.
3. **Persistent outage, must resolve now:** use the admin escape hatch `POST /admin/markets/:id/resolve` with a θ* you've verified out-of-band (records source `manual_admin`). This is the deliberate, audited override.
4. **Misconfigured token** (`api market has no oracle_token`): the market shouldn't have been created `api`-mode without a token. Resolve manually as above; fix the seed/creation path so it can't recur.

**Knobs.** `XPRICES_URL`, `ORACLE_MAX_STALENESS_SEC`, `ORACLE_FETCH_TIMEOUT_MS`, `ORACLE_CRON`, `ORACLE_SCHEDULER`.

---

## 2. Adaptive-parameter rail hit (`param_rail`) — V2-2 controller

**Symptom.** A `param_rail` alert (severity **`info`**, action `alert`); in the admin market's **Adaptive params** sub-tab a `rail:` badge shows a clamp is binding (e.g. σ_ε pinned at `2·σ₀`).

**What it means — usually nothing to do.** A clamped tuning parameter is an **envelope-edge signal, not a halt** (`MODEL.md §14.1`). The controller wanted to push σ_ε / s₀ / α / β past its safe rail and was clamped to the boundary. It does **not** suspend trading — that's by design (suspend-class breakers are rapid-move and insolvency, never a tuning clamp). Most often it means the market is simply more volatile than its genesis σ₀ assumed, and σ_ε riding its upper rail is the *correct*, honest response (the A/B sim shows this improves calibration in the volatile regime).

**When to act.** Only if the market's pricing looks wrong for the situation:
- **σ_ε pinned high** (rail `hi`) persistently and you believe the noise is genuine → leave it; this is the controller doing its job.
- **You want to stop auto-tuning** (e.g. a known data-quality issue is feeding garbage surprises): `PATCH /admin/markets/:id/cfg` with `{ "pinned": { "sigmaEps": <value> } }` to pin it, or `{ "enabled": false }` to freeze at the static baseline. Clear with `{ "pinned": {} }`.
- Review the σ_ε / s₀ history sparklines in the sub-tab to see whether it's oscillating (shouldn't — the EWMA is a stable, consistent estimator; see `core/test/sim.test.ts` "adaptive-parameter stability") or genuinely tracking a regime shift.

---

## 3. Trading circuit breakers (per-trade, `evalBreakers`) — `MODEL.md §15.1`

Evaluated post-fill against per-trade health. Three kinds:

| Alert | Trips when | Severity | Action |
|---|---|---|---|
| `belief_divergence` | σ > `sigmaRatio·σ₀` (default 3) | warning | alert admin |
| `rapid_price_move` | `|Δfair|/fair > priceMovePct` (default 10%) | warning | **suspend trading** |
| `insolvency_risk` | cash < `reserveRatio·reserve` (default 1.2) | critical | **reject trade**; cash < `reserveWarnRatio·reserve` (1.5) → warning alert |

**`belief_divergence`.** The market is far more uncertain than at genesis — often legitimate (real disagreement) but can indicate manipulation. Inspect recent trades and the belief chart; no automatic halt. If manipulation is suspected, SUSPEND manually (`POST /admin/markets/:id/suspend`).

**`rapid_price_move`.** A single fill moved the touched contract's fair > 10%. The market is auto-**suspended**. Triage: review the trade; if legitimate volatility, resume it (`POST /admin/markets/:id/resume` → back to OPEN); if abuse, keep suspended and investigate. Tune `priceMovePct` if the threshold is too tight for a genuinely volatile market.

**`insolvency_risk`.** The reserve gate is the hard solvency guarantee. A `critical`/reject means the trade was correctly refused — the MM cannot cover the implied liability. This is the system protecting itself; **do not** relax the reserve ratio to push a trade through. If a market is chronically near the gate, it needs more LP liquidity (genesis reserve / deposits), not a looser breaker. A `warning` (approaching) is a heads-up to watch liquidity.

---

## 4. Disputes — post-resolution window

**Flow.** On resolve, a market enters **RESOLVED** with `resolved_at` set; claims are **computed but gated**. The dispute window (`dispute_window_sec`, default **86400 s**) runs inside RESOLVED. Auto-settle (cron) moves RESOLVED → SETTLED **only** once the window has elapsed **and** no dispute is open; claims open at SETTLED.

**Symptom / triage.**
- **A market is stuck in RESOLVED past its window.** Check for an open dispute: `GET /admin/disputes?status=open`. An open dispute holds settlement indefinitely until resolved — this is intended.
- **Resolve the dispute:** `POST /admin/disputes/:id/resolve`.
  - `uphold` (requires `secondaryValue`): overrides θ* to the corrected value, re-runs `recordClaims`, writes an `admin_override` oracle row. The next auto-settle sweep (window already elapsed) settles it.
  - `reject`: closes the dispute, leaving θ* as-is; auto-settle proceeds.
- **No open dispute but still not settling** → the **scheduler** isn't ticking (§5), or the window genuinely hasn't elapsed yet (check `resolved_at + dispute_window_sec`).

**Who can dispute.** Only **holders**, only **within the window**, one open dispute per user per market (`POST /markets/:id/dispute`).

---

## 5. Scheduler not ticking — auto-resolve / auto-settle stalled

**Symptom.** `api` markets sit **OPEN** past their deadline (never auto-resolve), **and/or** RESOLVED markets never auto-settle past their window — across *all* markets at once (a single stuck market is §1 or §4, not this).

**What it means.** The in-process **`cron`** scheduler (the single backend job that runs `runApiResolutionSweep` + `runAutoSettleSweep`) isn't running. Causes: the API process is down/restarting, `ORACLE_SCHEDULER=false`, or a previous tick is wedged (the re-entrancy guard skips a new tick while one is still running — a hung feed fetch can stall it, though `ORACLE_FETCH_TIMEOUT_MS` bounds that).

> **Single-node caveat.** The scheduler is **single-node** today (`docs/scaling/` S-2 replaces it with a leader-elected runner). It must run on exactly one process. There is **no `setInterval`** anywhere in the backend — scheduled work is always this cron job (standing rule).

**Remediation.**
1. Confirm the API process is up and `ORACLE_SCHEDULER` is not `false`. On boot the log shows `[oracle scheduler] started (cron "...")`.
2. Restart the process — `startScheduler()` runs at boot. A wedged tick clears on restart.
3. **Backlog clears itself:** once ticking, the sweeps pick up every past-deadline `api` market and every window-elapsed RESOLVED market — no manual catch-up needed.
4. **Need a specific market resolved/settled now** while the scheduler is down: admin escape hatch `POST /admin/markets/:id/resolve`; settlement of any non-disputed RESOLVED market lands on the next healthy tick.

---

## Quick reference — symptom → section

| You see… | Go to |
|---|---|
| `oracle_failure` alert / `api` market SUSPENDED at deadline | §1 |
| `param_rail` alert / `rail:` badge in Adaptive params | §2 |
| `rapid_price_move` (market auto-suspended) | §3 |
| `insolvency_risk` / trade rejected | §3 |
| `belief_divergence` | §3 |
| Market stuck in RESOLVED, not settling | §4 (dispute) or §5 (scheduler) |
| `api` markets not resolving at deadline, system-wide | §5 |
