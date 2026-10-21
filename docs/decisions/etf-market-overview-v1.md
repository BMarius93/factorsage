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

**Amended 2026-10-12 — the compact Dashboard composition (owner).** Section 6 is replaced: the
overview is now two columns of single-line, eight-column tables on a wide desktop and compact cards
on a phone, it names each fund by the market it tracks, and it prints no heading, subtitle,
methodology or footnote. Nothing stands above it either: the strip that opened the Dashboard — a
`Run Backtest` card and a Current matches count — is gone. The contract, the arithmetic, the data
path and the cache (sections 2 to 5) are unchanged; only the catalog's display labels moved
(section 1). Where an earlier sentence in this document said the Dashboard states something in a
footnote, it now states it in the contract only.

**Amended 2026-10-20 — Dashboard V2: Market watch (owner).** Monitor activity becomes the Dashboard's
primary content, and the twenty funds move out of the full-width tables above it into **Market
watch**, a compact sidebar beside it on a wide desktop only (section 6, rewritten). The sidebar shows
**one period at a time** — `1W | 1M | 3M | 6M | YTD | 1Y`, rotating every ten seconds — which
reverses the earlier rejection of a period selector (see _Alternatives rejected_). Because a period's
line must cover the same window as that period's return, the contract's single one-year `sparkline`
is replaced by **six period-specific lines**, `sparklines` (sections 2 and 3). The returns, their
arithmetic, the data path and the cache are unchanged; the lines are built from the same bounded
read, so a computation costs no additional database or Redis read.

**Amended 2026-10-21 — Dashboard V2 layout and UX (owner).** Section 6 is rewritten again. The two
cards become one page in two panes: Market watch is a fixed-width pane (330–360px) flush against the
right edge from just under the topbar to the bottom of the screen, divided from the feed by one
hairline, with every fund on one 26px line. Rotation is every **eight** seconds, staged as a fade of
the returns and lines with one soft highlight of the new period; there is **no Auto control** —
choosing any period stops rotation for the rest of the page's life, and pointing at or working in
the sidebar only pauses it. A reader who prefers reduced motion gets no rotation. The contract, the
arithmetic, the data path and the cache are unchanged.

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
is read from the `SP500` series, never stored twice.

Each fund's `label` — the response's `name` — is the **market** it tracks, never the fund's own
name: `S&P 500`, `Nasdaq-100`, `Dow Jones`, `Russell 2000`, `S&P 500 Equal Weight`, the eleven sector
names, `Gold`, `Oil Futures`, `Long-Term Treasuries`, `High-Yield Bonds`. The ticker is shown beside
it and is what says the row is a fund (`S&P 500 (SPY)`). `USO`'s note — near-month WTI futures, not
spot crude — still travels in the contract; the Dashboard no longer prints it, so the label itself
says `Futures`.

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
          "sparklines": {
            // One per period, keyed like `returns`; null wherever the return is null.
            "1W": {
              "startDate": "2026-10-02", // the 1W anchor session
              "endDate": "2026-10-09", // sessionDate
              "values": [100, 100.21, 99.87, 100.12, 100.3, 100.48],
            },
            "1M": {
              "startDate": "2026-09-09",
              "endDate": "2026-10-09",
              "values": [100 /* … */],
            },
            // "3M", "6M", "YTD", "1Y" likewise
          },
        },
      ],
    },
  ],
}
```

- **The ticker is a display field.** It is what a reader recognises; the benchmark code, series id
  and provider symbol behind it never cross the contract.
- **No price.** A fund's share price is not an index level, so the contract carries returns and
  lines rebased to 100, and nothing a page could mistake for `S&P 500 = 7,637`.
- **Every period's line travels with its return.** A surface that shows one period at a time
  switches the number and the line together from the one response, without another request.
- **`null` is not zero.** A return the history cannot support is `null`; zero would claim the fund
  did not move.
- **Unrounded returns.** Rounding is the display's decision (one decimal in the grid, two in the
  accessible description).
- The response is about 42 KB uncompressed (about 12 KB gzipped) for twenty funds: six lines of at
  most 48 points each per fund. It was about 14 KB with the single 53-point line.

### 3. The arithmetic

One pure module, `apps/api/src/market/market-overview.ts`, tested without a database, cache or clock.

- **Price return:** `returnPct = (latestClose / anchorClose − 1) × 100` on the provider's
  split-adjusted close, distributions excluded. The contract says so (`returnBasis: PRICE_RETURN`);
  the Dashboard does not repeat it.
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
- **The trend lines** (`buildPeriodSparkline`). Each period's line is every stored session from
  **that period's anchor session** — the very session its return is measured from — through the
  latest completed session, rebased to 100 at the anchor. Its first-to-last change is therefore the
  period's return (to the line's two decimals), and its direction can never contradict the number
  beside it. `YTD` starts on the previous year's last session, as its return does.
  - **Real sessions only.** Every point is a stored close in session order; a weekend or holiday is
    not a point, and nothing is interpolated.
  - **Daily where it matters.** A window of at most 48 sessions — every `1W` (about 6) and `1M`
    (about 22) window — is sent whole, one point per daily close; a weekly sample could not draw a
    week.
  - **Bounded beyond.** `3M`, `6M`, `YTD` and `1Y` windows (about 63 to 253 sessions) are thinned to
    48 sessions by Largest-Triangle-Three-Buckets (`thinSessions`): deterministic, it keeps the first
    and last session (the true period endpoints) and, from each of 46 equal runs between them, the
    session that best preserves the line's turns — selecting stored closes, never averaging them.
  - **Null with its return**, and **null across a gap**: a period whose return is `null` has no
    line, and neither does one whose window holds a day the stored coverage does not — a line drawn
    through the hole would show a shape the market never made. The return, whose two endpoints are
    sound, is unaffected. Fewer than two sessions draw nothing.

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

### 6. The Dashboard — Market watch (2026-10-20, redesigned 2026-10-21)

Monitor activity is the page; the funds are a compact sidebar beside it. (The 2026-10-12 composition
— two columns of eight-column tables above the feed on a desktop, category cards on a phone — and the
2026-10-20 card composition with its Auto toggle are retired; they are in this file's history.)

- **≥ 1,280px — two panes, no cards.** Monitor activity takes the width that is left; **Market
  watch** is a fixed-width pane (`clamp(330px, 24vw, 360px)`: 330px at 1,280px, 345px at 1,440px,
  360px from 1,500px) flush against the right edge, sticky directly under the topbar and exactly the
  screen's remaining height. No border, radius, shadow or margin of its own: one hairline on its left
  divides it from the feed. Its header — title, the close the numbers are measured to, the period
  selector — stays put while its list scrolls on its own (a named, focusable region, with default
  overscroll chaining so the wheel passes to the page at either end). The feed scrolls with the page.
  At the foot of the page the sidebar travels up with the grid, never over the footer.
- **< 1,280px — no Market watch at all.** Not rendered, not hidden: the component is **not mounted**
  (`useMediaQuery("(min-width: 1280px)")`, whose server snapshot is `false`, so server and hydrating
  client agree and Market watch mounts right after hydration on a wide desktop). Below the
  breakpoint it therefore makes no request and starts no timer, and nothing replaces it — no card,
  no selector, no placeholder. The grid reserves the sidebar's track in CSS at the same query, so
  the feed does not move when Market watch appears. Crossing the breakpoint mounts or unmounts it,
  aborting a read still in flight and clearing its timers.
- **The rows.** The three groups in the API's order under compact sticky labels, each fund one grid
  line about 26px tall: a small local line icon for what it tracks (decorative, hidden from assistive
  technology), the ticker, the market's name (truncated with an ellipsis, whole in its `title`), the
  period's return (right-aligned, tabular, signed, ink tokens) and the period's line (plain SVG,
  52 × 16px, coloured by the same return). All twenty and their groups fit a 768px-tall screen; a
  shorter one scrolls the list rather than shrinking the type. A period change changes numbers and
  lines, never order, row height or scroll position.
- **One period, one rotation.** The period is one piece of state for the whole list
  (`usePeriodRotation`). It advances every **eight seconds**, `1W → 1M → 3M → 6M → YTD → 1Y → 1W`:
  one interval timer, re-armed on each change, starts a staged change — the returns and lines fade
  to 60% over 250ms, the period swaps while they are dim, and they return to full strength over
  420ms (670ms in all); tickers, names, icons and group labels never fade, and only opacity moves.
  The newly selected period takes one soft blue ring that swells and fades once
  (`data-highlight` on the `SegmentedControl` option). Stage timers are scheduled by the step before
  them and never overlap; a change already under way always finishes, so nothing stays dimmed.
- **The reader's control.** There is no Auto button, toggle or badge. Choosing a period — any, the
  one on screen included — shows it at once (cancelling a change under way) and stops rotation for
  the rest of the page's life; a new page load rotates again. Pointing at the sidebar, or keyboard
  focus inside it, **pauses** the timer without stopping rotation, and leaving gives the period on
  screen a full interval again; a click's leftover focus is not a keyboard hold. A hidden tab pauses
  it the same way. A reader who prefers reduced motion gets no automatic rotation and no fade or
  highlight; every period stays one click away. Nothing is a live region, so nothing is announced
  as it rotates. Changing the period — by hand or by rotation — makes no request; each series'
  sparkline geometry is computed once and kept for as long as the response.
- **Isolation.** Market watch has its own request (`useMarketOverview`), its own failure states and
  an error boundary; it is memoised and holds its rotation state itself, so its rotation never
  re-renders the feed and the feed's refreshes never re-render it. A Market watch failure never
  blanks the Dashboard.
- **States** — a skeleton of the final geometry, an error panel with retry, a clean unavailable
  panel, `As of 2 Jan` beside a stale fund's name with the fund's own date, `No data` for an empty
  one, `—` for an unavailable return (announced "not available") with a dashed rule where its line
  would be.
- Guests see exactly what a signed-in customer sees in Market watch, and on a phone go straight to
  the published built-in Monitor activity with the sign-in notice above it.

## Alternatives rejected

- **A period selector** — rejected for the full-width overview, because it would hide five of the
  six answers the overview existed to compare; **adopted** for Market watch (2026-10-20), where a
  sidebar a third of the width cannot hold six columns and the owner chose one rotating period over
  six cramped ones.
- **An Auto control to restart rotation** (2026-10-20, retired 2026-10-21) — a toggle and a
  `Paused` badge spent the sidebar's header on a mode. A chosen period is now a decision that holds
  for the page's life, and pausing on hover covers the reader who only wants to look.
- **Relabelling the one-year line for every period.** A 53-point weekly series cannot draw a week,
  and a line that does not span its return's window can point the other way from the number beside
  it.
- **Six reads, or one per fund, when the period changes** — or a client-side recomputation from a
  history. The six lines are prepared once per computation from the read the returns already make,
  so a period change is state only.
- **Rendering Market watch below 1,280px and hiding it with CSS** — it would still fetch, rotate and
  re-render on every phone.
- **Three groups side by side.** It forced a two-line row — eight columns do not fit a third of a
  1,280px page — and two lines per fund made the overview a screen tall. Two columns hold the
  eight-column single-line row. (The original decision chose the opposite; the 2026-10-12 amendment
  reversed it.)
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
Deploy API and web in the same release, or the API first and the web immediately after. The
2026-10-20 `sparkline` → `sparklines` change follows the same rule: a Market watch build against an
API without `sparklines` shows its error state and Monitor activity is unaffected; an older web build
against the new API simply draws no one-year line. Nothing in
the database changes. Before the production ETF bootstrap of PR 1 runs, the overview reports every
fund unavailable and renders its empty state.

## References

- `docs/decisions/etf-market-data-v1.md` — the storage, residency, refresh and reader of PR 1.
- `ai/architecture/benchmark-data.md` — the benchmark subsystem and the market overview.
- `docs/openapi.yaml` — `GET /market-overview`.
