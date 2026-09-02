# Fundamentals Loader

## Status

Implementation decision for `feat/fundamentals-loader`.

This slice extends the canonical `@intrinsic/stock-data` boundary with historical standardized financial statements. It deliberately stops before valuation formulas and frontend Stock Details work.

## Goals

- Persist 30 years (configurable through the existing stock history horizon) of standardized Income Statement, Balance Sheet, and Cash Flow history when FMP provides it.
- Load both quarterly (`Q1`-`Q4`) and annual (`FY`) statements.
- Keep PostgreSQL authoritative and Redis disposable/rebuildable under the existing complete-stock LRU.
- Preserve point-in-time/no-look-ahead semantics for future backtests and intrinsic-value calculations.
- Reuse the existing FMP request gate, stock-level load coordination, structured logging, and cache generation rules.
- Keep FMP DTO quirks in `@intrinsic/fmp`; domain/store/cache contracts use canonical financial-statement types.

## Explicitly out of scope

- intrinsic-value formula implementation
- intrinsic-value materialization
- key-metrics / ratios endpoints
- dividends and stock splits
- Stock Details frontend
- financial-statement HTTP endpoints or API contract changes
- strategy/backtest implementation
- raw/as-reported XBRL ingestion

## FMP source

Use the current stable standardized endpoints:

```text
/stable/income-statement
/stable/balance-sheet-statement
/stable/cash-flow-statement
```

Common query parameters used by this implementation are:

```text
symbol
period=quarter | annual
limit
```

Unlike historical EOD prices, these statement endpoints do not provide the canonical `from` / `to` interval contract used by the price loader. Do not pretend statement hydration can request exact missing date ranges.

Each standardized record currently provides common metadata including:

```text
date
symbol
reportedCurrency
cik
filingDate
acceptedDate
fiscalYear
period
```

`period=quarter` returns standalone `Q1`-`Q4` rows. `period=annual` returns `FY` rows. Keep both; do not derive one cadence from the other in this PR.

## Canonical domain model

Add:

```text
FinancialStatementType = INCOME | BALANCE_SHEET | CASH_FLOW
FinancialStatementCadence = QUARTERLY | ANNUAL
FinancialPeriod = FY | Q1 | Q2 | Q3 | Q4
```

A canonical financial statement snapshot contains:

```text
securityId
statementType
fiscalDate            // FMP standardized `date`, YYYY-MM-DD
fiscalYear
period
reportedCurrency
filingDate             // YYYY-MM-DD
availableFromDate      // PIT eligibility date defined below
observedAt             // when this exact revision was first persisted by us
contentHash            // deterministic hash of canonical statement content
values                 // canonical typed numeric line-item object
```

Provider-specific metadata such as the raw timezone-less FMP `acceptedDate` may be persisted as audit metadata, but it is not the V1 PIT eligibility field and must not leak into valuation logic.

### Canonical line-item catalogs

Do not persist the raw FMP object. Define explicit canonical field catalogs and map only these fields. Missing upstream fields remain absent/null; never fabricate zero. A provider-supplied numeric zero is preserved as zero.

Income Statement v1 fields:

```text
revenue
costOfRevenue
grossProfit
researchAndDevelopmentExpenses
generalAndAdministrativeExpenses
sellingAndMarketingExpenses
sellingGeneralAndAdministrativeExpenses
otherExpenses
operatingExpenses
costAndExpenses
netInterestIncome
interestIncome
interestExpense
depreciationAndAmortization
ebitda
ebit
nonOperatingIncomeExcludingInterest
operatingIncome
totalOtherIncomeExpensesNet
incomeBeforeTax
incomeTaxExpense
netIncomeFromContinuingOperations
netIncomeFromDiscontinuedOperations
otherAdjustmentsToNetIncome
netIncome
netIncomeDeductions
bottomLineNetIncome
eps
epsDiluted
weightedAverageShsOut
weightedAverageShsOutDil
```

Balance Sheet v1 fields:

```text
cashAndCashEquivalents
shortTermInvestments
cashAndShortTermInvestments
netReceivables
accountsReceivables
otherReceivables
inventory
prepaids
otherCurrentAssets
totalCurrentAssets
propertyPlantEquipmentNet
goodwill
intangibleAssets
goodwillAndIntangibleAssets
longTermInvestments
taxAssets
otherNonCurrentAssets
totalNonCurrentAssets
otherAssets
totalAssets
totalPayables
accountPayables
otherPayables
accruedExpenses
shortTermDebt
capitalLeaseObligationsCurrent
taxPayables
deferredRevenue
otherCurrentLiabilities
totalCurrentLiabilities
longTermDebt
capitalLeaseObligationsNonCurrent
deferredRevenueNonCurrent
deferredTaxLiabilitiesNonCurrent
otherNonCurrentLiabilities
totalNonCurrentLiabilities
otherLiabilities
capitalLeaseObligations
totalLiabilities
treasuryStock
preferredStock
commonStock
retainedEarnings
additionalPaidInCapital
accumulatedOtherComprehensiveIncomeLoss
otherTotalStockholdersEquity
totalStockholdersEquity
totalEquity
minorityInterest
totalLiabilitiesAndTotalEquity
totalInvestments
totalDebt
netDebt
```

Cash Flow v1 fields:

```text
netIncome
depreciationAndAmortization
deferredIncomeTax
stockBasedCompensation
changeInWorkingCapital
accountsReceivables
inventory
accountsPayables
otherWorkingCapital
otherNonCashItems
netCashProvidedByOperatingActivities
investmentsInPropertyPlantAndEquipment
acquisitionsNet
purchasesOfInvestments
salesMaturitiesOfInvestments
otherInvestingActivities
netCashProvidedByInvestingActivities
netDebtIssuance
longTermNetDebtIssuance
shortTermNetDebtIssuance
netStockIssuance
netCommonStockIssuance
commonStockIssuance
commonStockRepurchased
netPreferredStockIssuance
netDividendsPaid
commonDividendsPaid
preferredDividendsPaid
otherFinancingActivities
netCashProvidedByFinancingActivities
effectOfForexChangesOnCash
netChangeInCash
cashAtEndOfPeriod
cashAtBeginningOfPeriod
operatingCashFlow
capitalExpenditure
freeCashFlow
incomeTaxesPaid
interestPaid
```

Use explicit TypeScript field catalogs/unions so the JSON payload remains canonical and typed without creating ~120 provider-shaped Prisma columns.

## Verified provider value semantics

These conventions were verified against current real FMP statement data and are now the pinned
contract for every consumer of `FinancialStatement.values`. They are provider semantics, not
product methodology.

1. `capitalExpenditure` is a **signed cash-flow outflow** and is negative in the normal cases
   inspected.
2. FMP's own `freeCashFlow` satisfies `freeCashFlow = operatingCashFlow + capitalExpenditure`,
   precisely because `capitalExpenditure` is already negative. It is an addition, not a
   subtraction.
3. `commonDividendsPaid` and `netDividendsPaid` are **signed cash outflows** and are negative in
   the normal dividend-paying cases inspected.
4. `changeInWorkingCapital` is already the **signed cash-flow contribution** used in the cash-flow
   statement and may be positive or negative. It must never be treated as a conventional positive
   delta-NWC and subtracted again; its effect is already inside `operatingCashFlow`.
5. `interestExpense` is a **positive expense magnitude** when FMP reports it separately on the
   income statement.
6. `period=quarter` rows are **standalone** `Q1`-`Q4` rows, not cumulative YTD rows. Current FMP
   MSFT FY2026 quarterly values sum exactly to the `FY` row for revenue, net income, operating
   cash flow, capital expenditure, `changeInWorkingCapital` and `commonDividendsPaid`.

The mapper does not normalize any of this. Provider values stay canonical exactly as supplied:
signs are preserved, `freeCashFlow` is never recalculated, zero stays zero, and no cadence is
converted or aggregated. Financial calculations interpret the convention explicitly at the point
of use. These rules are locked by
`packages/fmp/src/mapping.test.ts` in `describe("FMP financial statement value semantics")`.

## Persistence

Prefer one durable `FinancialStatement` model rather than three almost-identical tables.

Conceptual Prisma shape:

```text
id                    UUID
securityId            FK -> Security
statementType         enum
fiscalDate            DATE
fiscalYear            INT
period                enum
reportedCurrency      STRING
filingDate            DATE
availableFromDate     DATE
providerAcceptedDate  STRING?   // audit only; FMP timestamp has no timezone
contentHash           STRING
observedAt            TIMESTAMP
values                JSONB
```

Recommended identity/indexes:

```text
UNIQUE(securityId, statementType, fiscalDate, period, filingDate, contentHash)
INDEX(securityId, statementType, period, fiscalDate)
INDEX(securityId, statementType, period, availableFromDate)
```

Add the relation on `Security` and an explicit Prisma migration. Do not alter the existing price
tables or the unified `DailyDerivedState` row.

The canonical JSON payload must be produced by the FMP mapper before persistence. `FinancialStatement.values` is not an FMP DTO dump.

## Point-in-time availability policy

V1 is deliberately conservative and daily-granularity.

FMP `acceptedDate` is currently returned without an explicit timezone. Do not manufacture precision by parsing it as local server time or UTC.

For V1:

```text
initial availableFromDate = filingDate + 1 calendar day
```

Consequences:

- a filing accepted after market close can never affect the same day's historical decision;
- a pre-market filing may become eligible one day later than theoretically necessary, which is acceptable because the policy prefers no-look-ahead correctness over same-day precision;
- weekends/holidays require no special case: backtests only consume the snapshot on a later eligible trading date.

Future work may replace this with exchange-calendar + timezone-aware accepted-time semantics. That requires a versioned methodology change; do not silently change V1 history.

## Revisions and restatements

Statements are immutable snapshots. Never overwrite a previously persisted revision merely because FMP later returns different values for the same fiscal period.

Logical fiscal identity is:

```text
securityId + statementType + fiscalYear + period + fiscalDate
```

`contentHash` is deterministic over canonical metadata/values using stable key ordering.

Persistence behavior:

1. If the same content hash for the logical identity already exists, do not insert a duplicate.
2. If a new filing date appears for an existing logical identity, insert a new snapshot with `availableFromDate = filingDate + 1 day`.
3. If content changes for an existing logical identity without a later filing date, treat it as a revision first observed by us now. Insert a new snapshot and use:

```text
availableFromDate = max(filingDate + 1 day, observedAt calendar date)
```

This prevents a newly observed correction from being backdated into historical backtests.

Known V1 limitation: the initial FMP standardized backfill can already contain historical restatements. Without a historical raw filing ledger we cannot reconstruct values that FMP no longer exposes. This PR must not claim stronger historical-vintage guarantees than the upstream data supports. From first ingestion onward, revisions observed by the product are preserved PIT-correctly.

## Read selection semantics

Introduce one pure selector used consistently by cache/store-facing service code.

For a query:

```text
statementTypes?
cadence?               // QUARTERLY or ANNUAL
from? / to?            // filter by fiscalDate
asOf?                  // PIT visibility cutoff by availableFromDate
```

Rules:

- `ANNUAL` means `period == FY`.
- `QUARTERLY` means `period in Q1,Q2,Q3,Q4`.
- filter requested fiscal-date range first.
- when `asOf` exists, exclude snapshots where `availableFromDate > asOf`.
- for each logical fiscal identity, select the latest eligible revision ordered by `availableFromDate`, then `observedAt`.
- without `asOf`, select the latest persisted revision for each logical fiscal identity.
- results are deterministic ascending by `fiscalDate`, then statement type/period.

Do not mix a future revision into an old `asOf` query.

## Dataset state and FMP loading

Use existing `StockDatasetState` dataset values:

```text
INCOME_STATEMENT
BALANCE_SHEET
CASH_FLOW
```

State variants must distinguish cadence, mapping version, and configured horizon because these endpoints cannot prove arbitrary date-range coverage:

```text
standard:quarter:v<mappingVersion>:h<historyYears>:w<warmupYears>
standard:annual:v<mappingVersion>:h<historyYears>:w<warmupYears>
```

The variant encodes the retention policy as well as the horizon: an older successful `h30` state
must not be read as proof that the wider `h30:w7` retention has already been backfilled. The
mapping version changes only when the provider mapping itself changes.

A successfully persisted state row for a variant means the full configured backfill request completed, including a successful empty response. Failed/partial attempts must not advance the successful state.

### Valuation warm-up retention

Fundamentals are retained for `VALUATION_FUNDAMENTALS_WARMUP_YEARS = 7` fiscal years **before** the
visible history:

```text
price / derived / API / backtest target = [today - historyYears, today]
fundamentals retention target           = [today - historyYears - 7, today]
```

Both are clamped to a known IPO/listing date. The warm-up exists only so that a valuation on the
**first visible trading day** already has a point-in-time eligible four-quarter TTM window and the
exact `N` / `N - 5` annual growth endpoints; without it the earliest ~1.5 years would carry no
intrinsic values and the first ~6 years would fall back to `DEFAULT_GROWTH`.

Rules:

- visible stock, derived-state, API projection and backtest history remain exactly `historyYears`;
  no `DailyDerivedState` row is ever produced for a warm-up year, because daily materialization
  uses only the visible price trading dates;
- `canonicalTarget` stays the user-visible price/derived target. A separate internal
  `fundamentalsTarget` is used only for statement backfill, statement publication and the derived
  rebuild's revision read;
- public `getFinancialStatements` stays bounded to the visible range: the extra years are internal
  valuation context, not newly exposed product history;
- retention is a loader guarantee, not a data guarantee. The provider may still not have those
  older statements, in which case a model is naturally unavailable or growth falls back exactly as
  the valuation methodology documents.

### Initial backfill

If the cadence-specific state variant does not exist, fetch the retained horizon using bounded
record counts. Capacity covers the visible years plus the warm-up years, keeping the existing
safety tails:

```text
quarter limit = (historyYears + warmupYears) * 4 + 8
annual limit  = (historyYears + warmupYears) + 2
```

Apply the fundamentals retention horizon after mapping: discard fiscal rows older than
`today - historyYears - warmupYears` / the known listing boundary when appropriate.

There are six source requests for a complete initial fundamentals backfill:

```text
3 statement types * 2 cadences
```

They may run concurrently through the existing FMP request gate; do not bypass distributed concurrency/rate-limit/cooldown controls.

### Refresh

Add:

```text
STOCK_FUNDAMENTALS_FRESHNESS_MS
```

Default: 6 hours.

When fundamentals are stale, refresh bounded recent windows only:

```text
quarter limit = 12
annual limit  = 3
```

These recent requests are intentionally overlap-based rather than fake date-range deltas. Deduplication/revision semantics make repeated unchanged rows cheap and allow recent corrections/new filings to be discovered.

`lastFundamentalsRefreshAt` advances only after all six refresh requests required by the operation succeed and persistence/cache publication completes. A partial failure may persist safe immutable rows but must not mark the whole fundamentals set fresh.

## Stock hydration/freshness integration

Fundamentals belong to the same canonical stock-data service; do not create a second API-only loader.

Extend the existing stock hydration lifecycle rather than bypassing it:

- initial `ensureStockHydrated` backfills missing fundamentals state variants or rehydrates them from PostgreSQL;
- Redis fundamentals are published before READY;
- old READY manifests lacking the new financial-statement dataset version are treated as stale and reconstructed;
- `ensureStockFresh` evaluates price freshness and fundamentals freshness independently under the same stock-level coordination resource;
- if only one group is stale, do not refetch the other group unnecessarily.

Do not widen the existing large Prisma write transaction pattern. Persist statement batches in bounded dataset/cadence operations and keep the READY/freshness marker as the cross-dataset completion boundary.

## Redis

All historical fundamentals for a resident stock must be available from Redis, while PostgreSQL remains authoritative.

Extend `StockManifest` with conceptually:

```text
financialStatementVersion: 1
lastFundamentalsRefreshAt?: Instant
```

Suggested keys:

```text
stock-data:v2:security:<id>:financials:income:quarter:v1:<year>
stock-data:v2:security:<id>:financials:income:annual:v1:<year>
stock-data:v2:security:<id>:financials:balance-sheet:quarter:v1:<year>
stock-data:v2:security:<id>:financials:balance-sheet:annual:v1:<year>
stock-data:v2:security:<id>:financials:cash-flow:quarter:v1:<year>
stock-data:v2:security:<id>:financials:cash-flow:annual:v1:<year>
```

Year is the `fiscalDate` year. Store all immutable revisions for the year; apply the pure selector at read time.

Every key must use the existing registered-key/generation mechanism so:

- HYDRATING TTL behavior remains valid;
- stale owners cannot publish into a successor generation;
- complete-stock LRU eviction removes financials together with prices and the daily derived state;
- no hot-path `SCAN` is introduced.

On refresh, rewrite only affected fiscal years for the statement/cadence series whose persisted rows changed.

## StockDataService

Add a generic canonical read capability rather than six public methods:

```text
getFinancialStatements(symbol, query)
```

Keep provider/store/cache-specific shapes behind their ports. Both future Stock Details and worker/backtests must use this same method.

Do not add fundamentals to the public `StockDetails` HTTP response in this PR; the frontend/API contract is a later vertical-slice change.

## Observability

Follow `ai/architecture/observability.md` and the path-specific Copilot instructions.

High-value events should make the following diagnosable without `trace`:

```text
fundamentals.backfill.started/completed/failed
fundamentals.refresh.started/completed/failed
fundamentals.dataset.persisted
```

Include relevant fields such as:

```text
symbol
statementType
cadence
rowCount
insertedRevisionCount
unchangedCount
durationMs
```

Use `debug` for individual provider request/limit details and cache year rewrites. Do not log full statement payloads or credentials.

## Required tests

### Domain/mapping

1. Standard FMP common metadata maps deliberately into canonical metadata.
2. Quarterly `Q1`-`Q4` and annual `FY` are validated correctly.
3. Every v1 catalog field maps when numeric.
4. Missing fields remain missing; mapper never creates zero.
5. Provider zero remains zero.
6. Invalid required metadata or non-numeric provided line items fail deterministically.
7. Provider ordering does not affect canonical ascending reads.

### PIT/revisions

8. Initial snapshot is eligible only from `filingDate + 1 day`.
9. Same hash is idempotent and does not create another revision.
10. New filing-date revision is preserved alongside the old revision.
11. Same-filing-date changed content is not backdated before `observedAt`.
12. `asOf` before a revision returns the older eligible snapshot.
13. `asOf` after a revision returns the newer snapshot.
14. No-asOf reads return the latest persisted revision.

### Loader/persistence/cache

15. First hydration requests exactly six full-backfill statement calls with the expected cadence/limits.
16. Existing successful state variants cause DB-only Redis re-admission with no fundamentals FMP request.
17. Stale fundamentals refresh requests only the six bounded recent calls, not the full 30-year history.
18. Fresh fundamentals perform no provider request.
19. Fundamentals failure does not advance `lastFundamentalsRefreshAt`.
20. Price freshness and fundamentals freshness are independent.
21. Redis year read/write preserves all revisions and exact fiscal-range slicing.
22. Old manifests without `financialStatementVersion=1` are not accepted as READY.
23. Complete-stock LRU eviction removes registered fundamentals keys with the rest of the stock.
24. Two service instances competing for the same stock do not perform duplicate full fundamentals backfills.
25. State variants change when `historyYears` changes, forcing an appropriate new backfill.

### FMP client

26. Stable paths/query parameters are exact and API keys are never included in errors/logs.
27. Statement calls continue to use the existing Redis FMP gate/retry/cooldown behavior.

### Optional live test

Add an opt-in live AAPL test that verifies current standardized statements expose consistent common metadata across income/balance/cash-flow for at least one recent quarter. Do not make live FMP a normal deterministic CI dependency.

## Validation

During implementation use targeted tests. Once settled, run the full gate once:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @intrinsic/stock-data test:redis
pnpm build
```

Do not implement valuation, HTTP/frontend financials, unrelated refactors, or speculative abstractions in this branch.
