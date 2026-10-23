# Architecture inventory and risk register (Phase 0)

Written 2026-10-23, before any change in this work, from the code on `main` at `376399c`. It records
what already exists so the later phases extend it instead of rebuilding it, and the risks found
before implementation. `PRODUCTION-READINESS-REPORT.md` is the final report; this is its input.

## 1. What exists

| Area | What is built | Where |
| --- | --- | --- |
| Entitlements | One pure matrix and resolver (`FREE | STARTER | PRO`), semantic guards, transactional guards under a per-user advisory lock, derived (never persisted) compliance, deterministic Monitor slot eligibility | `packages/contracts/src/entitlements.ts`, `apps/api/src/entitlements/`, `ai/architecture/entitlements.md` |
| Billing | Stripe Checkout + Portal + a FactorSage-owned change endpoint; one reconciliation path (`BillingReconciliationService`), the only writer of `User.plan` (`changeUserPlan`), inside the same per-user lock, after fetching canonical Stripe state; webhook signature + idempotency table; four prices (Starter/Pro × month/year) | `packages/contracts/src/billing.ts`, `apps/api/src/billing/`, `docs/decisions/stripe-billing-v1.md` |
| Guest | Derived from the absence of a session; reads public built-ins, Stock Details, `/pricing`, shared reports (`/share/{token}`); no backtest surface, no demo runs (`canViewDemo: false`, read by nothing) | `entitlements-v1.md` §4, `backtest-sharing-v1.md` |
| Backtest submission | Validates, freezes an immutable snapshot, and inserts run + job + progress in one transaction; per-user in-flight count (queued + running) under the user lock | `apps/api/src/backtests/backtests.service.ts` `submitRun` |
| Queue and execution | PostgreSQL `BacktestJob` (`FOR UPDATE SKIP LOCKED`), renewable lease (60 s, heartbeat 15 s), ownership-guarded writes, stale recovery with backoff, `maxAttempts` 3, release on graceful shutdown; per-user execution count at claim (live leases only); FIFO with a 20-row look-past for owners at capacity | `apps/worker/src/backtest/job-repository.ts`, `worker-loop.ts`, `job-lease.ts` |
| Global concurrency | **None.** Deployment-wide execution is `BACKTEST_WORKER_PROCESSES` (default 2) × worker hosts; nothing caps it across hosts | `packages/config/src/index.ts` `getBacktestWorkerConfig` |
| Cancellation | **None** ("Cancellation — deferred" in `ai/architecture/backtest-execution.md`) | — |
| Run states | `QUEUED → PREPARING_DATA → RUNNING → FINALIZING → COMPLETED | FAILED`; data preparation happens after the claim, inside the execution slot | contracts `BACKTEST_RUN_STATUSES` |
| Engine ceiling | `BACKTEST_MAX_SECURITIES = 200` (API and worker); PIT universe 2,000 securities / 600 simultaneous | `packages/contracts/src/backtests.ts` |
| Monitors | EOD-only, provider-free pass from durable checkpoints; singleton claim; per-user eligibility derived each cycle; user Monitors reference only the user's own Strategy and List | `apps/worker/src/monitor/`, `docs/decisions/monitor-eod-v2.md` |
| Stock data | Canonical loader; FMP behind `RedisFmpRequestGate` (4 concurrent, 20 req/s, queue 100); Redlock hydration locks; PostgreSQL canonical, Redis projection | `packages/stock-data/`, `packages/fmp/` |
| Redis tiers | Protected tier (S&P 500 PIT universe, ~735 securities, ~544 MB, no TTL, never LRU-evicted) + LRU tier counted in securities (`STOCK_LRU_MAX_SECURITIES`, default 100); routing in Lua, decided from PostgreSQL; `tiers` audit command | `packages/stock-data/src/cache.ts`, `protected-tier.ts`, `docs/decisions/stock-cache-tiers-v1.md` |
| PIT lists | One reconstructed universe (`sp500-historical-pit`), measured by peak simultaneous members; Pro-only (0 / 0 / 550) | `docs/decisions/sp500-historical-pit-v1.md` |
| Built-in content | 3 Lists (10 members each), 2 Strategies, 3 Dashboard Monitors, plus the PIT List; readable by everyone, changed by ADMIN; no premium concept | `apps/api/src/builtins/` |
| Rate limiting | One catalog, global interceptor, Redis counters; `backtest-execution` 60/h per user, 180/h per IP | `apps/api/src/rate-limit/` |
| Health | `/health` (static), `/health/ready` (PostgreSQL, Redis, eviction-policy verdict); web and worker have no HTTP probe | `apps/api/src/health.controller.ts` |
| Observability | Structured NDJSON logger with correlation context; no metrics, no tracing | `packages/observability/` |
| Deployment | `docker-compose.yml` for local use; dev-grade single-stage images (root, `pnpm` as PID 1, dev dependencies, no `HEALTHCHECK`); no TLS, proxy, limits, backups or runbook | `docker/`, `docker-compose.yml` |
| Benchmarks | `bench:pit-backtests` (real `submitRun` + raw worker processes, `/proc` sampling, determinism digest), `bench:stock-cache-tiers`, `bench:monitor`, `bench:daily-state-cache`; no HTTP or browser load tooling | `apps/api/src/backtest-benchmark/`, `apps/api/src/cache-benchmark/`, `apps/worker/src/monitor/capacity-bench.ts` |
| Tests | ~80 Playwright specs (personas per plan, hermetic fake FMP on :3011); PostgreSQL-backed integration suites serialized per package | `apps/web/e2e/`, `ai/workflows/validation.md` |

## 2. Gaps between the specification and the code

| Requirement | Current | Gap |
| --- | --- | --- |
| Pro+ plan, $19 / $49 / $199 | 3 plans, $9 / $29 (+ annual $99 / $299) | new plan value, catalog, rank, UI |
| Symbols 10 / 50 / 750 / 1,000 | 10 / 50 / 100, engine ceiling 200 | matrix and engine ceiling |
| Monitors 1 / 5 / ∞ / ∞ | 1 / 3 / 10 | matrix; operational fair-use protection for "∞" |
| Concurrent runs 1 / 1 / 1 / 2 | 1 / 1 / 2 | Pro drops to 1 |
| 30 years for every plan | 5 / 15 / 30 | matrix |
| Premium lists, strategies, PIT for Pro/Pro+ | PIT gated by a size limit only; no premium flag | premium capability, flag, read/use/copy gates |
| Guest demo backtests | explicitly none | curated, precomputed, read-only demonstrations |
| 4 global execution slots | per-process only | deployment-wide atomic admission |
| Fair scheduling | FIFO with look-past | owner-fair ordering |
| Bounded queue / backpressure | per-user in-flight only | global queue bound |
| Cancellation | none | cancel endpoint, `CANCELLED`, slot release |
| LRU 500 | default 100 | configuration, validation |
| Production infrastructure | none | compose, proxy, limits, backups, runbook |

## 3. Risks identified before implementation

| # | Risk | Evidence | Consequence |
| --- | --- | --- | --- |
| R1 | **LRU thrash for large non-S&P universes.** A List whose ordinary securities exceed the LRU count rebuilds them from PostgreSQL in every year window | `stock-cache-tiers-v1.md` "Mixed List, `STOCK_LRU_MAX_SECURITIES=3`: 148 s vs 9.3 s"; production-capacity "a sequential scan larger than the cache has a 100 % miss rate" | A 1,000-symbol Pro+ run of mostly non-S&P stocks against LRU 500 may run many times slower; four of them thrash each other |
| R2 | Preparation (hydration) runs inside the execution slot | `backtest-processor.ts` `PREPARING_DATA` after `claimNextJob` | A true FMP miss for 1,000 new securities (~8 requests each) holds one of four slots for the whole download |
| R3 | Claims wait on a per-user lock that billing holds across a Stripe call | earlier audit OPS-11 | With a global claim lock, one slow Stripe call could stall every claim; owners must be try-locked under it |
| R4 | Raising the engine ceiling 200 → 1,000 | `BACKTEST_MAX_SECURITIES` comment: "failing fast at submission is far better than an OS-killed worker" | Worker memory must be measured, not assumed |
| R5 | "Unlimited" Monitors | Monitor pass cost is per member per new session (~1.7 ms; 9,000 members ≈ 15–18 s) | One user with thousands of 750-symbol Monitors could stretch the EOD pass for everyone |
| R6 | Retired annual prices beside new monthly prices | catalog | Starter yearly $99 vs monthly $19 would be an unapproved 57 % discount |
| R7 | A `PRO_PLUS` row reaching an older build | `resolveEntitlements` throws on an unknown plan | Deploy order: migrate, deploy every process, then configure the Pro+ price |
| R8 | No connection-pool sizing | earlier audit OPS-09 | Default Prisma pool per process × (API + 4 backtest + 3 other children) |
| R9 | Redis RDB snapshot restore can resurrect stale manifests; `noeviction` at a full `maxmemory` fails warm reads | OPS-12, OPS-03 | Production Redis needs a sized `maxmemory` and a deliberate persistence choice |
| R10 | Docker's 10 s stop timeout vs the worker's 30 s drain; pnpm as PID 1 | Dockerfiles | A deploy can kill in-flight runs uncleanly (they recover through lease expiry, at the cost of an attempt) |
| R11 | Event-loop stalls longer than the 60 s lease | single-threaded simulation, heartbeat on a timer | A stall would let recovery requeue a run that is still executing (writes stay ownership-guarded, but CPU is spent twice) |
| R12 | No real 30-year data in the cloud VM | dev database empty; live FMP capped at three securities | Large-scale benchmarks must use a deterministic synthetic provider; only a three-security sample is real FMP |
