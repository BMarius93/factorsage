# Fundamental Metrics V1

## Status

**Proposed methodology lock.** Merging this decision makes the methodology below authoritative for
the implementation built on it: the point-in-time calculation first, then its persistence in the
unified derived state.

This decision builds on, and does not reinterpret:

- `docs/decisions/fundamentals-loader.md` — canonical standardized statements, provider sign
  conventions, immutable revisions and `availableFromDate` point-in-time eligibility;
- `docs/decisions/intrinsic-value-engine.md` — exact-quarter TTM semantics, flow-window alignment,
  latest-state semantics and no-look-ahead rules;
- `docs/decisions/retain-wide-column-calculated-series-storage.md` — one nullable column per
  calculated daily series on `DailyDerivedState`;
- `ai/architecture/calculated-series.md` and `ai/architecture/strategy-evaluation.md` — one daily
  materialization path and one evaluation-frame path shared by chart, Strategy, Backtest and
  Monitor consumers.

This document fixes formulas and availability rules before product code is added. It does not add a
new provider endpoint, a new source table, a new cache family, a new Strategy operator, or a new
valuation metric.

## Scope

V1 exposes exactly fifteen statement-derived metrics.

| Group | Metric | Product unit | Storage field |
| --- | --- | --- | --- |
| Growth | Revenue Growth TTM YoY | percent | `revenueGrowthTtmYoy` |
| Growth | EPS Growth TTM YoY | percent | `epsGrowthTtmYoy` |
| Growth | FCF Growth TTM YoY | percent | `fcfGrowthTtmYoy` |
| Profitability | Gross Margin TTM | percent | `grossMarginTtm` |
| Profitability | Operating Margin TTM | percent | `operatingMarginTtm` |
| Profitability | Net Margin TTM | percent | `netMarginTtm` |
| Profitability | FCF Margin TTM | percent | `fcfMarginTtm` |
| Quality | ROIC TTM | percent | `roicTtm` |
| Quality | ROE TTM | percent | `roeTtm` |
| Quality | ROA TTM | percent | `roaTtm` |
| Leverage | Debt / Equity | multiple | `debtToEquity` |
| Liquidity | Current Ratio | multiple | `currentRatio` |
| Leverage | Net Debt / EBITDA TTM | multiple | `netDebtToEbitdaTtm` |
| Solvency | Interest Coverage TTM | multiple | `interestCoverageTtm` |
| Efficiency | Asset Turnover TTM | multiple | `assetTurnoverTtm` |

No additional metric is implicitly part of V1. In particular, absolute Revenue, EPS, FCF, EBITDA,
book value and debt are calculation inputs, not Strategy-visible metrics under this decision.

`P/E`, `P/S`, `P/FCF` and `EV/EBITDA` are **Valuation**, not Fundamentals. They combine a PIT
fundamental denominator with a daily market-price observation and require a separate methodology
lock. They are explicitly out of scope here.

## Units

Percent metrics are stored and evaluated in **percentage points**, not fractions:

```text
0.1542 economic ratio -> 15.42 stored/product value -> UI renders 15.42%
```

That matches the existing Strategy `PERCENT` convention: a user entering `15%` supplies `15`, not
`0.15`. There must be no hidden conversion inside the evaluator.

Multiple metrics are stored as raw multiples:

```text
Debt / Equity = 0.75
Current Ratio = 1.60
Net Debt / EBITDA = 2.40
Interest Coverage = 8.25
Asset Turnover = 0.90
```

Calculations use full available precision. Display rounding is presentation only and must never feed
back into persistence, Strategy evaluation or a backtest.

## Shared point-in-time rules

For a metric effective on trading day `D`:

1. Only `FinancialStatement` revisions with `availableFromDate <= D` may be used.
2. For each logical fiscal identity, use the latest revision eligible on `D` under the existing
   financial-statement selector semantics.
3. Quarterly calculations use standalone `Q1`/`Q2`/`Q3`/`Q4` rows only.
4. A TTM flow window means exactly four distinct consecutive fiscal quarters. Missing one quarter
   makes that metric unavailable. An `FY` row never fills a TTM gap.
5. When a metric needs more than one statement family in one flow window, all families must use the
   same four fiscal-quarter identities. Independently choosing "latest four" windows is forbidden.
6. Missing is never zero. A provider-supplied numeric zero remains a real zero.
7. A metric may become unavailable when a later eligible statement revision invalidates one of its
   required inputs. An obsolete value must not carry forward past that event.
8. Current profile data and current market data are forbidden as historical fundamental inputs.
9. Fiscal-quarter identity, not calendar-quarter position, defines adjacency. Non-calendar fiscal
   years receive identical treatment.
10. The existing conservative statement rule remains authoritative: `availableFromDate` is derived
    from filing/revision availability by the fundamentals loader. Fundamental Metrics must not
    reconstruct or second-guess filing timestamps.
11. **No stale-window fallback.** Every flow window is anchored at the newest fiscal quarter the
    metric is evaluated for (see "Window anchors"). When that window is incomplete the metric is
    unavailable; it never falls back to an older complete window.
12. **One currency per observation.** Every statement that contributes a value to one metric
    observation — every quarter of its flow window or windows, and every balance-sheet state it
    reads — must report the same non-empty `reportedCurrency`. Mixed currencies, inside one window,
    across the current and previous TTM windows, across statement families, or between a flow
    window and a balance-sheet state, make that metric unavailable; so does a contributing statement
    without a currency. V1 performs no FX conversion, uses no current FX data and treats no two
    currency codes as equivalent. A single-statement ratio (Debt / Equity, Current Ratio) needs that
    statement to carry a currency.
13. **One fiscal quarter, one representing revision.** A provider can report a quarter with a
    moved period end, which the canonical selector keeps as a second logical identity. The quarter
    is represented by its latest eligible revision — later `availableFromDate`, then later
    `observedAt`; the later `fiscalDate` decides only between rows one observation delivered, then
    `contentHash` — whichever way the period end moved. The loader dates such a revision from its
    own filing only when it carries a real filing date made public after every filing stored for
    the quarter (a period-end placeholder never counts), otherwise from when it was first observed
    (`fundamentals-loader.md`, "Revisions and restatements"), so it never changes a session before
    it became known. Intrinsic value applies the same rule to its quarterly windows and annual rows.

The materializer maps an eligible statement event to the first canonical trading date on or after
its `availableFromDate`. A weekend or exchange holiday therefore produces no synthetic daily row;
the next actual `DailyPrice` date is the first day on which the new information may appear.

## Shared TTM helpers

The implementation should have one pure set of fiscal-window helpers rather than one bespoke
quarter selector per metric.

For a current four-quarter window:

```text
Q[-3], Q[-2], Q[-1], Q[0]
```

`Q[0]` is the window's anchor, fixed by the rules below, and all four identities are PIT eligible on
`D`.

### Window anchors

Freshness wins over completeness: a metric never reports an older period as if it were current.

- **Single-family flow metrics** (Revenue, EPS and FCF Growth, the Income margins, Interest
  Coverage, and the EBITDA window of Net Debt / EBITDA): `Q[0]` is that family's latest
  PIT-eligible quarterly fiscal identity. The exact predecessor chain the metric needs —
  `Q[-3]..Q[0]`, or `Q[-7]..Q[0]` for a TTM YoY metric — must exist in full; a missing identity
  makes the metric unavailable. There is no search backward for an older complete window.
- **Cross-family flow metrics** (FCF Margin): `Q[0]` is the newest quarterly fiscal identity held by
  any of the required families. Every required family must hold exactly `Q[-3]..Q[0]`; when one
  family lags the others, or has stopped reporting, the metric is unavailable. There is no fallback
  to an older window the families happen to share.
- **Averaged-state metrics** (ROIC, ROE, ROA, Asset Turnover): `Q[0]` is the latest Income quarter
  and the flow window is exactly `Q[-3]..Q[0]` of Income. The balance sheets required are exactly
  two identities: the opening state (the quarter immediately before `Q[-3]`) and the ending state
  (`Q[0]`). The interior balance-sheet quarters are not consumed and not required. A newer balance
  sheet never replaces the ending state.
- **Latest-state metrics** (Debt / Equity, Current Ratio, and the net debt of Net Debt / EBITDA):
  the latest PIT-eligible quarterly Balance Sheet as of `D`, independently of any flow window.

A TTM YoY growth metric requires the immediately preceding four-quarter window too:

```text
previous TTM: Q[-7], Q[-6], Q[-5], Q[-4]
current  TTM: Q[-3], Q[-2], Q[-1], Q[0]
```

All eight quarter identities must exist, be consecutive and be PIT eligible on `D`. V1 does not
rescale a shorter span into a one-year growth rate and does not substitute an annual row.

For metrics that use average balance-sheet state aligned to a TTM flow window, define:

```text
opening state = balance sheet for the fiscal quarter immediately before Q[-3]
ending state  = balance sheet for Q[0]
average state = (opening + ending) / 2
```

Both balance-sheet rows must be PIT eligible on `D`. Exactly these two balance-sheet identities are
required. The interior balance sheets for `Q[-3]`, `Q[-2]` and `Q[-1]` are neither consumed nor
required, and their absence never makes a metric unavailable. Requiring the aligned ending state
avoids pairing a trailing flow with an unrelated newer state merely because that newer filing
arrived first.

## Free cash flow convention

FMP's canonical cash-flow signs are already locked by `fundamentals-loader.md`:
`capitalExpenditure` is normally negative. V1 therefore defines per-quarter FCF as:

```text
FCF_q = operatingCashFlow_q + capitalExpenditure_q
```

Both fields are required for each quarter. Provider `freeCashFlow` is a reconciliation field only;
it is not the primary calculation input and no missing component is replaced from it.

```text
FCF_TTM = sum(FCF_q over the exact four-quarter TTM window)
```

## Metric formulas

### 1. Revenue Growth TTM YoY

Income Statement only. Require eight consecutive eligible quarters and `revenue` in every quarter.

```text
Revenue_TTM_current  = sum(revenue Q[-3]..Q[0])
Revenue_TTM_previous = sum(revenue Q[-7]..Q[-4])

require Revenue_TTM_current  > 0
require Revenue_TTM_previous > 0

Revenue Growth TTM YoY =
  (Revenue_TTM_current / Revenue_TTM_previous - 1) * 100
```

### 2. EPS Growth TTM YoY

Income Statement only. V1 intentionally follows the existing Graham-model EPS convention and sums
standalone quarterly `epsDiluted`; it does not reconstruct EPS from current shares.

```text
EPS_TTM_current  = sum(epsDiluted Q[-3]..Q[0])
EPS_TTM_previous = sum(epsDiluted Q[-7]..Q[-4])

require EPS_TTM_current  > 0
require EPS_TTM_previous > 0

EPS Growth TTM YoY =
  (EPS_TTM_current / EPS_TTM_previous - 1) * 100
```

Crossing from a loss to a profit, from a profit to a loss, or comparing two non-positive EPS
windows is **unavailable**, not an enormous or sign-inverted growth percentage. Profitability can be
expressed through the other metrics; V1 does not invent a special turnaround percentage.

### 3. FCF Growth TTM YoY

Cash Flow Statement only. Require eight consecutive eligible quarters and both OCF and CapEx in
every quarter.

```text
FCF_TTM_current  = sum(operatingCashFlow + capitalExpenditure, Q[-3]..Q[0])
FCF_TTM_previous = sum(operatingCashFlow + capitalExpenditure, Q[-7]..Q[-4])

require FCF_TTM_current  > 0
require FCF_TTM_previous > 0

FCF Growth TTM YoY =
  (FCF_TTM_current / FCF_TTM_previous - 1) * 100
```

Negative-to-positive or positive-to-negative transitions are unavailable for this growth metric.

### 4. Gross Margin TTM

Income Statement only. Require one exact four-quarter window with both fields present.

```text
Revenue_TTM     = sum(revenue)
GrossProfit_TTM = sum(grossProfit)

require Revenue_TTM > 0

Gross Margin TTM = GrossProfit_TTM / Revenue_TTM * 100
```

A negative gross margin is a valid reading.

### 5. Operating Margin TTM

Income Statement only.

```text
Revenue_TTM         = sum(revenue)
OperatingIncome_TTM = sum(operatingIncome)

require Revenue_TTM > 0

Operating Margin TTM = OperatingIncome_TTM / Revenue_TTM * 100
```

A negative operating margin is valid.

### 6. Net Margin TTM

Income Statement only.

```text
Revenue_TTM   = sum(revenue)
NetIncome_TTM = sum(netIncome)

require Revenue_TTM > 0

Net Margin TTM = NetIncome_TTM / Revenue_TTM * 100
```

A negative net margin is valid.

### 7. FCF Margin TTM

Use one aligned four-quarter fiscal window across Income Statement and Cash Flow Statement, ending
at the newest quarter either family holds (see "Window anchors"). Revenue and both FCF components
must exist for every quarter in that same window. When the families are not aligned on the newest
quarter the metric is unavailable; an older window both families share is never used.

```text
Revenue_TTM = sum(revenue)
FCF_TTM     = sum(operatingCashFlow + capitalExpenditure)

require Revenue_TTM > 0

FCF Margin TTM = FCF_TTM / Revenue_TTM * 100
```

A negative FCF margin is valid.

### 8. ROIC TTM

V1 uses a fixed tax assumption for a deterministic PIT operating-return measure:

```text
FUNDAMENTAL_ROIC_TAX_RATE = 0.21
```

This is intentionally the same numeric assumption as the V1 valuation tax rate, but Fundamental
Metrics owns its methodology explicitly; it must not depend on a runtime current tax-rate input.

Use one four-quarter Income Statement window for `operatingIncome`, plus opening and ending Balance
Sheet states aligned to that exact flow window.

For each state:

```text
cash = cashAndShortTermInvestments
       fallback cashAndCashEquivalents

investedCapital = totalDebt + totalStockholdersEquity - cash
```

`totalDebt`, `totalStockholdersEquity` and one cash field are required. There is no fallback from
`totalStockholdersEquity` to `totalEquity` in V1 because minority-interest treatment would change
the meaning of the denominator.

```text
OperatingIncome_TTM = sum(operatingIncome)
NOPAT_TTM            = OperatingIncome_TTM * (1 - 0.21)
AverageInvestedCapital = (openingInvestedCapital + endingInvestedCapital) / 2

require AverageInvestedCapital > 0

ROIC TTM = NOPAT_TTM / AverageInvestedCapital * 100
```

Negative ROIC is valid. No tax-rate clamping, current tax-rate lookup or company-specific tax
fallback is introduced in V1.

### 9. ROE TTM

Use one four-quarter Income Statement window and aligned opening/ending Balance Sheet states.

```text
NetIncome_TTM = sum(netIncome)
AverageEquity =
  (opening totalStockholdersEquity + ending totalStockholdersEquity) / 2

require AverageEquity > 0

ROE TTM = NetIncome_TTM / AverageEquity * 100
```

Negative ROE is valid only when the denominator is positive. Zero or non-positive average equity
makes the ratio unavailable rather than sign-inverted.

### 10. ROA TTM

Use one four-quarter Income Statement window and aligned opening/ending Balance Sheet states.

```text
NetIncome_TTM = sum(netIncome)
AverageAssets = (opening totalAssets + ending totalAssets) / 2

require AverageAssets > 0

ROA TTM = NetIncome_TTM / AverageAssets * 100
```

Negative ROA is valid.

### 11. Debt / Equity

This is a latest-state metric. Use the latest PIT-eligible quarterly Balance Sheet as of `D`.

```text
require totalStockholdersEquity > 0

Debt / Equity = totalDebt / totalStockholdersEquity
```

`totalDebt` and `totalStockholdersEquity` are required. Negative/zero equity makes the metric
unavailable rather than producing a misleading signed leverage ratio.

### 12. Current Ratio

Latest PIT-eligible quarterly Balance Sheet as of `D`.

```text
require totalCurrentLiabilities > 0

Current Ratio = totalCurrentAssets / totalCurrentLiabilities
```

Both fields are required.

### 13. Net Debt / EBITDA TTM

Use the latest exact four-quarter Income Statement window for EBITDA and the latest independently
PIT-eligible quarterly Balance Sheet for `netDebt`. This is deliberately a current leverage
snapshot: the state may be newer than the final quarter of the flow window, matching the existing
latest-state principle in the valuation engine.

```text
EBITDA_TTM = sum(ebitda over four consecutive eligible quarters)

require EBITDA_TTM > 0
require netDebt is present

Net Debt / EBITDA TTM = netDebt / EBITDA_TTM
```

Negative `netDebt` is valid and yields a negative multiple for net-cash companies. No fallback
reconstructs `netDebt` from other balance-sheet fields in V1.

### 14. Interest Coverage TTM

Income Statement only, one exact four-quarter window.

```text
EBIT_TTM            = sum(ebit)
InterestExpense_TTM = sum(interestExpense)

require InterestExpense_TTM > 0

Interest Coverage TTM = EBIT_TTM / InterestExpense_TTM
```

Negative EBIT produces a valid negative coverage reading. An explicit zero interest expense makes
the ratio mathematically unbounded and therefore unavailable in V1; infinity is never persisted.
A missing interest-expense field is also unavailable, never zero.

### 15. Asset Turnover TTM

Use one four-quarter Income Statement revenue window and aligned opening/ending Balance Sheet
states.

```text
Revenue_TTM  = sum(revenue)
AverageAssets = (opening totalAssets + ending totalAssets) / 2

require Revenue_TTM > 0
require AverageAssets > 0

Asset Turnover TTM = Revenue_TTM / AverageAssets
```

## Unavailability and numeric safety

A metric is unavailable when any required source field, quarter identity or denominator rule above
fails. Unavailability is represented by absence/`NULL` in `DailyDerivedState`, then `NaN` in an
`EvaluationFrame`, exactly like existing calculated-series gaps. It is never represented by zero,
infinity, a sentinel extreme value, or a stale previous value after an invalidating event.

The calculation kernel must reject non-finite results. It must not silently clamp extreme but finite
financial ratios. Database precision/scale is the existing calculated-series precision; storage
quantization is a persistence concern and UI rounding is presentation only.

**Out of storage range is unavailable, not a failure.** A finite result whose magnitude the
calculated-series column cannot hold — `DECIMAL(20,8)`, so `|value| >= 10^12` — is unavailable for
that observation. It is never clamped, saturated, stored as a sentinel maximum, converted to zero
or allowed to fail the rebuild: the other fourteen metrics, the security's other derived series and
its source statements are unaffected. The range is stated once in code
(`CALCULATED_SERIES_DECIMAL`) and pinned against the live columns.

## Materialization events and carry-forward

Fundamental metrics are event-driven calculations materialized onto the canonical daily trading
axis.

An evaluation event occurs on:

- the first canonical trading date for the security; and
- the first trading date on or after the `availableFromDate` of any newly eligible or revised
  `FinancialStatement` that could change at least one fundamental metric.

At each event, all fifteen metrics are evaluated from the PIT statement set visible on that date.
The resulting snapshot — including absence — is carried forward to every later trading date until
the next event.

A later revision may change a historical input or make a previously valid ratio unavailable. From
that revision's eligible trading date onward, the newly evaluated state replaces the old one. The
old value is never carried through an invalidation.

The service's existing `derivedRebuildStart` mechanism remains the rebuild boundary: a newly stored
statement revision causes the unified derived state to rebuild from the earliest affected
`availableFromDate` forward. There is no second revision timeline for Fundamental Metrics.

## Strategy semantics

Fundamentals are **Condition metrics only** in V1. They are not Trigger metrics.

Examples:

```text
ROIC TTM is above 15%
Revenue Growth TTM YoY is above 10%
Debt / Equity is below 1.0
Current Ratio is above 1.5
```

The implementation reuses existing Condition operators and does not introduce `BETWEEN`, `EQUALS`
or a fundamentals-specific operator family. Metric compatibility decides whether the right-hand
value is `PERCENT` or `NUMBER`/multiple; the Builder and backend validator must share that single
registry.

If a fundamental metric is unavailable on date `D`, a Condition using it is `NOT_EVALUABLE` under
the existing evaluator semantics. It is never treated as a failed numeric reading of zero.

Fundamental metric identity, including the selected metric, must be part of the Strategy
fingerprint. Different fundamental metrics must never collide in durable Monitor state or Strategy
deduplication.

## Chart semantics

Stock Details must display the same persisted daily values that Strategy/Backtest consumes. The web
app must not calculate ratios from raw statements independently.

Fundamentals are piecewise-constant between statement events, so a fundamentals pane should render
them as a step series. A line interpolated diagonally between quarterly changes would imply values
that never existed and is forbidden.

A tooltip should make PIT timing understandable, for example:

```text
ROIC TTM
18.42%
TTM through: Jun 30, 2026
Available from: Aug 1, 2026
```

The exact UI layout is a later implementation concern; the data source and step semantics are not.

## End-of-day product model

V1 Fundamental Metrics do not depend on realtime or intraday pricing. Their canonical observation
axis is the completed `DailyPrice` trading-session history already used by backtests.

The product may operate with end-of-day/delayed provider pricing without changing any methodology
in this document. A future valuation-ratio decision must likewise define its price input as the
canonical completed daily close unless a separate versioned methodology explicitly introduces an
intraday observation model.

## Explicit non-goals

This decision does not:

- create a `FundamentalSnapshot` table;
- create a dedicated fundamentals Redis namespace for calculated metrics;
- calculate fundamentals inside the backtest day loop;
- expose provider key-metrics/ratios endpoints as authoritative product values;
- add realtime/intraday fundamentals or valuation;
- add user-defined formulas;
- add valuation ratios (`P/E`, `P/S`, `P/FCF`, `EV/EBITDA`);
- add Strategy triggers or new Condition operators for fundamentals;
- claim exact historical pre-ingestion vintages that FMP no longer exposes; the existing
  `fundamentals-loader.md` limitation on historical restatements remains in force.

## Implementation sequence

This methodology is intended to be implemented in separate PRs:

1. pure calculation/materialization domain logic and formula tests;
2. `DailyDerivedState` persistence, rebuild and Redis parity;
3. Strategy/Backtest operands and Builder compatibility;
4. Stock Details/chart projection;
5. valuation ratios under a separate methodology lock;
6. independent correctness audit.
