# Stock Data Loader Implementation

## Status

Implemented on the stock-data loader feature branch. This decision supersedes the foundation
document wherever it previously implied request-range-driven hydration.

> Requested ranges are read projections, not hydration boundaries.

## Ownership

`@intrinsic/stock-data` is the one infrastructure-aware application layer used by Stock Details
and worker/backtest callers. API and worker create process-local Prisma and Redis clients and
inject the same service/adapters. They do not implement separate cache, provider, or technical
paths. PostgreSQL remains authoritative; Redis is disposable and reconstructible.

## Canonical hydration

`ensureStockHydrated` establishes all available canonical daily history up to
`STOCK_HISTORY_YEARS` (30 by default), clipped by known IPO date, provider availability, and the
current canonical date. It performs these steps under one stock hydration lock:

1. Recheck the v2 manifest after lock acquisition.
2. Compute the canonical horizon independently of the caller's requested range.
3. Subtract durable `StockDatasetCoverage` intervals from that horizon.
4. Request only missing prefix, suffix, or internal intervals from FMP.
5. Persist rows, successful provider-request coverage, and state transactionally. Coverage for an
   exact security/dataset/variant is compacted into disjoint maximal intervals; overlap and
   calendar-day adjacency merge while real gaps and other variants remain separate.
6. Rebuild the unified daily derived state from canonical price history.
7. Publish complete yearly price and daily derived-state chunks. A partial rebuild still republishes
   every affected year in full from PostgreSQL, because a yearly chunk is replaced wholesale.
8. Publish READY last.

A successful empty historical interval is durable request coverage. This distinguishes provider
or pre-listing unavailability from missing trading rows and prevents repeated empty-prefix loads.
It does not fabricate price rows. If PostgreSQL already covers the horizon, re-admission after LRU
eviction performs no historical FMP request.

## Freshness

`ensureStockFresh` is distinct from hydration. READY manifests carry the latest successful price
refresh instant. Once `STOCK_RECENT_PRICE_FRESHNESS_MS` elapses, the service requests only the
bounded `STOCK_RECENT_TAIL_CALENDAR_DAYS` interval. Successful empty weekend/holiday responses
delay another attempt only for the freshness interval; they do not permanently mark a future EOD
bar complete. Failures and exhausted 429 retries do not advance durable or Redis freshness.

Recent-tail freshness is stored independently in the dataset-state variant
`split-adjusted-eod-full:recent-tail`. A successful sync advances it only when the requested
coverage reaches the current canonical tail. This prevents a newer historical-gap fill from making
an old tail appear fresh after coverage intervals are compacted. Tail date and successful-sync
instant are monotonic under out-of-order completion.

Changed recent prices rewrite only affected current/recent yearly chunks. Closed years remain
untouched in the normal append path.

## Coordination

Security discovery uses `stock-data:load:hydrate:symbol:<NORMALIZED_SYMBOL>` until a durable
Security ID exists. Full hydration and freshness then use
`stock-data:load:hydrate:<securityId>`. Caller ranges and datasets are never part of lock identity.

A cached `symbol -> Security` identity is authoritative only while that stock's cache generation
is READY. Outside a READY generation the identity is re-resolved from PostgreSQL, and only then
from the provider, because PostgreSQL owns identity and Redis is disposable. Serving a cached
identity unconditionally allowed a deleted Security to survive in Redis and made every dependent
write fail on its foreign key instead of recovering.

Redlock uses a finite renewable lease (`STOCK_DATA_LOAD_LOCK_MS`, 30 seconds by default) and an
independent finite acquisition window (`STOCK_DATA_LOCK_WAIT_MS`, 120 seconds by default).
Automatic extension is proportional to the lease, and ownership assertions occur before
persistence and final cache publication. Exceptions release the lock. A caller waiting in another
API/worker process can wait through a 10+ second canonical load, then acquires, rechecks READY, and
performs no duplicate provider work. A definitive lease loss prevents subsequent durable writes or
READY publication. Price/derived write transactions also serialize per stock with a PostgreSQL
transaction advisory lock and assert lease ownership immediately before commit.

## Redis v2

Canonical resident keys are security-ID based:

```text
stock-data:v2:symbol:<encoded-symbol>:security
stock-data:v2:security:<id>:manifest
stock-data:v2:security:<id>:prices:1D:<year>
stock-data:v2:security:<id>:daily-state:<year>
stock-data:v2:security:<id>:keys
stock-data:v2:resident-stocks
stock-data:v2:access-sequence
```

Range reads issue one multi-key read for the intersecting years, concatenate ascending rows, and
slice exact boundary dates. Exact HTTP/date-range response keys do not exist.

The manifest contains status, configured horizon years, attempted coverage bounds, actual first
and last available price dates when present, hydration/freshness instants, source-dataset versions,
the derived-state methodology revision, and a unique hydration generation. HYDRATING is advisory and expires after 15 minutes;
the distributed lock is authoritative. Every chunk, symbol mapping, and READY publication compares
the active generation, so a stale owner cannot overwrite or register keys under a successor. A
concurrent generation-less symbol lookup atomically joins the currently active HYDRATING lifetime
rather than creating a persistent orphan. While HYDRATING, the manifest, registry, and every
registered key share a renewable temporary expiry. Generation-checked READY publication atomically
removes those expiries before resident admission. A crashed generation therefore self-cleans
without another stock access, while normal READY chunks never expire independently. READY is
written only after all required chunks. A later lock owner atomically replaces stale HYDRATING or
orphaned registry state and deletes every registered key without `SCAN` before reconstructing the
cache from PostgreSQL/provider deltas.

Complete-stock LRU uses a Redis `INCR` access sequence shared by API and worker. Every key is
registered under the security ID. READY publication, resident admission, oldest-victim selection,
and registry-based complete-stock deletion execute in one Lua transaction. Touch only applies to a
currently READY resident, so a stale reader cannot resurrect an evicted stock. No hot path uses
`SCAN`.

## FMP resilience

The FMP adapter classifies rate-limit, authentication, transient server/network, and non-retryable
provider errors without including the API key or complete URL in errors. 429 handling supports
Retry-After seconds and HTTP-date forms. A supplied Retry-After is honored in full and is not
shortened by `FMP_RETRY_MAX_DELAY_MS`; that setting caps exponential backoff only when the header is
absent. `FMP_MAX_RETRY_WAIT_MS` may make the current caller fail instead of sleeping through a long
cooldown and is enforced across cumulative retry sleep. Retries remain finite; 401/403 and other
invalid 4xx requests are not aggressively retried.

Every attempt passes through `RedisFmpRequestGate`. After waiting outside concurrency for any
provider cooldown, one Redis Lua admission atomically checks cooldown, distributed concurrency,
and the current fixed rate window immediately before the outbound callback starts. It consumes
both permits together, so a rate permit cannot be carried while waiting for concurrency. Redis
server time defines concurrency lease timestamps across API and worker hosts. A 429 atomically
publishes an absolute provider boundary under `stock-data:v2:fmp:cooldown-until` using Redis time.
A shorter later publication cannot reduce that boundary. The current caller's bounded queue/retry
wait does not cap the shared cooldown, and the credential is never part of a Redis key. API and
worker observe the same backpressure.

## Derived data

Daily SMA20D/50D/100D/200D and EMA20D/50D/200D use canonical ascending DailyPrice history. EMA seeds from the first complete-period SMA and then applies
$\alpha = 2/(period + 1)$. The origin is the first canonical available price, never an arbitrary
requested warm-up prefix, so request order cannot affect output.

Price upserts detect the earliest actual changed date and do not delete historical derived rows.
Normal suffix appends calculate against canonical history but persist only the new suffix and
rewrite only affected Redis years. Corrections persist forward from the corrected date because EMA
recurrence propagates. Introduction of an older prefix recalculates from canonical origin.

Weekly bars are derived only from canonical daily rows. Monday-based completed weeks use
first/max/min/last/sum OHLCV. Because `DailyDerivedState` is an end-of-trading-day state, a
completed week becomes eligible on its own final trading day's close, which is the last observed
bar of that week; earlier days in the same week must never see it. The ISO week containing the
hydration cutoff is still in progress and is not aggregated, since its final trading day is not yet
known. IPO mid-week, holiday-shortened, and cross-year weeks follow the same rule and use their
actual final trading day. If the 30-year canonical horizon begins mid-week, that artificially
truncated first week is omitted; a known IPO/listing that genuinely begins mid-week remains a valid
completed week. `WeeklyPrice` keeps one durable row per completed week; only the derived weekly
values are carried forward daily.

Derived persistence records one dataset state per family:
`DAILY_DERIVED_STATE / daily-derived-state:r<revision>` and `WEEKLY_PRICE / completed-weeks`.
Neither carries a calculation version.

## Point-in-time

Intrinsic and blend reads require both `valuationDate <= asOf` and
`sourceDataAsOf <= endOf(asOf)`. When `to` and `asOf` are present, the valuation upper bound is
`min(to, asOf)`.

`sourceDataAsOf` is per intrinsic-value model, not per row: each model has its own provenance
column and the cutoff is evaluated independently per model, so one model on a daily row can be
eligible while another on the same row is withheld. No model is ever delayed to the newest
provenance instant on its row, and a model value without its own provenance is never returned.

A blend's `sourceDataAsOf` is derived as the maximum provenance of the models composing it and is
never persisted. A blend is returned only when every required component value and component
provenance is present and eligible at the cutoff.

Intrinsic values and blends are read directly from the materialized daily state: there is exactly
one current row per `(securityId, date)`, so no version selection or read-time reconstruction from
sparse valuation events happens. A blend that was never materialized is absent; the reader must not
substitute models or renormalize missing weights.

## Validation

Normal tests use deterministic providers. Real Redis/PostgreSQL tests cover yearly write/read and
slicing, current-year replacement, generation-safe stale HYDRATING recovery, atomic complete-stock
LRU ordering, separate Redlock coordinators waiting beyond the old short retry window, exception
release, monotonic 120-second provider cooldown, transactional coverage compaction/concurrency, and
rate-window-boundary backlog admission. They also prove abandoned HYDRATING generations self-clean,
READY generations persist, the durable daily derived state survives Redis re-admission without
another derived rebuild, and two service instances perform one canonical FMP delta.

A cross-layer infrastructure suite additionally drives the assembled system over real HTTP:
Nest routes, `CanonicalStockDataService`, PostgreSQL, `RedisStockDataCache`, and
`RedlockLoadCoordinator`, with only the FMP provider boundary replaced by deterministic
fixtures. Each scenario is asserted on all three surfaces — HTTP response, PostgreSQL through
Prisma, and Redis keys — because a 200 response alone does not establish durable or cached
state. It covers:

- cold hydration and repeated requests projecting one canonical state;
- process restart against the same PostgreSQL and Redis, proving no dependence on process memory;
- complete and partial Redis loss, proving Redis is disposable and rebuilt from PostgreSQL
  without provider traffic;
- recovery when a cached identity outlives its Security row;
- the point-in-time intrinsic lifecycle: first eligibility, weekend availability taking effect on
  the next trading day, later revisions changing valuations only from their own eligibility,
  invalidation and restoration of a model, carry-forward between events, and per-model and blend
  provenance;
- price-only, fundamentals-only, and combined refresh cycles converging on one derived row per
  trading day with republication limited to affected years.

The suite runs against a dedicated test database supplied through `TEST_DATABASE_URL` and a
randomized Redis namespace, and removes only what it created.

Live checks remain opt-in through `test:live`: AAPL profile, split-adjusted history, SMA/EMA,
and intrinsic model values and canonical blends. They assert sanity and point-in-time invariants
— finite positive values, consistent currency, provenance never later than the valuation day,
blends equal to their weighted components, PostgreSQL and Redis agreeing on the latest daily
state, and a second request issuing no historical backfill — never exact provider numbers.
