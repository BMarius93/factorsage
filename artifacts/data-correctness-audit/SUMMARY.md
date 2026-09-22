# Data-correctness audit — summary

Generated 2026-09-22T15:53:21.745Z at `919ed236` (audit-large), 1 min. Database `intrinsic_value_matrix`, data as of 2026-09-21.

**FAIL** — 69,806,380 comparisons: 69,806,192 passed (7,694,153 of them within a stated tolerance), 188 failed, 0 skipped.

| Section | Status | Comparisons | Pass | Fail | Skipped | Tolerance passes | Independent oracle | End to end |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| source-data | FAIL | 209,149 | 209,140 | 9 | 0 | 0 | yes | no |
| strategies | PASS | 13,041 | 13,041 | 0 | 0 | 0 | yes | no |
| lists-buy-windows | PASS | 283,598 | 283,598 | 0 | 0 | 0 | yes | no |
| technicals | FAIL | 3,983,691 | 3,983,545 | 146 | 0 | 3,422,520 | yes | no |
| intrinsic | PASS | 2,459,422 | 2,459,422 | 0 | 0 | 1,325,338 | yes | no |
| backtests | PASS | 57,509,875 | 57,509,875 | 0 | 0 | 413 | yes | no |
| frame-provenance | PASS | 3,511,155 | 3,511,155 | 0 | 0 | 2,894,403 | yes | no |
| backtest-api | PASS | 1,761,982 | 1,761,982 | 0 | 0 | 0 | yes | no |
| look-ahead | FAIL | 2 | 1 | 1 | 0 | 0 | yes | no |
| signals-dashboard | PASS | 1,525 | 1,525 | 0 | 0 | 0 | yes | no |
| stock-details-api | FAIL | 71,692 | 71,660 | 32 | 0 | 51,479 | yes | no |
| ui | PASS | 1,248 | 1,248 | 0 | 0 | 0 | yes | yes |

Section detail is in each section's `summary.json`; failing items are listed under `failures/` and in each summary's `differences`.

- **intrinsic**: 2391 statements carry a provider filing date on or before their fiscal period end (look-ahead finding AUD-03).
- **look-ahead**: See FINAL_DATA_CORRECTNESS_AUDIT.md AUD-03 for the provider filing-date look-ahead.
