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
   duplicate indicator/model option lists in feature code. This includes labels and ordering: a
   shorter label for a dense surface is a `shortLabel` on the catalog entry, never a second map.
   To add a calculated series, follow `docs/development/adding-a-calculated-series.md`.
10. `maximumPositions` belongs to a Backtest execution, not a Strategy. A full-position fraction is
    derived as `1 / maximumPositions`; do not introduce a user-entered max-allocation percentage.

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
  operational source of truth for QA personas, seeding, auth test suites, Playwright, storage
  state, and the Google/email test policies.
- Never commit credentials, session cookies, tokens, or Playwright storage state.

## Validation

During implementation, prefer the smallest relevant test/typecheck command. Once the implementation is settled, run the full validation gate once before marking the task complete:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

When E2E exists for the changed flow, run it as well.

If a command cannot be run, report exactly why.
