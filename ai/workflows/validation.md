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

`TEST_DATABASE_URL` is required and must name a dedicated test database. There
is no fallback to `DATABASE_URL`, so an accidental run cannot write fixtures
into development data, and the suite refuses a `TEST_DATABASE_URL` equal to
`DATABASE_URL` unless `CI=true` (CI points both at its own throwaway database).

```bash
docker compose exec -T postgres createdb -U intrinsic intrinsic_value_test
TEST_DATABASE_URL=postgresql://intrinsic:intrinsic_dev_password@localhost:5432/intrinsic_value_test \
  pnpm db:test:prepare          # prisma migrate deploy against the test DB
pnpm --filter @intrinsic/api test:infrastructure
```

Keep `TEST_DATABASE_URL` in `.env` so `pnpm test` picks it up. All tests use
randomized symbols, a randomized Redis namespace, and targeted cleanup only.
Nothing resets or flushes developer infrastructure.

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
