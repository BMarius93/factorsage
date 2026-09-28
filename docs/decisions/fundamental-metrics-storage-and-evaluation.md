# Fundamental Metrics Storage and Evaluation

## Status

**Proposed architecture lock.** This document defines how `fundamental-metrics-v1.md` fits the
architecture that exists today. It is intentionally conservative: Fundamental Metrics extend the
canonical stock-data/derived-state path rather than creating a parallel subsystem.

## Decision summary

The end-to-end production path is:

```text
FMP standardized statements
        |
        v
FinancialStatement revisions                DailyPrice
(PostgreSQL authoritative)                      |
        |                                       |
        +-------------------+-------------------+
                            v
                 PIT fundamental materializer
                            |
                            v
                    DailyDerivedState
                  one row / security / date
                            |
                +-----------+-----------+
                |                       |
                v                       v
           PostgreSQL             Redis yearly chunks
          source of truth          disposable cache
                |                       |
                +-----------+-----------+
                            v
                projectEvaluationFrame
                  requested operands only
                            |
                    Float64Array columns
                            |
              Strategy / Backtest / Monitor

Stock Details reads the same persisted derived values through the stock-data/API projection path.
```

There is no `FundamentalSnapshot` persistence model and no calculated-fundamentals Redis namespace.

## Raw source remains `FinancialStatement`

The existing fundamentals loader is already the canonical source layer. It owns:

- standardized Income Statement, Balance Sheet and Cash Flow Statement history;
- quarterly and annual cadence;
- immutable provider revisions;
- `filingDate`, `availableFromDate`, `observedAt` and `contentHash`;
- point-in-time selection;
- PostgreSQL authority and disposable Redis financial-statement cache;
- 30-year visible history plus the existing fundamentals warm-up retention.

Fundamental Metrics must consume that model. They must not:

- call FMP directly;
- use FMP's key-metrics or ratios endpoints as product truth;
- persist another copy of raw statement line items;
- derive a second availability timestamp;
- overwrite or collapse statement revisions.

The existing raw financial Redis keys remain useful for statement reads and rebuilds. They are not
the Strategy/backtest hot-path representation of calculated metrics.

## `DailyDerivedState` is the calculated-series persistence model

The accepted wide-column decision applies unchanged. Add exactly fifteen nullable scalar columns to
`DailyDerivedState`:

```text
revenueGrowthTtmYoy
 epsGrowthTtmYoy
fcfGrowthTtmYoy

grossMarginTtm
operatingMarginTtm
netMarginTtm
fcfMarginTtm

roicTtm
roeTtm
roaTtm

debtToEquity
currentRatio
netDebtToEbitdaTtm
interestCoverageTtm
assetTurnoverTtm
```

(The leading space above `epsGrowthTtmYoy` is formatting only; the field name is exactly
`epsGrowthTtmYoy`.)

Each is nullable and uses the existing calculated-series decimal precision/scale. `NULL` means the
metric is unavailable on that trading day. It never means zero.

The `(securityId, date)` identity remains unchanged. No calculation revision enters the primary key
and no historical parallel copy of old formula versions is retained.

### One additive migration

The materialization/persistence implementation PR should add the fifteen nullable columns in one
additive migration. Existing rows remain `NULL`; SQL must not invent a historical backfill.

The canonical stock-data rebuild is the only backfill path.

### Derived methodology revision

Adding these columns changes the unified derived-state methodology and therefore requires one bump
of the existing global `DERIVED_STATE_REVISION` in the persistence/materialization PR.

The bump intentionally invalidates old derived coverage/manifests so a security rebuild produces a
single coherent current-methodology history. Do not add a fundamentals-specific revision column or
a per-row formula version for V1.

## Fundamental metric identity

There must be one stable machine identity per product metric, independent of its UI label and
storage field. Suggested identities are:

```text
REVENUE_GROWTH_TTM_YOY
EPS_GROWTH_TTM_YOY
FCF_GROWTH_TTM_YOY
GROSS_MARGIN_TTM
OPERATING_MARGIN_TTM
NET_MARGIN_TTM
FCF_MARGIN_TTM
ROIC_TTM
ROE_TTM
ROA_TTM
DEBT_TO_EQUITY
CURRENT_RATIO
NET_DEBT_TO_EBITDA_TTM
INTEREST_COVERAGE_TTM
ASSET_TURNOVER_TTM
```

The implementation must follow the repository's package boundaries, but the architectural rules are
fixed:

- exactly one product-facing catalog owns identity, label, group and unit;
- storage field lookup is explicit and typed, never inferred by changing case or parsing a label;
- Builder options, backend validation, Strategy descriptions and chart options do not keep separate
  copies of the metric list;
- completeness/drift tests pin the catalog, storage fields and projector mapping together;
- a newly added product metric that is not persisted/projectable must fail a structural test rather
  than quietly read as unavailable.

## Pure calculation layer

Fundamental formulas are pure and infrastructure-free. They consume canonical PIT-eligible
`FinancialStatement` objects (or a normalized calculation view derived from them) and return a
snapshot shaped conceptually as:

```ts
type FundamentalMetricSnapshot = {
  revenueGrowthTtmYoy?: number;
  epsGrowthTtmYoy?: number;
  fcfGrowthTtmYoy?: number;
  grossMarginTtm?: number;
  operatingMarginTtm?: number;
  netMarginTtm?: number;
  fcfMarginTtm?: number;
  roicTtm?: number;
  roeTtm?: number;
  roaTtm?: number;
  debtToEquity?: number;
  currentRatio?: number;
  netDebtToEbitdaTtm?: number;
  interestCoverageTtm?: number;
  assetTurnoverTtm?: number;
};
```

Absence means unavailable. Formula code does not use `NaN` as its domain result and does not know
about Prisma, Redis, Strategy documents, HTTP responses or React.

Quarter-window assembly should be shared across metrics. The implementation must not have fifteen
slightly different definitions of "latest four consecutive quarters".

## Daily materializer

Add one canonical materialization path, conceptually:

```ts
materializeDailyFundamentals({
  securityId,
  tradingDates,
  statements,
})
```

It receives:

- the canonical trading-date axis derived from persisted `DailyPrice` rows;
- every retained `FinancialStatement` revision needed for PIT reconstruction.

It plans statement evaluation events, evaluates the full fifteen-metric snapshot at each event and
carries that snapshot forward until the next event. Carry-forward includes absence: an invalidating
revision produces an absent field from that event onward.

The output may be an internal sparse-event representation or one state per trading date, whichever
fits the existing `buildDailyDerivedState` implementation best. The persisted result is always the
single daily row.

### Event planning

The materializer evaluates on:

1. the first trading date in the canonical calculation axis; and
2. the first trading date on or after each relevant statement revision's `availableFromDate`.

Multiple statement revisions becoming eligible on the same trading date collapse into one
evaluation event after the complete PIT statement set for that date is assembled.

There is no evaluation on a fiscal period end merely because the period ended. Information changes
only when a revision becomes eligible.

### One statement-revision read per rebuild

`StockDataService.rebuildDailyDerivedState` already reads retained immutable financial-statement
revisions for intrinsic-value materialization. Fundamental Metrics should reuse the same bounded
statement revision set in that rebuild, not issue an independent database read per metric or per
trading day.

A target shape is conceptually:

```ts
const statements = await store.getFinancialStatementRevisions(...);

const fundamentalStates = materializeDailyFundamentals({
  securityId,
  tradingDates,
  statements,
});

const intrinsicStates = materializeDailyIntrinsicValues({
  securityId,
  tradingDates,
  statements,
});

const rows = buildDailyDerivedState({
  prices,
  weeklyBars,
  fundamentalStates,
  intrinsicStates,
});
```

The exact signatures may differ, but the single-source/single-read property is required.

## Rebuild boundaries and revisions

The existing stock-data service already derives `derivedRebuildStart` from changed financial
statement revisions. Keep that mechanism.

If a newly observed revision has `availableFromDate = D`, derived state from the first affected
trading date on/after `D` through the current target is rebuilt. A refresh may therefore update:

- Fundamental Metrics;
- intrinsic values;
- any future statement-derived series;

in one unified rebuild and one cache publication boundary.

No metric-specific partial history is published while another metric family is still on the old
statement revision.

## PostgreSQL authority and Redis behavior

PostgreSQL remains authoritative for `DailyDerivedState`.

Redis continues to cache the same row-oriented derived state in the existing yearly
`daily-state:<year>` chunks under the current generation/manifest/LRU mechanism. The fifteen fields
are serialized into those chunks exactly like SMA, RSI, RVOL and intrinsic values.

Do not introduce keys such as:

```text
fundamentals:<securityId>
fundamental-series:<metric>:<securityId>
```

A Redis flush must continue to cost latency only: all calculated fundamentals are reconstructed from
PostgreSQL or rebuilt from canonical source data through the existing hydration path.

The existing complete-stock eviction semantics must evict Fundamental Metrics together with the
rest of the derived state; no orphan cache family is allowed.

## Backtest and Strategy evaluation

The backtest does **not** read raw financial statements and does **not** calculate TTM ratios.

Fundamental Metrics enter the evaluator as another operand family. Conceptually:

```text
fundamental:ROIC_TTM
fundamental:REVENUE_GROWTH_TTM_YOY
fundamental:DEBT_TO_EQUITY
```

Encoding is owned by the Strategy operand module and must have an explicit builder/inverse helper;
callers do not slice or parse opaque keys themselves.

`collectOperands(strategyDefinition)` includes only the fundamental metrics the strategy actually
references, plus the operands it already collects.

`projectEvaluationFrame(...)` resolves each requested fundamental identity to its explicit
`DailyDerivedState` field and writes one `Float64Array` column. Missing persisted values become the
existing frame-level absence representation (`NaN`).

The day loop therefore performs only array reads and predicate evaluation:

```text
NO FMP request
NO PostgreSQL statement query
NO Redis lookup per day
NO TTM assembly
NO ratio calculation
```

This is the same performance model already used for materialized technical series and RVOL.

## Strategy contract compatibility

V1 adds one Strategy metric family, conceptually:

```ts
{ kind: "FUNDAMENTAL"; metricId: FundamentalMetricId }
```

Exact naming should follow the current contract style, but all fifteen metrics share one family;
there should not be fifteen new top-level `StrategyMetric.kind` values.

Fundamentals are valid in `StrategyCondition` only. The compatibility registry must reject them in
`StrategyTrigger` and must select the right value unit:

- growth, margins, ROIC, ROE, ROA -> `PERCENT`;
- leverage/liquidity/coverage/turnover multiples -> numeric multiple value using the existing
  generic numeric representation chosen by the contract implementation.

No new operator is introduced. Existing condition operators remain authoritative.

The complete fundamental metric configuration participates in:

- Strategy validation;
- canonical description;
- version/fingerprint/deduplication;
- Monitor durable level-state identity if/when Monitor evaluates the strategy.

## Monitor parity

Realtime pricing is not a prerequisite for Fundamental Metrics. The feature is defined on canonical
completed daily sessions.

If Monitor remains enabled for end-of-day observations, it must project fundamental operands through
the same canonical `projectEvaluationFrame` path as a backtest. It must not calculate a "current"
fundamental snapshot separately from the daily materialized history.

If a provisional intraday observation path remains in the codebase, V1 makes no fundamental value
change on that provisional row: the latest eligible completed-session fundamental state may be
carried only if that is already the canonical Monitor frame policy. No new intraday statement
semantics are introduced here.

## Stock Details and chart projection

Stock Details must read Fundamental Metrics from the canonical derived-state projection, not from a
frontend formula over raw statements.

The API may expose a dedicated fundamental-series projection or extend an existing calculated-series
response, but it must preserve these invariants:

- values are exactly the persisted daily values;
- absence remains absence;
- date axis is canonical trading dates;
- step/carry-forward semantics are not replaced by interpolation;
- requesting a subset should not require recalculating the metric.

A UI optimization may collapse repeated daily values to change points for rendering, but that is a
wire/presentation optimization only. The canonical stored/evaluated series remains daily.

## Valuation remains a separate slice

`P/E`, `P/S`, `P/FCF` and `EV/EBITDA` are expected to be daily calculated series because their
market-price input changes daily. The existing wide-column model is likely to fit them, but this
architecture document does not pre-approve formulas, denominator rules, share-count selection,
enterprise-value construction or invalid-value behavior.

They require a separate decision and should not be smuggled into the Fundamental Metrics migration
or Strategy contract.

## Implementation PR boundaries

### PR 1 — calculation/materialization logic

- stable metric identities/catalog foundations;
- pure quarter-window helpers;
- all fifteen formula kernels;
- daily event planning/carry-forward;
- no Prisma migration, Builder UI or Strategy evaluator wiring unless required to compile shared
  types;
- formula and PIT unit tests.

### PR 2 — persistence/cache/rebuild

- fifteen `DailyDerivedState` columns;
- additive Prisma migration;
- domain/store row mappings;
- `DERIVED_STATE_REVISION` bump;
- stock-data rebuild integration;
- PostgreSQL round-trip and Redis parity;
- cold-cache reconstruction.

### PR 3 — Strategy/Backtest

- Strategy contract metric family and compatibility;
- operand identity and collection;
- evaluation-frame projection;
- Builder controls/descriptions;
- fingerprint/deduplication coverage;
- Backtest and Monitor parity tests.

### PR 4 — Stock Details/chart

- API projection;
- product grouping/labels;
- fundamentals pane/picker;
- step rendering;
- PIT-aware tooltip/source-period metadata where exposed.

### PR 5 — Valuation

Separate methodology decision and implementation.

### PR 6 — independent audit

Independent oracles, full-history PIT checks, persistence/cache parity, deterministic backtests and
chart/evaluator equality.

## Forbidden shortcuts

An implementation is non-conforming if it:

- stores the fifteen metrics in a new table instead of `DailyDerivedState`;
- caches calculated metrics under a parallel Redis family;
- calls FMP from Strategy or Backtest execution;
- computes fundamentals in React or in the backtest daily loop;
- selects statements by fiscal date without applying `availableFromDate`;
- silently treats missing fields as zero;
- lets a revised statement affect dates before its PIT eligibility;
- maintains a second list of fundamental labels/options in the web app;
- adds valuation ratios as part of the same migration without a valuation methodology lock.
