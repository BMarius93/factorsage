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

## O-03 — A Monitor cannot evaluate an alternative-data metric on a session newer than the last ingest

**Observation. Correct by the stated rule, but its interaction with the freshness window is worth
knowing. Not changed in this branch.**

`coverage.to` is `syncedThroughDate`, the **calendar date of the last successful ingest**, and
`buildAlternativeDataColumn` reports NOT_EVALUABLE for any session after it. That is the documented
rule and it is the honest one: past the last ingest the product has not looked, and a count of zero
would be a claim it cannot make.

The freshness window is twelve hours (`ALT_DATA_FRESHNESS_MS`). So a Monitor cycle that runs before
the window has elapsed skips the ingest, `syncedThroughDate` is still yesterday, and every
alternative-data metric on **today's provisional session** is NOT_EVALUABLE — the levels that name
one simply do not become ACTIVE. With a 22:00 ingest and a 12-hour window that is roughly the first
half hour of the following session.

Nothing is wrong: no signal fires on data the product does not have, which is the whole point. But
"my insider rule went quiet this morning" has a cause that is not visible from the Signal, and the
two settings — the freshness window and the coverage ceiling — are coupled in a way neither
documents. A shorter window for the two disclosure domains, or a ceiling expressed as the last
*session* rather than the last ingest date, would both close it; both are product decisions rather
than audit findings, so this branch only records the coupling.

The same interaction cannot affect a matrix sweep: `ALT_DATA_FRESHNESS_MS` is pinned to ten years
there (F-03), so `syncedThroughDate` is fixed at the provisioning ingest and every simulated session
is inside it.

## V-03 — The insider point-in-time boundary, hand-checked on real filings

**Verification. No defect.**

`Insider buyers / purchases / purchase value 20D` for AAPL, recomputed independently in SQL from the
persisted rows and read session by session across two real filings. Every number below is
hand-checkable from the rows underneath it.

| Session | buyers 20D | purchases 20D | purchase value 20D | Why |
| --- | --- | --- | --- | --- |
| 2006-09-01 | 0 | 0 | $0 | Fadell filed **on** 2006-09-01. The filing date itself is never credited. |
| 2006-09-05 | 1 | 3 | $18,077.40 | Available 09-02, a Saturday; the first session at or after it is Tuesday 09-05, because Monday 09-04 was Labor Day. Three fills, one person. |
| 2006-09-06 | 1 | 3 | $18,077.40 | |
| 2006-09-07 | 1 | 3 | $18,077.40 | Schmidt **traded** 09-05 and **filed** 09-07. A reader on 09-07 cannot have seen it. |
| 2006-09-08 | **2** | **8** | $716,007.40 | Schmidt available 09-08. Two distinct people; eight fills. |
| 2006-10-05 | 1 | 5 | $697,930.00 | Fadell's three have left the twenty-session window. |
| 2006-10-06 | 0 | 0 | $0 | Schmidt's five have left too. A real zero, and a rule may act on it. |
| 2007-10-26 | 0 | 0 | $0 | Campbell filed **on** 2007-10-26. |
| 2007-10-29 | 1 | 3 | $696,071.00 | Available Saturday 10-27; first session Monday 10-29. |

Four separate properties, each proved by a real row rather than by a fixture:

- **The publication date is not the availability date.** Two filings, two zeros on their own filing
  date.
- **The observable session is the frame's own next session.** A Saturday availability rolls to
  Tuesday across Labor Day in one case and to Monday in the other, with no holiday calendar anywhere
  in the evaluator — the security's own date axis does it.
- **Distinct actors are people, not rows.** 2006-09-08 holds eight purchases and two buyers.
- **The transaction date is preserved and is not what the window measures.** Campbell's three
  purchases were made on 2006-02-28, 2006-09-12 and 2007-01-26 and are all counted on 2007-10-29 —
  up to twenty months after the trade, because that is when the filing appeared.

## V-04 — The disclosure lag is large enough that windowing on the transaction date would be silently useless

**Verification of the product decision, measured.**

`docs/alternative-data-signals.md` argues that a congressional window must be measured on the
observable session because "a congressional disclosure routinely lags its transaction by up to
forty-five days, so windowing on the transaction date would produce a metric that is almost always
zero while still looking correct". Measured over the ingested universe:

| | value |
| --- | --- |
| Congressional stock disclosures ingested | 8,782 |
| Mean transaction → disclosure lag | **78 days** |
| Disclosures with a lag over 30 days | **3,482 (39.6%)** |
| AAPL mean lag / maximum lag | 98 days / **1,686 days** |

The default Congress lookback is 30 **sessions** — about six calendar weeks. Nearly forty per cent of
all disclosures become public after that window has already passed over their transaction date, so a
metric windowed on the transaction date would never see them. The argument in the specification is
not a rule of thumb; it is what the data does.

The minimum lag is **−21 days** — a disclosure dated before the transaction it reports, which is one
of the twelve provider anomalies in O-01.
