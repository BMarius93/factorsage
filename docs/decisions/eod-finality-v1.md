# End-of-Day Finality V1

## Status

**Accepted and implemented** (Monitor EOD V2, PR 1 — `feat/eod-finality`).

This is the first implementation step of the owner's 2026-10-14 requirement that FactorSage price
everything from **verified, finalized end-of-day bars** (`docs/decisions/monitor-eod-v2-proposal.md`
§9, `docs/audits/monitor-eod-v2-intraday-inventory.md`). It closes the *provisional EOD bar* leak for
every consumer of stored prices. The other leak — the Monitor's live `batch-quote` observations — was
left to later pull requests of the same plan: the Monitor EOD evaluation replaced it, and PR 8 deleted
the quote path (`docs/decisions/monitor-eod-v2.md` §3, §8).

## Problem

The provider's `historical-price-eod/full` endpoint lists the current session while it is still
trading, as an in-progress bar (verified live, `ai/architecture/deep-discovery.md` §3). The loaders
asked it for ranges ending at the **UTC day** and re-read a stock's tail on a **six-hour timer**
(`STOCK_RECENT_PRICE_FRESHNESS_MS`), so:

- a read during a session stored the in-progress bar as a `DailyPrice` row, with derived columns
  computed from it, and every consumer — Stock Details, technicals, valuation ratios, intrinsic
  values, Strategy frames, backtests — read it as the newest close until a later refresh replaced it;
- a refresh at 16:10 New York stored a bar the provider had not finalized, and the timer did not
  re-read it for six hours;
- a backtest submitted during a session could simulate today from that bar, immutably.

The endpoint's name proves nothing; the time a bar was read does.

## Decision

### 1. One finality clock

A session's bar is **final** at its 16:00 New York close plus `MARKET_DATA_EOD_PUBLICATION_DELAY_MS`
(30 minutes) — the convention the ETF refresh already used (`docs/decisions/etf-market-data-v1.md`
§7). `eodSessionFinalizedAt` and `eodCutoffDate` in `@intrinsic/domain` are the one implementation.
The **EOD cutoff** is the newest calendar date whose bar is final at a given instant: before 16:30
New York it is yesterday, afterwards today. It is DST-exact and calendar-agnostic — a Saturday
evening's cutoff is that Saturday, which simply holds no bar.

`getEodFinalityConfig()` reads the delay from the key the ETF refresh introduced, so the stock
loader, the benchmark loader, the market-data refresh and every later EOD consumer cannot disagree.

### 2. Nothing provisional is requested or stored

Every load target, provider request, coverage interval, retention horizon and product bound in
`CanonicalStockDataService` and `CanonicalBenchmarkDataService` ends at the EOD cutoff instead of the
UTC day (their `today()`). A row the provider returns outside the range it was asked for is dropped
(`withinRequestedRange`) rather than trusted, and the synchronization watermark records the instant
the read was **issued**, never the moment it was saved. So a row for a date is only ever written by a
read that began after that date's bar became final.

### 3. Freshness is a session question

The six-hour price timer is gone, and `STOCK_RECENT_PRICE_FRESHNESS_MS` with it. A recent tail is
re-read exactly when the durable record does not prove the **newest finalized session** on the
security's venue was read after it became final (`decideEodTailRefresh`, `EodFinalityPolicy`):

| Durable record | Decision |
| --- | --- |
| no leading-edge read ever | refresh |
| session bar stored, last read before it became final | refresh — this also re-reads a bar an older loader stored provisionally |
| last read predates the session | refresh |
| session bar stored, read after it became final | nothing |
| read after final, bar still missing | ask again on a widening spacing: at least `MARKET_DATA_SERIES_RETRY_MS` (30 min), and at least the time already passed since finalization |
| still missing `EOD_SESSION_GIVE_UP_MS` (24 h) after finalization | nothing: the security is taken not to have traded the session (a halt, a delisting) |

The venue's holiday schedule (`CachedTradingCalendar`, through the gated provider) decides which
weekday is a session. Without one — the live-FMP run composes none on purpose — every weekday is a
session: a holiday can then look like a missing bar, a bounded and retried request, but a missing
session can never look present. Statement freshness is unchanged (`STOCK_FUNDAMENTALS_FRESHNESS_MS`).

### 4. Stock EOD readiness interfaces

- `stockRefreshState(security)` — provider-free and Redis-free: the newest stored bar, when the newest
  leading-edge read was issued and the date it reached, `verifiedThrough` (the newest date proven
  final), `latestVerifiedBar`, `derivedThrough` and the price-basis generation. The stock counterpart
  of `benchmarkRefreshState`.
- `refreshStockTail(security, { expectedSession, from, fundamentals?, operands? })` — prepares one
  stock for one session through the canonical hydration path and reports `READY`,
  `AWAITING_PUBLICATION`, `NOT_PUBLISHED` or `FROZEN` from what PostgreSQL then proves. Statements
  are left alone unless asked for. The stock EOD preparation child (PR 2) is its consumer.

### 5. Backtests never simulate an unfinished session

A submission whose `endDate` is after the newest finalized date is ended there
(`parseCreateBacktestRunRequest`), and the immutable snapshot records the date it really ends on. A
period that would be empty once today is removed is refused with the newest completed session in the
message. "In the future" is judged in New York time. Completed runs are untouched.

### 6. Deterministic environments

`EOD_TAIL_REFRESH=frozen` never re-reads a stored tail — for the hermetic E2E stack, the QA matrix
and the data-correctness audit, whose stored data is the dataset. It replaces their long
`STOCK_RECENT_PRICE_FRESHNESS_MS` pins. Reads are still bounded at the cutoff. Production never sets
it. Seeds and fixtures write through the cutoff (`apps/api/src/eod-today.ts`), never past it.

## Consequences

- Before 16:30 New York, every surface's newest price is the previous completed session, and says
  so: Stock Details' "At close · *date* · End-of-day data" is now true by construction.
- Provider traffic falls: a stock's tail is read once per session (plus the earliest-rows check a read
  that adds a row makes, `historical-price-basis-v1.md` §7), not every six hours. A missing session
  costs at most about six spaced reads.
- **A completed week's weekly values appear on its last session's row once the cutoff enters the next
  ISO week** — Monday 16:30 New York instead of UTC midnight. `aggregateCompletedWeeks` is unchanged:
  it deliberately waits for a later week to prove the week over, and that rule is pinned by the
  calculated-series tests. Every row converges to the same values; only the moment Friday's row
  gains its week moves. Whether a week should complete on its Friday's finalization instead is a
  methodology question for the owner, recorded here rather than changed in passing.
- Tests that pinned clocks at UTC noon to mean "today" now pin an evening instant, after the day's
  finalization.

## Limitations

- **Corrections older than the ten-day tail** are still unseen until a `PRICE_DATASET_VERSION` bump,
  exactly as before (`deep-discovery.md` §6). A session is read once after it finalizes; a
  correction the provider makes later is picked up by the next session's tail read.
- **A provisional row stored before AUD-04's re-read rule**, outside every later tail window, cannot
  be identified from the watermark. Only the newest stored row of each security can still be
  provisional from before this decision, and the session rule re-reads it.
- **Early closes** finalize at the regular 16:30, not earlier: late, never wrong.
- **Frozen tails** expose whatever the frozen dataset holds; they are for deterministic environments
  only.
- **The Monitor's live quote observation** was unchanged by this decision. It was the inventory's
  remaining leak; the Monitor's EOD session evaluation replaced it and Monitor EOD V2 PR 8 removed
  it (`docs/decisions/monitor-eod-v2.md` §8).

## Inventory status (`docs/audits/monitor-eod-v2-intraday-inventory.md`)

| Path | Status after this decision |
| --- | --- |
| `historical-price-eod/full` provisional bar (stocks, benchmarks) | **Closed**: never requested, never stored; legacy rows re-read before any product read |
| Canonical price, derived, technical, fundamental, valuation, intrinsic reads | **Closed**: bounded at the EOD cutoff, behind session freshness |
| Stock Details API and header | **Closed**: newest bar is the newest finalized session |
| Backtests ending today | **Closed**: period ended at the newest finalized session at submission |
| Market overview / ETF conditions | Verified: already finalized-and-synchronized; now also bounded at the cutoff |
| Monitor quotes (`batch-quote`, `getCurrentObservations`, provisional frame) | **Closed**: replaced by the EOD evaluator (PR 3) and deleted (PR 8, `monitor-eod-v2.md` §8) |
