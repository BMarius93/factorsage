# QA-MATRIX fixtures — the Backtest V1 validation matrix

Deterministic, reusable inputs for a validation sweep of Backtest V1:

```text
10 Strategies  ×  10 Stock Lists  ×  10 Backtest configurations  =  1,000 runs
```

This document describes the **inputs**. The runner that executes the thousand combinations is
`docs/development/qa-matrix-runner.md` — deliberately separate work, for the reason in
[Why the matrix is backend-level](#why-the-matrix-is-backend-level).

| Where                             | What                                                         |
| --------------------------------- | ------------------------------------------------------------ |
| `packages/testing/src/qa-matrix/` | the canonical definitions — inert data and pure functions    |
| `apps/api/src/qa-matrix/`         | the seeder that reconciles those definitions into a database |
| `pnpm test:matrix:seed`           | the command                                                  |

## Naming

Every fixture lives in one reserved namespace so nothing can collide with an ordinary QA fixture:

```text
Strategies    QA-MATRIX-S01-<short-description>  …  QA-MATRIX-S10-…
Stock Lists   QA-MATRIX-L01-<short-description>  …  QA-MATRIX-L10-…
Configs       QA-MATRIX-C01-<short-description>  …  QA-MATRIX-C10-…
```

One run of the matrix is identified as:

```text
QA-MATRIX-Sxx-Lxx-Cxx        e.g. QA-MATRIX-S04-L09-C06
```

`qaMatrixRunLabel(strategyId, listId, configId)` builds it; nothing else should format it.

## The matrix clock

**Every date in the matrix is derived from one declared clock, and none is written down.**

The product horizon is relative, not absolute. The loader clips every projection to
`[today - STOCK_HISTORY_YEARS, today]` (`CanonicalStockDataService.projectionRange`), and the New
Backtest form offers `subtractYears(today, BACKTEST_MAX_PERIOD_YEARS)` as its earliest start. A
fixture with a hard-coded start is therefore correct only on the day it is written. The day after,
it asks for a period whose oldest part the loader **silently drops** — no rejection, no warning —
and the "thirty-year" run quietly becomes a shorter one against a boundary nobody re-checked. That
is the failure mode this design exists to prevent, and it is why `1996-01-01` is not in this
document any more.

```text
asOfDate      the declared clock; defaults to today
horizonStart  subtractYears(asOfDate, BACKTEST_MAX_PERIOD_YEARS)   ← the exact product boundary
periodEnd     the last trading session at or before the clock, capped by the validator's own
              period arithmetic
```

- the **thirty-year** configurations start _exactly_ on `horizonStart`, because the point of the
  longest configuration is to exercise the boundary the product actually enforces;
- the ten-, three- and one-year configurations start `subtractYears(periodEnd, n)`, comfortably
  inside it;
- no configuration can start before `horizonStart` or end after the clock, which is asserted rather
  than asserted-about.

Determinism is preserved, not traded away: every date is a pure function of `asOfDate`, so one
declared clock always yields the identical matrix. A sweep pins its clock, records it beside the
results, and is reproducible from that one value.

```bash
QA_MATRIX_AS_OF_DATE=2026-09-09 pnpm test:matrix:seed    # pin a sweep
pnpm test:matrix:seed                                    # seed the matrix that is valid today
```

`periodEnd`'s cap deserves one line of explanation. `subtractYears` clamps 29 February to the 28th;
the submission validator's own year arithmetic is a plain `setUTCFullYear` and does not. On a leap-day
clock the validator's 30-year cap therefore lands one day before the clock, so the clock clamps the
**end** rather than the start — moving the start would defeat the whole purpose of the configuration.

## The execution calendar — one source of truth

**Which dates a run simulates is settled by the pinned execution-calendar series' own bars, and by
nothing else.** A submitted run pins `executionCalendarSeriesId` (the current version of the
`SP500` benchmark, `EXECUTION_CALENDAR_REFERENCE_CODE`), and the worker's `loadExecutionCalendar`
reads that series' `BenchmarkDailyPrice` rows into a `readonly LocalDate[]` which becomes
`BacktestSimulationInput.executionCalendar`. A date exists because the market traded, evidenced by
real data — never because a rule said it should.

The QA matrix consumes **that same set**, and holds no opinion of its own:

```text
BenchmarkDailyPrice.date for the pinned SP500 series   ← the single source of truth
        │  readonly LocalDate[]
        ├─ worker    loadExecutionCalendar → buildExecutionCalendar → simulation
        ├─ seeder    loadQaMatrixExecutionCalendar → the persisted L10 windows
        └─ offline   captured-execution-calendar.ts → the fixture suites
```

`ExecutionCalendar` in `@intrinsic/strategy` (beside `buildExecutionCalendar`, in the engine's own
calendar module) is the shared abstraction: a navigable view over one date set, with `has`,
`onOrAfter`, `onOrBefore`, `advance`, `firstOfYear`, `lastOfYear`. **It contains no notion of
weekends, holidays or closures** — it can only report whether a date is in the set it was given. Hand
it a Sunday and the Sunday is a session; that is asserted by a test, because it is the property that
makes it a lookup rather than a second calendar.

`captured-execution-calendar.ts` is a **capture of that source, not a second one**: the literal
output of the same query, in the same representation, with its provenance in the file header. It
exists so the fixture suites resolve boundaries with no database and no provider. Refresh it with
`pnpm --filter @intrinsic/testing capture:execution-calendar` against a database whose `SP500`
series carries real history.

Two consequences worth stating plainly:

- **The tail is allowed to be behind.** A capture ends the day it was taken. A run cannot simulate
  past the last date its calendar holds, so the clock resolves `periodEnd` to the last date _in the
  calendar it was given_ — an older capture yields an earlier period end, and nothing breaks.
- **The fixtures follow the calendar in use.** Seeding against a database whose execution-calendar
  series is thin produces boundary windows inside what that series covers. The seed reports the
  calendar it used (count, first, last) on every run, so this is never silent. It also means a
  synthetic seeded series — which may carry a bar on 1 January — legitimately makes the year-boundary
  window's two dates calendar-adjacent, and `normalizeBuyWindowConfiguration` then merges them into
  one range covering exactly those two dates. Both outcomes are correct; the fixture is canonicalized
  through the product's own normalizer so it always matches what the database can hold.

There is deliberately **no** holiday/closure implementation anywhere in the QA matrix. An earlier
draft had one, and it agreed with the authoritative series on all 7,547 dates it was checked
against — which is exactly why it was removed rather than kept: two implementations that agree today
are still two answers to a question that has one, and the day they diverge the fixtures would name
dates no run simulates.

## What is persistent, and what is a repository fixture

- **Strategies and Stock Lists are persistent database entities**, owned by the existing `QA_USER`
  persona. `pnpm test:matrix:seed` writes them to the **test** database; `pnpm qa:matrix:provision`
  writes the same fixtures, from the same definitions, to the dedicated **matrix** database the
  thousand-run sweep executes in (see `qa-matrix-runner.md`). They are first-class product records, so a fixture that was only
  a literal in a file could not be selected in a browser, submitted through the API, or snapshotted
  by a run.
- **Backtest configurations are versioned repository fixtures**, because the domain has no
  persistent `BacktestConfiguration` entity. A configuration is the set of execution inputs a
  `CreateBacktestRunRequest` carries and a submitted `BacktestRun` freezes into its immutable
  snapshot. Inventing a table for it purely so QA could point at one would add a product entity the
  product does not have — so the fixtures live in `configs.ts` and are asserted against the real
  submission parser instead.

## The 10 Strategies

Each exercises Backtest V1 semantics deliberately. Structural claims (which Metric families, which
level percentages, whether there is a FINAL EXIT) are re-derived from the definition by
`deriveStrategyBehaviours` and required to match exactly, so the table below cannot drift from the
code.

| Id  | Name                                     | Shape                                                                                 | What it is for                                                                                                                                                   |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | `QA-MATRIX-S01-price-above-sma200-hold`  | BUY 100% · Price is above SMA 200D                                                    | The simplest strategy: one Condition, no SELL, no FINAL EXIT. A signal that stays TRUE for long stretches, so contribution-date top-ups apply.                   |
| S02 | `QA-MATRIX-S02-golden-cross-triggers`    | BUY 100% · SMA 50D crosses above SMA 200D → FINAL EXIT on the reverse cross           | Trigger-only entry and exit, daily moving averages, one-day events, and a position lifecycle that resets on every cross pair.                                    |
| S03 | `QA-MATRIX-S03-weekly-trend-ladder`      | BUY 50% / BUY 100% (ANDed weekly + daily) · SELL 50% · FINAL EXIT                     | Weekly moving averages as Metric _and_ Value, multi-Condition AND, a scaling ladder, a partial SELL and a Condition-driven FINAL EXIT.                           |
| S04 | `QA-MATRIX-S04-rsi-nested-buy-ladder`    | BUY 25 / 50 / 100% on RSI 14D below 40 / 30 / 20 · SELL 50% · FINAL EXIT              | **Strongest eligible BUY level**: a deeply oversold date satisfies all three, the 100% level fills first and the weaker ones settle without a trade.             |
| S05 | `QA-MATRIX-S05-rsi7-high-turnover-swing` | BUY 100% on RSI 7D cross · SELL 25% / 50% on Gain · FINAL EXIT on RSI 7D cross        | **High turnover.** Positions open and close quickly, two partial SELLs fire in definition order, and exits free slots for entries the same date.                 |
| S06 | `QA-MATRIX-S06-sparse-confluence`        | BUY 100% · four ANDed Conditions plus a Trigger · FINAL EXIT on Gain > 50%            | **Rare signal.** Maximum Signal breadth across two RSI periods and daily + weekly averages; the control case for a run that legitimately barely trades.          |
| S07 | `QA-MATRIX-S07-persistent-dca-ladder`    | BUY 25 / 50 / 75% · Condition-only, weekly trend filter · no SELL, no exit            | **Contribution top-up.** Long-lived TRUE signals, nothing ever sells, so every deposit date re-measures each fired level against a larger portfolio.             |
| S08 | `QA-MATRIX-S08-close-to-ema-reversion`   | BUY 50% / 100% · Price _is close to_ EMA 200D · SELL 75% on Gain · FINAL EXIT on Loss | The only `is close to` fixture (fixed 2% tolerance) and the only one using **Loss**; market and position metrics inside one Signal.                              |
| S09 | `QA-MATRIX-S09-margin-of-safety`         | BUY 50% / 100% on MOS (DCF, Balanced) · SELL 50% · FINAL EXIT on a MOS cross          | Valuation metrics against two intrinsic-value sources, Price vs an intrinsic-value series, and a deliberate `NOT_EVALUABLE` probe where fundamentals are absent. |
| S10 | `QA-MATRIX-S10-same-day-rotation`        | BUY 25% / 100% on RSI 14D crosses · SELL 25% ×2 on Gain · FINAL EXIT on a cross       | **SELL then BUY on the same date**, across the universe. Same-symbol re-entry on its closing date stays forbidden by engine methodology.                         |

Between them the ten cover: simple Conditions; ANDed Conditions; `crosses above` and `crosses below`;
`is close to`; daily and weekly moving averages; RSI; Margin of Safety; Gain; Loss; single and
multiple BUY levels; BUY 25 / 50 / 75 / 100; SELL 25 / 50 / 75; FINAL EXIT and its absence; the
strongest eligible BUY level; lifecycle reset; contribution-day top-up eligibility; a high-turnover
strategy; a sparse one; same-day rotation; and signals that persist for months set against one-day
triggers.

## The 10 Stock Lists

All membership uses **real catalog identities** — `Security` is the identity authority, and a
fictional production symbol would be a universe the product could never resolve. The deliberately
fictional `QATEST1`/`QATEST2` rows stay what they are and are not reused here: the matrix needs
decades of listing history and a thirty-name universe.

| Id  | Name                                   | Members                                                                                                                               | Buy windows                                                                                                                                                                | What it is for                                                                          |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| L01 | `QA-MATRIX-L01-single-security-full`   | `AAPL`                                                                                                                                | FULL                                                                                                                                                                       | One security; a degenerate universe against every slot configuration.                   |
| L02 | `QA-MATRIX-L02-small-old-full`         | `KO`, `JNJ`, `XOM`                                                                                                                    | FULL ×3                                                                                                                                                                    | Small, all long-listed, all unrestricted: the clean baseline.                           |
| L03 | `QA-MATRIX-L03-small-custom-uniform`   | `MSFT`, `IBM`, `MCD`                                                                                                                  | each `2010-01-01 → 2019-12-31`                                                                                                                                             | All CUSTOM, one shared decade; opens after and closes before a run.                     |
| L04 | `QA-MATRIX-L04-small-custom-divergent` | `PG`, `WMT`, `MMM`, `CAT`                                                                                                             | `PG 1996-01-01→2005-12-31`; `WMT 2015-06-01→open`; `MMM 2000-01-01→2004-12-31` + `2012-01-01→2016-12-31`; `CAT 2025-03-03→2025-03-31`                                      | Four different shapes: bounded, open-ended, two-range, narrow.                          |
| L05 | `QA-MATRIX-L05-mixed-modes-medium`     | `AAPL`, `KO`, `JNJ`, `MSFT`, `MRK`, `XOM`, `CVX`, `HD`                                                                                | first four FULL; `MRK 1996-01-01→1999-12-31`; `XOM 2000-01-01→2009-12-31`; `CVX 2010-01-01→2019-12-31`; `HD 2020-01-01→open`                                               | Mixed FULL/CUSTOM; restricted members tile the horizon disjointly.                      |
| L06 | `QA-MATRIX-L06-later-ipos-full`        | `AMZN`, `NVDA`, `GS`, `HON`, `CRM`, `GOOGL`, `V`, `MRNA`                                                                              | FULL ×8                                                                                                                                                                    | Every member listed inside the horizon: a 30y run starts before them.                   |
| L07 | `QA-MATRIX-L07-mixed-eras-full`        | `KO`, `JNJ`, `GOOGL`, `V`, `MRNA`                                                                                                     | FULL ×5                                                                                                                                                                    | Three listing eras in one list; the universe grows during the run.                      |
| L08 | `QA-MATRIX-L08-large-thirty-full`      | 30: `AAPL ADBE AMGN AXP BA CAT CSCO CVX DIS HD IBM JNJ JPM KO MCD MMM MRK MSFT NKE PG SHW TRV UNH WMT XOM` + `AMZN NVDA GS CRM GOOGL` | FULL ×30                                                                                                                                                                   | The size a V1 user actually runs; slot contention and cash pressure.                    |
| L09 | `QA-MATRIX-L09-overlapping-windows`    | `AAPL`, `MSFT`, `GOOGL`, `V`, `NVDA`, `AMZN`                                                                                          | `AAPL 2016-01-01→2020-12-31`; `MSFT 2016-06-01→2020-12-31`; `GOOGL 2017-01-01→2019-12-31`; `V 2018-01-01→2018-01-31`; `NVDA 2022-01-01→2024-12-31`; `AMZN 2022-07-01→open` | Overlapping, nested and disjoint eligibility — with **no member eligible during 2021**. |
| L10 | `QA-MATRIX-L10-boundary-windows`       | `JNJ`, `MSFT`, `IBM`, `XOM`, `KO`                                                                                                     | `JNJ 1996-01-01→1996-01-01`; `MSFT 2015-12-31→2016-01-01`; `IBM 2022-12-31→2023-01-01`; `XOM 2024-12-31→2025-01-01`; `KO 2025-12-31→2025-12-31`                            | Windows sitting exactly on configuration boundaries, including two single-day windows.  |

Coverage across the ten: one security, small, medium and a thirty-name list; long-listed securities,
later listings and mixtures; all-FULL, all-CUSTOM and mixed membership; divergent per-security
windows; multi-range and open-ended windows; windows that open after a run starts and close before it
ends; narrow and single-day windows; and both overlapping and mutually exclusive eligibility.

## The 10 Backtest configurations

Every period is derived from the matrix clock (above); `periodEnd` is the last trading session at or
before it. Benchmark and calendar semantics are held constant — every configuration compares against
the one V1 benchmark — so a difference between two matrix runs is never a difference in what they
were compared with.

| Id  | Name                                        | Period                       | Initial capital | Monthly | Max positions | What it is for                                                                        |
| --- | ------------------------------------------- | ---------------------------- | --------------- | ------- | ------------- | ------------------------------------------------------------------------------------- |
| C01 | `QA-MATRIX-C01-thirty-year-baseline`        | `horizonStart` → `periodEnd` | 100,000         | 0       | 10            | The full horizon, starting **exactly** on the oldest date the product permits.        |
| C02 | `QA-MATRIX-C02-ten-year-baseline`           | 10y → `periodEnd`            | 100,000         | 0       | 10            | Paired with C01 it isolates the effect of the period alone.                           |
| C03 | `QA-MATRIX-C03-three-year-baseline`         | 3y → `periodEnd`             | 100,000         | 0       | 10            | Short enough that a sparse strategy may legitimately never trade.                     |
| C04 | `QA-MATRIX-C04-one-year-baseline`           | 1y → `periodEnd`             | 100,000         | 0       | 10            | The shortest period; a single annual execution window.                                |
| C05 | `QA-MATRIX-C05-normal-contribution`         | 10y → `periodEnd`            | 10,000          | 500     | 10            | Ordinary dollar-cost averaging; the top-up path on a modest balance.                  |
| C06 | `QA-MATRIX-C06-large-contribution-focused`  | 10y → `periodEnd`            | 1,000           | 25,000  | **5**         | Deposits dominate, into a focused portfolio where each top-up is large enough to see. |
| C07 | `QA-MATRIX-C07-minimum-capital`             | 10y → `periodEnd`            | 1               | 0       | 10            | The contract minimum: proves share quantities stay continuous rather than rounding.   |
| C08 | `QA-MATRIX-C08-maximum-capital`             | `horizonStart` → `periodEnd` | 1,000,000,000   | 0       | 20            | The contract maximum; slots and signals bind instead of cash.                         |
| C09 | `QA-MATRIX-C09-single-position`             | 10y → `periodEnd`            | 100,000         | 0       | 1             | One slot: candidate ordering is decisive and an exit frees the only slot.             |
| C10 | `QA-MATRIX-C10-wide-portfolio-contribution` | `horizonStart` → `periodEnd` | 250,000         | 1,000   | 30            | Longest period, widest portfolio and monthly deposits at once.                        |

Coverage: 30y / 10y / 3y / 1y periods; zero, normal and large contributions; the minimum, a normal
and the maximum initial capital; and `maximumPositions` of **1, 5, 10, 20 and 30**. Three
configurations start exactly at the product horizon, so the boundary is executed rather than
described.

### L10, the execution-date boundary list

Every window endpoint is an index into the authoritative execution-date set — `first`, `last`,
`advance(±1)`, `firstOfYear`, `lastOfYear` — so no endpoint can be a day the engine would not
simulate, and the matrix never decides what a session is.

| Security | Window                                                     | Case                                                                         |
| -------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `JNJ`    | first execution date → +19 sessions                        | Opens on the **first execution date** of the thirty-year run.                |
| `KO`     | −19 sessions → last execution date                         | Closes on the **exact end execution date** every run simulates.              |
| `MSFT`   | next execution date after the 10y run opens → +39 sessions | Opens on the **next execution date**, excluding the run's opening date only. |
| `IBM`    | −39 sessions → execution date before the 1y run opens      | Closes **immediately before** a later relevant execution date.               |
| `XOM`    | one single execution date inside the 1y run                | A **one-session window** every configuration reaches.                        |
| `CAT`    | last execution date of year _Y−1_ + first of year _Y_      | **Year-boundary** behaviour with a real execution date on each side.         |

`CAT`'s two dates persist as two canonical ranges when they are not calendar-adjacent (the normal
case: nothing trades on 1 January) and as one merged range when the calendar in use does carry a bar
between them. The covered dates are identical either way, and the tests assert the covered dates plus
the adjacency rule rather than a hard-coded range count.

## Seeding

```bash
pnpm infra:up
pnpm db:test:prepare        # once, after a schema change
pnpm test:users:seed        # the QA_USER persona that owns the fixtures
pnpm test:matrix:seed       # add QA_MATRIX_AS_OF_DATE=YYYY-MM-DD to pin the clock
```

It reports what it did:

```text
QA matrix fixtures ready: as of 2026-09-09, execution calendar 1709 dates
(2020-01-02 to 2026-09-04), 10 strategies (0 created, 0 updated),
10 lists (0 created, 0 updated), 33 securities (0 created), 0 stale fixture(s) removed,
1000 combinations available.
```

The calendar line is not decoration: the boundary fixtures are cut against exactly those dates, so a
database with a thin execution-calendar series produces a correspondingly narrow `L10`. Seeding
refuses outright when the series has no bars at all, because there would be nothing authoritative to
cut against.

Properties, each pinned by a test in `apps/api/src/qa-matrix/`:

- **Deterministic.** No generated identifier carries meaning: strategy row ids are positional
  (`s04-buy2-c1`), and a fixture is reconciled by its name.
- **Idempotent for a clock.** A second seed with the same clock against an already-correct database
  writes _nothing_ — not even a no-op update, which would still move `updatedAt`. Seeding with a
  later clock legitimately updates `L10`, whose windows are cut against that clock's sessions; pin
  `QA_MATRIX_AS_OF_DATE` for a sweep that must not move.
- **Convergent.** A drifted fixture is repaired in place: a changed definition appends a version
  (existing versions are never rewritten, because a completed run may reference one), a changed
  description is reset, a list member the definition no longer contains is removed with its windows,
  and a drifted buy window is replaced as a complete set rather than merged into.
- **Test database only.** It resolves `TEST_DATABASE_URL` explicitly instead of inheriting
  `DATABASE_URL`, and refuses when `NODE_ENV` is production, when `TEST_DATABASE_URL` is unset, or
  when it names the development database.
- **QA-owned only.** Every read, write and delete is filtered by the resolved owner's `userId`, and
  every delete additionally by the reserved `QA-MATRIX-` prefix — so another account's identically
  named rows are untouched, and so are the QA account's own ordinary strategies and lists.
- **Creates no runs.** Seeding provisions inputs. Nothing executes.

The seeder also ensures the catalog carries the 33 matrix securities, creating **identity only** for
one that is missing and leaving an existing row exactly as it is — the catalog is the identity
authority, and a synchronized row is more accurate than a fixture. The market data a matrix _run_
needs is hydrated by the normal loader; seeding does not invent prices.

## Why the matrix is backend-level

The thousand-run sweep is an API-level exhaustive check whose value is arithmetic: every strategy
against every universe against every set of execution inputs, compared for correctness and
regression. A browser adds nothing to that and multiplies its cost — a thousand Playwright cases
would be a thousand sign-ins, page loads and polling loops around assertions that never leave the
API.

The intended architecture is therefore three separate pieces:

1. **Persistent QA Strategy/List fixtures** — this document.
2. **A backend/API matrix runner** for all 1,000 combinations — `qa-matrix-runner.md`.
3. **A small representative Playwright suite** for the browser flows a human actually performs.

`QA_MATRIX_PLAYWRIGHT_SAMPLE` names what step 3 should drive: `S01×L01×C04` (the fastest complete
submit-run-read journey), `S04×L05×C05` (buy windows and contributions both visible in the result)
and `S10×L08×C09` (thirty securities competing for one slot). That list is the only Playwright
support this work adds; no spec is written yet.

## Retention of future matrix runs

Strategies and Lists are **persistent**; matrix run results must not be. A thousand runs per sweep
would otherwise accumulate forever in the QA account.

The runner should identify its own output through `isQaMatrixRun`, which reads a run's denormalized
`strategyName` and `stockListName` columns and requires **both** to be in the reserved namespace.
Those columns are the right key because they survive everything: a `BacktestRun` snapshot is
immutable, and `strategyId` / `stockListId` are nulled when a fixture is deleted, so neither foreign
key can be trusted to identify an old matrix run.

Consequences the runner should keep:

- an ordinary backtest can never match, and neither can a developer's own run that used a matrix
  strategy against a personal list — both names must match;
- a new sweep may delete the previous sweep's runs before or after executing, and deleting a run
  cascades only that run's own progress, milestones, trades, equity points, positions and summary;
- nothing outside the namespace is ever a candidate for cleanup, so the cleanup needs no allow-list
  of "runs to keep".

## Files

```text
packages/strategy/src/backtest/calendar.ts          ExecutionCalendar — the shared abstraction
packages/testing/src/qa-matrix/captured-….ts        a capture of the authoritative date set
packages/testing/src/qa-matrix/clock.ts             the matrix clock: horizon, periods, boundary dates
packages/testing/src/qa-matrix/securities.ts        the 33 real catalog identities
packages/testing/src/qa-matrix/strategies.ts        the 10 Strategy definitions + behaviour derivation
packages/testing/src/qa-matrix/lists.ts             the 10 Stock List definitions
packages/testing/src/qa-matrix/configs.ts           the 10 configuration fixtures
packages/testing/src/qa-matrix/index.ts             naming, enumeration, retention predicate, PW sample
apps/api/src/qa-matrix/seed-qa-matrix.ts            the reconciling seeder
apps/api/src/seed-qa-matrix.ts                      the `pnpm test:matrix:seed` entry point
packages/testing/scripts/capture-execution-calendar.ts   refreshes the capture from a database
```

Tests: `apps/api/src/qa-matrix/qa-matrix-fixtures.test.ts` (definitions against the real Strategy and
backtest-submission contracts, the horizon proofs and the `L10` session proofs),
`seed-qa-matrix.test.ts` (the database-target guards), and `qa-matrix.integration.test.ts` (the seed
against real PostgreSQL, including that every persisted boundary is a real session).
