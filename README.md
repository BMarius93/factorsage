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
  |
  +----> packages/stock-data
             |--> packages/fmp
             |--> packages/database --> PostgreSQL
             +--> Redis
  |
  +----> enqueue durable work
             |
             v
         apps/worker
             |
             +--> packages/database
             +--> packages/domain
             +--> packages/valuation
             +--> packages/stock-data

Redis = disposable cache / locks / coordination.
PostgreSQL = durable source of truth.
```

`@intrinsic/stock-data` hydrates one canonical stock history (up to the configured 30-year
horizon) for API and worker callers. Requested dates only project reads from yearly Redis chunks.
PostgreSQL coverage prevents historical refetches, one stock-level Redlock prevents duplicate
same-stock hydration, and a separate Redis provider gate coordinates FMP rate/cooldown behavior.

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
  stock-data/   Canonical stock-data loading/cache/persistence orchestration
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

- nvm
- Node.js 22.23.2 (via `.nvmrc`)
- Corepack
- pnpm
- Docker Desktop

Enable pnpm if needed:

```bash
corepack enable
```

## First setup

1. Install and select the pinned Node.js version:

```bash
nvm install
nvm use
```

2. Verify the runtime:

```bash
node --version
```

3. Enable Corepack if needed:

```bash
corepack enable
```

4. Create local environment defaults:

```bash
cp .env.example .env
```

5. Install dependencies:

```bash
pnpm install
```

6. Start infrastructure:

```bash
pnpm infra:up
```

7. Validate Prisma setup:

```bash
pnpm db:generate
pnpm db:validate
```

8. Run repository quality checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

9. Start local applications in separate terminals:

```bash
pnpm dev:web
pnpm dev:api
pnpm dev:worker
```

10. Verify pnpm is available in your selected Node runtime:

```bash
pnpm --version
```

After dependency changes, keep `pnpm-lock.yaml` committed.

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
- API: `http://localhost:3001`
- API health: `http://localhost:3001/health`
- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`

## Authentication foundation

The current vertical slice provides local password authentication and `USER` / `ADMIN` role
authorization. `User` is the product identity, emails are normalized before storage and lookup,
and PostgreSQL enforces email uniqueness. Passwords use Argon2id and only a nullable
`passwordHash` is stored. The nullable field preserves compatibility with future external-only
identities without adding provider tables now.

Browser auth uses a signed JWT stored only in an HttpOnly cookie. The cookie uses `SameSite=Lax`,
path `/`, an eight-hour default lifetime, and `Secure` in production. Browser requests include
credentials and the API allows credentialed CORS only for configured origins. The frontend uses
`/auth/me` as its identity authority; backend guards remain authoritative for authorization. Auth
tokens are not stored in `localStorage` or `sessionStorage`.

Implemented endpoints:

- `POST /auth/login`
- `POST /auth/logout`
- `GET /auth/me`
- `GET /admin/health` (ADMIN authorization proof only)

Required auth settings are documented in `.env.example`:

- `AUTH_JWT_SECRET` (at least 32 characters; use a unique random production secret)
- `AUTH_TOKEN_TTL_SECONDS`
- `AUTH_COOKIE_NAME`
- `CORS_ORIGINS`
- `ADMIN_EMAIL` and `ADMIN_PASSWORD` (required only for bootstrap seeding)

Create or update the first administrator explicitly:

```bash
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='<temporary-value>' pnpm db:seed
```

The command has no default credentials, hashes the supplied password, normalizes the email, and is
idempotent. Do not put real credentials in committed files.

`CookieAuthGuard` resolves the current database user, while `Roles` metadata and `RolesGuard`
enforce `USER` / `ADMIN`. Future ADMIN endpoints, such as a future Security sync endpoint, must
reuse these primitives. Security sync itself is not implemented.

Google OAuth is intentionally deferred. This slice does not include Google packages, OAuth
callbacks, provider identifiers, an `OAuthAccount` table, or account linking. It also does not
include public registration, password reset, email verification, refresh tokens, or product
features.

## Full Docker stack

The starter also includes simple whole-repository Dockerfiles:

```bash
pnpm stack:up
```

For normal development, prefer running PostgreSQL/Redis in Docker and the Node applications locally for easier debugging.

## Validation contract

Every meaningful change should finish with:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The auth slice includes PostgreSQL-backed API integration tests. Start infrastructure before
running the full test gate locally.

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
