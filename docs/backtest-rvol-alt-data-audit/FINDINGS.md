# Backtest re-validation audit — findings

Branch `audit/backtest-rvol-alternative-data`. Working record of what the audit established, with the
evidence each conclusion rests on. The narrative report is `REPORT.md`.

## F-01 — Insider ingestion stopped after one page whenever a page held an unmappable row

**Severity: high. Data completeness. Fixed.**

`insider-trading/search` returns Form 3 rows — an initial statement of holdings, not a transaction —
with an empty `transactionType`. The mapper drops them, correctly. The page walk then decided it had
reached the end of history by comparing the **mapped** row count against the endpoint's page cap:

```ts
if (rows.length < FMP_INSIDER_TRADING_MAX_PAGE_SIZE) break;   // rows.length is post-mapping
```

Verified live on 2026-09-26: AAPL page 0 carried 1,000 rows, sixteen of them Form 3 with an empty
`transactionType`. The mapper returned 984, `984 < 1000` read as "last page", and the cold ingest
stopped. Nine further pages of real filings were never read.

| AAPL insider history | rows | coverage floor |
| --- | --- | --- |
| before | 956 | 2018-08-18 |
| after | 5,956 | 2003-05-28 |

Fifteen years of filings were missing, and — because the coverage floor is the earliest availability
date actually ingested — every session before 2018-08-18 reported NOT_EVALUABLE for a reason that had
nothing to do with the data. A refresh could not repair it either: the refresh rule correctly stops at
the first page that inserts nothing new, which is page 0.

**Fix.** The port now reports the payload's own length beside the mapped rows (`FmpProviderPage`), and
the walk tests `providerRowCount`. The dataset variants are bumped to `v2`, because a `v1` state row
is a coverage statement that is *wrong* rather than merely old; the bump makes it invisible and the
next read re-ingests cold. Rows are content-addressed, so nothing already persisted duplicates.

**Tests.** `alternative-data.integration.test.ts` — a full page with dropped rows keeps paging; a
genuinely short page still stops; the same for congressional disclosures. All three fail on the
pre-fix code.

## F-02 — Matrix retention could not see 1,006 runs, and the bloat failed live backtests

**Severity: high. Test infrastructure, with a real execution failure. Fixed.**

`cleanupMatrixRuns` scoped every statement to the *current* fixture owner's `userId`. The matrix
fixtures moved from `QA_USER` to `ADMIN_USER` when the runner began submitting through the real
entitlement-enforcing service, so every sweep that ran under the previous owner became permanently
invisible to cleanup.

Measured in `intrinsic_value_matrix` on 2026-09-26: 1,006 runs dated 2026-09-10 owned by
`qa-user@factorsage.test`, alongside the current owner's. `BacktestDailyEquity` held 3,884,050 live
tuples and 3,652,178 dead ones — **1,982 MB in one table**.

That is not only disk. A sweep inserts several million equity rows into a table autovacuum cannot keep
up with, and the five-second interactive transaction that writes a progress checkpoint starts
expiring. Runs that had computed everything correctly failed in `RUNNING`:

```
Transaction API error: Transaction already closed: A commit cannot be executed on an expired
transaction. The timeout for this transaction was 5000 ms, however 5096 ms passed …
  at BacktestProcessor.writeProgress → publishCheckpoint
```

Four such failures in the first 59 cases of a sweep whose two predecessors had both been 1000/1000
green.

**Fix.** The predicate is scoped to the set of test-persona ids rather than to one account — every
persona comes from one registry, so "never selects a real user's data" is unchanged — and the strategy
half of the namespace is the whole `QA-MATRIX-` prefix, so the audit variant (`QA-MATRIX-A…`) is
retained too. Cleanup is followed by `VACUUM (ANALYZE)` on the eight result tables, once, before the
timed sweep (~91 s).

After the fix the same sweep cleaned 1,095 runs from 5 accounts and ran with no such failure.

**Tests.** `matrix-cleanup.integration.test.ts` — a run owned by a previous fixture owner is invisible
to the current owner's predicate and selected when that owner is named; an audit-variant run is
retained.

**Not weakened.** The Prisma transaction timeout was left at 5 s. The audit did not prove the timeout
wrong; it proved the table was bloated.

## F-03 — The matrix would have re-ingested disclosure history from the provider on every run

**Severity: high for the audit's validity. Test infrastructure. Fixed.**

`matrix-worker-pool.ts` pins `STOCK_RECENT_PRICE_FRESHNESS_MS` and `STOCK_FUNDAMENTALS_FRESHNESS_MS`
to ten years so a sweep makes no provider request. `ALT_DATA_FRESHNESS_MS` — whose ordinary window is
**twelve hours** — was not pinned. The moment the matrix contained an alternative-data strategy, every
run would have called FMP during `PREPARING_DATA`.

Two consequences: the gate's "zero provider requests" condition would fail, and `syncedThroughDate` —
the ceiling of the evaluable range — would move between two executions of the same case, which the
determinism comparison would correctly report and nobody could reproduce.

**Fix.** Pinned in the matrix worker pool, and for the same reason in the audit stack, the signals
audit's worker and the E2E stack.

## F-04 — Alternative-data history was not provisioned into the matrix database

**Severity: medium. Test infrastructure. Fixed.**

`provision-matrix-database.ts` mirrored prices, derived state, statements and benchmarks but not
`AlternativeDataActor`, `InsiderTransaction` or `CongressTrade`. A matrix strategy naming an
alternative-data metric would have evaluated against no coverage at all — every session
NOT_EVALUABLE — and the sweep would have reported a thousand green runs that never tested the thing
they were built to test.

**Fix.** Three copiers added. `StockDatasetState` / `StockDatasetCoverage` already crossed with every
other dataset, so the copied coverage floor is the same statement in both databases.
`pnpm data:alt-data:ingest` is the operator command that fills the source.

## F-05 — Provider rows were bound to the requested security without checking the symbol

**Severity: low (latent). Hardened.**

Every persisted row took `securityId` from the security that was asked for; the mapped
`providerSymbol` was never compared against it. A page carrying a foreign symbol — a provider-side
filter change, a paging defect — would have become that security's disclosure history and been counted
by its metrics.

Probed live on 2026-09-26 across `senate-trades`, `house-trades` and `insider-trading/search`, pages
0–60: **every row carried the requested symbol**. So this is a guard, not a fix for an observed
defect. Mismatched rows are now dropped, reported through `onForeignRows`, and excluded from the
coverage window.

## O-01 — Twelve provider rows are dated as filed before the transaction they report

**Observation. No product defect.**

Of 188,969 persisted rows, 12 have `availableFromDate <= transactionDate`: 8 insider, 4 congressional.
They are provider typos — `V` reports a 2021-11-05 transaction filed 2011-11-08, `GOOGL` a transaction
dated **2027-01-25**, `HON` a 2013-10-24 transaction filed 2012-10-25.

The product's rule is satisfied on every one of them: availability is publication + 1 day, and that is
the only claim it makes. It never asserts that a filing follows its trade. The audit reports the count
rather than failing on it, so a change in the feed is visible without the provider's typos being
reported as engine defects.

## O-02 — Two derived rows per long-history security keep a pre-r6 methodology

**Observation. Outside the product horizon; no surface can read them.**

An independent SQL recomputation of Relative Volume over all 259,735 persisted rows of the 33 matrix
securities found 50 absence mismatches for `rvol10` and none for `rvol20` or `rvol50`. All 50 are on
**1992-09-23 and 1992-09-24**, two rows each for the 25 securities whose history reaches that far.

The cause is not the calculation. `DailyDerivedState` carries no variant column: the methodology a row
was written under is recorded in its **coverage interval**, and a rebuild writes only rows inside the
current target. The r6 coverage floor is 1992-09-25, which is exactly the 34-year price-retention
start; the two rows before it were written under r4, before Relative Volume existed, and carry NULL.

They are 3.5 years outside the 30-year product horizon (1996-09-25), and `projectionRange` clips every
product read to that horizon, so nothing can reach them. Worth knowing rather than worth fixing: the
row-level guard against reading a superseded methodology is the coverage interval, not the row.

## V-01 — Relative Volume is exact over the whole persisted history

**Verification. No defect.**

An independent recomputation in SQL — PostgreSQL window functions, a different implementation from the
engine's rolling accumulator and from the audit oracle's slice-and-average — over every persisted row
of all 33 matrix securities:

| | rows compared | absence mismatches | value mismatches | max abs difference |
| --- | --- | --- | --- | --- |
| `rvol10` | 259,735 | 50 (see O-02) | 0 | 5.0e-9 |
| `rvol20` | 259,735 | 0 | 0 | 5.0e-9 |
| `rvol50` | 259,735 | 0 | 0 | 5.0e-9 |

5.0e-9 is exactly half a unit in the eighth decimal, which is what `Decimal(20,8)` storage quantizes
to. The stored values are the correctly-rounded representation of the exact ratio.

Warm-up boundaries are exact after the full-history rebuild: every security holds `n − 10`, `n − 20`
and `n − 50` values for the three periods, and a late listing warms up from its own first bar
(`ALAB`: first `rvol10` ten sessions after listing, `rvol20` at twenty, `rvol50` at fifty).

## V-02 — Every persisted disclosure's availability date is publication + 1 day

**Verification. No defect.**

Across all 179,782 insider and 9,187 congressional rows:

| Check | Result |
| --- | --- |
| `availableFromDate <> filingDate + 1 day` | 0 |
| `availableFromDate <> disclosureDate + 1 day` | 0 |
| A zero or absent price producing a transaction value | 0 |
| An amount lower bound equal to the band's midpoint | 0 |
| Non-stock congressional rows kept but never counted | 405 kept, excluded by the `STOCK` filter |

The insider classification is doing real work: of 179,782 rows only **1,431 are open-market
purchases**. 45,962 awards and 44,336 option exercises would have been counted as purchases by an
implementation that read "acquisition" as "buy".
