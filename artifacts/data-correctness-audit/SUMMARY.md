# Data-correctness audit — summary

Generated 2026-09-26T01:26:08.206Z at `eef25d95` (audit/backtest-rvol-alternative-data), 0 min. Database `intrinsic_value_matrix`, data as of 2026-09-22.

**FAIL** — 74,739,860 comparisons: 74,739,859 passed (8,617,700 of them within a stated tolerance), 1 failed, 0 skipped.

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
| relative-volume | PASS | 703,305 | 703,305 | 0 | 0 | 702,657 | yes | no |
| alternative-data | PASS | 4,221,571 | 4,221,571 | 0 | 0 | 220,789 | yes | no |

Section detail is in each section's `summary.json`; failing items are listed under `failures/` and in each summary's `differences`.

- **intrinsic**: 2391 statements carry a provider filing date on or before their fiscal period end; their availability is derived from the statutory deadline instead (AUD-03).
- **look-ahead**: The provider leaves 2,391 statements undated; availability comes from the statutory deadline instead. See FINAL_DATA_CORRECTNESS_AUDIT.md AUD-03.
- **alternative-data**: 12 row(s) the provider dated as filed on or before the transaction they report. A provider anomaly: availability is still publication + 1 day on every one of them, which is the only rule the product states. 11 stored transaction value(s) one unit in the last place below the exact product, from float64 multiplication before Decimal(24,4) quantization. Maximum absolute error $0.0001.
