# Stock Data Loader Implementation

## Status

Implemented on the stock-data loader feature branch. This note records the implementation of the
approved `stock-data-foundation.md` contracts; that foundation decision remains authoritative.

## Ownership and dependencies

`@intrinsic/stock-data` is the one infrastructure-aware application layer for Stock Details and
future worker/backtest callers. It owns orchestration, range subtraction, Prisma mapping, Redis
residency, distributed coordination, daily/weekly derivation, and point-in-time selection. API and
worker create process-local database/Redis clients and may inject adapters, but do not duplicate
loader behavior. `domain` and `valuation` remain infrastructure-free.

## PostgreSQL

Migration `20260823120000_add_stock_data_loader` adds:

- UUID-keyed `Security` plus current `SecurityProfile`;
- `StockDatasetState` with dataset variant, watermarks, last successful sync, and calculation version;
- split-adjusted `DailyPrice` and versioned `DailyTechnical`;
- one `WeeklyPrice` per completed week and generic versioned `WeeklyTechnical` storage;
- point-in-time `IntrinsicValue` and versioned `IntrinsicValueBlend` snapshots.

Migration `20260823160000_add_stock_dataset_coverage` adds exact successful request intervals.
Watermarks remain optimization state. Coverage intervals allow an internal unfetched range to be
loaded without interpreting weekends or holidays as missing market rows. Dataset rows, coverage,
and successful state advance in one transaction; failed multi-delta loads commit none of them.
When canonical price rows change, persisted daily/weekly derived rows and their coverage/state are
invalidated transactionally because a newly loaded prefix can change downstream EMA seeds.

## FMP

Production uses the stable `profile` and `historical-price-eod/full` endpoints. The latter is the
canonical split-adjusted, non-dividend-adjusted OHLCV source. DTOs are validated and mapped inside
`@intrinsic/fmp`; nullable identifiers, string employee counts, timestamps, percentage units, and
newest-first ordering do not cross into the domain. Optional live tests call stable
`technical-indicators/sma` and `technical-indicators/ema` only as validation oracles.

## Range loading

The service checks Redis, reads PostgreSQL coverage, subtracts covered intervals from the bounded
request, calls FMP once for each missing interval, persists all successful deltas atomically,
invalidates the symbol cache, and returns an ascending database read. Prefix, suffix, two-sided,
and internal gaps are supported. A successfully fetched interval covers its calendar bounds, so an
empty weekend/holiday response is not retried as if rows were expected.

## Redis and coordination

Data keys use `stock-data:v1:symbol:<encoded-symbol>:<dataset-key>`. Each key is registered in
`stock-data:v1:symbol:<encoded-symbol>:keys`; LRU order is the
`stock-data:v1:resident-symbols` sorted set. Admission and eviction operate on a complete symbol and
never use `SCAN`. Redis is disposable and all cache values can be rebuilt from PostgreSQL/FMP.
Redlock resources use `stock-data:load:<symbol>:<dataset>` with expiration and automatic extension;
callers recheck cache/coverage after lock acquisition.

## Technical semantics

Daily SMA20D/50D/100D/200D and EMA20D/50D/200D are calculated from canonical closes and persisted
with `calculationVersion = 1`. EMA seeds with the SMA at the first complete period, then uses
$\alpha = 2/(period + 1)$. Values before the complete seed window are absent, never zero. A bounded
technical request loads a 400-calendar-day warm-up prefix.

Weekly bars aggregate Monday-based completed trading weeks from daily bars. Open/high/low/close/
volume use first/max/min/last/sum. A snapshot becomes eligible the following Monday, including for
holiday-shortened weeks, so a date inside the source week cannot observe its eventual close.
Weekly moving averages consume weekly closes; no arbitrary weekly period catalog is activated.

## Intrinsic value

The schema and repository preserve security ID, valuation date, `sourceDataAsOf`, model, value per
share, currency, and calculation version. Queries require both valuation date and publication
instant to be eligible by `asOf`. Approved blends retain definition version and require every
component; missing DDM or another model yields no blend, with no substitution or renormalization.

V2 contains no retained validated valuation formulas or approved source-publication ingestion
pipeline. This slice therefore does not invent DCF, residual-income, DDM, or Graham assumptions.
Formula/source ingestion remains a follow-up behind the implemented persistence/calculation ports.

## HTTP

The public read surface is `GET /stocks/:symbol`, `/prices`, `/technicals/daily`,
`/intrinsic-values`, and `/intrinsic-value-blends`. Stock Details defaults to 365 bounded days.
Historical arrays are ascending; dates, ranges, models, and blend IDs are validated; unknown symbols
return 404; unrecognized provider/storage failures return a generic 503 without provider details.
