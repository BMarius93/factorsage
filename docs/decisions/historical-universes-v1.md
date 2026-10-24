# Historical PIT built-in universes, v1

- **Status:** Accepted, 2026-10-24.
- **Extends:** `sp500-historical-pit-v1.md` (the S&P 500 reconstruction, its List and its Pro
  allowance), `protected-stock-tier-v1.md`, `stock-cache-tiers-v1.md`, `entitlements-v2.md` §6.
- **Measured results:** `docs/audits/historical-universes-2026-10-24.md`.

## 1. Context and scope

The S&P 500 point-in-time universe proved the model: a built-in SYSTEM List whose members carry
`CUSTOM` buy windows reconstructed from the provider's index history, so a backtest buys a security
only while it was a member and never force-sells it when it leaves. This decision extends that model
to a catalog of 23 premium universes — two more indices and twenty universes derived from one — and
to an internal set of research rankings, without changing what a List, a buy window or a backtest
is.

What is new is where the windows come from. An index universe's windows are its reconstructed
membership. A derived universe's windows are a **generation**: a deterministic, versioned
evaluation of a definition over PostgreSQL, validated before it may reach a List. Nothing a customer
does reaches the provider, and opening the Lists page or selecting a universe reads only metadata.

## 2. The catalog

Every definition lives in `packages/domain/src/historical-universes.ts`; its key is the List's
immutable `systemKey`.

| Category          | Universes                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Market Indices    | S&P 500 — Historical PIT (existing), Nasdaq-100 — Historical PIT, Dow Jones 30 — Historical PIT                                                               |
| S&P 500 Sectors   | Technology, Financials, Health Care, Energy, Industrials, Utilities, Communication Services, Consumer Discretionary, Consumer Staples, Materials, Real Estate |
| Market Cap        | S&P 500 Top 100 and Top 250 by market capitalization (monthly)                                                                                                |
| Investment Styles | S&P 500 Growth and Value (FactorSage methodology, quarterly), High Dividend (semi-annual), Top 50 Momentum 12-1 and Top 100 by Liquidity (monthly)            |
| Dow Strategies    | Dogs of the Dow (annual), Small Dogs of the Dow (annual)                                                                                                      |

**Internal research candidates** (`audience: INTERNAL`, category `RESEARCH`) are generated and
validated like the catalog but are never published and never listed: market cap top 25/50 and
bottom 50/100; momentum top 25/100, 6-month, 12-month and risk-adjusted top 50; lowest and highest
volatility 50/100; liquidity top 50; the top 50 by earnings yield, FCF yield, book-to-price, revenue,
EPS and FCF growth, ROIC, ROE, gross margin, interest coverage and lowest leverage; Nasdaq-100 top 25
by market cap and top 20 by momentum; Dow top 10 by momentum. The audit evaluates each one; none is
published by this change.

**Growth and Value** are not the S&P 500 Growth/Value style indices, whose historical constituents
cannot be reconstructed from the provider. They are FactorSage's own: each quarter, the third of the
S&P 500's members with the highest composite score, the composite being the mean percentile rank,
among that date's members, of revenue growth, EPS growth and 12-month return (Growth) or of
book-to-price, earnings yield and sales-to-price (Value), for members with at least two of the three.
Their names say "S&P 500 Growth" and "S&P 500 Value" as universes of the S&P 500, and their
descriptions say the methodology is FactorSage's.

**The sectors are BLOCKED.** A sector universe needs every member's GICS sector on each date. The
provider reports today's sector only, in its own taxonomy rather than GICS, and GICS itself changed
(Real Estate left Financials in 2016; Communication Services replaced Telecommunication Services in
2018). Today's sector applied to thirty years is not point-in-time, so the sectors are defined,
listed as "Historical data unavailable", and never generated (`UNAVAILABLE_UNIVERSE_DATA`).

## 3. Index memberships

### 3.1 S&P 500

Unchanged (`sp500-historical-pit-v1.md`). Its List keeps the 1996 floor and the survivorship
disclosure it was published with; its coverage by year is measured like every other universe's and
reported, and the universes derived from it start only at their own reliable period (§6).

### 3.2 Nasdaq-100

`nasdaq-constituent` and `historical-nasdaq-constituent` are the Nasdaq-100 (NDX) — 101 current
lines, the hundred largest non-financial Nasdaq companies with Alphabet's two classes — not every
Nasdaq listing. The change log runs from the index's 1985 launch; the reconstruction, resolution and
effective-date rules are the S&P 500's, unchanged. Its expected line band is 100–112: from 2014 to
2017 the index carried many second share classes (Liberty Global, LiLAC, Liberty Media, Discovery,
Comcast, Fox, Alphabet), and the reconstruction's 105–111 lines then are those classes, not missing
removals.

### 3.3 Dow Jones Industrial Average

`dowjones-constituent` and `historical-dowjones-constituent`: 30 lines, a 1994 snapshot followed by
the changes. The log omits two published changes, so reconstructed as delivered it holds 31–32 lines
from 1996 to 2019. Two **change-log corrections** (`change-log-corrections.ts`) restore them:

- **Travelers Group, 1997-03-17.** The 1997 change replaced Bethlehem Steel, Texaco, Westinghouse
  and Woolworth with Hewlett-Packard, Johnson & Johnson, Travelers Group and Wal-Mart; the log
  records the four removals and three additions, and Travelers only as a "Citigroup" addition on
  1998-10-08 with no removal. Travelers Group became Citigroup and stayed in the average as the same
  component until 2009; the correction moves the addition to 1997-03-17.
- **Dow Inc., 2019-04-02.** Dow Inc. replaced DowDuPont before the open on 2019-04-02. The log
  records the removal under DD, the ticker DowDuPont took two months later, so it cannot match
  DowDuPont's 2017 addition under DWDP, and it records no addition of Dow Inc.

A correction is a reviewed decision about one published change, with its evidence; it replaces
named provider rows only when each matches exactly one stored row, and is refused — reported, never
half applied — when the provider has corrected its log. The provider's rows are never modified.
With both, the Dow holds exactly 30 lines on every day since 1996 but the six single days between a
removal and the addition the log dates the day after it, which the List projection already closes.

## 4. The engine and the generator

`packages/stock-data/src/historical-universes/`: `engine.ts` (pure), `metrics.ts` (pure),
`validation.ts` (pure), `inputs.ts` (PostgreSQL reads) and `generator.ts` (orchestration and
persistence).

**Point-in-time rules**, enforced in one place:

1. A reconstitution date `T` is the **last observed trading session** of each listed month — the
   sessions the parent's stored prices show, never a weekday rule. The latest observed month is never
   treated as complete.
2. The candidates on `T` are the parent's members **on `T`**: the index's reconstructed membership,
   or, for a universe drawn from another (Small Dogs), that universe's selection on `T`.
3. A candidate's value reads only data **available by `T`'s close** (§5).
4. Ties are broken by the larger market capitalization, then the security id.
5. The selection takes effect on **`T` + 1 day** — the next session for everything a buy window
   serves, since windows are read only on sessions — and lasts through the next reconstitution date.
6. A membership is **clipped to the member's parent membership**: a member that leaves the index
   mid-period leaves the universe the same day, and is a candidate again only at the first
   reconstitution after it returns. Re-entry yields a second window.
7. Nothing is filled from the future: a member without a value on `T` is not selected.

**Generations.** One run loads a root index's parent membership and observed sessions once, computes
every metric its universes need in one pass over the securities (a typed-array matrix, a handful of
loads per security), ranks each universe, and stores a generation: selections with rank, value and
effective date (`HistoricalUniverseSelection`), merged membership periods
(`HistoricalUniverseMembershipPeriod`), per-reconstitution diagnostics, the validation, the
methodology and engine versions and two digests.

- **Idempotent.** The input digest covers the definition, its methodology and engine versions, the
  parent's synchronization digest and every candidate's value on every date. A universe whose digest
  equals its latest completed generation's writes nothing.
- **Incremental.** New sessions add reconstitutions and change the digest; a rerun after an
  ingestion writes exactly one generation per universe that moved.
- **Atomic and serialized.** A generation's rows and the universe's pointer to it are written in one
  transaction under a per-universe advisory lock; a failure leaves the previous generation in force.
- **Versioned.** `methodologyVersion` per definition and `HISTORICAL_UNIVERSE_ENGINE_VERSION` are
  recorded in every generation; changing either changes the digest.
- **Bounded.** A universe keeps only its latest generation and the one its List was published from;
  a superseded generation is deleted with its selections and periods in the transaction that
  replaces it.

## 5. Metrics

Every metric is `null` with a reason when unavailable — never zero — and the reasons are counted in
each reconstitution's diagnostics.

### 5.1 Market capitalization

The session's close times the share count of the latest quarterly statement public by then, under
the valuation ratios' share-count and price-basis rules (`valuation-ratios-v1.md` rules 2, 3, 5, 6
and 8; `marketCapitalizationColumn`). The provider's own historical market capitalization is not
used: its share counts are not point-in-time. A listed share class counts with the company's whole
count, so a two-class company can occupy two lines of a ranking.

### 5.2 Price metrics

On the stored, split-adjusted research closes, with lags counted in the parent's sessions and a
lagged close taken at most five sessions before its session:

- **12-1 momentum** — the close 21 sessions back over the close 252 back, minus one.
- **6- and 12-month return**; **risk-adjusted momentum** — 12-1 momentum over the annualized
  volatility of the daily log returns between those two closes (at least 220 returns).
- **252-session volatility** — annualized standard deviation of daily log returns (at least 240).
- **63-session dollar volume** — the mean of close × volume over the last 63 sessions (at least 50
  bars), the liquidity measure.

A metric needs a close on `T` itself; a member that did not trade on `T` has no value.

### 5.3 Dividends

`DividendEvent` holds each security's provider dividend history: ex-date, record, payment and
declaration dates, the declared and the split-adjusted amount, and the provider's frequency label,
replaced whole on every synchronization and recorded in `StockDatasetState` (`DIVIDEND`).

The **indicated annual dividend** on `T` is the current regular rate times the payments per year:

- **No look-ahead.** Only dividends whose ex-date is on or before `T` are read. A dividend is
  declared before it goes ex, so one that has gone ex was public on `T`; a dividend declared but not
  yet ex is not read, so nothing announced after `T` can reach it.
- **Special and irregular payments are excluded**: a one-off is not a rate.
- **Payments per year** come from the frequency label unless the regular payments with an ex-date in
  the year to `T` contradict it; then from that count (10+: monthly, 3–6: quarterly, 2: semi-annual,
  1: annual). The labels are not reliable alone — a one-off payment between quarterly ones is
  sometimes labelled monthly (XOM, 2001-06-18).
- **The rate** is the latest regular payment, unless it is under half the median of that year's
  regular payments (an out-of-cycle payment, not a cut).
- A security whose latest regular payment went ex more than 400 days before `T` indicates nothing.

The **indicated yield** is that amount over the split-adjusted close — both on the same basis.
A security whose dividends were never synchronized is missing data (`DIVIDENDS_NOT_INGESTED`, which
counts against coverage), distinct from one that pays none (`NO_REGULAR_DIVIDEND`, ineligible).

### 5.4 Fundamentals and valuation yields

Revenue, EPS and FCF growth, ROIC, ROE, gross margin, interest coverage and net debt to EBITDA are
the derived state's point-in-time Fundamental Metrics on `T` (`fundamental-metrics-v1.md`), which
read only statements available on `T` (filing dates, with the listing-evidence floor). Earnings
yield, FCF yield, book-to-price and sales-to-price invert the valuation ratios on `T` and are
available only where the ratio is positive.

### 5.5 Nominal price

Small Dogs ranks the as-traded price: the stored close with every split after `T` undone. A 4-for-1
split in 2022 divided every earlier stored close by four, so a price ranking on stored closes would
call a high-priced stock cheap before its split.

## 6. Validation and publication

Each reconstitution passes when:

- **data coverage** — members with market data on `T` over the parent's lines, unresolved
  constituents and members without a close counting against it — is at least **0.90**;
- **metric availability** — members with a value over members with data — is at least **0.75**
  (genuine ineligibility, such as a short history or no dividend, lowers it);
- the selection is **full**; and, for a universe drawn from another, that universe is reliable on `T`.

The **reliable period** is the suffix of reconstitutions after the last one that fails; a universe is
`VALIDATED` when that period is at least five years long and its latest reconstitution is at most 400
days older than the latest session. An index universe is validated by coverage alone, monthly.

Lifecycle: `DRAFT` → `VALIDATED` → `PUBLISHED`, or `BLOCKED` when a required dataset has no source.
`pnpm data:historical-universes -- publish <key>` projects a validated generation into the List
**from its `publishFrom`** (the first effective date of the reliable period), refuses an internal
universe, a draft, a blocked one and one the engine's ceilings could not run, and records the
published generation. The S&P 500's own List keeps its 1996 floor (§3.1). A published universe
whose newer generation does not validate stays published on its last good generation.

**Product rules** — one `MaintainedUniverse` (`maintainedUniverseForList`) decides them for every
catalog universe:

- Premium: Guest, Free and Starter see each universe with a lock and a "Pro" label and cannot open
  its membership, backtest it or monitor it (`entitlements-v2.md` §6); the backend refuses all of
  them whatever the client shows.
- Measured by its most simultaneous members in the run's period, against
  `backtests.maxIndexUniverseConstituents`; the snapshot records the root `indexKey` and, for a
  derived universe, its `universeKey`. An index universe's snapshot is byte-for-byte what it was.
- **Never edited and never duplicated.** A copy would stop being maintained, and so point-in-time,
  and would outlive the plan that unlocks it; `POST /lists/:id/duplicate` answers `409` on every
  plan.
- Customer monitors watch only their own Lists, so no customer monitor can reach a universe.
- `GET /lists/universes` lists every catalog universe by category with `availability` and `locked`,
  so "Historical data unavailable" (no plan unlocks it) and "Requires Pro" are never one message.
  Internal universes are never listed.

## 7. PostgreSQL, Redis and data reuse

- **One dataset per security.** Prices, statements, splits and dividends are stored once per
  security whichever index names it. An index's ingestion checkpoints a security another index's run
  already loaded as reused, at no provider cost; dividends are skipped once synchronized.
- **The protected tier stays the S&P 500's** (`PROTECTED_TIER_INDEX_KEYS`). Every Dow security is an
  S&P 500 security already; the Nasdaq-100's former members outside the S&P 500 are not made
  resident because their membership is stored. A Nasdaq-100 or Dow run is not designated and reads
  its non-S&P members through the bounded LRU and PostgreSQL. A universe derived from the S&P 500
  designates only S&P 500 securities. `protect --index NASDAQ100` is refused.
- Derived universes add no EOD rows anywhere: their generations hold selections and periods only.

## 8. Operations

```bash
# Membership (provider; owner-authorized budgets)
RUN_INDEX_UNIVERSE_INGESTION=1 scripts/cloud/fmp-index-universe.sh sync --index NASDAQ100
RUN_INDEX_UNIVERSE_INGESTION=1 scripts/cloud/fmp-index-universe.sh resolve --index NASDAQ100 --budget 2500
RUN_INDEX_UNIVERSE_INGESTION=1 scripts/cloud/fmp-index-universe.sh ingest --index NASDAQ100 --budget 4000
RUN_INDEX_UNIVERSE_INGESTION=1 scripts/cloud/fmp-index-universe.sh dividends --index SP500 --budget 750
# Generation and publication (PostgreSQL only)
pnpm data:historical-universes -- generate --all
pnpm data:historical-universes -- report --out artifacts/historical-universes/report.json
pnpm data:historical-universes -- publish nasdaq100-historical-pit sp500-top100-market-cap
```

Every step is idempotent and resumable: sync and resolve keep their checkpoints in PostgreSQL,
ingestion its `IndexUniverseIngestion` rows, dividends their `StockDatasetState`, generation its
digests. On a persistent production database the same sequence, run again after each ingestion,
does only what changed. `project` is the S&P 500's alone; every other index reaches its List through
`publish`. Reports hold counts and dates only and are git-ignored with the provider data.

## 9. Capacity

A published universe must fit the engine's existing ceilings — 600 simultaneous members and 2,000
securities per run (`BACKTEST_MAX_INDEX_UNIVERSE_*`) — and is measured, like the S&P 500, by its
peak of simultaneous members, never its distinct securities. The ceilings were not raised. A
derived universe never holds more members at once than its selection count — one selection ends on
the reconstitution date and the next starts the day after — and the measured peaks are in the audit.

## 10. Licensing

S&P 500, Nasdaq-100 and Dow Jones Industrial Average are trademarks of their owners (S&P Dow Jones
Indices; Nasdaq, Inc.). The universes are FactorSage reconstructions from a market-data provider's
records, not licensed index data, and their names and descriptions say so; Growth, Value, High
Dividend, Momentum, Liquidity and the Dogs are FactorSage methodologies, not index products. The
provider's terms on redistributing derived constituent data in a commercial product have not been
reviewed by counsel. **Flagged:** confirm the provider licence covers displaying reconstructed
constituents, and whether the index names may be used, before a commercial launch.

## 11. Limitations

- Survivorship: before about 2010 the provider holds no prices for a large share of past S&P 500
  members; derived universes start where coverage is sufficient, the S&P 500's own List does not
  (§3.1).
- Effective dates carry the S&P 500 reconstruction's known one-session uncertainty for unconfirmed
  log dates.
- Fundamental universes depend on the derived state's coverage, which starts later than prices.
- Sectors are blocked until a point-in-time GICS source exists.
