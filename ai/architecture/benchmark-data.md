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
Benchmark                         product identity: code, name, description, selectability
 └─ BenchmarkSeries               IMMUTABLE definition: source kind, provider symbol, currency,
     ├─ BenchmarkDailyPrice       methodology version — appended, never edited
     ├─ BenchmarkDatasetState     tail/coverage watermarks
     └─ BenchmarkDatasetCoverage  exact successful coverage intervals
```

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
trades on days the market did not.

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
previous version's cached bars.

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
SP500 / "S&P 500" / FMP_SYMBOL / SPY / USD / methodologyVersion 1
```

The API reconciles it into PostgreSQL idempotently at startup, so a normal local, development, CI or
test database has the catalog after `migrate` with no manual SQL. No frontend array and no second
backend list repeats `SP500` or `SPY`; the browser selects a code, and `providerSymbol` never crosses
the HTTP boundary.

**V1 ships exactly one benchmark, and it is the default.** The model is built for more: broad-market,
sector, industry and global-equity benchmarks are new rows, and a direct index feed or a composite is
a new `BenchmarkSourceKind` member plus a loader for it — not a reinterpretation of existing rows.

`methodologyVersion` describes what the _series means_. `SP500` is currently backed by the `SPY` ETF,
which tracks the index including its own expense ratio and distribution behaviour. Replacing that
with a direct index feed would change the numbers, so it raises the version — and because every run
snapshots the benchmark id, code, name, source kind, provider symbol and methodology version it
executed under, an already-completed run stays interpretable.

## What the engine sees

```ts
{
  (benchmarkId, code, name, dates, closes);
}
```

The backtest engine does not know, and must never branch on, the fact that V1's `SP500` is currently
`SPY`.
