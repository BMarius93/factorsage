# Complete Price Coverage

## Status

**Accepted.**

Supersedes decision 5 of `viewport-driven-stock-details-history.md` (_"Exhaustion is discovered
from data, not asserted from coverage"_) and the observation in its Context that read `AAPL`'s
1996 coverage against a 2006 first row as a legitimate state. Amends steps 4–5 of the canonical
hydration sequence in `stock-data-loader-implementation.md` and the empty-interval paragraph
beneath them, and qualifies decision 4 of `caller-scoped-history-materialization.md`. Everything
else in those documents — viewport-driven loading, the 30-year Stock Details limit and its
server-side clamp, the lock protocol, coverage compaction, freshness, weekly and point-in-time
rules, manifest generations and LRU residency — stands unchanged.

`ai/architecture/system-overview.md` and `ai/architecture/database.md` describe the resulting
mechanism, `ai/product/stock-details.md` the boundary the chart now navigates against, and
`ai/workflows/validation.md` the live assertion and the local diagnostic procedure.

## Context

### The provider caps a response at 5000 rows and says nothing

FMP's daily history endpoint,
`GET https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=AAPL&from=&to=`,
honours `from` and `to` but returns **at most 5000 rows per response**, newest first, and silently
drops everything older. There is no error, no pagination hint and no partial flag. Live probes on
2026-09-04 with the configured account:

- `from=1996-09-04&to=1997-09-04` → 254 rows, earliest 1996-09-04. The data exists.
- `from=2000-01-01&to=2001-01-01` → 252 rows; `from=2004-01-01&to=2005-01-01` → 252 rows. So
  does every year in between.
- `from=1996-08-31&to=2026-09-04` → **exactly 5000 rows, earliest 2006-10-18.**
- `from=2000-01-01&to=2026-09-04` → **exactly 5000 rows, earliest 2006-10-18.** The same cap on a
  different window: the earliest row is a function of the cap, not of what was asked.
- `from=1996-08-31&to=2006-10-11` → 2545 rows, earliest 1996-09-03. Asked for on its own, the
  "missing" decade is there.

### The loader recorded a capped answer as coverage

`CanonicalStockDataService.hydrateWithinLease` sent each missing coverage interval as **one**
`provider.getDailyPrices(symbol, id, delta)` call and recorded the whole interval as
`successfulCoverage`. Nothing between the adapter and the loader could tell a complete answer from
a capped one, so a delta wider than 5000 trading days persisted its newest 5000 rows and marked
the remainder — the oldest years — as "covered, no rows". Every later read subtracted that
coverage from its target and asked for nothing.

The state this produced, verified against the live stack:

- `AAPL`: `StockDatasetCoverage` says 1996 → today, the Redis manifest says
  `coverageStart: 1996-09-03`, and `DailyPrice` starts 2006-10-12. It was hydrated by the earlier
  horizon loader, which asked for all thirty years in one delta.
- `BRK-A` and `XOM`: the same coverage, with `DailyPrice` starting 2001-10-29. They were hydrated
  by the current caller-scoped loader: the one-year page view materialized about five years, and a
  later wide ask sent the prefix `1996-09-04 → 2021-09-08` as one delta — 5000 rows starting
  2001-10-29, coverage recorded from 1996.
- `KO`: complete. It had only ever been asked for its one-year window plus warm-up (1,253 rows),
  and no single delta in its history exceeded the cap. Its correctness was a property of the size
  of the requests it happened to receive, not of the rule.
- A fresh `AAPL` diagnostic (that one security's loader-owned rows and Redis keys removed, then
  the page opened and widened) reproduced the `BRK-A`/`XOM` shape exactly: the 1Y window → 1,252
  rows; the prefix ask `1996-09-04 → 2021-09-08` → 5000 rows starting 2001-10-29; coverage
  recorded from 1996.

### The chart turned the hole into a listing date

`useStockHistory` treated an empty `/prices` window as the security's first trading day
(`prices.length === 0 ⇒ exhausted`) and pinned the chart there — for `AAPL`, at 2006, ten years
short of what the provider has and what the product limit permits.
`viewport-driven-stock-details-history.md` read that state as legitimate ("coverage is a record of
what was asked for, not a promise that rows exist") and built its boundary rule on it. The premise
was a defect: coverage had been recorded for intervals that were never completely asked for, and a
client rule then converted the resulting hole into a fact about the security.

### Vocabulary

- **Requested range** — what a caller asked for: the Stock Details window, or a backtest's period.
- **Load target** — the requested range widened by the derived-series warm-up, clamped to the
  retention horizon and unioned with what is already resident
  (`caller-scoped-history-materialization.md`).
- **Coverage** — the `StockDatasetCoverage` intervals for `DAILY_PRICE` under the current variant:
  the dates the provider was asked for completely and whose returned rows are all persisted. The
  manifest's `coverageStart`/`coverageEnd` describe the range _resident in Redis_ — the load target
  of the last hydration, unioned with what a current manifest already held — which after an
  eviction or a narrow first read can be narrower than the durable intervals. Anything that must
  prove coverage, the `PROVIDER` boundary included, reads PostgreSQL.
- **Materialized history** — the `DailyPrice` rows that actually exist; the manifest's
  `canonicalHistoryStart`/`canonicalHistoryEnd`.
- **Boundary origin** — why `history.start` is where it is: `HORIZON`, `LISTING` or `PROVIDER`.

Coverage and materialized history may legitimately differ: a pre-listing interval, or a provider
whose history starts later than the horizon, is covered and empty. What must never differ is what
was asked for and what coverage claims was asked for.

## Decision

**A coverage interval means the provider was asked for every date in it with complete requests and
every returned row is persisted. Completeness is the adapter's job, the meaning is revisioned, and
a boundary is reported by the API — never inferred by a client from an empty window.**

1. **The adapter fulfils the port contract completely.**
   `FmpClient.getDailyPrices(symbol, securityId, range)` requests `[from, to]`; while the page is
   full — `rows.length >= FMP_EOD_MAX_ROWS_PER_RESPONSE` — and its earliest row is later than
   `from`, it requests `[from, earliest - 1 day]` and continues; a short page ends the walk. Rows
   are deduplicated by date and returned ascending. `FMP_EOD_MAX_ROWS_PER_RESPONSE = 5000` lives in
   `packages/fmp/src/client.ts` and nowhere else: it is a provider fact, and provider knowledge
   belongs in `@intrinsic/fmp`. The port contract, `FmpStockProviderPort.getDailyPrices`, now
   promises every row the provider has inside the window. The live suite
   `packages/stock-data/src/live-fmp.integration.test.ts` asserts that a 30-year `AAPL` read
   paginates past the cap and reaches its requested start, so a provider that lowers the cap fails
   there rather than silently shortening every long history again.
2. **Coverage is recorded only for what was completely asked.** `hydrateWithinLease` still sends
   one delta per missing interval and still records that interval as `successfulCoverage`; what
   changed is that one delta is now one complete answer. An interval that comes back empty is
   durable coverage — "nothing there; asking again is pointless" — which is what stops the
   loader re-requesting a pre-listing prefix on every read. It is **never** an inference about the
   security's listing date: no `ipoDate`, no listing bound and no chart boundary is derived from an
   empty interval. The listing date comes from the provider's profile; a provider boundary comes
   only from rule 4.
3. **What coverage means is revisioned, exactly like the derived state.** `PRICE_DATASET_VERSION`
   (`packages/stock-data/src/ports.ts`, previously in `cache.ts`) moves from **1 to 2**. One
   constant drives both stores: the Redis manifest field `priceDatasetVersion`, which `isCurrent`
   already compares, so every v1 manifest is stale regardless of how much it claims to cover; and
   the durable `DAILY_PRICE` coverage and dataset-state variant, `DAILY_PRICE_VARIANT`, now
   `split-adjusted-eod-full:v2` and derived from the version, so rows written under the v1 variant
   `split-adjusted-eod-full` are never read by the v2 loader. Self-healing needs no manual step.
   On next access the stale manifest fails `isCurrent`, the caller enters hydration under the
   stock lock, finds no v2 coverage for its target, asks the provider for the whole target
   (paginated, complete), upserts the rows — days already persisted are matched by their primary
   key, the missing prefix appears — and records v2 coverage. Because the earliest changed date
   precedes the previous earliest row, the derived state is rebuilt from the canonical origin and
   the yearly chunks are republished. The **whole caller target** is re-verified, not just the
   prefix below the earliest persisted row, because v1 coverage cannot be trusted anywhere: where a
   v1 delta was truncated depends on which deltas produced it (`AAPL` lost 1996–2006, `BRK-A`
   1996–2001) and nothing durable records that history. The cost is one complete provider read of
   the target per stock, once — for a 30-year ask two pages, 5000 and roughly 2550 rows, and one
   derived rebuild from origin: the same work as a cold load of that target. A security that is
   never accessed again is never re-verified. When the current variant is recorded, superseded
   `DAILY_PRICE` coverage and dataset-state variants are deleted in the same transaction, so the
   coverage table never carries two generations for a stock. The freshness watermark
   `split-adjusted-eod-full:recent-tail` is a tail watermark, not coverage: it is unchanged and is
   not removed. This is the mechanism `DERIVED_STATE_REVISION` already uses for
   `DailyDerivedState` (`ai/architecture/calculated-series.md`, "Revision and lazy rebuild"):
   global, lazy, no data migration. **Any future change to what a coverage interval means bumps
   `PRICE_DATASET_VERSION`.**
4. **Stock Details reports an explicit boundary; the client stops only there.**
   `history.startOrigin` is `HORIZON`, `LISTING` or `PROVIDER`. `HORIZON` and `LISTING` are as
   before: the 30-year limit, or the listing date when that is later. `getStockDetails` reports
   `PROVIDER` when durable v2 coverage is complete from that horizon-or-listing bound to the day
   before the earliest persisted `DailyPrice` row — the store answers
   `getEarliestDailyPriceDate(securityId)` — meaning the provider was asked completely and has
   nothing older; `history.start` is then that earliest row. One qualification: the permitted
   start is a calendar date, and the first trading day at or after it can trail it by a weekend
   and a holiday without that saying anything about the provider. A verified-empty gap of at most
   `PROVIDER_BOUNDARY_MIN_GAP_DAYS` (seven calendar days, `service.ts`) is therefore still
   reported as `HORIZON` or `LISTING`; only a longer one — which no market closure produces — is
   reported as `PROVIDER`. Exhaustion is unaffected either way: the chart pins at the first bar it
   holds. Until a boundary is provable the wider bound is reported and the client keeps asking. The controller clamp in
   `apps/api/src/stocks/stock-details-history.ts` stays horizon-only: it bounds requests, it does
   not answer where history begins. `useStockHistory` sets `exhausted` only when the requested
   start reaches `history.start` (`from <= historyStart`), never because a window came back empty.
   An empty window still advances `loadedFrom`, so it is not asked for again, and the next gesture
   asks for the next older window, until the boundary.
5. **No local historical reset is required.** Correctness comes from the revision; every
   environment heals per stock on next access. For diagnostics a developer may remove one
   security's loader-owned data and let the loader rebuild it: its `DailyPrice`,
   `DailyDerivedState` and `WeeklyPrice` rows; its `StockDatasetCoverage` and `StockDatasetState`
   rows for `DAILY_PRICE`, `WEEKLY_PRICE` and `DAILY_DERIVED_STATE`; its
   `stock-data:v2:security:<id>:*` Redis keys, its `stock-data:v2:symbol:<symbol>:security`
   mapping and its entry in `stock-data:v2:resident-stocks`. Nothing else: never users,
   authentication, lists, or the `Security` row itself — list memberships reference it, and its
   identity is what the loader keys everything on. Fundamentals keep their own coverage and are
   not part of the procedure. Never flush Redis or drop tables to get there.
6. **The Stock Details limit and backtest ranges stay separate.** `STOCK_DETAILS_MAX_HISTORY_YEARS`
   bounds the Stock Details surface at the controller. A backtest names its own range through
   `StockDataService` and is unaffected by the viewport, the clamp and `history.start`; nothing
   couples them. The fix benefits it all the same: a 30-year ask is now complete, where before it
   was silently the newest 5000 trading days.

## Consequences

- `AAPL`, `BRK-A`, `XOM` and every other security hydrated under v1 re-verify their target on next
  access and gain the years they were missing; the chart reaches 1996 for `AAPL` instead of pinning
  at 2006. No operator action, no migration, no flush.
- Under v2 a `PROVIDER` boundary is exact: a row exists on `history.start` and complete coverage
  proves nothing older. `QATEST1`'s boundary is `PROVIDER`: its seed writes coverage for the whole
  horizon while its synthetic rows span 160 weeks.
- Pagination is invisible above the adapter: one delta is still one `getDailyPrices` call, coverage
  bookkeeping and the lock protocol are untouched, and the recent-tail refresh, a bounded window
  far below the cap, never pages.
- A capped page can no longer pass for an empty one at any layer: the adapter completes it, the
  loader records only complete asks, the API reports only proven boundaries, and the web app stops
  only at a reported one.
- Two revisions now exist side by side and must not be conflated: `PRICE_DATASET_VERSION` for
  what price coverage means, `DERIVED_STATE_REVISION` for the derived methodology. Either bump is
  global and lazy.

## Rejected

- **Chunking deltas in the loader instead of paginating in the adapter.** Splitting a wide delta
  into sub-5000-row pieces in `@intrinsic/stock-data` would have fixed the symptom while leaving
  the port contract false for every other caller, and it is redundant once the adapter is
  complete. The cap is a property of one provider endpoint; that knowledge belongs in
  `@intrinsic/fmp`, behind a port that promises the whole window.
- **Heuristically repairing v1 coverage from the earliest persisted row.** Trimming every v1
  interval to start at the first `DailyPrice` row assumes each truncation happened at exactly one
  place and that place is the earliest row — true only for a specific v1 request pattern, and
  `AAPL` and `BRK-A` already show two. A revision is deterministic, costs one bounded re-read per
  stock, and is the tool the repository already uses for exactly this class of change.
- **Reporting the manifest's `coverageStart` as a navigable boundary.** It is where asking began,
  and under v1 it was where a capped response began being misread. Even under v2 it is a bound on
  requests, not on rows; a provider whose history is shorter than the horizon would again hand the
  chart a blank region.
- **A data migration deleting v1 coverage.** Redis manifests have no migration path, and a SQL
  migration would have covered one store while the other kept serving stale bounds. The revision
  invalidates both uniformly and removes the superseded variants lazily, in the transaction that
  writes the replacement.
- **Keeping the "empty window ⇒ first trading day" rule.** It was the mechanism that turned a
  truncated response into a fake listing date, and it would do so again for the next provider
  quirk. Price history being contiguous from listing makes an empty window consistent with a
  boundary; it does not make it one. Only the API, reading complete coverage, can say so.
