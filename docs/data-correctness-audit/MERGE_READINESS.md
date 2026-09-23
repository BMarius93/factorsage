# `audit-large`: merge-readiness review

A clean-room review of the branch as a deployable change, not another correctness audit. The
financial correctness evidence is [FINAL_DATA_CORRECTNESS_AUDIT.md](FINAL_DATA_CORRECTNESS_AUDIT.md)
(69,814,984 comparisons, 1 explained failure) and is not repeated here.

## Branch reviewed

| | |
| --- | --- |
| Branch | `audit-large` |
| HEAD | `fd72f05e` (`78c6e2c3` plus the one review fix below) |
| Base | `main` at `334d974a`, which is also the merge base |
| Ahead / behind | 19 commits ahead, 0 behind (18 at review start, plus this review's commit) |
| Working tree at review start | clean |

## Diff

178 files, +380,947 / −502. The insertions are almost entirely committed JSON evidence.

| Category | Files | Notes |
| --- | --- | --- |
| Production correctness fix | 12 | `financial-statements.ts`, `service.ts`, `prisma-store.ts`, `derived-state.ts`, `job-repository.ts`, `ratio-binding.ts`, `dashboard.service.ts`, `monitors.service.ts`, `signal-since.ts`, `security-universe.ts`, `benchmark-service.ts`, contracts |
| Production data/version change | 3 | `ports.ts` (v2→v3), `benchmark-ports.ts` (v1→v2), one data-only migration |
| Audit/test infrastructure | 45 | `apps/api/src/data-correctness-audit/**`, `mirror-table.ts`, the Playwright audit stage and config, the worker audit scan, new test files |
| CLI/developer tooling | 3 | `resync-canonical-stock-data.ts`, two `package.json` script entries |
| Documentation | 9 | `docs/data-correctness-audit/**`, `ai/architecture/deep-discovery.md`, `docs/development/qa-matrix-runner.md` |
| Committed evidence | 104 | `artifacts/data-correctness-audit/**`, 9.1 MB |
| Generated/debug content | 0 | `.debug/`, the 990 other scenario files and the raw provider snapshots are ignored |
| Suspicious/unexpected | 0 | see Findings |

Repository impact: **1.7 MB packed** for all 475 branch-only objects (19.2 MB uncompressed, because
the artifacts were regenerated and re-committed). Largest newly tracked file: 360 KB
(`backtests/index.json`). No file needs LFS.

## Clean-room result

A detached worktree of `audit-large` at a separate path, its own `node_modules`, its own `.env`
copied from `.env.example`, a database created empty for the purpose and Redis index 5. The
existing development environment was not touched.

```bash
git worktree add --detach <dir> audit-large
cp .env.example <dir>/.env      # DATABASE_URL=…/intrinsic_value_clean, REDIS_URL=…/5, QA_MATRIX_REDIS_DB=6
docker exec factorsage-postgres-1 psql -U intrinsic -d postgres -c 'create database intrinsic_value_clean;'
pnpm install --frozen-lockfile  # 9.7 s, lockfile accepted unchanged
pnpm db:generate && pnpm db:validate && pnpm db:migrate:deploy && pnpm db:check-drift
ADMIN_EMAIL=… ADMIN_PASSWORD=… pnpm db:seed
pnpm build
pnpm --filter @intrinsic/api start:prod  # + worker start, web start
# catalog sync (documented fresh-environment step), then:
pnpm builtins:bootstrap
```

**PASS.** Nothing in the bootstrap read `artifacts/`, `.debug/`, a matrix archive, a provider
snapshot or any audit state.

## Fresh DB

**PASS**, on a database created empty minutes earlier.

| Check | Result |
| --- | --- |
| Migrations | all 33 applied, including the data-only PIT migration (0 rows to update on an empty table) |
| `db:check-drift` | `schema.prisma` matches the migration history |
| `db:seed` | bootstrap admin created |
| `builtins:bootstrap` | 3 lists, 2 strategies, 3 monitors — **after** the catalog sync, which it demands with an actionable error (pre-existing, `docs/development/builtin-content.md`) |
| Benchmark catalog | `SP500`, `SP500_INDEX`, `DJIA_INDEX`, `VIX_INDEX` and their series exist from migrations; bars hydrate lazily |
| Price dataset version | cold read wrote `split-adjusted-eod-full:v3` |
| Derived state revision | cold read wrote `daily-derived-state:r5` |
| Benchmark dataset version | backtest wrote `provider-eod-full:v2` |
| PIT fundamentals | 554 statements hydrated, 68 undated by the provider, **0** available on or before their filing date, **0** before the earliest deadline a filer is bound by. Q2 1994-03-31 → 1994-05-17 (45 days lands on a Sunday → Monday → +1); FY/Q4 1993-09-30 → 1993-12-30 |
| Ratio persistence | `returnIndex` `1.3864022746` at scale 10 and `portfolioReturnPercent` `38.64022746` at scale 8 — the same number at both scales, from the new string binding |
| Monitor schema/state | the first cycle on an empty database was empty and released cleanly; the next reconstructed 66 levels across 3 built-in monitors and wrote 14 Signals |
| Backtest end to end | submitted through the API, executed by the worker, `COMPLETED`, 82 trades |

No code assumed pre-existing rows. Nothing needed a remediation command to work.

## Existing environment upgrade

Deploying the merged branch to an environment on `main` requires **no mandatory operational step**.
Every semantic change invalidates itself:

| Change | Invalidation | Rebuild | Manual step | Old data readable | Mixing possible |
| --- | --- | --- | --- | --- | --- |
| `PRICE_DATASET_VERSION` 2→3 | automatic: the variant keys `StockDatasetState`/`Coverage`, and the Redis manifest carries `priceDatasetVersion` | automatic, lazily on the next read of that security | none (optional pre-warm) | yes, rows are replaced not deleted | no: the loader filters coverage by variant |
| `BENCHMARK_PRICE_DATASET_VERSION` 1→2 | automatic, same mechanism | automatic on the next benchmark read | none (optional pre-warm) | yes | no |
| `DERIVED_STATE_REVISION` 4→5 | automatic: variant plus the manifest's `derivedStateRevision` | automatic; rows for the rebuilt range are replaced | none | yes | no |
| PIT fundamentals availability | the migration corrects the affected rows in place, and the r5 manifest mismatch invalidates every cached statement projection | intrinsic values re-materialize with the derived state | none | yes | no |
| Ratio storage | write-path only | none | none | yes; old rows keep their last digit | harmless: both are valid `numeric` |
| Monitor `Since` | read-path projection only | none | none | yes; 0 of the Dashboard-visible rows lack `lifecycleSinceDate` | no |
| Matrix copy + Redis flush | QA environment only | on the next `qa:matrix:provision` | none | n/a | n/a |

Two consequences an operator should expect:

1. **A first-touch re-hydration burst.** Roughly 8 provider requests per security the first time each
   one is read after deploy, through the shared FMP gate. `ai/architecture/production-capacity.md`
   already describes this as the deliberate cost of a dataset bump. It can be moved off the request
   path with `pnpm data:resync` and `pnpm benchmarks:prewarm`.
2. **Queued backtests are refused, not mixed.** A run records `dataRevisions` at submission and the
   worker refuses one it cannot honour with `ENGINE_VERSION_MISMATCH` — before the execution
   calendar, before any security, before any provider or cache read, and on every retry. Runs queued
   before the deploy must be resubmitted. This is pre-existing machinery; the new constants plug
   into it automatically.

There is no startup version check, by design: invalidation is per read, so a partially-warmed
environment is correct at every moment rather than correct only after a batch job.

## Production isolation

**PASS.** No production code imports audit code.

- Every reference to `data-correctness-audit` outside that directory is a doc comment, the opt-in
  `pnpm audit:data-correctness` script, or the ESLint rule that keeps the oracle independent.
- `app.module.ts` registers no audit module; no `@Controller` exists anywhere under the audit
  directory; `dist/app.module.js` contains no audit reference.
- `apps/worker/src/monitor/data-correctness-scan.ts` is a standalone script nothing imports.
- The web client bundle contains no audit code and the route manifest no audit route. The audit's
  Playwright spec (`*.audit.spec.ts`) is matched by no project in `playwright.config.ts`, so
  `pnpm test:e2e` cannot pick it up.
- No new package export: `packages/*/src/index.ts` is unchanged. The new exports
  (`statementPublicAvailabilityDate`, `tradingSessionCloseInstant`, the version constants) are
  production code used by production callers.
- The production application reads no audit artifact, no `.debug` path, no matrix archive, no
  provider snapshot and no audit-only environment variable.

`apps/api/dist` does contain the compiled audit and QA-matrix modules, because `nest build` compiles
everything under `src`. Nothing imports or registers them, `start:prod` runs `node dist/main.js`, and
this is the pre-existing arrangement for the repository's other CLIs — NON-BLOCKING.

## Dataset revisions

Traced end to end for all three families, in both a fresh and an upgraded environment:

```
constant  →  persisted variant (StockDatasetState / StockDatasetCoverage, keyed by variant)
          →  Redis manifest field (priceDatasetVersion / derivedStateRevision), checked by isCurrent()
          →  loader: manifest not current ⇒ not READY ⇒ re-hydrate; coverage under the new variant is
             missing ⇒ fetch and replace rows; derived state rebuilt and written under the new variant
          →  every consumer reads through that loader
```

Superseded **price** coverage and state rows are pruned on the first successful sync of the new
variant (28 stale v2 rows remain in the development database only for securities not yet read).
Superseded **derived-state** coverage rows are not pruned and accumulate as inert metadata — r2 and
r3 rows from earlier bumps are still present on `main` — which is harmless because the loader
filters by variant.

## Redis/cache

**PASS.**

- Dataset versions live in the manifest payload, which `isCurrent()` compares field by field, so a
  pre-deploy projection can never satisfy a post-deploy read. Statement, price and derived reads all
  pass that gate.
- No deployment step needs a flush; a flush costs provider traffic and nothing else.
- The only flush this branch introduces is inside `qa:matrix:provision`, scoped to the matrix Redis
  index, refusing unless the URL names exactly the index the environment reports, with three unit
  tests. It exists because a re-copied matrix database was being served from projections of the
  previous copy (494 of 496 runs failed invariant 17 on a cached in-session benchmark bar).
- Verified isolation in the clean room: index 5 held 2,480 keys of its own while the development
  index and the matrix index were untouched.

## `data:resync`

**PASS for safety.** It is a data-maintenance CLI, not a runtime path.

| Property | Result |
| --- | --- |
| Scope | explicit: `--matrix` or one or more `--symbol`; refuses with neither |
| Arguments | `--from` required and validated, `--to` defaults to today, `from > to` refused, unknown flags refused |
| Dangerous targets | refuses any database whose name matches `matrix` or `test` before opening a connection |
| Provider traffic | through the shared `RedisFmpRequestGate`; pinned by `fmp-gate-coverage.test.ts`, which now lists this CLI as a known composition root |
| Deletion | none of its own. It reads through the canonical loader, which replaces rows only for dates the provider returned |
| Safeguards | uses the hydration lock and the ordinary loader; bypasses nothing |
| Failure handling | per-symbol try/catch, failures counted, non-zero exit; partial completion is recorded as coverage and the next run continues |
| Idempotent | yes: a second run over complete coverage makes no provider request (observed: 0) |
| Read-only mode | `--verify-only` reports without touching the provider |
| Documentation | usage block in the file, and the runbook below |

## Git/artifacts

**KEEP** all 9.1 MB currently committed:

| Directory | Size | Decision | Reason |
| --- | --- | --- | --- |
| `intrinsic/` (34 files) | 6.9 MB | KEEP | 121 filing-event valuations per security with the model inputs and `effectiveFrom` dates — the durable evidence for the intrinsic-value engine and the PIT rule, not a per-day dump |
| `backtests/` (14 files) | 1.6 MB | KEEP | 10 sample scenarios, the 1,000-run index and the section summary |
| `technicals/` (34 files) | 384 KB | KEEP | per-security comparison counts and samples |
| `ui/`, `lookahead/`, `strategies/`, `signals/`, `source-data/`, `stock-details/`, `dashboard/`, `lists/`, `manifest.json`, `SUMMARY.md` | 420 KB | KEEP | the manifest, per-section summaries and the expectations the browser stage was checked against |

**REMOVE**: nothing. Regenerable bulk is already excluded — `.gitignore` adds
`artifacts/data-correctness-audit/backtests/scenario-*.json` (10 samples remain tracked, 990 are
not), `artifacts/data-correctness-audit/source-data/raw/` and `artifacts/data-correctness-audit/ui/logs/`.
`.debug/` was already ignored; 0 files under it are tracked; no logs, dumps, screenshots or caches
are tracked.

One review fix: `backtests/summary.json` and `manifest.json` recorded the sweep by **absolute path**,
which committed a developer's home directory into the evidence. They now record the sweep directory
name.

## CI

**Unchanged by this branch** (`.github/workflows/ci.yml` has no diff). Normal PR CI remains:
`install --frozen-lockfile`, `db:generate`, `db:validate`, `db:check-drift`, `db:migrate:deploy`,
`lint`, `typecheck`, `test`, `stock-data test:redis`, `openapi:validate`, `build`.

- The 3,870-second matrix and the audit are reachable only through `pnpm qa:matrix:run` and
  `pnpm audit:data-correctness`, which CI does not call and no lifecycle hook references.
- The audit's own unit tests do run in the normal suite and cost 27 ms in total
  (`oracle.test.ts` 9 ms, `audit-case.test.ts` 18 ms).
- No CI step needs a local artifact, `.debug`, or a provider key. The hermetic E2E fixtures are
  unchanged.
- `db:check-drift` passes with the new migration, verified in the clean room.

## Production build

**PASS** in the clean room: all ten packages, `apps/web` (`✓ Compiled successfully`), `apps/worker`
and `apps/api` build from a fresh `node_modules` with no existing build output. See Production
isolation for what the output does and does not contain.

## Smoke test

**PASS**, clean room, from built output.

| Surface | Result |
| --- | --- |
| API health | `{"status":"ok","service":"api"}` |
| Database | migrations, seeds, catalog sync (9,861 securities created), reads and writes |
| Redis | 2,480 keys in its own index |
| Worker | backtest child and monitor child ready; monitor cycle 1 empty and released; cycle 2 evaluated 3 monitors and reconstructed 66 levels |
| Auth/bootstrap | admin login, Terms acceptance, admin-only endpoint |
| Dashboard | `GET /dashboard` 200; 14 rows after the first real cycle, each with `since` at its own observation session's close |
| Stock Details | `GET /stocks/AAPL` 200 with 252 bars, 252 technical rows, 1,008 intrinsic points from a cold start |
| Backtest | submitted, executed, `COMPLETED`, 82 trades, readable through the API |
| Web | `/` 200 (renders the Dashboard), `/stocks/AAPL` 200, `/backtests` 200, `/pricing` 200 |

## Rollback

**SAFE WITH OPERATIONAL STEP.**

| Aspect | After rolling back to `main` |
| --- | --- |
| Schema | compatible: the only new migration is a data-only `UPDATE`, no DDL. Old code reads the same tables; Prisma does not check migration history at runtime |
| Fundamentals | the corrected `availableFromDate` values remain and old code reads them as written, so the corrected point-in-time semantics persist — old code applies its rule only when *writing* a new statement |
| Prices | old code looks for `split-adjusted-eod-full:v2`, which was pruned for every security touched after the upgrade, so it re-fetches and re-establishes v2. No data loss; a second re-hydration burst |
| Derived state | r4 coverage rows survive a r5 rebuild, so old code trusts its own coverage and serves rows whose values were computed under r5. Numerically these are the audited-correct values; they are not recomputed. If strict r4 semantics are wanted, bump or rebuild deliberately |
| Ratios | old code resumes writing double-rounded ratios; existing single-rounded rows stay. Both valid `numeric`, invisible in the UI |
| Monitor `Since` | the Dashboard reverts to showing the scan instant. No data change: both columns were always written |
| Queued backtests | runs queued under the new constants are refused with `ENGINE_VERSION_MISMATCH` and must be resubmitted |

Nothing requires restoring data, and no rollback step is destructive. The operational step is
expecting the second re-hydration burst and resubmitting queued runs.

## Runbook

**Before deploy:** nothing. Optionally note the current time, so the first-touch burst is
attributable.

**Deploy:** the normal path — `pnpm install --frozen-lockfile`, `pnpm db:migrate:deploy`,
`pnpm build`, restart API and worker. The migration is a data-only `UPDATE` over
`FinancialStatement` rows whose provider filing date is not after the fiscal period end; it never
moves an availability date earlier.

**After deploy:** no required step. Expect a re-hydration burst on first touch per security, and
resubmit backtests that were queued before the deploy.

Optional, to move that burst off the request path (both go through the shared provider gate):

```bash
pnpm data:resync --matrix --from 1992-01-01        # or --symbol X --symbol Y …
pnpm benchmarks:prewarm --code SP500 --from 1996-01-01
```

Verification, read-only and provider-free:

```bash
pnpm data:resync --matrix --from 1992-01-01 --verify-only
```

It prints bars and bounds per security, dataset state against recorded coverage, and any
execution-calendar session absent inside a security's own range. Expect `0` absent sessions and
"Coverage agrees with dataset state everywhere coverage is recorded". Duration in this environment:
about 3 s per security for a forced tail re-read, one provider request each; a full cold
re-verification is about 8 requests and 10–40 s per security.

**Fresh environment only:** run the catalog synchronization (`POST /admin/securities/sync` as an
administrator) before `pnpm builtins:bootstrap`, which is pre-existing behaviour and says so when it
refuses.

## Validation gate

Run for this review, all from the clean room unless noted:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS, lockfile unchanged |
| `pnpm db:generate` / `db:validate` | PASS |
| `pnpm db:migrate:deploy` (empty database) | PASS, 33 migrations |
| `pnpm db:check-drift` | PASS, schema matches the migration history |
| `pnpm db:seed`, `pnpm builtins:bootstrap` | PASS (after the catalog sync) |
| `pnpm build` | PASS, all packages and apps |
| `pnpm lint` (main worktree) | PASS |
| `pnpm typecheck` (main worktree) | PASS |
| `pnpm -r --no-bail test` (main worktree) | 3 failures in the parallel run, all green in isolation: `redis.integration.test.ts` ×2 (5 s timeouts) and one `GET /dashboard` 404 in `builtins.integration.test.ts`; isolated reruns api 1,305/1,305, stock-data 469/469, builtins 19/19 |
| `pnpm --filter @intrinsic/api test` (after the review fix) | 1,304 of 1,305; the one failure was `securities-sync.integration.test.ts`, which passes 10/10 alone — the same parallel-load family, a different file each run |
| `pnpm lint`, `pnpm typecheck` (after the review fix) | PASS |
| `pnpm openapi:validate` | PASS, 54 paths |
| `pnpm test:e2e` (main worktree, hermetic stack) | PASS, 238 passed |
| `pnpm audit:data-correctness --sections=backtests` (after the review fix) | PASS, 1,000 of 1,000 scenarios, 0 mismatches |
| Clean-room smoke | PASS, see above |

The full 69.8-million-comparison audit was **not** re-run: the only production files this review
touched are none — both review fixes are inside the audit harness (`run-audit.ts`,
`run-backtest-audit.ts`), which changes what the evidence records, not what the product computes.
The backtests section was re-run anyway to regenerate the affected artifacts, and reproduced all
1,000 runs.

## Findings

### BLOCKER

None.

### SHOULD FIX — both fixed during this review

1. **Committed evidence carried an absolute home-directory path.** `backtests/summary.json` and
   `manifest.json` recorded the sweep as `/Users/<name>/…`. They now record the directory name, and
   the affected artifacts were regenerated.

### NON-BLOCKING

1. `apps/api/dist` ships the compiled audit and QA-matrix modules. Nothing imports or registers
   them; `start:prod` runs `dist/main.js` only. Same arrangement as the repository's existing CLIs.
2. Superseded derived-state coverage rows (r2, r3, r4) are never pruned. Inert: the loader filters by
   variant. Pre-existing on `main`.
3. `apps/web/test-results` is not in `.gitignore` (pre-existing). Playwright failure snapshots can
   contain a persona password, which is why the audit's UI stage deletes that directory itself after
   running. Nothing under it is tracked.
4. A fresh environment must run the catalog synchronization before `builtins:bootstrap`. Pre-existing,
   documented, and the command refuses with an actionable message.
5. The deploy causes a one-time first-touch re-hydration burst per security. Deliberate and already
   described in `ai/architecture/production-capacity.md`; the runbook gives the optional pre-warm.
6. Statement availability is now conservative rather than exact where the provider supplies no filing
   date (up to about a month late for a large accelerated filer). Documented as a remaining risk in
   the audit report; removing it needs a source that dates those filings.

## Final recommendation evidence

`BLOCKERS REMAINING: 0`

Operational steps to know before deciding:

1. Deploying needs no manual data step. Expect a first-touch provider re-hydration burst (~8
   requests per security, through the shared gate); pre-warm with `data:resync` and
   `benchmarks:prewarm` if you would rather choose when it happens.
2. Backtests queued before the deploy are refused with `ENGINE_VERSION_MISMATCH` and must be
   resubmitted. That refusal is what prevents old and new semantics from mixing inside one run.
3. Rollback is safe without restoring data, but expect a second re-hydration burst, and note that
   derived-state rows already rebuilt under r5 will be served by r4 code without recomputation.
4. A fresh environment needs `POST /admin/securities/sync` before `pnpm builtins:bootstrap`.
