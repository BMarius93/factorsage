# Strategies

## Status

Product definition for Strategy V1.

The domain boundaries, level structure, Condition/Trigger grammar and the initial operators in this
document are product decisions. The complete metric compatibility matrix is still being expanded.
Coding agents must not silently fill gaps in the matrix or turn technical implementation choices
into new product semantics.

## Domain boundary

A **Strategy** defines reusable investment signal logic.

Keep these concepts separate:

- **Strategy** — reusable BUY / SELL / FINAL EXIT logic;
- **Stock List** — the user-owned universe of securities to evaluate;
- **Backtest configuration** — combines a Strategy and a Stock List and adds execution inputs such
  as date range, initial capital, contributions, `maximumPositions`, fees or other simulation
  settings;
- **Backtest run** — one immutable execution of a backtest configuration and its results.

A Strategy does **not** own a Stock List, backtest date range, initial capital, monthly
contributions, `maximumPositions`, or other run-specific inputs.

A monitor may later evaluate the same canonical Strategy logic against current data. Monitoring
must not define a second strategy language.

## Strategy shape

A strategy version contains:

- name and optional description;
- ordered **BUY levels**;
- ordered **SELL levels**;
- an optional **FINAL EXIT**;
- no global intrinsic-value model;
- no Stock List or backtest execution parameters.

Each level owns one **Signal**. The signal decides whether that level matches on a given eligible
date. The level then carries the action metadata appropriate to BUY, SELL or FINAL EXIT.

## Signal model

A Signal contains:

- zero or more **Conditions**;
- zero or one **Trigger**.

A signal must contain at least one Condition or a Trigger.

All Conditions in a signal are combined with **AND**. If a Trigger exists, it is also ANDed with
the Conditions for that date.

Conceptually:

```text
Signal[t] =
  Condition1[t]
  AND Condition2[t]
  AND ...
  AND OptionalTrigger[t]
```

There can be **at most one Trigger per Signal**.

This is deliberate product semantics. Conditions describe persistent state; the optional Trigger
describes the single event that fires the signal while that state is true. Multiple independent
triggers in one signal would usually require unrelated transitions to happen on exactly the same
date and are excluded from V1.

## Product terminology

Do not expose `left operand`, `right operand`, AST terminology or other compiler vocabulary in the
Strategy product model.

A Condition is presented as:

```text
Metric -> Price
Condition -> is above
Value -> EMA 50D
```

A Trigger is presented as:

```text
Metric -> Price
Trigger -> crosses above
Value -> EMA 50D
```

The same three-field mental model is used for every supported metric family. The available Values
and operators are filtered by the selected Metric.

## Conditions

Initial V1 Condition operators are:

- `is above`;
- `is below`;
- `is close to` where compatible.

`is above` and `is below` are strict comparisons. V1 intentionally does not expose equality,
`above or equal`, or `below or equal` variants.

### `is close to`

`is close to` is a Condition, not a Trigger. It describes a state that may remain true for several
consecutive dates.

For V1, `is close to` means **within 2% of the comparison value**. The 2% tolerance is a product
constant, not a user-editable Strategy parameter.

Example:

```text
Metric -> Price
Condition -> is close to
Value -> EMA 200D
```

The UI should keep the row simple and explain the fixed 2% tolerance in help text / tooltip rather
than adding another input.

Conceptually, for compatible numeric values:

```text
abs(metric - value) / abs(value) <= 0.02
```

If the comparison value is unavailable or cannot be used safely for the calculation, the predicate
is `NOT_EVALUABLE`, never an invented zero or fallback.

## Triggers

Initial V1 Trigger operators are:

- `crosses above`;
- `crosses below`.

A Trigger is an event / transition. It requires both the current and previous eligible values.

`crosses above` means:

```text
metric[t] > value[t]
AND
metric[t-1] <= value[t-1]
```

`crosses below` means:

```text
metric[t] < value[t]
AND
metric[t-1] >= value[t-1]
```

Example:

```text
Metric -> Price
Trigger -> crosses above
Value -> EMA 50D
```

The distinction from a Condition is fundamental:

```text
Price is above EMA 50D
false false true true true false

Price crosses above EMA 50D
false false true false false false
```

A Trigger is not evaluable when either the current or previous required value is unavailable.

## Daily evaluation model

The product mental model is date-aligned series evaluation.

Historical market-derived metrics are aligned to eligible trading dates. Evaluating one Condition
or Trigger produces one logical result per date. Multiple Conditions are then ANDed by date, and
the optional Trigger is ANDed with them.

For example:

```text
Price is above EMA 50D
-> logical daily result series

RSI 14D is below 30
-> logical daily result series

Margin of Safety (DCF) is above 25%
-> logical daily result series
```

The simple mental model is a boolean array. The technical implementation must preserve a third
state for unavailable data:

- `TRUE` — all required data exists and the predicate matches;
- `FALSE` — all required data exists and the predicate does not match;
- `NOT_EVALUABLE` — required market data, derived data, previous trigger data, or position state is
  unavailable.

`NOT_EVALUABLE` never produces a trading signal. It must not be silently converted to zero or to a
future value.

This document defines the semantics, not the in-memory representation. A future implementation may
use arrays, typed arrays, bitsets, iterators or another representation if it preserves exactly the
same date-aligned results, diagnostics and deterministic behavior.

## Series alignment and point-in-time rules

Strategy evaluation inherits the canonical stock-data rules.

- `Price` means canonical end-of-day close.
- Moving averages and intrinsic-value series come from the canonical selectable-series catalog in
  `../../docs/decisions/selectable-series-catalog.md`.
- Weekly values use only completed weeks and are carried forward onto eligible daily rows according
  to the canonical stock-data policy.
- Warm-up gaps remain unavailable.
- Fundamental and intrinsic-value inputs must remain point-in-time correct.
- No predicate may use future information to fill a missing current or previous value.
- A cross requires the actual eligible `t-1` and `t` values under the same point-in-time policy.

## Initial metric patterns

The complete metric compatibility matrix is intentionally maintained as a product concern. The
patterns below are already established and should guide the first implementation.

### Price

Price compares with compatible price-valued series, including moving averages and intrinsic-value
models / blends from the canonical selectable-series catalog.

Examples:

```text
Metric -> Price
Condition -> is above
Value -> EMA 50D
```

```text
Metric -> Price
Condition -> is close to
Value -> EMA 200D
```

```text
Metric -> Price
Trigger -> crosses below
Value -> Balanced
```

Supported initial operators:

- Conditions: `is above`, `is below`, `is close to`;
- Triggers: `crosses above`, `crosses below`.

### Margin of Safety

Margin of Safety (MOS) is a first-class derived Strategy metric, parameterized by the selected
intrinsic-value source. It is not exposed as a special comparison operator.

Example:

```text
Metric -> Margin of Safety (DCF)
Condition -> is above
Value -> 25%
```

or:

```text
Metric -> Margin of Safety (Balanced)
Trigger -> crosses above
Value -> 25%
```

Conceptually:

```text
MOS = (Intrinsic Value - Price) / Intrinsic Value * 100
```

Therefore:

- positive MOS means Price is below the selected intrinsic value;
- `0%` means Price is at the selected intrinsic value;
- negative MOS means Price is above the selected intrinsic value.

Supported initial operators:

- Conditions: `is above`, `is below`;
- Triggers: `crosses above`, `crosses below`.

`is close to` is not exposed for MOS in V1.

### Gain and Loss

Gain and Loss are position-dependent metrics intended for SELL and FINAL EXIT logic. They are not
available in BUY rules.

Examples:

```text
Metric -> Gain
Condition -> is above
Value -> 25%
```

```text
Metric -> Loss
Trigger -> crosses above
Value -> 10%
```

Supported initial operators:

- Conditions: `is above`, `is below`;
- Triggers: `crosses above`, `crosses below`.

Unlike Price, moving averages, intrinsic value and MOS, Gain/Loss cannot necessarily be precomputed
from market history alone because they depend on the simulated position state. The technical design
must treat this difference explicitly rather than forcing Gain/Loss into a static historical array.

The exact cost-basis semantics used by Gain/Loss must be confirmed as a product decision before
implementation if they are not already authoritative elsewhere.

## Metric compatibility table — current V1 baseline

| Metric | Condition operators | Trigger operators | Value type | Allowed in |
| --- | --- | --- | --- | --- |
| Price | `is above`, `is below`, `is close to` | `crosses above`, `crosses below` | compatible price-valued canonical series | BUY, SELL, FINAL EXIT |
| Margin of Safety (selected IV source) | `is above`, `is below` | `crosses above`, `crosses below` | percentage | BUY, SELL, FINAL EXIT |
| Gain | `is above`, `is below` | `crosses above`, `crosses below` | percentage | SELL, FINAL EXIT |
| Loss | `is above`, `is below` | `crosses above`, `crosses below` | percentage | SELL, FINAL EXIT |

This is the current baseline, not a declaration that these are the only eventual metrics. RSI,
additional technical metrics, fundamentals and other derived metrics must be added deliberately with
their own compatible Value types and operators. Do not infer compatibility merely because two
values are numeric.

## BUY levels

A Strategy may contain multiple ordered BUY levels.

Each BUY level contains:

- one Signal;
- one BUY level percentage selected from `25%`, `50%`, `75%`, `100%`.

The percentage represents a fraction of one full position, not a percentage of the whole portfolio.
The size of a full position is an execution concern derived from the backtest inputs (for example
`maximumPositions`) and is not stored as a Strategy-level portfolio limit.

A BUY Signal may use only market-derived metrics. Position-dependent Gain/Loss metrics are not
available before a position exists.

The exact lifecycle behavior for repeated BUY levels against an already-open position must follow
the accepted backtest execution rules. If that behavior is not yet authoritative, agents must mark
it as an open product question rather than invent it inside the Strategy evaluator.

## SELL levels

A Strategy may contain multiple ordered SELL levels.

Each SELL level contains:

- one Signal;
- one partial SELL percentage selected from `25%`, `50%`, `75%`.

SELL levels may use both market-derived metrics and position-dependent metrics such as Gain/Loss.

The selected SELL percentage is the fraction of the position remaining at execution time. For
example, two successive 50% partial sells leave 25% of the original position if both are allowed to
execute during the position lifecycle.

Whether a specific SELL level may fire more than once per position lifecycle is an execution rule
and must be kept explicit in the backtest design; do not infer it merely from the signal grammar.

## FINAL EXIT

FINAL EXIT is a distinct Strategy concept, not a `SELL 100%` level.

It contains one Signal and no percentage selector. When it executes, it closes the entire remaining
position.

Keeping FINAL EXIT distinct allows the position lifecycle and later monitoring/backtest reporting
to distinguish partial profit/risk management from the condition that ends the position.

The precedence between a matching partial SELL and FINAL EXIT on the same date must remain an
explicit engine rule. Preserve any already-authoritative rule; otherwise report it as an open
product decision.

## Level composition

Signals inside one level use AND as described above.

Separate BUY levels and separate SELL levels are distinct candidate actions. Their ordering is
preserved by the Strategy definition.

The backtest technical design must define deterministic handling when more than one level of the
same action family matches on the same date. It must not silently choose an interpretation that is
not already a product decision.

## Validation rules

At minimum, Strategy validation must enforce:

- at least one Condition or Trigger in every Signal;
- no more than one Trigger in a Signal;
- only operators supported by the selected Metric;
- only Value types compatible with the selected Metric/operator;
- `is close to` only where explicitly supported;
- no Gain/Loss metrics in BUY rules;
- no unavailable or arbitrary series identifiers outside the canonical catalogs/registries;
- valid BUY/SELL level percentages;
- FINAL EXIT has no percentage selector;
- no Strategy-owned Stock List, capital, contribution, `maximumPositions` or backtest date-range
  fields.

API/domain validation and Strategy Builder options must derive from the same canonical definitions;
the UI must not maintain a second independent compatibility matrix.

## What is deliberately not decided here

This document defines product semantics. It does not prescribe:

- whether logical daily results are stored as normal arrays, typed arrays, bitsets or streamed;
- how common metric series are cached/reused across rules;
- the evaluator class/interface layout;
- whether static market predicates and position-state predicates use separate evaluator layers;
- database schema for Strategy persistence/versioning;
- backtest worker batching/parallelism;
- exact diagnostics representation for `NOT_EVALUABLE`;
- product metrics not yet added to the compatibility table;
- any backtest execution behavior explicitly called out above as still open.

Those are technical-design or remaining product decisions. A coding agent may recommend them, but
must separate recommendations from established product behavior and must not implement them before
the relevant task authorizes implementation.

## Strategy Builder surface

The Strategy Builder should contain only Strategy concerns:

1. strategy details;
2. BUY levels;
3. SELL levels;
4. optional FINAL EXIT;
5. a human-readable logic preview.

Each Signal visually separates:

- **Conditions** — zero or more rows, combined with AND;
- **Trigger (optional)** — zero or one row.

Do not put Stock List selection, backtest period, initial capital, monthly contributions,
`maximumPositions`, fees or other backtest-run parameters into Strategy Builder.
