# BMM — Web2 Bayesian Market Maker (Continuous Prediction Market)

A play-money prediction market on **continuous outcomes** (e.g. "BTC price at month-end"),
priced by a **Bayesian Market Maker**. Users trade user-composed contracts (call/put/binary/
spread/gaussian/linear) against a live Gaussian belief; admins create/fund/resolve markets;
LPs provide reserve liquidity. No real money, no blockchain.

> **Docs:** see [`docs/`](docs/README.md) — the spec (`docs/MODEL.md`), the V1 design
> (`docs/v1/TDD.md`) and build plan (`docs/v1/TASKS.md`), and the V2 roadmap (`docs/v2/`).

## Stack

- **Monorepo:** Bun workspaces — `packages/core` (pure math engine), `packages/shared`
  (types/DTOs), `apps/api` (ElysiaJS), `apps/web` (React + Vite).
- **DB:** PostgreSQL (Drizzle ORM).

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- A PostgreSQL database reachable via `DATABASE_URL` (any local install is fine).
  Docker is **optional** — see [Database](#database).

## Quickstart

```bash
# 1. install
bun install

# 2. configure
cp .env.example .env        # then set DATABASE_URL + secrets (JWT_SECRET, ADMIN_PASSWORD)

# 3. database schema  (available from Phase 2)
bun run db:migrate          # apply schema
bun run db:seed             # seed admin + demo users

# 4. run everything (api + web in parallel)
bun run dev
```

## Database

The app talks to Postgres via `DATABASE_URL` — point it at **any** Postgres you have:

```
DATABASE_URL=postgresql://user:pass@localhost:5432/your_db
```

A Prisma-style `?schema=public` suffix is accepted (the DB layer strips it and sets
the search_path). If you'd rather spin up a throwaway Postgres in Docker instead of
using a local one, the compose file is provided:

```bash
bun run db:up               # start Postgres 16 in Docker (set POSTGRES_PORT if 5432 is taken)
bun run db:down             # stop it
```

- API: http://localhost:3000 (Swagger at `/swagger`, health at `/health`)
- Web: http://localhost:5173

## Workspace scripts

| Command | What it does |
|---|---|
| `bun run dev` | Run api + web in parallel (`--filter '*'`) |
| `bun run build` | Build all workspaces |
| `bun run typecheck` | Type-check all workspaces |
| `bun run test` | Run all tests |
| `bun run lint` / `format` | Biome lint / format |
| `bun run db:up` / `db:down` | Start / stop the Postgres container |

## Status

**Phase 0 (scaffold) complete.** Next: Phase 1 — the `packages/core` math engine.
See [`docs/v1/TASKS.md`](docs/v1/TASKS.md).
