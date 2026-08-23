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
5. Persist rows, successful provider-request coverage, and state transactionally.
6. Bring daily technical and weekly aggregation versions current from canonical price history.
7. Publish complete yearly price, daily technical, and weekly chunks.
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

Changed recent prices rewrite only affected current/recent yearly chunks. Closed years remain
untouched in the normal append path.

## Coordination

Security discovery uses `stock-data:load:hydrate:symbol:<NORMALIZED_SYMBOL>` until a durable
Security ID exists. Full hydration and freshness then use
`stock-data:load:hydrate:<securityId>`. Caller ranges and datasets are never part of lock identity.

Redlock uses a finite lease, automatic extension proportional to the lease, bounded acquisition
retry, and ownership assertions before persistence and final cache publication. Exceptions release
the lock. A caller waiting in another API/worker process acquires after the first caller, rechecks
READY, and performs no duplicate provider work. A definitive lease loss prevents subsequent
durable writes or READY publication.

## Redis v2

Canonical resident keys are security-ID based:

```text
stock-data:v2:symbol:<encoded-symbol>:security
stock-data:v2:security:<id>:manifest
stock-data:v2:security:<id>:prices:1D:<year>
stock-data:v2:security:<id>:technicals:1D:v<calculationVersion>:<year>
stock-data:v2:security:<id>:weekly:1W:v<calculationVersion>:<year>
stock-data:v2:security:<id>:keys
stock-data:v2:resident-stocks
stock-data:v2:access-sequence
```

Range reads issue one multi-key read for the intersecting years, concatenate ascending rows, and
slice exact boundary dates. Exact HTTP/date-range response keys do not exist.

The manifest contains status, configured horizon years, attempted coverage bounds, actual first
and last available price dates when present, hydration/freshness instants, and dataset calculation
versions. HYDRATING is advisory; the distributed lock is authoritative. READY is written only
after all required chunks. A failed process cannot permanently block later hydration because a
later lock owner ignores/rebuilds non-READY state.

Complete-stock LRU uses a Redis `INCR` access sequence shared by API and worker. Every key is
registered under the security ID. Eviction reads that registry and deletes the manifest and all
chunks as one logical unit without `SCAN`.

## FMP resilience

The FMP adapter classifies rate-limit, authentication, transient server/network, and non-retryable
provider errors without including the API key or complete URL in errors. 429 handling supports
Retry-After seconds and HTTP-date forms. Rate-limit and transient failures use bounded exponential
backoff, jitter, maximum delay, and finite retries; 401/403 and other invalid 4xx requests are not
aggressively retried.

Every attempt passes through `RedisFmpRequestGate`. The gate uses a leased distributed concurrency
semaphore, fixed-window rate permit, bounded per-process queue/wait, and shared TTL cooldown. A 429
publishes the bounded cooldown under `stock-data:v2:fmp:cooldown-until`; the credential is never
part of a Redis key. API and worker observe the same backpressure.

## Derived data

Daily SMA20D/50D/100D/200D and EMA20D/50D/200D use canonical ascending DailyPrice history and
`calculationVersion = 1`. EMA seeds from the first complete-period SMA and then applies
$\alpha = 2/(period + 1)$. The origin is the first canonical available price, never an arbitrary
requested warm-up prefix, so request order cannot affect output.

Price upserts detect the earliest actual changed date and do not delete historical derived rows.
Normal suffix appends calculate against canonical history but persist only the new suffix and
rewrite only affected Redis years. Corrections persist forward from the corrected date because EMA
recurrence propagates. Introduction of an older prefix recalculates from canonical origin.

Weekly bars are derived only from canonical daily rows. Monday-based completed weeks use
first/max/min/last/sum OHLCV and become eligible the following Monday. IPO mid-week,
holiday-shortened, cross-year, and current partial weeks follow the same completed-period rule.
There is one durable weekly row per completed week, never one duplicate per day.

## Point-in-time and versions

Intrinsic and blend reads require both `valuationDate <= asOf` and
`sourceDataAsOf <= endOf(asOf)`. When `to` and `asOf` are present, the valuation upper bound is
`min(to, asOf)`.

Durable intrinsic reads select the highest calculation version for each valuation-date/model
identity, then the latest eligible source instant. Blend reads select highest blend version, then
calculation version, then eligible source instant for each valuation-date/blend identity. Dynamic
blend calculation chooses the highest calculation version shared by every required component and
never mixes versions, substitutes models, or renormalizes missing weights.

Persisted blend rows do not cause an early return. The service combines persisted identities with
eligible component dates, calculates only missing requested identities, deduplicates, and sorts the
merged result.

## Validation

Normal tests use deterministic providers. Real Redis tests cover yearly write/read and slicing,
current-year replacement, READY manifests, complete-stock LRU, separate Redlock coordinators,
exception release, provider-wide limiting/cooldown, and two service instances with separate Prisma
and Redis clients performing one canonical FMP delta. Live AAPL profile, split-adjusted history,
SMA, and EMA checks remain opt-in through `test:live`.
