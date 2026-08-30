# V1 Intrinsic Value Engine

## Status

Methodology lock for the V1 intrinsic-value engine. This document fixes the formulas, constants,
input rules and availability rules **before** any valuation code exists. It implements nothing.

It builds on already-locked decisions and does not reinterpret them:

- `stock-data-foundation.md` — model identities, daily materialization, per-model PIT provenance,
  derived blend provenance, blend weights.
- `fundamentals-loader.md` — verified FMP sign conventions and standalone quarterly cadence.
- `stock-data-loader-implementation.md` — point-in-time read semantics.

## Models

Exactly four models. No additional model may be introduced under this decision.

- `DCF_FCFF`
- `RESIDUAL_INCOME`
- `DDM`
- `GRAHAM`

## Shared point-in-time input rules

Every calculation is point-in-time. For a valuation effective on trading day `D`:

1. Only `FinancialStatement` revisions with `availableFromDate <= D` may be used.
2. For each required fiscal identity (`statementType`, `fiscalYear`, `period`), use the latest
   eligible revision. This is exactly what `selectFinancialStatements` already does.
3. Quarterly inputs use standalone `Q1`/`Q2`/`Q3`/`Q4` rows.
4. TTM means exactly four consecutive PIT-eligible standalone quarters. "Consecutive" means four
   distinct adjacent fiscal quarters with no gap in the series.
5. Never mix `FY` rows into a TTM series.
6. If the four required quarters are not all available, the model is `NOT_APPLICABLE`. There is no
   fallback to an annual statement for TTM.
7. Latest state inputs use the latest PIT-eligible **quarterly** statement of the required family.
8. Historical share counts come from PIT financial-statement data only. Current profile shares are
   never used for a historical valuation. (The V2 `SecurityProfile` carries no share count at all,
   so there is nothing to fall back to.)

## Flow-window alignment versus latest-state selection

TTM flow-window alignment and latest-state selection are **separate concepts**. Implementation must
not infer this distinction, so it is normative here.

**Flow inputs** (period quantities: cash-flow and income-statement flows) use one common
four-consecutive-quarter fiscal window for every statement family the model requires. When a model
needs quarterly fields from more than one family, all of its TTM flow inputs must come from the
_same_ four fiscal-quarter identities (`fiscalYear`, `period`). Never take "the latest four
`CASH_FLOW` quarters" and "the latest four `INCOME` quarters" independently when those windows
differ. Every quarter identity in the window must exist and be PIT-eligible for every family the
model requires; otherwise the model is `NOT_APPLICABLE`. No annual row may ever fill a TTM gap.

**State inputs** (balance-sheet state and the final per-share denominator) are not flow-window
inputs. They use the latest independently eligible quarterly statement as of valuation day `D`,
**even when that fiscal quarter is newer than the final quarter of the model's TTM flow window**.
This is intentional: the TTM window represents trailing operating performance, while these fields
represent the latest known financial and share state.

The statements actually used — flow-window and latest-state alike — all contribute to that model's
provenance.

The one exception is `DDM`, whose per-quarter diluted share count is a flow-window input paired to
that same quarter's dividend payment, not a latest-state input. See the `DDM` section.

## Model evaluation events, invalidation and carry-forward

A model is evaluated when a relevant PIT input first becomes eligible or a newer eligible revision
replaces one of its inputs.

If a later eligible revision or input makes a previously valid model invalid, the model becomes
**unavailable from that trading day onward**. An obsolete intrinsic value is never carried forward
past its invalidation. This refines — and does not contradict — the carry-forward rule in
`stock-data-foundation.md`: invalidation is itself a model evaluation event, and the value it
produces is "absent". The daily materializer carries the latest valid model state forward only
until the next evaluation event.

`NOT_APPLICABLE` is represented exactly as the existing schema already represents unavailability:
the model's value column and its per-model provenance column are both `NULL` on that trading day.
Nothing distinguishes "not yet eligible" from "not applicable" in storage, which is the existing
invariant (an absent value is never zero and is never back-filled).

## Provenance

A model's `sourceDataAsOf` is the maximum `availableFromDate`/availability instant across **all**
source statements actually used by that model: its flow-window quarters, its latest-state
statements, and the two annual rows used as growth endpoints. Statements that were never read —
intermediate annual rows in particular — do not contribute.

Fixed methodology assumptions (the constants below) are not data provenance and never contribute
to `sourceDataAsOf`.

Because `DDM` does not consume `growthUsed`, its provenance does **not** include the annual growth
statements; `DCF_FCFF`, `RESIDUAL_INCOME` and `GRAHAM` do include them. This is precisely why
provenance is per model rather than per row.

Blend provenance stays as already locked: the maximum provenance of the blend's required
components, derived at read time and never persisted.

## Fixed V1 assumptions

```text
FORECAST_YEARS       = 10
TAX_RATE             = 0.21
DCF_WACC             = 0.10
COST_OF_EQUITY       = 0.10
TERMINAL_GROWTH      = 0.025
DEFAULT_GROWTH       = 0.05
MAX_FORECAST_GROWTH  = 0.15
```

No dynamic historical CAPM/WACC in V1. Current beta, current risk-free rate, current ERP, and any
other non-PIT current-market input are forbidden in historical valuations. V2 owns no such series
anyway, which is why the discount rates are fixed constants rather than estimated.

## Growth methodology

Growth is estimated from **annual** statements.

Primary — 5-year revenue CAGR:

- take the latest PIT-eligible `FY` revenue (fiscal year `N`);
- compare it with the `FY` revenue of fiscal year `N - 5`;
- **only these two endpoint rows are required.** The four intermediate `FY` rows (`N-1` … `N-4`)
  need not exist or be eligible and are never used;
- both endpoints must be the **exact** fiscal-year identities `N` and `N - 5`. Never substitute
  `N-4`, `N-6` or another nearby year, and never rescale a shorter or longer span into a 5-year
  rate;
- both endpoint values must be `> 0`.

```text
growth = (latestRevenue / revenueFiveYearsEarlier)^(1/5) - 1
```

Fallback — 5-year net-income CAGR under the identical rule (same exact `N` / `N - 5` endpoint
identities), used only when both endpoint values are `> 0`.

If the required endpoint pair cannot be formed for revenue, continue to the net-income fallback; if
neither CAGR can be calculated:

```text
growth = DEFAULT_GROWTH = 0.05
```

Cap the upside only:

```text
growthUsed = min(rawGrowth, MAX_FORECAST_GROWTH)   // 0.15
```

No arbitrary negative floor is imposed. A CAGR computed from two positive endpoints is naturally
greater than `-100%`.

Only the annual statements actually used as endpoints contribute to model provenance. Intermediate
annual rows that were never read do not.

## DCF_FCFF

Flow inputs come from **one common four-consecutive-quarter fiscal window**. For each quarter in
that window, all three fields below must exist and be PIT-eligible; the `CASH_FLOW` and `INCOME`
windows are never selected independently:

```text
per quarter q in the common window:
  CASH_FLOW  operatingCashFlow
  CASH_FLOW  capitalExpenditure
  INCOME     interestExpense

operatingCashFlow_TTM   = sum(4 quarterly operatingCashFlow)      // CASH_FLOW
capitalExpenditure_TTM  = sum(4 quarterly capitalExpenditure)     // CASH_FLOW, already negative
interestExpense_TTM     = sum(4 quarterly interestExpense)        // INCOME, positive magnitude
```

If any of the four quarter identities is missing or not PIT-eligible for any required family,
`DCF_FCFF` is `NOT_APPLICABLE`. No annual row fills the gap.

`interestExpense` is required per quarter and the missing/zero distinction is strict:

- an explicit reported `0` is a valid zero and is used as such;
- a **missing** `interestExpense` field makes `DCF_FCFF` `NOT_APPLICABLE`.

Missing is never treated as zero, and V1 introduces no fallback to `interestPaid`, `netInterestIncome`,
a debt-derived estimate, or any other field. The mapper preserves reported zeros and omits only
genuinely absent fields, so the distinction is observable in the data.

Construction:

```text
FCFF_0 = operatingCashFlow_TTM
       + capitalExpenditure_TTM
       + interestExpense_TTM * (1 - TAX_RATE)
```

- `capitalExpenditure_TTM` is **added**, never subtracted: FMP already reports it signed negative.
- `changeInWorkingCapital` is **not** used. Its effect is already inside `operatingCashFlow`, and
  the FMP field is the signed cash-flow contribution rather than a conventional positive ΔNWC.
- Provider `freeCashFlow` is a reconciliation/cross-check only, approximately
  `freeCashFlow_TTM ≈ operatingCashFlow_TTM + capitalExpenditure_TTM`. It is never the primary
  DCF input.

If `FCFF_0 <= 0`, `DCF_FCFF` is `NOT_APPLICABLE` in V1.

Forecast and discounting:

```text
FCFF_t = FCFF_0 * (1 + growthUsed)^t          for t = 1..FORECAST_YEARS
PV_t   = FCFF_t / (1 + DCF_WACC)^t

TV     = FCFF_10 * (1 + TERMINAL_GROWTH) / (DCF_WACC - TERMINAL_GROWTH)
PV_TV  = TV / (1 + DCF_WACC)^10

EV     = sum(PV_t) + PV_TV
```

Equity bridge — these are **latest-state** inputs, taken from the latest PIT-eligible quarterly
balance sheet as of `D` even when its fiscal quarter is newer than the flow window's final quarter:

```text
cash  = latest eligible cashAndShortTermInvestments
        fallback latest eligible cashAndCashEquivalents
debt  = latest eligible totalDebt

equityValue = EV + cash - debt
```

`netDebt` is **not** a fallback in V1 unless a later decision specifies it.

Shares — also a latest-state input, independent of the flow window:

```text
shares = latest eligible quarterly weightedAverageShsOutDil    // INCOME, require shares > 0
valuePerShare = equityValue / shares
```

`NOT_APPLICABLE` when any required input (OCF, CapEx, interest expense, cash, debt, diluted
shares) is missing, when the common four-quarter flow window cannot be formed, when
`FCFF_0 <= 0`, or when the final `equityValue <= 0`.

## RESIDUAL_INCOME

```text
netIncome_TTM = sum(4 quarterly netIncome)                         // INCOME, flow window
bookValue     = latest eligible quarterly totalStockholdersEquity  // BALANCE_SHEET, latest state
shares        = latest eligible quarterly weightedAverageShsOutDil // INCOME, latest state
```

The flow window is four consecutive PIT-eligible `INCOME` quarters — only one statement family is
involved, so no cross-family alignment is needed. `bookValue` and `shares` are latest-state inputs
and may come from a fiscal quarter newer than the flow window's final quarter.

Require `bookValue > 0` and `shares > 0`.

```text
RI_0   = netIncome_TTM - bookValue * COST_OF_EQUITY
RI_t   = RI_0 * (1 + growthUsed)^t              for t = 1..FORECAST_YEARS
PV_t   = RI_t / (1 + COST_OF_EQUITY)^t

TV_RI  = RI_10 * (1 + TERMINAL_GROWTH) / (COST_OF_EQUITY - TERMINAL_GROWTH)
PV_TV  = TV_RI / (1 + COST_OF_EQUITY)^10

equityValue   = bookValue + sum(PV_t) + PV_TV
valuePerShare = equityValue / shares
```

The charge uses the **latest (ending) book value**, not an opening book value. This is deliberate
and is what the golden vector below encodes.

A negative `RI_0` does not by itself invalidate the model. `NOT_APPLICABLE` only when a required
input is missing, when `bookValue <= 0` or `shares <= 0`, or when the final `equityValue <= 0`.

## DDM

Common dividends only.

Both inputs are flow-window inputs on **one common four-consecutive-quarter fiscal window**. For
each quarter in that window, pair the `CASH_FLOW` row with the `INCOME` row of the same fiscal
identity (`fiscalYear`, `period`); every quarter must be PIT-eligible for both families:

```text
quarterDps = abs(commonDividendsPaid) / weightedAverageShsOutDil   // require shares > 0
DPS_TTM    = sum(4 quarterDps)
```

`abs` is applied because `commonDividendsPaid` is a signed cash outflow, normally negative.

Summing four per-quarter DPS values deliberately handles a changing share count better than
dividing total TTM dividends by the latest quarter's share count alone. This is why `DDM` is the
one model whose diluted share count is **not** a latest-state input: each quarter's shares stay
paired to that same quarter's dividend payment.

If `DPS_TTM <= 0`, `DDM` is `NOT_APPLICABLE`.

One-stage Gordon model:

```text
D1            = DPS_TTM * (1 + TERMINAL_GROWTH)
valuePerShare = D1 / (COST_OF_EQUITY - TERMINAL_GROWTH)
```

No company-specific dividend CAGR in V1. `DDM` does not use `growthUsed`.

## GRAHAM

The legacy Graham growth formula is used because there is no PIT historical AAA corporate
bond-yield series in V2, so the revised bond-yield-adjusted form cannot be computed
point-in-time-correctly.

The flow window is four consecutive PIT-eligible `INCOME` quarters; only one statement family is
involved.

```text
EPS_TTM = sum(4 quarterly epsDiluted)      // INCOME, flow window; require EPS_TTM > 0

gPercent      = growthUsed * 100
valuePerShare = EPS_TTM * (8.5 + 2 * gPercent)
```

If the multiplier `8.5 + 2 * gPercent` is `<= 0`, `GRAHAM` is `NOT_APPLICABLE`.

Market price is never an input to the Graham intrinsic value.

## Currency

`DailyDerivedState` keeps its single shared `intrinsicCurrency` column. Per-model currency columns
are **not** added, and V1 introduces no FX conversion anywhere.

Two rules apply, at different levels:

1. **Per model.** Every statement supplying a numeric input to one model must share the same
   `reportedCurrency`. If a model's required inputs carry incompatible currencies, that model is
   `NOT_APPLICABLE`.
2. **Per row.** All non-null intrinsic model results materialized on the same `DailyDerivedState`
   row must resolve to the same currency, which becomes that row's `intrinsicCurrency`.

If independently calculated non-null model results for the same trading day resolve to
incompatible currencies, that is a **data-consistency failure**, not a valuation outcome. The
deterministic handling that fits the current single-column materializer is:

- materialize **no** intrinsic values for that security on that trading day: every model column,
  every blend column and `intrinsicCurrency` stay `NULL`, exactly as any other unavailable value;
- the technical/weekly columns on that row are unaffected;
- surface the condition as a logged data-consistency event through `@intrinsic/observability`
  rather than skipping it silently.

No model is ever labelled with another model's currency, no currency is picked by priority or
majority (any such tie-break would be arbitrary and would silently drop valid results), and no
value is converted. The incompatible result set simply remains unavailable.

## Blends

The existing product definitions are unchanged:

- `BALANCED` — 50% `DCF_FCFF`, 30% `RESIDUAL_INCOME`, 20% `GRAHAM`
- `CONSERVATIVE` — 40% `DCF_FCFF`, 30% `RESIDUAL_INCOME`, 30% `GRAHAM`
- `DIVIDEND` — 40% `DCF_FCFF`, 40% `DDM`, 20% `RESIDUAL_INCOME`

Every required component must be present. Weights are never renormalized and a missing model is
never substituted. Blend provenance remains the maximum provenance of its required components.

## Golden vectors

Pure-formula examples to lock later unit tests. Every value below was recomputed from the formulas
in this document and reproduces exactly.

### DCF_FCFF

```text
inputs:
  operatingCashFlow_TTM   = 120
  capitalExpenditure_TTM  = -20
  interestExpense_TTM     = 10
  TAX_RATE                = 0.21
  growthUsed              = 0.05
  DCF_WACC                = 0.10
  TERMINAL_GROWTH         = 0.025
  FORECAST_YEARS          = 10
  cash                    = 50
  debt                    = 30
  shares                  = 10

FCFF_0                    = 107.9
PV(forecast FCFF)         = 842.8935174394
PV(terminal value)        = 926.0835838887
enterprise value          = 1768.9771013280
equity value              = 1788.9771013280
value per share           = 178.8977101328
```

### RESIDUAL_INCOME

```text
inputs:
  netIncome_TTM   = 80
  bookValue       = 500
  shares          = 10
  COST_OF_EQUITY  = 0.10
  growthUsed      = 0.05
  TERMINAL_GROWTH = 0.025
  FORECAST_YEARS  = 10

RI_0                   = 30
PV(forecast RI)        = 234.3540826986
PV(terminal RI)        = 257.4838509422
equity value           = 991.8379336408
value per share        = 99.1837933641
```

### GRAHAM

```text
inputs:
  EPS_TTM    = 8
  growthUsed = 0.05

value per share = 148
```

### DDM

```text
inputs:
  DPS_TTM         = 2      // sum of four quarterly DPS contributions
  COST_OF_EQUITY  = 0.10
  TERMINAL_GROWTH = 0.025

value per share = 27.3333333333
```

### Blends over those model outputs

```text
BALANCED     = 148.8039930756
CONSERVATIVE = 145.7142220623
DIVIDEND     = 102.3291760593
```
