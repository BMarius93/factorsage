# Validation

Default completion gate:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm openapi:validate
```

Do not suppress failing type checks.

## What CI adds to the gate

`.github/workflows/ci.yml` runs the gate above plus three checks worth running locally when they
apply:

- **Frozen install.** `pnpm install --frozen-lockfile`, under the pnpm version `packageManager` pins
  in `package.json` (the same version Corepack gives developers and the Docker images). It fails
  when `pnpm-lock.yaml` is out of step with any `package.json`; commit the lockfile with every
  dependency change.
- **Migration drift.** `pnpm db:check-drift` replays every committed migration into a throwaway
  database it creates, with a unique generated name, on the server `DATABASE_URL` (or
  `MIGRATION_DRIFT_DATABASE_URL`) points at, diffs the result against `schema.prisma` with
  `prisma migrate diff --exit-code`, prints the missing SQL on a mismatch, and drops the database.
  The configured database is only used to issue `CREATE`/`DROP DATABASE` for that name — it is
  never the shadow, so the check is safe against the development database; the role needs
  `CREATEDB`. It catches a schema edit without its migration, a migration without its schema edit,
  and a hand-edited migration whose end state no longer matches the schema. It does **not** catch
  an edit to an already-applied migration that leaves the end state unchanged (that is
  `prisma migrate status`/checksum territory on a real database), data correctness inside a
  migration, or whether a migration can apply to a database holding real rows.
- `pnpm --filter @intrinsic/stock-data test:redis`.

## Package builds are incremental

`pnpm test` runs every workspace suite concurrently, and several test scripts rebuild the shared
packages they import so they also work standalone. Every `packages/*` build is therefore
`tsc --incremental --tsBuildInfoFile dist/.tsbuildinfo`: a rebuild with unchanged sources writes
nothing, so a concurrent suite can never import a `dist` file that `tsc` has just truncated. A plain
`tsc` rewrites every output and once made a whole web test file see `emptyStrategyDefinition is not
a function` in CI. `packages/config/src/workspace-builds.test.ts` keeps the rule. Deleting a
package's `dist` also deletes its build info and forces a full build.

## PostgreSQL-backed tests

`DATABASE_URL` is the development database and is never written to by tests.

Every suite that writes to PostgreSQL calls `useTestDatabase()` from
`@intrinsic/testing`, which loads root env, requires `TEST_DATABASE_URL`, refuses
a value equal to `DATABASE_URL` unless `CI=true`, and points this process's
Prisma clients at the test database. It must be called at module scope, before
anything constructs a Prisma client — directly, or through `PrismaService` when
a Nest testing module compiles. There is no fallback, so an unconfigured run
fails loudly instead of mutating development data.

Current callers (re-derive with `grep -rl "useTestDatabase()" apps packages --include=*.ts`; the
list was last corrected by E2E-007, when it had fallen seventeen suites behind):

- `apps/api/src/admin/securities-sync.integration.test.ts`
- `apps/api/src/auth/auth.integration.test.ts`
- `apps/api/src/auth/email-verification.integration.test.ts`
- `apps/api/src/auth/google-auth.integration.test.ts`
- `apps/api/src/auth/password-reset.integration.test.ts`
- `apps/api/src/auth/registration-enumeration.integration.test.ts`
- `apps/api/src/auth/registration.integration.test.ts`
- `apps/api/src/backtests/backtests.integration.test.ts`
- `apps/api/src/benchmarks/prune-fixture-benchmarks.integration.test.ts`
- `apps/api/src/billing/billing.integration.test.ts`
- `apps/api/src/builtins/builtins.integration.test.ts`
- `apps/api/src/e2e-stack/fixture-reseed.integration.test.ts` — writes the E2E fixture scope
  exactly as `pnpm test:personas:seed` does (see "The deterministic E2E stack" below)
- `apps/api/src/entitlements/entitlements.integration.test.ts`
- `apps/api/src/lists/stock-lists.integration.test.ts`
- `apps/api/src/market/market.integration.test.ts`
- `apps/api/src/monitors/monitors.integration.test.ts`
- `apps/api/src/openapi/openapi.contract.test.ts`
- `apps/api/src/qa-matrix/matrix-cleanup.integration.test.ts`
- `apps/api/src/qa-matrix/qa-matrix.integration.test.ts`
- `apps/api/src/rate-limit/rate-limit-coverage.test.ts`
- `apps/api/src/rate-limit/rate-limit.api.integration.test.ts`
- `apps/api/src/recent-searches/recent-searches.integration.test.ts`
- `apps/api/src/stocks/stocks.infrastructure.integration.test.ts`
- `apps/api/src/stocks/stocks.integration.test.ts`
- `apps/api/src/stocks/stocks.live-fmp.integration.test.ts` (inside `beforeAll`,
  so the opt-in gate still skips cleanly)
- `apps/api/src/strategies/strategies.integration.test.ts`
- `apps/worker/src/backtest/claim-entitlements.integration.test.ts`
- `apps/worker/src/backtest/job-repository.integration.test.ts`
- `apps/worker/src/monitor/monitor-cycle.integration.test.ts`
- `apps/worker/src/monitor/monitor-eligibility.integration.test.ts`
- `apps/worker/src/monitor/scan-repository.integration.test.ts`
- `packages/stock-data/src/benchmark-data.integration.test.ts`
- `packages/stock-data/src/benchmark-market-references.integration.test.ts`
- `packages/stock-data/src/benchmark-retention.integration.test.ts`
- `packages/stock-data/src/benchmark-series.integration.test.ts`
- `packages/stock-data/src/derived-state.integration.test.ts`
- `packages/stock-data/src/financial-statements.test.ts`
- `packages/stock-data/src/price-retention.integration.test.ts`
- `packages/stock-data/src/provider-reuse.integration.test.ts`
- `packages/stock-data/src/redis.integration.test.ts`
- `packages/stock-data/src/security-search.integration.test.ts`

`apps/worker/src/monitor/capacity-bench.ts` also calls it; it is a developer benchmark script, not a
suite.

**Suites that drive a Nest app over HTTP bind it to loopback.** Left unlistened (`app.init()`),
supertest binds a _wildcard_ ephemeral port per request, and on macOS that bind succeeds even when
another process already holds the same port on `127.0.0.1` — the request then reaches that process.
This machine has two such listeners (editor helpers): one answers `404` with an empty body, the
other accepts and never answers, after which every later test in the file times out at 5 s. Both
were reproduced deliberately during TEST-001. `await app.listen(0, "127.0.0.1")` removes the
mechanism; `registration-enumeration` and `backtests` do it. Other suites still use `app.init()`
and remain exposed to the same rare collision — a `404 {}` or a 5 s timeout cascade in one of them
is this, not a product failure, until they are converted.

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

## The Stripe sandbox suite is opt-in

`apps/api/src/billing/billing.integration.test.ts` needs no Stripe at all: it replaces the gateway
with an in-memory fake and runs inside the normal gate, so every billing rule — the transition
matrix, the status policy, webhook idempotency, the one-subscription invariant, reconciliation — is
proven offline.

Only `apps/api/src/billing/billing.sandbox.smoke.test.ts` touches the Stripe network, and three
things gate it:

- `describe.skipIf(!ENABLED)` on `STRIPE_SANDBOX_SMOKE=true`, so it is inert even when reached
  directly by path;
- package scripts also `--exclude` it from `pnpm test`;
- it **throws** in `beforeAll` if the configured key is not test mode, so it can never run against
  live billing.

```bash
STRIPE_SANDBOX_SMOKE=true pnpm test:billing:sandbox
```

It creates Stripe test-mode Customers, one Checkout Session and one Portal Session, and pays for
nothing. Hosted Checkout and Portal are browser flows; the manual runbook for them, including Test
Clocks, is in `../architecture/billing.md`.

Two operator commands are not tests and are never part of the gate:

```bash
pnpm billing:verify-catalog          # the four prices, against the configured Stripe environment
pnpm billing:reconcile -- --user x   # rebuild one user's billing state from Stripe
```

`pnpm billing:verify-catalog` is worth running whenever billing configuration changes: it is the only
check that would catch a `STRIPE_PRICE_PRO_MONTHLY` pointing at the $9 Starter price, because runtime
deliberately never reads an amount.

Playwright billing specs (`apps/web/e2e/billing/`) need no Stripe either — they assert FactorSage's own
surface and skip the checkout-initiation cases when billing is unconfigured:

```bash
pnpm test:e2e:billing
```

The public pricing specs (`pricing.guest.spec.ts`, `pricing.free.spec.ts`) are hermetic whatever the
API's configuration: they abort any browser request that leaves the local stack and answer
`/billing/status` and `/billing/checkout` in the browser for the Checkout case.

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
only, never exact FMP values. Playwright never calls FMP: the E2E API and worker
point `FMP_BASE_URL` at a local fixture server and run under an egress guard,
and the QA seeds write deterministic data and coverage watermarks that keep the
loader off even that (`auth-testing.md` §7).

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

| Command                                                  | Database                   |
| -------------------------------------------------------- | -------------------------- |
| `pnpm dev:api`, `pnpm dev:worker`, `pnpm dev:web`        | `DATABASE_URL` — real data |
| `pnpm db:migrate:deploy`, `pnpm db:seed`                 | `DATABASE_URL`             |
| `pnpm db:test:prepare`                                   | `TEST_DATABASE_URL`        |
| `pnpm test` (PostgreSQL-backed suites)                   | `TEST_DATABASE_URL`        |
| `pnpm test:users:seed`, `pnpm test:securities:seed`      | `TEST_DATABASE_URL`        |
| `pnpm test:builtins:seed`, `pnpm test:entitlements:seed` | `TEST_DATABASE_URL`        |
| `pnpm builtins:bootstrap`, `pnpm builtins:reset`         | `DATABASE_URL`             |
| `pnpm monitors:scan-once`                                | `DATABASE_URL`             |
| `pnpm test:matrix:seed`                                  | `TEST_DATABASE_URL`        |
| `pnpm dev:api:e2e`, `pnpm dev:worker:e2e`                | `TEST_DATABASE_URL`        |
| `pnpm dev:fmp:e2e`, `pnpm dev:web:e2e`                   | none                       |

### Normal development, against real market data

```bash
pnpm infra:up
pnpm db:migrate:deploy
pnpm dev:api        # and, in other shells:
pnpm dev:worker
pnpm dev:web
```

> **Do not run `pnpm test` while the deterministic E2E stack is up** (audit T-1, a known limitation).
> They share `TEST_DATABASE_URL`: a running `dev:worker:e2e` claims the queued backtest jobs the API
> integration suite creates, and `fixture-reseed.integration.test.ts` rewrites the E2E fixture scope
> under the running stack. Stop the E2E stack first; the two are alternatives, not companions. After
> `pnpm test`, run `pnpm test:personas:seed` again before `pnpm test:e2e`: other suites create and
> delete rows in the same database, and the seed is what restores the exact fixture state.

### Deterministic Playwright

The E2E stack replaces the development stack — both bind the same ports, so stop one before
starting the other. It is **hermetic**: the fixture FMP server stands in for the provider, every
other provider is switched off or made inert, and every Node process runs under an egress guard
that refuses any non-loopback connection. `ai/workflows/auth-testing.md` §7 is the full runbook —
what is real and what is faked, where fixture responses live, how time is controlled, what a reseed
deletes, how to add a fixture, and how the guard proves isolation.

```bash
pnpm infra:up
set -a && . ./.env && set +a && pnpm db:test:prepare
pnpm dev:fmp:e2e      # the fixture FMP server, 127.0.0.1:3011
pnpm dev:api:e2e      # and, in other shells:
pnpm dev:worker:e2e
pnpm dev:web:e2e
pnpm test:personas:seed
pnpm test:e2e
pnpm test:entitlements:seed && pnpm test:e2e   # a further run: the downgraded spec is irreversible
```

The Playwright global setup refuses to start unless the processes on the API and web ports and a
backtest worker child were launched through those commands, and its teardown fails the run if the
fixture server was asked for anything it has no fixture for, if the guard blocked a connection, or if
any persona still has a backtest in flight other than the entitlement fixtures' pinned ones.

Seeded data stays fresh for thirty days on this stack (`STOCK_RECENT_PRICE_FRESHNESS_MS` and
`STOCK_FUNDAMENTALS_FRESHNESS_MS` are overridden by the launcher only), so the suite no longer has to
follow the seed within hours; reseeding is still the reset, and still the documented first step.

The fixtures make deliberately different coverage claims, because only one of them is true in each
case:

- **`QATEST1` claims the whole retention horizon** with seeded rows, and **`QATEST2` and `ENTF001`…
  `ENTF100` claim it with none** (complete and empty). They are fictional securities whose only
  provider is the fixture, so the fixture genuinely is the authority on what exists — for `QATEST1`
  nothing before its first bar, for the others nothing at all. That is what lets Stock Details
  report a `PROVIDER` boundary, and what lets a thirty-year PRO run over eighty ENTF securities
  settle in seconds with no provider request.
- **`SP500` claims only the interval it generated.** It is backed by a real symbol whose history
  continues much further back, so a horizon claim would be a lie that permanently blocked fetching
  it. A backtest reaching before the seeded window therefore does ask for the older years — on this
  stack, the fixture server, which answers "no bars" — and that provider-written coverage is
  deleted by the next reseed.

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

## Built-in content and the Dashboard

- `packages/strategy/src/monitor-lifecycle.test.ts` — **needs nothing.** The accepted signal
  lifecycle, case by case.
- `apps/worker/src/monitor/monitor-cycle.integration.test.ts` — PostgreSQL. The lifecycle through
  the real repository: pending setups, latched triggers, reconstruction (including setups older
  than the first history read), buy windows, built-in Monitors, and transition history that always
  ends in the stored state.
- `apps/api/src/builtins/builtin-catalog.test.ts` — **needs nothing.** The canonical catalog pinned
  to the decision document.
- `apps/api/src/builtins/builtins.integration.test.ts` — PostgreSQL. Bootstrap idempotency, SYSTEM
  authorization, administrator edits, capacity, and the Dashboard read model with preferences.
- `apps/web/e2e/dashboard/*.spec.ts` — Playwright against the deterministic stack, after
  `pnpm test:builtins:seed`.

## Rate limiting and the OpenAPI document

Rate limiting is proven by five suites inside the normal gate, and they are deliberately split by
what they need, so a developer without infrastructure still runs most of them:

- `apps/api/src/rate-limit/rate-limit.integration.test.ts` — **needs Redis.** The distributed
  guarantees: the boundary, the `429`, `Retry-After`, refill when the window ends, isolation between
  users, between unauthenticated addresses and between policies, that concurrent requests cannot
  exceed the allowance, and that two separately compiled applications share one counter. It resolves
  `TEST_REDIS_URL` then `REDIS_URL`, skips locally when neither is set, and **hard-fails in CI**, for
  the same reason the stock-data Redis suite does — a silent skip there would leave the only
  distributed coverage untested.
- `apps/api/src/rate-limit/rate-limit.api.integration.test.ts` — **needs PostgreSQL and Redis.** The
  limiter on real routes: `POST /auth/login` answers `429` after its allowance, and sign-in, lists
  and entitlements behave exactly as before.
- `apps/api/src/rate-limit/rate-limit-coverage.test.ts` — **needs PostgreSQL** (it compiles
  `AppModule`). Every mounted route declares a policy or a written exemption. This is the suite that
  fails when somebody adds a controller and forgets `@RateLimit`.
- `apps/api/src/rate-limit/rate-limit.failure.test.ts` and `client-ip.test.ts` and
  `rate-limit.ordering.test.ts` — **need nothing.** Fail-open/fail-closed, timeout bounding, the
  proxy-hop and IPv6 rules, and the Nest enhancer ordering the design depends on.

`packages/stock-data/src/fmp-gate-coverage.test.ts` needs nothing and proves every production
`FmpClient` is constructed with the shared Redis provider gate — the invariant that keeps separate
processes from each consuming the whole FMP allowance.

`apps/api/src/openapi/openapi.contract.test.ts` needs PostgreSQL. It compiles the real application
and requires `docs/openapi.yaml` to describe exactly the routes that exist, with each one's
rate-limit policy, `429`, fail-closed `503`, cookie authentication and `401`/`403`. A new or renamed
route that is not documented fails here.

`pnpm openapi:validate` is a separate, infrastructure-free check that the document is valid
OpenAPI 3.1 with every `$ref` resolvable. Run it after editing `docs/openapi.yaml`; it is part of
the completion gate.

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
