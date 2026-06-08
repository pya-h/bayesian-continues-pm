# BMM — Web2 Bayesian Market Maker (Continuous Prediction Market)

A play-money prediction market on **continuous outcomes** (e.g. "BTC price at month-end"),
priced by a **Bayesian Market Maker**. Users compose their own contracts (call / put / binary /
spread / gaussian / linear) and trade them against a live Gaussian belief; the market maker
prices each trade in closed form, charges a spread, and **learns** from order flow via a Bayesian
belief update. Admins create / fund / resolve markets and top up users; LPs provide reserve
liquidity and share pro-rata in the pool. No real money, no blockchain.

> **Docs:** see [`docs/`](docs/README.md) — the spec ([`docs/MODEL.md`](docs/MODEL.md)), the V1
> design ([`docs/v1/TDD.md`](docs/v1/TDD.md)) and build plan ([`docs/v1/TASKS.md`](docs/v1/TASKS.md)),
> and the V2 roadmap ([`docs/v2/`](docs/v2/)).

## How it works

- **Pricing.** Every contract's fair value is `E_belief[payoff]`, computed in closed form for a
  Gaussian belief (`packages/core`). The exec price = fair ± a spread that widens with inventory,
  adverse selection, and volatility.
- **Learning.** Each trade is decoded into a noisy signal about the outcome; the belief `N(μ, σ²)`
  is updated by a precision-weighted conjugate Bayesian step, so consensus `μ` moves toward informed
  flow and `σ` tightens.
- **Solvency.** The MM holds a reserve = the α-quantile (VaR, Monte-Carlo) of its liability. Trades
  that would push `cash < 1.2 × reserve` are partially filled to the solvency frontier or rejected.
- **Settlement.** Admin resolves with the true outcome θ\*; positions pay `q · payoff(θ*)` via an
  explicit **claim**. LPs claim their pro-rata share of the pool's final cash separately.
- **Circuit breakers.** Post-trade health checks (belief divergence, rapid price move, insolvency
  risk — MODEL.md §15.1) broadcast `system:alert` over WebSocket; admins see them live.

## Stack

- **Monorepo:** Bun workspaces — `packages/core` (pure, IO-free math engine), `packages/shared`
  (types / zod DTOs), `apps/api` (ElysiaJS + Drizzle + postgres.js), `apps/web` (React + Vite +
  Tailwind v4 + TanStack Query). Lint/format via Biome.
- **DB:** PostgreSQL (Drizzle ORM + drizzle-kit).

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- A PostgreSQL database reachable via `DATABASE_URL` (any local install is fine). Docker is
  **optional** — see [Database](#database).

## Quickstart

```bash
# 1. install
bun install

# 2. configure
cp .env.example .env        # set DATABASE_URL + secrets (JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD)

# 3. database
bun run db:migrate          # apply schema
bun run db:seed             # seed the admin (infinite balance) + alice / bob (play money)

# 4. run everything (api + web in parallel)
bun run dev
```

- **API:** http://localhost:4000 (Swagger at `/swagger`, health at `/health`)
- **Web:** http://localhost:5173

> **Port note:** if host ports up to ~4000 are occupied, run the API on a free port and point the
> web client at it:
> ```bash
> PORT=4100 bun run --filter '@bmm/api' dev
> VITE_API_URL=http://localhost:4100 VITE_WS_URL=ws://localhost:4100/ws bun run --filter '@bmm/web' dev
> ```

## Try it end-to-end

1. Sign in as the admin (`ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env`) → **Admin** tab.
2. **Create** a market (μ₀, σ₀, R₀ + optional advanced config), **Open** it, and **top up** a user.
3. Sign in as that user, open the market, **compose a contract on the chart** (drag the strike /
   center / width), watch the live quote, and **trade**. The belief PDF and price update live.
4. Back as admin: **Resolve** with the true outcome θ\*, then **Settle**.
5. As the user: **Claim** your payout in **Portfolio**; LPs claim on the **LP** page. Portfolio and
   the admin **overview** show the final, formula-backed P&L.

The same cycle, headless and self-checking, is one command (against a running API):

```bash
PORT=4100 bun run --filter '@bmm/api' dev     # shell 1
API_URL=http://localhost:4100 bun run demo     # shell 2 — creates a throwaway market,
                                               # trades→resolves→settles→claims, asserts, cleans up
```

## Simulation (calibration / tuning)

A seeded Monte-Carlo harness (MODEL.md §17.3) runs the full BMM loop against synthetic informed
traders and reports belief accuracy, 80%-CI calibration, and MM / trader profitability — and
doubles as a tuning tool for the default engine params:

```bash
bun run sim                                    # σ_obs sweep with sensible defaults
bun run sim --runs 5000 --traders 100 --mu0 65000 --sigma0 5000
bun run sim --sigmaObs 2500 --seed 7 --no-sweep
```

A well-informed market should **learn** (error ≪ prior), keep `calib₈₀` near 0.80, and leave the
MM profitable; pure-noise flow games the MM (negative MM P&L) — exactly what the sweep shows.

## Testing

```bash
bun run test            # all workspaces
bun run test:core       # pure engine (math, breakers, sim) — fast, no DB
bun run test:shared     # zod DTOs
bun run test:web        # pure UI derivations (no DOM)
bun run test:api        # integration — hits a real Postgres via app.handle() (runs with --isolate)
```

`test:api` needs `DATABASE_URL` + `ADMIN_PASSWORD` in the environment; it creates throwaway rows and
cleans them up. (Running the root `bun run test` is fine; running the bare `bun test` at the root
without `--isolate` cross-closes the shared DB pool — use the scripts above.)

**Browser smoke (Playwright)** lives in [`e2e/`](e2e/) and is intentionally outside the workspace
globs (so it never runs in `bun run test`). Install and run it on demand:

```bash
cd e2e && bun install && bun run install:browsers
bun run e2e                                    # boots API (4100) + web (5173), drives the UI
```

## Database

Point `DATABASE_URL` at **any** Postgres:

```
DATABASE_URL=postgresql://user:pass@localhost:5432/your_db
```

A Prisma-style `?schema=public` suffix is accepted (the DB layer strips it). To spin up a throwaway
Postgres in Docker instead, the compose file is provided:

```bash
bun run db:up               # start Postgres in Docker (set POSTGRES_PORT if 5432 is taken)
bun run db:down             # stop it
```

## Workspace scripts

| Command | What it does |
|---|---|
| `bun run dev` | Run api + web in parallel (`--filter '*'`) |
| `bun run build` | Build all workspaces |
| `bun run typecheck` | Type-check all workspaces |
| `bun run test` | Run all tests (use `test:core` / `:api` / `:web` / `:shared` to scope) |
| `bun run lint` / `format` | Biome lint / format |
| `bun run sim` | Monte-Carlo calibration sim (MODEL.md §17.3) |
| `bun run demo` | Headless end-to-end demo against a running API |
| `bun run db:migrate` / `db:seed` | Apply schema / seed admin + demo users |
| `bun run db:up` / `db:down` | Start / stop the Postgres container |

## Status

**v1 complete (Phases 0–11).** Continuous-outcome BMM with closed-form Gaussian pricing, Bayesian
belief updates, enforced solvency, LP provide/withdraw/claim, explicit settlement claims,
formula-backed portfolio + admin statistics, chart-driven trading, circuit-breaker alerts, a
Monte-Carlo calibration tool, and an end-to-end demo. V2 (multi-modal beliefs, leverage / shorting,
adaptive params, robust oracles) is scoped in [`docs/v2/`](docs/v2/).
