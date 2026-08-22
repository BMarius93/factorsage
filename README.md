# IntrinsicValue V2

Clean rewrite foundation for IntrinsicValue.

The goal is **not** to regenerate the old application. The goal is to preserve the valuable UI, financial logic, tests, and product knowledge while rebuilding the architecture around explicit boundaries.

## Architecture

```text
Browser
  |
  v
apps/web
  |
  | HTTP contracts
  v
apps/api
  | \
  |  \--> packages/fmp
  |
  +----> packages/database --> MySQL
  |
  +----> enqueue durable work
             |
             v
         apps/worker
             |
             +--> packages/database
             +--> packages/domain
             +--> packages/valuation
             +--> packages/fmp

Redis = disposable cache / locks / coordination.
MySQL = durable source of truth.
```

## Repository layout

```text
apps/
  web/          Next.js UI only
  api/          NestJS API / orchestration
  worker/       Dedicated asynchronous worker process

packages/
  domain/       Pure product/business rules
  valuation/    Pure intrinsic-value calculations
  contracts/    API and execution contracts
  database/     One Prisma schema, one migration history
  fmp/          Financial Modeling Prep adapter
  observability/ Logging / tracing contracts
  testing/      Shared test utilities

ai/             Canonical context for coding agents
docs/           Human-facing architecture/development docs
docker/         Container definitions
```

## Non-negotiable boundaries

- `apps/web` never imports Prisma.
- `apps/web` never calls FMP directly.
- `apps/web` never starts or imports worker runtime code.
- API and worker are separate processes.
- API and worker share one database package/schema.
- Domain and valuation code cannot depend on HTTP, Prisma, Redis, Nest, Next, or environment variables.
- Historical index-membership PIT is not part of V2.
- Fundamentals/intrinsic historical calculations must preserve no-look-ahead correctness.
- Lists are static and each symbol can have `FULL` or `CUSTOM` buy window semantics.
- No TypeScript build-error suppression.

## Prerequisites

- Node.js 22+
- Corepack
- pnpm
- Docker Desktop

Enable pnpm if needed:

```bash
corepack enable
```

## First setup

```bash
cp .env.example .env
pnpm install
pnpm infra:up
pnpm db:validate
pnpm typecheck
pnpm test
pnpm build
```

After the first install, commit `pnpm-lock.yaml`.

## Local development

Run infrastructure:

```bash
pnpm infra:up
```

Then use three terminals:

```bash
pnpm dev:web
pnpm dev:api
pnpm dev:worker
```

Default URLs:

- Web: `http://localhost:3000`
- API health: `http://localhost:3001/health`
- MySQL: `localhost:3306`
- Redis: `localhost:6379`

## Full Docker stack

The starter also includes simple whole-repository Dockerfiles:

```bash
pnpm stack:up
```

For normal development, prefer running MySQL/Redis in Docker and the Node applications locally for easier debugging.

## Validation contract

Every meaningful change should finish with:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Feature-specific E2E tests will be added when the first vertical slice is implemented.

## Rewrite order

1. Repository foundation — this archive.
2. Canonical AI/product documentation.
3. Port pure `runtime-core` behavior and valuation methods with tests.
4. Define the unified Prisma model.
5. FMP adapter.
6. Stock Details vertical slice.
7. Auth + Lists with per-symbol buy windows.
8. Strategies.
9. Backtest execution + worker.
10. Monitors.
11. Entitlements + Stripe.
12. Admin + full Playwright regression.

The old repository remains reference-only. Do not bulk-copy it into this repository.
