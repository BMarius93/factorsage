# FactorSage data-correctness audit: final report

**Date:** 2026-09-22. The audit and, later the same day, a remediation pass that fixed every
finding and re-ran the whole audit against the repaired data. The findings below are reported as
they were first found, each followed by what was done about it.
**Branch:** `audit-large`.
**Dataset:** the frozen QA-matrix database `intrinsic_value_matrix`. The first pass read data as of
the 2026-09-21 session; the rerun reads the 2026-09-22 session, after the price and benchmark
history was re-verified against the provider and the derived state rebuilt. This is a read-only
copy of the development database's canonical market data.
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
matched exactly. The counts are from the rerun on the repaired data; the first pass's are in
brackets where they differ:

| Output compared                                             |                Count |   Mismatches |
| ----------------------------------------------------------- | -------------------: | -----------: |
| Trades, every field                                         |  184,785 (184,692)   |            0 |
| Daily equity rows                                           | 3,621,000 (3,620,600)|            0 |
| Benchmark rows                                              | 3,621,000 (3,620,600)|            0 |
| Summary metrics (money exact, ratios at their stored scale) |               23,000 |            0 |
| Annual returns                                              |               15,400 |            0 |
| Ledger steps reconstructed                                  | 3,805,785 (3,805,292)|            0 |
| Invariant checks                                            |23,462,808 (23,459,537)| 0 violations |

- **API.** For all 1,000 runs, the Backtests service returns the same numbers the oracle expects:
  1,761,982 comparisons, 0 failures.
- **Browser.** On 10 representative runs, what the page shows matches: 729 checks, 0 failures.

**Calculated series.** Independent recomputation over the full history of all 33 matrix securities
agrees with the stored values:

| Series                                                     | Comparisons | Failures | Explanation                                        |
| ---------------------------------------------------------- | ----------: | -------: | -------------------------------------------------- |
| Technical indicators                                       |   3,983,283 |    **0** | 146 in the first pass, all EMA 200W (AUD-02, fixed) |
| Intrinsic values and blends                                |   2,459,197 |        0 | Unavailable days included                          |
| IV point-in-time checks                                    |     921,487 |        0 |                                                    |
| Every operand a backtest decided from ("frame provenance") |   3,511,665 |        0 |                                              |

**Monitor, Signals and Dashboard.** Two real Monitor cycles ran on real data. Across the reference
lifecycle, the persisted state and Signals, and the Dashboard service, there were 1,636
comparisons and 0 failures. That includes 326 checks that a Signal which should not exist is
absent, and — new in the rerun — that every row's "Since" is its own observation's session and a
reconstructed row's is exactly that session's close (`sinceLaterThanActivation: 0`, against 26 of
26 wrong in the first pass). The Dashboard in the browser showed exactly the expected rows at
desktop width and again at 390x844: 123 checks, 0 failures.

**Stock Details.** On 10 deliberately different symbols, the DB, the reference series and the API
agree: 71,433 comparisons, **0 failures** (32 in the first pass, the same EMA 200W effect as
above). The page agrees with them: 466 checks, 0 failures.

**The audit found real defects. All six are now fixed, and the rerun demonstrates it:**

- **AUD-03 (High):** point-in-time look-ahead from provider filing dates. 2,391 of 16,793
  statements have a provider filing date on or before the fiscal period end, so FactorSage treated
  them as public the day after the quarter closed. It changed the trades of 9 of the 100
  Margin-of-Safety matrix runs, by up to 4.5% of final value. Availability is now derived from the
  statutory deadline when the provider has no filing date, and the audit's independent probe finds
  **0 of 100** cases trading differently under its own deadline assumption.
- **AUD-04 (Medium):** the price loader could permanently miss a real trading session, or keep an
  in-session bar as final history, while its coverage record claimed the data was complete. Found
  in live data for MRNA, GOOG, BRK-A, ADBE and AAL. The loader was fixed with regression tests; the
  damaged rows have now been re-verified against the provider and replaced, and **0 of 36**
  securities miss a session inside their own range.
- **Four lower-severity findings** (AUD-01, 02, 05, 06): precision, reproducibility and
  presentation. None of them changed a matrix decision, and all four are fixed.

**The rerun also corrected two defects in the audit itself**, both of which would have reported a
product failure that was not one: the UI stage compared the page against the oracle's float instead
of the value FactorSage stores (a 1.4e‑14 difference becomes a whole cent at a display midpoint),
and the look-ahead section asserted a property of the provider's data (how many filings it leaves
undated) rather than the invariant that matters (that none of them is available too early). Both
are described under their findings.

**What this does not show:**

- That FactorSage is correct outside what was compared. See [Remaining risks](#remaining-risks).
- That provider data is right. Raw provider data was compared only for 6 symbols plus SPY, and
  against one fetch.

Manifest totals, rerun (first pass in brackets):

| Result                                      |                    Count |
| ------------------------------------------- | -----------------------: |
| Comparisons                                 | 69,814,984 (69,806,380)  |
| Passed                                      | 69,814,983 (69,806,192)  |
| … of which passed within a stated tolerance |  7,694,254 (7,694,153)   |
| Failed                                      |              **1** (188) |
| Skipped                                     |                    0 (0) |

The one remaining failure is **DIS 2026-09-22 volume**: 7,167,667 stored against 7,173,330 in a
provider snapshot taken 96 minutes later. The consolidated tape was revised after the close, in the
window between the dataset's final sync and the audit's own fetch. It is not a FactorSage defect
and it is not hidden: every open, high, low and close of all six compared symbols matches exactly,
no Strategy metric can reference volume (the definition validator rejects `VOLUME`), and the
leading-edge rule from AUD-04 re-reads that session on the next sync and adopts the revision. No
tolerance was widened and nothing was re-frozen to make it disappear.

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

Each finding below keeps the text it was first reported with, followed by the remediation pass of
the same day. The statuses are the ones the reruns demonstrate, not the ones the fixes intended:

| Id     | Severity      | Subsystem                               | Status                                                                        |
| ------ | ------------- | --------------------------------------- | ----------------------------------------------------------------------------- |
| AUD-03 | High          | Fundamentals point in time (input data) | **FIXED** — rule, migration and rebuild; availability moved for 2,391 rows     |
| AUD-04 | Medium        | Price and benchmark loading             | **FIXED** — loader (`b4e45c80`) and the damaged rows re-verified and replaced |
| AUD-05 | Low–Medium    | Dashboard "Since"                       | **FIXED** — the observation's session, projected at the read edge             |
| AUD-02 | Low           | EMA reproducibility                     | **FIXED** — one canonical calculation anchor, all derived state rebuilt       |
| AUD-06 | Low           | QA-matrix provisioning                  | **FIXED** — the copy is a mirror, and the stale row is gone                   |
| AUD-01 | Informational | Persistence precision                   | **FIXED** — ratios are rendered at their column's scale                       |
| AUD-07 | Low           | The audit's own UI expectation          | **FIXED** — the display expectation comes from the stored value              |
| AUD-08 | Low           | The audit's own look-ahead check        | **FIXED** — it asserts the availability bound, not the provider's dating     |

AUD-07 and AUD-08 were found by the rerun: both are defects in the audit harness that reported a
product failure which was not one. They are recorded here because an audit that quietly corrects
its own checks is worth no more than one that quietly widens a tolerance.

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

**Remediation — dataset repair.** Both bumps were taken: `PRICE_DATASET_VERSION` 2 → 3 and
`BENCHMARK_PRICE_DATASET_VERSION` 1 → 2 (`07aa6a8b`). Coverage recorded before the leading-edge
rule is therefore invisible to the loader, and the rows the provider returns replace what was
stored for those dates. Repairing only the rows the audit noticed would have left the rest of the
universe unexamined; a version bump re-verifies all of it.

`pnpm data:resync` (`c3296a3c`) drives that deliberately instead of waiting for a page read, and
reports what the data says afterwards. It ran over the 33 matrix securities plus the three symbols
named in this finding that are not in the matrix universe, from 1992-01-01:

| Check                                                        | Before                                                                                       | After                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Execution-calendar sessions absent inside a security's range | ADBE 2026-09-16, MRNA 2026-09-04 (and, outside the matrix set, AAL 2026-09-16, GOOG/BRK-A 2026-09-04) | **0 across all 36 securities**            |
| MRNA 2026-09-04                                              | missing                                                                                      | 145.55 / 14,966,547                       |
| MRNA 2026-09-09                                              | 137.395 / 3,911,148 (in-session)                                                             | **135.61 / 8,650,500** (the final bar)    |
| Coverage against dataset state                               | not checked                                                                                  | agrees for every dataset that records it  |
| Price dataset variant                                        | `split-adjusted-eod-full:v2`                                                                 | `split-adjusted-eod-full:v3`, synced today |

The benchmark side was re-verified the same way with `pnpm benchmarks:prewarm`: `SP500` (the
execution calendar and the comparison) and the three index series the Dashboard overview reads now
carry `provider-eod-full:v2` coverage. Asking for `SP500` from 1996-01-01 also extended it back to
1996-01-02 — 175 bars earlier than the previous start, all of them before the 30-year product
horizon, so no run can reach them. Its per-year bar counts are 248–254 throughout.

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

**Remediation — what the source data actually offers.** The raw payloads were re-read before
choosing a rule (`artifacts/data-correctness-audit/source-data/raw/`). For the affected statements
the provider's `filingDate` *is* the fiscal period end, and its `acceptedDate` is the day **before**
that end. Neither field carries a publication date, so no arithmetic on them can recover one:
reading either as a filing date would be inventing precision the data does not have. The affected
set is not random — it is DIS before 2019 and GOOGL before Q3 2015, i.e. whole stretches of one
provider's history.

**Remediation — the rule.** `statementPublicAvailabilityDate` in `packages/domain` (`beecf337`):

- when `filingDate > fiscalDate`, the provider dated the filing, and availability is that date
  plus one day — unchanged from before;
- otherwise availability is the **statutory deadline for the widest filer class**: 45 calendar days
  after a quarter's end, 90 after an annual period (`FY` and `Q4`, which is published with the
  annual report), a due date falling on a Saturday or Sunday moved to the following Monday, plus
  one day.

This is deliberately conservative in one direction only. A large accelerated filer reports well
inside those deadlines, so the rule can make a statement visible up to about a month later than it
really was; it can never make one visible earlier. Better late than early is the only safe error
for a point-in-time rule, and 45/90 are the deadlines a filer of unknown class is bound by.

**Remediation — the data.** `20260922170000_point_in_time_statement_availability` recomputes
availability for the affected rows only, and never moves one earlier
(`GREATEST(availableFromDate, deadline + 1 day)`). In the matrix database it moved exactly the
2,391 rows this finding names; DIS Q2 2015 went from 2015-04-01 to 2015-05-16, and DIS FY/Q4 2018
from 2018-10-01 to 2019-01-01 (90 days lands on Saturday 2018-12-29 → Monday 2018-12-31 → plus a
day). `DERIVED_STATE_REVISION` 4 → 5 then rebuilt every stored intrinsic value under the new
availability, so no materialized row still encodes the old one.

**Remediation — coverage.** Eight cases in `packages/domain/src/financial-statements.test.ts`: the
day after a real filing date; the DIS Q2 2015 fallback with its 45-day deadline; the FY and Q4
annual case with the weekend shift; a 400-date property check that availability is always after the
period end, always after the statutory due date, within three days of it, and never a Sunday; and a
selection test proving the statement is invisible at 2015-04-01 and 2015-05-15 and visible on
2015-05-16. The audit's own look-ahead probe is unchanged and still independent.

### AUD-05: the Dashboard "Since" column shows the scan time for reconstructed signals

**Example.** AMZN (S01 × L08) has been ACTIVE since 2026-07-30. Its `since` field is the scan
instant, 49 days later, so the page says the state began "just now". This happened on 26 of the 26
reconstructed rows.

**Root cause.** Reconstruction stamps `lifecycleSince` with the cycle's wall clock. The web page
deliberately does not render `observationDate` or "from history" (DashboardPage.tsx), which
contradicts `ai/product/monitors.md`.

**Not fixed.** It is a presentation decision. Either render the activation session, or stamp the
activation session's close.

**Remediation.** The second option, at the read edge (`7d46110e`). A lifecycle row already records
both facts: `lifecycleSinceDate` is the observation the state was entered on, `lifecycleSince` the
write that persisted it. `monitorStateSince` projects the **earlier** of

- that session's close — 16:00 in `America/New_York`, the one timezone every supported venue trades
  in, from the new `tradingSessionCloseInstant` in `packages/domain`; and
- the write instant itself.

A reconstruction is dated to its own session however long after the fact the scan ran, and a match
found while its own session is still open keeps the scan's instant, because a close still to come
must never be presented as a past "since". Both columns keep their meaning in the database and the
worker keeps stamping them with its clock: this is a projection, not a redefinition. The Monitor
detail page's "waiting since" had the same defect and reads the same projection now.

**Remediation — coverage.** `signal-since.test.ts` covers the reconstructed case (2026-07-30
observed, 2026-09-17 written → 2026-07-30T20:00:00Z), the in-session case, the re-persisted case,
the winter offset and the missing-observation fallback. Two cases in
`builtins.integration.test.ts` drive a reconstructed and an in-session state through
`GET /dashboard`; the first fails before the fix with exactly the 49-day error this finding
describes. `tradingSessionCloseInstant` is pinned in both offsets, on both 2026 daylight-saving
transition days, and by a decade-long round-trip against `tradingSessionDate`.

**Remediation — the audit now asserts it.** What used to be recorded as evidence
(`sinceLaterThanActivation`) is a comparison: no Dashboard row may claim a "since" later than its
own observation session's close, and a reconstructed row must claim exactly that close. The oracle
computes the close itself (`oracle/sessions.ts`, a search over the two possible offsets rather than
the product's offset-correction algorithm), so the check stays independent.

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

**Remediation.** Anchored, and the root cause turned out to be two causes (`a008018c`). The
rebuild computed the series over *the load window it was asked for*, so a caller asking for recent
dates seeded the recursion later than a caller asking for the whole horizon; and the weekly
aggregation took its history context from that same window, so whether the first ISO week was
dropped as artificial depended on the request too. The second one was worth 1e‑5 on `ema200w`,
three orders of magnitude more than the effect this finding measured.

Both now anchor on the **earliest persisted bar** for the security, which prices are never pruned
below, so a stored derived row is a pure function of the stored prices. `DERIVED_STATE_REVISION`
4 → 5 rebuilt every stored row under that anchor — and under the new statement availability with
it.

**Remediation — coverage.** "derived-state determinism" in `packages/stock-data/src/service.test.ts`
rebuilds 7,600 synthetic sessions through a whole-horizon window and a recent window and requires
every one of the thousand-plus overlapping stored rows to be identical. It fails on both causes
before the fix (verified by reverting `service.ts` alone). The audit's tolerance was not touched.

### AUD-06: the QA-matrix copy keeps stale rows

`provision-matrix-database.ts` inserts with `skipDuplicates`. A row the development database later
corrected keeps its old value in the matrix copy. For example, ADBE 2026-09-09 is 255.7246 / 1.17M
in the matrix copy and 254.86 / 4.17M in development.

This affects only the audit and QA environment. It did not affect this audit's equality checks,
because both sides read the same copy. It does mean the "canonical" copy can hold provisional bars.

**Remediation.** The copy now has two explicit semantics (`71351499`), both in `mirror-table.ts`
behind a port so the algorithms are testable without two databases:

- market data is **mirrored** scope by scope, one scope per security or series — the target's rows
  for that scope are deleted and the source's inserted, so the result cannot depend on what was
  there;
- the three identity tables (`Security`, `Benchmark`, `BenchmarkSeries`) are reconciled: inserted
  when missing, updated when their content differs, never deleted, because the QA account's lists,
  strategies and runs reference them.

The delete precedes the inserts without a transaction around both, which leaves a crash short
rather than stale — provisioning is re-runnable and the preflight verifies per-security coverage
before any run executes.

**Remediation — evidence.** Re-provisioning reported what it replaced: `Security` 0 inserted and 27
updated, `FinancialStatement` 16,793 replacing 16,793, `DailyPrice` 259,636 replacing 259,635,
`DailyDerivedState` 259,636 replacing 259,635, `BenchmarkDailyPrice` 11,456 replacing 11,278. This
finding's own example is settled: ADBE 2026-09-09 in the matrix database was 255.7246 / 1,167,260
and is now **254.86 / 4,165,500**, the same bar the development database holds. The regression test
seeds a stale destination row and requires the next copy to remove it, and a corrected row and
requires it to be replaced.

### AUD-01: float ratios are rounded twice on their way into PostgreSQL

**Evidence.** Prisma 6 converts a JS `number` bound to a Decimal column to 16 significant digits.
PostgreSQL then rounds that at the column scale. This model matched all 289,728 persisted ratios
sampled. Correct rounding of the float matched 289,474 of them. Across the matrix, 5,817 stored
`returnIndex` values differ by 1e‑10 from correctly rounded values.

**Impact.** At most 2.9e‑8 percentage points in annual returns. Nothing visible.

**Recommended.** Bind ratios as decimal strings if exactness at the stored scale matters.

**Remediation.** Done, at the write boundary (`08ff74f3`). Every persisted ratio — the two growth
indices at scale 10, the percentages at scale 8 — is rendered as a decimal literal at its column's
scale before it is bound, so PostgreSQL receives a value it stores unchanged. The engine's
arithmetic is untouched and nothing invents precision: the stored value is exactly the float,
rounded once.

The audit's model of storage follows the write path. `storedAtScale` is now single rounding;
`prismaFloatBoundAtScale` keeps the measured pre-fix model, so the audit can still report how many
rows the old binding would have stored differently and an archive written before the fix can be
read with the model that was true for it. `correctlyRoundedAtScale` also had to change: it built
its Decimal from the float's *shortest* decimal form, which for one audited ratio
(`8.84411177645`) rounds up at ten places while the double it names is below that midpoint and
rounds down. It now expands the float to its exact binary value, which is what PostgreSQL sees.

**Remediation — coverage.** `ratio-binding.test.ts` pins the audited pair — the matrix's
`1.0009891328499996`, stored as `1.0009891329` and now as `1.0009891328` — renders at exactly the
column scale, refuses a non-finite or unstorable value, and keeps a null null.

### AUD-07: the UI stage compared the page against the oracle, not against the stored value

**Found by the rerun.** The Stock Details display expectation took its moving averages from the
reference recomputation. DIS held `sma20d` 106.48500000 on 2026-09-22, which the page renders as
`$106.49`; the reference's own value for the same session is 106.48499999999999, which formats as
`$106.48`. The technicals comparison legitimately passes that 1.4e‑14 difference inside its stated
tolerance, but a display string has no tolerance, and at a rounding midpoint the difference becomes
a whole cent. It was reported as the page showing a wrong number.

**Fix.** The display expectation now comes from the **stored** row — the database, never the API,
so the check stays non-circular. Whether the stored value is right is the question the 42,670
technicals comparisons answer one section earlier, independently and with a stated tolerance; this
stage's question is only whether the page shows the value FactorSage holds.

### AUD-08: the look-ahead section asserted a property of the provider's data

**Found by the rerun.** One check required that no statement carry a provider filing date on or
before its fiscal period end. 2,391 do, and always will: that is what the provider sends. The
assertion could therefore never pass, whatever FactorSage did with those statements — it measured
the provider, and it kept the manifest red after the defect it stood for was gone.

**Fix.** The check now states the invariant that matters, in its own SQL and independently of the
rule the product applies: a statement the provider leaves undated may not be available before the
earliest deadline a filer is bound by — 40 days after a quarter, 60 after a fiscal year. **0 of
16,793** violate it. The 2,391 undated filings remain reported as evidence, under the section's
`implausibleFilingDates`, because they are a real property of the source data and a reader should
see them.

## Remaining risks

- **Provider semantics.** The audit trusts the provider's split adjustment and statement values
  beyond the 6 symbols compared. Restated values (vintages) are not stored, so a historical
  restatement is invisible.
- **Statement availability is now conservative, not exact (AUD-03).** Where the provider supplies
  no filing date, availability is the statutory deadline for the widest filer class. For a large
  accelerated filer that is up to about a month later than the real publication, so a backtest over
  those years is pessimistic about when it knew a number. The error is one-directional by
  construction; removing it needs a source that dates those filings, not a different rule.
- **Monitor coverage on real data.** The rerun still exercises 2 sessions and 6 Monitors, and no
  `PENDING_TRIGGER` state or second-session activation occurs on those dates. The lifecycle
  scenarios that real data does not reach — including `PENDING_TRIGGER`, re-emission and a removed
  and re-added member — are covered by the fixture table in
  `worker/monitor/monitor-transitions.fixture.test.ts`, against written-out expectations, not by
  the real-data scan. The Monitor's live frame recomputes daily indicators over a bounded window;
  that deliberate divergence (deep-discovery §5) was not provoked here.
- **UI breadth.** 10 backtest runs, 10 symbols and one Dashboard were checked in the browser, and
  only the newest 5 trade-log rows of each run. The Dashboard is now also checked at 390x844 — the
  same rows, states and prices, and no horizontal overflow — but no other surface is.
- **Matrix scope.** Fees and slippage are zero in V1. Delisting is not modelled. The execution
  calendar is SPY bars.
- **Tolerances.** 7,694,254 comparisons passed within a stated tolerance: the storage quantum of
  `Decimal(20,8)` series plus float accumulation. No tolerance is relative to portfolio size, and
  none was widened for this rerun.
- **Provider revisions after the close.** A session's consolidated volume keeps moving for hours
  after 16:00, which is what the one remaining source failure is. A dataset frozen minutes after a
  close holds numbers the provider will still revise; the loader adopts the revision on its next
  read, but an audit run against that dataset sees the difference.

## Final audit table

The rerun, after every finding was fixed and the datasets repaired. The first pass's failures are
in the last column.

| Area                        |                    Comparisons |           Pass |    Fail | Skipped | First pass | Independent oracle | E2E verified      |
| --------------------------- | -----------------------------: | -------------: | ------: | ------: | ---------: | ------------------ | ----------------- |
| Source data                 |                        209,359 |        209,358 |   **1** |       0 | 9 (AUD-04) | yes (raw provider) | —                 |
| Technical indicators        |                      3,983,283 |      3,983,283 |       0 |       0 | 146        | yes                | via Stock Details |
| Intrinsic value             |                      2,459,197 |      2,459,197 |       0 |       0 | 0          | yes                | via Stock Details |
| Strategy evaluation         | 13,041 + 17,751,128 real-frame |            all |       0 |       0 | 0          | yes                | —                 |
| Lists and Buy Windows       |                        283,598 |        283,598 |       0 |       0 | 0          | yes                | via backtests     |
| Backtests (1,000 runs)      |                     57,518,181 |     57,518,181 |       0 |       0 | 0          | yes                | API + UI          |
| Frame provenance            |                      3,511,665 |      3,511,665 |       0 |       0 | 0          | yes                | —                 |
| Backtest API                |                      1,762,271 |      1,762,271 |       0 |       0 | 0          | yes                | yes               |
| Look-ahead                  |              2 checks + probes |              2 |       0 |       0 | 1 (AUD-03) | yes                | —                 |
| Monitor, Signals, Dashboard |                          1,636 |          1,636 |       0 |       0 | 0          | yes                | yes               |
| Stock Details API           |                         71,433 |         71,433 |       0 |       0 | 32         | yes                | yes               |
| UI (Playwright)             |                          1,318 |          1,318 |       0 |       0 | 0          | yes                | yes               |
| **Total** (manifest)        |                 **69,814,984** | **69,814,983** |   **1** |   **0** | **188**    |                    |                   |

The strategy real-frame comparisons are counted inside the Backtests row of the manifest.

## The rerun's evidence, per finding

| Finding | The check that now demonstrates it                                                                                             | Result                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| AUD-03  | The audit's own deadline assumption (40/60 days) re-priced every Margin-of-Safety case                                         | 0 of 100 cases trade differently; no security's statements move      |
| AUD-03  | Undated filings available before the earliest deadline a filer is bound by (the audit's SQL, independent of the product's rule) | 0 of 16,793                                                          |
| AUD-04  | Execution-calendar sessions absent inside a security's own range, over the whole universe                                       | 0 across 36 securities; coverage agrees with state everywhere        |
| AUD-02  | Every stored SMA, EMA and RSI of all 33 securities against the reference indicators                                            | 3,983,283 comparisons, 0 failed (was 146)                            |
| AUD-05  | Every Dashboard row's "Since" against its own observation session's close                                                      | `sinceLaterThanActivation: 0` on both sessions (was 26 of 26 wrong)  |
| AUD-06  | Re-provisioning reports what it replaced, and the finding's own example row                                                     | ADBE 2026-09-09 is now 254.86 / 4,165,500, as in development         |
| AUD-01  | 1,000 runs' stored ratios against single rounding of the engine's float                                                         | 0 mismatches; 6,488 rows the old binding would have stored otherwise |
