# Historical price and corporate-action basis: investigation

Branch `design/historical-price-basis-v1`, cut from `main` at `79fa8509` (the merge of PR #74),
investigated on 2026-09-30. This is the evidence behind
`docs/decisions/historical-price-basis-v1.md`. It starts from, and does not repeat,
`docs/valuation-ratios-gate/INVESTIGATION.md` (the valuation gate, "the prior gate" below).

No product code was written. Every provider request was a read with the local key. Nothing the
provider returned is committed in bulk: `evidence/` holds summaries, ratios and a handful of
quoted values.

## Verdict

- **The prior gate's nine findings all hold.** This investigation re-measured each of them with a
  stronger test and found no contradiction. A clean-room review then corrected parts of this
  record; its findings are applied below and listed in the decision's "Review".
- **The stored close is FMP's adjusted series, and it folds most spin-offs in as if they were
  splits.**
  - The six known securities (MMM, HON, WDC, AXP, MRK and IBM) are confirmed trade by trade.
    Insider trade prices fall inside the stored session's low–high range only when the stored
    bar is multiplied by the measured factor: 0/306 MMM trades at factor 1 and 306/306 at 1.1963.
    That is 306 distinct trades on 48 dates, and it resolves the factor to about ±0.5 %.
  - WDC's Sandisk factor is measured independently for the first time: 1.3273 (64 trades on 49
    dates), against the provider's 1.323.
  - IBM's Kyndryl factor is confirmed against an independent as-traded series, Alpha Vantage's
    raw daily close. The ratio is 1.046000 for twenty years and 1.000000 after 2021-11-04, and
    98.7 % of 6,450 sessions sit within cent rounding of that one step.
  - The provider scales volume by the same factor: stored IBM volume is exactly 1.046 × raw
    before Kyndryl. RVOL is affected too.
- **No further affected security among the 62 with statements.** A range-containment scan of all
  of them, with insider histories fetched for the 29 that had none stored, finds no price-only
  adjustment beyond the six. The provider's DIS 2007 entry cannot be placed either way.
- **The problem is market-wide.** An estimated 36–37 of 230 US large caps (about 16 %) carry at
  least one provider-listed price-only candidate since 1996-09-30. The list omits events (MMM
  2024 is in the sample and not flagged) and may include a few share-changing ones, so this is an
  estimate, not a bound.
- **FMP offers no independent as-traded record on the current plan.** Twelve endpoints were
  tested:
  - market-cap history, enterprise values, key metrics, intraday bars, the light and
    dividend-adjusted series, and earnings all carry the adjusted basis;
  - bulk EOD and older calendar windows are not on the plan;
  - the legacy v3 endpoints are refused.
- **Share counts behave as the prior gate found.** Statement share counts are restated by
  share-changing actions only.
  - HON's quarters from 2002 are restated to half, by the 2026 reverse split. The clean-room
    review found 62 of 64 within 2 % of half the as-reported implied count.
  - The spin-offs are not restated.
  - The dividend method agrees with both only as a cross-check: 59 of 68 single-quarter readings
    fall within ±2 %.
- **Margin of Safety is overstated on 34,077 of the 315,524 sessions that have one (10.8 %).**
  - That is 211,653 model and blend values.
  - The overstatement is exactly the distribution factor `Φ` in intrinsic value ÷ price: 1.046
    to 2.120.
  - The built-in `Value & Trend` Strategy's BUY condition (Balanced MOS above 5 %) holds on stored
    data but not on the as-traded basis on 4,664 of the 28,720 affected sessions. Its SELL
    condition (below −15 %) is missed on 4,557.
  - At the live edge `Φ = 1`, so this price-basis defect does not reach today's value.
    Statement content does: after a distribution the statements still describe the whole former
    company. HON's Balanced Margin of Safety reads +14.3 % today on one quarter that includes the
    separation.
- **The provider rewrites whole histories after a split, and its timing is unobserved.**
  - APH's 2:1 split of 2026-09-03 is already applied back to 2016: price halved, volume doubled.
  - The loader re-reads only the tail, so the next event in a loaded security leaves a step in
    stored history.
  - Whether the provider publishes an ex-date row before it rewrites the older rows is unknown.
    Baselines for GPMT (1:10, 2026-10-06) and DXJ (3:1, 2026-10-09) are captured to measure it.
- **Candidate external sources exist, but none is validated for the event set or licensed.**
  - Retail APIs fold spin-offs into their split factors (Alpha Vantage, Tiingo).
  - EODHD's documented "as traded" close is reconstructed from adjusted prices.
  - The institutional databases (CRSP, Sharadar, Algoseek, Xignite) keep price and share factors
    apart, and need a commercial licence.

## Scope

| Data                                           | What was read                                                                                                                                                                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Development database `intrinsic_value`         | 9,768 catalog securities; 64 with prices (368,857 rows, 1992-09-09 → 2026-09-25); 62 with statements (6,391 quarterly income identities); 363,049 derived rows of those 62; 63,499 priced `S`/`P` insider rows for 33 securities. |
| Insider history fetched for this investigation | `insider-trading/search` for the 29 priced securities with no stored insider rows (122 pages). With the stored rows, 102,906 open-market trades on stored sessions in 62 securities.                                              |
| Provider split lists                           | `stable/splits` for the 63 priced securities and for 270 further large caps (a 319-security sample above $50 B market capitalisation on NYSE and NASDAQ).                                                                         |
| Provider probes                                | 500 FMP requests in all, listed under "Reproducing".                                                                                                                                                                              |
| Independent series                             | Alpha Vantage `TIME_SERIES_DAILY` for IBM through its published `demo` key (6,768 sessions from 1999-11-01). EODHD's `demo` key for AAPL, AMZN and TSLA, through the research agent.                                              |
| External documentation                         | Vendor documentation, pricing pages, licence terms and the CRSP, Compustat and Sharadar factor definitions; about 125 fetches by a research agent. No sign-up, no payment, no personal data.                                      |

SEC EDGAR's XBRL API was tried once for as-filed share counts and refused the request: it
requires a declared contact in the `User-Agent`. That contact is an operator fact, so it was not
invented here and SEC data was not used.

## 1. The price pipeline as implemented

| Stage            | What happens                                                                                                                                                                                                                                                                                                                                                            | Source                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider read    | `historical-price-eod/full` walked to completeness in pages of 5,000 rows; only `date, open, high, low, close, volume, vwap` are mapped. No endpoint for splits, dividends or unadjusted prices is called anywhere in the product.                                                                                                                                      | `packages/fmp/src/client.ts` (`walkDailyPrices`), `mapping.ts` (`mapFmpDailyPrices`)                                                                   |
| Storage          | `DailyPrice(securityId, date, open, high, low, close, volume, vwap)`, all `Decimal(20,8)`. `StockDataset` declares `DIVIDEND` and `STOCK_SPLIT`, but nothing writes them.                                                                                                                                                                                               | `packages/database/prisma/schema.prisma`                                                                                                               |
| Coverage         | `StockDatasetCoverage` under `split-adjusted-eod-full:v3` (`PRICE_DATASET_VERSION = 3`); a coverage interval means "asked completely, every row persisted".                                                                                                                                                                                                             | `packages/stock-data/src/ports.ts`, `docs/decisions/complete-price-coverage.md`                                                                        |
| Refresh          | `refreshPriceWithinLease` re-reads from ten calendar days before the earlier of today and the previous sync's tail. `saveDailyPriceSync` compares each returned row with the stored one (`samePrice`), deletes and re-inserts the returned dates in one transaction, and reports the earliest changed date.                                                             | `service.ts`, `prisma-store.ts`                                                                                                                        |
| Derived rebuild  | A **second** transaction rebuilds `DailyDerivedState` and `WeeklyPrice` from the earliest changed date. The rebuild calculates from the earliest persisted bar, so EMA and RSI are a pure function of the stored prices (AUD-02).                                                                                                                                       | `service.ts` (`rebuildDailyDerivedState`), `prisma-store.ts` (`saveDailyDerivedState`)                                                                 |
| Redis            | Yearly row-JSON price chunks (`prices:1D:<year>`) and columnar `daily-state:v2` chunks, written one key at a time under a `HYDRATING` manifest and read by `MGET` under a `READY` one. The manifest check and the multi-year read are separate commands.                                                                                                                | `packages/stock-data/src/cache.ts`                                                                                                                     |
| Backtest         | `PREPARING_DATA` hydrates and refreshes once; `RUNNING` reads one calendar-year window at a time with no generation check. Fills are at the same day's close, shares are fractional, fees and slippage are zero. Snapshots record global `dataRevisions` (`priceDatasetVersion`, `derivedStateRevision`, `fundamentalsVariantVersion`, `benchmarkPriceDatasetVersion`). | `service.ts` (`prepareDailyEvaluationData`, `readDailyEvaluationFrame`), `packages/strategy/src/backtest/methodology.ts`, `backtest-data-revisions.ts` |
| Monitor          | Prices come from the Redis projection, the derived tail straight from PostgreSQL, plus the live quote as a provisional row.                                                                                                                                                                                                                                             | `monitor-frame.ts`, `ai/architecture/deep-discovery.md`                                                                                                |
| Margin of Safety | `(IV − close) / IV × 100` in the evaluation frame, with `close` the stored close.                                                                                                                                                                                                                                                                                       | `packages/stock-data/src/evaluation-frame.ts`                                                                                                          |
| Intrinsic values | DCF (FCFF) and Residual Income divide by the latest point-in-time quarterly `weightedAverageShsOutDil`. DDM divides each quarter's `commonDividendsPaid` by that quarter's share count. Graham sums four `epsDiluted`.                                                                                                                                                  | `packages/stock-data/src/intrinsic-value-inputs.ts`                                                                                                    |
| Benchmark        | Same endpoint, same pagination, same ten-day tail, its own table and `BENCHMARK_PRICE_DATASET_VERSION`.                                                                                                                                                                                                                                                                 | `benchmark-service.ts`                                                                                                                                 |

## 2. What the stored close carries

### 2.1 Method: range containment

An insider's open-market trade price is an as-traded price. The prior gate took the median of
price ÷ stored close per period. This investigation adds a stronger, per-trade test. If the
stored close is the as-traded price divided by `A`, every trade must fall inside the stored
session's range multiplied by `A`:

```text
low(D) × A × (1 − 0.5 %)  ≤  price  ≤  high(D) × A × (1 + 0.5 %)
```

- For the right `A`, 90–100 % of trades are contained. AAPL's 4:1 window is the low end, at 92 %.
  The rest are filings misdated, averaged or in another instrument, off by 1–7 %.
- For a wrong `A`, typically none are.
- Each trade therefore bounds `A` to `[price ÷ high, price ÷ low]`.
- The "95 % interval" in the tables is the set of factors that at least 95 % of a window's
  constraints admit.
- **Counts are distinct trades.** Rows repeated in the feed are removed: MMM's 317 rows before
  Solventum are 306 trades.
- **Trades cluster on few dates.** The event windows hold, for example, MMM 48 dates, WDC 49,
  IBM 72, AXP 43, and HON 5 in its last period.
- **The resolution is therefore about ±0.5 %.** MMM contains all 306 trades at every factor from
  1.190 to 1.200, and IBM all 361 from 1.043 to 1.049. The test separates events of a few
  percent; it cannot see a 1 % one.

The median is also reported. It carries an intraday-timing bias of up to a few percent in
volatile or trending periods: ALAB's 2026 H2 median is 1.0439, yet 136 of 136 trades are
contained at factor 1. Containment does not carry that bias.

### 2.2 Event by event

`evidence/events.csv` has every column. The core of it:

| Security, ex-date      | Event (measured)                                       | Contained at factor 1, before | Measured factor before (median, 95 % interval) | Provider list            | Contained at the list's factor                            | Share factor `G` step | Distribution factor `Φ` step | `close × shares` error before |
| ---------------------- | ------------------------------------------------------ | ----------------------------- | ---------------------------------------------- | ------------------------ | --------------------------------------------------------- | --------------------- | ---------------------------- | ----------------------------- |
| MMM 2024-04-01         | Solventum, price-only                                  | 0/306                         | 1.1963 (1.1875–1.2043)                         | no entry                 | 0/306                                                     | 1                     | 1.1963                       | −16.4 %                       |
| WDC 2025-02-24         | Sandisk, price-only                                    | 0/64                          | 1.3273 (1.3154–1.3367)                         | 1323:1000 `stock-split`  | 64/64; 1,014/1,018 in 2003–2018                           | 1                     | 1.323                        | −24.4 %                       |
| IBM 2021-11-04         | Kyndryl, price-only                                    | 0/361                         | 1.0443 (1.0383–1.0521)                         | 523:500 `stock-split`    | 361/361                                                   | 1                     | 1.046                        | −4.4 %                        |
| MRK 2021-06-03         | Organon, price-only                                    | 1/178                         | 1.0485 (1.0427–1.0561)                         | 131:125 `stock-split`    | 178/178                                                   | 1                     | 1.048                        | −4.6 %                        |
| AXP 2005-10-03         | Ameriprise, price-only                                 | 0/147                         | 1.1326 (1.1246–1.1385)                         | 10000:8753 `stock-split` | 94/147 (list 0.9 % too large)                             | 1                     | 1.1326                       | −11.7 %                       |
| HON 2018-10-01 / 10-29 | Garrett and Resideo, price-only                        | 0/261                         | 1.0600 cumulative (1.0548–1.0661)              | 1011:1000 dated 10-28    | 0/261 at the list's cumulative 0.964                      | 1                     | 1.049 (2.120 cumulative)     | −52.8 %                       |
| HON 2025-10-30         | Solstice, price-only                                   | 14/30                         | 1.0105 cumulative (1.0048–1.0183)              | no entry                 | 1/30                                                      | 1                     | 1.060 (2.021 cumulative)     | −50.5 %                       |
| HON 2026-06-29         | 1-for-2 reverse split and Aerospace spin-off, combined | 0/6                           | 0.9532 (0.9484–0.9616)                         | 1907:2000 `spin-off`     | 6/6                                                       | 0.5                   | 1.906                        | −47.5 %                       |
| DIS 2007-06-13         | ABC Radio/Citadel: **undetermined**                    | 11/11 (6 dates)               | 1.0015 (0.994–1.0114)                          | 2000:1973 `stock-split`  | 9/11: the 2 exclusions lie 0.1–0.2 % inside the tolerance | 1                     | unknown                      | unknown                       |
| AAPL 2020-08-31        | 4:1 split                                              | 0/295                         | 4.0013                                         | 4:1                      | 271/295                                                   | 4                     | 1                            | none                          |
| AAPL 2014-06-09        | 7:1 split (window carries ×28)                         | 0/2,107                       | 27.9576 (27.8211–28.2244)                      | 7:1                      | 2,106/2,107                                               | 7                     | 1                            | none                          |
| NVDA 2024-06-10        | 10:1 split                                             | 1/487                         | 9.9899 (9.9355–10.0836)                        | 10:1                     | 486/487                                                   | 10                    | 1                            | none                          |
| AMZN 2022-06-06        | 20:1 split                                             | 0/1,899                       | 20.0148 (19.8711–20.1364)                      | 20:1                     | 1,899/1,899                                               | 20                    | 1                            | none                          |
| WMT 2024-02-26         | 3:1 split                                              | 0/529                         | 3.0031 (2.9833–3.0224)                         | 3:1                      | 528/529                                                   | 3                     | 1                            | none                          |
| CRWD 2026-07-02        | 4:1 split                                              | 0/3,023                       | 3.9914 (3.9721–4.0349)                         | 4:1                      | 3,016/3,023                                               | 4                     | 1                            | none                          |
| JNJ, KO                | controls, no event                                     | 150/150; 350/353              | 0.9993; 0.9997                                 | none                     | —                                                         | —                     | 1                            | none                          |

- **A combined event decomposes only with share evidence.** HON's 2026 step is
  `A = 0.9532 = G × Φ = 0.5 × 1.906`. A factor below one looks like a reverse split and nothing
  more; only the share factor shows that half the value left in a spin-off.
- **The provider's labels are not a classification.**
  - Its only `spin-off` label is the combined HON event.
  - Five genuine spin-offs are labelled `stock-split`: WDC, IBM, MRK, AXP, and HON's 2018 entry.
  - Two spin-offs are missing: MMM 2024 and HON 2025.
  - One entry, DIS 2007, cannot be placed.
    - Its 11 trades on 6 dates contain 1.000.
    - Only 2 of them exclude the listed 1.0137, and both by 0.1–0.2 % of a 0.5 % tolerance.
    - At a tolerance of 0.72 %, both factors contain every trade.
- **The provider's own factor histories disagree with each other.**
  - For HON's 2018 events, the split list says 1.011, the price series about 1.049, and the
    dividend endpoint's `dividend ÷ adjDividend` about 1.043.
  - The dividend-adjusted series computes its factor on the adjusted close. MMM's 2024-02-14
    step implies a price of 77.13 against a stored close of 77.27 and an as-traded price near
    92.5.

### 2.3 The whole store

`evidence/insider-universe-scan.csv` applies the test to every security-year of all 62 securities,
at the factor the provider's split list implies for that date:

- **Explained by the list:** in the 48 securities with no flagged segment, 77,286 of 77,546
  trades (99.66 %) are contained at the list's factor.
- **Flagged segments below 80 % containment:** MMM (every year to 2024), HON (every year) and
  AXP (2003–2005). These are the known events.
- **The other flags are insider-feed defects.** None persists as a step:
  - class B trades filed under BRK-A;
  - GS rows in 2019 at 1.4 % of the close;
  - MRK rows in 2003–2008 priced at $15–17 against a $39–45 range, some labelled
    "Option (right to buy)";
  - AAL's pre-merger AMR identity in 2013;
  - sparse AXON rows;
  - class C/A mixing in GOOG and GOOGL.

The ALAB, WDC 2026 and GS 2008 medians that looked like steps are fully contained at factor 1.

**Events the test cannot reach.** Insider coverage starts in 2003 at the earliest, so:

| Event                             | Evidence                                                                                                                                                                                             | Status                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| AXP / Lehman Brothers, 1994-05-31 | Provider entry 400:353 (1.1331); before the product horizon, inside retention                                                                                                                        | unverifiable                      |
| MMM / Imation, 1996-07-01         | No entry; stored close +3.47 % on the ex-date (SPY +0.86 %)                                                                                                                                          | unverifiable                      |
| MRK / Medco, 2003-08-20           | No entry; the one genuine pre-event trade (2002-09-24, 45.65 against a 42.37–44.08 bar) fits 1.048 and excludes any Medco factor above about 1.06; stored close −2.97 % on the ex-date (SPY −0.41 %) | unverifiable; leans "not carried" |

### 2.4 An independent as-traded series: Alpha Vantage IBM

Alpha Vantage documents `TIME_SERIES_DAILY` as "raw (as-traded)". Its published `demo` key
serves IBM's full history from 1999-11-01. Its ratio to the stored IBM close
(`evidence/alpha-vantage-ibm-ratio-by-year.csv`):

| Period                  | Sessions | Ratio (median; min–max)                                                                                |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| 2001-02-01 → 2021-11-03 | 5,223    | **1.046000**; 1.0411–1.0566                                                                            |
| 2021-11-04 → 2026-09-25 | 1,227    | **1.000000**; 1.0000–1.0000 (identical on every session)                                               |
| 1999-11-01 → 2001-01-31 | 316      | 1.04693; the vendors differ by more than 0.5 % on 26 sessions, more than 1 % on 12, more than 3 % on 3 |

- **One step, exactly the provider's factor.** 6,366 of the 6,450 sessions from February 2001
  are within cent rounding of `stored × 1.046` before the ex-date and `stored × 1` after it.
  - Of the 84 exceptions, 69 are a systematic 0.09 % offset in January–April 2001, a
    decimalisation-era difference between the two vendors.
  - The other 15 are isolated sessions; the largest is 1.01 %.
- **The ratio is piecewise constant.** One step in 22 years supports storing a basis as a list
  of events rather than per session (the decision, "Data model").
- **The raw close looks genuine.** Only 4 of 5,223 closes are not whole cents, and the raw move
  on 2021-11-04 is −4.94 %, the distribution.
- **Alpha Vantage's metadata is still wrong.** It lists Kyndryl as a `split coefficient` of
  1.046 in `TIME_SERIES_DAILY_ADJUSTED` and in `SPLITS`.
- **Volume follows the same factor.** Stored IBM volume is 1.046 × Alpha Vantage's raw volume on
  every session before 2021-11-04: median 1.04600, tenth percentile 1.046. It is 1.000 × raw
  after.
  - So the provider scales volume for a distribution exactly as for a split.
  - An RVOL window that straddles a distribution compares volumes on two bases (decision, §1).
- **Before 2001 the two vendors disagree** by more than rounding on about one session in twelve.
  A reference must survive that, which is why the decision asks for a step structure rather
  than per-session agreement.

EODHD's demo key reproduces the split sessions (AAPL 2020-08-28 499.23, AMZN 2022-06-03 2,447.00)
but not the tape. 59 % of AAPL's post-2001 pre-split closes are not whole cents: 645.5708 =
28 × 23.0561 on 2014-06-06. The close is the adjusted price multiplied by later split factors,
the same construction as FMP's `non-split-adjusted` series. A published third-party test found
its Realty Income close off by the Orion spin-off factor.

### 2.5 Ex-date continuity

The stored close is continuous across every event the insider test confirms:

| Security          | Ex-date move       | SPY same day |
| ----------------- | ------------------ | ------------ |
| AXP               | 0.00 %             |              |
| IBM               | −0.57 %            |              |
| MMM               | +6.02 %            | −0.17 %      |
| MRK               | +2.17 %            |              |
| WDC               | −5.59 %            |              |
| HON (four events) | −0.27 % to −6.46 % |              |

For DIS on 2007-06-13 the stored close moved −0.30 % against SPY's +1.50 %. That shortfall is the
size of the 1.4 % ABC Radio distribution, but it is well inside single-day noise.

Single-day market moves of several percent make this a weak test: see MMM's +6.02 % on the
Solventum date. It is recorded as consistent, not as proof, and it does not decide DIS.

### 2.6 Beyond the store: a large-cap estimate

The splits calendar cannot give a market-wide history on this plan: a year-wide window is capped
at 436 rows, and starts before a recent cut-off are refused. The provider's per-security split
lists were therefore read for the 319 NYSE and NASDAQ common stocks above $50 B
(`evidence/largecap-provider-price-only-candidates.csv`):

- **Flagged:** 69 securities (44 of the 230 US-domiciled) carry at least one entry since
  1996-09-30 that is not a small-integer ratio, or is labelled other than `stock-split`.
- **Price-only candidates.** Excluded as share-changing:
  - entries labelled `stock-dividend`;
  - EQIX 1:32, BKNG 25:1, GOOG and WBD class C distributions, and SCCO's stock dividends labelled
    as splits;
  - the SRE 1998 and BNY 2007 merger ratios.

  That leaves 37 US large caps (16.1 %) with a provider-listed price-only candidate. Excluding
  also the two ambiguous exchange ratios, USB 2001 and DELL 2018, leaves 36.
  - Examples: GE 2019, 2023 and 2024; RTX 2020; T 2022; DHR 2016 and 2023; ABT 2004 and 2013;
    PFE 2020; COP 2012.
  - With 30-year histories assumed, the sessions before each flagged security's latest candidate
    are about 10 % of all US large-cap sessions, and about 60 % of the flagged securities' own.

- **Two more combined events, shaped like HON 2026:** HLT 2017 (250:513) and MSI 2011
  (400:1617).
- **This is an estimate, not a bound.**
  - The list omits events: MMM is in the sample and is not flagged, because Solventum is
    missing.
  - It may still hold a few share-changing entries that look like distributions.

## 3. FMP endpoints tested for an as-traded record

| Endpoint                                             | Result                                                                                                                                               | Independent? |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `historical-price-eod/full`                          | The stored basis (MMM 2024-03-28 88.68; about 106.1 as traded at the measured 1.1963)                                                                | —            |
| `historical-price-eod/non-split-adjusted`            | Equal to the adjusted series for MMM (no list entry); the prior gate showed it is the adjusted series times the split list                           | No           |
| `historical-price-eod/dividend-adjusted`             | Adjusted further for dividends, with factors computed on the adjusted close                                                                          | No           |
| `historical-price-eod/light`                         | 88.68                                                                                                                                                | No           |
| `historical-market-capitalization`                   | MMM 2024-03-28: 49,217,400,000 = 88.68 × 555.0 M                                                                                                     | No           |
| `enterprise-values` (`stockPrice`, `numberOfShares`) | AAPL 2020-06-27 `stockPrice` 88.41, split-adjusted                                                                                                   | No           |
| `key-metrics` (`marketCap`)                          | Same market cap as `enterprise-values`                                                                                                               | No           |
| `historical-chart/1hour`                             | MMM 2024-03-28 hourly bars 87.47–88.80; AAPL 2020-08-28 124.7–125.9                                                                                  | No           |
| `earnings` (`epsActual`)                             | AAPL 2012-07-24 0.33 = 9.32 ÷ 28, restated                                                                                                           | No           |
| `dividends`                                          | `dividend` is as declared (AAPL 2020-08-07 0.82, `adjDividend` 0.205); a per-share figure in as-traded units, used below to measure `G`; not a price | Partly       |
| `eod-bulk`                                           | 402, not on the plan                                                                                                                                 | —            |
| `api/v3/historical-price-full`                       | 403, legacy users only since 2025-08-31                                                                                                              | —            |
| `splits`, `splits-calendar`                          | As in §2.2; the calendar is capped and refuses older windows                                                                                         | No           |

The declared dividends and the insider trade prices are the only as-traded quantities this plan
serves. Neither is a daily price.

## 4. Share basis

### 4.1 The share factor, measured from dividends

A quarter's declared dividend per share is in the share units of its date. Dividends paid ÷
restated diluted shares is in current research units. Their ratio is the factor `G` by which the
provider restated that quarter's share count. `evidence/share-factor-from-dividends.csv` covers 70
quarters; the single-ex-date quarters give:

| Security        | Quarters | Measured `G`                                                 | Explained by                                                       |
| --------------- | -------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| HON 2002–2026   | 27       | 0.477–0.510                                                  | the 2026 1-for-2 reverse split, restated through the whole history |
| MMM 2023–2024   | 8        | 1.003–1.012                                                  | nothing: Solventum not restated                                    |
| IBM 2021–2022   | 6        | 1.007–1.011                                                  | nothing: Kyndryl not restated                                      |
| MRK 2021        | 4        | 0.987–1.065                                                  | nothing: Organon not restated                                      |
| AXP 2005–2006   | 5        | 0.994–1.013, and 1.51 for Q4 2005 (a payment-timing outlier) | nothing: Ameriprise not restated                                   |
| AXP 1996        | 1        | 3.015                                                        | the 2000 3:1 split                                                 |
| AAPL 2014, 2020 | 9        | 28.2, 27.8, 3.95–4.03, 0.97–1.01                             | the 2014 and 2020 splits                                           |
| WMT, NVDA       | 9        | 3.01, 10.16, 1.00–1.01                                       | the 2024 splits                                                    |

This agrees with the prior gate's as-reported probe:

- AAPL ×28, NVDA ×10, AMZN ×20, WMT ×3, CRWD ×4;
- IBM and WDC ×1;
- 85.4 % of 2,033 as-filed quarters within 2 % of the split history;
- 233 as-filed values defective.

The dividend method is a cross-check, not a measurement.

- **It is noisy.** 9 of these 68 single-quarter readings fall outside ±2 % of the explaining
  ratio. One, AXP Q4 2005, is off by 51 %.
- **It reads 0.5–1 % high throughout**, because it divides by diluted rather than record-date
  shares.
- **One quarter cannot separate 1.000 from 1.048.** MRK's Q4 2021 reads 1.065.
- **It needs a regular payer.**

It does separate 1 from 0.5, 3 or 28 on a median of quarters.

The other methods:

- **As-reported figures** carry their own failure exactly at an event. HON's as-reported Q2 2026
  EPS (19.1) is year-to-date minus Q1, and so mixes the post-split year with the pre-split Q1.
  The implied share ratio is 1.07 instead of 0.5.
- **Revision pairs**, a quarter observed before and after the provider restates it, are exact.
  They exist only going forward.

The clean-room review re-checked HON with net income ÷ reported diluted EPS as the as-filed
count. 62 of 64 quarters are within 2 % of twice the restated count; the two exceptions are the
2025 Q4 rounding and that 2026 Q2 figure.

### 4.2 What the share basis is

The latest point-in-time quarterly `weightedAverageShsOutDil` is in current research share units:
as-filed units multiplied by every share-changing ratio since the quarter. It is present on
6,391 of 6,391 quarterly income statements, and 4 are not positive.

The prior gate's B3 anomalies stand: 593 sessions whose latest quarter sits on a different basis
from its neighbours. Margin of Safety already consumes them.

For a session `D`, the latest quarter `Q` and the count `S_f(Q)` as filed, which is in the units
of its filing date because an issuer restates for a split before it files:

```text
researchClose(D) × restatedShares(Q)
  = asTradedClose(D) × S_f(Q) × (share-changing ratios in (filing date of Q, D]) ÷ Φ(D)
```

The split factors cancel, up to the provider's rounding of restated per-share figures: a future
split enters as a unit and leaves the product unchanged. `Φ(D)` does not cancel. It is the whole
of blocker B1.

## 5. Margin of Safety

### 5.1 Where the bias enters, model by model

| Series                                  | What the stored value is                                                  | Does the value itself carry B1? | Does the comparison with the close? | Other basis exposure                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------- | ------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| DCF (FCFF)                              | equity value ÷ latest restated diluted shares, per current research share | no                              | yes, by `Φ`                         | recast cash flows around a spin-off; a future split before its statements are re-observed |
| Residual Income                         | (book value + PV of residual income) ÷ latest restated shares             | no                              | yes, by `Φ`                         | as above                                                                                  |
| DDM                                     | Σ quarterly dividends paid ÷ that quarter's restated shares               | no                              | yes, by `Φ`                         | four share counts, which can straddle a future split in different units                   |
| Graham                                  | from Σ four restated `epsDiluted`                                         | no                              | yes, by `Φ`                         | cent-rounded restated EPS; the provider's EPS defects (170 quarters); a future split      |
| Balanced, Conservative, Dividend blends | fixed-weight sums of the above                                            | no                              | yes, by `Φ`                         | inherits its components                                                                   |

Every model divides by a provider-restated per-share quantity. So every intrinsic value is
internally consistent in current research share units, and the defect is only in the comparison.
It is an exact factor:

```text
IV ÷ storedClose = (IV ÷ asTradedEquivalent) × Φ(D)
```

One correction fixes every model for B1. Statement recasting around spin-offs is a separate
exposure: WDC's and IBM's continuing-operations quarters beside as-filed ones. It changes
intrinsic values themselves, and no price basis fixes it.

### 5.2 How much

`evidence/mos-impact.csv`, over the product horizon from 1996-09-30, using the measured factors
in §2.2. HON's 20 sessions between its two 2018 distributions are left out as unverifiable.

|                                                                                 | Value                                                                                                                                  |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions with a Margin of Safety value                                          | 315,524 of 332,294 (one price row, ALAB 2026-09-25, has no derived row)                                                                |
| Sessions on proven-affected ranges                                              | 34,077 (10.8 %). The prior gate's count, 35,234 (10.6 %), also includes the sessions with no value and HON's 20 unverifiable ones.     |
| Model and blend values affected                                                 | 211,653                                                                                                                                |
| Overstatement, median                                                           | 18.0 percentage points                                                                                                                 |
| Overstatement of IV ÷ price                                                     | exactly `Φ`: 1.046 (IBM) to 2.120 (HON before 2018)                                                                                    |
| Overstatement, largest                                                          | 9,544.6 points (WDC DDM, where the intrinsic value is a tiny fraction of the price); the point figure grows as `(100 − MOS) × (Φ − 1)` |
| Balanced reads positive on stored data and non-positive as traded               | 5,033 sessions (HON 3,015, MMM 1,222, WDC 277, AXP 192, MRK 168, IBM 159)                                                              |
| `Value & Trend` BUY condition (Balanced > 5 %): true stored, false as traded    | 4,664 of 28,720                                                                                                                        |
| `Value & Trend` SELL condition (Balanced < −15 %): false stored, true as traded | 4,557 of 28,720                                                                                                                        |

- **Proven wrong:** the six securities' ranges above, measured by containment.
- **Suspected:** every security whose provider list carries a price-only candidate (§2.6), and
  AXP before 1994-05-31.
- **Unverifiable:** everything before insider coverage, and every security with no insiders or
  no independent series. That is most of the 9,768-security catalog: only 64 securities are
  loaded, and any other opens on demand.

### 5.3 The live edge: the price basis is right, the statements may not be

`Φ(today) = 1` for every security, because no distribution lies after today. So at the live edge
the **price basis** is right in today's Margin of Safety, the Stock Details "price vs value" chips
and every live Monitor Signal.

B1 reaches three places:

- backtests;
- historical charts and intrinsic-value overlays;
- a Monitor level reconstructed from history, whose reconstructed latch may be wrong on an
  affected range.

**The statement content at the live edge is a second defect.** The clean-room review found it.
After a distribution the price has fallen by the value distributed, but the statements still
describe the whole former company until filings reflect the separation, and sometimes they
book a one-off gain from it.

| Security | Sessions                | Stored inputs                                                                          | Effect                                                                                                                                                                                                           |
| -------- | ----------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MMM      | 2024-04-01 → 2024-07-26 | DDM 81.65–81.75, built on the pre-spin $1.51 quarterly dividend                        | falls to 70.83 on 2024-07-29 and 59.88 on 2024-10-23                                                                                                                                                             |
| HON      | 2026-06-29              | Balanced 158.15 from pre-separation statements, against a post-event price of 227.80   | Margin of Safety −44 %                                                                                                                                                                                           |
| HON      | 2026-07-24 onwards      | Q2 2026: EPS 17.81 and net income 5,682 M, 2.43 times any other HON quarter since 2016 | Graham 180.66 → 362.30 and Residual Income 152.87 → 327.96 on the day that quarter became available. Balanced Margin of Safety **+14.3 %** on 2026-09-24, so `Value & Trend`'s BUY margin condition holds today. |

No price basis fixes this. The decision records it as open, in its §13.

## 6. How the provider re-bases, and what the loader does with it

- **Whole-history rewrite.** APH split 2:1 on 2026-09-03 (the provider's calendar), and four
  weeks later its history reads:
  - 80.04 on 2026-09-02 with volume 25,313,252, then 82.07 on 2026-09-03 with volume 10,189,410;
  - 6.36 on 2016-01-04, one eighth of the as-traded level after the 2021, 2024 and 2026 splits.

  Prices before the event are divided and volumes multiplied by the ratio, back to the start.

- **Rounding.** The precision varies by security, not only by price level.
  - AAPL's 2008 closes (2.87–6.96) are all whole cents, and NVDA's 2013 closes (0.30–0.41) carry
    4 or more decimals.
  - But 6,863 stored rows at or above $1 carry more than two decimals: ADBE 2,716, BA 1,991,
    AMD 1,665, AAL 472.
  - NVDA's rows below $1 carry up to 8.
  - A re-base rounds every row independently, so a detector needs a per-row tolerance with a
    floor (0.01 at or above $1, 0.0001 below), not one relative threshold.
- **Timing: not observable from stored data.** Every stored row was fetched after the last event
  in it.
  - `evidence/rebase-observation-baselines.csv` captures anchor and recent rows for GPMT, whose
    provider calendar lists a 1:10 reverse split on 2026-10-06, and for DXJ, a 3:1 split on
    2026-10-09.
  - Re-reading those rows daily around the ex-dates measures when the provider re-bases, and
    whether it re-bases the anchor and the tail together.
- **What the loader does today:**
  - it re-reads ten days;
  - it saves them before anything checks for a basis change;
  - it rebuilds derived state from the tail's start in a second transaction;
  - it republishes the touched years one key at a time.

  The history before the tail keeps the old basis, so every price-derived series gains a
  split-sized step (B2).

- **Two hazards grow from small to material once a full-history replacement is possible:**
  - A reader that passes the `READY` check just before a republish can `MGET` a mix of old and
    new years.
  - A running backtest reads its later years after the event and its earlier ones before it.
- **Further gaps, found by the clean-room review:**
  - **Prefix widening.** `hydrateWithinLease` fetches only the missing interval, with no overlap
    with stored rows. A widening after a re-base therefore puts a new-basis prefix beside
    old-basis rows, and no test sees it.
  - **Rows outside coverage.** CRWD has rows from 2019-06-12 under v3 coverage from 2021-08-19.
    MSFT has rows from 1992-09-09 under coverage from 1992-09-22. 26 securities hold rows before
    today's retention start. The derived rebuild reads from the earliest stored row
    (`EARLIEST_PERSISTED_PRICE_DATE`), so a replacement must cover those rows too.
  - **An ex-date row before the rewrite.** If the provider publishes the ex-date row in the new
    basis before it rewrites the older rows, nothing stored changes, and the tail save commits a
    split-sized step.
  - **The Monitor on an ex-date.** It appends the live quote, already post-event, to closed
    history that has not been re-based, and recomputes moving averages and RSI over both. A 4:1
    day reads −75 % against every moving average, and the resulting Signals are permanent.
  - **The benchmark cache** has no `HYDRATING`/`READY` manifest or generation.

## 7. External sources

The research agent's full report (vendor documentation quotes, URLs, demo results) was the input
to `docs/decisions/historical-price-basis-v1.md` §6 and its licensing table. The findings that
decide the gate:

| Source                                              | As-traded close                                                              | Spin-offs                                                                 | History                                           | Commercial display of derived values                                                 | Cost (published)                        | Status for FactorSage                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------- |
| FMP (current)                                       | none on this plan                                                            | folded into the adjusted series as splits                                 | 1990s                                             | individual plans exclude display; a Data Display and Licensing Agreement is required | contact sales                           | no as-traded record                                                   |
| Alpha Vantage                                       | `TIME_SERIES_DAILY`, validated for IBM (§2.4)                                | listed as splits (`split coefficient` 1.046)                              | from 1999-11                                      | ToS: commercial use by contact only                                                  | premium $49.99–249.99/mo buys rate only | plausible raw close; history short of 1996; licence unknown           |
| Tiingo                                              | `close` (raw) and `adjClose`                                                 | `splitFactor` "…or pays a distribution"                                   | from 1962; delisted if the ticker is not recycled | "EOD + IEX Redistribution/Display" plan                                              | $250/mo (80k entities), $500/mo (1.2M)  | best published licence; raw close and derived-metric scope unverified |
| Sharadar (Nasdaq Data Link)                         | `closeunadj`; `close` is split-only, `closeadj` adds dividends and spin-offs | typed `spinoff` / `spinoffdividend` actions                               | from 1998                                         | sharadar.com licence is personal-only; professional via Nasdaq                       | contact sales                           | best semantics; licence and pre-1998 unknown                          |
| Intrinio                                            | `close` and `adj_close`, per-bar `factor`                                    | undocumented                                                              | "50+ years"                                       | Startup and Enterprise include "Commercial Use and Display Rights"                   | $333 → $999/mo; $1,250+/mo              | licensable; semantics unverified                                      |
| CRSP (Morningstar)                                  | `PRC`; `CFACPR` ≠ `CFACSHR`, `FACSHR` = 0 for spin-offs                      | the reference treatment                                                   | from 1925                                         | written permission required                                                          | contact sales                           | reference method; commercial terms unknown                            |
| EODHD                                               | documented "as traded", observed reconstructed                               | undocumented; a third-party test found the close off by a spin-off factor | from 1962                                         | Enterprise (display unverified)                                                      | $2,499/mo                               | rejected as a reference                                               |
| Massive (Polygon)                                   | `adjusted=false`                                                             | typed share-change events only                                            | from 2003                                         | Business plan                                                                        | $2,499/mo                               | too shallow                                                           |
| Norgate, Kibot, Finnhub                             | —                                                                            | —                                                                         | —                                                 | personal or internal use only                                                        | —                                       | not licensable                                                        |
| FirstRate, Algoseek, Databento, Alpaca, Marketstack | —                                                                            | —                                                                         | from 2000, 2007, 2018, 2016, and 10–15 years      | —                                                                                    | —                                       | too shallow                                                           |

- **Two factors are institutional practice.** CRSP, Compustat, Sharadar, Algoseek, Xignite and
  Norgate each keep one factor for share-changing events and treat a spin-off as price-only.
  CRSP: "For spin-offs, Factor to Adjust Shares Outstanding is set to zero." Retail APIs that
  fold spin-offs into a split factor are the exception: FMP, Alpha Vantage and Tiingo.
- **Exchange fees.** The obligations fall on the vendor that ingests exchange feeds. Nasdaq's
  policy treats end-of-day information on an uncontrolled product as typically not needing a
  recipient agreement. NYSE requires a licence for later redistribution of real-time proprietary
  data. Massive, Intrinio and EODHD state that their plans carry no exchange fees for historical
  data. A contract must say so for FactorSage's use.
- **Alpha Vantage's `demo` key served research only.** Its terms put commercial use behind a
  contact, so validation data from it is evidence, not product input.
- **FMP's own display rights are open**: owner input O11 in
  `docs/legal/owner-inputs-and-review.md`. Its individual plans exclude display to end users.
  Every basis in the decision is built on FMP's prices.

## Reproducing

The probes were one-off scripts, kept out of the repository as the prior gate's were. What they
did, precisely enough to redo:

- **Stored data**, against `intrinsic_value` with
  `docker exec -i factorsage-postgres-1 psql -U intrinsic -d intrinsic_value`:
  - the prior gate's queries for the latest quarterly revisions and the insider median;
  - `DailyPrice (symbol, date, close, open, high, low, volume)`;
  - `InsiderTransaction` rows with `transactionCode in ('S','P') and price > 0` (security name
    sanitised of tabs and newlines);
  - the latest quarterly `CASH_FLOW` revision's `commonDividendsPaid`;
  - `DailyDerivedState` joined to `DailyPrice` for the seven intrinsic columns and their
    `*SourceAsOf` presence.
- **Containment:** for each trade on a stored session, keep it at factor `A` when
  `low·A·0.995 ≤ price ≤ high·A·1.005`. The 95 % interval is the range of factors admitted by at
  least 95 % of a window's `[price ÷ (high·1.005), price ÷ (low·0.995)]` constraints.
  - Class filters: GOOGL excludes Class B and Class C names; GOOG keeps Class C; BRK-A excludes
    Class B; NKE excludes Class A.
  - Preferred stock, options, warrants, notes, units and rights are excluded everywhere.
- **Provider-implied factor** for a window: the product of `stable/splits` ratios dated after the
  window's end.
- **Share factor** per quarter with exactly one ex-date in it: Σ declared `dividend` ÷
  (`|commonDividendsPaid|` ÷ restated `weightedAverageShsOutDil`).
- **The `Value & Trend` counts** read the Balanced blend column. A first run read the
  Conservative column by mistake and reported 4,635 and 4,369. The clean-room review caught it.
- **Margin of Safety impact:** for each session and each series with a positive value (the four
  models only with their provenance instant), `stored = (IV − c) ÷ IV`,
  `asTraded = (IV − c·Φ) ÷ IV`. `Φ` is the product of the measured steps with an ex-date after
  the session: MMM 1.1963; WDC 1.323; IBM 1.046; MRK 1.048; AXP 1.1326; HON 1.906 at 2026-06-29,
  1.0601 at 2025-10-30 and 1.049 at 2018-10-29.
- **Provider requests (500 FMP in all; 497 answered, 2 × 402, 1 × 403):**

  | Endpoint                                                                                             | Requests |
  | ---------------------------------------------------------------------------------------------------- | -------- |
  | `stable/splits`                                                                                      | 335      |
  | `stable/insider-trading/search`                                                                      | 122      |
  | `stable/dividends`                                                                                   | 13       |
  | `historical-price-eod/full`                                                                          | 10       |
  | `splits-calendar`                                                                                    | 3        |
  | `dividend-adjusted`                                                                                  | 3        |
  | `historical-market-capitalization`                                                                   | 2        |
  | `historical-chart/1hour`                                                                             | 2        |
  | `enterprise-values`                                                                                  | 2        |
  | `company-screener`                                                                                   | 2        |
  | `key-metrics`, `non-split-adjusted`, `light`, `eod-bulk`, `earnings`, `api/v3/historical-price-full` | 1 each   |

  Plus one Alpha Vantage demo request (IBM `TIME_SERIES_DAILY`, `outputsize=full`) and one
  refused SEC request. The clean-room review made 7 further FMP requests (HON as-reported
  statements, WDC insider pages) and one Alpha Vantage demo request of its own.
