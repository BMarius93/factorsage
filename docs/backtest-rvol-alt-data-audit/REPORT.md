# Backtest re-validation — Relative Volume and Alternative Data

Branch `audit/backtest-rvol-alternative-data`, from `439f634a`.

An end-to-end re-validation of the Backtest V1 engine after the Relative Volume period-identity fix
(`d4ce4aa2`) and the alternative-data slice (`0adf5610`, `d8f1dc36`). `FINDINGS.md` holds each finding
with the evidence it rests on; this is the narrative.

Institutional / Form 13F is out of V1 and nothing here reintroduces it.

## 1. Audit scope

| Area | What was re-validated |
| --- | --- |
| Relative Volume | `rvol10` / `rvol20` / `rvol50`: the calculation, the materialization, the warm-up boundary, the period-aware semantic identity, several periods in one Strategy, the frame projection, and Monitor parity |
| Insider Activity | the FMP payload, the mapper, the persisted row, `availableFromDate`, coverage, the rolling projection, role filtering, distinct-buyer counting, purchase and sale value, Strategy evaluation |
| Congressional Trading | House and Senate ingestion, stable actor identity, owner and chamber filters, amount ranges, transaction vs disclosure date, `availableFromDate`, stock-only behaviour, Congress Groups, group snapshot freezing, the rolling projection, Strategy evaluation |
| Engine | source-data correctness, point-in-time correctness, derived-series correctness, strategy evaluation, trade generation, the ledger, backtest results, determinism, no look-ahead, no silent NOT_EVALUABLE → 0, no cross-period RVOL identity collisions, no alternative-data scope or group leakage |

## 2. Matrix dimensions discovered

The existing infrastructure was found and reused rather than re-invented.

```text
10 Strategies  ×  10 Stock Lists  ×  10 Backtest configurations  =  1,000 runs
                identified as  QA-MATRIX-Sxx-Lxx-Cxx
```

- **Inputs** — `docs/development/qa-matrix-fixtures.md`, defined in `packages/testing/src/qa-matrix/`.
  `S01`–`S10` (Price/SMA, golden cross, weekly ladder, RSI ladder, high-turnover RSI 7D, sparse
  confluence, DCA ladder, EMA reversion, Margin of Safety, same-day rotation); `L01`–`L10` (one
  security through a thirty-name universe, FULL and CUSTOM windows, later listings, overlapping and
  boundary windows); `C01`–`C10` (30y / 10y / 3y / 1y, contributions 0 / 500 / 1,000 / 25,000, capital
  1 / 10,000 / 100,000 / 250,000 / 1,000,000,000, `maximumPositions` 1 / 5 / 10 / 20 / 30).
- **Runner** — `docs/development/qa-matrix-runner.md`, `apps/api/src/qa-matrix/`. A dedicated
  `intrinsic_value_matrix` database and Redis db 3, a 17-check preflight, submission through the real
  `BacktestsService.submitRun`, execution by the real worker supervisor, **40 invariants** re-derived
  from persisted evidence (37 from the database, 3 from the forensic archive), a determinism rerun
  over 6 golden combinations comparing every persisted column, and one gate with 15 stable failure
  codes.
- Every date is a pure function of one declared clock (`QA_MATRIX_AS_OF_DATE`); the execution calendar
  is the pinned `SP500` benchmark's own bars and nothing else.

Sweeps in this audit ran at clock `2026-09-26`.

### The audit variant

`S01`–`S10` are the historical baseline and were **not edited**. A second strategy dimension was
added instead — `A01`–`A10`, selected with `--strategies audit` — over the same ten Lists and ten
configurations, so either sweep is 1,000 runs and the two are comparable. See
`qa-matrix-fixtures.md`. Core coverage is therefore not reduced by one condition.

## 3. Original matrix results

_(filled from the sweep)_

## 4. Extended RVOL / Insider / Congress matrix results

_(filled from the sweep)_

## 5. Data-correctness findings

## 6. PIT / look-ahead findings

## 7. RVOL correctness

## 8. Insider correctness

## 9. Congress correctness

## 10. Backtest / ledger invariants

## 11. Determinism results

## 12. Monitor parity

## 13. Bugs found

## 14. Fixes made

## 15. Tests added

## 16. Exact gate results

## 17. Remaining risks and provider limitations

## 18. Merge-ready
