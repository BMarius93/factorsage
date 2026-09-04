# Validation

Default completion gate:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Do not suppress failing type checks.

## PostgreSQL-backed tests

`DATABASE_URL` is the development database and is never written to by tests.

Every suite that writes to PostgreSQL calls `useTestDatabase()` from
`@intrinsic/testing`, which loads root env, requires `TEST_DATABASE_URL`, refuses
a value equal to `DATABASE_URL` unless `CI=true`, and points this process's
Prisma clients at the test database. It must be called at module scope, before
anything constructs a Prisma client — directly, or through `PrismaService` when
a Nest testing module compiles. There is no fallback, so an unconfigured run
fails loudly instead of mutating development data.

Current callers:

- `apps/api/src/admin/securities-sync.integration.test.ts`
- `apps/api/src/auth/auth.integration.test.ts`
- `apps/api/src/auth/registration.integration.test.ts`
- `apps/api/src/auth/google-auth.integration.test.ts`
- `apps/api/src/lists/stock-lists.integration.test.ts`
- `apps/api/src/stocks/stocks.integration.test.ts`
- `apps/api/src/stocks/stocks.infrastructure.integration.test.ts`
- `apps/api/src/stocks/stocks.live-fmp.integration.test.ts` (inside `beforeAll`,
  so the opt-in gate still skips cleanly)
- `packages/stock-data/src/derived-state.integration.test.ts`
- `packages/stock-data/src/financial-statements.test.ts`
- `packages/stock-data/src/redis.integration.test.ts`
- `packages/stock-data/src/security-search.integration.test.ts`

Prepare the database once, then keep `TEST_DATABASE_URL` in `.env` so `pnpm test`
picks it up:

```bash
docker compose exec -T postgres createdb -U intrinsic intrinsic_value_test
TEST_DATABASE_URL=postgresql://intrinsic:intrinsic_dev_password@localhost:5432/intrinsic_value_test \
  pnpm db:test:prepare          # prisma migrate deploy against the test DB
```

Redis isolation is deliberately different: suites keep one instance and isolate
by randomized key namespace with targeted cleanup. Nothing resets or flushes
developer infrastructure.

Redis-backed suites resolve `TEST_REDIS_URL` then `REDIS_URL`. Locally a missing
value skips them, so a developer without `pnpm infra:up` is not blocked. **In CI
(`CI=true`) a missing value is a hard failure instead of a skip**, because
`packages/stock-data/src/redis.integration.test.ts` holds the only coverage proving
the Redis cache and PostgreSQL agree on every materialized series — a silent skip
there would let CI report green with that parity untested.

## Stock API infrastructure tests

`apps/api/src/stocks/stocks.infrastructure.integration.test.ts` exercises
HTTP -> Nest -> CanonicalStockDataService -> real PostgreSQL -> real Redis ->
real Redlock with only the FMP boundary replaced by deterministic fixtures. It
runs inside normal `pnpm test` and requires reachable PostgreSQL and Redis
(`pnpm infra:up`).

```bash
pnpm --filter @intrinsic/api test:infrastructure
```

## Live FMP suites are opt-in at the suite level

Two suites can call the real provider:

- `apps/api/src/stocks/stocks.live-fmp.integration.test.ts`
- `packages/stock-data/src/live-fmp.integration.test.ts`

**`RUN_LIVE_FMP_TESTS=1` is the only thing that authorizes a live call.** Both
suites resolve `liveFmpTestsEnabled()` from `@intrinsic/testing` and become
`describe.skip` without it, so the gate holds even when a suite is reached
directly:

```ts
const describeLive = liveFmpTestsEnabled() ? describe : describe.skip;
```

An `FMP_API_KEY` in `.env` is **not** authorization. Package scripts also pass
`--exclude`, but that only hides the files from a default run — a direct
`vitest path/to/live-fmp.integration.test.ts` bypasses it, which is exactly how
a live suite once fired real requests while gated on the key alone. The
suite-level gate is what makes that impossible; the script exclusion is
convenience on top of it.

A placeholder key (`changeme`, `your-api-key`, `<key>`, blank …) is never a
credential. With the opt-in on, `assertLiveFmpCredentials()` throws inside
`beforeAll` rather than sending a request that cannot succeed.

`packages/stock-data/src/live-fmp-gate.test.ts` proves all of this offline: the
opt-in permutations, placeholder rejection, that the gate is closed during the
deterministic run, that the repository contains exactly the two known live
suites, and that each is gated through the shared helper and nothing else.

Run them deliberately:

```bash
RUN_LIVE_FMP_TESTS=1 TEST_DATABASE_URL=... FMP_API_KEY=... \
  pnpm --filter @intrinsic/api test:live

RUN_LIVE_FMP_TESTS=1 FMP_API_KEY=... \
  pnpm --filter @intrinsic/stock-data test:live
```

The API suite refuses to run against `DATABASE_URL` and both assert invariants
only, never exact FMP values. Playwright never calls FMP: the QA seed writes
deterministic data and coverage watermarks that keep the loader off the
provider.

The `@intrinsic/stock-data` live suite also asserts that a 30-year `AAPL`
daily-price request paginates past FMP's 5000-row per-response cap
(`FMP_EOD_MAX_ROWS_PER_RESPONSE` in `packages/fmp/src/client.ts`) and reaches
its requested start. It is the one assertion that catches the provider lowering
the cap; without it a long history would silently shorten again, as
`docs/decisions/complete-price-coverage.md` records.

For a migrated financial behavior:

1. port the old test or create an equivalent characterization test,
2. verify old expected behavior,
3. only then refactor the implementation.

For a vertical slice:

1. unit tests,
2. integration tests,
3. Playwright user journey once the UI/API path exists.

## Historical stock data in the local environment

No reset is needed when `PRICE_DATASET_VERSION` changes. A stock hydrated under
an earlier version has a stale Redis manifest and coverage under a variant the
loader no longer reads, so its next access re-verifies the caller's target with
complete provider requests and republishes its chunks; the derived state is
rebuilt from the canonical origin only when that re-verification actually
changes rows (a recovered prefix), never for rows that came back identical —
lazily, per stock, under the normal hydration lock.
Development databases are not migrated, flushed or reseeded for it.

For diagnostics, remove one security's loader-owned data and let the next
access rebuild it: its `DailyPrice`, `DailyDerivedState` and `WeeklyPrice`
rows; its `StockDatasetCoverage` and `StockDatasetState` rows for
`DAILY_PRICE`, `WEEKLY_PRICE` and `DAILY_DERIVED_STATE`; its
`stock-data:v2:security:<id>:*` Redis keys, its
`stock-data:v2:symbol:<symbol>:security` mapping and its entry in
`stock-data:v2:resident-stocks`. Never touch users, authentication, lists or
the `Security` row, and never flush Redis or drop tables to get there.

## Authentication and Playwright

Auth suites, QA-persona seeding, storage state, and the Google/email test policies are documented
in `ai/workflows/auth-testing.md`. Playwright drives an already-running stack and is not part of
`pnpm test`; run `pnpm test:e2e:smoke` (or `pnpm test:e2e`) when an auth or session flow changed.
