# Validation

Default completion gate:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Do not suppress failing type checks.

## Stock API infrastructure tests

`apps/api/src/stocks/stocks.infrastructure.integration.test.ts` exercises
HTTP -> Nest -> CanonicalStockDataService -> real PostgreSQL -> real Redis ->
real Redlock with only the FMP boundary replaced by deterministic fixtures. It
runs inside normal `pnpm test` and requires reachable PostgreSQL and Redis
(`pnpm infra:up`).

Preferred local setup uses a dedicated test database so hydration data stays
out of the development database:

```bash
createdb intrinsic_value_test   # once, on the local PostgreSQL server
TEST_DATABASE_URL=postgresql://intrinsic:intrinsic_dev_password@localhost:5432/intrinsic_value_test \
  pnpm db:test:prepare          # prisma migrate deploy against the test DB
pnpm --filter @intrinsic/api test:infrastructure
```

Without `TEST_DATABASE_URL` the suite falls back to `DATABASE_URL` (CI provides
a dedicated migrated database there). All tests use randomized symbols, a
randomized Redis namespace, and targeted cleanup only.

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
