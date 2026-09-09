# Price Retention Behind the Product Horizon

## Status

**Accepted.**

Refines `caller-scoped-history-materialization.md`: the caller's range still decides what is
materialized, but the bound that range is clamped to is no longer the product horizon. It does not
change `complete-price-coverage.md` — `PRICE_DATASET_VERSION` is deliberately **not** bumped,
because what a persisted daily bar means has not changed. It does not change
`fundamentals-loader.md`: statement retention stays anchored to the product horizon.

## Context

`STOCK_HISTORY_YEARS` (30) meant two different things at once. It was the product horizon — the
oldest day a user may select, chart, query or backtest — and it was also the outer clamp on the
loader's own price retention. `canonicalTarget` computed one range from it, and that range was used
both by `projectionRange`, which decides what a caller may _see_, and by `loadTarget`, which decides
what the loader may _hold_.

The two are not the same question, and conflating them produced a real defect. `loadTarget` widens
a requested window by `DERIVED_SERIES_WARMUP_DAYS` — 1,456 calendar days, the two-hundred completed
weeks `SMA(200, 1W)` / `EMA(200, 1W)` need plus a margin — and then clamped the result back to the
horizon. For a maximum-length backtest, whose period starts exactly on that horizon, the clamp
undid the widening entirely: the warm-up was subtracted and immediately clipped back onto the
boundary it was meant to reach behind. The first four years of a thirty-year run therefore had no
two-hundred-week average at all, and a Strategy naming one was `NOT_EVALUABLE` for that whole span
— silently, because an absent series is a legitimate warm-up answer everywhere else.

FMP does return daily history older than thirty years for long-listed US securities such as `AAPL`
and `IBM`, so the missing rows were available all along. Nothing about the product should widen to
reach them.

## Decision

**The product horizon and the raw-price retention horizon are separate policies. The product
horizon stays at 30 years. Raw `DailyPrice` retention becomes 34.**

1. **`STOCK_HISTORY_YEARS` is the product horizon and nothing else.** It is surfaced as
   `productHistoryYears`, and it alone bounds `projectionRange`, `intrinsicReadRange`,
   `boundFinancialQuery` and the Stock Details bound. `BACKTEST_MAX_PERIOD_YEARS` and
   `STOCK_DETAILS_MAX_HISTORY_YEARS` in `@intrinsic/contracts` are unchanged at 30. No API
   contract, no UI control and no validation limit moves.
2. **Retention is derived, never configured.** `PRICE_RETENTION_WARMUP_YEARS` is
   `ceil(DERIVED_SERIES_WARMUP_DAYS / 365.25)` — four years today — and
   `priceRetentionYears(productHistoryYears)` is their sum. Registering a longer catalog series
   widens the warm-up, and retention widens with it. A second environment variable would let the
   two drift apart, which is exactly the failure this decision exists to remove.
3. **Only `loadTarget` moves.** It clamps to the retention horizon instead of the product horizon.
   Below the product boundary the target stops being caller-scoped and snaps to the retention
   start: there is no surface down there to scope it to, and one canonical prefix means every deep
   caller converges on the same range, so it is fetched once and never re-requested in slices.
4. **The extra years are ordinary canonical history.** They are persisted as `DailyPrice`, recorded
   in `DAILY_PRICE_VARIANT` coverage, and they participate in `DailyDerivedState` — which is the
   point, since a recursive EMA and a 200-week average are only correct if they were computed from
   them. They are cut off exactly once, at `projectionRange`, so no product surface can return one.
5. **Fundamentals retention does not compound.** `fundamentalsTarget` stays
   `productHistoryYears + VALUATION_FUNDAMENTALS_WARMUP_YEARS` (30 + 7), and the dataset variant
   stays `h30:w7`. The two warm-ups answer different questions — one makes a recursive price series
   valid on the first visible day, the other makes a TTM window and its growth endpoints
   point-in-time eligible on it — and adding them would make statement retention 41 years and
   re-download every filing for a policy change that never touched one.
6. **Benchmarks are unchanged.** A `Benchmark` carries no derived series (`AGENTS.md` invariant
   13); its history is the run's execution calendar and the comparison line, both of which live
   inside the backtestable period. It stays on the product horizon.
7. **`PRICE_DATASET_VERSION` is not bumped.** A revision bump means "what a persisted bar means has
   changed", and it makes every existing coverage interval invisible. Here the bars are identical
   and the durable coverage is exactly what makes the upgrade cheap. Bumping it would discard
   reusable PostgreSQL coverage and force a full provider reload for a retention-policy change.
8. **The cache manifest records both horizons.** `StockManifest` carries `productHistoryYears` and
   `priceRetentionYears`, and `isCurrent` compares both. A READY manifest written under the old,
   narrower policy is therefore stale and cannot report that the wider one is satisfied. Redis is
   disposable, so that costs a rebuild from PostgreSQL and no provider traffic for dates already
   covered.

## Upgrade path

An installation that already holds thirty years does not reload. The first read that reaches the
product boundary widens its load target to the retention boundary; `getDatasetCoverage` reports the
existing interval; `missingCoverageRanges` yields exactly the missing prefix, and only that is
requested. With `now = 2026-09-09` and an existing `1996-09-09 → 2026-09-09`, the one historical
request is `1992-09-09 → 1996-09-08`.

The inserted prefix precedes the earliest previously known row, so `recalculationStart` returns the
start of the target and the derived state is rebuilt across the whole history rather than patched
in front of it — which is required, because an EMA and a Wilder RSI are recurrences and every value
after the prefix changes. The affected Redis yearly chunks are republished from PostgreSQL after
the write.

## Consequences

- A maximum-length backtest on a long-listed security now has `SMA(200, 1W)` / `EMA(200, 1W)`,
  `EMA(200, 1D)` and RSI on its first eligible day.
- A cold long-listed security costs roughly four more years of daily rows when — and only when — a
  caller actually reaches the product boundary. A one-year Stock Details view is unaffected: its
  load target never approaches the boundary, so the clamp never applies.
- Deploying the change makes every resident READY manifest stale once. Each stock rebuilds its
  Redis projection from PostgreSQL on next access; no fundamentals, no covered price interval and
  no derived row is refetched.
- A security listed inside the retention window clamps to its listing date. There is no artificial
  warm-up and no false coverage before a company existed.

## Rejected

- **`STOCK_HISTORY_YEARS = 34`.** It would widen Stock Details, the price and technical APIs, the
  backtestable period and — through `fundamentalsTarget` — statement retention to 41 years. The
  product decision is that 30 years is what the product offers.
- **A separate `PRICE_RETENTION_YEARS` environment variable.** Two independent numbers can be
  configured into disagreement, and the failure mode is silent: a retention horizon shorter than
  the warm-up puts the null values straight back.
- **Bumping `PRICE_DATASET_VERSION`.** See decision 7.
- **Publishing only the visible years to Redis.** The warm-up chunks cost roughly 13% more memory
  and keep the cached projection a plain image of the load target. Diverging the two would add a
  second range rule to every publish path for a saving the resident-stock cap already bounds.
