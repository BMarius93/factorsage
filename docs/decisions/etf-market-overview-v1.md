# ETF Market Overview V1

## Status

**Accepted for PR 2 — the Dashboard's market overview.** It builds on PR 1,
`docs/decisions/etf-market-data-v1.md`, which stored the twenty ETF histories in PostgreSQL, kept
them fully resident in Redis and refreshes them from the worker. This decision replaces the
`GET /market-overview` contract and the Dashboard's three market-reference cards (S&P 500, DJIA,
VIX) with an overview of those twenty funds.

Out of scope, and left for PR 3: removing the market-reference index series (`SP500_INDEX`,
`DJIA_INDEX`, `VIX_INDEX`) — their catalog rows, stored bars, Redis keys and QA seeds stay exactly as
they are. This PR only stops the Dashboard from showing them.

## Context

The Dashboard opened with five cards: Run Backtest, three index levels and the current match count.
Three closes and a seven-session line said very little — nothing about sectors, commodities or bonds,
and nothing about anything longer than a week. PR 1 made twenty ETF histories available without a
provider call. The question the Dashboard should now answer at a glance:

- How are the major US market segments performing?
- Which sectors are gaining or losing?
- How are gold, oil and bonds performing?
- How do short-, medium- and long-term returns differ?

## Decision

### 1. The universe and its order

`MARKET_OVERVIEW_ETF_GROUPS` (`@intrinsic/domain`) is the one list: Benchmarks (SPY, QQQ, DIA, IWM,
RSP), Sector Performance (XLK, XLF, XLE, XLV, XLI, XLY, XLP, XLU, XLB, XLRE, XLC), Macro &
Alternatives (GLD, USO, TLT, HYG). The response follows it exactly; no web array repeats it. Each
group gained a `shortLabel` (`Benchmarks`, `Sectors`, `Macro`) for the phone category selector. `SPY`
is read from the `SP500` series, never stored twice. `USO`'s note — near-month WTI futures, not spot
crude — travels in the contract and is shown beside it.

### 2. The contract

`GET /market-overview` keeps its path, its absence of any session and its exemption from the legal
gate. Its body is replaced (`MarketOverviewResponse` in `@intrinsic/contracts`):

```jsonc
{
  "generatedAt": "2026-10-10T18:30:00.000Z", // when the summary was computed
  "basis": "END_OF_DAY",
  "returnBasis": "PRICE_RETURN",
  "status": "AVAILABLE", // | PARTIAL | UNAVAILABLE
  "asOf": "2026-10-09", // the reference session
  "groups": [
    {
      "id": "US_SECTORS",
      "label": "Sector Performance",
      "shortLabel": "Sectors",
      "instruments": [
        {
          "ticker": "XLK",
          "name": "Technology",
          "status": "AVAILABLE", // | STALE | UNAVAILABLE
          "sessionDate": "2026-10-09",
          "returns": {
            "1W": 0.48,
            "1M": 2.32,
            "3M": 7.31,
            "6M": 15.07,
            "YTD": 23.47,
            "1Y": 32.18,
          },
          "sparkline": {
            "startDate": "2025-10-09",
            "endDate": "2026-10-09",
            "values": [100, 101.2],
          },
        },
      ],
    },
  ],
}
```

- **The ticker is a display field.** It is what a reader recognises; the benchmark code, series id
  and provider symbol behind it never cross the contract.
- **No price.** A fund's share price is not an index level, so the contract carries returns and a
  line rebased to 100, and nothing a page could mistake for `S&P 500 = 7,637`.
- **`null` is not zero.** A return the history cannot support is `null`; zero would claim the fund
  did not move.
- **Unrounded returns.** Rounding is the display's decision (one decimal in the grid, two in the
  accessible description).
- The response is about 14 KB uncompressed for twenty funds.

### 3. The arithmetic

One pure module, `apps/api/src/market/market-overview.ts`, tested without a database, cache or clock.

- **Price return:** `returnPct = (latestClose / anchorClose − 1) × 100` on the provider's
  split-adjusted close, distributions excluded. The Dashboard footnote says so.
- **Anchors**, from the fund's latest completed session: `1W` 7 calendar days; `1M`, `3M`, `6M`
  calendar months with the day clamped to the target month's end (`subtractMonths` in
  `@intrinsic/contracts`); `YTD` the last day of the previous calendar year; `1Y` one calendar year
  with 29 February clamped to 28 February (`subtractYears`).
- **The anchor session** is the most recent stored session on or before the anchor date — never a
  later one. A history that starts after the anchor yields `null`. When coverage has a gap between
  that session and the anchor, a later session might exist that was never stored, so the return is
  `null` rather than measured from an older close. Weekends and holidays need no calendar: they hold
  no bar, and coverage says the days were asked.
- **Completed sessions only.** The provider lists the current session while it trades, so a bar
  counts only after its 16:00 New York close plus `MARKET_DATA_EOD_PUBLICATION_DELAY_MS` (the
  refresh worker's own convention), and only if the series' recent tail was read after that instant
  (`lastTailSyncAt`, PostgreSQL's durable watermark). A bar read mid-session stays provisional until
  a later read replaces it; the session before it is reported meanwhile.
- **The reference session** (`asOf`) is the newest completed session any fund reached — derived
  from the data, because the exchange calendar is fetched from the provider and the overview may not
  ask it. A fund behind it is `STALE` and keeps its own `sessionDate`, to which its returns are
  measured. A fund with no completed session is `UNAVAILABLE`.
- **The trend line** samples the session on or before each of the last 52 weekly steps back from
  the latest session, prepends the `1Y` anchor session, and rebases to 100: 53 points whose
  first-to-last change is the `1Y` return. A shorter history starts at its first session; fewer than
  two points draw nothing.

### 4. Where the numbers come from

`MarketService` reads through `MarketOverviewDataPort` — `listBenchmarks`, `readBenchmarkHistory`
(the `BenchmarkHistoryReader` of PR 1) and `benchmarkRefreshState` — and nothing else. **It never
asks the provider**: the hydration methods are not in the port, a unit test fails if any of them is
touched, and the integration test replaces the provider with a spy that fails on any call. A series
that was never bootstrapped is reported unavailable, not fetched.

Each read is bounded: one year plus 45 days to today, from the resident Redis projection (one `GET`
and one `MGET`), rebuilt from PostgreSQL once if Redis lost it, PostgreSQL if Redis cannot answer.
Twenty series are read four at a time. One computation therefore costs one catalog query, twenty bounded
Redis reads and, per series, the three small indexed PostgreSQL reads of `benchmarkRefreshState`
(coverage, latest bar, tail watermark) — **61 PostgreSQL round trips**, measured, at most once a minute
per API process however many visitors ask. A Redis loss costs one rebuild computation of about 200
(PR 1's residency check and publication snapshot), then the warm count again. Only the watermark of
the three is used; a narrower watermark read would save 40 indexed lookups a minute per process,
which is not material at that rate and would widen PR 1's reader interface, so it is not added.

One unreadable series costs its own row: the failure is logged with the original error
(`market.overview.instrument.failed`, with `lastSuccessfulReadAgeMs`) and the row is unavailable — or,
while **that instrument's own last successful read** is younger than the 15-minute staleness bound,
keeps that read's answer, dated by its own session. The bound is measured from when the read ran,
never from a summary that carried the answer forward, so a series that keeps failing is served its
last good answer for at most 15 minutes and then reported unavailable until a read succeeds again
(`MarketService.lastSuccessful`, process memory, twenty entries).

### 5. Serving it to many visitors

The summary is identical for everybody, so it is computed once per process and served to all
(`SnapshotCache`):

- **single flight** — concurrent requests share one computation;
- **60-second TTL** — at most one read of twenty series per minute per API process;
- **stale while revalidating** — between 60 seconds and 15 minutes the previous summary is served at
  once while one background computation replaces it;
- **bounded** — nothing older than 15 minutes is served; a computation that throws then fails the
  request (`500`) rather than presenting an old summary as current. A summary that carries a kept
  answer stops being servable when that answer's read reaches 15 minutes, even inside its TTL
  (`servableUntil`), so the two bounds never stack. `SnapshotCache` passes nothing from one summary
  to the next computation: anything copied forward would be re-stamped as new.

Process memory, not Redis: the summary is a projection of the Redis projection, carries nothing
user-owned, and a shared copy would need its own invalidation and a namespace invariant 16 does not
allow. `Cache-Control: private, max-age=60` — the body is everybody's, but the response carries the
caller's own rate-limit headers, which a shared cache must not hand to someone else. The route moved
from `stock-read` to `standard-read`: it no longer hydrates anything.

### 6. The Dashboard

Order: a compact strip (Run Backtest, Current matches), the market overview, then Current matches —
unchanged in every behaviour. The three index cards and the VIX gauge are removed from the web app.

- **≥ 1,280px** — three group cards side by side. Each row has two lines: ticker, name and a 96×20
  trend line; then the six returns under the group's period headings, which double as sort buttons
  (strongest first; a second click restores the catalog order). Nothing fills the space under the two
  shorter groups.
- **880–1,279px** — Benchmarks beside Macro & Alternatives, Sector Performance across both below
  them with its rows in two columns.
- **< 880px** — a category selector (`Benchmarks / Sectors / Macro`, a choice of group, never of
  period) and a native sort select; one card per fund with a full-width trend line and the six
  returns as a labelled 3 × 2 grid. No horizontal scrolling.
- **States** — a skeleton with the final layout's geometry (no shift on desktop), a clean unavailable
  panel when nothing has data, an error panel with retry, a `STALE` pill with the fund's own date, a
  `No data` pill, `—` for an unavailable return (announced as "not available"), `0.0%` for zero.
- Signed returns use `+` and a true minus sign (U+2212), tabular figures and the financial-state
  tokens; the trend line's colour follows the `1Y` return and it is announced in words.

## Alternatives rejected

- **A period selector.** It would hide five of the six answers the overview exists to compare.
- **Eight-column rows.** Too wide for three groups side by side at 1,280px; the two-line row keeps
  every value at body size.
- **Sending histories to the browser** for client-side returns or charts — larger, and it would put
  canonical arithmetic in React.
- **A Redis summary cache or a dashboard namespace** — a third copy of the same data, forbidden by
  invariant 16.
- **Using the trading calendar for the reference session** — it is fetched from the provider.
- **Hydrating a missing series on a Dashboard read** — the bootstrap and the refresh worker own
  provider reads.

## Deployment

The web app and the API change the contract together: a new web build against an old API — or the
reverse — renders the market overview's error state (the Current matches section is unaffected).
Deploy API and web in the same release, or the API first and the web immediately after. Nothing in
the database changes. Before the production ETF bootstrap of PR 1 runs, the overview reports every
fund unavailable and renders its empty state.

## References

- `docs/decisions/etf-market-data-v1.md` — the storage, residency, refresh and reader of PR 1.
- `ai/architecture/benchmark-data.md` — the benchmark subsystem and the market overview.
- `docs/openapi.yaml` — `GET /market-overview`.
