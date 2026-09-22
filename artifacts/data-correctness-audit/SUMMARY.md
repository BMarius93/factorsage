# Data-correctness audit — summary

Generated 2026-09-22T23:31:52.385Z at `2f2ecc86` (audit-large), 1 min. Database `intrinsic_value_matrix`, data as of 2026-09-22.

**FAIL** — 69,814,984 comparisons: 69,814,983 passed (7,694,254 of them within a stated tolerance), 1 failed, 0 skipped.

| Section | Status | Comparisons | Pass | Fail | Skipped | Tolerance passes | Independent oracle | End to end |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| source-data | FAIL | 209,359 | 209,358 | 1 | 0 | 0 | yes | no |
| strategies | PASS | 13,041 | 13,041 | 0 | 0 | 0 | yes | no |
| lists-buy-windows | PASS | 283,598 | 283,598 | 0 | 0 | 0 | yes | no |
| technicals | PASS | 3,983,283 | 3,983,283 | 0 | 0 | 3,422,392 | yes | no |
| intrinsic | PASS | 2,459,197 | 2,459,197 | 0 | 0 | 1,325,129 | yes | no |
| backtests | PASS | 57,518,181 | 57,518,181 | 0 | 0 | 410 | yes | no |
| frame-provenance | PASS | 3,511,665 | 3,511,665 | 0 | 0 | 2,895,000 | yes | no |
| backtest-api | PASS | 1,762,271 | 1,762,271 | 0 | 0 | 0 | yes | no |
| look-ahead | PASS | 2 | 2 | 0 | 0 | 0 | yes | no |
| signals-dashboard | PASS | 1,636 | 1,636 | 0 | 0 | 0 | yes | no |
| stock-details-api | PASS | 71,433 | 71,433 | 0 | 0 | 51,323 | yes | no |
| ui | PASS | 1,318 | 1,318 | 0 | 0 | 0 | yes | yes |

Section detail is in each section's `summary.json`; failing items are listed under `failures/` and in each summary's `differences`.

- **intrinsic**: 2391 statements carry a provider filing date on or before their fiscal period end; their availability is derived from the statutory deadline instead (AUD-03).
- **look-ahead**: The provider leaves 2,391 statements undated; availability comes from the statutory deadline instead. See FINAL_DATA_CORRECTNESS_AUDIT.md AUD-03.
