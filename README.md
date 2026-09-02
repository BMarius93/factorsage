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
         apps/worker  (foundation only: no job processors registered yet)

Redis = disposable cache / locks / coordination.
PostgreSQL = durable source of truth.
```

`@intrinsic/stock-data` hydrates one canonical stock history (up to the configured 30-year
horizon). `apps/api` is its only caller today; `apps/worker` is a foundation process that
registers no job processors yet and must consume this same package rather than reimplementing
loading when backtests land. Requested dates only project reads from yearly Redis chunks.
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

8. Apply migrations to the development database. The applications and tests assume a
   migrated schema; nothing migrates it implicitly:

```bash
pnpm db:migrate:deploy
```

9. Create and migrate the dedicated test database (see [Test databases](#test-databases)):

```bash
docker compose exec -T postgres createdb -U intrinsic intrinsic_value_test
TEST_DATABASE_URL=postgresql://intrinsic:intrinsic_dev_password@localhost:5432/intrinsic_value_test \
  pnpm db:test:prepare
```

Add the same `TEST_DATABASE_URL` line to your `.env` so test runs pick it up.

10. Run repository quality checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

11. Start local applications in separate terminals:

```bash
pnpm dev:web
pnpm dev:api
pnpm dev:worker
```

12. Verify pnpm is available in your selected Node runtime:

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

## Authentication

The Nest API is the authentication authority. It owns credentials, sessions, email verification,
and the Google OpenID Connect exchange; the web app holds no authentication authority. V2 does not
use NextAuth and does not use Pages Router.

`User` is the product identity. Emails are normalized before storage and lookup, PostgreSQL
enforces uniqueness, passwords use Argon2id, and `passwordHash` is nullable so an external-identity
-only user can exist. `emailVerifiedAt` records local email confirmation, `OAuthAccount` links
external identities (no provider tokens are ever stored), and `EmailVerificationToken` keeps one
outstanding hashed, single-use token per user.

Browser auth uses a signed JWT stored only in an HttpOnly cookie: `SameSite=Lax`, path `/`, an
eight-hour default lifetime, and `Secure` in production. Browser requests include credentials and
the API allows credentialed CORS only for configured origins. Auth tokens are never stored in
`localStorage` or `sessionStorage`.

Endpoints:

- `GET /auth/providers` — which external providers this deployment configured
- `POST /auth/register`, `POST /auth/verify-email`, `POST /auth/resend-verification`
- `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`
- `GET /auth/google`, `GET /auth/google/callback`
- `GET /admin/health` (ADMIN authorization proof only)

A new local user starts unverified and cannot sign in until the emailed link is redeemed;
redeeming consumes the one-time token and marks the address verified in a single transaction.
Google sign-in uses the authorization-code flow with `state`, PKCE S256, and an OIDC `nonce`, and
accepts identity only from an ID token whose signature, audience, issuer, and expiry
`google-auth-library` has verified. It creates or links an account only when Google reports the
address as verified, and it ends in exactly the same FactorSage session cookie as password login.

Settings are documented in `.env.example`: `AUTH_JWT_SECRET` (at least 32 characters),
`AUTH_TOKEN_TTL_SECONDS`, `AUTH_COOKIE_NAME`, `AUTH_EMAIL_VERIFICATION_TTL_SECONDS`,
`WEB_BASE_URL`, `CORS_ORIGINS`, the optional `GOOGLE_*` and `SMTP_*` groups, and `ADMIN_EMAIL` /
`ADMIN_PASSWORD` for bootstrap seeding. Google and SMTP are optional and ship empty, so a fresh
`.env` copied from the template runs with both simply not offered; each group is all-or-nothing,
and a partially configured one is rejected rather than silently disabled.

Create or update the first administrator explicitly:

```bash
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='<temporary-value>' pnpm db:seed
```

The command has no default credentials, hashes the supplied password, normalizes the email, marks
it verified, and is idempotent. Do not put real credentials in committed files.

`CookieAuthGuard` resolves the current database user, while `Roles` metadata and `RolesGuard`
enforce `USER` / `ADMIN`. Future ADMIN endpoints must reuse these primitives.

Forgot/reset password, refresh tokens, and additional identity providers are not implemented.

`ai/architecture/authentication.md` is the canonical design document and
`ai/workflows/auth-testing.md` is the test/QA-persona runbook.

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

Start infrastructure (`pnpm infra:up`) and apply migrations before running the gate locally:
several suites are backed by real PostgreSQL and Redis.

### Test databases

`DATABASE_URL` is the development database and is never written to by tests.

Every PostgreSQL-backed suite — auth, stock API, and stock-data persistence — resolves its
connection through `TEST_DATABASE_URL`, a dedicated database such as `intrinsic_value_test`.
They share one helper, `useTestDatabase()` from `@intrinsic/testing`, which refuses to run
without it. There is deliberately no fallback to `DATABASE_URL`, so an accidental run cannot
write fixtures into development data, and a `TEST_DATABASE_URL` equal to `DATABASE_URL` is
refused unless `CI=true`. `pnpm db:test:prepare` runs `prisma migrate deploy` against
`TEST_DATABASE_URL`; it never resets or drops a database. CI points `TEST_DATABASE_URL` at its
own throwaway database, the only place the two URLs may match.

Redis needs no separate instance: every suite uses a randomized key namespace, cleans up only
the keys it created, and never flushes.

### Test suites

- `pnpm test` — the default gate. Deterministic; no `FMP_API_KEY` required, but
  `TEST_DATABASE_URL` must be set because it includes PostgreSQL-backed suites.
- `pnpm --filter @intrinsic/api test:infrastructure` — the cross-layer stock API suite
  (HTTP → Nest → PostgreSQL → Redis → Redlock) with only the FMP provider boundary faked.
  It is part of `pnpm test`.
- `pnpm --filter @intrinsic/stock-data test:redis` — real-Redis stock-data integration tests.
- `pnpm --filter @intrinsic/api test:live` — opt-in live FMP smoke tests. Excluded from
  `pnpm test` and from CI. Requires `RUN_LIVE_FMP_TESTS=1`, `FMP_API_KEY`, and a
  `TEST_DATABASE_URL` that differs from `DATABASE_URL`. It asserts invariants only, never
  exact provider values.
- `pnpm test:e2e:smoke` / `pnpm test:e2e` — Playwright authentication suite. Not part of
  `pnpm test`: it drives an already-running stack and needs the QA personas seeded with
  `pnpm test:users:seed`. See `ai/workflows/auth-testing.md`.

`ai/workflows/validation.md` holds the detailed testing workflow.

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
