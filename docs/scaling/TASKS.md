# TASKS — BMM Continuous Prediction Market **Scaling**

Phased plan for horizontal scale & ops. **Prerequisite: V1 + V2 shipped and in use.** This milestone was **carved out of V2 Phase V2-4** (`docs/v2/TASKS.md`) — scaling is **not needed for the current dev stage**, so it lives here as its own track to be picked up when real multi-node load justifies it.

All work here is **infrastructure-only and additive**: a single-node deployment keeps behaving exactly as today (in-process per-market queue, in-process WS fan-out, in-process `cron` scheduler). Every Redis/multi-node path sits **behind a config flag** whose default is the current in-process implementation, so nothing here changes single-node behavior or the math.

Legend: `core`/`shared`/`api`/`web`/`infra` as in V1/V2. Each phase ends with a runnable checkpoint. `[blocked-by]` = hard deps.

> ** Invariant (standing rule).** Scaling must **never** weaken per-market **sequential consistency** (`MODEL.md §18.2`) or MM solvency. Concurrent trades on one market — even across nodes — must serialize exactly as the single-node in-process queue does today: no reserve double-spend, no lost belief update. Every phase adds a regression check asserting this against the in-process baseline.

> ** Seam-first rule.** Prefer extracting an **interface** with the current in-process behavior as the default impl, then adding a distributed impl behind it. Avoid a big-bang rewrite; each phase should be independently shippable and single-node-safe.

**Recommended order:** S-1 (coordination seams + Redis lock/pub-sub) → S-2 (leader-per-market routing + leader-elected scheduler) → S-3 (read scaling + cache) → S-4 (gateway: rate-limit, metrics, probes) → S-5 (multi-node hardening: consistency/chaos/load + runbook). S-1 is the foundation everything else builds on; S-4 is independent and can land any time.

---

## Phase S-1 — Coordination seams + Redis lock & pub/sub `[api, infra]` `[blocked-by: none]`
**Goal:** replace the two in-process coordination primitives (per-market lock, WS fan-out) with pluggable interfaces, and add Redis-backed implementations behind a config flag — single-node default unchanged.
- [ ] Extract a `MarketLock` interface from the current `withMarketLock` (in-process queue stays the default impl). Add a **Redlock** impl (`redis` + `redlock`) selected by `config.scale.lockDriver = 'memory' | 'redis'`. Same lock-then-transact contract; lock TTL + watchdog renew for long transactions; fail-closed on lock-acquire timeout.
- [ ] Extract a `Bus` (publish/subscribe) interface from the current in-process WS broadcaster. Add a **Redis pub/sub** impl so a trade on node A fans out to WS clients on node B. Topic scheme unchanged (per-market + system); each node subscribes and re-emits to its local sockets.
- [ ] `config.scale` block (lockDriver, busDriver, redisUrl, lock TTL/renew) with env wiring; default `memory`/in-process.
- [ ] **Tests:** Redlock impl serializes two concurrent acquirers (integration, ephemeral Redis); bus round-trips a message across two in-process subscribers; the in-process default path is byte-identical to today (existing trade/WS suites pass with `lockDriver=memory`).
**Checkpoint:** with `lockDriver=redis`, two API processes contending for the same market's lock serialize; a trade on one process pushes a WS update to a client connected to the other. Single-node (`memory`) behavior unchanged.

---

## Phase S-2 — Leader-per-market routing + leader-elected scheduler `[api, infra]` `[blocked-by: S-1]`
**Goal:** route every write for a market to a single owning node (so the in-process queue still does the fine-grained serialization, with Redlock as the cross-node guard), and make the `cron` scheduler safe to run on every node.
- [ ] Single-leader-per-market via **consistent-hash on `market_id`** over the live node set (membership via Redis). Non-owner nodes **forward writes** (trade/resolve/settle) to the owner; reads are served anywhere. Owner change on membership churn drains in-flight work under the lock.
- [ ] **Leader-elected scheduler:** replace the single-node `startScheduler` (V2-3) with an election (Redis lock / lease) so exactly one node runs the oracle/auto-settle tick at a time; on leader loss another node takes over. **Still `cron`, never `setInterval`.** This is the handoff noted in V2-3.
- [ ] Graceful node shutdown: deregister from membership, hand off owned markets, stop the scheduler lease.
- [ ] **Tests:** writes for a market always land on its hash-owner across a 2-node cluster; killing the leader promotes a follower and the tick keeps firing exactly once; no double-resolve under leader churn (idempotent under the per-market lock).
**Checkpoint:** 2 nodes; trades on one market always serialize on its owner regardless of which node received the request; the scheduled oracle/settle tick runs exactly once cluster-wide and survives leader loss.

---

## Phase S-3 — Read scaling & hot cache `[api, infra]` `[blocked-by: S-1]`
**Goal:** take read load off the primary and off recomputation.
- [ ] Postgres **read replicas** for GET/history/stats endpoints (writes → primary, reads → replica); read-your-writes handled for the owning node via primary-read on fresh markets. Replica routing behind config.
- [ ] **Hot cache** (Redis) for belief/quote snapshots + market views, invalidated on the publish path from S-1 (a fill publishes → cache bust). Read-through with short TTL as a backstop.
- [ ] **Shard-by-`market_id` plan/migration** (document the partition key + cutover; no data move required at dev stage — plan only unless load demands it).
- [ ] **Tests:** a stale-replica read never serves a quote that violates the latest reserve (cache busts on fill); cache hit/miss accounting; replica-routing falls back to primary on replica lag beyond threshold.
**Checkpoint:** GET-heavy load (quotes/history/stats) is served from replica + cache; a fill on the primary invalidates the snapshot so the next read is fresh.

---

## Phase S-4 — Gateway: rate limiting, metrics & probes `[api, infra]` `[blocked-by: none]`
**Goal:** production-edge hygiene; independent of the multi-node machinery (lands any time).
- [ ] Gateway **rate limiting** (per-IP / per-user, token-bucket; Redis-backed counter so limits hold across nodes, in-memory fallback single-node).
- [ ] **Structured logs** (JSON) + **metrics**: trade latency, reserve utilization, trade throughput, lock wait, oracle tick duration. Prometheus-style `/metrics` or equivalent.
- [ ] **Health / readiness probes**: `/health` (liveness) + `/ready` (DB + Redis + replica reachable) for the balancer.
- [ ] **Tests:** rate limiter rejects past the bucket and refills; `/ready` flips to not-ready when a dependency is down; metrics counters increment on the trade path.
**Checkpoint:** the API exposes liveness/readiness for a balancer, enforces rate limits across nodes, and emits the core ops metrics.

---

## Phase S-5 — Multi-node hardening `[api, infra]` `[blocked-by: S-1, S-2, S-3]`
**Goal:** prove the scaled system is correct under concurrency and failure, and document operations.
- [ ] **Consistency test:** concurrent trades on one market across 2 nodes stay sequentially consistent (no reserve double-spend, belief updates not lost) — the headline V2-4 checkpoint.
- [ ] **Chaos test:** node loss mid-trade (kill the owner while a trade is in flight) — the trade either fully commits or fully fails, lock is reclaimed, no partial state.
- [ ] **Load test:** multi-node + Redis under sustained trade + GET load; record latency/throughput envelopes.
- [ ] **Ops runbook:** Redis outage, replica lag, leader flapping, lock-watchdog expiry mid-transaction, rate-limit tuning — each with detection signal + remediation.
**Checkpoint:** run 2 API nodes behind a balancer; parallel trades on the same market remain consistent; reads scale on replicas; killing a node mid-trade leaves no partial state; the runbook covers each failure mode.

---

### Definition of done (Scaling)
The system runs **horizontally** (N API nodes behind a balancer) while preserving per-market **sequential consistency** and MM solvency: per-market writes serialize on a hash-owned leader guarded by a Redis distributed lock, WS fans out cross-node via Redis pub/sub, the oracle/settle scheduler runs exactly once cluster-wide via leader election, reads scale on replicas + cache, the edge enforces rate limits and exposes health/metrics, and chaos/load tests + an ops runbook back it. A **single-node** deployment (all drivers `memory`/in-process) behaves byte-identically to V2 — scaling is opt-in via config.
