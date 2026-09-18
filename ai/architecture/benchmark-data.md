# Benchmark Data — Architecture

A benchmark is a first-class product concept, deliberately **not** a `Security`.

## Why it is separate

A benchmark is passive comparison data. It is never bought, never consumes portfolio cash, never
occupies a position slot, and has no fundamentals, no derived technicals and no intrinsic values.

`Security.isBenchmark = true` would drag every one of those behaviours along with it: the benchmark
would enter the stock catalog and its search, occupy a slot in the resident-stock LRU, and invite a
derived-state rebuild that calculates RSI and DCF for an index proxy for no reason. Benchmark
identity and benchmark market data therefore stay explicit.

```text
Benchmark                         product identity: code, name, description, active,
 │                                backtest-selectable, display order
 └─ BenchmarkSeries               IMMUTABLE definition: source kind, series type, provider symbol,
     ├─ BenchmarkDailyPrice       currency, methodology version — appended, never edited
     ├─ BenchmarkDatasetState     tail/coverage watermarks
     └─ BenchmarkDatasetCoverage  exact successful coverage intervals
```

## Two properties that are easy to conflate, and must not be

**`isActive` is not `isBacktestSelectable`.** The first asks whether the system maintains the
series at all; the second asks whether a customer may compare a portfolio against it. They started
as one flag because every benchmark answered both the same way, and the market-reference indices are
the case that separates them: they are fully live system series — reconciled, hydrated, stored,
projected, read on every Dashboard load — and a user may never select one. Expressing that as
`isActive = false` would have switched off the loading the Dashboard depends on in order to tidy a
dropdown, and would have made "inactive" mean two different things depending on the row.

The rule is enforced where it matters rather than in the picker: `/benchmarks` filters on both, and
`BacktestsService` refuses a submission naming a non-selectable code with the catalog's existing
wording — to a submitter, a benchmark that may not be chosen and one that does not exist are the
same refusal. Leaving it to the dropdown would have made the rule presentational.

**`sourceKind` is not `seriesType`.** `sourceKind` says *how* the data is obtained; `seriesType`
says what the financial object *is*:

- `ETF_PROXY` — a tradable fund tracking an index. A share price, carrying the fund's expense ratio
  and distribution behaviour, and something a funded comparison portfolio can conceptually buy.
- `INDEX` — the index itself. Not investable, no expense ratio, and for `^VIX` not a price at all.

`SPY` and `^GSPC` are both `FMP_SYMBOL`, and they are not the same kind of thing. `seriesType` lives
on the **series**, not the product row, because changing it changes what every stored bar means —
so reconciliation treats it as part of the immutable definition and a change appends a version.
Nothing in a browser contract carries it: the web app selects a code and reads labels, and what a
series is remains a server-side fact.

## Identity is versioned, and data hangs off the version

A benchmark's _meaning_ can change: `SP500` is sourced from the `SPY` ETF today and could be sourced
from a direct index feed tomorrow, which would change every number it produces.

That is not an edit, and it must not be stored as one. If the source, provider symbol, currency or
methodology lived on the mutable product row, changing any of them would silently reinterpret every
bar already stored under that benchmark id — and a run that had been queued but not yet started
would execute against a definition it never chose.

So reconciliation is **append-only** for the definition:

- the product row's words (name, description, ordering, selectability) are corrected on every boot;
- a definition that differs from the one in force creates `BenchmarkSeries` version _n+1_;
- a definition identical to the one **currently in force** creates nothing, so reruns converge;
- returning to a source used before is a _new_ version, not a resurrection of the old one: its data
  is fetched under it, because a history restated years later is not the history already stored;
- market data, coverage, watermarks and the Redis projection are all keyed by `seriesId`.

A `BacktestRun` therefore pins `benchmarkSeriesId` at submission and the worker resolves **by id**.
Resolution by code does not exist on the worker's port at all — `BacktestBenchmarkLoader` exposes
`getSeries(seriesId)` and nothing else, so the mistake cannot be reintroduced by accident.

`packages/stock-data/src/benchmark-series.integration.test.ts` pins the three consequences: a
catalog change after submission cannot change what a pinned run reads; v1's bars cannot be
overwritten or reinterpreted as v2; and a completed run's configuration stays interpretable —
including the provider symbol it was sourced from — after the catalog advances.

## The execution calendar is not the comparison benchmark

The dates a run simulates decide when a monthly contribution lands and what the return index is
based at. They therefore decide the portfolio's own numbers, and they must not depend on what the
user chose to compare against: two runs identical but for their benchmark must produce identical
trades and an identical portfolio return.

The engine names its own reference series for this — `EXECUTION_CALENDAR_REFERENCE_CODE` — and a run
pins that series version too, in `snapshot.executionCalendar`. It is the same code the product also
offers as a comparison today, which costs nothing: one hydration serves both roles, and the
separation lives in the code and the snapshot rather than in duplicated bytes.

The pin is **required**: `BacktestRun.executionCalendarSeriesId` is `NOT NULL` behind an
`onDelete: Restrict` foreign key, a submission that cannot resolve the reference is refused with
`503`, and an attempt that cannot read the pinned series fails with
`EXECUTION_CALENDAR_UNAVAILABLE`. The comparison benchmark may still degrade to a null comparison,
because it changes nothing about the portfolio; the calendar may not.

`packages/strategy/src/backtest/simulate.test.ts` proves the independence against a benchmark that
trades on days the market did not, and
`packages/strategy/src/backtest/simulation.window.test.ts` proves an anomalous security bar outside
the calendar — a Saturday, a market holiday — still cannot become a portfolio day once execution is
split into calendar-year windows.

## Two readings of one series

A run's pinned comparison series is read twice per simulated date, and the two readings answer
different questions:

- the **growth index** (`close / closeOnFirstSimulatedDate`) is `time-weighted-index@1`, and is what
  `benchmarkReturnPercent`, `alpha` and the benchmark's own drawdown are built on;
- the **funded comparison portfolio** buys fractional shares with the run's own external cash flows
  and marks them at the close in effect on the date, which is the absolute `S&P 500` line on the
  chart (`comparisonScenarios: funded-scenarios/strategy-benchmark-cash@1`).

The second is not derivable from the first once a run has monthly contributions: a growth index
knows nothing about the price each contribution actually bought at. Both readings come from one
monotonic cursor over one series, so they can never disagree about which bar was in effect on a
date, and neither is allowed to redefine the other. `ai/architecture/backtest-execution.md` holds
the formulas.

## What is deliberately shared

Everything about _how_ market data is obtained. Duplicating it would be the real mistake:

```text
FMP  →  canonical provider adapter (paginated to completeness)
     →  coverage reconciliation (missingCoverageRanges, the one date arithmetic)
     →  hydration lock (the same LoadCoordinator / Redlock)
     →  retries, rate limits, shared 429 cooldown (the same FMP gate)
     →  PostgreSQL durable persistence (advisory-locked write, compacted coverage intervals)
     →  Redis yearly projection
```

`FmpClient.getBenchmarkDailyPrices` and `getDailyPrices` share one private walk over
`historical-price-eod/full`; only the identity stamped on the rows differs. The port is split
(`FmpBenchmarkProviderPort`) for the same reason `FmpSecurityCatalogPort` is: an implementation or a
fake should depend only on the calls it makes.

The worker **never** calls FMP around this infrastructure.

## Redis namespace

```text
benchmark:v1:benchmark:<seriesId>:daily-price:<year>
benchmark:v1:benchmark:<seriesId>:manifest
```

Keyed by the immutable series, so a new version projects into its own keys and can never read a
previous version's cached bars — and so can a *different* benchmark: `SP500`, `SP500_INDEX`,
`DJIA_INDEX` and `VIX_INDEX` are four series ids, four sets of keys, four coverage ledgers and four
watermarks. Hydrating an index cannot touch the SPY benchmark's bars or mark its coverage, which is
what `packages/stock-data/src/benchmark-market-references.integration.test.ts` proves.

Distinct from `stock-data:v2:security:<id>:…` on purpose: the stock LRU can never evict a benchmark,
a benchmark can never occupy a stock residency slot, and a Redis flush costs one durable re-read.

## Freshness

A hydration re-reads the bounded recent tail only when the durable freshness watermark
(`provider-eod-full:recent-tail`) has aged past the configured window. The watermark is PostgreSQL
state, not a cache entry, so a Redis flush cannot make the loader believe the series is stale and
re-download it — and a seeded environment with a current watermark runs a backtest with no provider
call at all. That is what makes the deterministic E2E path possible.

## Revisioning

`BENCHMARK_PRICE_DATASET_VERSION` is the same mechanism as `PRICE_DATASET_VERSION`: a rebuild
trigger, never a row identity. Bumping it makes every earlier coverage interval and cache manifest
invisible to the loader, and the affected range is re-verified lazily on the next read. No migration,
no data move.

## The catalog

`BENCHMARK_CATALOG` in `@intrinsic/domain` is the **one** source of benchmark metadata:

```text
code          name                          source      type        symbol  selectable
────────────────────────────────────────────────────────────────────────────────────────
SP500         S&P 500                       FMP_SYMBOL  ETF_PROXY   SPY     yes
SP500_INDEX   S&P 500 Index                 FMP_SYMBOL  INDEX       ^GSPC   no
DJIA_INDEX    Dow Jones Industrial Average  FMP_SYMBOL  INDEX       ^DJI    no
VIX_INDEX     CBOE Volatility Index         FMP_SYMBOL  INDEX       ^VIX    no
```

**`SP500` stays `SPY`, and that is a decision rather than an omission.** The backtest benchmark is
an investable ETF proxy because the funded comparison scenario buys it with the run's own cash
flows — a portfolio compared against something nothing can hold is a comparison against an
abstraction. Every completed run also pinned that meaning: `snapshot.benchmark` records the code,
the series id, the provider symbol and the methodology version it executed under, so re-pointing
`SP500` at `^GSPC` would have appended a version that re-based every future run's comparison while
leaving the old ones reading a different thing under the same name. `SP500_INDEX` is therefore a
**separate series**, not a correction of `SP500`, and the execution calendar keeps resolving
`SP500`/`SPY` exactly as before.

The three index rows are internal **market references**: what the Dashboard reports the market did.
`MARKET_REFERENCE_SERIES` in `@intrinsic/domain` names them, in display order, with the words the
product uses for them (`S&P 500`, `DJIA`, `VIX` — shorter than the catalog names, because that is
what a reader calls them). It is one list for the same reason the catalog is: no array in the web
app decides which indices exist.

The API reconciles it into PostgreSQL idempotently at startup, so a normal local, development, CI or
test database has the catalog after `migrate` with no manual SQL. No frontend array and no second
backend list repeats `SP500` or `SPY`; the browser selects a code, and `providerSymbol` never crosses
the HTTP boundary.

**Exactly one benchmark is backtest-selectable, and it is the default.** The model is built for
more: broad-market, sector, industry and global-equity benchmarks are new rows, and a composite or a
direct feed of a different shape is a new `BenchmarkSourceKind` member plus a loader for it — not a
reinterpretation of existing rows. The index references were the first proof of that: they are four
catalog entries and a boolean, with no new table, no new namespace and no new loader.

`methodologyVersion` describes what the _series means_. `SP500` is currently backed by the `SPY` ETF,
which tracks the index including its own expense ratio and distribution behaviour. Replacing that
with a direct index feed would change the numbers, so it raises the version — and because every run
snapshots the benchmark id, code, name, source kind, provider symbol and methodology version it
executed under, an already-completed run stays interpretable.

## The market overview

`GET /market-overview` is the read behind the Dashboard's three index cards. It is deliberately not
part of `GET /dashboard`: the Dashboard read model is entirely about which monitors *this viewer*
can see, and an index closed where it closed. The endpoint therefore carries no session at all — no
guard, no cookie, no viewer argument on the service — so a Guest and a signed-in customer are served
identical bytes, and a second surface wanting the same three numbers reads this rather than a
viewer-scoped model that happens to contain them.

```jsonc
{
  "generatedAt": "2026-09-17T20:00:00.000Z",
  "basis": "END_OF_DAY",
  "items": [
    {
      "code": "SP500_INDEX",
      "label": "S&P 500",
      "status": "AVAILABLE",
      "value": 7637.05,
      "previousClose": 7551.81,
      "changePercent": 1.1287,
      "sessionDate": "2026-09-17",
      "sparkline": [{ "date": "2026-09-09", "value": 7521.35 }] // 7 sessions, oldest first
    }
  ]
}
```

The rules, all decided in one pure function (`apps/api/src/market/market-overview.ts`) so each is
tested without a database, a provider or a clock:

- **`value`, not `price`.** `^VIX` is a level implied by option prices and nothing holds it. One
  neutral name across three cards is more honest than an equity word stretched over the third.
- **The latest _session_, never "today".** A read on a Sunday reports Friday's close and says so
  with `sessionDate`.
- **`changePercent` compares two adjacent observed sessions.** Not 24 hours of wall clock, which
  would be meaningless over a weekend and wrong over a holiday.
- **Fewer than two observations yields no percentage at all.** Zero would claim the market was flat,
  which one bar cannot support.
- **The sparkline is the last seven observed sessions**, with their real dates. Weekends and
  holidays are absent rather than padded, because a padded weekend draws a flat segment the market
  never had.
- **`basis: END_OF_DAY` is a value, not a convention.** These are closes. Nothing consuming this
  contract may present them as live, and the Dashboard's cards carry the session date for that
  reason. An intraday source would be a second `basis` member and a different loading path, never a
  silent reinterpretation of this one.
- **One unreadable series costs one card.** Each reference is read independently; a failure is
  logged with its code and the original error (`market.overview.reference.failed`) and returned as
  `status: "UNAVAILABLE"` with no numbers. A provider hiccup must not take down a page that is
  mostly about monitors, and a remembered number would be worse than none.

There is **no market cache**. The service holds a `BenchmarkDataService` and can reach the provider
only through it, so a read goes: catalog row → durable coverage subtracted → shared hydration lock →
shared FMP gate → PostgreSQL → the `benchmark:v1:*` Redis projection. A `dashboard:market:*`
namespace, a second price table or a browser cache used as the source of truth would each be a
second implementation of something that already exists.

The read asks for the **recent window it actually draws** (`MARKET_OVERVIEW_LOOKBACK_DAYS`, 30
calendar days to today) and lets the existing loader hydrate whatever is missing or stale. That is
what keeps API startup free of a decades-deep index download: nothing is prefetched at boot, and the
page asks for what a page needs.

## Test isolation: the selectable catalog is exact

The product exposes exactly one backtest benchmark, and the suites assert it exactly —
`GET /benchmarks` is `["SP500"]`, and the New Backtest picker holds that one option — rather than
"contains `SP500` and no `_INDEX` code". A test database that other suites write into makes an
"exactly" assertion fail, and the fix for that is isolation, not a weaker assertion:

- **loader and worker fixtures are never selectable.** The loader resolves by `isActive` alone, so
  a fixture benchmark registered to exercise hydration, versioning or job claiming is created with
  `isBacktestSelectable: false`. `pnpm -r test` runs packages concurrently, and a selectable
  fixture from one package is a real `GET /benchmarks` entry for another package's assertion;
- **a fixture that must be selectable deletes itself in the same test** (the pinned-series
  versioning test submits a run against its own code, so it cleans up in a `finally`);
- **the canonical QA seed prunes what leaked before.** `pnpm test:securities:seed` removes every
  benchmark that is neither in `BENCHMARK_CATALOG` nor referenced by any run
  (`pruneOrphanedFixtureBenchmarks`). The rule is structural — never a list of test codes — so it
  cannot remove product data or history, and it only ever runs against `TEST_DATABASE_URL`.

Integration suites do not prune for themselves: with packages running in parallel, a prune could
remove another suite's live fixture mid-test.

## Prewarming deeper history

These series are stored durably because we will use them for more than a card, and the lazy read
above only ever materializes a month. `pnpm benchmarks:prewarm` is the way to say "fetch this range
now, once, off the request path":

```bash
pnpm benchmarks:prewarm --code SP500_INDEX --from 1990-01-01
pnpm benchmarks:prewarm --code SP500_INDEX --code DJIA_INDEX --code VIX_INDEX --from 2006-01-01
pnpm benchmarks:prewarm --code SP500 --from 2000-01-01 --to 2009-12-31
```

It resolves a code and calls `ensureBenchmarkHydrated`, and that is all it does: coverage
subtraction, the hydration lock, the shared provider gate, retries, persistence and the Redis
projection are the canonical implementations, so a prewarmed range is indistinguishable from one a
page read happened to materialize and rerunning it costs nothing. It reports what coverage says
afterwards rather than assuming success — a series whose own history begins later legitimately
leaves a leading gap.

`--from` is **required and has no default**. Baking in a start date would put a claim about how much
history the provider has into a tool, where it would quietly rot; coverage stays provider-driven.
(Measured on 2026-09-17: one `historical-price-eod/full` page returns 5000 rows, so `^GSPC` reaches
back to 2006-10-31 in a single request and the adapter's pagination walks further on request.)

## What the engine sees

```ts
{
  (benchmarkId, code, name, dates, closes);
}
```

The backtest engine does not know, and must never branch on, the fact that V1's `SP500` is currently
`SPY`.
