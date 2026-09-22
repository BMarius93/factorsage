# Existing test audit

This audit asks what the tests that existed before the data-correctness audit actually prove. It
covers only the suites that bear on financial and data correctness. Auth, billing, legal and layout
suites are out of scope. File counts were taken on 2026-09-22 at `334d974a`:

| Package | Unit files | Integration files |
| --- | --- | --- |
| strategy | 11 | 0 |
| valuation | 9 | 0 |
| stock-data | 18 | 10 |
| domain | 6 | 0 |
| contracts | 11 | 0 |
| api | 48 | 32 |
| worker | 7 | 5 |
| web | 102 | 0 |

There are also 51 Playwright specs.

## Summary

| Family | Kind | Proves | Does **not** prove | Expected values come from | Imports the logic it checks? |
| --- | --- | --- | --- | --- | --- |
| `packages/valuation/*.test.ts` incl. `golden-vectors.test.ts` | unit, golden | Each formula reproduces the ADR's golden vectors (DCF 178.8977101328, RI 99.1837933641, DDM 27.3333, Graham 148, the three blends) to 9–10 decimals | Point-in-time input assembly on real statements; growth other than g = 0.05 (every golden vector uses 0.05, so the cap and negative growth are covered only by small literal tests); daily materialization | Literals from `docs/decisions/intrinsic-value-engine.md` | No (literals). The golden test writes its blend weights inline, so it does not import them. |
| `stock-data/intrinsic-value-{inputs,evaluator,materializer}.test.ts` | unit | Assembly rules on hand fixtures: TTM windows, latest state, provenance, event dates, carry-forward, invalidation | Real FMP statement shapes; implausible provider filing dates | Hand fixtures plus ADR literals | No |
| `stock-data/daily-technicals.test.ts`, `weekly-technicals.test.ts` | unit, oracle-helper | SMA/EMA against a naive re-summed oracle (`moving-average-oracle.test-helper.ts`); weekly eligibility and exclusion rules | Stored values on real history; the interaction of the weekly first-week drop with the retention horizon; incremental versus full rebuild | The oracle helper plus some literals **captured from the shipped code** (regression snapshots such as `sma50d: 236.81000000000026`) | Oracle helper: no. Snapshot literals: effectively yes. |
| `stock-data/daily-oscillators.test.ts` | unit, golden | Wilder RSI against the published Wilder worked example (70.46 / 66.25) and a closed-form oracle; edges at 0, 50 and 100 | Stored values on real history | Published example plus an independent script | No |
| `strategy/predicates.test.ts`, `evaluability.test.ts`, `position.test.ts` | unit | Operators, strictness, 2 % close-to, cross, Kleene AND/OR, Gain/Loss | A differential check against an independent implementation on real frames | Literal | No |
| `strategy/backtest/simulate.test.ts` (2,206 lines), `simulation.*.test.ts` | unit / engine | Hand-built scenarios: sizing, tiers, contributions, liquidation, window equivalence (windowed == continuous), determinism | That results on real data are right. `simulation.window.test.ts` compares production with production. | Mostly hand-computed literals with `toBeCloseTo(…, 6)`; the window-equivalence suites compare two production paths | The equivalence suites use production for both sides |
| `strategy/monitor-lifecycle.test.ts` | unit, property | Scripted transitions (literal); structural invariants over 2,000 random seeds | Real-data signals. The reconstruction-equivalence test compares `replayMonitorLevel` with `stepMonitorLevel` (production vs production). | Literal / production | Partly |
| `worker/monitor/monitor-cycle.integration.test.ts` (~80 cases) | integration (real PostgreSQL) | Emission, resolution, reconstruction, stale quotes, holidays, Gain/Loss skipping, no double emission, and absence (`toHaveLength(0)`) | Indicator correctness (frames are built by production `projectMonitorEvaluationFrame`); real prices | Hand-chosen flat prices, literal expectations | Frame: yes |
| `api/builtins/builtins.integration.test.ts` (dashboard) | API | Row filtering, ordering, visibility, fields | That rows correspond to a real scan (state rows are **hand-seeded** with a placeholder fingerprint) | Literal | No |
| `api/backtests/backtests.integration.test.ts` | API | Submission, snapshot, ownership, read contract | Numerical correctness | Literal | — |
| Web unit tests (`features/*/utils/*.test.ts`, component tests) | unit | Formatting helpers and rendering against **mocked** API responses | That displayed numbers equal backend numbers | Literal | — |
| Playwright `e2e/backtests/*.spec.ts` | E2E | Structure: 8 tiles are not "—", the chart has 3 series, sections are in order, trade log reason text is non-empty, membership-boundary trade dates (through the API) | **No spec compares a displayed number with the backend or an oracle** | — | — |
| Playwright `e2e/stocks/*.spec.ts` | E2E | Labels, gap counts, viewport, history bounds on the seeded `QATEST1` | Any displayed price, MA or IV value | — | — |
| Playwright `e2e/dashboard/*.spec.ts` | E2E | 3 hand-seeded rows, filters, absence of "from history" | Rows produced by the engine | Hand-seeded DB rows | — |
| **QA matrix** (`apps/api/src/qa-matrix/*`) | backtest matrix | See below | See below | See below | See below |

## The 10×10×10 matrix

The fixtures are in `packages/testing/src/qa-matrix/` and the runner in `apps/api/src/qa-matrix/`.
They are documented in `docs/development/qa-matrix-fixtures.md` and `qa-matrix-runner.md`.

### Dimensions (1,000 = 10 × 10 × 10 scenarios)

- **Strategies (10):**
  - S01 price > SMA200D, hold
  - S02 golden cross / death cross triggers
  - S03 weekly trend ladder (weekly MAs as Metric and Value, partial SELL, condition FINAL EXIT)
  - S04 RSI nested BUY ladder 25/50/100
  - S05 RSI7 high-turnover swing with Gain SELLs
  - S06 sparse confluence (4 Conditions + Trigger)
  - S07 persistent DCA ladder (weekly filter, no exits)
  - S08 close-to EMA200D with Gain SELL and Loss FINAL EXIT
  - S09 Margin of Safety (DCF, Balanced), including a NOT_EVALUABLE probe
  - S10 same-day rotation (RSI14 crosses, SELL 25 % × 2)
- **Lists (10):**
  - L01 AAPL only
  - L02 KO / JNJ / XOM
  - L03 uniform CUSTOM 2010–2019
  - L04 divergent CUSTOM shapes
  - L05 mixed FULL/CUSTOM tiling
  - L06 later IPOs
  - L07 mixed eras
  - L08 30 securities
  - L09 overlapping/nested/disjoint windows with an empty 2021
  - L10 boundary windows cut on real execution dates
- **Configurations (10), each as capital / monthly contribution / maximum positions:**
  - C01 30 years, 100k / 0 / 10
  - C02 10 years, 100k / 0 / 10
  - C03 3 years, 100k / 0 / 10
  - C04 1 year, 100k / 0 / 10
  - C05 10 years, 10k / 500 / 10
  - C06 10 years, 1k / 25k / 5
  - C07 10 years, $1 / 0 / 10
  - C08 30 years, $1bn / 0 / 20
  - C09 10 years, 100k / 0 / 1
  - C10 30 years, 250k / 1k / 30

Every date is derived from one clock (`QA_MATRIX_AS_OF_DATE`). L10's windows are indices into the
real execution calendar.

### What each scenario really does

It really executes: a real submission through `BacktestsService.submitRun`, a real worker
supervisor, real PostgreSQL results, and zero FMP requests enforced by the gate.

### What is asserted

Forty invariants are re-derived from **persisted** evidence without calling the engine:

- 37 are settled from the DB;
- 3 need the forensic archive, which exists only for the **6 golden** cases.

The main groups:

- **Ledger identity:** `cash + positions == total` (9) and `amount == shares × price` (10).
- **Sizing:** target / shortfall / cash (18), with a derived float budget.
- **Level lifecycle:** 19–24.
- **Cost basis and P&L:** average-cost basis (28) and realized/unrealized P&L (29, 30).
- **Summary reconciliation:** 32–35.
- **Contributions and cash baseline:** 14 and 15.
- **Benchmark as a funded portfolio:** 17.
- **Buy windows:** BUY only inside a window (11).
- **Coverage:** no trading before listing (39) and no warm-up date simulated (40).
- **Determinism:** the golden set is re-executed and every persisted column compared.

### What is not asserted before this audit

| Output | Verified before? | How |
| --- | --- | --- |
| Trades | **Structurally only** | Each trade is checked for internal consistency: sizing arithmetic, windows, lifecycle rules. Nothing checked that the **set** of trades is the one the strategy should have produced. |
| Signals | Partly | Invariant 36 re-derives BUY signals, but only in the 6 golden archives. SELL, FINAL EXIT and every Gain/Loss decision were never re-derived. |
| Missed trades | No | A trade that should have happened and did not violates no invariant. |
| Equity | Yes, as an identity | Checked as `cash + positions == total`. Nothing independently checked that positions were marked at the right close on the right date. |
| Annual returns | **No** | Not checked at all. |
| CAGR and drawdowns | **No** | Neither the portfolio's nor the benchmark's was independently recomputed. |
| Portfolio return and alpha | Reconciled only | Reconciled to the stored index, which was not itself recomputed. |
| Benchmark | Yes | Invariant 17 rebuilds the funded benchmark portfolio from its closes. That is an independent check of that line. |
| Final liquidation | Yes | Invariants 25, 31 and 32, plus engine unit tests. |

### Are the expected values independent?

The invariants are written without calling the engine, which is good. But they re-derive
**consequences** of the engine's choices rather than **the choices themselves**. An engine that
bought the wrong stock on the wrong day, and did it consistently, passes all 40.

`matrix-invariants.ts` imports `ExecutionCalendar` from `@intrinsic/strategy` to resolve dates.
That is a navigation helper, not the logic under test.

### Tolerances

Every invariant is exact except 18 (sizing), whose float budget is derived from the declared
scales. That is financially justified, and `qa-matrix-runner.md` documents it.

### Conclusion

"1,000 matrix runs green" meant: 1,000 runs completed and each was **internally consistent**. It
did not mean that each run made the trades the strategy defines, and it did not independently
confirm annual returns, CAGR or drawdown. The reference backtester in this audit closes exactly that
gap.

## Mocks that could hide problems

- **Dashboard.** The API and Playwright suites read hand-seeded state rows with a placeholder
  fingerprint, so a reducer or scan defect cannot surface there.
- **Web.** Unit tests mock every API response. A contract/formatting mismatch against real
  backend numbers is invisible to them.
- **Hermetic E2E stack.** The fake FMP returns `[]` for prices, statements and quotes, so no E2E
  path exercises real data. `QATEST1`'s intrinsic values are seeded constants.
- **Monitor integration.** Frames are built by the production projector, so an indicator defect
  would be consistent on both sides.
