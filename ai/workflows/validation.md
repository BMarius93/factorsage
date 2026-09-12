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
- `apps/api/src/backtests/backtests.integration.test.ts`
- `apps/api/src/entitlements/entitlements.integration.test.ts`
- `apps/api/src/lists/stock-lists.integration.test.ts`
- `apps/api/src/qa-matrix/qa-matrix.integration.test.ts`
- `apps/api/src/qa-matrix/matrix-cleanup.integration.test.ts`
- `apps/api/src/strategies/strategies.integration.test.ts`
- `apps/api/src/stocks/stocks.integration.test.ts`
- `apps/api/src/stocks/stocks.infrastructure.integration.test.ts`
- `apps/api/src/stocks/stocks.live-fmp.integration.test.ts` (inside `beforeAll`,
  so the opt-in gate still skips cleanly)
- `apps/worker/src/backtest/claim-entitlements.integration.test.ts`
- `apps/worker/src/backtest/job-repository.integration.test.ts`
- `apps/worker/src/monitor/monitor-cycle.integration.test.ts`
- `apps/worker/src/monitor/monitor-eligibility.integration.test.ts`
- `apps/worker/src/monitor/scan-repository.integration.test.ts`
- `packages/stock-data/src/benchmark-data.integration.test.ts`
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

## The QA validation matrix is a developer command

`pnpm qa:matrix:run` executes 1,000 real backtests and is **never part of `pnpm test`**. It targets
its own database — `QA_MATRIX_DATABASE_URL`, whose name must contain `matrix` — and refuses
production, the development database, the test database and a shared Redis logical database before
any client exists.

```bash
pnpm qa:matrix:provision     # once: create, migrate, copy canonical data from the dev database
pnpm qa:matrix:preflight     # seventeen checks; nothing runs if any fails
pnpm qa:matrix:run           # the sweep, or --case Sxx-Lxx-Cxx to reproduce one
```

The suites that cover the runner itself (`apps/api/src/qa-matrix/matrix-*.test.ts`) execute no
backtests and run in milliseconds inside the normal gate.
`matrix-cleanup.integration.test.ts` is PostgreSQL-backed and calls `useTestDatabase()` like every
other DB-backed suite.

See `../../docs/development/qa-matrix-runner.md`.

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

## Backtests

`packages/strategy` is pure and needs no infrastructure: the engine suites — allocation math, level
firing, average cost, contributions, buy windows, candidate ordering, benchmark normalization,
alpha, the no-lookahead prefix test and deterministic replay — run offline in
`pnpm --filter @intrinsic/strategy test`.

`packages/strategy/src/backtest/simulation.window.test.ts` is the annual-execution regression suite:
it runs the same input through the continuous reference path and through calendar-year windows and
requires them to agree on every trade, fill, contribution date, position, cash balance, curve point
and summary metric. It also pins the year-boundary Trigger context, contribution continuity, the
three funded comparison scenarios, and that a run which did not consume every window has no result.
If a windowing change breaks equivalence, that is a methodology change and must be treated as one
rather than re-baselined.

`packages/stock-data/src/provider-reuse.integration.test.ts` needs PostgreSQL and Redis. Case L is
the one that proves annual execution does not cost one provider cycle per year: it prepares a cold
security once, steps through three calendar-year windows counting provider requests, checks the
yearly Redis chunks exist, then flushes Redis and shows the same windows rebuild from PostgreSQL
without touching the provider.

`packages/stock-data/src/benchmark-data.integration.test.ts` needs PostgreSQL and Redis. It is what
proves benchmark loading reuses coverage and the Redis projection rather than re-reading the
provider, and that a current durable freshness watermark means **no provider call at all** — the
property the deterministic E2E path depends on.

`apps/worker/src/backtest/backtest-annual-execution.test.ts` needs nothing: it drives the processor
against a recording loader and pins the seam — one whole-period prepare, one read per calendar year,
a milestone per completed year carrying the computed prefix, and a later window's failure leaving
the run terminally `FAILED` rather than partially completed.

`apps/worker/src/backtest/job-repository.integration.test.ts` needs PostgreSQL. It proves the claim
protocol: two workers never take one job, two jobs are claimed independently, an expired lease is
recovered, an exhausted job fails terminally, and a terminal job is never reclaimed. `apps/worker`
now has its own suite, so `pnpm test` runs it:

```bash
pnpm --filter @intrinsic/worker test
```

`apps/api/src/qa-matrix/` holds the deterministic QA-MATRIX fixtures for the Backtest V1 validation
matrix — ten persistent Strategies, ten persistent Stock Lists and ten repository configuration
fixtures, seeded with `pnpm test:matrix:seed`. Its suites need no market data: the definitions are
checked against the real `validateStrategy` and `parseCreateBacktestRunRequest` contracts, and the
integration suite exercises the seeder against PostgreSQL with an isolated randomized owner. See
`../../docs/development/qa-matrix-fixtures.md`; the runner that executes the 1,000 combinations does
not exist yet.

The Playwright backtest suite drives a **running stack with a running worker**, and that stack must
point at the **test database**, not at your development one.

## Two databases, and which command targets which

`DATABASE_URL` is where you do real work: real FMP history, real `SP500` bars sourced from `SPY`.
`TEST_DATABASE_URL` is where deterministic fixtures live: fictional securities, and synthetic
benchmark bars written into the real `SP500` series so an E2E run never reaches a provider.

Those fixtures must never meet your development database. `seedQaBenchmarkData` writes invented
S&P 500 history, and nothing on a results page distinguishes an invented bar from a real one — a
manual thirty-year backtest would silently compare against part-real, part-fabricated history. The
seeds therefore **connect to `TEST_DATABASE_URL` explicitly** and refuse to start when it is unset
or equal to `DATABASE_URL` (except in CI, where one database is the whole environment).

| Command                                             | Database                   |
| --------------------------------------------------- | -------------------------- |
| `pnpm dev:api`, `pnpm dev:worker`, `pnpm dev:web`   | `DATABASE_URL` — real data |
| `pnpm db:migrate:deploy`, `pnpm db:seed`            | `DATABASE_URL`             |
| `pnpm db:test:prepare`                              | `TEST_DATABASE_URL`        |
| `pnpm test` (PostgreSQL-backed suites)              | `TEST_DATABASE_URL`        |
| `pnpm test:users:seed`, `pnpm test:securities:seed` | `TEST_DATABASE_URL`        |
| `pnpm test:matrix:seed`                             | `TEST_DATABASE_URL`        |
| `pnpm dev:api:e2e`, `pnpm dev:worker:e2e`           | `TEST_DATABASE_URL`        |

### Normal development, against real market data

```bash
pnpm infra:up
pnpm db:migrate:deploy
pnpm dev:api        # and, in other shells:
pnpm dev:worker
pnpm dev:web
```

> **Do not run `pnpm test` while the deterministic E2E stack is up.** They share
> `TEST_DATABASE_URL`, and a running `dev:worker:e2e` will claim the queued backtest jobs the API
> integration suite creates — the suite then sees them mid-execution instead of `QUEUED`. Stop the
> E2E stack first; the two are alternatives, not companions.

### Deterministic Playwright

The E2E stack replaces the development stack — both bind the same ports, so stop one before
starting the other. `dev:api:e2e` and `dev:worker:e2e` need `TEST_DATABASE_URL` in the shell, the
same way `db:test:prepare` does:

```bash
set -a && . ./.env && set +a      # export TEST_DATABASE_URL for the two e2e stack commands
pnpm infra:up
pnpm db:test:prepare
pnpm test:users:seed && pnpm test:securities:seed
pnpm dev:api:e2e    # and, in other shells:
pnpm dev:worker:e2e
pnpm dev:web
pnpm test:e2e
```

Both the QA security's and the benchmark's freshness watermarks carry the seed's own timestamp, so
run the seed shortly before the suite; otherwise the loader treats the tail as stale and reaches for
the provider.

The two fixtures make deliberately different coverage claims, because only one of them is true in
both cases:

- **`QATEST1` claims the whole retention horizon.** It is a fictional security whose only provider
  is the fixture, so the fixture genuinely is the authority on what exists before its first bar —
  nothing. That is what lets Stock Details report a `PROVIDER` boundary.
- **`SP500` claims only the interval it generated.** It is backed by a real symbol whose history
  continues much further back, so a horizon claim would be a lie that permanently blocked fetching
  it. Keep E2E backtest periods inside the seeded window: an earlier start is genuinely uncovered
  and a real read would go to the provider.

### Repairing a development database seeded before this split

A database that was QA-seeded under the old behaviour still holds synthetic `SP500` bars, and they
cannot be told apart from real ones by inspection. Discard the benchmark's stored market data and
let the loader rebuild it from the provider:

```bash
pnpm db:benchmarks:reset SP500     # omit the code to reset every benchmark
```

It deletes bars, coverage intervals and watermarks — a durable projection of provider data, never
user-owned state — and leaves the `BenchmarkSeries` rows themselves alone, because completed runs
pin them. Completed runs keep their stored results either way. The next backtest re-hydrates the
series from FMP.

## Entitlements

Entitlements V1 is enforced at the API mutation boundaries and in both worker kinds, so a change
to a plan, a limit or an enforcement point has to be tested against all three.

- `packages/contracts/src/entitlements.test.ts` — the commercial matrix number by number, the
  derived compliance and Monitor-eligibility helpers, and the semantic assertions. Values are
  written as literals rather than imported, so the suite cannot agree with a wrong implementation.
  No infrastructure.
- `packages/contracts/src/entitlements.rate-limiting-boundary.test.ts` — proves entitlements carry
  no request-rate concept and that the module has no dependency that could reach a request or a
  counter. `docs/decisions/entitlements-v1.md` section 10 keeps the two mechanisms apart; this is
  what stops them merging.
- `apps/api/src/entitlements/entitlements.integration.test.ts` — PostgreSQL-backed. HTTP through to
  the database for every limit, guest behaviour, role-escalation attempts, the concurrency race and
  the downgrade rules. Deliberately drives the API directly: UI checks are convenience only, so a
  suite exercising the browser would prove nothing about the invariant.
- `apps/worker/src/backtest/claim-entitlements.integration.test.ts` — PostgreSQL-backed. Concurrency
  at the claim, including a plan that dropped while runs were queued.
- `apps/worker/src/monitor/monitor-eligibility.integration.test.ts` — PostgreSQL-backed. What a
  cycle may evaluate, and that `enabled` is never rewritten.

## Authentication and Playwright

Auth suites, QA-persona seeding, storage state, and the Google/email test policies are documented
in `ai/workflows/auth-testing.md`. Playwright drives an already-running stack and is not part of
`pnpm test`; run `pnpm test:e2e:smoke` (or `pnpm test:e2e`) when an auth or session flow changed.
