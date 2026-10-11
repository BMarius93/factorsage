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
benchmark:v1:benchmark:<seriesId>:head                               JSON head: the publication
benchmark:v1:benchmark:<seriesId>:chunks                             registry of the series' chunks
benchmark:v1:benchmark:<seriesId>:daily-price:v1:<year>:<digest16>  immutable columnar year chunk
benchmark:v1:benchmark:<seriesId>:generation                         generation fence
```

Keyed by the immutable series, so a new version projects into its own keys and can never read a
previous version's cached bars — and so can a *different* benchmark: `SP500`, `SP500_INDEX`,
`DJIA_INDEX`, `VIX_INDEX` and every `ETF_*` series are separate series ids, sets of keys, coverage
ledgers and watermarks. Hydrating an index cannot touch the SPY benchmark's bars or mark its
coverage, which is what `packages/stock-data/src/benchmark-market-references.integration.test.ts`
proves.

Distinct from `stock-data:v2:security:<id>:…` on purpose: the stock LRU can never evict a benchmark,
a benchmark can never occupy a stock residency slot, and a Redis flush costs one durable re-read.

**Every series is fully resident** (`docs/decisions/etf-market-data-v1.md` §3–§4):

- a chunk's key names its content (the year's PostgreSQL digest), so a key is never rewritten;
- the head names every year's digest and **always describes all durable coverage** — it is built
  from PostgreSQL's whole history, never from the range a caller asked for, so a narrow read cannot
  narrow residency;
- a publication stages missing chunks with a short expiry, then commits the head by
  compare-and-set, makes the named chunks permanent and deletes every registered chunk the head no
  longer names; unchanged years are reused;
- a reader `GET`s the head and `MGET`s only the years it needs, re-reading the head when a chunk is
  gone (the head moved), so it sees exactly one publication; the head answers any range, reporting
  what its coverage does not hold as missing, so a resident read never touches PostgreSQL;
- a head commits only on the series' generation fence, which is written only under PostgreSQL's
  series write lock — raised by a re-base replacement just before it commits, re-established by a
  publisher from what PostgreSQL committed — so a stale publisher can never make an older price
  generation visible after a newer one committed;
- nothing committed has a TTL. Redis's own `maxmemory-policy` must not be an unaccepted `allkeys-*`
  policy, which readiness refuses (`REDIS_ACCEPTED_EVICTION_POLICY` is the explicit override).

The first commit of a series deletes the previous `:manifest` + `:daily-price:<year>` layout.
`pnpm db:benchmarks:reset` discards a reset series' projection with its rows; it never flushes.

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

The three index rows are internal **market references**. They were what the Dashboard reported the
market did until the ETF market overview replaced those cards; they remain catalogued and stored.
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

`GET /market-overview` is the read behind the Dashboard's ETF market overview
(`docs/decisions/etf-market-overview-v1.md`): the twenty funds of `MARKET_OVERVIEW_ETF_GROUPS` in
their three groups, each with six trailing price returns (1W, 1M, 3M, 6M, YTD, 1Y) and a 53-point
one-year trend line rebased to 100. It is deliberately not part of `GET /dashboard`: the Dashboard
read model is entirely about which monitors *this viewer* can see, and a fund closed where it
closed. The endpoint carries no session at all — no guard, no cookie, no viewer argument on the
service — so a Guest and a signed-in customer are served identical bodies.

The rules, decided in one pure module (`apps/api/src/market/market-overview.ts`) and tested without
a database, a cache or a clock:

- **No price crosses the contract.** A fund's share price is not an index level; the contract
  carries returns and a rebased line, and the ticker as a display field. The benchmark code, series
  id and provider symbol never cross it.
- **Calendar anchors, real sessions.** Each period is measured from the fund's latest completed
  session to its most recent stored session on or before the period's anchor date — 7 days, 1/3/6
  months clamped to month end, the previous year's last day, one year with 29 February clamped —
  never a later session. A history that does not reach the anchor, or a coverage gap at it, yields
  `null`, never zero.
- **Completed sessions only.** A bar counts after its 16:00 New York close plus the refresh's
  publication delay, and only if the series' recent tail was read after that instant
  (`lastTailSyncAt`). Nothing intraday is reported as a close.
- **One reference session.** `asOf` is the newest completed session any fund reached; a fund behind
  it is `STALE` with its own `sessionDate`. The exchange calendar is not consulted: it is fetched
  from the provider.
- **`basis: END_OF_DAY` and `returnBasis: PRICE_RETURN` are values, not conventions.** Split-adjusted
  closes, distributions excluded; the Dashboard's footnote says so.
- **One unreadable series costs one row** (`status: UNAVAILABLE`, logged as
  `market.overview.instrument.failed` with the original error), or keeps that fund's last
  successful answer while *the read it came from* is younger than 15 minutes — never refreshed by
  being carried into a newer summary, so a series that keeps failing becomes unavailable.

**It never asks the provider.** `MarketService` holds `MarketOverviewDataPort` — `listBenchmarks`,
`readBenchmarkHistory` (the `BenchmarkHistoryReader`) and `benchmarkRefreshState` — and no hydration
method, so a read goes: catalog rows → the resident `benchmark:v1:*` head and year chunks (one `GET`,
one `MGET`), rebuilt from PostgreSQL once if Redis lost them, PostgreSQL if Redis cannot answer.
A series never bootstrapped is reported unavailable. Each read is bounded to one year and 45 days.

**It is computed once and served to everyone**: an in-process `SnapshotCache` with single flight, a
60-second TTL, stale-while-revalidate up to 15 minutes and nothing older ever served — including a
kept answer inside a newer summary, which ends that summary's servability when its read turns 15
minutes old. A warm computation is 61 small PostgreSQL reads and twenty Redis reads. Process memory
rather than Redis, because the summary is a projection of the Redis projection and carries nothing
user-owned. `Cache-Control: private, max-age=60`, because the response also carries the caller's
rate-limit headers. The policy is `standard-read`.

The market-reference index series below (`SP500_INDEX`, `DJIA_INDEX`, `VIX_INDEX`) are no longer read
by this endpoint. They stay catalogued, stored and seeded until a later change removes them.

## The market-overview ETFs

Twenty ETFs in three groups — Benchmarks, Sector Performance, Macro & Alternatives — are listed once
in `MARKET_OVERVIEW_ETF_GROUPS` (`packages/domain/src/market-overview-etfs.ts`). `SPY` **is**
`SP500`; the other nineteen are `ETF_<TICKER>` catalog rows, `ETF_PROXY`, active and **never
backtest-selectable**, so `GET /benchmarks` is unchanged. `GET /market-overview` (above) reports them
in that order. The storage decision, with its measurements and pre-deployment checklist, is
`docs/decisions/etf-market-data-v1.md`; the overview's is `docs/decisions/etf-market-overview-v1.md`.

- **Re-base protection.** Every `ETF_PROXY` series — `SP500` included — gets the stock detector of
  `historical-price-basis-v1.md`: a read that would add or change a stored bar first re-reads the
  earliest stored bars, a changed earliest bar re-reads and compares the whole history, and a
  measured re-base replaces it in one transaction under a new `BenchmarkSeriesPriceBasis`
  generation, with the Redis projection discarded first. Split-sized moves at the newest edge are
  held. `INDEX` series are unaffected.
- **Refresh.** The worker's `market-data` child (`ai/architecture/api-worker.md`) keeps the twenty
  current after each NYSE close: one bounded tail read per series, never the history, persisted
  before it is published. It never bootstraps.
- **Reading.** `BenchmarkHistoryReader` is the provider-free read boundary for workers: a range, the
  full history, one session, a rolling window, several series, each bounded by an explicit end date.
  With the projection resident a read is one `GET` and one `MGET`. Without it, a read tries to
  rebuild it under the hydration lock but waits at most one second for that lock before it answers
  from PostgreSQL, so a lock nobody can grant never holds a request.

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

These series are stored durably because we use them for more than a card, and no Dashboard read
ever fetches anything (the market overview reads only what is stored). `pnpm benchmarks:prewarm` is
the way to say "fetch this range now, once, off the request path":

```bash
pnpm benchmarks:prewarm --code SP500_INDEX --from 1990-01-01
pnpm benchmarks:prewarm --code SP500_INDEX --code DJIA_INDEX --code VIX_INDEX --from 2006-01-01
pnpm benchmarks:prewarm --code SP500 --from 2000-01-01 --to 2009-12-31
```

It resolves a code and calls `ensureBenchmarkHydrated`, and that is all it does: coverage
subtraction, the hydration lock, the shared provider gate, retries, persistence and the Redis
projection are the canonical implementations, so a prewarmed range is indistinguishable from one a
backtest's hydration happened to materialize and rerunning it costs nothing. It reports what coverage says
afterwards rather than assuming success — a series whose own history begins later legitimately
leaves a leading gap.

`--from` is **required and has no default**. Baking in a start date would put a claim about how much
history the provider has into a tool, where it would quietly rot; coverage stays provider-driven.
(Measured on 2026-09-17: one `historical-price-eod/full` page returns 5000 rows, so `^GSPC` reaches
back to 2006-10-31 in a single request and the adapter's pagination walks further on request.)

**The market-overview bootstrap** is the one named group:

```bash
pnpm benchmarks:prewarm --group market-overview --report artifacts/market-overview-bootstrap.json
```

It reconciles the catalog, then loads the twenty ETFs one at a time, `SP500` first, from
`MARKET_OVERVIEW_HISTORY_FLOOR` (1993-01-01, before every fund listed, so the provider still decides
where each history begins) through today, proves each Redis projection against PostgreSQL, and
prints a line per ETF: span, bars, pre-inception period, missing coverage, sessions missing against
`SP500`, a late start, and the provider HTTP requests actually sent. It exits non-zero when a series
failed, and a rerun asks only for what is still missing. The validation procedure is §6 of
`docs/decisions/etf-market-data-v1.md`; `pnpm market-data:refresh-once` then exercises the
incremental path.

## What the engine sees

```ts
{
  (benchmarkId, code, name, dates, closes);
}
```

The backtest engine does not know, and must never branch on, the fact that V1's `SP500` is currently
`SPY`.
