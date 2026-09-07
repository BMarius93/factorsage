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
Benchmark                     product identity: code, name, source kind, provider symbol,
 ├─ BenchmarkDailyPrice        methodology version
 ├─ BenchmarkDatasetState      tail/coverage watermarks
 └─ BenchmarkDatasetCoverage   exact successful coverage intervals
```

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
benchmark:v1:benchmark:<benchmarkId>:daily-price:<year>
benchmark:v1:benchmark:<benchmarkId>:manifest
```

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
