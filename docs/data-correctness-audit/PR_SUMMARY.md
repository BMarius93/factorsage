# Data-correctness audit: PR summary

The full report is [FINAL_DATA_CORRECTNESS_AUDIT.md](FINAL_DATA_CORRECTNESS_AUDIT.md). The
evidence is in `artifacts/data-correctness-audit/`, and [README](README.md) explains how to run
the audit again.

## Result

**All 1,000 matrix backtests reproduce exactly, and all six findings are fixed.** An independent
reference backtester re-ran every scenario and matched every trade, equity row and metric. The
audit's worst finding — a look-ahead in the fundamentals data — now has a stated point-in-time
rule, and the audit's own independent probe can no longer find a single trade that depended on the
old one. The manifest is at **1 failure in 69,814,984 comparisons**, and that one is a provider
volume revision after the close, explained below rather than tolerated away.

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

The rerun, after every fix and every dataset repair. The first pass is in the last column.

| Area                        |    Comparisons |     Failed | First pass |
| --------------------------- | -------------: | ---------: | ---------: |
| **Total** (manifest)        | **69,814,984** |      **1** |    **188** |
| Backtests                   |     57,518,181 |          0 |          0 |
| Technical indicators        |      3,983,283 |          0 |        146 |
| Frame provenance            |      3,511,665 |          0 |          0 |
| Intrinsic value             |      2,459,197 |          0 |          0 |
| Backtest API                |      1,762,271 |          0 |          0 |
| Lists and Buy Windows       |        283,598 |          0 |          0 |
| Source data                 |        209,359 | 1 (volume) |          9 |
| Stock Details API           |         71,433 |          0 |         32 |
| Strategies (constructed)    |         13,041 |          0 |          0 |
| Monitor, Signals, Dashboard |          1,636 |          0 |          0 |
| UI (Playwright)             |          1,318 |          0 |          0 |
| Look-ahead                  |              2 |          0 |          1 |

Nothing was skipped. 7,694,254 of the passes fall within a stated tolerance, all of it storage
quantization, and no tolerance was widened. Two more checks are counted inside the Backtests row:
strategy evaluation on real frames (17,751,128 comparisons, 0 failed) and a poisoned-future
look-ahead probe (60 runs, 0 differences).

**The one failure.** DIS 2026-09-22 volume: 7,167,667 stored against 7,173,330 in a provider
snapshot taken 96 minutes later. The consolidated tape is revised after the close, and the dataset
was frozen before the revision. Every open, high, low and close of all six compared symbols matches
exactly, no Strategy metric can reference volume, and the leading-edge rule from AUD-04 adopts the
revision on the next sync.

## The 10×10×10 matrix

The matrix gate was **GREEN**, on the repaired dataset:

- 1,000 of 1,000 runs submitted, completed and archived (1,000 of 1,000 archives verified)
- 0 invariant failures, 0 runner errors
- 0 provider requests
- 0 differences in the determinism reruns
- 3,870 s at 15.5 runs/min
- the invariants that need archives (36–38) verified on all 1,000 runs, where before they covered
  6

The independent oracle then compared every run:

| Output compared     |      Count |   Mismatches |
| ------------------- | ---------: | -----------: |
| Scenarios           |      1,000 | 0 (all PASS) |
| Trades              |    184,785 |            0 |
| Equity rows         |  3,621,000 |            0 |
| Benchmark rows      |  3,621,000 |            0 |
| Metrics             |     23,000 |            0 |
| Annual-return years |     15,400 |            0 |
| Ledger steps        |  3,805,785 |            0 |
| Invariant checks    | 23,462,808 |            0 |

Trades moved from 184,692 to 184,785 between the two passes: statements now become available on
their statutory deadline rather than the day after the period end, and the price history gained the
sessions the old coverage had lost.

## Bugs

All six are fixed. `FINAL_DATA_CORRECTNESS_AUDIT.md` carries each one's root cause, code change,
regression coverage, dataset remediation and before/after evidence.

| Id     | What it was                                                                         | Fix                                                                                        | What the rerun shows                                            |
| ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| AUD-03 | 2,391 statements available the day after the period closed, before any filing existed | availability from the real filing date, else the statutory 45/90-day deadline (`beecf337`) | 0 of 100 Margin-of-Safety cases trade differently; 0 of 16,793 available too early |
| AUD-04 | a session could go missing, or an in-session bar stay, while coverage claimed complete | loader (`b4e45c80`) plus both dataset version bumps (`07aa6a8b`) and `pnpm data:resync`     | 0 sessions absent across 36 securities; MRNA 2026-09-09 is the final bar |
| AUD-02 | stored EMA depended on the date the derived state was rebuilt                        | one calculation anchor: the earliest persisted bar (`a008018c`)                            | 3,983,283 technical comparisons, 0 failed                        |
| AUD-05 | the Dashboard's "Since" showed the scan time for reconstructed signals               | the observation session's close, projected at the read edge (`7d46110e`)                   | `sinceLaterThanActivation: 0`, was 26 of 26                      |
| AUD-06 | the QA-matrix copy kept stale rows                                                   | mirror the market data, reconcile the identity tables (`71351499`)                         | ADBE 2026-09-09 is now the final bar in the matrix copy too      |
| AUD-01 | Prisma double-rounded float ratios into Decimal columns                              | render every ratio at its column's scale (`08ff74f3`)                                      | 0 mismatches; 6,488 rows the old binding would have stored otherwise |

Two defects in the **audit itself** were found by the rerun and are recorded as AUD-07 and AUD-08:
the UI stage compared the page against the oracle's float instead of the stored value (a 1.4e‑14
difference becomes a cent at a display midpoint), and the look-ahead section asserted a property of
the provider's data rather than the availability bound that matters.

Re-provisioning also turned out to leave the matrix Redis projections describing the previous copy —
the runs priced the benchmark from a cached in-session bar and 494 of them failed invariant 17.
Provisioning now discards those projections, with unit tests.

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
