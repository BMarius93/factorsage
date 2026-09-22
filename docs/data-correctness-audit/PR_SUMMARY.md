# Data-correctness audit: PR summary

The full report is [FINAL_DATA_CORRECTNESS_AUDIT.md](FINAL_DATA_CORRECTNESS_AUDIT.md). The
evidence is in `artifacts/data-correctness-audit/`, and [README](README.md) explains how to run
the audit again.

## Result

**All 1,000 matrix backtests reproduce exactly.** An independent reference backtester re-ran every
scenario and matched every trade, equity row and metric. The audit also found and fixed one
loader defect: a real trading session could go permanently missing from price history. Its
worst finding is a look-ahead in the fundamentals data, which is left for a product decision.

## What was audited

Every area in the correctness map was checked against independent reference implementations:

- source prices, statements and splits (against raw provider responses)
- technical indicators
- intrinsic values and blends
- Strategy evaluation
- Lists and Buy Windows
- the Monitor → Signal → Dashboard pipeline
- Stock Details
- the backtest engine, ledger, benchmark, metrics, annual returns and final liquidation
- the Backtest Results UI
- look-ahead

## Infrastructure added

- **`pnpm audit:data-correctness`.** One command with selectable sections. Everything runs against
  the frozen QA-matrix database.
- **Oracles** (`apps/api/src/data-correctness-audit/oracle/`). These are independent reference
  implementations: indicators, the intrinsic-value engine, predicates, the Monitor lifecycle and
  a reference backtester. ESLint forbids them from importing production logic. Their tests use
  hand-computed and published values, and negative controls prove the comparisons can fail.
- **`qa:matrix:run --archive-all`.** Captures a forensic archive for every case, not just the six
  golden ones.
- **A worker audit scan** (`apps/worker/src/monitor/data-correctness-scan.ts`). It runs one real
  Monitor cycle at a past session.
- **A Playwright audit stage** (`apps/web/e2e/data-correctness/`). It uses its own config and
  runs against the servers the audit starts, which point at the matrix database.

## Counts

| Area                        |    Comparisons |                   Failed |
| --------------------------- | -------------: | -----------------------: |
| **Total** (manifest)        | **69,806,380** |  **188** (all explained) |
| Backtests                   |     57,509,875 |                        0 |
| Technical indicators        |      3,983,691 | 146 (AUD-02, max 2.1e‑8) |
| Frame provenance            |      3,511,155 |                        0 |
| Intrinsic value             |      2,459,422 |                        0 |
| Backtest API                |      1,761,982 |                        0 |
| Lists and Buy Windows       |        283,598 |                        0 |
| Source data                 |        209,149 |               9 (AUD-04) |
| Stock Details API           |         71,692 |              32 (AUD-02) |
| Strategies (constructed)    |         13,041 |                        0 |
| Monitor, Signals, Dashboard |          1,525 |                        0 |
| UI (Playwright)             |          1,248 |                        0 |
| Look-ahead                  |              2 |               1 (AUD-03) |

Nothing was skipped. 7,694,153 of the passes fall within a stated tolerance, all of it storage
quantization. Two more checks are counted inside the Backtests row: strategy evaluation on real
frames (17,748,544 comparisons, 0 failed) and a poisoned-future look-ahead probe (60 runs, 0
differences).

## The 10×10×10 matrix

The matrix gate was **GREEN**:

- 1,000 of 1,000 runs completed
- 0 invariant failures
- 0 provider requests
- 0 differences in the determinism reruns
- the invariants that need archives (36–38) verified on all 1,000 runs, where before they covered
  6

The independent oracle then compared every run:

| Output compared     |      Count |   Mismatches |
| ------------------- | ---------: | -----------: |
| Scenarios           |      1,000 | 0 (all PASS) |
| Trades              |    184,692 |            0 |
| Equity rows         |  3,620,600 |            0 |
| Benchmark rows      |  3,620,600 |            0 |
| Metrics             |     23,000 |            0 |
| Annual-return years |     15,400 |            0 |
| Ledger steps        |  3,805,292 |            0 |
| Invariant checks    | 23,459,537 |            0 |

## Bugs

- **AUD-04, fixed** (`b4e45c80`). The price and benchmark loaders could permanently miss a real
  session, or keep an in-session bar, while their coverage claimed the data was complete. Seen in
  the development database: MRNA, GOOG and BRK-A on 2026-09-04, and ADBE and AAL on 2026-09-16.
  Regression tests fail before the fix and pass after it. Rows already damaged need an operator
  re-sync.
- **AUD-03, open, High.** Provider filing dates that equal the fiscal period end make 2,391
  statements available before any filing existed. This is a look-ahead: it changes 9 of the 100
  Margin-of-Safety runs, by up to +4.5% of final value. Fixing it needs a product decision on the
  availability rule.
- **AUD-05, open.** The Dashboard's "Since" shows the scan time for reconstructed signals, up to 49
  days late.
- **AUD-02, AUD-06 and AUD-01, open, Low or informational.** In order:
  - stored EMA values depend on the date the derived state was rebuilt;
  - the QA-matrix copy keeps stale rows;
  - Prisma double-rounds float ratios.

## Commands run

```
QA_MATRIX_AS_OF_DATE=2026-09-22 pnpm qa:matrix:provision / qa:matrix:preflight
QA_MATRIX_AS_OF_DATE=2026-09-22 pnpm qa:matrix:run --archive-all                    # GREEN, 2,462 s
tsx src/data-correctness-audit/run-audit.ts --sections=strategies,lists,source
tsx src/data-correctness-audit/run-audit.ts --sections=technicals,intrinsic,backtests,api
tsx src/data-correctness-audit/run-audit.ts --sections=lookahead,signals
tsx src/data-correctness-audit/run-audit.ts --sections=stock-details,ui
pnpm lint · pnpm typecheck · pnpm -r --no-bail test · pnpm build · pnpm openapi:validate
pnpm dev:{fmp,api,worker,web}:e2e · pnpm test:personas:seed · pnpm test:e2e
```

## Gate

| Step             | Result                         |
| ---------------- | ------------------------------ |
| lint             | ✅                             |
| typecheck        | ✅                             |
| build            | ✅                             |
| openapi:validate | ✅                             |
| test             | ✅ with one known flake, below |
| E2E              | ✅ with one known flake, below |

- **test.** Every package passes: api 1,283, web 1,100, worker 215, stock-data 468, strategy 225,
  contracts 250, and the rest. In the parallel run, 3 tests in `stock-data`'s
  `redis.integration.test.ts` timed out at 5 s. Rerun alone, the file passes 25 of 25. This is the
  documented load flake.
- **E2E.** 237 passed and 1 failed. The failure was `backtests.user.spec.ts`, "submits a run,
  watches it progress…", which samples a run while it is still going. It passed when rerun alone.

## Artifacts

`artifacts/data-correctness-audit/` holds:

- `SUMMARY.md` and `manifest.json`
- per-section summaries
- `failures/`
- `backtests/index.json`
- ten sample scenario files

These are committed. The other 990 per-scenario files (about 89 MB) and the raw provider snapshots
are regenerated by the command and git-ignored.
