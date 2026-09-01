# Strategies

A strategy defines reusable signal logic. It does not own a stock universe, capital, monthly
contributions, maximum open positions, or a maximum-allocation percentage. Those are execution
inputs of a backtest run. A monitor evaluates the same canonical strategy logic against current
data.

## Shape

A strategy version contains:

- name and optional description;
- ordered BUY levels;
- ordered SELL levels;
- an optional FINAL EXIT;
- no global intrinsic-value model;
- no user-configurable candidate-ranking setting.

Every condition chooses the valuation or technical series it needs. All selectable series come
from the canonical catalog in `../../docs/decisions/selectable-series-catalog.md`; Strategy UI and
Stock Details must not maintain separate option lists.

## Condition grammar

Conditions render as human-readable sentences. Depending on the predicate, the row is either:

```text
[left metric] [operator] [comparison]

Discount to [valuation source] [operator] [percentage]
Premium over [valuation source] [operator] [percentage]
```

Only compatible comparisons are shown. The UI uses a filtered view of the canonical series
catalog rather than accepting arbitrary operand combinations.

### V1 predicates

| Predicate | Operators | Comparisons | Allowed in |
| --- | --- | --- | --- |
| Price versus series | `is above`, `is below`, `crosses above`, `crosses below` | all 21 selectable series | BUY, SELL, FINAL EXIT |
| Discount to intrinsic value | `is at least`, `is at most` | 7 valuation sources plus a discount preset | BUY, SELL, FINAL EXIT |
| Premium over intrinsic value | `is at least`, `is at most` | 7 valuation sources plus a premium preset | BUY, SELL, FINAL EXIT |
| Moving average versus moving average | `is above`, `is below`, `crosses above`, `crosses below` | another moving average in the same timeframe | BUY, SELL, FINAL EXIT |
| Gain from entry | `is at least` | gain preset | SELL, FINAL EXIT only |
| Loss from entry | `is at least` | loss preset | SELL, FINAL EXIT only |

`Price` means the canonical end-of-day close. A moving average cannot compare with itself.
Daily-to-weekly moving-average comparisons are excluded from V1; both operands of a moving-average
comparison use the same timeframe.

### Percentage presets

- intrinsic-value discount: `10, 15, 20, 25, 30, 40, 50%`;
- intrinsic-value premium: `10, 15, 20, 25, 30, 50, 75, 100%`;
- gain from entry: `5, 10, 15, 20, 25, 30, 40, 50, 75, 100%`;
- loss from entry: `5, 10, 15, 20, 25, 30, 40, 50%`.

These are product dropdown values, not free-text suggestions. API/domain validation must enforce
the same allowed values.

### Operator semantics

- `is above` is strict `>`;
- `is below` is strict `<`;
- `is at least` is inclusive `>=`;
- `is at most` is inclusive `<=`;
- `crosses above` means previous left `<=` previous right and current left `>` current right;
- `crosses below` means previous left `>=` previous right and current left `<` current right.

A cross is not evaluable without both current and previous eligible operand values. Weekly values
use only completed weeks and are carried forward daily according to the canonical stock-data
policy.

## Rule composition

- Conditions inside one level are combined with AND.
- Separate levels are alternatives (OR) and are evaluated in their displayed order.
- The first matching BUY level produces the BUY action for that symbol.
- The first matching SELL level produces the partial SELL action for that symbol on that day.
- FINAL EXIT is checked only when no partial SELL executed for that symbol on that day.
- Position-dependent predicates are not offered in BUY rules.

Three-valued evaluation is required:

- `TRUE`: all data exists and the predicate matches;
- `FALSE`: all data exists and the predicate does not match;
- `NOT_EVALUABLE`: a required operand or position state is unavailable.

`NOT_EVALUABLE` never produces a trading signal and must retain a stable reason code for backtest
diagnostics and monitor health details.

## Actions

### BUY

A BUY level selects one entry fraction of a full position:

- 25%;
- 50%;
- 75%;
- 100%.

The percentage is not a percentage of the whole portfolio. It is a fraction of one full position,
whose size is derived by the backtest from `maximumPositions`. An already-open symbol consumes one
position slot regardless of entry fraction and cannot receive another BUY until that position is
fully closed. Unused capacity remains cash; monthly contributions do not automatically top up an
open partial position.

### SELL

A SELL level selects one fraction of the position remaining at execution time:

- 25%;
- 50%;
- 75%.

Therefore two successive 50% SELL actions sell 75% of the original shares. Each SELL level fires
at most once per position lifecycle.

### FINAL EXIT

FINAL EXIT has no percentage selector. It sells the entire remaining position.

## Candidate ordering

Candidate ordering is automatic and is not exposed in Strategy Builder. If all simultaneous BUY
candidates fit within cash and open-position capacity, all are eligible. When they do not all fit:

1. candidates with an available Balanced intrinsic value are ordered by Balanced discount,
   highest first;
2. candidates without an available Balanced value follow;
3. the final deterministic tie-break is symbol ascending.

This policy is engine methodology and must be versioned/snapshotted with backtest execution so a
future policy change cannot silently reinterpret completed runs.

## UI requirements

Strategy Builder contains only:

1. strategy details;
2. BUY rules;
3. SELL rules;
4. optional FINAL EXIT;
5. a human-readable logic preview.

It must not show a global valuation-model field, `maximumPositions`, a maximum-allocation
percentage, or a candidate-ranking control.
