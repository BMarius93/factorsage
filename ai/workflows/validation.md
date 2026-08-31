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

- `apps/api/src/auth/auth.integration.test.ts`
- `apps/api/src/stocks/stocks.integration.test.ts`
- `apps/api/src/stocks/stocks.infrastructure.integration.test.ts`
- `apps/api/src/stocks/stocks.live-fmp.integration.test.ts` (inside `beforeAll`,
  so the opt-in gate still skips cleanly)
- `packages/stock-data/src/financial-statements.test.ts`
- `packages/stock-data/src/redis.integration.test.ts`

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

## Stock API infrastructure tests

`apps/api/src/stocks/stocks.infrastructure.integration.test.ts` exercises
HTTP -> Nest -> CanonicalStockDataService -> real PostgreSQL -> real Redis ->
real Redlock with only the FMP boundary replaced by deterministic fixtures. It
runs inside normal `pnpm test` and requires reachable PostgreSQL and Redis
(`pnpm infra:up`).

```bash
pnpm --filter @intrinsic/api test:infrastructure
```

The opt-in live smoke suite never runs by default or in CI:

```bash
RUN_LIVE_FMP_TESTS=1 TEST_DATABASE_URL=... FMP_API_KEY=... \
  pnpm --filter @intrinsic/api test:live
```

It refuses to run against `DATABASE_URL` and asserts invariants only, never
exact FMP values.

For a migrated financial behavior:
1. port the old test or create an equivalent characterization test,
2. verify old expected behavior,
3. only then refactor the implementation.

For a vertical slice:
1. unit tests,
2. integration tests,
3. Playwright user journey once the UI/API path exists.
