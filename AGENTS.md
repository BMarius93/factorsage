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
7. MySQL is the durable source of truth.
8. Redis is disposable infrastructure and must not be the only store for completed/user-owned state.

## Dependency rules

Allowed direction:

```text
web -> contracts

api -> contracts/domain/valuation/database/fmp/observability
worker -> contracts/domain/valuation/database/fmp/observability

database -> Prisma
fmp -> external FMP API
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
