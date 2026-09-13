# IntrinsicValue Agent Rules

Read `ai/README.md` before substantial work.

## Product invariants

1. Historical S&P 500 / Dow membership PIT is removed from the product.
2. Stock lists are static user-owned universes; membership references the canonical `Security`
   catalog, never free-text symbols.
3. Each list membership defines buy eligibility:
   - `FULL` (no persisted ranges)
   - `CUSTOM` (one or more date ranges, persisted only in canonical normalized form —
     sorted, non-overlapping, non-adjacent, at most one open-ended; see `ai/product/lists.md`)
4. Fundamental and intrinsic-value historical calculations must remain point-in-time correct and must not use future information.
5. Backtests are asynchronous long-running work.
6. API and worker are different processes, not different business implementations.
7. PostgreSQL is the durable source of truth.
8. Redis is disposable infrastructure and must not be the only store for completed/user-owned state.
9. Stock Details and Strategy conditions consume one canonical selectable-series catalog; do not
   duplicate indicator/model option lists in feature code. This includes labels and ordering: each
   series has exactly one product label, and no surface keeps a second label map or ordering array.
   Calculated series are stored as explicit PostgreSQL columns — see
   `docs/decisions/retain-wide-column-calculated-series-storage.md` for the accepted decision,
   `ai/architecture/calculated-series.md` for how it is implemented, and
   `docs/development/adding-a-calculated-series.md` to add one.
10. `maximumPositions` belongs to a Backtest execution, not a Strategy. A full-position fraction is
    derived as `1 / maximumPositions`; do not introduce a user-entered max-allocation percentage.
11. Strategy signal semantics are defined in `ai/product/strategies.md`. Keep Strategy, Stock List,
    Backtest configuration and Backtest run as separate concepts. A Signal has zero or more
    Conditions plus at most one optional Trigger; Conditions are ANDed and the optional Trigger is
    ANDed with them for the same date. Do not silently add operators, metric/value compatibility,
    multiple triggers, or backtest execution parameters to the Strategy model. Strategy Builder and
    backend validation must share canonical compatibility definitions rather than maintaining
    separate matrices.
12. A submitted `BacktestRun` snapshot is immutable and is the reproducibility authority. Nothing in
    a completed or running run may be re-derived from the current `Strategy`, `StrategyVersion`,
    `StockList` or `Benchmark` rows, and deleting any of them must never delete or reinterpret a
    run. Execution behaviour the product leaves open — candidate ordering, level firing, exits
    before entries, contribution timing, fees — is engine methodology with a version recorded in
    that snapshot; see `ai/architecture/backtest-execution.md`. Do not change one of those rules
    without bumping its version.
13. A Benchmark is a first-class concept, never a `Security` and never `Security.isBenchmark`. It is
    passive comparison data: never bought, never consuming cash or a position slot, and carrying no
    derived series. `BENCHMARK_CATALOG` in `@intrinsic/domain` is the one source of benchmark
    metadata, and a provider symbol never crosses an API contract. Benchmark loading reuses the
    canonical provider adapter, coverage reconciliation, hydration lock, provider gate and Redis
    projection principles under its own namespace; see `ai/architecture/benchmark-data.md`.
14. Backtest work is claimed from PostgreSQL (`BacktestJob`, `FOR UPDATE SKIP LOCKED`, renewable
    lease, ownership-guarded writes). Do not add a queue library, and do not make Redis the queue.
    One backtest is never internally parallelized: its simulation stays sequential and
    single-process so it is deterministic. Concurrency comes from independent worker OS processes,
    configured by `BACKTEST_WORKER_PROCESSES`.
15. A Monitor is a live `Strategy` plus a `StockList` plus `enabled` — no pinned version, no
    execution parameters, no user-configurable cadence — and it produces Signals, which are
    append-only durable records distinct from the Monitor itself. `ai/product/product-overview.md`
    fixes how List, Strategy, Backtest, Monitor and Signal relate; `ai/product/monitors.md` and
    `ai/architecture/monitor-engine.md` own the semantics. The scan cycle is claimed from
    PostgreSQL through the singleton `MonitorScanSchedule` row with the same `FOR UPDATE SKIP
    LOCKED` + renewable-lease protocol as `BacktestJob`; that idiom now has two instances, and a
    third durable claim must match them rather than add a queue, a cron or a Redis lock.
16. Redis is **required at runtime** — every stock-data read, hydration lock and provider gate goes
    through it and nothing degrades to PostgreSQL-only when it is down — but its **contents are
    disposable**: everything in it is a projection of PostgreSQL or transient coordination, keyed
    by security/series id under `stock-data:v2:*` (cache chunks, manifests, the resident LRU, the
    FMP gate), `stock-data:load:*` (Redlock hydration locks) and `benchmark:v1:*`, never by user.
    Do not add a user-scoped key, a second namespace convention, or Monitor/Signal state to it.

17. Commercial entitlements are an application-domain concern with one central definition in
    `@intrinsic/contracts`. `docs/decisions/entitlements-v1.md` is the source of truth for every
    plan, capability and limit; `ai/architecture/entitlements.md` is how it is implemented. Plan
    (`FREE | STARTER | PRO`) and role (`USER | ADMIN`) are orthogonal columns on `User`, both
    resolved server-side from persisted state and never from client input; `GUEST` is derived from
    the absence of a session and never creates a row. Do not write `plan === "PRO"` in feature
    code — ask for a named capability or limit and enforce it with a semantic guard at the
    canonical mutation or execution boundary. A limit that can be raced is decided inside the
    writing transaction under the shared per-user entitlement lock. A downgrade is never
    destructive: existing content stays readable and correctable, and compliance is derived rather
    than persisted. Billing may move the persisted plan and nothing else; it is never an input to
    entitlement resolution, and request rate is never modelled as an entitlement.

18. Stripe is a billing provider and nothing else. `docs/decisions/stripe-billing-v1.md` is the source
    of truth for the four-price catalog, the transition matrix and the billing-status policy;
    `ai/architecture/billing.md` is how it is implemented. The direction is one-way — Stripe billing
    state, then persisted `User.plan`, then the entitlement resolver, then enforcement — and never
    reversed: no entitlement question is ever answered by consulting Stripe, and no entitlement value
    lives in billing code. `apps/api/src/entitlements/user-plan.ts` remains the only writer of
    `User.plan`, reached by exactly one caller, `BillingReconciliationService`, which is also the only
    thing that writes the `BillingSubscription` mirror — in the same transaction, under the shared
    per-user entitlement lock, after fetching canonical Stripe state inside it. A plan is never granted
    from a browser redirect, from an unverified webhook payload, or from a subscription-update request
    whose payment has not succeeded. `apps/api/src/billing/stripe.gateway.ts` is the only file that may
    import the Stripe SDK, and no client input may name a Stripe price, customer or subscription: the
    whole accepted surface is one of four logical price keys. Stripe never touches `User.role`. Do not
    add credits, top-ups, trials, metered billing, a second paid subscription per user, or
    hand-written proration arithmetic.

## Dependency rules

Allowed direction:

```text
web -> contracts

api -> contracts/domain/strategy/stock-data/database/fmp/observability
worker -> contracts/domain/strategy/stock-data/database/fmp/observability

database -> Prisma
fmp -> domain/external FMP API
strategy -> contracts/domain
stock-data -> contracts/domain/strategy/database/fmp/observability/Redis
```

Forbidden:

- `web -> database`
- `web -> Prisma`
- `web -> fmp`
- `web -> worker`
- `web -> strategy`
- `domain -> database`
- `domain -> HTTP`
- `domain -> process.env`
- `valuation -> database`
- `valuation -> process.env`
- `stock-data -> process.env`
- `strategy -> database`
- `strategy -> HTTP`
- `strategy -> process.env`

`@intrinsic/strategy` is pure: Strategy evaluation, position state and the backtest day loop, with
no I/O and no clock. It is what keeps the API, the backtest worker and the Monitor engine on one
implementation of what a Strategy means. `stock-data` depends on it only to project the columnar evaluation frame the
engine consumes — which is also where the intrinsic-value provenance gate is applied, so a pure
evaluator physically cannot read an ungated value.

## Database rules

- One canonical Prisma schema.
- One migration history.
- API and worker each create their own process-local DB client/pool.
- Do not silently change schema.
- Schema changes require an explicit migration and a short migration note.

## Frontend rules

- Read `ai/architecture/frontend.md` for substantial frontend/UI work.
- The old repository is a visual/behavioral oracle only; do not copy its architecture wholesale.
- Preserve the established FactorSage visual identity where it still fits V2: Geist, light neutral surfaces, blue primary accent, restrained financial state colors, soft cards, and high information clarity.
- Use App Router only in V2; do not introduce Pages Router.
- Keep route files thin and organize product code by feature.
- Use `@intrinsic/contracts` as the canonical API shape; do not duplicate response types in the web app.
- Responsive desktop and mobile behavior is part of feature acceptance. Do not defer mobile behavior to a later cleanup task.
- Prefer dedicated mobile composition for dense data when a desktop table/layout would be hard to use on a phone.
- Do not put canonical financial/business calculations in React components.
- Use semantic design tokens before adding new hard-coded brand colors.
- For time-series market charts, prefer the established Lightweight Charts direction unless the task has a materially different visualization need.

## Code-change rules

- Prefer small reviewable changes.
- Do not bulk-copy the old repository.
- Treat old code as reference/oracle, not architecture.
- Preserve existing validated formulas unless the task explicitly changes them.
- Do not change financial formulas as part of infrastructure refactors.
- No `typescript.ignoreBuildErrors`.
- Do not commit generated build output.
- Do not introduce a generic `shared/utils.ts` dumping ground.
- Add dependencies only when there is a concrete use.
- Never commit secrets or real `.env` files.

## Agent efficiency

- Keep investigation and implementation within the explicit task scope.
- Search and read narrowly; do not repeatedly reread unchanged files or dump large files/logs without a concrete need.
- Prefer existing tests and logs over ad-hoc diagnostic scripts. Temporary probes must not remain in the final diff.
- During iteration, run targeted validation for the code being changed. Run the full repository validation gate once after the implementation is settled.
- Do not repeat successful command output; summarize pass/fail. On failure, preserve the relevant error evidence.
- For review/validate/commit/push-only tasks, do not modify implementation. If validation fails, stop and report unless the task explicitly includes fixing failures.
- If the task requires investigation before implementation, establish the root cause before changing code and stop exploring unrelated alternatives once it is confirmed.
- Keep status updates and final reports concise and non-repetitive.

## Observability rules

- Read `ai/architecture/observability.md` for server-side API, worker, stock-data, FMP, database, cache, queue, or integration work.
- Application runtime logging must use `@intrinsic/observability`; do not add ad-hoc `console.log`, `console.warn`, or `console.error` calls.
- Respect the configured `LOG_LEVEL`. Use `info` for meaningful lifecycle boundaries, `debug` for operational detail, and `trace` only for high-volume diagnostics.
- Important operations must emit stable searchable events for relevant `started`, `completed`, and `failed` boundaries. Include `durationMs` on completed/failed operations when meaningful.
- Preserve correlation context through the call chain. Standard fields are `requestId`, `correlationId`, `actorUserId`, `runId`, `jobId`, `symbol`, and `component` when applicable.
- Use the internal user ID as `actorUserId`; do not use email as the normal user correlation key.
- Crossing a process boundary is explicit: queue/job payloads must carry the relevant correlation fields, and the receiving worker must recreate the logging context.
- Never log passwords, cookies, authorization headers, JWTs, API keys, secrets, credentials, or complete sensitive request/response payloads.
- Do not swallow, replace, or change business errors merely to add logging. Log with context and preserve the original error semantics.
- When a caught exception is translated into a generic error, log the original error object before translation so its name, message, and stack are retained.
- New integrations and long-running flows must include enough structured logging to identify the operation, owner/caller when available, external dependency, outcome, and elapsed time without enabling `trace`.

## Authentication and E2E testing

- For authentication work or browser/E2E testing, read `ai/workflows/auth-testing.md`. It is the
  operational source of truth for test personas, seeding, auth test suites, Playwright, storage
  state, and the Google/email test policies.
- Test personas are defined once in `packages/testing/src/personas.ts` — one account per commercial
  plan, plus an administrator on the smallest plan. Do not add a persona email, password, plan or
  storage-state path anywhere else, and do not change a persona's plan inside a test: sign in as the
  plan under test. `PRO_USER` is the normal development and manual-testing account; `ADMIN_USER` is
  for internal/QA scenarios that intentionally need entitlement overrides.
- Never commit credentials, session cookies, tokens, or Playwright storage state.

## Validation

PostgreSQL-backed suites require `TEST_DATABASE_URL` pointing at a dedicated, migrated test database
(`pnpm db:test:prepare`); they never fall back to `DATABASE_URL`. `apps/api`, `apps/worker` and
`packages/stock-data` serialize their test files for that reason. `apps/worker` is one supervisor
with two child kinds — backtest children and Monitor children — so a worker change must be tested
against the kind it affects. See `ai/workflows/validation.md`.

During implementation, prefer the smallest relevant test/typecheck command. Once the implementation is settled, run the full validation gate once before marking the task complete:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

When E2E exists for the changed flow, run it as well.

If a command cannot be run, report exactly why.
