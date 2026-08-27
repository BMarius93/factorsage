# IntrinsicValue Agent Rules

Read `ai/README.md` before substantial work.

## Product invariants

1. Historical S&P 500 / Dow membership PIT is removed from the product.
2. Symbol lists are static.
3. Each list symbol may define a buy window:
   - `FULL`
   - `CUSTOM(startDate, endDate)`
4. Fundamental and intrinsic-value historical calculations must remain point-in-time correct and must not use future information.
5. Backtests are asynchronous long-running work.
6. API and worker are different processes, not different business implementations.
7. PostgreSQL is the durable source of truth.
8. Redis is disposable infrastructure and must not be the only store for completed/user-owned state.

## Dependency rules

Allowed direction:

```text
web -> contracts

api -> contracts/domain/stock-data/database/fmp/observability
worker -> contracts/domain/stock-data/database/fmp/observability

database -> Prisma
fmp -> domain/external FMP API
stock-data -> domain/database/fmp/observability/Redis
```

Forbidden:

- `web -> database`
- `web -> Prisma`
- `web -> fmp`
- `web -> worker`
- `domain -> database`
- `domain -> HTTP`
- `domain -> process.env`
- `valuation -> database`
- `valuation -> process.env`
- `stock-data -> process.env`

## Database rules

- One canonical Prisma schema.
- One migration history.
- API and worker each create their own process-local DB client/pool.
- Do not silently change schema.
- Schema changes require an explicit migration and a short migration note.

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
- New integrations and long-running flows must include enough structured logging to identify the operation, owner/caller when available, external dependency, outcome, and elapsed time without enabling `trace`.

## Validation

Before marking a task complete, run the relevant subset and normally all of:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

When E2E exists for the changed flow, run it as well.

If a command cannot be run, report exactly why.
