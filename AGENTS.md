# IntrinsicValue Agent Rules

Read `ai/README.md` before substantial work.

## Product invariants

1. Historical S&P 500 / Dow membership PIT **data** is removed from the product: nothing ships,
   syncs or reconstructs index constituents. Point-in-time membership a user supplies is a
   different thing and is supported — see invariant 3.
2. Stock lists are static user-owned universes; membership references the canonical `Security`
   catalog, never free-text symbols.
3. Each list membership defines buy eligibility:
   - `FULL` (no persisted ranges)
   - `CUSTOM` (one or more date ranges, persisted only in canonical normalized form —
     sorted, non-overlapping, non-adjacent, at most one open-ended; see `ai/product/lists.md`)

   A buy window is the period a member is eligible for **new BUY** actions; it never constrains a
   SELL or a FINAL EXIT, and nothing force-liquidates a position when one closes. The UI calls the
   concept **membership** and renders an open-ended window as `Present`; `buyWindow` remains the
   internal name everywhere else. Multiple periods are what make point-in-time index membership
   representable, and the single-period V1 editor must never silently discard the others.
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
    **FINAL EXIT is the one level that may hold more than one Signal**: it is a single action
    reached by one or more alternative **Exit Rules**, ORed, each owning its own Signal and
    therefore its own optional Trigger. The supported grammar is exactly OR of AND groups, and only
    there — BUY and SELL keep one Signal each, there is no nesting, and there is no per-condition
    AND/OR choice. Whatever number of Exit Rules match on one date, FINAL EXIT is still **one**
    action, one level id, one trade and one Signal; it must never execute or emit twice. The
    persisted definition document is schema version 2; version 1 rows are upgraded at read time by
    `upgradeStrategyDefinitionDocument`, never rewritten, and a single-rule FINAL EXIT fingerprints
    identically to version 1 so no stored `definitionHash` or Monitor latch moves. A **frozen copy**
    of a definition — `BacktestRun.snapshot.strategy.definition` — is not covered by that read path
    and is projected at its own boundaries instead: the worker upcasts the document to execute it,
    the API canonicalizes it to answer its contract, and neither writes the row back.
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
    `rate-limit:v1:*` is the one further namespace, and it is deliberately outside that rule: it
    holds HTTP rate-limit counters, which are neither a projection of PostgreSQL nor user-owned
    state — losing one grants allowance rather than destroying anything — so it is keyed by actor,
    including by user id. It shares the same Redis instance on its own connection and never a
    second provider. See `ai/architecture/rate-limiting.md`.

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

19. API rate limiting is abuse and capacity protection, never a commercial entitlement
    (`docs/decisions/entitlements-v1.md` section 10, enforced by
    `packages/contracts/src/entitlements.rate-limiting-boundary.test.ts`). Every allowance lives in
    one catalog, `apps/api/src/rate-limit/rate-limit-policies.ts`; a route names a policy with
    `@RateLimit("…")` and never carries a number, a Redis call or a limiter. Enforcement is the one
    global `RateLimitInterceptor` — an interceptor rather than a guard because Nest runs global
    enhancers before controller guards, so a guard could not see the session it keys by. Every
    mounted route must declare a policy or an explicit `@RateLimitExempt(reason)`;
    `rate-limit-coverage.test.ts` fails the build otherwise. Counters are keyed by user id for
    authenticated traffic and by client IP otherwise — never by plan, and never by a submitted email
    address. `X-Forwarded-For` is trusted only as far as `RATE_LIMIT_TRUSTED_PROXY_HOPS` says a
    deployment really has proxies. A policy may carry a second, wider per-IP bucket; buckets are
    spent in order, stopping at the first refusal, and anything an earlier bucket took is handed
    back — so **a refused request never consumes usable allowance from another bucket** and one
    caller's doomed retries cannot drain a shared allowance their colleagues depend on. Every
    consume stays one atomic Redis script rather than a read-then-write. Redis-failure behaviour is a per-policy decision — capacity
    policies fail open, security and payment policies fail closed with `503` and
    `RATE_LIMIT_UNAVAILABLE` — and there is never a process-local fallback limiter, which would
    report a distributed guarantee the system does not have. Outbound provider throttling is a
    different mechanism with different semantics (wait, not reject) and stays
    `RedisFmpRequestGate`. `ai/architecture/rate-limiting.md` is how it is implemented.

20. `docs/openapi.yaml` is the HTTP API's specification and describes the API that exists.
    `apps/api/src/openapi/openapi.contract.test.ts` compiles the real application and requires the
    document to match it operation for operation — each route's rate-limit policy, its `429`, its
    `503` where the policy fails closed, its cookie authentication and its `401`/`403` — so a new
    or renamed route cannot land undocumented. `pnpm openapi:validate` separately validates the
    document against the official OpenAPI 3.1 schema. Do not document an endpoint that does not
    exist, and do not add a route without documenting it.

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
- Preserve the established FactorSage visual identity where it still fits V2: a near-white canvas,
  flat light-bordered surfaces, a restrained blue accent used as ink more often than as fill,
  restrained financial state colors, and high information clarity. Geist is a **V2 choice, not
  something inherited from V1** — deployed V1 renders in the OS UI stack; V2 keeps Geist because it
  renders identically on every platform.
- `apps/web/src/styles/tokens.css` holds the product's shared visual language: the semantic palette,
  the radius and elevation scales, the type scale, the standard control sizes and the page spacing
  system. Ask for those by name rather than restating their values, and never redefine one locally.
  Geometry specific to a single component may stay in that component. `ai/architecture/ui-system.md`
  states the rule; `ai/architecture/v1-visual-parity.md` holds the measured V1 reference behind it.
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
pnpm openapi:validate
```

When E2E exists for the changed flow, run it as well.

If a command cannot be run, report exactly why.
