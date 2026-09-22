# FactorSage data-correctness audit: final report

**Date:** 2026-09-22.
**Branch:** `audit-large`.
**Dataset:** the frozen QA-matrix database `intrinsic_value_matrix`, with data as of the
2026-09-21 session. This is a read-only copy of the development database's canonical market data.
**Command:** `pnpm audit:data-correctness` (see [README](README.md)).
**Evidence:** `artifacts/data-correctness-audit/`. The main files are `manifest.json`, `SUMMARY.md`
and one directory per section.

Related documents:

- [CORRECTNESS_MAP.md](CORRECTNESS_MAP.md): where every value comes from.
- [EXISTING_TEST_AUDIT.md](EXISTING_TEST_AUDIT.md): what the existing tests prove and what they
  do not.

## Executive summary

The audit asked whether FactorSage computes the right value from the same inputs, and whether the
user is shown exactly that value.

**Backtests.** All 1,000 matrix scenarios were run through the real API and worker. They were then
re-executed by an independent reference backtester that imports no production logic. Every scenario
matched exactly:

| Output compared                                             |      Count |   Mismatches |
| ----------------------------------------------------------- | ---------: | -----------: |
| Trades, every field                                         |    184,692 |            0 |
| Daily equity rows                                           |  3,620,600 |            0 |
| Benchmark rows                                              |  3,620,600 |            0 |
| Summary metrics (money exact, ratios at their stored scale) |     23,000 |            0 |
| Annual returns                                              |     15,400 |            0 |
| Ledger steps reconstructed                                  |  3,805,292 |            0 |
| Invariant checks                                            | 23,459,537 | 0 violations |

- **API.** For all 1,000 runs, the Backtests service returns the same numbers the oracle expects:
  1,761,982 comparisons, 0 failures.
- **Browser.** On 10 representative runs, what the page shows matches: 729 checks, 0 failures.

**Calculated series.** Independent recomputation over the full history of all 33 matrix securities
agrees with the stored values:

| Series                                                     | Comparisons | Failures | Explanation                                  |
| ---------------------------------------------------------- | ----------: | -------: | -------------------------------------------- |
| Technical indicators                                       |   3,983,691 |      146 | All in EMA 200W, all at most 2.1e‑8 (AUD-02) |
| Intrinsic values and blends                                |   2,459,422 |        0 | Unavailable days included                    |
| IV point-in-time checks                                    |     921,487 |        0 |                                              |
| Every operand a backtest decided from ("frame provenance") |   3,511,155 |        0 |                                              |

**Monitor, Signals and Dashboard.** Two real Monitor cycles ran on real data. Across the reference
lifecycle, the persisted state and Signals, and the Dashboard service, there were 1,525
comparisons and 0 failures. That includes 327 checks that a Signal which should not exist is
absent. The Dashboard in the browser showed exactly the expected rows: 53 checks, 0 failures.

**Stock Details.** On 10 deliberately different symbols, the DB, the reference series and the API
agree: 71,692 comparisons, with 32 failures (the same EMA 200W effect as above). The page agrees
with them: 466 checks, 0 failures.

**The audit found real defects:**

- **AUD-03 (High, not fixed):** point-in-time look-ahead from provider filing dates. 2,391 of
  16,793 statements have a provider filing date on or before the fiscal period end, so FactorSage
  treats them as public the day after the quarter closed. It changes the trades of 9 of the 100
  Margin-of-Safety matrix runs, by up to 4.5% of final value.
- **AUD-04 (Medium, fixed):** the price loader could permanently miss a real trading session, or
  keep an in-session bar as final history, while its coverage record claimed the data was complete.
  It was found in live data for MRNA, GOOG, BRK-A, ADBE and AAL. It is fixed for both the stock
  loader and the benchmark loader, with regression tests.
- **Four lower-severity findings** (AUD-01, 02, 05, 06): precision, reproducibility and
  presentation issues. None of them changes a matrix decision.

**What this does not show:**

- That FactorSage is correct outside what was compared. See [Remaining risks](#remaining-risks).
- That provider data is right. Raw provider data was compared only for 6 symbols plus SPY, and
  against one fetch.

Manifest totals: 69,806,380 comparisons.

| Result                                      |      Count |
| ------------------------------------------- | ---------: |
| Passed                                      | 69,806,192 |
| … of which passed within a stated tolerance |  7,694,153 |
| Failed                                      |        188 |
| Skipped                                     |          0 |

Every one of the 188 failures is explained by AUD-02, AUD-03 or AUD-04.

## Scope

The audit covers source prices, statements and splits; technical indicators; intrinsic values and
blends; Strategy evaluation; Lists and Buy Windows; the Monitor lifecycle and Signals; the
Dashboard; Stock Details; the backtest engine, ledger, benchmark, metrics, annual returns and final
liquidation; the Backtest Results UI; and look-ahead.

## Methodology

The audit relies on four kinds of evidence. They differ in what they can prove.

1. **Production tests.** These are the existing suites. [EXISTING_TEST_AUDIT.md](EXISTING_TEST_AUDIT.md)
   classifies them. They were run unchanged as part of the gate.
2. **Independent oracle verification.** The reference implementations live in
   `apps/api/src/data-correctness-audit/oracle/`:
   - indicators;
   - the intrinsic-value engine;
   - predicates and the Monitor lifecycle;
   - the reference backtester.

   Each one was written from the product documents and ADRs. ESLint rejects any import of
   `@intrinsic/*`, Prisma or parent directories there. The oracle's own correctness comes from
   hand-computed and externally published values: the ADR golden vectors and Wilder's RSI example
   (`oracle/oracle.test.ts`). Negative controls in `backtests/audit-case.test.ts` show that the
   comparison fails on a one-ULP price, a missing trade, a $0.000001 cash difference, a 1e‑10
   index difference, and a BUY outside its window.

3. **Invariants.** These are properties that must hold whatever the expected output is:
   - cash never negative;
   - no orphan sells;
   - shares equal the reconstructed position;
   - `amount = shares × price`;
   - `cash + positions = total`;
   - BUY only inside a window;
   - execution price equal to that date's close;
   - equity dates are execution dates;
   - positions never exceed `maximumPositions`.

   These run on every row of every run.

4. **End-to-end reconciliation.** Four paths are checked:
   - database to service (Prisma rows against `BacktestsService` and `DashboardService`, called
     in-process);
   - HTTP (`GET /stocks/:symbol`);
   - a real browser (Playwright, `apps/web/e2e/data-correctness/`) on an API and web stack that
     the audit starts and points at the matrix database;
   - a real Monitor cycle in the worker (`apps/worker/src/monitor/data-correctness-scan.ts`) at a
     past session, with that session's close as the quote.

The expected display strings are formatted with `Intl.NumberFormat` under the documented display
rules, not with the web app's own helpers.

**Tolerances.** A tolerance is used only where a value is stored as a rounded float:

- `Decimal(20,8)` series get half a unit in the 8th decimal plus 1e‑12 relative.
- Margin of Safety adds the derivative of that quantization.

Money, shares, prices, dates, counts and states are all compared exactly. Stored ratios (such as
the returnIndex and percentages) are compared exactly **at their stored scale**. That uses the
write path the audit measured (AUD-01).

## Existing test assessment

In brief: before this audit, "1,000 matrix runs green" meant the runs completed and were internally
consistent. 40 invariants were re-derived from persisted rows.

Nothing independently re-derived:

- which trades a strategy should make;
- SELL, FINAL EXIT or Gain/Loss decisions;
- annual returns, CAGR or drawdown.

Frame-level BUY signals were checked only for the 6 golden cases that had archives.

Elsewhere:

- The Dashboard and Stock Details E2E suites checked structure against hand-seeded rows and never
  compared a displayed number with a backend number.
- The weekly EMA and EMA 200W stored history had never been compared against a recomputation over
  real data.

Details are in [EXISTING_TEST_AUDIT.md](EXISTING_TEST_AUDIT.md).

## Source data

`source-data/summary.json`, with raw provider snapshots frozen under `source-data/raw/`
(git-ignored):

| Check                                                                                                            |       Compared | Failed |
| ---------------------------------------------------------------------------------------------------------------- | -------------: | -----: |
| Daily OHLCV of AAPL, NVDA, KO, MRNA, DIS and GOOGL over full history (1992–2026)                                 | 200,861 fields |      9 |
| SPY execution-calendar closes                                                                                    |          7,556 |      0 |
| Split adjustment (12 splits since 1992: AAPL 2:1 ×2, 7:1, 4:1; NVDA 2:1 ×3, 3:2, 4:1, 10:1; GOOGL 999:500, 20:1) |             12 |      0 |
| Income-statement values and filing dates of KO, AAPL and DIS against the provider (40 quarters each)             |            720 |      0 |

Every split is adjusted: the day-over-day ratio on each split date stays between 0.86 and 1.10. The
persisted series is split-adjusted and not dividend-adjusted, as documented.

The 9 price mismatches are all dated 2026-09-03 or later. They are AUD-04:

- MRNA 2026-09-09 has close 137.395 and volume 3.9M, against the final 135.61 and 8.65M.
- MRNA is missing 2026-09-04.
- AAPL and NVDA 2026-09-08 have late volume corrections.

## Stock Details

`stock-details/summary.json` and `ui/observed.json`. The 10 symbols were chosen for their
differences:

| Symbol     | Why it is in the set                                  |
| ---------- | ----------------------------------------------------- |
| KO         | Dividend payer (DDM and the Dividend blend available) |
| AAPL, NVDA | Split history                                         |
| MRNA       | Short history and losses (IV partly unavailable)      |
| AMZN       | No dividend (DDM and the Dividend blend unavailable)  |
| DIS        | Filing-date anomaly                                   |
| V          | Listed in 2008                                        |
| GOOGL      | Entity change                                         |
| CRM        | Dividend initiated in 2024                            |
| XOM        | Cyclical losses                                       |

| Category                                                          | Compared |      Failed |
| ----------------------------------------------------------------- | -------: | ----------: |
| API prices (OHLCV, one-year window)                               |    2,529 |           0 |
| API technical values                                              |   42,823 | 32 (AUD-02) |
| API intrinsic points, including availability and `sourceDataAsOf` |   26,330 |           0 |
| UI                                                                |      466 |           0 |

The UI checks cover the latest close, the change, the as-of date, previous close, day range,
52-week range, volume, every blend tile and model row, and every moving average.

Exact semantics:

- **Latest price** is the last persisted bar, which can be the in-progress session.
- **Change** is taken between the last two bars.
- **52-week range** is the min and max over the loaded one-year window.
- **There is no separate quarterly intrinsic table.** The "quarterly" history is the daily series,
  carried forward, stepping at each filing event.

## Technical indicators

`technicals/summary.json`. The audit covered all 17 series FactorSage exposes:

- SMA 20, 50, 100 and 200, daily and weekly;
- EMA 20, 50 and 200, daily and weekly;
- RSI 7, 14 and 21.

It covered every stored row from 1996-09-10 onward for 33 securities, plus 429,675 warm-up-region
comparisons (0 failed).

| Series              | Result                                                                               |
| ------------------- | ------------------------------------------------------------------------------------ |
| 16 of the 17 series | 0 failures                                                                           |
| EMA 200W            | 146 of 234,294 fail, all in 2026-08/09 rows, with a maximum \|Δ\| of 2.1e‑8 (AUD-02) |

- Warm-up absence matched exactly: no value is stored where the reference has none, and none is
  missing where it has one.
- The weekly source week matched on every row: 0 mismatches. The stale-Friday scenario raised by
  code review did not occur in this data.

## Intrinsic value

`intrinsic/summary.json` and `intrinsic/<SYMBOL>.json`, which includes `quarterlyHistory`. These
are the results for all four models and three blends over 234,360 visible trading days:

| Model           | Present | Absent (unavailable) | Failed |
| --------------- | ------: | -------------------: | -----: |
| DCF (FCFF)      | 211,914 |               22,446 |      0 |
| Residual Income | 210,635 |               23,725 |      0 |
| DDM             | 183,869 |               50,491 |      0 |
| Graham          | 212,484 |               21,876 |      0 |
| Balanced        | 187,907 |               46,453 |      0 |
| Conservative    | 187,907 |               46,453 |      0 |
| Dividend        | 160,087 |               74,273 |      0 |

- **Values.** The largest difference was below 5e‑9, the storage quantum. Provenance
  (`*SourceAsOf`) was also compared, with 0 failures.
- **Unavailable conditions.** These matched the ADR exactly. They include: a missing TTM window,
  a missing latest state, a missing field, non-positive FCFF, EPS, dividend or book value, and the
  currency rules.
- **Point in time.** Provenance was never after the row date (921,487 checks). Availability was
  never earlier than the filing date plus one day, across 16,793 statements.
- **Look-ahead.** The engine applies its rule correctly. The inputs make it look ahead: see AUD-03.

## Strategies

`strategies/differential.json` and `strategies/real-frame-evaluation.json`.

- **Operators at their boundaries.** Strictness, the inclusive 2% `is close to`, a zero comparison
  value, and NaN/Infinity: 960 cases, 0 failures.
- **Random Signal compositions.** Frames with holes: 12,000 evaluations, 0 failures.
- **FINAL EXIT.** OR of ANDed Exit Rules over every tri-state combination: 81 cases, 0 failures.
- **Real matrix frames.** The production `buildStrategyGates` was compared with the reference
  evaluator for every level, security and simulated date of the 100 C01 runs (30 years): 17,748,544
  comparisons, 0 failures. That includes 5,931,719 TRUE days and 331,302 NOT_EVALUABLE days.
- **Gain/Loss decisions.** These cannot be precomputed. They are verified through the exact ledger
  equality of the strategies that use them (S05, S06, S08, S10).

## Lists and Buy Windows

`lists/buy-windows.json`.

**Differential test.** 1,508 range sets were checked, covering leap day, month and year boundaries,
overlap, adjacency, nesting and open-ended windows. Each was probed on 93 days, with normalization
checked for canonical form and idempotence: 283,598 comparisons, 0 failures.

**Matrix evidence** (69,115 trades in lists that have CUSTOM windows):

| Trades                                       |  Count |
| -------------------------------------------- | -----: |
| BUYs inside a window                         | 19,885 |
| BUYs outside a window                        |  **0** |
| BUYs exactly on a window's start date        |    423 |
| BUYs exactly on a window's end date          |    136 |
| SELLs outside a window (exits are not gated) |    135 |
| FINAL EXITs outside a window                 |    684 |
| Liquidations outside a window                |    335 |

The reference backtester applies the same rule independently, and it matched all 1,000 runs.

## Monitor and signals

`signals/summary.json`. Six audit Monitors were created through `MonitorsService`, covering:

- Conditions only;
- Trigger only, both a BUY and a FINAL EXIT;
- Conditions plus a Trigger;
- an RSI ladder on boundary buy windows;
- weekly averages on a mixed list;
- RSI events.

Levels that use Gain or Loss were correctly skipped. The real worker cycle ran on 2026-09-17 (by
reconstruction) and then on 2026-09-18.

| Session    | (member, level) pairs | ACTIVE | Absent, and checked absent |
| ---------- | --------------------: | -----: | -------------------------: |
| 2026-09-17 |                   191 |     29 |                        162 |
| 2026-09-18 |                   191 |     26 |                        165 |

- **Transitions.** 26 occurrences continued without a new Signal, 3 ended on 2026-09-18 with a
  reason, and none opened.
- **Duplicates.** There was never more than one open Signal per level.
- **Result.** 1,525 comparisons, 0 failures.

Not exercised by real data on these sessions: a `PENDING_TRIGGER` setup, and a new occurrence
opening on the second session. The reducer's scripted unit suite covers both. The audit's own
lifecycle tests cover them against the reference only in constructed inputs; see Remaining risks.

## Dashboard

`dashboard/reconciliation.json` and the `ui-dashboard` checks.

- **Service.** `DashboardService` rows were compared with the expected set: presence, state,
  observation date, price, percentage, strategy and list. There were no extra or duplicate rows,
  and every expected-absent pair was confirmed absent: 661 comparisons, 0 failures.
- **Browser.** The page shows the same rows with the right action, state and price: 53 checks, 0
  failures.
- **AUD-05.** The "Since" column shows the scan time for reconstructed rows.

## Backtest

`backtests/summary.json`, `backtests/index.json`, and `backtests/scenario-NNNN-Sxx-Lxx-Cxx.json`
(one per run).

**The sweep** was `2026-09-22-20260922-145032`. The matrix gate was GREEN:

- 1,000 of 1,000 runs completed;
- 0 invariant failures;
- 0 provider requests;
- 0 differences in the 6 golden reruns (determinism);
- invariants 36–38, which need archives, verified for **all 1,000**. Before this audit they were
  verified for 6.

|                                                                             |                                              |
| --------------------------------------------------------------------------- | -------------------------------------------: |
| Backtest scenarios                                                          |                       **1,000 / 1,000 PASS** |
| Scenarios with zero trades (expected, e.g. S06 and short periods)           |                                          105 |
| Trades compared (18 fields each)                                            |                                      184,692 |
| Trade mismatches                                                            |                                            0 |
| Equity rows compared (8 fields each)                                        |                                    3,620,600 |
| Equity mismatches                                                           |                                            0 |
| Benchmark rows compared                                                     |                      3,620,600, 0 mismatches |
| Summary metric comparisons                                                  |                         23,000, 0 mismatches |
| Annual returns derived and chain-checked                                    |                                       15,400 |
| Final-liquidation checks                                                    | 12,000, 0 failures (2,806 liquidation sales) |
| Ledger reconstruction steps                                                 |                      3,805,292, 0 violations |
| Invariant checks                                                            |                     23,459,537, 0 violations |
| Input checks (calendar, benchmark closes, frame closes, skipped securities) |                           26,200, 0 failures |
| Archive result vs persisted rows (persistence fidelity)                     |                            3,000, 0 failures |
| Largest run                                                                 |                   S10-L08-C10, 10,893 trades |

An example of the evidence, from `backtests/scenario-0979-S10-L08-C09.json`, trade 1:

```text
2016-09-23 CRM BUY — "BUY 100% level s10-buy2 TRUE (new position)"
execution price expected 70.39000000   actual 70.39000000
cash before 100000.000000
sizing: portfolio 100000, full-position budget 100000, target 100000, shortfall 100000
shares expected 1420.6563432305        actual 1420.6563432305
amount expected 100000.000000          actual 100000.000000
cash after expected 0.000000           actual 0.000000
final value expected 470046.640823     actual 470046.640823   PASS (29,802 comparisons)
```

## Look-ahead bias

`lookahead/` and the `look-ahead` section.

- **Engine.** For 60 runs, the production engine was re-run with every observation after the
  midpoint replaced by adversarial values. Every trade and every equity row up to the cut stayed
  identical: 22,685 trades and 150,930 equity rows, 0 differences. **The engine does not read the
  future.**
- **Indicators.** The reference indicators are strictly causal. The stored values match them, and
  weekly values become effective only on their week's last trading day. **No indicator uses a
  future close.**
- **Intrinsic engine.** It uses only statements with `availableFromDate ≤ D`: 0 of 921,487 PIT
  violations. **The rule is applied correctly.**
- **Filing dates (AUD-03, look-ahead in the inputs).** The provider reports the fiscal period end
  as the filing date for 2,391 statements. Two examples:
  - DIS before its 2019 restructuring: 360 statements.
  - GOOGL before Alphabet's 2015-Q3: 195 statements.

  FactorSage therefore treats those results as public the day after the quarter ended.

- **Filing-date impact.** Statements were re-dated to the SEC large-accelerated-filer deadlines (40
  days after a quarter, 60 after a fiscal year). Under that assumption, **9 of 100 S09 runs trade
  differently**. For example, S09-L08-C01 ends 4.47% higher without the look-ahead, and
  S09-L06-C01 2.76% higher. This is an estimate under a stated assumption.
- **List membership and Buy Windows.** They are frozen in the run snapshot, and no BUY falls outside
  its frozen window.
- **Benchmark.** It is based at the first simulated date and uses the close at or before each date.
  It matched the oracle on 3,620,600 rows.

## Benchmark

This is the funded S&P 500 (SPY) scenario: shares bought with each external cash flow at that
date's close, and values carried forward.

- **Rows.** The benchmark index and value matched the oracle on all 3,620,600 rows.
- **Metrics.** Benchmark return and benchmark max drawdown matched on all 1,000 runs.
- **Source.** The SPY closes match the provider on all 7,556 sessions.
- **UI.** The chart shows 3 series over the right span on the 10 UI runs.

## Metrics

These are the metrics the product displays. Each was recomputed independently from the reference
ledger and equity series.

| Metric                | Definition as implemented and documented                                                                                               | Checked                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Portfolio return      | (time-weighted index − 1) × 100. The index is `index(d-1) × value(d) / (value(d-1) + contribution(d))`                                 | 1,000 runs, exact at numeric(20,8)                       |
| Benchmark return      | Benchmark close ÷ close in effect on the first date, minus 1                                                                           | Same                                                     |
| Excess return (alpha) | Portfolio return − benchmark return                                                                                                    | Same                                                     |
| CAGR                  | index^(1/years) − 1, with years = calendar days ÷ 365.25                                                                               | Same                                                     |
| Max drawdown          | Largest decline of the index from its running peak                                                                                     | Same                                                     |
| Portfolio value       | Final value                                                                                                                            | Exact                                                    |
| Net profit            | Final value − invested capital                                                                                                         | Exact                                                    |
| Trades                | Count, including liquidation sales                                                                                                     | Exact                                                    |
| Annual returns        | Year-end index ÷ previous year-end index, minus 1; partial when the requested period starts after 1 January or ends before 31 December | 15,400 years; each run's years chain to its total return |

For annual returns:

- The API derives them from the index as stored (AUD-01). The largest difference from the
  unrounded index is 2.9e‑8 percentage points, invisible at 2 decimals.
- A figure is never cumulative.

## UI reconciliation

`ui/observed.json`: 1,248 checks, 0 failures.

**Backtest Results** (10 runs, 729 checks):

- all 8 tiles;
- every annual return and its partial flag;
- chart series, point count and span;
- the configuration: period, capital, contribution and stocks;
- the newest 5 trade-log rows: date, symbol, action, reason, amount, "shares @ price" and realized
  P&L;
- the trade-log total.

**Stock Details** (10 symbols, 466 checks).

**Dashboard** (53 checks).

The three stages of a number are each explained. For example, the oracle's raw CAGR is rounded to
numeric(20,8) by the database. The API serves that number, and the page prints it with 2 decimals
and a sign.

## Bugs discovered

| Id     | Severity      | Subsystem                               | Status                                          |
| ------ | ------------- | --------------------------------------- | ----------------------------------------------- |
| AUD-04 | Medium        | Price and benchmark loading             | **Fixed** (`b4e45c80`)                          |
| AUD-03 | High          | Fundamentals point in time (input data) | Documented, not fixed: needs a product decision |
| AUD-05 | Low–Medium    | Dashboard "Since"                       | Documented                                      |
| AUD-02 | Low           | EMA reproducibility                     | Documented                                      |
| AUD-06 | Low           | QA-matrix provisioning                  | Documented                                      |
| AUD-01 | Informational | Persistence precision                   | Documented                                      |

### AUD-04: a missed session or an in-session bar becomes permanent history (fixed)

**Examples.** The development database is missing real sessions: MRNA, GOOG and BRK-A on
2026-09-04, and ADBE and AAL on 2026-09-16. Its `StockDatasetCoverage` nevertheless claims
continuous coverage. MRNA 2026-09-09 is stored as 137.395 / 3.9M, an in-session snapshot. The
final bar is 135.61 / 8.65M.

**Root cause.** A price sync marks coverage through the UTC day. In the New York evening, that date
has no session yet. The sync also persists the current session's in-progress bar. Later syncs only
re-read the ten days behind _today_. A gap fill that reached today even marked the tail fresh
without re-reading it. So once the next sync came more than ten days later, the missing or
provisional date was never read again.

The exact mechanism is reproduced by the new tests. Both fail before the fix and pass after it:

- in `packages/stock-data/src/service.test.ts`, "fetches a session later when it was not yet
  published", and "replaces an in-session bar with the final one however long the next read takes";
- in `benchmark-data.integration.test.ts`, the equivalent test for the benchmark loader.

**Fix.** Every leading-edge sync (a tail refresh, or a gap fill that reaches today) also re-reads
the previous sync's own tail window (`unsettledTailStart`). Every date is therefore fetched again
once after it settles. This applies to both the stock loader and the benchmark loader. The
benchmark loader matters most: its bars are the backtest execution calendar. No revision bump was
needed, because no stored value is reinterpreted. `ai/architecture/deep-discovery.md` §3 is
corrected.

**Not repaired automatically.** Rows already damaged before the fix are re-read only when a later
sync reaches back over them. That is 5 sessions in the development database, and MRNA 2026-09-04
in the matrix copy. Repairing them needs either a targeted re-sync or a `PRICE_DATASET_VERSION`
bump. That is an operator decision.

### AUD-03: statements treated as public before any filing existed (not fixed)

**Example.** DIS FY2018: fiscal period end 2018-09-29, provider `filingDate` 2018-09-30. FactorSage
makes it available on 2018-10-01. The actual 10-K was filed in late November 2018.

**Root cause.** The provider supplies the period end when it has no filing date. The ADR defines
availability as `filingDate + 1` and has no plausibility guard.

**Impact.** 2,391 of 16,793 statements. The engine applies its rule correctly; the input violates
the invariant that fundamentals must stay point-in-time correct (AGENTS.md invariant 4). 9 of 100
Margin-of-Safety runs trade differently when it is corrected.

**Recommended fix.** This needs a product decision, and was not implemented. When
`filingDate ≤ fiscalDate`, derive availability as `fiscalDate + regulatory deadline`, or treat the
statement as not point-in-time usable. That requires a fundamentals variant or derived-state
revision bump and a rebuild. `lookahead/filing-date-impact.json` shows the impact of the 40/60-day
choice.

### AUD-05: the Dashboard "Since" column shows the scan time for reconstructed signals

**Example.** AMZN (S01 × L08) has been ACTIVE since 2026-07-30. Its `since` field is the scan
instant, 49 days later, so the page says the state began "just now". This happened on 26 of the 26
reconstructed rows.

**Root cause.** Reconstruction stamps `lifecycleSince` with the cycle's wall clock. The web page
deliberately does not render `observationDate` or "from history" (DashboardPage.tsx), which
contradicts `ai/product/monitors.md`.

**Not fixed.** It is a presentation decision. Either render the activation session, or stamp the
activation session's close.

### AUD-02: stored EMA values depend on when the derived state was rebuilt

**Example.** KO EMA 200W on 2026-09-18: the stored value differs from a recomputation over the same
stored closes by 1.5e‑8. Recomputing from a history start 13 days later changes KO's 1997 EMA 200W
by 0.057.

**Root cause.** EMA has infinite memory, and it is seeded at the start of the retained history.
That start moves with the clock (today − 34 years). Incremental rebuilds therefore seed different
rows from different starts. The 200-week warm-up leaves about e^-2, or 13.5%, of the seed's weight
at the horizon start.

**Impact.** No matrix Strategy uses weekly EMAs, so no decision changed. Every one of the 146
technicals failures and the 32 Stock Details failures is this effect. The largest is 2.1e‑8.

**Recommended.** Anchor the seed to a fixed epoch, or document the non-convergence.

### AUD-06: the QA-matrix copy keeps stale rows

`provision-matrix-database.ts` inserts with `skipDuplicates`. A row the development database later
corrected keeps its old value in the matrix copy. For example, ADBE 2026-09-09 is 255.7246 / 1.17M
in the matrix copy and 254.86 / 4.17M in development.

This affects only the audit and QA environment. It did not affect this audit's equality checks,
because both sides read the same copy. It does mean the "canonical" copy can hold provisional bars.

### AUD-01: float ratios are rounded twice on their way into PostgreSQL

**Evidence.** Prisma 6 converts a JS `number` bound to a Decimal column to 16 significant digits.
PostgreSQL then rounds that at the column scale. This model matched all 289,728 persisted ratios
sampled. Correct rounding of the float matched 289,474 of them. Across the matrix, 5,817 stored
`returnIndex` values differ by 1e‑10 from correctly rounded values.

**Impact.** At most 2.9e‑8 percentage points in annual returns. Nothing visible.

**Recommended.** Bind ratios as decimal strings if exactness at the stored scale matters.

## Remaining risks

- **Provider semantics.** The audit trusts the provider's split adjustment and statement values
  beyond the 6 symbols compared. Restated values (vintages) are not stored, so a historical
  restatement is invisible.
- **Filing-date look-ahead (AUD-03)** is unresolved.
- **Already-damaged price rows (AUD-04).** Rows damaged before the fix remain until they are
  re-synced.
- **Monitor coverage.** On real data, only 2 sessions and 6 Monitors were exercised. No
  `PENDING_TRIGGER` state and no second-session activation occurred on these dates. The Monitor's
  live frame recomputes daily indicators over a bounded window; that deliberate divergence
  (deep-discovery §5) was not provoked here.
- **UI breadth.** 10 backtest runs, 10 symbols and one Dashboard were checked in the browser, and
  only the newest 5 trade-log rows of each run. Mobile layouts were not checked.
- **Matrix scope.** Fees and slippage are zero in V1. Delisting is not modelled. The execution
  calendar is SPY bars.
- **Tolerances.** 7,694,153 comparisons passed within a stated tolerance: the storage quantum of
  `Decimal(20,8)` series plus float accumulation. No tolerance is relative to portfolio size.

## Final audit table

| Area                        |                    Comparisons |           Pass |         Fail | Skipped | Independent oracle | E2E verified      |
| --------------------------- | -----------------------------: | -------------: | -----------: | ------: | ------------------ | ----------------- |
| Source data                 |                        209,149 |        209,140 |   9 (AUD-04) |       0 | yes (raw provider) | —                 |
| Technical indicators        |                      3,983,691 |      3,983,545 | 146 (AUD-02) |       0 | yes                | via Stock Details |
| Intrinsic value             |                      2,459,422 |      2,459,422 |            0 |       0 | yes                | via Stock Details |
| Strategy evaluation         | 13,041 + 17,748,544 real-frame |            all |            0 |       0 | yes                | —                 |
| Lists and Buy Windows       |                        283,598 |        283,598 |            0 |       0 | yes                | via backtests     |
| Backtests (1,000 runs)      |                     57,509,875 |     57,509,875 |            0 |       0 | yes                | API + UI          |
| Frame provenance            |                      3,511,155 |      3,511,155 |            0 |       0 | yes                | —                 |
| Backtest API                |                      1,761,982 |      1,761,982 |            0 |       0 | yes                | yes               |
| Look-ahead                  |              2 checks + probes |              1 |   1 (AUD-03) |       0 | yes                | —                 |
| Monitor, Signals, Dashboard |                          1,525 |          1,525 |            0 |       0 | yes                | yes               |
| Stock Details API           |                         71,692 |         71,660 |  32 (AUD-02) |       0 | yes                | yes               |
| UI (Playwright)             |                          1,248 |          1,248 |            0 |       0 | yes                | yes               |
| **Total** (manifest)        |                 **69,806,380** | **69,806,192** |      **188** |   **0** |                    |                   |

The strategy real-frame comparisons are counted inside the Backtests row of the manifest.
