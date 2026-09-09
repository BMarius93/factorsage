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

A Strategy must contain **at least one BUY level** to be saved: without one, nothing can ever be
bought and the strategy is inert. SELL levels and FINAL EXIT remain optional — a strategy that only
buys and holds is valid.

Strategy identity is the Strategy id. Names are **not** unique per user: the same person may keep
two strategies both called `Value Strategy`, and they remain distinct records.

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
- Moving averages, oscillators and intrinsic-value series come from the canonical selectable-series
  catalog in `../../docs/decisions/selectable-series-catalog.md`.
- Weekly values use only completed weeks and are carried forward onto eligible daily rows according
  to the canonical stock-data policy.
- Warm-up gaps remain unavailable.
- Fundamental and intrinsic-value inputs must remain point-in-time correct.
- No predicate may use future information to fill a missing current or previous value.
- A cross requires the actual eligible `t-1` and `t` values under the same point-in-time policy.

Catalog membership does not automatically make a series a supported Strategy metric/value. Strategy
compatibility remains an explicit product matrix.

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

### Moving averages

The canonical moving averages are first-class Strategy metrics, not only Values. This enables the
natural moving-average relationships a user expects to express directly:

```text
Metric -> EMA 50D
Trigger -> crosses above
Value -> SMA 200D
```

```text
Metric -> SMA 50D
Condition -> is above
Value -> SMA 200D
```

Compatibility is explicit, never inferred from the fact that two series are numeric. For a selected
moving-average Metric, the permitted Values are exactly the canonical compatible set for that
series:

- the same timeframe only — a daily moving average compares with daily moving averages, a weekly
  with weekly. Daily-versus-weekly comparisons are not part of V1;
- never the metric itself.

This is the rule the selectable-series catalog already expresses as `comparableMovingAverages`, and
it remains the single source of that compatibility. API validation and the Strategy Builder both
read it; neither restates it.

Supported V1 operators:

- Conditions: `is above`, `is below`, `is close to`;
- Triggers: `crosses above`, `crosses below`.

The fixed 2% tolerance defined above applies to `is close to` here exactly as it does for Price.

### RSI

The canonical RSI series are first-class Strategy metrics:

- `RSI 7D`;
- `RSI 14D`;
- `RSI 21D`.

Each RSI metric compares with a user-entered numeric threshold. The Value is constrained to the
product range `1` through `100`; it is not limited to conventional presets such as 30 or 70.

Examples:

```text
Metric -> RSI 14D
Condition -> is below
Value -> 30
```

```text
Metric -> RSI 14D
Condition -> is above
Value -> 70
```

```text
Metric -> RSI 14D
Trigger -> crosses above
Value -> 30
```

```text
Metric -> RSI 14D
Trigger -> crosses below
Value -> 70
```

Supported V1 operators for RSI 7D, RSI 14D and RSI 21D are:

- Conditions: `is above`, `is below`;
- Triggers: `crosses above`, `crosses below`.

`is close to` is not exposed for RSI in V1.

RSI triggers use the same transition semantics as every other Trigger. For example:

```text
RSI 14D crosses above 30
=
RSI14D[t] > 30
AND
RSI14D[t-1] <= 30
```

An unavailable RSI warm-up value makes the predicate `NOT_EVALUABLE`; the evaluator must not
substitute zero.

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

#### Canonical formula

```text
MOS = (Intrinsic Value - Price) / Intrinsic Value * 100
```

**The denominator is Intrinsic Value, never Price.** Margin of Safety is the discount to intrinsic
value. It must not be confused with upside, which divides by Price and answers a different
question:

```text
Intrinsic Value = 100, Price = 75

MOS    = (100 - 75) / 100 * 100 = 25%
upside = (100 - 75) /  75 * 100 = 33.33%
```

These are intentionally different concepts. The product exposes MOS; it does not expose upside.

Further canonical examples:

```text
Intrinsic Value = 100, Price = 100  -> MOS =   0%
Intrinsic Value = 100, Price = 120  -> MOS = -20%
```

Interpretation:

- positive MOS means Price is below the selected intrinsic value;
- `0%` means Price is at the selected intrinsic value;
- negative MOS means Price is above the selected intrinsic value.

#### Availability and point-in-time rules

If the selected point-in-time intrinsic value is `<= 0`, MOS is `NOT_EVALUABLE`. The ratio is
undefined at zero and sign-inverted below it, so a negative intrinsic value would otherwise report
a large positive margin of safety for a stock trading far above it.

Each MOS metric uses the point-in-time series of **its own explicitly selected** intrinsic-value
source: `Margin of Safety (DCF)`, `Margin of Safety (Graham)` and `Margin of Safety (Balanced)` are
different metrics over different series. Never substitute zero, future data, a current-day
intrinsic value applied to a historical date, or another intrinsic-value model. Every existing
point-in-time and no-look-ahead rule continues to apply unchanged.

#### Value domain

Any finite percentage `<= 100%`. There is no artificial lower bound, and decimal thresholds such as
`22.5` are allowed. The upper bound is the metric's own mathematics rather than a product limit:
with a positive price and a positive intrinsic value, MOS is always below `100`.

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

#### Canonical definitions

Both metrics are measured against the position's **average cost**:

```text
Gain = (Price - AverageCost) / AverageCost * 100

Loss = max(0, (AverageCost - Price) / AverageCost * 100)
```

**Gain is signed.** It is negative while the position is underwater:

```text
Price = 125, AverageCost = 100  -> Gain =  25%
Price =  85, AverageCost = 100  -> Gain = -15%
```

**Loss is a non-negative loss-from-average-cost metric**, clamped at zero. It is deliberately _not_
an unclamped negative mirror of Gain:

```text
Price = 125, AverageCost = 100  -> Loss =  0%
Price =  85, AverageCost = 100  -> Loss = 15%
```

So a rule reads exactly as a user expects it to:

```text
Loss is above 10%
```

means the current price is more than 10% below the position's average cost.

#### Value domains

- `Gain`: any finite percentage `>= -100%`, no artificial upper bound, decimals allowed;
- `Loss`: `0%` through `100%`, decimals allowed.

Both bounds are the metrics' own mathematics rather than product limits: with a positive price, a
long position can never lose more than its entire cost.

Supported initial operators:

- Conditions: `is above`, `is below`;
- Triggers: `crosses above`, `crosses below`.

Unlike Price, moving averages, intrinsic value, RSI and MOS, Gain/Loss cannot necessarily be
precomputed from market history alone because they depend on the simulated position state. The
technical design must treat this difference explicitly rather than forcing Gain/Loss into a static
historical array.

How average cost evolves across repeated BUY levels and partial SELLs during one position
lifecycle is execution behaviour and stays with the backtest design; the Strategy-facing definition
above is what the metric means and does not depend on that answer.

## Metric compatibility table — current V1 baseline

| Metric                                          | Condition operators                   | Trigger operators                | Value type                                                                              | Allowed in            |
| ----------------------------------------------- | ------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- | --------------------- |
| Price                                           | `is above`, `is below`, `is close to` | `crosses above`, `crosses below` | compatible price-valued canonical series                                                | BUY, SELL, FINAL EXIT |
| Moving average (any of the 14 canonical series) | `is above`, `is below`, `is close to` | `crosses above`, `crosses below` | the canonical compatible moving averages for that series — same timeframe, never itself | BUY, SELL, FINAL EXIT |
| RSI 7D / 14D / 21D                              | `is above`, `is below`                | `crosses above`, `crosses below` | user-entered numeric threshold `1..100`                                                 | BUY, SELL, FINAL EXIT |
| Margin of Safety (selected IV source)           | `is above`, `is below`                | `crosses above`, `crosses below` | percentage `<= 100`, decimals allowed                                                   | BUY, SELL, FINAL EXIT |
| Gain                                            | `is above`, `is below`                | `crosses above`, `crosses below` | percentage `>= -100`, decimals allowed                                                  | SELL, FINAL EXIT      |
| Loss                                            | `is above`, `is below`                | `crosses above`, `crosses below` | percentage `0..100`, decimals allowed                                                   | SELL, FINAL EXIT      |

This is the current baseline, not a declaration that these are the only eventual metrics.
Additional technical metrics, fundamentals and other derived metrics must be added deliberately with
their own compatible Value types and operators. Do not infer compatibility merely because two
values are numeric.

## BUY levels

A Strategy may contain multiple ordered BUY levels, and must contain at least one.

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

- at least one BUY level in every saved Strategy;
- at least one Condition or Trigger in every Signal;
- no more than one Trigger in a Signal;
- only operators supported by the selected Metric;
- only Value types compatible with the selected Metric/operator;
- `is close to` only where explicitly supported;
- RSI Values constrained to numeric thresholds from `1` through `100`;
- moving-average Values restricted to the canonical compatible set for the selected moving-average
  Metric — same timeframe, never the metric itself, and never inferred from numeric similarity;
- percentage Values inside their metric's own semantic domain: Margin of Safety `<= 100`, Gain
  `>= -100`, Loss `0..100`. There is no single shared percentage range;
- no two semantically identical Conditions inside one Signal. A duplicate is rejected with an error
  pointing at the duplicated row; it is never silently removed, because ANDing a predicate with
  itself is a no-op and always a mistake. Identity is semantic — same Metric, same operator, same
  Value — not object or row identity;
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

### Contextual metric explanation

Rule rows stay simple. A metric that needs explaining is explained beside the row, never by adding
inputs to it.

`Margin of Safety` is the clearest case. Its row stays exactly three fields:

```text
Metric -> Margin of Safety (DCF)
Condition -> is above
Value -> 25%
```

There are no formula-configuration inputs: the intrinsic-value source is part of the Metric, and
the formula is fixed. The Builder must instead explain the metric contextually, covering:

- what Margin of Safety means;
- the canonical formula, with Intrinsic Value as the denominator;
- a simple numerical example;
- the distinction between MOS and upside;
- the meaning of positive, zero and negative MOS.

On desktop this belongs in the right-hand explanation panel. On mobile the equivalent explanation
appears near the relevant Metric or through the Builder's compact expandable help surface. The
rendering may differ between the two; the semantics must not.

Explanation content must be derived from canonical Strategy metric metadata — the same registry
definitions that supply Metric, operator and Value options — rather than hard-coded inside the
Strategy Builder feature. Two surfaces explaining one metric differently is the drift the single
canonical catalog and registry exist to prevent.

Builder help text describes **what a signal means**, never what the backtest engine does with it.
Execution behaviour that is still an open decision — whether a level fires once or repeatedly, how
two matching levels interact, how SELL and FINAL EXIT resolve on the same date — must not appear in
help text as established fact.

## Strategy Builder UX direction

The old IntrinsicValue repository is the **visual and behavioral UX oracle** for Strategy Builder,
not an architectural source. Preserve the recognizable interaction language and visual family where
it still fits V2, but do not copy old frontend architecture, state management, data access or domain
modeling wholesale. V2 product documents, contracts and frontend architecture remain authoritative.

### Visual language

- Preserve the established Strategy Builder color language from the old product where it remains
  useful, especially clear visual differentiation between BUY, SELL and FINAL EXIT.
- Use the current FactorSage semantic design tokens and component primitives rather than introducing
  a second palette or scattering hard-coded colors through feature code.
- Controls should keep the compact, financial-tool density of the old builder rather than becoming
  oversized generic form controls.
- Select/dropdown interactions should feel recognizably similar to the old product, while their
  actual option sets and validation come from the canonical V2 Strategy definitions.
- Signal rows should read naturally as short sentences. `Metric / Condition / Value` and
  `Metric / Trigger / Value` are the primary interaction pattern; avoid exposing compiler-style or
  implementation-oriented concepts.
- BUY levels, SELL levels and FINAL EXIT must be visually distinguishable without requiring the user
  to read every label, while still keeping the overall UI restrained rather than decorative.

### Desktop composition

On desktop, prefer the old product's two-area composition rather than a single full-width form:

- the main Strategy editing surface occupies roughly **65–70%** of the available content width;
- a contextual explanation / preview area occupies roughly **30–35%** on the right;
- the right-side area should remain visible while editing when practical, for example with sticky
  positioning inside the page layout;
- the right-side area may contain the explanation for the currently focused Metric, Condition,
  Trigger or Value, longer help text, examples, and the human-readable Strategy logic preview;
- the Strategy definition remains the primary content: the explanation panel supports the builder
  and must not visually dominate it.

### Mobile composition

Mobile is a dedicated composition, not the desktop layout squeezed into a narrow viewport.

- Use one primary column.
- Present each BUY/SELL level and FINAL EXIT as a clear mobile-friendly section/card.
- Reflow `Metric / Condition / Value` and `Metric / Trigger / Value` controls according to available
  width; stacking is preferable to clipped or overly compressed selects.
- Contextual explanation that lives in the desktop right-hand panel should move close to the control
  it explains, typically directly below the active row or section.
- Longer help or the overall Strategy logic preview may use a compact expandable/collapsible surface
  lower in the flow when that avoids excessive vertical noise.
- Do not require horizontal scrolling to define or understand a Signal.
- Do not defer mobile behavior to a later cleanup task; desktop and mobile are both part of Strategy
  Builder acceptance.

### Continuity rule

A user familiar with the old product should recognize the Strategy Builder's colors, density,
select-driven interaction and explanatory behavior as the same product family. The V2 version should
feel cleaner and more deliberate, not like a completely unrelated generic form.

When the old repository and the V2 product/domain model conflict, **V2 wins**. Reuse the old
repository to answer questions such as visual hierarchy, interaction rhythm, responsive behavior and
help placement — never to override the Strategy semantics or dependency rules defined here and in
`AGENTS.md` / `ai/architecture/frontend.md`.
