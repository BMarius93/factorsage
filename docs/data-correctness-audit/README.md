# Data-correctness audit: how to run it

The audit asks whether FactorSage's numbers are right. Given the same raw data and the same
inputs, it checks two things:

- that FactorSage computes the correct result;
- that the user is shown exactly that result.

`FINAL_DATA_CORRECTNESS_AUDIT.md` holds the findings. This page explains how to run the audit
again.

## One command

```bash
pnpm infra:up
QA_MATRIX_AS_OF_DATE=$(date +%F) pnpm qa:matrix:provision   # the frozen dataset (copied from the dev DB, read-only)
QA_MATRIX_AS_OF_DATE=$(date +%F) pnpm audit:data-correctness -- --run-matrix
```

`--run-matrix` first runs the 1,000-case matrix with every case archived, using
`pnpm qa:matrix:run --archive-all`. That takes about 40 minutes and writes about 650 MB to
`.debug/qa-matrix/`. It then runs every audit section against that sweep. The sweep is spawned with
the development `DATABASE_URL` and `REDIS_URL` restored: the audit process itself points at the
matrix database, and a child that inherited that would see the matrix connections as the
development ones and refuse to start.

If you leave out `--run-matrix`, the audit uses the newest sweep that has archives. You can also
choose a sweep with `--sweep=<dir>`.

Stop the development servers first. The UI stages start their own API and web servers on ports
3001 and 3000, pointed at the QA-matrix database. If either port is already serving, the audit
refuses to start rather than trust a server whose database it cannot see.

## Sections

`--sections=a,b,…`. The default is `all`.

| Section         | What it checks                                                                                                                                                                                | Needs                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `source`        | `DailyPrice`, `FinancialStatement` and SPY bars against raw provider responses. It also checks that splits are adjusted.                                                                      | The frozen snapshots under `source-data/raw/`, or `FMP_API_KEY` to take them once |
| `technicals`    | Every stored SMA, EMA and RSI (daily and weekly) of every matrix security, for its full history, against the reference indicators                                                             | —                                                                                 |
| `relative-volume` | Every stored `rvol10` / `rvol20` / `rvol50` of every matrix security, for its full history, against the reference recomputed from that security's own persisted volumes                     | —                                                                                 |
| `alternative-data` | Every persisted insider and congressional row against the provider document in its own `raw` column — availability date, classification, transaction value, amount bounds — plus every projected metric column against the reference column | ingested disclosure history                     |
| `intrinsic`     | Every stored model value, blend and provenance instant against the reference intrinsic-value engine, plus the point-in-time rules on the statements                                           | —                                                                                 |
| `strategies`    | Production operators, Signals and the FINAL EXIT OR against the reference evaluator, on boundary cases and random inputs                                                                      | —                                                                                 |
| `lists`         | Buy-window normalization and eligibility against a date-set reference, plus the BUY and exit evidence from the matrix                                                                         | a sweep                                                                           |
| `backtests`     | All 1,000 runs through the reference backtester, compared field by field. It also covers the ledger, invariants, liquidation, frame provenance, real-frame strategy evaluation and look-ahead | a sweep with archives                                                             |
| `api`           | `BacktestsService` (the code behind `GET /backtests/*`) for all 1,000 runs, against the reference                                                                                             | `backtests` in the same invocation                                                |
| `signals`       | Real Monitor cycles on two sessions, checked against the reference lifecycle and `DashboardService`                                                                                           | —                                                                                 |
| `stock-details` | `GET /stocks/:symbol` for 10 representative symbols, against the DB and the references                                                                                                        | the audit stack (started automatically)                                           |
| `ui`            | Playwright on Backtest Results, Stock Details and the Dashboard, against the expectations above                                                                                               | the sections above in the same or an earlier invocation                           |

## Independence rule

The code under `apps/api/src/data-correctness-audit/oracle/` is the reference implementation. It
may import only arithmetic primitives (`decimal.js`) and its own files. ESLint enforces this, and
`pnpm lint` fails on any `@intrinsic/*`, Prisma or parent-directory import there.

The oracle is written from the product and methodology documents, not from the engine. If it
imported the engine, it would agree with every bug it exists to find. Its own correctness is
pinned by `oracle/oracle.test.ts`, whose expected values are either hand-computed or published
elsewhere: the ADR's golden vectors and Wilder's RSI example.

## Artifacts

`artifacts/data-correctness-audit/`:

```text
SUMMARY.md, manifest.json           totals per section: comparisons / pass / fail / skipped / tolerance passes
source-data/ technicals/ intrinsic/ strategies/ lists/ lookahead/ signals/ dashboard/ stock-details/ ui/
backtests/scenario-NNNN-Sxx-Lxx-Cxx.json   one per matrix case: inputs, expected vs actual result,
                                            trades (with the oracle's reason and sizing), year-end equity,
                                            comparison counts, invariant and ledger results
backtests/index.json, summary.json, api-reconciliation.json, frame-provenance.json
failures/                          full evidence for every failing case
```

A comparison counts as PASS only when it matches exactly, or when it falls within a tolerance that
the comparison itself names and justifies. Tolerance passes are counted separately. SKIPPED is
never counted as PASS.
