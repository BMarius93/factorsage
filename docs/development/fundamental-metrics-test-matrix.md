# Fundamental Metrics V1 — Correctness Matrix

## Purpose

This is the validation contract for `docs/decisions/fundamental-metrics-v1.md` and
`docs/decisions/fundamental-metrics-storage-and-evaluation.md`.

The goal is not merely broad test count. Every implementation PR must prove the specific financial,
point-in-time, persistence and evaluation invariants it changes. A green generic workspace suite is
necessary but not sufficient.

The final audit must use structurally independent recomputation where practical. A test that calls
the production formula to calculate its expected value proves wiring, not correctness.

## General rules

1. Use exact fiscal identities in fixtures. Do not let calendar-quarter assumptions hide fiscal-year
   bugs.
2. Every PIT test names both `fiscalDate`/period identity and `availableFromDate`.
3. Missing fields are represented as missing, never by a zero fixture unless zero itself is what the
   case tests.
4. Tests that assert unavailability must also include a nearby valid case so an always-null column
   cannot pass unnoticed.
5. Tests that assert a metric can be negative must include a negative value and prove Strategy
   comparison sees that value rather than absence.
6. Where persistence quantizes to `DECIMAL(20,8)`, compare against the stored quantum rather than an
   impossible pre-quantization float.
7. Any test involving revisions must prove both sides of the eligibility boundary.
8. Any backtest/Monitor parity test uses the same Strategy definition and observation dates; no
   duplicated evaluator logic is allowed in the test harness.
9. Provider requests during a fully provisioned backtest correctness run are a failure.
10. A Redis flush may change latency only. Results and persisted history must remain identical.

## Metric formula matrix

Every one of the fifteen metrics requires:

- at least one hand-computed golden vector;
- at least one independent-oracle vector over a larger fixture;
- missing-input behavior;
- denominator-edge behavior where relevant;
- a signed-value case where the methodology permits negative output;
- invariance to input ordering;
- no mutation of caller-owned statement arrays/objects.

### Revenue Growth TTM YoY

Required cases:

- eight consecutive positive-revenue quarters, exact expected YoY;
- one missing quarter in current TTM -> unavailable;
- one missing quarter in previous TTM -> unavailable;
- FY row present but missing quarterly row -> still unavailable;
- previous TTM revenue `0` -> unavailable;
- current TTM revenue `0` -> unavailable;
- non-calendar fiscal-year chain -> same answer for same values;
- later revision of one quarter changes the value only from revision availability onward.

### EPS Growth TTM YoY

Required cases:

- eight consecutive positive `epsDiluted` quarters, sum-quarterly-EPS golden value;
- changing diluted share counts do not cause a hidden current-share recomputation;
- previous EPS TTM `<= 0` -> unavailable;
- current EPS TTM `<= 0` -> unavailable;
- negative-to-positive turnaround -> unavailable, not a huge positive percentage;
- positive-to-negative transition -> unavailable;
- missing one quarterly EPS -> unavailable;
- annual EPS cannot fill a gap.

### FCF Growth TTM YoY

Required cases:

- `operatingCashFlow + capitalExpenditure` with negative CapEx sign, exact expected value;
- provider `freeCashFlow` deliberately inconsistent in fixture -> production result follows OCF +
  CapEx, not provider FCF;
- missing OCF -> unavailable;
- missing CapEx -> unavailable;
- previous/current FCF TTM `<= 0` -> unavailable;
- negative-to-positive transition -> unavailable;
- eight-quarter exact adjacency required.

### Gross Margin TTM

Required cases:

- positive margin golden vector;
- negative gross profit -> valid negative margin;
- revenue `<= 0` -> unavailable;
- missing gross profit -> unavailable;
- ratio-of-sums verified; must not equal the simple average of quarterly margins in an unequal
  revenue fixture.

### Operating Margin TTM

Same structural cases as Gross Margin, including a fixture proving ratio-of-sums rather than mean of
quarterly percentages.

### Net Margin TTM

Same structural cases, including valid negative net income with positive revenue.

### FCF Margin TTM

Required cases:

- common fiscal window across Income and Cash Flow;
- Income latest-four and Cash Flow latest-four deliberately differ -> unavailable until a common
  window exists;
- negative FCF -> valid negative margin;
- ratio-of-sums, not mean of quarterly FCF margins;
- missing OCF/CapEx/revenue in any required quarter -> unavailable.

### ROIC TTM

Required cases:

- fixed 21% tax assumption golden vector;
- test proves no current/company tax-rate field influences result;
- cash uses `cashAndShortTermInvestments` when present;
- cash falls back to `cashAndCashEquivalents` only when the primary cash field is absent;
- missing both cash fields -> unavailable;
- no fallback from `totalStockholdersEquity` to `totalEquity`;
- opening state is the quarter immediately before the TTM window;
- ending state is the final TTM quarter;
- a newer independently eligible balance sheet must **not** replace the aligned ending state;
- average invested capital `<= 0` -> unavailable;
- negative operating income with positive invested capital -> valid negative ROIC;
- one missing aligned balance-sheet quarter -> unavailable.

### ROE TTM

Required cases:

- average opening/ending stockholders' equity golden vector;
- test proves ending equity alone is not used;
- average equity `<= 0` -> unavailable;
- negative net income + positive average equity -> valid negative ROE;
- `totalEquity` does not substitute for missing `totalStockholdersEquity`.

### ROA TTM

Required cases:

- average opening/ending assets golden vector;
- ending assets alone produces a different fixture answer and must not be used;
- average assets `<= 0` -> unavailable;
- negative net income + positive assets -> valid negative ROA.

### Debt / Equity

Required cases:

- latest eligible quarterly Balance Sheet selected;
- total debt / total stockholders' equity exact ratio;
- equity `0` -> unavailable;
- negative equity -> unavailable;
- explicit debt `0` + positive equity -> valid `0` ratio;
- later balance-sheet revision changes value only at/after its eligibility date.

### Current Ratio

Required cases:

- exact current assets/current liabilities ratio;
- current liabilities `0` -> unavailable;
- missing liabilities/assets -> unavailable;
- explicit assets `0`, positive liabilities -> valid `0` ratio;
- latest eligible quarterly Balance Sheet selected.

### Net Debt / EBITDA TTM

Required cases:

- positive net debt and positive EBITDA golden vector;
- negative net debt -> valid negative multiple;
- EBITDA `<= 0` -> unavailable;
- missing `netDebt` -> unavailable; no reconstructed fallback;
- latest eligible Balance Sheet may be newer than the final quarter in the EBITDA TTM window;
- four consecutive Income quarters required.

### Interest Coverage TTM

Required cases:

- exact EBIT / interest-expense ratio;
- explicit interest expense `0` -> unavailable, never infinity;
- missing interest expense -> unavailable;
- negative EBIT + positive interest -> valid negative coverage;
- ratio-of-sums, not mean of quarterly coverage values.

### Asset Turnover TTM

Required cases:

- revenue / average opening-ending assets golden vector;
- latest independent assets must not replace aligned ending assets;
- average assets `<= 0` -> unavailable;
- revenue `<= 0` -> unavailable;
- ratio uses TTM revenue sum and two state points, not mean of quarterly turnover values.

## Shared fiscal-window tests

The common quarter-window helper requires one reusable behavioral suite covering:

- Q1 -> Q2 -> Q3 -> Q4 across one fiscal year;
- Q3 -> Q4 -> Q1 -> Q2 across a fiscal-year boundary;
- non-calendar fiscal year with the same fiscal identities;
- one missing quarter;
- duplicate revisions for one fiscal identity, older/newer eligibility;
- shuffled input order;
- FY rows mixed into input but ignored for quarterly windows;
- eight-quarter current/previous TTM chain;
- a ninth older quarter that must not alter the latest selected pair of windows;
- a future revision that exists in storage but is not yet eligible as of `D`.

## PIT boundary matrix

For a statement with:

```text
fiscal period end: 2026-06-30
filingDate:        2026-07-31
availableFromDate: 2026-08-01
```

prove:

- any trading date before 2026-08-01 cannot see the revision;
- if 2026-08-01 is a trading date, it is the first eligible observation;
- if `availableFromDate` is a weekend/holiday, no synthetic observation is created and the next
  actual trading date is first eligible;
- a chart projection, a Strategy evaluation and a backtest all change on the same trading date.

Also test two revisions of the same fiscal identity:

```text
revision A available 2026-08-01
revision B available 2026-10-15
```

The expected history is:

```text
before 2026-08-01       -> prior state / unavailable
2026-08-01..2026-10-14  -> A-derived metrics
2026-10-15 onward       -> B-derived metrics
```

No row before 2026-10-15 may contain a value that depends on revision B.

## Restatement / observed-later matrix

The existing fundamentals-loader limitation remains explicit: initial provider backfill may already
contain historical restatements that the provider no longer versions.

From first product ingestion onward, test:

- same logical fiscal identity + same content hash -> no duplicate revision/event;
- later filing date -> immutable new revision and new PIT event;
- changed content with no later filing date, first observed today -> eligibility is not backdated
  before the existing loader's `max(filingDate + 1 day, observedAt calendar date)` rule;
- rebuilding from the new eligibility point changes derived rows only from that point forward;
- Redis years touched by a mid-year rebuild retain the earlier months of that year.

## Daily materialization matrix

`materializeDailyFundamentals` requires tests that prove:

- first trading day is evaluated;
- multiple statement events on one trading date collapse to one final snapshot;
- values carry forward exactly between events;
- unavailability carries forward after an invalidating event;
- a later valid event can restore a previously unavailable metric;
- trading dates are sorted/canonical even if input statements are shuffled;
- there is exactly one output state per canonical trading day when using a daily-output shape;
- no output row exists on a weekend/holiday absent from `DailyPrice`;
- no statement revision after a trading date can influence that date;
- every one of the fifteen metrics fires non-null on at least one sufficiently complete fixture.

## `DailyDerivedState` persistence matrix

The persistence PR must prove:

- all fifteen registered fields have real nullable PostgreSQL columns;
- migration is additive and existing row identity remains `(securityId, date)`;
- domain -> Prisma -> domain round-trip preserves each field to storage precision;
- `NULL` round-trips as absent, not zero;
- negative valid values round-trip correctly;
- very large finite multiples within supported decimal bounds round-trip or are rejected according
  to the existing store contract, never silently converted to infinity;
- `buildDailyDerivedState` writes the metric snapshot onto the same daily row as technical and
  intrinsic state;
- a `DERIVED_STATE_REVISION` bump invalidates old coverage/manifests and causes canonical rebuild;
- there is no new fundamentals-specific calculated-state table.

## Redis parity and cache matrix

Required integration tests:

- warm PostgreSQL -> Redis publish -> Redis read returns all fifteen values identically;
- flush Redis -> same stock/range rehydrates from PostgreSQL without provider requests;
- partial derived rebuild mid-year republishes a complete affected yearly chunk;
- complete-stock LRU eviction removes the fundamental fields with the existing daily-state chunk;
- generation fencing prevents a stale hydration owner from publishing old fundamental rows;
- READY manifest never advertises a current derived revision while Redis holds an older row shape;
- no `SCAN`-based hot path is introduced;
- no separate calculated-fundamentals Redis key family exists.

Measure yearly chunk size after the fifteen columns are added and record it against the existing
wide-column Redis budget in `retain-wide-column-calculated-series-storage.md`. A budget breach is a
design trigger, not a reason to hide the measurement.

## Strategy contract matrix

For all fifteen metric identities, prove:

- metric can be represented by the canonical `FUNDAMENTAL` Strategy metric family;
- canonical description uses the single product label;
- percent metrics accept the Strategy percent value unit;
- multiple metrics accept the chosen canonical numeric/multiple unit;
- metric is accepted in Conditions;
- metric is rejected in Triggers in V1;
- unsupported Value kinds/operators are rejected by the shared compatibility registry;
- Builder-visible options equal backend-valid options;
- no separate frontend metric list exists;
- serialized Strategy definition round-trips without changing identity.

Fingerprint tests must prove at minimum:

```text
ROIC_TTM != ROE_TTM
ROIC_TTM != REVENUE_GROWTH_TTM_YOY
DEBT_TO_EQUITY != CURRENT_RATIO
```

under otherwise identical conditions. This is a regression guard against the class of identity bug
previously found in parameterized metrics such as RVOL.

## Evaluation-frame matrix

For each metric family unit/group:

- requested fundamental operand becomes exactly one frame column;
- unrequested fundamental fields are not projected;
- persisted `NULL` becomes frame `NaN`/absence;
- persisted zero remains numeric zero;
- persisted negative value remains negative;
- `collectOperands` deduplicates repeated references to the same metric;
- two different fundamental metrics produce distinct operand keys/columns;
- projection performs no formula calculation and reads only the explicit `DailyDerivedState` field.

A test should deliberately make the raw `FinancialStatement` fixtures disagree with a persisted
`DailyDerivedState` value and prove the evaluation frame reads the persisted derived value. That
locks the architecture: the evaluator is not a shadow fundamentals engine.

## Backtest matrix

Targeted backtest fixtures must cover:

- one BUY Condition based only on a fundamental metric;
- fundamental + technical Condition AND combination;
- fundamental + RVOL combination;
- fundamental + intrinsic-value/Margin-of-Safety combination;
- BUY eligibility window interaction;
- SELL/final-exit Condition use if the product contract allows the same fundamental Condition family
  there;
- unavailable metric -> predicate not evaluable under existing semantics, never equivalent to zero;
- metric turns false -> true on a statement event and entry becomes possible only from that trading
  date;
- metric turns true -> unavailable on a later revision and does not remain latched as a stale
  numeric reading;
- same Strategy + same data -> deterministic trades/equity bytes across reruns;
- zero provider requests once the dataset is provisioned.

The backtest hot path should be instrumented/proven indirectly so that no per-day financial
statement query, Redis read or TTM calculation occurs.

## Monitor parity matrix

If Monitor evaluates Fundamental Conditions:

- backtest and Monitor project the same metric on the same completed session through
  `projectEvaluationFrame`;
- a statement event changes both on the same eligible trading date;
- durable Monitor level identity includes the fundamental metric id;
- repeated application of the same transition does not double-emit;
- no intraday/current-price path invents a new fundamental value between completed daily sessions.

Realtime pricing is not required to satisfy this matrix.

## Chart/API parity matrix

For each exposed fundamental metric:

- API value on date `D` equals the persisted `DailyDerivedState` value on `D`;
- Strategy/backtest frame value on `D` equals that same API value before display formatting;
- unavailable remains absent in API and chart;
- UI rounding does not alter backend value;
- step rendering changes only at actual value/event boundaries and never interpolates a diagonal
  financial value between two reports;
- selecting a metric does not trigger a raw-statement formula in the web app;
- tooltip/source-period metadata, if exposed, identifies the relevant TTM end / availability date
  without pretending the fiscal period end was the information date.

A dedicated parity fixture should compare a date immediately before and immediately after a filing
eligibility boundary.

## Cold-environment / reconstruction gate

Before final merge readiness, verify from a clean environment/database state supported by the repo:

1. apply migrations from scratch;
2. provision canonical source data through normal stock-data paths;
3. materialize Fundamental Metrics;
4. verify PostgreSQL rows;
5. verify Redis publication;
6. flush Redis;
7. reconstruct/read identical results without changing PostgreSQL truth;
8. run representative Strategies/backtests with provider access disabled after provisioning.

No seed-only or developer-local shortcut may be required for production paths.

## Independent audit gate

After all feature PRs are merged, run an audit separate from the implementation work.

For every audited security/date with sufficient source data, independently reconstruct:

- eligible statement revision set;
- selected consecutive fiscal windows;
- all fifteen formulas;
- expected availability/unavailability;
- expected daily carry-forward.

Compare the independent oracle against persisted `DailyDerivedState` at storage precision.

The audit must report at least:

```text
security count
trading-day count
metric comparisons by metric
non-null comparison count by metric
unavailable comparison count by metric
formula mismatches by metric
PIT violations
revision-boundary violations
PostgreSQL/Redis mismatches
chart/evaluation-frame mismatches
provider requests during provisioned backtests
determinism differences
```

Recording a metric's non-null count is mandatory: an always-null broken implementation can otherwise
produce zero numeric mismatches.

## Performance / budget checks

Feature correctness comes first, but the final implementation must measure rather than guess:

- full derived rebuild CPU time per long-history security before/after Fundamental Metrics;
- `DailyDerivedState` average PostgreSQL row size;
- Redis yearly daily-state chunk size;
- projected evaluation-frame memory for representative strategies using 1, 5 and 15 Fundamental
  Metrics;
- large backtest runtime versus an equivalent strategy without Fundamental Conditions.

The architecture expects the day-loop cost of a fundamental Condition to be an array read plus
numeric predicate. A measured regression that implies per-day statement work is a correctness issue,
not merely an optimization opportunity.

## Merge gates by PR

### Calculation/materialization PR

Must pass:

- all metric golden vectors;
- shared fiscal-window suite;
- PIT event/carry-forward suite;
- missing/negative/zero edge matrix;
- existing package tests/typecheck/lint for touched packages.

### Persistence/cache/rebuild PR

Must pass:

- migration validation/drift checks;
- all fifteen column completeness checks;
- PostgreSQL round-trip;
- Redis parity and cold-cache reconstruction;
- derived-revision rebuild behavior;
- existing stock-data/API/worker affected suites.

### Strategy/Backtest PR

Must pass:

- contract compatibility/drift tests;
- fingerprint uniqueness;
- operand collection/projection;
- targeted backtest determinism/PIT cases;
- Monitor parity where applicable;
- no provider requests in provisioned execution.

### Chart PR

Must pass:

- API/persistence parity;
- chart/evaluator parity fixture;
- step rendering behavior;
- responsive UI/e2e coverage consistent with existing Stock Details standards.

### Final audit PR

Must pass:

- independent full-history formula/PIT comparison;
- non-null coverage evidence for every metric;
- persistence/cache parity;
- deterministic representative backtest matrix;
- workspace CI and production-isolation checks.

## Non-goal of this matrix

This document does not set the methodology for `P/E`, `P/S`, `P/FCF` or `EV/EBITDA`. Their tests
belong to the future Valuation methodology and must not be silently added to Fundamental Metrics V1.
