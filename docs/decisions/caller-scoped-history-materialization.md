# Caller-Scoped History Materialization

## Status

**Accepted.**

Supersedes one rule of `stock-data-loader-implementation.md`: the line _"Requested ranges are read
projections, not hydration boundaries"_ and step 2 of its canonical-hydration sequence, _"Compute
the canonical horizon independently of the caller's requested range."_ Everything else in that
document — the lock protocol, coverage compaction, empty-interval durability, freshness, weekly
rules, point-in-time reads, manifest generations and LRU residency — stands unchanged.

`ai/architecture/system-overview.md` and `ai/architecture/api-worker.md` describe the resulting
flow. `ai/product/stock-details.md` describes the product surface that motivated it.

## Context

`ensureStockHydrated` computed its target as `STOCK_HISTORY_YEARS` (30) back from today, clipped by
the listing date, whatever the caller had asked for. That was deliberate: one canonical state per
security is simpler to reason about than a per-caller one, and coverage bookkeeping already made
repeat loads cheap.

The cost only became visible on the product surface. Opening Stock Details on its one-year default
window made a cold security download, calculate, persist and publish its entire retained history —
for a stock listed in 2006, roughly five thousand daily price rows and as many derived rows, plus
every yearly Redis chunk, before the page could draw twelve months. Nothing in the request asked
for that, nothing on the page displayed it, and the user waited for all of it. The loader was
serving the backtest's appetite to every page view.

## Decision

**The caller's requested range decides what is materialized. The configured horizon is the outer
bound that range is clamped to, never a floor a read falls back to.**

1. **Every read passes a load target.** `getStockDetails`, `getDailyPrices`,
   `getDailyDerivedState`, `getFinancialStatements`, `getIntrinsicValues` and
   `getIntrinsicValueBlends` each translate their own bounded range into a target and pass it to
   `ensureStockHydrated` / `ensureStockFresh`. There is no parameterless hydration entry point
   left to fall back to a horizon.
2. **A load target is `[requested.from - derived warm-up, today]`, clamped to the horizon.** The
   upper bound stays today because a resident stock is only usable while its tail is current:
   freshness, the recent-tail refresh and the manifest all key off it, and holding a stale tail
   saves nothing.
3. **The warm-up is derived from the canonical registries, not chosen.**
   `DERIVED_SERIES_WARMUP_DAYS` in `packages/stock-data/src/service.ts` takes the longest lookback
   across `DAILY_MOVING_AVERAGES`, `DAILY_OSCILLATORS` and `WEEKLY_MOVING_AVERAGES`, expresses both
   timeframes in weeks, and adds a small margin for the partial start week and holiday-shortened
   weeks. Today that is `SMA(200, 1W)` / `EMA(200, 1W)` at two hundred completed weeks. A series
   with a longer lookback widens the warm-up by being added to its registry, and nothing else.
4. **Readiness is per range.** The cache manifest already carried `coverageStart`; it is now part
   of the readiness question. A stock materialized for one year is ready for that year and not
   ready for twenty, which is what makes the wider request load the missing prefix instead of
   silently reading short. How current the _tail_ is remains a freshness question, so a day
   rollover still takes the cheap recent-tail path rather than re-entering cold hydration.
   `coverageStart` is a trustworthy readiness input only because, under `PRICE_DATASET_VERSION` 2,
   every provider request behind it was complete; a manifest from an earlier version is stale
   however far back it claims to reach (`complete-price-coverage.md`).
5. **Widening is incremental and never narrows.** A hydration or refresh maintains the union of
   what this caller needs and what is already resident, so a backtest's twenty years survive the
   next page view, and repairing a cache miss rebuilds the range the invalidated manifest held.
6. **Backtests are unaffected in capability.** A caller that names decades still gets decades, in
   one provider delta, because it asked. What changed is that this is now something a caller asks
   for rather than something the loader assumes.
7. **Fundamentals retention is unchanged.** `VALUATION_FUNDAMENTALS_WARMUP_YEARS` and the
   `h30:w7` dataset variants stay as they are: statement backfill is a bounded number of
   limit-capped provider calls, not a per-year download, and narrowing it would change
   point-in-time eligibility.

## Consequences

- Opening Stock Details on a cold security materializes roughly five years instead of twenty to
  thirty. Verified against the live stack: `KO` hydrated 1,253 daily rows for a one-year request
  where `AAPL`, hydrated under the previous rule by the same page, holds 5,004.
- Every catalog series is still warmed up on the first visible trading day. This is the property
  the warm-up exists for and the one that must fail loudly if it is ever trimmed:
  `packages/stock-data/src/service.test.ts` asserts every `TECHNICAL_SERIES_FIELDS` entry is
  present on the first day of the requested window.
- A user who walks 1Y → 5Y → MAX now causes two additional provider deltas rather than one large
  one. Each is bounded by what was asked for, and the already-loaded history stays on screen while
  the next one arrives.
- One canonical state per security still holds. The manifest describes how much of it is resident,
  not a second, per-caller copy of it.

## Rejected

- **Honouring the requested `to` as well as `from`.** A manifest whose `coverageEnd` lagged today
  would make every other caller read a stale tail, and the freshness machinery would have to grow a
  second notion of currency. The history prefix was the expensive half; the tail is one bounded
  recent-tail request.
- **Keeping the horizon and hiding the excess in the frontend.** The rows were still downloaded,
  calculated, persisted and published. Only the page was cheap.
- **A per-caller cache namespace.** Two materialized histories for one security reintroduces the
  divergence the single canonical state exists to prevent.
