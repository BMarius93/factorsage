# Retain Wide-Column Calculated-Series Storage

## Status

**Accepted.**

Supersedes nothing. It records the storage decision that the unified daily derived state in
`stock-data-foundation.md` left implicit, and it constrains how every future calculated series is
added. All point-in-time, completed-week, materialization and provenance rules in
`stock-data-foundation.md`, `intrinsic-value-engine.md` and `selectable-series-catalog.md` remain
authoritative and unchanged.

`ai/architecture/calculated-series.md` describes how the accepted model is implemented.
`docs/development/adding-a-calculated-series.md` is the checklist for adding one.

## Decision

FactorSage stores each calculated daily series as its **own explicit nullable PostgreSQL column**
on `DailyDerivedState`.

1. **Explicit columns.** Every scalar series is one nullable `DECIMAL(20,8)` column
   (`packages/database/prisma/schema.prisma`, model `DailyDerivedState`). `NULL` means the value is
   not eligible on that trading day; it is never zero and is never back-filled before the value's
   first eligible day.
2. **One logical row per `(securityId, date)`** remains an invariant. The composite primary key is
   the identity. No calculation-version column ever participates in it, no derived family gets its
   own daily table, and no per-series cache key is introduced.
3. **PostgreSQL remains the persistent source of truth.** Derived values are reproducible from
   canonical `DailyPrice` and point-in-time `FinancialStatement` revisions under the current
   methodology, but PostgreSQL is what is read back and what survives.
4. **Redis remains a disposable acceleration layer.** A flush costs latency, never data. It caches
   the same daily rows as yearly chunks and participates in complete-stock LRU residency. Since
   2026-09-30 each chunk is column-oriented (daily-state encoding 2); see
   [Redis chunk layout](#redis-chunk-layout-column-oriented-chunks-daily-state-encoding-2).
5. **Stable catalog ID, product label and storage field name are three separate concepts.** The
   catalog ID (`SMA_20D`) is the durable machine identity that selection state, API filters and
   future Strategy persistence use. The label (`SMA 20D`) is product presentation and is never an
   identity. The storage field (`sma20d`) is the persistence name. They are related by convention
   and pinned by tests, not by string parsing at runtime.
6. **New scalar series are added with additive Prisma migrations** — a nullable column, existing
   rows left `NULL`, no SQL back-fill. The canonical rebuild is the only calculation path.
7. **JSONB is deferred**, not the current target. It is a documented future option with explicit
   triggers below, not a direction this codebase is moving toward by default.
8. **PostgreSQL EAV (`(security, date, series_id, value)`) is rejected** for this workload.

## Scope of validity

This model is accepted for the **expected range of approximately 40–100 explicitly defined,
product-owned series**. Below roughly 40 the cost is trivially acceptable; toward 100 the
constraints below begin to bind and the triggers should be re-examined rather than ignored.

The model assumes series are **explicitly defined by the product and known at build time**. It does
not accommodate user-defined or runtime-defined series at all — that is a trigger, not a
limitation to work around.

## Evidence

Measured on the development PostgreSQL and Redis instances (7 hydrated securities, 30,792
`DailyDerivedState` rows, 21 series):

| Measurement | Value |
| --- | --- |
| `DailyDerivedState` heap size / rows | 7,120 kB / 30,792 = **236.8 B per row** |
| `avg(pg_column_size(row))` | **212.6 B** |
| `DailyDerivedState` total relation (incl. primary key) | **10 MB** |
| `DailyPrice` per-row size, for comparison | 110.7 B |
| Redis `daily-state:<year>` chunk (one security, one year) | **169,617 B** (~652 B per trading day) |
| Redis footprint, whole cache | **32.78 MB** for 7 resident stocks (2,489 keys) |
| One fully warmed 21-series row, serialized | **772 B**, of which **434 B (56%)** are JSON field names and syntax |
| Full 20-year derived rebuild (technicals + weekly + carry-forward) | **~240 ms** of CPU per security |

Estimated by projection from those measurements (script, not measured against a live system):

| Projection | 21 series | 50 series | 100 series |
| --- | --- | --- | --- |
| Redis year chunk per security | 190 KB | 383 KB | 715 KB |
| Redis 30-year footprint per security | 5.6 MB | 11.2 MB | 21 MB |
| Redis resident set at `maxResidentStocks = 100` | ~0.56 GB | ~1.1 GB | ~2.1 GB |
| EAV rows, 1,000 securities × 30 years | 159 M | 378 M | 756 M |

Judgment, stated as judgment: the binding constraint at the top of the accepted range is **not**
PostgreSQL — a 100-series wide row remains comfortably inside the 1 KB budget below — but the
**row-oriented Redis chunk**, whose 56 % field-name overhead is paid per row per year. If the range
is pushed toward 100 series, changing the Redis chunk layout is the cheaper intervention, and it is
independent of this decision because Redis is disposable.

## Budgets

These are the thresholds this decision is accepted against. Exceeding one is a trigger to
re-open it, not something to absorb silently.

| Budget                                               | Threshold                  | Measured at acceptance | Measured at r7, worst case | Column-oriented chunks (encoding 2), worst case                     |
| ---------------------------------------------------- | -------------------------- | ---------------------- | -------------------------- | ------------------------------------------------------------------- |
| Average `DailyDerivedState` heap row size            | ≤ 1 KB                     | 236.8 B                | 457 B (`pg_column_size`)   | unchanged                                                           |
| Redis footprint per security, 30-year history        | ≤ 12 MB                    | ~4.7 MB                | **13.2 MB: exceeded**      | 4.64 MiB for the full retention; 8.87 MiB at the ceiling: **holds** |
| Redis resident set at configured `maxResidentStocks` | ≤ 2 GB                     | 32.78 MB (7 stocks)    | ≤ 1.49 GB at 100           | 0.49 GB at 100; 0.93 GB at the ceiling                              |
| Series-adding migrations                             | ≤ ~1 per sprint, sustained | well below             | well below                 | unchanged                                                           |

### Measured after Fundamental Metrics V1 (r7)

Migration `20260929090000_add_fundamental_metrics_derived_state` took the row to 42 value columns.
Measured on the final implementation (Fundamental Metrics persistence branch, 2026-09-29) through
the real rebuild, PostgreSQL and Redis, on a synthetic worst case: one security with every series,
all fifteen fundamentals included, non-null on every day.

| Measurement | Without the fifteen fields | With them |
| --- | --- | --- |
| `avg(pg_column_size(row))` | 342 B | 457 B |
| Redis `daily-state:2025` chunk (261 rows) | 244 KB | 343 KB |
| Redis `daily-state` payload, thirty years (7,826 rows) | 7.16 MB | 10.16 MB |
| All registered keys, thirty years: payload / `MEMORY USAGE` | ~8.5 MB / — | 11.5 MB / 13.2 MB |
| Redis `daily-state` payload, full retention (8,871 rows) | 8.13 MB | 11.53 MB |
| All registered keys, full retention: payload / `MEMORY USAGE` | — | 13.0 MB / 14.9 MB |

A resident security carries its whole retained history, not just the thirty-year product horizon:
`priceRetentionYears(30)` keeps 34 years of bars plus the current one, and the derived state
covers every one of them. Real securities agree with the synthetic case. The 19 securities
resident in the development Redis at r6, before the fifteen fields existed, occupy 0.6–11.0 MB each
(mean 6.1 MB, 115 MB in total). The eight with a full 35-chunk history use 10.2–11.0 MB, and the
fifteen fields add roughly 3.4 MB to a fully populated retention, which puts them near 14 MB.

Against the budgets:

- **Row size: holds.** 457 B per row stays far inside 1 KB.
- **Per security: exceeded.** The worst case uses 13.2 MB of Redis memory for thirty years (11.5 MB
  of payload) and 14.9 MB for the full retention a resident security holds (13.0 MB of payload),
  against a 12 MB threshold.
- **Resident set: holds.** `STOCK_CACHE_MAX_RESIDENT_STOCKS` is not set by any environment file
  and defaults to 100 (`getStockDataConfig`). Even if every resident security were the worst case,
  the upper bound is 100 × 14.9 MB ≈ 1.49 GB, 75 % of the 2 GB budget. The budget holds up to about
  134 worst-case residents.

The per-security threshold is recorded as exceeded, and that is now an explicit trigger for the
Redis serialization and layout, not for this storage decision. The row-oriented chunk spends most of
its bytes repeating JSON field names (56 % in the measurement above), so a column-oriented chunk is
the intervention. It is independent of the PostgreSQL model because Redis is disposable. It is due
before either of the following:

- another series family is added (the valuation ratios are next);
- `STOCK_CACHE_MAX_RESIDENT_STOCKS` is raised above about 130. The pre-release audit's O-2 asks
  for it to cover the monitored universe; at 500 residents the worst case is about 7.5 GB.

**Resolved on 2026-09-30** by the column-oriented chunk below, before the valuation ratios. The
worst case is now 4.64 MiB per security (8.87 MiB at the ceiling), so the per-security budget holds
again and 2 GB covers about 411 worst-case residents (215 at the ceiling).

## Redis chunk layout: column-oriented chunks (daily-state encoding 2)

This changes how each yearly `daily-state` chunk is spelled, and nothing else. PostgreSQL, the row
identity, `DERIVED_STATE_REVISION` (still 7) and every value any consumer reads are unchanged, and no
migration was needed. Redis stays disposable: a lost chunk still costs a rebuild from PostgreSQL and
never data.

### Decision

- **One chunk per security and calendar year, as before**, now under a versioned key:
  `stock-data:v2:security:<id>:daily-state:v2:<year>`. The key count, the key registry,
  complete-stock LRU eviction and the one `MGET` per read are unchanged.
- **Column-oriented, run-length-encoded JSON.** A chunk holds its header (`version`, `securityId`,
  `year`), the field dictionary, one ascending date axis and one column per field:

  ```text
  {"version":2,"securityId":"…","year":2024,
   "fields":["sma20d",…,"intrinsicValues.DCF_FCFF",…,"intrinsicCurrency"],
   "dates":["2024-01-02","2024-01-03",…],
   "columns":[[187.5,188.25,…],…,[["USD",252]]]}
  ```

  A cell is the value on one session, `[value, count]` for `count ≥ 2` consecutive sessions holding
  that value, or `[count]` for sessions with no value.

- **One canonical codec**, `packages/stock-data/src/daily-state-chunk.ts`
  (`encodeDailyStateChunk`, `decodeDailyStateChunk`), called only by the cache. Stock Details,
  Backtest, Monitor and Strategy keep reading `DailyDerivedState[]` through the same service
  methods and never see the layout. Tests and audit tooling that inspect a chunk use the same codec
  and `dailyStateChunkKey`.
- **Columns come from the registries** — the moving averages, oscillators, Relative Volume periods,
  Fundamental Metrics, intrinsic models, blends and model provenance fields — plus
  `weeklySourceWeekStart` and `intrinsicCurrency`, in the key order `dailyDerivedStateFromRow`
  writes. A decoded row therefore serializes byte for byte like the row PostgreSQL produced. The
  codec test's fixture is typed `Required<DailyDerivedState>`: a new field fails to compile until
  the fixture carries it, and then fails the round trip until the chunk has a column for it.

### Why these choices

- **Absence is a count, never a `null` and never a zero**, so no decoder can turn a missing value
  into `0` — the `Number(null)` trap. Absent, zero, negative and positive stay distinct on every
  field family.
- **Runs compress only what the rows already repeat.** Fundamental Metrics, intrinsic values, their
  provenance and the currency are carried forward between statement events, and the weekly averages
  between weeks. On the 33 matrix securities the statement-derived columns change 5 to 8 times a
  year and the weekly ones 53 times, while the 13 daily columns change on every session. Each session
  keeps its own value, and a gap is a run of exactly its own length. Decoding restores each
  session's stored value and carries nothing forward, so no value can cross an invalidation gap.
- **Deterministic bytes.** Rows are ordered by date, every field is read by name through the column
  list, and runs are maximal. The same rows produce the same bytes whatever order their properties
  were created in, which republish comparisons and the audit rely on.
- **Decoded rows are fast objects.** Each row is cloned from a per-shape template that already has
  the row's keys, and its values are then written. A row built field by field through computed keys
  degrades to a V8 dictionary-mode object, measured at about three times the heap of the same row
  from `JSON.parse`.

### Versioning, invalidation and failure

- `DAILY_STATE_ENCODING_VERSION = 2` appears in the key, in the payload and in the stock manifest
  (`dailyStateEncodingVersion`). The retired row array is version 1, which never carried a marker.
  It is a cache version only: it is not `DERIVED_STATE_REVISION` and is not part of
  `BACKTEST_DATA_REVISIONS`, and a test pins both.
- **Deploy transition.** A manifest written before this change has no encoding. It is not current,
  so the security is rebuilt from PostgreSQL before anything is read. `BEGIN_HYDRATION` deletes the
  version-1 chunks through the key registry, so nothing is orphaned. Such a manifest keeps its
  resident range (`isCurrentExceptEncoding`, used only by `maintainedTarget`), so the whole range is
  republished rather than narrowed to the first read's window. The provider is asked only for a tail
  PostgreSQL has not covered yet, exactly as any hydration of that range would ask. Measured on the
  matrix copy's WMT (35 chunks):
  1. `main`'s code published the version-1 layout into a namespace.
  2. This change's code read that same namespace. It republished once — one `begin-hydration` and 300
     chunk writes, with 0 provider calls — and served rows identical to `main`'s and to PostgreSQL.
  3. The namespace was left with 0 version-1 chunks and 35 version-2 chunks, still 300 keys in all.
- **Mixed versions: deploy stop-then-start.** Each process kind runs as a single instance today (the
  compose `app` profile). Stop every API and worker running the old code before a new one serves.
  If an old and a new process do share one Redis, they rebuild each other's projection on
  alternating reads: the old code ignores the new manifest field and misses the renamed chunks, and
  the new code refuses the old manifest.
  - No wrong data is served, because the two encodings never share a key and each side validates
    what it reads.
  - Each flip republishes the security from PostgreSQL, and makes an existing race frequent: a reader
    invalidating another process's in-flight hydration. Operations in flight can then fail with
    `Stock cache hydration generation changed`, and a backtest caught that way fails
    `EXECUTION_FAILED` and has to be re-run.
  - Rolling back is safe: the old code misses the version-2 chunks and rebuilds.

  Dual writes were deliberately not built.

- **Damage.** A chunk that does not decode is a miss, exactly like a missing chunk, and the read never
  returns a partial history. That covers:
  - invalid JSON, a version-1 array, or another version;
  - another security or year;
  - a different field dictionary;
  - a date axis that is not strictly ascending inside its year;
  - a column that does not cover every date exactly once;
  - a cell of the wrong kind, including `null` and an overflowed `Infinity`.

  The manifest is invalidated and the security is republished from PostgreSQL, and a read that still
  cannot decode falls back to PostgreSQL. The event is logged as `stock-data.cache.chunk-unreadable`
  (warn) through the cache's `onUnreadableChunk` observer.

- **Publication** is unchanged: one `SET` per year inside the existing `set-registered` script, under
  a HYDRATING generation nobody reads. A publication that fails part-way leaves no READY manifest,
  and the next read completes it.

### Measured

`pnpm bench:daily-state-cache` (`apps/api/src/cache-benchmark/`) hydrates the frozen QA-matrix copy
through the production service into a throwaway namespace, with the provider refused. The copy holds
33 securities, their full retained history, data as of 2026-09-28. The benchmark measures both
encodings on the same rows. The "before" figures were also measured with `main`'s own code at
`81f53560`, and they agree. MiB is 2²⁰ bytes and GB is 10⁹ bytes. Timings come from one development
machine (Apple M1, Node 22.23.2, Redis 7.4.11 on jemalloc 5.3.0), so read them as ratios. The reports
are in `artifacts/daily-state-cache-benchmark/`.

| Measurement                                                                                                                                                                           | Row-oriented (v1)                                 | Column-oriented (v2) | Change    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------- | --------- |
| `daily-state` payload, all 33 securities                                                                                                                                              | 324.7 MB                                          | 47.9 MB              | −85.2 %   |
| `daily-state` `MEMORY USAGE`, all 33 securities                                                                                                                                       | 365.4 MB                                          | 50.8 MB              | −86.1 %   |
| All registered keys of one real security: median                                                                                                                                      | 13.80 MiB                                         | 3.96 MiB             | −71.3 %   |
| All registered keys of one real security: mean                                                                                                                                        | 12.73 MiB                                         | 3.64 MiB             | −71.4 %   |
| All registered keys of one real security: largest                                                                                                                                     | 14.76 MiB (WMT)                                   | 4.08 MiB (AAPL)      | −72.4 %   |
| Synthetic worst-case `daily-state`: every field on every weekday of full retention (8,871 rows), each family at its real cadence pushed to the worst (statements twelve times a year) | 12.79 MiB                                         | 2.13 MiB             | −83.3 %   |
| Synthetic ceiling `daily-state`: every field changing on every session (no run longer than one)                                                                                       | 12.79 MiB                                         | 6.36 MiB             | −50.2 %   |
| Keys per full-retention security                                                                                                                                                      | 301                                               | 301                  | unchanged |
| Commands of a warm Stock Details read / of 31 backtest windows                                                                                                                        | 6 GET, 1 MGET, 1 EVAL / 124 GET, 62 MGET, 62 EVAL | the same             | unchanged |

The ceiling cannot occur, because the carried-forward families only change on a week or a
statement event, but it bounds the encoding itself.

**Capacity**, against the 2 GB budget above. Worst case per security is the synthetic `daily-state`
plus the largest real price, statement, registry, manifest and identity keys (2.51 MiB together):

|                                            | v1        | v2, realistic worst case | v2, ceiling |
| ------------------------------------------ | --------- | ------------------------ | ----------- |
| Worst case per security                    | 15.29 MiB | 4.64 MiB                 | 8.87 MiB    |
| 100 residents (the default)                | 1.60 GB   | 0.49 GB                  | 0.93 GB     |
| Residents within 2 GB                      | 124       | 411                      | 215         |
| 100 residents at the largest real security | 1.55 GB   | 0.43 GB                  | —           |

The prices (1.3–1.5 MiB) are now a resident security's largest family, ahead of its derived state
(about 1.6 MiB for a full history) and its statements (about 1 MiB).

**CPU and memory**, WMT's full retention (35 chunks, 8,558 rows), median of repeated runs:

| Measurement                                                               | v1             | v2             |
| ------------------------------------------------------------------------- | -------------- | -------------- |
| Encode one year                                                           | 1.12 ms        | 0.74 ms        |
| Decode one year (v1 parse, filter and sort; v2 decode of the window)      | 0.82 ms        | 0.72 ms        |
| Encode full retention                                                     | 41.0 ms        | 28.1 ms        |
| Decode full retention, CPU only                                           | 39.1 ms        | 34.2 ms        |
| Warm full-retention read through Redis (`MGET` and decode)                | 160.4 ms       | 44.3 ms        |
| Heap retained by a full-retention read                                    | 12.1 MB        | 7.2 MB         |
| Garbage collection over 30 full-retention reads: rows kept / rows dropped | 236 / 37 ms    | 117 / 146 ms   |
| Synthetic ceiling, decode / encode full retention                         | 39.2 / 43.4 ms | 47.5 / 56.8 ms |

The payload a read transfers is 7× smaller (11.1 MB → 1.6 MB for WMT), which is where the warm read
gains. A caller that uses its rows pays half the garbage collection. Rows dropped the moment they
are decoded cost more, because a bare `JSON.parse`'s output dies young, while decoding also builds
each column and clones a template per row. Only the impossible ceiling is slower: about a fifth
slower to decode and a third to encode. Runs of the benchmark vary by 10–20 % on this machine.

**Product paths**, warm:

- Stock Details, one Fundamental over thirty years (AAPL, ROIC TTM, service level): 105 ms → 43 ms,
  with the same response (286,019 bytes) and the same commands.
- A backtest's 31 calendar-year frame windows (AAPL, with 0, 1, 5 or 15 Fundamentals, or a mixed
  set): 252–472 ms → 121–134 ms.
- The real `BacktestProcessor` re-executing 17 stored matrix snapshots (technical, intrinsic Margin
  of Safety, Fundamental, and Fundamental mixed with RVOL and technicals, one to thirty years): 74.7 s
  → 49.3 s in total, of which frame loading went from 20.0 s to 7.2 s.

**Parity.** Every published chunk of all 33 securities decodes to exactly the PostgreSQL rows, byte
for byte (259,410 rows). The same harness was run against `main`'s build and this change's build,
and the two agree on all 1,782 comparisons:

- 1,023 backtest frame windows, each 50 operands compared as raw Float64 bits;
- 660 Stock Details projections;
- 99 Monitor frames.

The 17 re-executed backtests are identical in trades, daily equity, positions and summary. The
independent Fundamental audit reproduces its counts exactly: 4,887,105 comparisons, then 3,511,275
for frame provenance, then 7,784,455 at full scale — all with 0 failures. No provider was reached
in any of it.

### Alternatives considered

Measured on the same 33 securities during design. The timings come from a separate prototype run on
the same machine.

| Layout                                        | Payload vs v1 | WMT `daily-state` memory | WMT full decode | Why not                                                                                            |
| --------------------------------------------- | ------------- | ------------------------ | --------------- | -------------------------------------------------------------------------------------------------- |
| Row-oriented JSON (v1)                        | —             | 12.98 MB                 | 26.6 ms         | the retired layout                                                                                 |
| Dense columns, `null` for absence             | −54 %         | 5.46 MB                  | 35.3 ms         | three times the run-length size for the carried-forward families, and `null` invites the zero trap |
| Sparse `[index, value]` pairs                 | −42 %         | 6.59 MB                  | 37.8 ms         | larger than dense: most columns are mostly present                                                 |
| **Run-length columns (chosen)**               | −85 %         | 1.67 MB                  | 24.0 ms         |                                                                                                    |
| Run-length columns without the dictionary     | −85.5 %       | 1.66 MB                  | 24.0 ms         | the dictionary costs 1.7 % and makes a chunk self-describing and drift-checked                     |
| Run-length columns, deflated, base64          | −91.7 %       | 0.96 MB                  | 28.8 ms         | 0.7 MB more per security, for opaque bytes, twice the encode cost and a second failure mode        |
| Run-length columns, brotli, base64            | −92 %         | 0.91 MB                  | 30.5 ms         | the same, slower                                                                                   |
| Row-oriented JSON, deflated, base64           | −89 %         | 1.34 MB                  | 36.3 ms         | hides the repetition rather than removing it                                                       |
| Float64 values with a validity bitmap, base64 | −62 %         | 4.46 MB                  | 23.4 ms         | eight bytes a value and no runs; opaque                                                            |

Several keys per year were not considered. They would multiply the key registry, the per-key
allocator overhead and the commands of every read.

Deferred, measured opportunities:

- Dates as day offsets would save about 5 % more. The axis stays ISO dates because it is what every
  column aligns to, and a chunk should be readable in `redis-cli`.
- Projecting frames straight from columns, without materializing rows, would spare the row
  allocation for a selective consumer such as Stock Details' single metric. The decode already
  materializes only the requested window and is at CPU parity with the old parse, so this stays a
  future optimization.
- The price and statement chunks are still row-oriented JSON.

**Headroom for the valuation ratios.** Four more daily-changing numeric columns were appended to real
and synthetic chunks, with a value on every session. That is the size of P/E, P/S, P/FCF and
EV/EBITDA, and it is a benchmark-only simulation: no product field exists.

- On real securities it adds 0.47 MB per security on average (0.59 MB row-oriented).
- The realistic worst case becomes 5.16 MiB per security: 0.54 GB at 100 residents, and about 369
  residents within 2 GB.
- The ceiling becomes 8.90 MiB: 0.93 GB at 100.

## Triggers for reconsidering JSONB

Re-open this decision when **any** of the following becomes true:

1. **Hundreds of series.** The catalog credibly heads beyond ~100 explicitly defined series.
2. **User-defined or runtime-defined series.** Any requirement for a series whose existence,
   parameters or formula is chosen at runtime rather than committed to the repository. The
   wide-column model cannot express this at all: a column cannot be created per user.
3. **Unacceptable migration frequency.** Adding series requires migrations more often than roughly
   once per sprint on a sustained basis, or migrations start being batched purely to avoid the
   per-series cost.
4. **Measured budget breach.** Any budget in the table above is exceeded by measurement, not by
   estimate.

Until then, JSONB stays out of the schema and out of the architecture documents except under an
explicit Deferred/Future heading.

## Why EAV is rejected

- **Row explosion.** 159 M rows today's series count, 756 M at 100 series, for 1,000 securities
  over 30 years — before indexes, and for a workload whose only access pattern is a contiguous
  range scan the existing composite primary key already serves.
- **It is a regression, not a novelty.** Migration `20260830210000_unify_daily_derived_state`
  deliberately replaced per-family derived tables and calculation versions with the single unified
  row. Long-form rows would reintroduce the shape that decision removed.
- **Read cost.** Every consumer would pivot sparse rows back into a daily state, which is exactly
  the sparse-event reconstruction `stock-data-foundation.md` forbids backtests from doing.

The API's intrinsic-value endpoints already return long-form points
(`IntrinsicValueResponse` in `packages/contracts/src/stock-data.ts`). That is a wire projection and
is unaffected by this decision; it is not storage.

## Consequences and accepted tradeoffs

Accepted costs:

- **Adding a series touches ~12 files**, including three hand-written mappings in
  `packages/stock-data/src/prisma-store.ts` (`DailyDerivedStateRow`, `dailyDerivedStateFromRow`,
  `dailyDerivedStateToRow`). This is the price of the model and is documented rather than hidden.
- **A partially wired series fails silently.** Absence is how unavailability is represented, so a
  missing column or a missing mapper reads back exactly like a warm-up gap. This is mitigated by
  registry-driven completeness tests, not by discipline: `derived-state.integration.test.ts`
  asserts every registered field has a real column via `information_schema`, and the round-trip and
  Redis parity suites iterate the registries.
- **Schema evolution is a migration**, so series cannot be added by configuration.

Accepted benefits:

- The schema is self-describing and debuggable directly in `psql`.
- Type safety is real: `DailyMovingAverageField`/`WeeklyMovingAverageField` make an unregistered
  field a compile error.
- No pivot, no JSON extraction and no query planning surprises on the only hot access path,
  `securityId + date range ascending`.
- Numeric behaviour is unchanged and explicit.

### Accepted limitation: the global derived-state revision

`DERIVED_STATE_REVISION` (`packages/stock-data/src/derived-state.ts`) is a single global number.
Bumping it for one series invalidates the coverage and cache manifests of **every** series for
every security, and the affected history is rebuilt lazily on next access.

This is **accepted for now**. It is observable in production data: after the r2 → r3 bump that
added the weekly moving averages, the hydrated securities carry `NULL` weekly columns until each is
next accessed — 701 of 30,792 rows had weekly values at the time of measurement.

Per-family or per-series revisions are a **deferred** design, not part of this decision. Revisit
when rebuild cost becomes user-visible or when a family's rebuild frequency diverges materially
from the others.

### Deferred: NOT_EVALUABLE reason persistence

The evaluator produces rich unavailability reasons — `EvaluatedIntrinsicModel` carries
`phase: "ASSEMBLY" | "VALUATION"` plus a reason code from
`IntrinsicValueAssemblyReason` or `VALUATION_NOT_APPLICABLE_REASONS`. `toSnapshot` in
`packages/stock-data/src/intrinsic-value-materializer.ts` collapses all of them to field absence
before persistence, so storage cannot distinguish "not yet eligible" from "not applicable" from
"invalidated by a later revision".

Whether Strategy's `NOT_EVALUABLE` requires those reasons to be **persisted**, or whether deriving
them at evaluation time is sufficient, is a **deferred Strategy decision**. It is deliberately not
settled here: persisting a reason per series per trading day is a storage-shape change that should
be decided together with the Strategy engine that would consume it, not in advance of it.

## Non-goals

This decision does **not**:

- migrate calculated values to JSONB, now or on a schedule;
- introduce EAV or any long-form storage table;
- introduce a v3 namespace or a key per series (the column-oriented encoding of the yearly chunk,
  recorded above, changed how a chunk is spelled and nothing about the key family);
- introduce a generic `/series` API endpoint;
- introduce per-family or per-series revisions;
- change any financial formula, warm-up convention or point-in-time rule;
- add RSI, MACD, growth or ratio series;
- make `WeeklyPrice` a generic derived-series value — it remains completed-week OHLCV source data;
- claim the wide-column model is correct beyond the stated range and budgets.

## References

- `ai/architecture/calculated-series.md` — how this is implemented.
- `docs/development/adding-a-calculated-series.md` — the extension checklist.
- `docs/decisions/stock-data-foundation.md` — unified daily derived state, PIT and weekly rules.
- `docs/decisions/selectable-series-catalog.md` — the product catalog and its identities.
- `docs/decisions/intrinsic-value-engine.md` — model formulas, provenance and availability rules.
