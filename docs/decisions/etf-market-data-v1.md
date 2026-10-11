# ETF Market Data V1

## Status

**Accepted for PR 1 — the historical-data infrastructure.** The Dashboard that draws these series,
and any change to the `GET /market-overview` contract, are later pull requests and are not part of
this decision's implementation. Nothing here exposes a new series to a browser.

PR 2 has since replaced the `GET /market-overview` contract and the Dashboard's index cards with the
ETF market overview, reading this infrastructure through `BenchmarkHistoryReader` and never the
provider: `docs/decisions/etf-market-overview-v1.md`. Statements below that the endpoint is untouched
describe PR 1.

This decision:

- adds nineteen ETF series to `BENCHMARK_CATALOG` and one grouped market-overview catalog of twenty
  ETFs (`SPY` reuses `SP500`);
- replaces the benchmark Redis projection's `manifest` + yearly-key layout with an immutable,
  content-addressed chunk layout under a compare-and-set head, which fixes two defects in it;
- makes every benchmark history **fully resident** in Redis, with PostgreSQL canonical;
- applies the re-base protection of `historical-price-basis-v1.md` to `ETF_PROXY` benchmark series,
  as its §12 requires before an ETF that can split is added;
- adds an independent, durable market-data refresh owned by its own worker child;
- adds a bootstrap command and a readiness guard against an unsafe Redis eviction policy.

`ai/architecture/benchmark-data.md` describes the resulting mechanism. `AGENTS.md` invariants 13, 15
and 16 carry the rules.

## Context

### The universe

Twenty ETFs in three display groups, in this order:

| Group                | Tickers                                                |
| -------------------- | ------------------------------------------------------ |
| Benchmarks           | SPY, QQQ, DIA, IWM, RSP                                |
| Sector Performance   | XLK, XLF, XLE, XLV, XLI, XLY, XLP, XLU, XLB, XLRE, XLC |
| Macro & Alternatives | GLD, USO, TLT, HYG                                     |

`USO` holds near-month WTI crude oil futures. It is not the spot price of oil, it has had a 1:8
reverse split (2020-04-29), and its long history diverges from crude by roll cost. Its catalog
description and its market-overview entry both say so.

### What already existed

The benchmark subsystem (`ai/architecture/benchmark-data.md`) already held immutable, versioned
series identity, a PostgreSQL bar table keyed `(seriesId, date)`, durable coverage and freshness
watermarks, the shared FMP adapter with its 5,000-row pagination, the shared Redis provider gate,
the Redlock hydration lock and a Redis projection under `benchmark:v1:*`. It already loaded `SPY`
as `SP500` and three market-reference indices. Everything the twenty ETFs need is either already
there or a property the subsystem should have had anyway.

### Two defects in the old projection

1. **The manifest narrowed.** Each hydration wrote the years of its own target and then a manifest
   saying `coverageStart = target.from, coverageEnd = target.to`. A 30-day market-overview read
   after a 30-year backtest hydration therefore replaced a 30-year manifest with a 30-day one, and
   the next backtest missed Redis and read PostgreSQL again. Residency was a property of whichever
   read came last.
2. **A multi-year publication was not atomic.** Years were written one plain `SET` at a time, and a
   reader's `MGET` did not check that the years it received came from one publication. A reader
   racing a republish could combine years from two different writes, and with a re-base two
   different price bases.

## Decision

### 1. Catalog: one list, SPY reused

- Nineteen catalog rows `ETF_<TICKER>`, `sourceKind: FMP_SYMBOL`, `seriesType: ETF_PROXY`,
  `isActive: true`, **`isBacktestSelectable: false`**. `GET /benchmarks` and every existing
  snapshot are unchanged, and the backtest comparison stays `SP500` alone.
- `SPY` is `SP500`. The backtest benchmark and the execution calendar are already the SPY series,
  so the overview reads it rather than storing and fetching SPY twice. `SP500` remains the
  execution calendar.
- `MARKET_OVERVIEW_ETF_GROUPS` in `@intrinsic/domain` (`market-overview-etfs.ts`) is the one grouped
  list: ticker, label, benchmark code, listing month and, for `USO`, the futures note. The refresh
  job and the bootstrap read it. It crosses no API contract in this PR.
- The index references `SP500_INDEX`, `DJIA_INDEX` and `VIX_INDEX` are untouched, and so is
  `GET /market-overview`.

### 2. PostgreSQL is canonical

Every bar is written to `BenchmarkDailyPrice` before anything is published to Redis, coverage and
watermarks are PostgreSQL state, and every Redis key can be rebuilt from PostgreSQL without the
provider. Three tables are added (migration `20261011120000_etf_market_data`, additive only):

- `BenchmarkSeriesPriceBasis` — the per-series price-basis generation;
- `BenchmarkPriceBasisEvent` — measured re-bases written with a replacement;
- `MarketDataRefreshSchedule` — the refresh's singleton claim row.

### 3. Redis: an immutable chunk per year, a compare-and-set head

```text
benchmark:v1:benchmark:<seriesId>:head                               JSON head
benchmark:v1:benchmark:<seriesId>:chunks                             registry set
benchmark:v1:benchmark:<seriesId>:daily-price:v1:<year>:<digest16>  columnar year chunk
benchmark:v1:benchmark:<seriesId>:generation                         generation fence
```

- **A chunk is immutable and content-addressed.** Its key carries the year's digest — PostgreSQL's
  `md5` over the year's bars, truncated to 16 hex digits — so a key always holds exactly one
  content. The payload is columnar (`{v,s,y,d,o,h,l,c,x}`), about 52 bytes per bar against about
  136 for the old row JSON, and is validated on decode.
- **The head is the publication.** It names the series, the chunk encoding version, the price
  dataset version, the price-basis generation, the resident ranges, every year's digest, the bar
  count, first and last date, and when it was materialized.
- **The head always describes all durable coverage.** A publication is built from PostgreSQL's
  complete history, never from the range a caller asked for, so a narrow read can no longer narrow
  residency. Unchanged years are reused: their digest is already in the head and their chunk
  already exists.
- **Publication is staged, then committed by compare-and-set.** One Lua script writes missing
  chunks with a short expiry (default 10 minutes) and records them in the registry. A second
  commits the new head only if the stored head is still the one the publisher read, and only if
  every chunk it names exists; it then removes every expiry from the named chunks and deletes
  every registered chunk the new head does not name. A losing publisher changes nothing; an
  interrupted one leaves only expiring chunks, which the next commit also sweeps.
- **The snapshot is consistent.** Coverage, the generation and every year's digest are read in one
  `REPEATABLE READ` transaction, so a head never names a digest from a different moment than its
  coverage.
- **A reader sees one publication or retries.** It reads the head, then `MGET`s exactly the chunks
  of the years it needs. A chunk missing means the head moved; it re-reads the head, at most three
  times, then falls back to PostgreSQL. An unreadable chunk is deleted and reported.
- **The head answers any range.** It holds every stored bar and every coverage interval, so a read
  returns the bars in its range and reports what coverage does not hold as missing, computed from
  the head — exactly the answer PostgreSQL would give, with no database call. A read through today
  on a weekend is therefore served from Redis and reports Saturday onwards as missing.
- **Residency is verified, chunks included.** `ensureBenchmarkResident` compares the head's
  generation, coverage and every year's digest with PostgreSQL, and checks that every chunk it
  names exists; a chunk deleted as unreadable or lost to eviction makes the series republish from
  PostgreSQL. A publication that cannot commit is reported `UNPUBLISHED`, never as an empty history.
- **Bounded memory.** Each series holds one publication's chunks plus, briefly, one stage's. Nothing
  grows with the number of publications, and the old layout is deleted on the first commit.
- **No TTL on anything committed.** Residency is a property of the data, never a timer.
- **The generation fence.** A head commits only when its price-basis generation equals the
  series' fence; with no fence, nothing commits. The fence is written in exactly two places, both
  holding PostgreSQL's series write lock — the transaction-scoped advisory lock under which every
  generation change happens:
  1. a re-base replacement raises it to the new generation inside its transaction, after its last
     write and immediately before its commit, and in the same atomic step removes every head,
     registry and chunk of another generation;
  2. a publisher that finds the fence missing (Redis lost it) or not equal to its snapshot's
     generation re-establishes it from the generation PostgreSQL has committed, waiting out a
     replacement in flight, then reads a new snapshot if its own is older.

  Why this is enough: the lock orders every fence write with every generation change, so the fence
  is never behind a committed generation, and a raise removes the old generation's projection
  before the new generation commits. A head of the old generation committed before the raise is
  removed by it; one attempted after it is refused, however stale its publisher and whether or not
  that process still holds its hydration lease. A replacement that rolls back after raising leaves
  the fence one ahead, which the next publisher repairs under the lock. Readers never consult the
  fence: a warm read is still one `GET` and one `MGET`, with no PostgreSQL call.

### 4. Full residency, and why eviction policy matters

Every benchmark series — the twenty ETFs, the three indices and `SP500` — is kept whole in Redis.

- The namespace is outside the stock LRU. The stock LRU is application-level Lua over
  `stock-data:v2:*` and never touches `benchmark:v1:*`; its behaviour is unchanged, and an
  integration test evicts stocks under it while a benchmark head and its chunks stay.
- **Redis's own `maxmemory-policy` is a different mechanism.** An `allkeys-*` policy may evict any
  key once `maxmemory` is reached: a committed head or chunk, a hydration lock, the gate's
  cooldown. A TTL-free key is no protection against it.
- **Required configuration.** `noeviction` (recommended), or no `maxmemory` limit, or a `volatile-*`
  policy. Under `volatile-*` only keys with an expiry can be evicted: no committed projection key
  has one, but a lock or a staged chunk can still be.
- **The guard.** The API's readiness probe and both the API and the market-data worker at startup
  read `INFO memory` and judge the policy:

  | Verdict     | When                                                             | Readiness           |
  | ----------- | ---------------------------------------------------------------- | ------------------- |
  | `SAFE`      | `noeviction`, or `maxmemory` 0                                   | ok                  |
  | `TOLERATED` | `volatile-*`                                                     | ok, with the reason |
  | `ACCEPTED`  | the `allkeys-*` policy named in `REDIS_ACCEPTED_EVICTION_POLICY` | ok                  |
  | `UNSAFE`    | any other `allkeys-*`                                            | **503**             |
  | `UNKNOWN`   | `INFO` refused, failed or timed out                              | ok, reported        |

  `REDIS_ACCEPTED_EVICTION_POLICY` is an explicit, auditable operator override for a managed Redis
  whose policy cannot be changed. It accepts exactly the policy it names.

- **Memory headroom.** About 125,000 bars for the twenty ETFs from their listings through 2026,
  plus the indices. At about 52 bytes per bar that is about 6.5 MB of payload, 7–8 MB with key
  overhead. A publication stages at most one series' changed years beside the live ones, under
  1 MB. Provision at least **32 MB** of headroom above the stock projection's budget for benchmark
  residency. The PostgreSQL side is about 25 MB with indexes.

**Production Redis is not changed by this PR.** Its current policy is not known to this decision.
Read it with `INFO memory` before deploying: an `allkeys-*` policy fails readiness until it is
changed or explicitly accepted.

### 5. Re-base protection for ETF series

`historical-price-basis-v1.md` §12 requires a benchmark that can split to have the detector, a
generation and an atomic read before it is added. The ETF series reuse the stock implementation
(`comparePriceHistories`, `closesDiffer`, `heldFromIndex` and the tolerance of §7) and apply it to
every `ETF_PROXY` series. `INDEX` series cannot be re-based by a share-changing action and are
unaffected.

- **The earliest bars are checked before every save that changes the history** (§7, rule 2, as
  the stock loader applies it). A read that would add a session or change a stored bar
  (`changesStoredBenchmarkBars`) first re-reads a 30-calendar-day window at the start of the stored
  history. A re-base rescales every bar before its ex-date, so those bars change whenever any
  re-base happened, however long ago — including one the provider folds in weeks after the
  ex-date, when the tail itself reads exactly as stored. A read that changes nothing is saved as it
  is and costs no check.
- **Unchanged earliest bars: an ordinary correction.** The read is saved. This is what keeps a
  corrected recent bar from being a false positive.
- **Changed: the whole history is re-read and compared** (`comparePriceHistories`). A complete
  answer replaces the history in **one transaction** under the advisory lock: all bars, coverage,
  state, the freshness watermark, the measured events, and a generation bump by compare-and-set
  (`PriceBasisConflictError` on a race). An answer missing more than 1 % of the stored sessions is
  refused, nothing is saved, and the next run asks again (`REBASE_REFUSED`).
- **Redis before PostgreSQL, fenced.** Inside the replacement's transaction, just before it
  commits, the generation fence is raised and the old generation's head, registry and chunks are
  removed in one atomic step (§3). Until then readers are served the old generation, which is
  still what PostgreSQL holds; from then on a reader without a head reads PostgreSQL, which moves
  in one transaction, and no publisher can commit the old generation again — including one whose
  snapshot predates the commit and whose hydration lease has expired. The replacer then
  republishes under the new generation; if it lost its lease and cannot, the next publisher does.
- **Ordinary saves are pinned to their generation.** Every refresh and hydration reads the
  generation before it asks the provider and saves with it; the save compares it under the series
  write lock and writes nothing (`PriceBasisConflictError`) when a replacement committed another
  generation meanwhile. A writer that stalled past its lease therefore cannot put bars read on the
  old basis beside the new one in PostgreSQL, even when its own earliest-bars check — made after
  the provider rewrote the history — finds nothing changed.
- **The ex-date hold** (§7, rule 3). Bars newer than the newest stored one are compared with the bar
  before them; a move below 0.7 or above 1.4 holds that bar and every later one while fewer than four
  sessions stand from it. `USO`'s 1:8 reverse split (×8) is exactly that move. Once four sessions
  stand, the move is saved — after the earliest-bars check has had that read to show a rewrite. A
  replacement applies the hold against the provider's own bar for the newest stored session, which
  is on the new basis, never against the stored one.
- **Backtests.** A run reads its benchmark in one call, which returns one publication's bars or
  PostgreSQL's, so a replacement cannot mix bases within a run. `SPY` has not split since 1993. A
  per-run generation pin for benchmarks is not added: it would change the comparison semantics,
  which this PR must not.

### 6. Bootstrap

```bash
pnpm benchmarks:prewarm --group market-overview --report artifacts/market-overview-bootstrap.json
```

- It reconciles the catalog (the same idempotent path every API boot runs), then loads the twenty
  ETFs **one at a time, `SP500` first**, each from `1993-01-01` — before every fund listed, so the
  provider decides where each history begins — to today.
- Each series goes through `ensureBenchmarkHydrated`: coverage subtraction, the hydration lock, the
  shared gate, the paginated provider walk, PostgreSQL, then Redis. Then `ensureBenchmarkResident`
  proves the head against every year's digest, and the report is computed from the history read
  back through the provider-free reader.
- **Report per ETF:** first and last bar, bar count, the pre-inception period, coverage still
  missing, `SP500` sessions missing inside the history, bars on dates `SP500` has no session for,
  the longest gap, a start long after the listing month, residency, generation, **the HTTP requests
  the provider actually received** (every page and retry, counted at `fetch`), and duration.
- **Resumable and duplicate-free.** Coverage is durable, so a rerun asks only for what is still
  missing, and a range asked and found empty — the years before a listing — is never asked again.
  Bars are keyed `(seriesId, date)`. A series that fails is reported, the others still load, and the
  command exits non-zero.
- **Provider cost.** One walk per series, `⌈bars ÷ 5,000⌉` pages: two for each ETF with more than
  5,000 sessions, one for `XLRE`, `XLC` and `HYG` — about 37 requests if `SP500` is also loaded
  from scratch, fewer when it already holds history. That is an estimate. The report measures the
  real figure, which retries, an earliest-bars check on a series that already held history, and a
  provider that pages differently change.
- **Not run by this PR.** The production bootstrap needs approval. Validation procedure:
  1. confirm the eviction policy (`GET /health/ready`, or the `redis.eviction-policy` startup log);
  2. run the command above against the target environment once;
  3. check every report line is `OK`, or that each `WARN` is understood (a late start, a provider
     gap), and that `failed` is 0;
  4. run it again: it must report 0 provider HTTP requests;
  5. run `pnpm market-data:refresh-once`. It prints each series' outcome and exits non-zero when
     the run did not complete, another run was in flight, or any series is `FAILED`,
     `REBASE_REFUSED`, `NOT_BOOTSTRAPPED`, `DEFERRED` or `BACKING_OFF`.

### 7. The refresh, and who owns it

- **An independent worker child**, `market-data`, the third child kind beside backtest and Monitor
  (`MARKET_DATA_WORKER_PROCESSES`, default 1, at most 2; 0 disables it). It claims the singleton
  `MarketDataRefreshSchedule` row (id `ETF_MARKET_DATA`) with `FOR UPDATE SKIP LOCKED`, a renewable
  lease and `claimedBy`-guarded writes — the third instance of the idiom of `AGENTS.md` invariant 15.
- **Not the Monitor worker.** The Monitor cycle must never wait on twenty provider reads or back off
  because the provider is slow. Its own row in its own table means a slow or failing refresh can
  neither hold, delay nor back off the Monitor's schedule, and a test proves the refresh never
  touches `MonitorScanSchedule`.
- **Cadence.** Every 10 minutes from the end of a run (`MARKET_DATA_REFRESH_INTERVAL_MS`); a failed
  run backs off from 1 minute, doubling, capped at the interval.
- **Session- and holiday-aware.** The expected session is the latest NYSE session (the shared
  `CachedTradingCalendar`) whose close plus a publication delay (`MARKET_DATA_EOD_PUBLICATION_DELAY_MS`,
  30 minutes) has passed; weekdays are the fallback when the calendar cannot be read, and that is
  logged. A series is read only when PostgreSQL does not already hold that session, read after it
  was final. One the provider has not published yet is asked again no more often than
  `MARKET_DATA_SERIES_RETRY_MS` (30 minutes), spaced by the durable tail watermark — which only a
  read reaching today advances, so a backtest's backfill of old years never delays it. One whose
  newest bars are held at a possible ex-date advances no watermark; the child spaces it by the same
  interval in its own memory.
- **Never the full history.** One bounded tail read (`STOCK_RECENT_TAIL_CALENDAR_DAYS`, 10) from the
  oldest of: that window, the day after coverage ends, and any unsettled session, plus the
  earliest-bars check when it adds a session: two small requests per ETF per session. The full
  history is read only by the re-base protection, and only after the earliest bars changed.
- **Corrections.** A changed bar inside the tail is saved over the stored one once the earliest bars
  are confirmed, and republished. It neither bumps the generation nor triggers a full read.
- **Isolated, bounded, persisted first.** One series at a time, through the shared gate. A failing
  series is logged while the others proceed; the run fails, and backs off, only when every series
  it attempted failed. No series starts after a 4-minute budget or once the lease is lost; the rest
  are `DEFERRED`. PostgreSQL is written before the head is republished.
- **Per-series backoff.** A refused re-base costs three reads, so it is retried after 30 minutes,
  doubling up to 6 hours, not on every run; so is a series that fails while others succeed. When
  every series fails together the cause is shared and the run's own backoff applies instead. The
  backoff lives in the child's memory: a restart costs at most one early attempt per series.
- **Never a bootstrap.** A series with no coverage is reported `NOT_BOOTSTRAPPED`, once per run.
- **Redis restart.** A series that needs no read is still verified (`ensureBenchmarkResident`), so a
  Redis restart is repaired within one run from PostgreSQL alone, with no provider request. Any
  read path repairs it too.

`pnpm market-data:refresh-once` runs one run on demand through the same claim, so it never overlaps
the child.

### 8. The read interface for workers

`BenchmarkHistoryReader` (`@intrinsic/stock-data`) never calls the provider. It reads the resident
projection, rebuilds it from PostgreSQL once when Redis lost it, and falls back to PostgreSQL when
Redis cannot answer — reading the rows, the generation and the coverage in one `REPEATABLE READ`
snapshot. A rebuild that fails (the hydration lock not had in time, a lease lost while
republishing) still falls back; a Redis that cannot be read at all is an outage and fails the read,
as `AGENTS.md` invariant 16 requires. Every read is bounded by an explicit end date, clamped to
today, and never returns a bar after it. An end before the history begins returns an empty
history.

| Need             | Method                                                 |
| ---------------- | ------------------------------------------------------ |
| A range          | `readBenchmarkHistory(series, { from, to })`           |
| The full history | `readFullBenchmarkHistory(series, through?)`           |
| One session      | `readBenchmarkSession(series, date)`                   |
| A rolling window | `readBenchmarkSessions(series, { through, sessions })` |
| Several series   | `readBenchmarkHistories(series[], range)`              |

Each returns the rows, the generation they were read under, any range coverage does not hold, and
whether Redis or PostgreSQL answered. With the projection resident, a read makes no PostgreSQL and
no provider call: one `GET` of the head and one `MGET` of the years it needs.

### 9. Observability

| Event                              | Level               | Meaning                                           |
| ---------------------------------- | ------------------- | ------------------------------------------------- |
| `redis.eviction-policy`            | info / warn / error | the verdict at startup                            |
| `benchmark.cache.publication`      | debug / warn        | a commit, or a conflict, missing chunk or failure |
| `benchmark.cache.chunk-unreadable` | warn                | a chunk failed to decode and was deleted          |
| `stock-data.price-basis`           | info / warn / error | hold, re-base, refusal, unconfirmed earliest row  |
| `market-data.refresh.*`            | info / warn / error | claim, series outcome, summary, failure, recovery |
| `benchmark.prewarm.group.*`        | info / error        | the bootstrap and its per-ETF report              |

## Alternatives rejected

- **A dashboard market cache or a second price table.** It would be a second hydration path, which
  `AGENTS.md` invariant 13 forbids, and would re-implement coverage, the lock and the gate.
- **The Monitor worker doing the refresh.** It couples the two schedules, which must stay
  independent.
- **A cron, a queue or a Redis lock for the refresh.** Invariant 15: a third durable claim matches the
  existing two.
- **Keeping the manifest and writing it wider.** Without content-addressed chunks a reader still
  cannot tell two publications' years apart; a compare-and-set head over immutable keys is what
  makes a read consistent.
- **A TTL on benchmark keys.** Residency would become a timer, and expiry would cost provider-free
  but needless rebuilds.
- **Changing production Redis from code.** Not this PR's to do; the guard reports and blocks
  readiness instead.

## Limitations

- **Redis that loses acknowledged writes.** The fence assumes Redis keeps what it acknowledged. A
  failover to a lagging replica, or a restart from a snapshot taken before a replacement, can bring
  back an old fence with an old head; readers do not compare generations with PostgreSQL, so that
  head is served until the next residency check — the refresh child's next run for the twenty ETFs
  and `SP500`. After restoring Redis from a backup, delete the `benchmark:v1:*` keys or run
  `pnpm market-data:refresh-once`.
- **A fence write delayed past its transaction.** Every fence write is issued under the series
  lock but not bounded by it: one stalled in transit for longer than the 120-second transaction
  timeout could land after a later one. It can only leave the fence behind PostgreSQL with the head
  removed; an old head would need a second publisher stalled the same way.
- **In-process spacing.** The per-series backoff and the held-series spacing live in the child's
  memory; a restart costs at most one early read per series.
- **Budget order.** Under persistent slowness the 4-minute budget defers the same series — the last
  in display order — on every run.
- **A re-base during a hydration** replaces the history and ends that hydration, so an older range
  the same target was missing is read by the next attempt rather than this one.

## Pre-deployment checklist

- [ ] Approve and apply migration `20261011120000_etf_market_data` (additive).
- [ ] Read the production Redis `maxmemory-policy`; set `noeviction`, or set
      `REDIS_ACCEPTED_EVICTION_POLICY` deliberately. Confirm at least 32 MB of headroom.
- [ ] Decide `MARKET_DATA_WORKER_PROCESSES` (default 1) for the worker deployment.
- [ ] Approve the production bootstrap and run the validation procedure in §6.
- [ ] Watch `market-data.refresh.run.summary` for the first trading day.

## References

- `docs/decisions/historical-price-basis-v1.md` — §7–§9 and §12.
- `ai/architecture/benchmark-data.md` — the benchmark subsystem.
- `docs/decisions/complete-price-coverage.md` — the provider's 5,000-row page and coverage meaning.
- `ai/architecture/api-worker.md` — worker processes and durable claims.
