import {
  ALTERNATIVE_DATA_COUNT_MAX,
  ALTERNATIVE_DATA_LOOKBACKS,
  alternativeDataMeasureDefinition,
  alternativeDataMeasures,
  alternativeDataMetricSignature,
  alternativeDataScope,
  buildAlternativeDataMetric,
  CONGRESS_CHAMBER_FILTERS,
  CONGRESS_OWNERS,
  defaultAlternativeDataMetric,
  describeAlternativeDataConfiguration,
  findAlternativeDataMeasure,
  INSIDER_ROLES,
  isAlternativeDataMetricKind,
  type ActorScope,
  type ActorScopeNames,
  type AlternativeDataLookback,
  type AlternativeDataMetric,
  type AlternativeDataMetricKind,
  type CongressActivityMetric,
  type CongressChamberFilter,
  type CongressMeasure,
  type CongressOwner,
  type InsiderActivityMetric,
  type InsiderMeasure,
  type InsiderRole,
} from "./alternative-data.js";
import type { ContentOwnershipResponse } from "./builtins.js";
import {
  findFundamentalMetric,
  FUNDAMENTAL_METRIC_CATALOG,
  FUNDAMENTAL_METRICS_LABEL,
  isFundamentalMetricId,
  type FundamentalMetricCatalogEntry,
  type FundamentalMetricId,
  type FundamentalMetricUnit,
} from "./fundamental-metrics.js";
import {
  comparableMovingAverages,
  findSelectableSeries,
  INTRINSIC_VALUE_SERIES,
  MOVING_AVERAGE_SERIES,
  OSCILLATOR_SERIES,
  PRICE_COMPARABLE_SERIES,
  type SelectableSeriesId,
  type SelectableSeriesSource,
} from "./selectable-series.js";

/**
 * The one canonical Strategy model: its types, its Metric/Condition/Trigger/Value compatibility
 * registry, its validator and its human-readable description primitives.
 *
 * `ai/product/strategies.md` is the product decision this file implements and
 * `ai/architecture/strategy-builder.md` is the accepted plan; neither is restated or reinterpreted
 * here. `AGENTS.md` invariant 11 requires the Strategy Builder and backend validation to share one
 * compatibility definition, which is why this lives in `@intrinsic/contracts`: it is the only
 * package the web app may depend on and it is equally available to the API and worker. A feature
 * must never keep a second matrix, operator list, label map or limit.
 *
 * Series identity stays owned by `selectable-series.ts`. This file references catalog ids and its
 * projections; it never restates the 24-entry catalog, and moving-average compatibility is read
 * from `comparableMovingAverages` rather than re-derived.
 *
 * Product vocabulary only: Metric, Condition, Trigger, Value. No left/right operand, no AST, no
 * compiler terminology reaches this contract.
 *
 * Deliberately absent: evaluation. Nothing here reads market data, position state or a date. What
 * a Signal *means* over historical data is designed in `ai/architecture/strategy-evaluation.md`.
 */

// ---------------------------------------------------------------------------
// Level kinds and percentages
// ---------------------------------------------------------------------------

export const STRATEGY_LEVEL_KINDS = ["BUY", "SELL", "FINAL_EXIT"] as const;

export type StrategyLevelKind = (typeof STRATEGY_LEVEL_KINDS)[number];

/** The one product label per level kind; no surface keeps a second map. */
export const STRATEGY_LEVEL_LABELS = {
  BUY: "BUY",
  SELL: "SELL",
  FINAL_EXIT: "FINAL EXIT",
} as const satisfies Record<StrategyLevelKind, string>;

/** Fraction of one full position. Position size itself is a backtest input, never a Strategy one. */
export const BUY_LEVEL_PERCENTAGES = [25, 50, 75, 100] as const;

/** Fraction of the position remaining at execution time. */
export const SELL_LEVEL_PERCENTAGES = [25, 50, 75] as const;

export type BuyLevelPercentage = (typeof BUY_LEVEL_PERCENTAGES)[number];
export type SellLevelPercentage = (typeof SELL_LEVEL_PERCENTAGES)[number];

// ---------------------------------------------------------------------------
// Metric / operator / Value
// ---------------------------------------------------------------------------

/**
 * The Relative Volume lookback periods a Strategy may name: exactly 10, 20 and 50 sessions.
 *
 * Product identity, stated here because `@intrinsic/contracts` is the only package the web app may
 * depend on — the same reason the selectable-series catalog lives here rather than in
 * `@intrinsic/domain`. The backend identities that are actually calculated and persisted stay in
 * `DAILY_RELATIVE_VOLUMES`, and `apps/api/src/stocks/selectable-series-catalog.test.ts` is the
 * drift guard between the two. Arbitrary or user-entered windows are deliberately not supported.
 */
export const RELATIVE_VOLUME_PERIODS = [10, 20, 50] as const;

export type RelativeVolumePeriod = (typeof RELATIVE_VOLUME_PERIODS)[number];

/**
 * The period a freshly selected Relative Volume Metric starts from.
 *
 * Unlike the derived defaults elsewhere in this file this one is a product choice: 20 sessions is
 * roughly a trading month and is the window the product presents as the ordinary reading.
 */
export const DEFAULT_RELATIVE_VOLUME_PERIOD: RelativeVolumePeriod = 20;

/** The one product label for a Relative Volume period. No surface keeps a second map. */
export function relativeVolumeLabel(period: RelativeVolumePeriod): string {
  return `RVOL ${period}`;
}

/**
 * A Strategy Metric.
 *
 * `Price` is the canonical end-of-day close and is deliberately not a catalog entry, so it is its
 * own kind. Moving averages and RSI are addressed through their **catalog ids**, never a parallel
 * enum. `Margin of Safety` is a first-class metric parameterized by the intrinsic-value source it
 * reads — never a comparison operator, and never a global valuation setting on the Strategy.
 *
 * `Relative Volume` is parameterized by its **period**, not by a catalog id, for the same reason
 * `Price` is not a catalog entry: it is not a selectable series. It is never drawn as a chart
 * overlay, never comparable with another series, and never a Strategy `Value` — Stock Details
 * reports it as a reading beside the volume bars. Its periods are the domain registry's, so the
 * three supported windows are stated once for the whole product.
 *
 * A **Fundamental Metric** is one kind for all fifteen, parameterized by the stable identity of the
 * product catalog (`fundamental-metrics.ts`). The identity is the whole of it: no label, group or
 * storage field is ever stored in the document, and there is no configuration to edit.
 */
export type StrategyMetric =
  | { kind: "PRICE" }
  | { kind: "MOVING_AVERAGE"; seriesId: SelectableSeriesId }
  | { kind: "OSCILLATOR"; seriesId: SelectableSeriesId }
  | { kind: "RELATIVE_VOLUME"; period: RelativeVolumePeriod }
  | { kind: "MARGIN_OF_SAFETY"; sourceId: SelectableSeriesId }
  | { kind: "FUNDAMENTAL"; metricId: FundamentalMetricId }
  | { kind: "GAIN" }
  | { kind: "LOSS" }
  /**
   * The alternative-data metrics, parameterized by a **measure plus configuration** rather than by
   * a catalog id or a single period: a lookback, and where the domain has actors, an actor scope
   * and its filters. `alternative-data.ts` owns those shapes; this union carries them so one
   * Condition row can hold any of them without a fourth control.
   */
  | InsiderActivityMetric
  | CongressActivityMetric;

export type StrategyMetricKind = StrategyMetric["kind"];

/** Canonical metric order, used to build the Builder's grouped option list. */
export const STRATEGY_METRIC_KINDS = [
  "PRICE",
  "MOVING_AVERAGE",
  "OSCILLATOR",
  "RELATIVE_VOLUME",
  "MARGIN_OF_SAFETY",
  "FUNDAMENTAL",
  "GAIN",
  "LOSS",
  "INSIDER_ACTIVITY",
  "CONGRESS_ACTIVITY",
] as const satisfies readonly StrategyMetricKind[];

/**
 * The right-hand side of a Condition or Trigger, in product vocabulary.
 *
 * `SERIES` compares against another canonical series; `NUMBER` is a plain user-entered threshold
 * (RSI); `PERCENT` is a user-entered percentage in percentage points (Margin of Safety, Gain, Loss,
 * the percentage Fundamental Metrics); `MULTIPLE` is a user-entered raw multiple (Relative Volume,
 * the ratio Fundamental Metrics). The distinction between them is a unit,
 * which is what lets one renderer print `30`, `25%` and `2x` without a per-metric formatting rule
 * in feature code.
 */
export type StrategyValue =
  | { kind: "SERIES"; seriesId: SelectableSeriesId }
  | { kind: "NUMBER"; value: number }
  | { kind: "PERCENT"; value: number }
  | { kind: "MULTIPLE"; value: number }
  /**
   * A currency amount, entered in the product's reporting currency.
   *
   * Its own kind rather than a `NUMBER` with a wide range, for the same reason `MULTIPLE` is: the
   * unit is what lets one renderer print `$1,000,000` where another prints `30` and `2x`, with no
   * per-metric formatting rule in feature code. It exists because the alternative-data value
   * measures are amounts of money — an insider's purchase value, a disclosed amount band's floor —
   * and reading one as a bare number would lose what it is.
   */
  | { kind: "MONEY"; value: number };

export type StrategyValueKind = StrategyValue["kind"];

/**
 * The Condition operators.
 *
 * `is above` and `is below` are the only comparisons, and they are **strict** — `>` and `<` — for
 * every metric (`ai/product/strategies.md` § Conditions). There is no inclusive form: on a
 * whole-number count "at least two insiders bought" is written `is above 1`, which says exactly the
 * same thing. `is close to` is not a comparison but a ±2% proximity state, and the registry offers it
 * to the price-scaled metrics only.
 */
export const CONDITION_OPERATORS = [
  "IS_ABOVE",
  "IS_BELOW",
  "IS_CLOSE_TO",
] as const;

export const TRIGGER_OPERATORS = ["CROSSES_ABOVE", "CROSSES_BELOW"] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];
export type TriggerOperator = (typeof TRIGGER_OPERATORS)[number];

/**
 * `is close to` means within 2% of the comparison value. It is a fixed product constant, never a
 * user-editable Strategy field: no Condition carries a tolerance, and the Builder explains the
 * fixed tolerance in help text instead of adding an input.
 */
export const IS_CLOSE_TO_TOLERANCE = 0.02;

// ---------------------------------------------------------------------------
// Signal, levels and the Strategy document
// ---------------------------------------------------------------------------

export type StrategyCondition = {
  id: string;
  metric: StrategyMetric;
  operator: ConditionOperator;
  value: StrategyValue;
};

export type StrategyTrigger = {
  id: string;
  metric: StrategyMetric;
  operator: TriggerOperator;
  value: StrategyValue;
};

/**
 * Zero or more Conditions, ANDed, plus at most one optional Trigger ANDed with them for the same
 * date.
 *
 * "At most one Trigger" is structural — a single optional field, not a runtime rule — so an
 * over-triggered Signal is unrepresentable rather than merely rejected.
 */
export type StrategySignal = {
  conditions: StrategyCondition[];
  trigger?: StrategyTrigger;
};

export type StrategyBuyLevel = {
  id: string;
  signal: StrategySignal;
  percentage: BuyLevelPercentage;
};

export type StrategySellLevel = {
  id: string;
  signal: StrategySignal;
  percentage: SellLevelPercentage;
};

/**
 * One alternative way FINAL EXIT can match: a Signal, with its own identity.
 *
 * A rule owns exactly one Signal, so the only structure the model can express is **OR of AND
 * groups**: Conditions AND inside a rule, rules OR across the action. There is no nested group, no
 * per-condition connector and no boolean expression tree — `A AND (B OR C)` is written as
 * `(A AND B) OR (A AND C)`, which the grammar already represents.
 */
export type StrategyExitRule = { id: string; signal: StrategySignal };

/**
 * FINAL EXIT: **one** action, reached by one or more alternative Exit Rules combined with OR.
 *
 * It carries no percentage at all — the type makes that product rule unrepresentable — and it
 * remains a single level with a single id, which is the identity a Monitor's durable state and a
 * backtest trade are keyed by. The rules are alternatives *within* that one action, never several
 * Final Exits: however many of them match on one date, the position closes once.
 */
export type StrategyFinalExit = { id: string; rules: StrategyExitRule[] };

/**
 * The persisted definition document's schema version.
 *
 * `1` described a FINAL EXIT as a single flat `signal`. `2` replaces that with `rules`, the ordered
 * list of alternatives. Version 1 documents are still read: `upgradeStrategyDefinitionDocument`
 * upcasts one to the equivalent single-rule version 2 document before anything validates it, so no
 * stored row is rewritten and no strategy changes meaning.
 */
export const STRATEGY_SCHEMA_VERSION = 2;

/** The version this file can still read and upcast. Never written. */
export const STRATEGY_LEGACY_SCHEMA_VERSION = 1;

/**
 * The versioned Strategy document: ordered BUY levels, ordered SELL levels and an optional
 * FINAL EXIT.
 *
 * Name and description are deliberately **not** here. They are Strategy identity rather than
 * signal logic, and keeping them out is what lets a rename avoid creating a new definition
 * version. `StrategyDraft` is the pair a user actually edits.
 *
 * There is no Stock List, initial capital, contribution, `maximumPositions`, fee or date-range
 * field, and no global intrinsic-value model. Those belong to a Backtest configuration; the
 * validator rejects them rather than ignoring them.
 */
export type StrategyDefinition = {
  schemaVersion: typeof STRATEGY_SCHEMA_VERSION;
  buyLevels: StrategyBuyLevel[];
  sellLevels: StrategySellLevel[];
  finalExit?: StrategyFinalExit;
};

/**
 * A complete Strategy as authored: identity fields plus the definition document.
 *
 * This is the shape `validateStrategy` expects and the shape the Strategy Builder saves, so the
 * two cannot drift.
 */
export type StrategyDraft = {
  name: string;
  description?: string;
  definition: StrategyDefinition;
};

/** Shared input limits, so the Builder and the API cannot disagree. */
export const STRATEGY_NAME_MAX_LENGTH = 120;
export const STRATEGY_DESCRIPTION_MAX_LENGTH = 500;
export const STRATEGY_MAX_BUY_LEVELS = 10;
export const STRATEGY_MAX_SELL_LEVELS = 10;
export const STRATEGY_MAX_CONDITIONS_PER_SIGNAL = 10;
/**
 * Alternatives inside one FINAL EXIT.
 *
 * The same bound as the BUY and SELL level lists, because it bounds the same thing: how many
 * independent ways one action can be reached.
 */
export const STRATEGY_MAX_EXIT_RULES = 10;

/** An empty definition: one that a user starts from, and that validation rejects until a BUY exists. */
export function emptyStrategyDefinition(): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [],
    sellLevels: [],
  };
}

// ---------------------------------------------------------------------------
// The one Metric / operator / Value compatibility registry
// ---------------------------------------------------------------------------

/**
 * The metric categories, in canonical order: the first of the Builder's two metric controls.
 *
 * A row is authored as Category -> Metric -> Configuration -> Condition -> Value. The category is
 * never stored: it is a property of the metric's kind (`strategyMetricCategory`), so a row can never
 * hold a category and a metric that disagree.
 *
 * `FUNDAMENTALS` follows `VALUATION`, keeping the two statement-derived families side by side while
 * staying a separate category: a fundamental measures the business alone, where a valuation compares
 * a statement-derived value with the market price (`docs/decisions/fundamental-metrics-v1.md`).
 */
export const STRATEGY_METRIC_CATEGORIES = [
  "PRICE",
  "MOVING_AVERAGES",
  "OSCILLATORS",
  "VOLUME",
  "VALUATION",
  "FUNDAMENTALS",
  "POSITION",
  "INSIDER_ACTIVITY",
  "CONGRESSIONAL_TRADING",
] as const;

export type StrategyMetricCategoryId =
  (typeof STRATEGY_METRIC_CATEGORIES)[number];

/**
 * The one product label per category.
 *
 * The top-level categorization is Strategy metadata the series catalog does not define, so it lives
 * here once. Inside a catalog-backed category the order is the catalog's own.
 */
export const STRATEGY_METRIC_CATEGORY_LABELS = {
  PRICE: "Price",
  MOVING_AVERAGES: "Moving averages",
  OSCILLATORS: "Oscillators",
  VOLUME: "Volume",
  VALUATION: "Valuation",
  FUNDAMENTALS: FUNDAMENTAL_METRICS_LABEL,
  POSITION: "Position",
  INSIDER_ACTIVITY: "Insider activity",
  CONGRESSIONAL_TRADING: "Congressional trading",
} as const satisfies Record<StrategyMetricCategoryId, string>;

/**
 * The permitted Values for one Metric.
 *
 * `min`/`max` are omitted where the metric has no bound on that side: Margin of Safety has no
 * lower bound and Gain has no upper one, and an invented bound would reject a legitimate rule. The
 * same holds for a multiple: Relative Volume and a leverage ratio of non-negative quantities have a
 * floor of zero, while Net Debt / EBITDA and Interest Coverage are signed and have none.
 */
export type StrategyValueSpec =
  | { kind: "SERIES"; seriesIds: readonly SelectableSeriesId[] }
  | {
      kind: "NUMBER";
      min: number;
      max: number;
      step: number;
      /**
       * The value must be a whole number.
       *
       * Set only where the metric counts discrete things: `Insider buyers is above 2.5` is not a
       * rule anybody means, while `RSI 14D is below 30.5` is perfectly ordinary. It is a property of
       * what the metric measures, so it is declared here and enforced by the one validator rather
       * than by an input's `step`.
       */
      integer?: true;
    }
  | { kind: "PERCENT"; min?: number; max?: number }
  | { kind: "MULTIPLE"; min?: number; max?: number; step: number }
  /** A currency amount. Non-negative, unbounded above: there is no largest real purchase. */
  | { kind: "MONEY"; min: number; max?: number; step: number };

type StrategyMetricDefinitionBase = {
  kind: StrategyMetricKind;
  /** Catalog-backed identities carry no label here; theirs comes from the catalog. */
  label?: string;
  category: StrategyMetricCategoryId;
  /**
   * The catalog ids this metric may be instantiated with: the moving averages, the RSI periods, or
   * the intrinsic-value sources a Margin of Safety metric can read. Absent for the metrics that
   * take no parameter.
   */
  parameterSeriesIds?: readonly SelectableSeriesId[];
  conditionOperators: readonly ConditionOperator[];
  /**
   * The Trigger operators this metric supports, or **empty** when it is not available as a Trigger
   * at all.
   *
   * Empty is a deliberate product statement, not an omission: Relative Volume is a Condition-only
   * metric. A Trigger is a crossing event, and the Monitor's own not-matched -> matched transition
   * already turns a Condition such as `RVOL 20 is above 2` into a signal on the session it first
   * holds — a `crosses above` operator for it would be a second, redundant way to say the same
   * thing, latched differently. The Builder does not offer the metric in a Trigger row, and
   * `validatePredicate` rejects a document that names it there.
   */
  triggerOperators: readonly TriggerOperator[];
  /** Also parameterizes an entry with something other than a catalog id; see `RELATIVE_VOLUME`. */
  allowedIn: readonly StrategyLevelKind[];
};

/**
 * One registry entry.
 *
 * The union is what makes per-instance Value resolution structural: a metric whose permitted
 * Values depend on the series it was instantiated with declares `valueSource` and has **no**
 * static `value` list to read by mistake. Every caller goes through `valueSpecFor`.
 */
export type StrategyMetricDefinition = StrategyMetricDefinitionBase &
  (
    | {
        /**
         * Values resolve through `comparableMovingAverages(seriesId)` — same timeframe, never the
         * series itself. That helper is the single source of this compatibility; nothing restates
         * it, and no compatibility is ever inferred from two series both being numeric.
         */
        valueSource: "COMPARABLE_MOVING_AVERAGES";
        value?: never;
      }
    | {
        /**
         * Values resolve from the selected **measure's own unit** — a count, an amount of money or a
         * percentage. The unit is a property of the measure, not of the metric kind, so
         * `Insider buyers` and `Insider purchase value` share a kind and take different Values.
         */
        valueSource: "ALTERNATIVE_DATA_MEASURE";
        value?: never;
      }
    | {
        /**
         * Values resolve from the selected Fundamental Metric's own catalog entry: its unit decides
         * `PERCENT` or `MULTIPLE`, and its mathematics any floor. The unit belongs to the metric, not
         * the kind, so `ROIC TTM` and `Debt / Equity` share a kind and take different Values.
         */
        valueSource: "FUNDAMENTAL_METRIC";
        value?: never;
      }
    | { valueSource?: undefined; value: StrategyValueSpec }
  );

const ALL_LEVEL_KINDS: readonly StrategyLevelKind[] = STRATEGY_LEVEL_KINDS;
const POSITION_LEVEL_KINDS: readonly StrategyLevelKind[] = [
  "SELL",
  "FINAL_EXIT",
];

/**
 * The strict comparison pair: every metric's Condition operators except the price-scaled ones,
 * which add `is close to`.
 *
 * `is close to` is a ±2% tolerance, which is meaningless on a unitless oscillator, on a count of two
 * insiders and arbitrary on an amount of money, so those metrics offer the comparison pair alone.
 */
const COMPARISON_OPERATORS: readonly ConditionOperator[] = [
  "IS_ABOVE",
  "IS_BELOW",
];
const PRICE_SCALE_CONDITION_OPERATORS: readonly ConditionOperator[] = [
  "IS_ABOVE",
  "IS_BELOW",
  "IS_CLOSE_TO",
];

function catalogIds(
  series: readonly { id: SelectableSeriesId }[],
): readonly SelectableSeriesId[] {
  return series.map((entry) => entry.id);
}

/**
 * The V1 compatibility matrix, transcribed from `ai/product/strategies.md` § Metric compatibility
 * table. No inference and no additions: a series becomes a usable Metric or Value only when that
 * document says so, and its operators and Value domain are a product decision there.
 */
export const STRATEGY_METRIC_DEFINITIONS: Record<
  StrategyMetricKind,
  StrategyMetricDefinition
> = {
  PRICE: {
    kind: "PRICE",
    label: "Price",
    category: "PRICE",
    conditionOperators: PRICE_SCALE_CONDITION_OPERATORS,
    triggerOperators: TRIGGER_OPERATORS,
    value: { kind: "SERIES", seriesIds: catalogIds(PRICE_COMPARABLE_SERIES) },
    allowedIn: ALL_LEVEL_KINDS,
  },
  MOVING_AVERAGE: {
    kind: "MOVING_AVERAGE",
    category: "MOVING_AVERAGES",
    parameterSeriesIds: catalogIds(MOVING_AVERAGE_SERIES),
    conditionOperators: PRICE_SCALE_CONDITION_OPERATORS,
    triggerOperators: TRIGGER_OPERATORS,
    valueSource: "COMPARABLE_MOVING_AVERAGES",
    allowedIn: ALL_LEVEL_KINDS,
  },
  OSCILLATOR: {
    kind: "OSCILLATOR",
    category: "OSCILLATORS",
    parameterSeriesIds: catalogIds(OSCILLATOR_SERIES),
    conditionOperators: COMPARISON_OPERATORS,
    triggerOperators: TRIGGER_OPERATORS,
    /**
     * `step` is the Builder's numeric input step, a presentation choice. The product bound is the
     * range itself — a threshold from 1 through 100, not restricted to conventional presets.
     */
    value: { kind: "NUMBER", min: 1, max: 100, step: 1 },
    allowedIn: ALL_LEVEL_KINDS,
  },
  /**
   * Relative Volume: today's session volume against the mean of the previous N sessions.
   *
   * Parameterized by period rather than by a catalog id, so it declares no `parameterSeriesIds`;
   * `strategyMetricOptions` instantiates one option per supported period.
   *
   * `triggerOperators` is empty **on purpose** — see the field's own documentation. The value is a
   * multiple with no upper bound (a news-day RVOL of 30 is real) and a floor of zero, which is the
   * value's own domain rather than an invented limit.
   */
  RELATIVE_VOLUME: {
    kind: "RELATIVE_VOLUME",
    label: "Relative Volume",
    category: "VOLUME",
    conditionOperators: COMPARISON_OPERATORS,
    triggerOperators: [],
    value: { kind: "MULTIPLE", min: 0, step: 0.1 },
    allowedIn: ALL_LEVEL_KINDS,
  },
  MARGIN_OF_SAFETY: {
    kind: "MARGIN_OF_SAFETY",
    label: "Margin of Safety",
    category: "VALUATION",
    parameterSeriesIds: catalogIds(INTRINSIC_VALUE_SERIES),
    conditionOperators: COMPARISON_OPERATORS,
    triggerOperators: TRIGGER_OPERATORS,
    /**
     * No lower bound: with a positive intrinsic value MOS is always below 100, and a negative
     * margin simply means price exceeds intrinsic value, which is a legitimate rule.
     */
    value: { kind: "PERCENT", max: 100 },
    allowedIn: ALL_LEVEL_KINDS,
  },
  /**
   * The fifteen Fundamental Metrics, one kind instantiated once per catalog entry by `instancesOf`.
   *
   * It carries no `label`: like the catalog-backed kinds, each instance is named by its own catalog
   * entry. Its Condition operators are the strict comparison pair — `is close to` is a ±2% tolerance
   * that belongs to the price-scaled metrics — and `triggerOperators` is empty because
   * `docs/decisions/fundamental-metrics-v1.md` makes fundamentals Condition metrics only: a value that
   * changes only when a statement is published is a state, and a Monitor's own not-matched -> matched
   * transition already raises a Signal on the session a Condition first holds. The Value comes from the
   * metric's unit — see `FUNDAMENTAL_METRIC` above.
   */
  FUNDAMENTAL: {
    kind: "FUNDAMENTAL",
    category: "FUNDAMENTALS",
    conditionOperators: COMPARISON_OPERATORS,
    triggerOperators: [],
    valueSource: "FUNDAMENTAL_METRIC",
    allowedIn: ALL_LEVEL_KINDS,
  },
  GAIN: {
    kind: "GAIN",
    label: "Gain",
    category: "POSITION",
    conditionOperators: COMPARISON_OPERATORS,
    triggerOperators: TRIGGER_OPERATORS,
    /** Signed, and unbounded above: a long position cannot lose more than its whole cost. */
    value: { kind: "PERCENT", min: -100 },
    allowedIn: POSITION_LEVEL_KINDS,
  },
  LOSS: {
    kind: "LOSS",
    label: "Loss",
    category: "POSITION",
    conditionOperators: COMPARISON_OPERATORS,
    triggerOperators: TRIGGER_OPERATORS,
    /** Non-negative by definition, clamped at zero, and capped by the position's own cost. */
    value: { kind: "PERCENT", min: 0, max: 100 },
    allowedIn: POSITION_LEVEL_KINDS,
  },
  /**
   * The two alternative-data kinds.
   *
   * They declare no `parameterSeriesIds` — neither is a catalog series — and each is instantiated
   * once per **measure** by `instancesOf`, so the Insider activity category offers `Insider buyers`,
   * `Insider sellers`, `Insider purchase value` and `Insider sale value` as four ordinary metrics.
   * The measure is the metric's identity; its lookback, scope and filters are **configuration**,
   * edited after selection, and never part of the metric's label or its selector entry.
   *
   * Their Condition operators are the strict comparison pair every non-price metric has.
   * `triggerOperators` is empty for both, exactly as it is for Relative Volume and for the same
   * reason: a disclosure count is a state, and a Monitor's own not-matched -> matched transition
   * already raises a Signal on the session `Insider buyers is above 1` first holds. A
   * `crosses above` form would be a second, differently latched way to say that.
   */
  INSIDER_ACTIVITY: {
    kind: "INSIDER_ACTIVITY",
    label: "Insider activity",
    category: "INSIDER_ACTIVITY",
    conditionOperators: COMPARISON_OPERATORS,
    triggerOperators: [],
    valueSource: "ALTERNATIVE_DATA_MEASURE",
    allowedIn: ALL_LEVEL_KINDS,
  },
  CONGRESS_ACTIVITY: {
    kind: "CONGRESS_ACTIVITY",
    label: "Congressional trading",
    category: "CONGRESSIONAL_TRADING",
    conditionOperators: COMPARISON_OPERATORS,
    triggerOperators: [],
    valueSource: "ALTERNATIVE_DATA_MEASURE",
    allowedIn: ALL_LEVEL_KINDS,
  },
};

/**
 * The alternative-data metric behind one Strategy Metric, or `undefined` for every other kind.
 *
 * The one narrowing accessor, so no caller reads `.measure` off a metric that has none.
 */
export function asAlternativeDataMetric(
  metric: StrategyMetric,
): AlternativeDataMetric | undefined {
  return isAlternativeDataMetricKind(metric.kind)
    ? (metric as AlternativeDataMetric)
    : undefined;
}

/** The permitted Values for one alternative-data measure's unit. */
function alternativeDataValueSpec(
  metric: AlternativeDataMetric,
): StrategyValueSpec {
  switch (alternativeDataMeasureDefinition(metric).unit) {
    case "COUNT":
      return {
        kind: "NUMBER",
        min: 0,
        max: ALTERNATIVE_DATA_COUNT_MAX,
        step: 1,
        integer: true,
      };
    case "MONEY":
      return { kind: "MONEY", min: 0, step: 1_000 };
  }
}

/**
 * The permitted Values for one Fundamental Metric: its unit's Value kind, floored where the metric's
 * own mathematics has a floor, and otherwise any finite number.
 *
 * A percentage is in percentage points exactly as the metric is stored — a rule set at 15% compares
 * with 15 — so there is no scaling anywhere between this spec and the evaluator. A multiple's `step`
 * is the Builder input's increment, the same presentation choice Relative Volume makes; validation
 * requires no step, so `Debt / Equity is below 0.75` is as valid as `0.8`.
 */
function fundamentalMetricValueSpec(
  entry: FundamentalMetricCatalogEntry,
): StrategyValueSpec {
  const floor = entry.minimum === undefined ? {} : { min: entry.minimum };
  switch (entry.unit) {
    case "PERCENT":
      return { kind: "PERCENT", ...floor };
    case "MULTIPLE":
      return { kind: "MULTIPLE", ...floor, step: 0.1 };
  }
}

/**
 * The catalog id a Metric is parameterized with, or `undefined` for the metrics that take none.
 *
 * One accessor so no caller switches on `seriesId` versus `sourceId` itself.
 */
export function strategyMetricSeriesId(
  metric: StrategyMetric,
): SelectableSeriesId | undefined {
  switch (metric.kind) {
    case "MOVING_AVERAGE":
    case "OSCILLATOR":
      return metric.seriesId;
    case "MARGIN_OF_SAFETY":
      return metric.sourceId;
    default:
      return undefined;
  }
}

/**
 * A Metric's **identity** as one string: kind plus whatever identifies it — a catalog id, a
 * Relative Volume period, an alternative-data measure.
 *
 * The select control needs one scalar per option, and two options must never collide. It lives
 * here rather than in the Builder so the encoding follows the metric union — adding a
 * period-parameterized kind is a change to one function, not to a component that happened to
 * assume every parameter was a catalog id.
 *
 * Configuration is deliberately **not** part of it. An alternative-data metric's lookback, scope and
 * filters are edited after the metric is chosen, so the identity — and the select option it
 * addresses — must be the same before and after: `Insider sellers` stays `Insider sellers` whether
 * it looks back 20 sessions or 180. `describeMetricConfiguration` is what renders the rest.
 *
 * Exhaustive over the metric kinds, with no fallback: a kind parameterized by something new must say
 * what identifies it here, or fail to compile. A fallback of `kind` plus a catalog id is exactly how
 * three Relative Volume periods — and would be how fifteen Fundamental Metrics — collapsed into one
 * option.
 */
export function strategyMetricKey(metric: StrategyMetric): string {
  switch (metric.kind) {
    case "INSIDER_ACTIVITY":
    case "CONGRESS_ACTIVITY":
      return `${metric.kind}:${metric.measure}`;
    case "RELATIVE_VOLUME":
      return `${metric.kind}:${metric.period}`;
    case "FUNDAMENTAL":
      return `${metric.kind}:${metric.metricId}`;
    case "MOVING_AVERAGE":
    case "OSCILLATOR":
      return `${metric.kind}:${metric.seriesId}`;
    case "MARGIN_OF_SAFETY":
      return `${metric.kind}:${metric.sourceId}`;
    case "PRICE":
    case "GAIN":
    case "LOSS":
      return `${metric.kind}:`;
  }
}

/**
 * The base label of a metric kind: `Price`, `Margin of Safety`, `Gain`, `Loss`. Catalog-backed
 * kinds have none of their own — theirs comes from the catalog entry they are instantiated with.
 */
function metricBaseLabel(kind: StrategyMetricKind): string {
  return STRATEGY_METRIC_DEFINITIONS[kind].label ?? kind;
}

export function strategyMetricDefinition(
  metric: StrategyMetric,
): StrategyMetricDefinition {
  return STRATEGY_METRIC_DEFINITIONS[metric.kind];
}

export function conditionOperatorsFor(
  metric: StrategyMetric,
): readonly ConditionOperator[] {
  return strategyMetricDefinition(metric).conditionOperators;
}

export function triggerOperatorsFor(
  metric: StrategyMetric,
): readonly TriggerOperator[] {
  return strategyMetricDefinition(metric).triggerOperators;
}

/**
 * The permitted Values for one Metric instance.
 *
 * The single entry point, and the only place per-instance resolution happens: a moving-average
 * Metric resolves through `comparableMovingAverages`, so a self-comparison or a daily-versus-weekly
 * pair can never be offered or accepted.
 *
 * The operator is deliberately not a parameter: in V1 no operator narrows a metric's Value domain,
 * and a parameter that is provably ignored would invite callers to believe otherwise.
 */
export function valueSpecFor(metric: StrategyMetric): StrategyValueSpec {
  const definition = strategyMetricDefinition(metric);
  if (definition.valueSource === "ALTERNATIVE_DATA_MEASURE") {
    const alternative = asAlternativeDataMetric(metric);
    return alternative
      ? alternativeDataValueSpec(alternative)
      : // Unreachable: the registry entry and the metric kind come from the same union.
        { kind: "NUMBER", min: 0, max: ALTERNATIVE_DATA_COUNT_MAX, step: 1 };
  }
  if (definition.valueSource === "COMPARABLE_MOVING_AVERAGES") {
    const seriesId = strategyMetricSeriesId(metric);
    return {
      kind: "SERIES",
      seriesIds: seriesId ? catalogIds(comparableMovingAverages(seriesId)) : [],
    };
  }
  if (definition.valueSource === "FUNDAMENTAL_METRIC") {
    const entry =
      metric.kind === "FUNDAMENTAL"
        ? findFundamentalMetric(metric.metricId)
        : undefined;
    return entry
      ? fundamentalMetricValueSpec(entry)
      : // Unreachable for a validated metric: an identity the catalog does not define is refused
        // before any Value is judged. A renderer of a drifted document still gets a spec, not a throw.
        { kind: "PERCENT" };
  }
  return definition.value;
}

/**
 * The operator a freshly added row starts from: the first one the metric's registry entry lists.
 *
 * Every metric declares at least one of each, which a registry-integrity test asserts, so the
 * fallbacks are unreachable. They live here rather than in the Builder so no surface has to know
 * an operator name to create a row.
 */
export function defaultConditionOperatorFor(
  metric: StrategyMetric,
): ConditionOperator {
  const [first] = conditionOperatorsFor(metric);
  return first ?? CONDITION_OPERATORS[0];
}

export function defaultTriggerOperatorFor(
  metric: StrategyMetric,
): TriggerOperator {
  const [first] = triggerOperatorsFor(metric);
  return first ?? TRIGGER_OPERATORS[0];
}

/**
 * The Value a freshly selected Metric starts from, or `undefined` when the metric permits none.
 *
 * Every default is derived rather than invented: the first permitted series in canonical catalog
 * order, the midpoint of a numeric metric's own range (50 for every RSI, its neutral line), or the
 * neutral zero of a percentage domain. None of them is a product-mandated preset.
 *
 * `undefined` is reachable only for a metric parameterized with a series that is not valid for it,
 * which validation rejects; it is returned rather than guessed so no caller silently receives a
 * comparison the registry does not permit.
 */
export function defaultValueFor(
  metric: StrategyMetric,
): StrategyValue | undefined {
  const spec = valueSpecFor(metric);
  // A count of disclosures has no neutral midpoint to take — the product bound on its threshold is
  // not a range the reading lives in. It starts at the floor of its unit instead, exactly as a money
  // threshold does below: with the default `is above`, `Insider buyers is above 0` reads "there was
  // any such activity at all", the smallest rule that says anything.
  if (
    spec.kind === "NUMBER" &&
    asAlternativeDataMetric(metric) !== undefined
  ) {
    return { kind: "NUMBER", value: spec.min };
  }
  switch (spec.kind) {
    case "SERIES": {
      const [first] = spec.seriesIds;
      return first ? { kind: "SERIES", seriesId: first } : undefined;
    }
    case "NUMBER": {
      // The neutral midpoint of the metric's own unit range — 50 for every RSI — read from the
      // catalog rather than chosen here, then held inside the product range.
      const series = findSelectableSeries(strategyMetricSeriesId(metric) ?? "");
      const range =
        series?.source.kind === "OSCILLATOR" ? series.source.range : spec;
      return {
        kind: "NUMBER",
        value: clampToSpec((range.min + range.max) / 2, spec.min, spec.max),
      };
    }
    case "PERCENT":
      return { kind: "PERCENT", value: clampToSpec(0, spec.min, spec.max) };
    case "MULTIPLE":
      // The neutral point of the unit itself: `1x` is a quantity exactly equal to what it is measured
      // against — a session trading its own baseline, debt equal to equity, current assets equal to
      // current liabilities. Derived from what the value means, not a product-mandated preset.
      return { kind: "MULTIPLE", value: clampToSpec(1, spec.min, spec.max) };
    case "MONEY":
      // The floor of the unit's own domain. A money threshold has no neutral point to derive — any
      // non-zero default would be a product-mandated preset nobody decided — so a fresh row starts
      // at zero and the user types the amount they mean.
      return { kind: "MONEY", value: clampToSpec(0, spec.min, spec.max) };
  }
}

function clampToSpec(value: number, min?: number, max?: number): number {
  if (min !== undefined && value < min) {
    return min;
  }
  if (max !== undefined && value > max) {
    return max;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Metric options
// ---------------------------------------------------------------------------

/**
 * One selectable Metric: a metric at its canonical default configuration, its identity label and
 * the category it belongs to.
 */
export type StrategyMetricOption = {
  metric: StrategyMetric;
  label: string;
  category: StrategyMetricCategoryId;
};

function instantiateMetric(
  kind: StrategyMetricKind,
  seriesId: SelectableSeriesId,
): StrategyMetric {
  switch (kind) {
    case "MOVING_AVERAGE":
      return { kind, seriesId };
    case "OSCILLATOR":
      return { kind, seriesId };
    case "MARGIN_OF_SAFETY":
      return { kind, sourceId: seriesId };
    case "RELATIVE_VOLUME":
      // Parameterized by period, not by a catalog id. `instancesOf` is what builds its instances;
      // reaching here would mean a caller passed a series id to a metric that takes none.
      throw new Error("Relative Volume is not parameterized by a series id");
    case "INSIDER_ACTIVITY":
    case "CONGRESS_ACTIVITY":
      // Parameterized by a measure plus configuration, never by a catalog id — the same situation
      // Relative Volume is in, and refused here for the same reason.
      throw new Error(
        `${kind} is not parameterized by a series id`,
      );
    case "FUNDAMENTAL":
      // Parameterized by a Fundamental Metric identity, never by a catalog series id.
      throw new Error("FUNDAMENTAL is not parameterized by a series id");
    case "PRICE":
      return { kind: "PRICE" };
    case "GAIN":
      return { kind: "GAIN" };
    case "LOSS":
      return { kind: "LOSS" };
  }
}

/**
 * Every instance of one metric kind, in canonical order.
 *
 * A kind is parameterized by a catalog id, by a period, or by nothing at all. Resolving that here
 * is what keeps `buildMetricOptions` from switching on the kind itself.
 */
function instancesOf(kind: StrategyMetricKind): readonly StrategyMetric[] {
  if (isAlternativeDataMetricKind(kind)) {
    // One option per measure, each at its own default configuration. The lookback, scope and filters
    // are configuration edited after selection, so the list stays as short as the number of things
    // the domain actually measures and never enumerates configuration permutations.
    return alternativeDataMeasures(kind).flatMap((measure) => {
      const metric = defaultAlternativeDataMetric(kind, measure);
      return metric ? [metric] : [];
    });
  }
  if (kind === "RELATIVE_VOLUME") {
    return RELATIVE_VOLUME_PERIODS.map((period) => ({ kind, period }));
  }
  if (kind === "FUNDAMENTAL") {
    // One option per catalog entry, in the catalog's flat canonical order — the order every flat
    // list of the metrics uses — and never a second ordering here. (A surface that shows the
    // groups reads the catalog's grouped view instead, with this order inside each group.)
    return FUNDAMENTAL_METRIC_CATALOG.map((entry) => ({
      kind,
      metricId: entry.id,
    }));
  }
  const definition = STRATEGY_METRIC_DEFINITIONS[kind];
  return definition.parameterSeriesIds
    ? definition.parameterSeriesIds.map((seriesId) =>
        instantiateMetric(kind, seriesId),
      )
    : [{ kind } as StrategyMetric];
}

/** Which half of a Signal a Metric is being chosen for. */
export const STRATEGY_PREDICATE_PARTS = ["CONDITION", "TRIGGER"] as const;
export type StrategyPredicatePart = (typeof STRATEGY_PREDICATE_PARTS)[number];

function buildMetricOptions(
  levelKind: StrategyLevelKind,
  part: StrategyPredicatePart,
): readonly StrategyMetricOption[] {
  const options: StrategyMetricOption[] = [];
  for (const category of STRATEGY_METRIC_CATEGORIES) {
    for (const kind of STRATEGY_METRIC_KINDS) {
      const definition = STRATEGY_METRIC_DEFINITIONS[kind];
      if (definition.category !== category) {
        continue;
      }
      if (!definition.allowedIn.includes(levelKind)) {
        continue;
      }
      // A metric with no Trigger operators is not offered as a Trigger. The registry answers it,
      // so no component filters the list and the validator enforces the same rule on the document.
      if (part === "TRIGGER" && definition.triggerOperators.length === 0) {
        continue;
      }
      for (const metric of instancesOf(kind)) {
        options.push({ metric, label: strategyMetricLabel(metric), category });
      }
    }
  }
  return options;
}

/**
 * One category of the Metric control, with the metrics it offers in one level kind and one half of a
 * Signal. A category with nothing to offer there is absent rather than empty.
 */
export type StrategyMetricCategory = {
  id: StrategyMetricCategoryId;
  label: string;
  options: readonly StrategyMetricOption[];
};

/** Consecutive options of one category, in the registry's own order — never a second ordering. */
function buildMetricCategories(
  options: readonly StrategyMetricOption[],
): readonly StrategyMetricCategory[] {
  const categories: {
    id: StrategyMetricCategoryId;
    options: StrategyMetricOption[];
  }[] = [];
  for (const option of options) {
    const last = categories[categories.length - 1];
    if (last && last.id === option.category) {
      last.options.push(option);
    } else {
      categories.push({ id: option.category, options: [option] });
    }
  }
  return categories.map((category) => ({
    id: category.id,
    label: STRATEGY_METRIC_CATEGORY_LABELS[category.id],
    options: category.options,
  }));
}

type MetricMenu = {
  readonly options: readonly StrategyMetricOption[];
  readonly categories: readonly StrategyMetricCategory[];
};

function buildMetricMenu(
  levelKind: StrategyLevelKind,
  part: StrategyPredicatePart,
): MetricMenu {
  const options = buildMetricOptions(levelKind, part);
  return { options, categories: buildMetricCategories(options) };
}

const METRIC_MENU_BY_LEVEL: Record<
  StrategyLevelKind,
  Record<StrategyPredicatePart, MetricMenu>
> = {
  BUY: {
    CONDITION: buildMetricMenu("BUY", "CONDITION"),
    TRIGGER: buildMetricMenu("BUY", "TRIGGER"),
  },
  SELL: {
    CONDITION: buildMetricMenu("SELL", "CONDITION"),
    TRIGGER: buildMetricMenu("SELL", "TRIGGER"),
  },
  FINAL_EXIT: {
    CONDITION: buildMetricMenu("FINAL_EXIT", "CONDITION"),
    TRIGGER: buildMetricMenu("FINAL_EXIT", "TRIGGER"),
  },
};

/**
 * Every Metric selectable in one level kind and one half of a Signal, in canonical category order.
 *
 * `Gain` and `Loss` are simply absent for BUY: they are position-dependent and no position exists
 * before the first buy. `Relative Volume` is simply absent for `TRIGGER`: it declares no Trigger
 * operators. No component filters this list further.
 */
export function strategyMetricOptions(
  levelKind: StrategyLevelKind,
  part: StrategyPredicatePart = "CONDITION",
): readonly StrategyMetricOption[] {
  return METRIC_MENU_BY_LEVEL[levelKind][part].options;
}

/**
 * The categories the Metric control offers in one level kind and one half of a Signal, each with its
 * metrics, in canonical order.
 *
 * The same options as {@link strategyMetricOptions}, partitioned: the Builder's first control lists
 * the categories and its second the chosen category's metrics, so no component groups, filters or
 * orders anything itself. A category with no metric there — `Position` in a BUY level, `Volume` in
 * a Trigger — is simply absent.
 */
export function strategyMetricCategories(
  levelKind: StrategyLevelKind,
  part: StrategyPredicatePart = "CONDITION",
): readonly StrategyMetricCategory[] {
  return METRIC_MENU_BY_LEVEL[levelKind][part].categories;
}

/** The category a metric belongs to: a property of its kind, never stored beside it. */
export function strategyMetricCategory(
  metric: StrategyMetric,
): StrategyMetricCategoryId {
  return STRATEGY_METRIC_DEFINITIONS[metric.kind].category;
}

/**
 * The metric a freshly created row, or a change of category, starts from: the first metric of the
 * given category — or of the first category when none is given — at its canonical default
 * configuration.
 *
 * `undefined` when the category offers nothing in that level kind and half of a Signal, so no caller
 * silently receives a metric the registry would not have offered there. Every level kind offers
 * `Price` in both halves, so the first category always has one.
 */
export function defaultStrategyMetric(
  levelKind: StrategyLevelKind,
  part: StrategyPredicatePart,
  category?: StrategyMetricCategoryId,
): StrategyMetric | undefined {
  const categories = strategyMetricCategories(levelKind, part);
  const chosen =
    category === undefined
      ? categories[0]
      : categories.find((candidate) => candidate.id === category);
  return chosen?.options[0]?.metric;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const CONDITION_OPERATOR_LABELS = {
  IS_ABOVE: "is above",
  IS_BELOW: "is below",
  IS_CLOSE_TO: "is close to",
} as const satisfies Record<ConditionOperator, string>;

export const TRIGGER_OPERATOR_LABELS = {
  CROSSES_ABOVE: "crosses above",
  CROSSES_BELOW: "crosses below",
} as const satisfies Record<TriggerOperator, string>;

export function conditionOperatorLabel(operator: ConditionOperator): string {
  return CONDITION_OPERATOR_LABELS[operator];
}

export function triggerOperatorLabel(operator: TriggerOperator): string {
  return TRIGGER_OPERATOR_LABELS[operator];
}

/**
 * The catalog's own label, or the raw id when the identifier is not a catalog series.
 *
 * Rendering never throws on a drifted document: the validator is what rejects an unknown id, and a
 * preview that crashed would hide the very rule the user needs to fix.
 */
function seriesLabel(id: SelectableSeriesId): string {
  return findSelectableSeries(id)?.label ?? id;
}

/**
 * The one Metric label: the metric's **identity**, never its configuration.
 *
 * For every catalog-backed identity it is `findSelectableSeries(id).label` and nothing else.
 * A source label can carry its own parentheses ("DCF (FCFF)"), so the source follows the product's
 * `·` separator — `Margin of Safety · DCF (FCFF)` — rather than nesting a second pair (UI-058). The
 * composition happens here, in one function: a composition of the catalog label, never a second
 * label map.
 *
 * An alternative-data metric is named by its measure alone — `Insider sellers` — because its
 * lookback, scope and filters are configuration a user edits after choosing it. A label that carried
 * the lookback would be a label a Configure change silently invalidates, which is how the selector
 * once read `20D` while the rule said `180D`. {@link describeMetricConfiguration} renders the
 * configuration, and every surface shows the two together.
 *
 * A Fundamental Metric is named by its catalog label alone — `ROIC TTM`, `Debt / Equity` — and never
 * by anything derived from its identity's spelling or its storage field.
 *
 * Exhaustive over the metric kinds: a new kind must name itself here or fail to compile, rather than
 * fall through to a label that is only its kind.
 */
export function strategyMetricLabel(metric: StrategyMetric): string {
  switch (metric.kind) {
    case "INSIDER_ACTIVITY":
    case "CONGRESS_ACTIVITY":
      return alternativeDataMeasureDefinition(metric).label;
    case "MOVING_AVERAGE":
    case "OSCILLATOR":
      return seriesLabel(metric.seriesId);
    case "RELATIVE_VOLUME":
      // One label for the whole product: the Strategy row, the preview and the Stock Details
      // chart legend all read `RVOL 20`.
      return relativeVolumeLabel(metric.period);
    case "MARGIN_OF_SAFETY":
      return `${metricBaseLabel("MARGIN_OF_SAFETY")} · ${seriesLabel(
        metric.sourceId,
      )}`;
    case "FUNDAMENTAL":
      // The raw identity for a drifted document, exactly as `seriesLabel` does: validation rejects it,
      // and a preview that threw would hide the rule that needs fixing.
      return findFundamentalMetric(metric.metricId)?.label ?? metric.metricId;
    case "PRICE":
    case "GAIN":
    case "LOSS":
      return metricBaseLabel(metric.kind);
  }
}

/**
 * A multiple's number, at least one decimal and never rounded.
 *
 * At least one decimal so `2` and `2.0` cannot read as two different thresholds; never rounded because
 * the text is the rule's canonical description — the preview, a trade reason and the Dashboard print
 * it — and a threshold of 0.75 printed `0.8x` would describe a different rule from the one evaluated.
 * Plain positional digits, never exponent notation: a tiny threshold reads `0.0000001x`, not `1e-7x`.
 */
function multipleText(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  if (Number.isInteger(value)) {
    return value.toFixed(1);
  }
  const shortest = String(value);
  return shortest.includes("e")
    ? value.toFixed(20).replace(/0+$/, "")
    : shortest;
}

export function strategyValueLabel(value: StrategyValue): string {
  switch (value.kind) {
    case "SERIES":
      return seriesLabel(value.seriesId);
    case "NUMBER":
      return String(value.value);
    case "PERCENT":
      return `${value.value}%`;
    case "MULTIPLE":
      // A multiple always reads with its unit: `2.0x`, `1.5x`, `0.75x`.
      return `${multipleText(value.value)}x`;
    case "MONEY":
      // Grouped, with no decimals: these are disclosure-scale amounts where a cent is noise, and a
      // reader comparing `$1,000,000` with `$250,000` needs the separators far more than the change.
      return Number.isFinite(value.value)
        ? `$${Math.round(value.value).toLocaleString("en-US")}`
        : `$${String(value.value)}`;
  }
}

// ---------------------------------------------------------------------------
// Human-readable description primitives
// ---------------------------------------------------------------------------

/**
 * One line of the Strategy logic preview.
 *
 * Structure, not one formatted string: the legacy builder generated a formula string and then
 * re-parsed it with regular expressions to humanize it. Generating structure once removes that
 * round trip and lets the UI tone each line by level kind.
 *
 * The preview is derived at render time and never persisted; a stored rendering would be a second
 * source of truth that goes stale the moment rendering changes.
 */
export type StrategyPreviewLine =
  | {
      kind: "LEVEL";
      levelKind: StrategyLevelKind;
      /** 1-based position among levels of the same kind. Absent for FINAL EXIT. */
      index?: number;
      /** Absent for FINAL EXIT, which has no percentage. */
      percentage?: number;
    }
  /**
   * The header of one FINAL EXIT Exit Rule, emitted **only when there is more than one**.
   *
   * A single-rule FINAL EXIT reads exactly as it always has — a heading and its rows — because
   * labelling a lone alternative "RULE 1" would name a choice the strategy does not offer.
   * `connector` is present on every rule after the first, and is what makes `(rule 1) OR (rule 2)`
   * legible rather than a run of separate FINAL EXIT actions.
   */
  | { kind: "EXIT_RULE"; index: number; connector?: "OR" }
  /**
   * One Condition as {@link StrategyPredicateDescription}: `text` is the metric's identity, the
   * operator and the Value, and `configuration` is the metric's configuration summary —
   * `180D · CEO, CFO`, `30D · Congress Watchlist · Senate` — present exactly when the metric has
   * configuration. The sidebar composes them exactly as {@link describeCondition} does.
   */
  | ({ kind: "CONDITION"; connector?: "AND" } & StrategyPredicateDescription)
  /** `connector` is present exactly when Conditions precede the Trigger it is ANDed with. */
  | ({ kind: "TRIGGER"; connector?: "AND" } & StrategyPredicateDescription)
  | { kind: "EMPTY"; levelKind: StrategyLevelKind };

/**
 * Every alternative-data metric one definition names, in document order.
 *
 * The one walk that answers "which actors and groups does this strategy reference?", and it is shared
 * by three callers that must never disagree: strategy validation resolving the references, a backtest
 * submission freezing the groups it names, and any surface resolving display names. Duplicates are
 * kept — the same configured metric may appear in several levels — and `collectActorGroupIds` is what
 * deduplicates.
 */
export function collectAlternativeDataMetrics(
  definition: StrategyDefinition,
): AlternativeDataMetric[] {
  const metrics: AlternativeDataMetric[] = [];
  const addSignal = (signal: StrategySignal): void => {
    const predicates: (StrategyCondition | StrategyTrigger)[] = [
      ...signal.conditions,
    ];
    if (signal.trigger) {
      predicates.push(signal.trigger);
    }
    for (const predicate of predicates) {
      const metric = asAlternativeDataMetric(predicate.metric);
      if (metric) {
        metrics.push(metric);
      }
    }
  };
  for (const level of definition.buyLevels) {
    addSignal(level.signal);
  }
  for (const level of definition.sellLevels) {
    addSignal(level.signal);
  }
  for (const rule of definition.finalExit?.rules ?? []) {
    addSignal(rule.signal);
  }
  return metrics;
}

/**
 * Display names for the actors and groups a definition references, keyed by identifier.
 *
 * A surface that has resolved them passes them in; one that has not renders the neutral fallback
 * (`Selected group`). Nothing here looks a name up, because the identifier is the identity and the
 * name is presentation — which is exactly what lets a completed backtest render the *snapshotted*
 * name from the same functions the Builder uses.
 */
export type StrategyScopeNames = {
  actors?: Readonly<Record<string, string>>;
  groups?: Readonly<Record<string, string>>;
};

function scopeNamesFor(
  scope: ActorScope | undefined,
  names: StrategyScopeNames | undefined,
): ActorScopeNames {
  if (!scope) {
    return {};
  }
  if (scope.kind === "ACTOR") {
    const actorName = names?.actors?.[scope.actorId];
    return actorName === undefined ? {} : { actorName };
  }
  if (scope.kind === "GROUP") {
    const groupName = names?.groups?.[scope.groupId];
    return groupName === undefined ? {} : { groupName };
  }
  return {};
}

/**
 * The configuration of one metric in words, or `null` when the metric takes none.
 *
 * Only the alternative-data metrics are configured, and their summary always leads with the lookback
 * — `180D`, `180D · CEO, CFO`, `30D · Congress Watchlist · Senate · Self, Spouse` — because the
 * lookback is configuration, not identity (`strategyMetricLabel` never carries it). This is the one
 * rendering of a metric's configuration: the condition row's summary line, the Strategy Logic
 * sidebar, the explanation panel, a backtest's trade reasons and the Dashboard all print this
 * string, so none of them can disagree with another about what a rule is configured to count.
 */
export function describeMetricConfiguration(
  metric: StrategyMetric,
  names?: StrategyScopeNames,
): string | null {
  const alternative = asAlternativeDataMetric(metric);
  if (!alternative) {
    return null;
  }
  return describeAlternativeDataConfiguration(
    alternative,
    scopeNamesFor(alternativeDataScope(alternative), names),
  );
}

/**
 * One Condition or Trigger in words, in its two parts.
 *
 * `text` is the metric's identity, the operator and the Value — `Insider sellers is above 2`.
 * `configuration` is {@link describeMetricConfiguration}, present exactly when the metric has any.
 * Kept apart so a surface can set the configuration in a quieter register; joined, they are exactly
 * {@link describeCondition} or {@link describeTrigger}.
 */
export type StrategyPredicateDescription = {
  text: string;
  configuration?: string;
};

function describePredicate(
  metric: StrategyMetric,
  operatorLabel: string,
  value: StrategyValue,
  names: StrategyScopeNames | undefined,
): StrategyPredicateDescription {
  const text = `${strategyMetricLabel(metric)} ${operatorLabel} ${strategyValueLabel(value)}`;
  const configuration = describeMetricConfiguration(metric, names);
  return configuration === null ? { text } : { text, configuration };
}

/**
 * The one-line form: the configuration follows the sentence in parentheses.
 *
 * Parentheses rather than a trailing dash because a sentence is also printed inside lists of
 * sentences — a Dashboard reason or a trade log joins its Conditions with "and" — and a
 * configuration carries its own comma list (`CEO, CFO`). Enclosed, it can never be read as part of
 * the list around it.
 */
function predicateSentence(description: StrategyPredicateDescription): string {
  return description.configuration === undefined
    ? description.text
    : `${description.text} (${description.configuration})`;
}

/**
 * One Condition as a single canonical sentence: `RSI 14D is below 30`,
 * `Insider sellers is above 2 (180D · CEO, CFO)`.
 *
 * `names` resolves an actor or group scope to its display name; without it the neutral fallback
 * (`Selected group`) is printed, which stays honest when a name is unavailable.
 */
export function describeCondition(
  condition: StrategyCondition,
  names?: StrategyScopeNames,
): string {
  return predicateSentence(
    describePredicate(
      condition.metric,
      conditionOperatorLabel(condition.operator),
      condition.value,
      names,
    ),
  );
}

/** One Trigger as a single canonical sentence, exactly as {@link describeCondition} words a Condition. */
export function describeTrigger(
  trigger: StrategyTrigger,
  names?: StrategyScopeNames,
): string {
  return predicateSentence(
    describePredicate(
      trigger.metric,
      triggerOperatorLabel(trigger.operator),
      trigger.value,
      names,
    ),
  );
}

function describeSignal(
  signal: StrategySignal,
  names?: StrategyScopeNames,
): StrategyPreviewLine[] {
  const lines: StrategyPreviewLine[] = signal.conditions.map(
    (condition, index) => ({
      kind: "CONDITION",
      ...(index === 0 ? {} : { connector: "AND" as const }),
      ...describePredicate(
        condition.metric,
        conditionOperatorLabel(condition.operator),
        condition.value,
        names,
      ),
    }),
  );
  if (signal.trigger) {
    // The Trigger is ANDed with the Conditions for the same date, so the preview keeps the
    // connector a reader would expect. A trigger-only Signal has nothing to join and carries none.
    lines.push({
      kind: "TRIGGER",
      ...(lines.length === 0 ? {} : { connector: "AND" as const }),
      ...describePredicate(
        signal.trigger.metric,
        triggerOperatorLabel(signal.trigger.operator),
        signal.trigger.value,
        names,
      ),
    });
  }
  return lines;
}

/**
 * The whole Strategy as ordered preview lines: BUY levels, then SELL levels, then FINAL EXIT.
 *
 * An incomplete level renders an explicit `EMPTY` line rather than vanishing, so the preview shows
 * what is missing instead of silently under-reporting the strategy. Output is deterministic: the
 * same definition always produces the same lines in the same order.
 *
 * FINAL EXIT emits **one** level header followed by its Exit Rules, so a reader sees one action
 * with alternatives rather than a sequence of Final Exits. With a single rule the shape is exactly
 * what it was before Exit Rules existed.
 */
export function describeStrategy(
  definition: StrategyDefinition,
  names?: StrategyScopeNames,
): readonly StrategyPreviewLine[] {
  const lines: StrategyPreviewLine[] = [];

  const appendLevel = (
    levelKind: StrategyLevelKind,
    signal: StrategySignal,
    index?: number,
    percentage?: number,
  ): void => {
    const header: StrategyPreviewLine = { kind: "LEVEL", levelKind };
    if (index !== undefined) {
      header.index = index;
    }
    if (percentage !== undefined) {
      header.percentage = percentage;
    }
    lines.push(header);
    const body = describeSignal(signal, names);
    if (body.length === 0) {
      lines.push({ kind: "EMPTY", levelKind });
      return;
    }
    lines.push(...body);
  };

  definition.buyLevels.forEach((level, index) => {
    appendLevel("BUY", level.signal, index + 1, level.percentage);
  });
  definition.sellLevels.forEach((level, index) => {
    appendLevel("SELL", level.signal, index + 1, level.percentage);
  });
  if (definition.finalExit) {
    // One FINAL EXIT heading, then its alternatives beneath it. The heading is never repeated: the
    // strategy has one Final Exit action however many ways there are to reach it.
    lines.push({ kind: "LEVEL", levelKind: "FINAL_EXIT" });
    const rules = definition.finalExit.rules;
    rules.forEach((rule, index) => {
      if (rules.length > 1) {
        lines.push(
          index === 0
            ? { kind: "EXIT_RULE", index: index + 1 }
            : { kind: "EXIT_RULE", index: index + 1, connector: "OR" },
        );
      }
      const body = describeSignal(rule.signal, names);
      if (body.length === 0) {
        lines.push({ kind: "EMPTY", levelKind: "FINAL_EXIT" });
        return;
      }
      lines.push(...body);
    });
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Product help metadata
// ---------------------------------------------------------------------------

/** One worked example: what was given, what the metric reports, and what that means. */
export type StrategyHelpExample = {
  given: string;
  result: string;
  meaning: string;
};

/**
 * Structured help for one Metric, operator or level kind.
 *
 * Content lives here, beside the registry and keyed by the same identities, so two surfaces can
 * never explain one metric differently. Feature code must not hold help strings for the same
 * reason it must not hold labels.
 *
 * Every entry describes **what a signal means**, never what an engine does with it: level
 * repetition, precedence between a partial SELL and FINAL EXIT, and candidate ordering are open
 * backtest decisions and must not appear here as established behaviour.
 */
export type StrategyHelpEntry = {
  summary: string;
  detail: string;
  /** Canonical formula in product vocabulary, where the metric has one. */
  formula?: string;
  examples?: readonly StrategyHelpExample[];
  notes?: readonly string[];
  /** When the predicate has no answer at all, and therefore never produces a signal. */
  notEvaluableWhen?: string;
};

const CLOSE_TO_PERCENT = `${IS_CLOSE_TO_TOLERANCE * 100}%`;

export const STRATEGY_METRIC_HELP: Record<
  StrategyMetricKind,
  StrategyHelpEntry
> = {
  PRICE: {
    summary: "The stock's end-of-day close.",
    detail:
      "Price compares with the canonical price-scaled series: the moving averages and the intrinsic-value models and blends. Oscillators are unitless and are never comparable with a price.",
    notEvaluableWhen:
      "There is no close for the date, or the compared series has no value yet.",
  },
  MOVING_AVERAGE: {
    summary:
      "A moving average of the close, used as a Metric in its own right.",
    detail:
      "A moving-average Metric compares only with the moving averages of the same timeframe, and never with itself. Daily-versus-weekly comparisons are not part of V1, so a daily average offers only daily averages as Values.",
    notes: [
      "Weekly averages use completed weeks only and are carried onto eligible daily dates.",
    ],
    notEvaluableWhen:
      "Either average is still inside its warm-up window and has no value for the date.",
  },
  OSCILLATOR: {
    summary: "Relative Strength Index over the selected period.",
    detail:
      "RSI compares with a threshold you type, anywhere from 1 to 100 — it is not restricted to conventional levels such as 30 or 70. RSI is unitless, so it is never compared with a price or with another series.",
    // Deliberately period-neutral. One help entry serves RSI 7D, RSI 14D and RSI 21D, so naming a
    // period here would show the wrong one beside two of the three metrics; the row itself already
    // names the selected series.
    examples: [
      {
        given: "the selected RSI is below 30",
        result: "true on every date it is under 30",
        meaning: "A state that can stay true for several days in a row.",
      },
      {
        given: "the selected RSI crosses above 30",
        result: "true only on the date it moves from 30 or below to above 30",
        meaning: "A single event, not a state.",
      },
    ],
    notEvaluableWhen:
      "The selected period is still warming up, so it has no RSI value for the date yet.",
  },
  RELATIVE_VOLUME: {
    summary:
      "How this session's volume compares with the average of the sessions before it.",
    detail:
      "Relative Volume is a multiple, not a percentage: 2.0x means the session traded twice its recent baseline. The baseline is the average volume of the previous 10, 20 or 50 trading sessions — the session being measured is never part of its own average, and sessions are counted, not calendar days. It is a condition only; a monitor already raises a signal on the session a condition first holds, so there is no separate crossing form.",
    formula:
      "RVOL(period) = Volume / average Volume of the previous `period` sessions",
    examples: [
      {
        given: "8.4M shares today, 3.6M average over the previous 20 sessions",
        result: "2.3x",
        meaning: "Unusually heavy trading for this stock.",
      },
      {
        given: "1.8M shares today, 3.6M average over the previous 20 sessions",
        result: "0.5x",
        meaning: "A quiet session: half the usual participation.",
      },
    ],
    notes: [
      "The three periods are fixed presets. A custom window is deliberately not offered.",
      "The baseline is this stock's own recent history, so 2.0x means the same thing for a mega-cap and for a small-cap.",
    ],
    notEvaluableWhen:
      "The full lookback of previous sessions does not exist yet, one of those sessions has no volume, or their average is zero.",
  },
  MARGIN_OF_SAFETY: {
    summary:
      "The discount of the price to the selected intrinsic-value source, as a percentage.",
    detail:
      "The intrinsic-value source is part of the Metric and the formula is fixed, so the rule stays three fields with nothing to configure. Each Margin of Safety metric reads only its own selected source, on that source's point-in-time series for the evaluated date.",
    formula:
      "Margin of Safety = (Intrinsic Value - Price) / Intrinsic Value * 100",
    examples: [
      {
        given: "Intrinsic Value 100, Price 75",
        result: "25%",
        meaning: "Positive: the price is below the intrinsic value.",
      },
      {
        given: "Intrinsic Value 100, Price 100",
        result: "0%",
        meaning: "The price is exactly at the intrinsic value.",
      },
      {
        given: "Intrinsic Value 100, Price 120",
        result: "-20%",
        meaning: "Negative: the price is above the intrinsic value.",
      },
    ],
    notes: [
      "The denominator is Intrinsic Value, never Price.",
      "Margin of Safety is not upside. With Intrinsic Value 100 and Price 75 the margin of safety is 25% while the upside is 33.33%, because upside divides by the price. The product exposes margin of safety.",
      "A negative threshold is a legitimate rule: it asks for a price above the intrinsic value.",
    ],
    notEvaluableWhen:
      "The point-in-time intrinsic value for the date is zero or negative. The ratio is undefined at zero and sign-inverted below it, so it is reported as not evaluable rather than as a large margin of safety.",
  },
  /**
   * The help all fifteen Fundamental Metrics share. `strategyMetricHelp` puts each metric's own
   * summary and formula, from its catalog entry, in front of it, so nothing here names one metric.
   */
  FUNDAMENTAL: {
    summary:
      "A measure of the business itself, calculated from the company's reported quarterly financial statements.",
    detail:
      "Every value is point-in-time: on each trading day it uses only the statements that were public by then, and it changes only on the first session after a new or revised statement became public. It is a condition only; a monitor already raises a signal on the session a condition first holds, so there is no crossing form.",
    notes: [
      "TTM is the latest four consecutive reported fiscal quarters, summed. A growth rate compares them with the four quarters immediately before, and an annual report never fills a missing quarter.",
      "An average balance-sheet figure is the mean of the balance sheet just before those four quarters and the one at their end.",
      "A negative reading is a real reading, such as a loss-making margin, and is compared like any other.",
    ],
    notEvaluableWhen:
      "The statements the metric needs cannot support a value on that date: a missing quarter or line item, a denominator that is not positive, statements in different currencies, a growth rate whose current or previous four-quarter total is not positive — a loss, or a turn between loss and profit — or Asset Turnover without positive revenue. It is then unavailable, never zero, and a condition on it never matches.",
  },
  GAIN: {
    summary:
      "How far the price is above the position's average cost, as a percentage.",
    detail:
      "Gain is signed: it is negative while the position is underwater. It depends on an open position, so it is available in SELL levels and FINAL EXIT and not in BUY levels.",
    formula: "Gain = (Price - AverageCost) / AverageCost * 100",
    examples: [
      {
        given: "Price 125, average cost 100",
        result: "25%",
        meaning: "The position is up a quarter on its cost.",
      },
      {
        given: "Price 85, average cost 100",
        result: "-15%",
        meaning: "Signed: the position is underwater.",
      },
    ],
    notEvaluableWhen: "There is no open position, so there is no average cost.",
  },
  LOSS: {
    summary:
      "How far the price is below the position's average cost, as a percentage.",
    detail:
      "Loss is clamped at zero rather than being an unclamped mirror of Gain, so `Loss is above 10%` reads exactly as expected: the price is more than 10% below the position's average cost. It depends on an open position, so it is available in SELL levels and FINAL EXIT and not in BUY levels.",
    formula: "Loss = max(0, (AverageCost - Price) / AverageCost * 100)",
    examples: [
      {
        given: "Price 85, average cost 100",
        result: "15%",
        meaning: "The price is 15% below the average cost.",
      },
      {
        given: "Price 125, average cost 100",
        result: "0%",
        meaning: "Clamped at zero while the position is profitable.",
      },
    ],
    notEvaluableWhen: "There is no open position, so there is no average cost.",
  },
  /**
   * One help entry serves all four insider measures, so nothing here names a particular one; the
   * row itself already says whether it is counting buyers or summing purchase value.
   */
  INSIDER_ACTIVITY: {
    summary:
      "What company insiders disclosed on Form 4 over the selected number of trading sessions.",
    detail:
      "Only actual open-market purchases and sales are counted. Awards, gifts, option exercises, conversions and shares withheld for tax are on the same form and are deliberately excluded: none of them is a decision to buy or sell at the market price. The window is measured on the session the filing became readable, not on the day of the trade — a backtest may only ever see what was already public — and a Form 4 is due within two business days, so in practice the two are days apart.",
    notes: [
      "Buyer and seller counts are distinct **people**: one insider filing three purchases counts once.",
      "Purchase and sale value sum share count times price, and a line the form prices at zero contributes nothing rather than zero dollars.",
      "A role filter is optional. Left alone, every insider counts.",
    ],
    notEvaluableWhen:
      "The full lookback window is not inside the disclosure history this product holds for the stock — before the earliest filing it has, or beyond the last time the data was refreshed.",
  },
  CONGRESS_ACTIVITY: {
    summary:
      "What members of Congress disclosed trading in this stock over the selected number of trading sessions.",
    detail:
      "House and Senate are one domain and both are included unless a chamber is selected. The window is measured on the session the disclosure became readable rather than on the transaction date, and for this domain the difference is large: a member has up to forty-five days to report a trade, so a window on the transaction date would find almost nothing while still looking correct. Both dates are preserved on every disclosure.",
    notes: [
      "Only common stock is counted. Bonds, options, funds and crypto are disclosed on the same filings, are kept, and are never counted as a share purchase.",
      "Disclosed amounts are **bands**, such as $15,001 - $50,000. A value measure sums the band's lower bound and is named for that; no midpoint is ever invented.",
      "Owner and chamber filters are optional. A filing that names no owner is counted by an unfiltered metric and never selected by an owner filter, because it has made no statement to filter on.",
    ],
    notEvaluableWhen:
      "The full lookback window is not inside the disclosure history this product holds for the stock.",
  },
};

/** How a Fundamental Metric's unit reads, as the note its explanation carries. */
const FUNDAMENTAL_UNIT_NOTES = {
  PERCENT:
    "Measured in percentage points: a rule set at 15% compares with 15, exactly as a reading of 15.42% is 15.42, and never with 0.15.",
  MULTIPLE:
    "A raw multiple, not a percentage: a rule set at 1.5x compares with 1.5, one and a half times.",
} as const satisfies Record<FundamentalMetricUnit, string>;

/**
 * The canonical help for one Metric instance.
 *
 * The entry of the metric's kind, except that a Fundamental Metric leads with its own summary and
 * formula from the product catalog and a note on its unit — one help entry for the kind would
 * otherwise describe ROIC and Debt / Equity in the same words. Every surface reads this, so the
 * explanation of a metric is never assembled in feature code.
 */
export function strategyMetricHelp(metric: StrategyMetric): StrategyHelpEntry {
  const shared = STRATEGY_METRIC_HELP[metric.kind];
  if (metric.kind !== "FUNDAMENTAL") {
    return shared;
  }
  const entry = findFundamentalMetric(metric.metricId);
  if (!entry) {
    return shared;
  }
  return {
    ...shared,
    summary: entry.summary,
    formula: entry.formula,
    notes: [FUNDAMENTAL_UNIT_NOTES[entry.unit], ...(shared.notes ?? [])],
  };
}

export const STRATEGY_OPERATOR_HELP: Record<
  ConditionOperator | TriggerOperator,
  StrategyHelpEntry
> = {
  IS_ABOVE: {
    summary: "A state: the metric is strictly greater than the value.",
    detail:
      "Conditions describe a state that can stay true for many days in a row. There is no `above or equal` variant: on a whole-number count, `at least 2` is written `is above 1`.",
    formula: "metric > value",
  },
  IS_BELOW: {
    summary: "A state: the metric is strictly less than the value.",
    detail:
      "Conditions describe a state that can stay true for many days in a row. There is no `below or equal` variant: on a whole-number count, `none at all` is written `is below 1`.",
    formula: "metric < value",
  },
  IS_CLOSE_TO: {
    summary: `A state: the metric is within ${CLOSE_TO_PERCENT} of the value.`,
    detail: `The ${CLOSE_TO_PERCENT} tolerance is a fixed product constant, not a field on the rule, which is why this row has no extra input. Like every Condition it is a state and may stay true for several days.`,
    formula: `abs(metric - value) / abs(value) <= ${IS_CLOSE_TO_TOLERANCE}`,
    notEvaluableWhen:
      "The comparison value is unavailable or cannot be used safely for the calculation.",
  },
  CROSSES_ABOVE: {
    summary:
      "An event: the metric was at or below the value and is now above it.",
    detail:
      "A Trigger is a transition, so it needs both the previous and the current eligible value. It is true on the single date the move happens, not for as long as the metric stays above.",
    formula: "metric[t] > value[t] AND metric[t-1] <= value[t-1]",
    examples: [
      {
        given: "Price is above EMA 50D",
        result: "false false true true true false",
        meaning: "A Condition stays true while the state holds.",
      },
      {
        given: "Price crosses above EMA 50D",
        result: "false false true false false false",
        meaning: "A Trigger fires once, on the date of the transition.",
      },
    ],
    notEvaluableWhen:
      "Either the current or the previous value is unavailable.",
  },
  CROSSES_BELOW: {
    summary:
      "An event: the metric was at or above the value and is now below it.",
    detail:
      "A Trigger is a transition, so it needs both the previous and the current eligible value. It is true on the single date the move happens, not for as long as the metric stays below.",
    formula: "metric[t] < value[t] AND metric[t-1] >= value[t-1]",
    notEvaluableWhen:
      "Either the current or the previous value is unavailable.",
  },
};

/**
 * What a level's percentage is a percentage *of*, in one canonical phrase per level kind.
 *
 * A BUY level's percentage is a fraction of one full position; a SELL level's is a fraction of the
 * position remaining at execution time. FINAL EXIT has no percentage and so has no basis. The
 * phrase lives here so the logic preview and any future surface cannot word it differently.
 */
export const STRATEGY_LEVEL_PERCENTAGE_BASIS = {
  BUY: "of a full position",
  SELL: "of the remaining position",
} as const satisfies Record<"BUY" | "SELL", string>;

export const STRATEGY_LEVEL_HELP: Record<StrategyLevelKind, StrategyHelpEntry> =
  {
    BUY: {
      summary: "Buys a fraction of one full position when its Signal matches.",
      detail:
        "The percentage is a fraction of one full position, not of the whole portfolio; how large a full position is comes from the backtest inputs. A BUY Signal may use only market-derived metrics, because Gain and Loss need a position that does not exist yet.",
    },
    SELL: {
      summary:
        "Sells a fraction of the position remaining at execution time when its Signal matches.",
      detail:
        "SELL Signals may use market-derived metrics and the position-dependent Gain and Loss. Two successive 50% partial sells leave a quarter of the original position.",
    },
    FINAL_EXIT: {
      summary: "Closes the entire remaining position when its Signal matches.",
      detail:
        "FINAL EXIT is a distinct concept rather than a `SELL 100%` level, so it has no percentage: keeping it separate is what lets reporting tell partial profit-taking apart from the condition that ends the position.",
    },
  };

/**
 * What a catalog series means when it is chosen as the comparison **Value**.
 *
 * A Value is the same object as a Metric wherever the product offers it as both, so the families
 * that have a Metric of their own are keyed straight back to that Metric's entry rather than
 * explained twice — `SMA 200D` says the same thing whichever side of the Condition it sits on.
 * The intrinsic-value families are the two that have no Metric of their own: `Margin of Safety`
 * consumes an intrinsic-value source rather than being one, so without these entries selecting
 * `Price is below <blend>` would have nothing canonical to say about the series it compares with.
 *
 * Keyed by the catalog's own `source.kind`, so one entry serves a whole family and no series is
 * named in text shared by all of them.
 */
export const STRATEGY_VALUE_SERIES_HELP: Record<
  SelectableSeriesSource["kind"],
  StrategyHelpEntry
> = {
  MOVING_AVERAGE: STRATEGY_METRIC_HELP.MOVING_AVERAGE,
  OSCILLATOR: STRATEGY_METRIC_HELP.OSCILLATOR,
  INTRINSIC_VALUE_BLEND: {
    summary:
      "A weighted combination of the intrinsic-value models, as a value per share.",
    detail:
      "A blend is on the price scale, so it compares with Price. Its weights are a versioned product definition rather than something a rule configures, and the comparison is point-in-time: the blend's value as it stood on the evaluated date.",
    notEvaluableWhen:
      "The blend has no point-in-time value for the date, because a model it is composed of has none.",
  },
  INTRINSIC_VALUE_MODEL: {
    summary: "One intrinsic-value model on its own, as a value per share.",
    detail:
      "A model is on the price scale, so it compares with Price. Comparing against a single model rather than a blend is a deliberately narrower rule: it answers to that one method and to nothing else, on that model's point-in-time series for the evaluated date.",
    notEvaluableWhen: "The model has no point-in-time value for the date.",
  },
};

/**
 * The canonical help for one catalog series, or `undefined` when the id is not a catalog entry.
 *
 * The one accessor a surface needs to explain a `SERIES` Value. A numeric or percentage Value has
 * no entry and never gets one: a threshold the user typed explains itself, and inventing prose for
 * it would be help text with no canonical source.
 */
export function strategySeriesHelp(
  seriesId: SelectableSeriesId,
): StrategyHelpEntry | undefined {
  const entry = findSelectableSeries(seriesId);
  return entry ? STRATEGY_VALUE_SERIES_HELP[entry.source.kind] : undefined;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const STRATEGY_VALIDATION_CODES = [
  "SHAPE_INVALID",
  "UNKNOWN_FIELD",
  "NAME_REQUIRED",
  "NAME_TOO_LONG",
  "DESCRIPTION_TOO_LONG",
  "BUY_LEVEL_REQUIRED",
  "TOO_MANY_LEVELS",
  "TOO_MANY_CONDITIONS",
  "SIGNAL_EMPTY",
  "EXIT_RULE_REQUIRED",
  "TOO_MANY_EXIT_RULES",
  "DUPLICATE_EXIT_RULE",
  "PERCENTAGE_INVALID",
  "METRIC_NOT_ALLOWED_IN_LEVEL",
  "METRIC_SERIES_UNSUPPORTED",
  /** A metric parameterized by something other than a catalog id named an unsupported parameter. */
  "METRIC_PERIOD_UNSUPPORTED",
  /** A Fundamental Metric named an identity the product catalog does not define. */
  "FUNDAMENTAL_METRIC_UNSUPPORTED",
  /** The metric exists, but not in the part of a Signal the document used it in. */
  "METRIC_NOT_ALLOWED_IN_PART",
  "OPERATOR_NOT_SUPPORTED",
  "VALUE_KIND_MISMATCH",
  "VALUE_OUT_OF_DOMAIN",
  "SERIES_UNKNOWN",
  "SERIES_NOT_COMPARABLE",
  "DUPLICATE_CONDITION",
  "DUPLICATE_ID",
  /** An alternative-data metric named a measure its domain does not define. */
  "MEASURE_UNSUPPORTED",
  /** A lookback outside the closed preset list. */
  "LOOKBACK_UNSUPPORTED",
  /** An actor scope was malformed, or named on a metric kind that has no scope. */
  "SCOPE_INVALID",
  /** A chamber, owner or role filter named a value the product does not define. */
  "FILTER_INVALID",
] as const;

export type StrategyValidationCode = (typeof STRATEGY_VALIDATION_CODES)[number];

export type StrategyIssuePart =
  | "STRATEGY"
  | "NAME"
  | "DESCRIPTION"
  | "LEVEL"
  /** One FINAL EXIT Exit Rule, as a whole. */
  | "EXIT_RULE"
  | "PERCENTAGE"
  | "CONDITION"
  | "TRIGGER";

export type StrategyIssueField = "METRIC" | "OPERATOR" | "VALUE";

/**
 * Where an issue belongs.
 *
 * The path is the load-bearing part: it is what lets one validator drive both the inline field
 * errors in the Builder and the API's 400 body, with no second mapping. `levelKind` is absent for
 * the strategy-scope issues that belong to no level, such as the name.
 */
export type StrategyIssuePath = {
  levelKind?: StrategyLevelKind;
  /** Absent for FINAL EXIT, which is a single level, and for strategy-scope issues. */
  levelIndex?: number;
  /**
   * Which Exit Rule inside FINAL EXIT, 0-based. Present only under `FINAL_EXIT`, and absent on the
   * issues that belong to FINAL EXIT as a whole — an empty or over-long rule list.
   */
  ruleIndex?: number;
  part: StrategyIssuePart;
  conditionIndex?: number;
  field?: StrategyIssueField;
};

export type StrategyValidationIssue = {
  code: StrategyValidationCode;
  path: StrategyIssuePath;
  /** User-facing, product vocabulary only. */
  message: string;
};

/** Thrown by the normalizers; carries the same issues the non-throwing validator returns. */
export class StrategyValidationError extends Error {
  readonly issues: readonly StrategyValidationIssue[];

  constructor(issues: readonly StrategyValidationIssue[]) {
    super(issues[0]?.message ?? "The strategy is not valid");
    this.name = "StrategyValidationError";
    this.issues = issues;
  }
}

const STRATEGY_KEYS = ["name", "description", "definition"] as const;
const DEFINITION_KEYS = [
  "schemaVersion",
  "buyLevels",
  "sellLevels",
  "finalExit",
] as const;
const LEVEL_KEYS = ["id", "signal", "percentage"] as const;
const FINAL_EXIT_KEYS = ["id", "rules"] as const;
const EXIT_RULE_KEYS = ["id", "signal"] as const;
const SIGNAL_KEYS = ["conditions", "trigger"] as const;
const PREDICATE_KEYS = ["id", "metric", "operator", "value"] as const;

const METRIC_KEYS: Record<StrategyMetricKind, readonly string[]> = {
  PRICE: ["kind"],
  MOVING_AVERAGE: ["kind", "seriesId"],
  OSCILLATOR: ["kind", "seriesId"],
  RELATIVE_VOLUME: ["kind", "period"],
  MARGIN_OF_SAFETY: ["kind", "sourceId"],
  // The identity and nothing else: a label, group, unit or storage field smuggled beside it is refused.
  FUNDAMENTAL: ["kind", "metricId"],
  GAIN: ["kind"],
  LOSS: ["kind"],
  INSIDER_ACTIVITY: ["kind", "measure", "lookback", "roles"],
  CONGRESS_ACTIVITY: [
    "kind",
    "measure",
    "lookback",
    "scope",
    "chamber",
    "owners",
  ],
};

const VALUE_KEYS: Record<StrategyValueKind, readonly string[]> = {
  SERIES: ["kind", "seriesId"],
  NUMBER: ["kind", "value"],
  PERCENT: ["kind", "value"],
  MULTIPLE: ["kind", "value"],
  MONEY: ["kind", "value"],
};

const ACTOR_SCOPE_KEYS: Record<ActorScope["kind"], readonly string[]> = {
  ANY: ["kind"],
  ACTOR: ["kind", "actorId"],
  GROUP: ["kind", "groupId"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function issuePath(input: StrategyIssuePath): StrategyIssuePath {
  return {
    ...(input.levelKind !== undefined ? { levelKind: input.levelKind } : {}),
    ...(input.levelIndex !== undefined ? { levelIndex: input.levelIndex } : {}),
    ...(input.ruleIndex !== undefined ? { ruleIndex: input.ruleIndex } : {}),
    part: input.part,
    ...(input.conditionIndex !== undefined
      ? { conditionIndex: input.conditionIndex }
      : {}),
    ...(input.field !== undefined ? { field: input.field } : {}),
  };
}

/** Where a level's rows live, so a predicate never rebuilds the level part of its own path. */
type PredicateLocation = {
  levelKind: StrategyLevelKind;
  levelIndex?: number;
  ruleIndex?: number;
  part: "CONDITION" | "TRIGGER";
  conditionIndex?: number;
};

function predicatePath(
  location: PredicateLocation,
  field?: StrategyIssueField,
): StrategyIssuePath {
  return issuePath({ ...location, field });
}

function boundsText(min?: number, max?: number): string {
  if (min !== undefined && max !== undefined) {
    return `between ${min} and ${max}`;
  }
  if (min !== undefined) {
    return `of ${min} or more`;
  }
  if (max !== undefined) {
    return `of ${max} or less`;
  }
  return "that is a finite number";
}

const BACKTEST_FIELD_HINT =
  "A stock list, capital, contributions, maximum positions and the backtest date range belong to a backtest configuration, not to a strategy.";

/**
 * The state of one validation pass: the issues found so far, and the ids already claimed.
 *
 * Ids are checked across the **whole definition** rather than within one level, because they are
 * persisted and are what future per-level diagnostics and evaluator references address. Levels,
 * Exit Rules and predicates keep separate namespaces: a level and a condition sharing a string are
 * addressing different things and never collide. The separation is load-bearing for backwards
 * compatibility — upcasting a version 1 FINAL EXIT reuses the level's own id for the single Exit
 * Rule it becomes, which is the only id derivable from the stored document without inventing one.
 */
class ValidationContext {
  readonly issues: StrategyValidationIssue[] = [];
  private readonly levelIds = new Set<string>();
  private readonly exitRuleIds = new Set<string>();
  private readonly predicateIds = new Set<string>();

  /**
   * Records `id` in one namespace, reporting the **later** occurrence when it is already taken.
   * A duplicate is never regenerated or dropped: two rows claiming one identity is a real
   * ambiguity, and silently re-keying one of them would move the user's rule somewhere they did
   * not put it.
   */
  claimId(
    namespace: "LEVEL" | "EXIT_RULE" | "PREDICATE",
    id: string,
    path: StrategyIssuePath,
    what: string,
  ): void {
    const taken =
      namespace === "LEVEL"
        ? this.levelIds
        : namespace === "EXIT_RULE"
          ? this.exitRuleIds
          : this.predicateIds;
    if (taken.has(id)) {
      this.add(
        "DUPLICATE_ID",
        path,
        `Another ${what} already uses the identifier \`${id}\`.`,
      );
      return;
    }
    taken.add(id);
  }

  add(
    code: StrategyValidationCode,
    path: StrategyIssuePath,
    message: string,
  ): void {
    this.issues.push({ code, path, message });
  }

  rejectUnknownKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
    path: StrategyIssuePath,
    hint?: string,
  ): void {
    for (const key of unknownKeys(value, allowed)) {
      this.add(
        "UNKNOWN_FIELD",
        path,
        `\`${key}\` is not part of a strategy.${hint ? ` ${hint}` : ""}`,
      );
    }
  }
}

/**
 * Validates one alternative-data metric's measure and configuration.
 *
 * Every parameter set is **closed**: the measure must be one its domain defines, the lookback must
 * be a preset, a scope must be one of the three shapes, and every filter value must be a known enum
 * member. An unrecognized value is refused rather than dropped, because silently discarding a filter
 * widens a rule the user deliberately narrowed — a strategy that was "Senate only" would quietly
 * start counting the House.
 *
 * A scope on a kind that has none is refused for the same reason: `UNKNOWN_FIELD` would be reported
 * by the key check, but a metric carrying a scope the evaluator ignores is a rule that does not mean
 * what it says.
 */
function parseAlternativeDataMetric(
  kind: AlternativeDataMetricKind,
  raw: Record<string, unknown>,
  path: StrategyIssuePath,
  issues: ValidationContext,
): AlternativeDataMetric | undefined {
  const rawMeasure = raw.measure;
  if (
    typeof rawMeasure !== "string" ||
    !findAlternativeDataMeasure(kind, rawMeasure)
  ) {
    issues.add(
      "MEASURE_UNSUPPORTED",
      path,
      `\`${String(rawMeasure)}\` is not a ${STRATEGY_METRIC_CATEGORY_LABELS[
        STRATEGY_METRIC_DEFINITIONS[kind].category
      ].toLowerCase()} measure.`,
    );
    return undefined;
  }

  const rawLookback = raw.lookback;
  if (
    typeof rawLookback !== "number" ||
    !(ALTERNATIVE_DATA_LOOKBACKS as readonly number[]).includes(rawLookback)
  ) {
    issues.add(
      "LOOKBACK_UNSUPPORTED",
      path,
      `A lookback must be one of the ${ALTERNATIVE_DATA_LOOKBACKS.join(", ")} session windows.`,
    );
    return undefined;
  }
  const lookback = rawLookback as AlternativeDataLookback;

  if (kind === "INSIDER_ACTIVITY") {
    const roles = parseEnumFilter(
      raw.roles,
      INSIDER_ROLES,
      "insider role",
      path,
      issues,
    );
    if (roles === "INVALID") {
      return undefined;
    }
    return {
      kind,
      measure: rawMeasure as InsiderMeasure,
      lookback,
      ...(roles === undefined ? {} : { roles: roles as InsiderRole[] }),
    };
  }

  const scope = parseActorScope(raw.scope, path, issues);
  if (!scope) {
    return undefined;
  }

  const rawChamber = raw.chamber;
  if (
    typeof rawChamber !== "string" ||
    !(CONGRESS_CHAMBER_FILTERS as readonly string[]).includes(rawChamber)
  ) {
    issues.add(
      "FILTER_INVALID",
      path,
      `A chamber must be one of ${CONGRESS_CHAMBER_FILTERS.join(", ")}.`,
    );
    return undefined;
  }
  const owners = parseEnumFilter(
    raw.owners,
    CONGRESS_OWNERS,
    "disclosed owner",
    path,
    issues,
  );
  if (owners === "INVALID") {
    return undefined;
  }
  return {
    kind,
    measure: rawMeasure as CongressMeasure,
    lookback,
    scope,
    chamber: rawChamber as CongressChamberFilter,
    ...(owners === undefined ? {} : { owners: owners as CongressOwner[] }),
  };
}

/**
 * Reads an optional enum filter list.
 *
 * `undefined` means "no filter", which is different from an empty list: an empty list is a filter
 * that admits nothing, and a metric that can never match is always a mistake rather than something
 * to normalize away.
 */
function parseEnumFilter(
  raw: unknown,
  allowed: readonly string[],
  noun: string,
  path: StrategyIssuePath,
  issues: ValidationContext,
): readonly string[] | undefined | "INVALID" {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.add(
      "FILTER_INVALID",
      path,
      `A ${noun} filter must list at least one value; leave it out to include every ${noun}.`,
    );
    return "INVALID";
  }
  const values: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !allowed.includes(entry)) {
      issues.add(
        "FILTER_INVALID",
        path,
        `\`${String(entry)}\` is not a ${noun} this product recognizes.`,
      );
      return "INVALID";
    }
    if (!values.includes(entry)) {
      values.push(entry);
    }
  }
  return values;
}

function parseActorScope(
  raw: unknown,
  path: StrategyIssuePath,
  issues: ValidationContext,
): ActorScope | undefined {
  if (!isRecord(raw)) {
    issues.add("SCOPE_INVALID", path, "Choose whose activity this rule counts.");
    return undefined;
  }
  const kind = raw.kind;
  if (kind !== "ANY" && kind !== "ACTOR" && kind !== "GROUP") {
    issues.add(
      "SCOPE_INVALID",
      path,
      `\`${String(kind)}\` is not a kind of scope.`,
    );
    return undefined;
  }
  issues.rejectUnknownKeys(raw, ACTOR_SCOPE_KEYS[kind], path);
  if (kind === "ANY") {
    return { kind: "ANY" };
  }
  const idField = kind === "ACTOR" ? "actorId" : "groupId";
  const id = raw[idField];
  if (typeof id !== "string" || id.trim().length === 0) {
    issues.add(
      "SCOPE_INVALID",
      path,
      kind === "ACTOR"
        ? "Choose the actor this rule counts."
        : "Choose the group this rule counts.",
    );
    return undefined;
  }
  return kind === "ACTOR"
    ? { kind: "ACTOR", actorId: id }
    : { kind: "GROUP", groupId: id };
}

function parseMetric(
  raw: unknown,
  location: PredicateLocation,
  levelKind: StrategyLevelKind,
  issues: ValidationContext,
): StrategyMetric | undefined {
  const path = predicatePath(location, "METRIC");
  if (!isRecord(raw)) {
    issues.add("SHAPE_INVALID", path, "Choose a metric for this rule.");
    return undefined;
  }
  const rawKind = raw.kind;
  if (
    typeof rawKind !== "string" ||
    !(STRATEGY_METRIC_KINDS as readonly string[]).includes(rawKind)
  ) {
    issues.add(
      "SHAPE_INVALID",
      path,
      `\`${String(rawKind)}\` is not a strategy metric.`,
    );
    return undefined;
  }
  const kind = rawKind as StrategyMetricKind;
  issues.rejectUnknownKeys(raw, METRIC_KEYS[kind], path);

  const definition = STRATEGY_METRIC_DEFINITIONS[kind];
  if (!definition.allowedIn.includes(levelKind)) {
    issues.add(
      "METRIC_NOT_ALLOWED_IN_LEVEL",
      path,
      `${metricBaseLabel(kind)} is not available in a ${STRATEGY_LEVEL_LABELS[levelKind]} level.${
        definition.category === "POSITION"
          ? " It depends on an open position."
          : ""
      }`,
    );
    return undefined;
  }

  switch (kind) {
    case "PRICE":
      return { kind: "PRICE" };
    case "GAIN":
      return { kind: "GAIN" };
    case "LOSS":
      return { kind: "LOSS" };
    case "RELATIVE_VOLUME": {
      // Parameterized by period rather than by a catalog id, and the period list is closed: an
      // arbitrary window is refused here rather than silently rounded to a supported one.
      const period = raw.period;
      if (
        typeof period !== "number" ||
        !(RELATIVE_VOLUME_PERIODS as readonly number[]).includes(period)
      ) {
        issues.add(
          "METRIC_PERIOD_UNSUPPORTED",
          path,
          `${metricBaseLabel("RELATIVE_VOLUME")} supports only the ${RELATIVE_VOLUME_PERIODS.join(", ")} session periods.`,
        );
        return undefined;
      }
      return { kind: "RELATIVE_VOLUME", period: period as RelativeVolumePeriod };
    }
    case "FUNDAMENTAL": {
      // The identity must be one the product catalog defines, matched exactly. Stored and submitted
      // documents are runtime data, so the type alone proves nothing: a lower-cased identity, a label
      // or a storage field is refused rather than normalized into the metric it resembles.
      const metricId = raw.metricId;
      if (!isFundamentalMetricId(metricId)) {
        issues.add(
          "FUNDAMENTAL_METRIC_UNSUPPORTED",
          path,
          `\`${String(metricId)}\` is not a fundamental metric this product offers.`,
        );
        return undefined;
      }
      return { kind: "FUNDAMENTAL", metricId };
    }
    case "INSIDER_ACTIVITY":
    case "CONGRESS_ACTIVITY":
      return parseAlternativeDataMetric(kind, raw, path, issues);
    default:
      break;
  }

  const parameterSeriesIds = definition.parameterSeriesIds ?? [];
  const rawSeriesId = kind === "MARGIN_OF_SAFETY" ? raw.sourceId : raw.seriesId;
  if (typeof rawSeriesId !== "string") {
    issues.add("SHAPE_INVALID", path, "Choose a metric for this rule.");
    return undefined;
  }
  if (!findSelectableSeries(rawSeriesId)) {
    issues.add(
      "SERIES_UNKNOWN",
      path,
      `\`${rawSeriesId}\` is not a series this product offers.`,
    );
    return undefined;
  }
  const seriesId = rawSeriesId as SelectableSeriesId;
  if (!parameterSeriesIds.includes(seriesId)) {
    issues.add(
      "METRIC_SERIES_UNSUPPORTED",
      path,
      `${seriesLabel(seriesId)} cannot be used as a ${STRATEGY_METRIC_CATEGORY_LABELS[definition.category].toLowerCase()} metric.`,
    );
    return undefined;
  }
  return instantiateMetric(kind, seriesId);
}

function parseValue(
  raw: unknown,
  location: PredicateLocation,
  issues: ValidationContext,
): StrategyValue | undefined {
  const path = predicatePath(location, "VALUE");
  if (!isRecord(raw)) {
    issues.add("SHAPE_INVALID", path, "Choose a value for this rule.");
    return undefined;
  }
  const kind = raw.kind;
  if (
    kind !== "SERIES" &&
    kind !== "NUMBER" &&
    kind !== "PERCENT" &&
    kind !== "MULTIPLE" &&
    kind !== "MONEY"
  ) {
    issues.add(
      "SHAPE_INVALID",
      path,
      `\`${String(kind)}\` is not a kind of strategy value.`,
    );
    return undefined;
  }
  issues.rejectUnknownKeys(raw, VALUE_KEYS[kind], path);

  if (kind === "SERIES") {
    if (typeof raw.seriesId !== "string") {
      issues.add("SHAPE_INVALID", path, "Choose a value for this rule.");
      return undefined;
    }
    if (!findSelectableSeries(raw.seriesId)) {
      issues.add(
        "SERIES_UNKNOWN",
        path,
        `\`${raw.seriesId}\` is not a series this product offers.`,
      );
      return undefined;
    }
    return { kind: "SERIES", seriesId: raw.seriesId as SelectableSeriesId };
  }

  if (typeof raw.value !== "number") {
    issues.add("SHAPE_INVALID", path, "Enter a number for this rule.");
    return undefined;
  }
  return { kind, value: raw.value };
}

/**
 * Whether one Value may be compared with one Metric, and why not when it may not.
 *
 * The single answer to that question. The validator turns a rejection into a path-addressed issue;
 * the Strategy Builder's draft reducer asks the same function whether a Value survives a change of
 * Metric. Neither restates the rule, so a Value the Builder keeps can never be one the API rejects.
 */
export type StrategyValueCompatibility =
  | { compatible: true }
  | {
      compatible: false;
      code:
        "VALUE_KIND_MISMATCH" | "SERIES_NOT_COMPARABLE" | "VALUE_OUT_OF_DOMAIN";
      message: string;
    };

export function checkStrategyValue(
  metric: StrategyMetric,
  value: StrategyValue,
): StrategyValueCompatibility {
  const spec = valueSpecFor(metric);
  const metricLabel = strategyMetricLabel(metric);

  if (spec.kind === "SERIES") {
    if (value.kind !== "SERIES") {
      return {
        compatible: false,
        code: "VALUE_KIND_MISMATCH",
        message: `${metricLabel} is compared with another series, not with a typed number.`,
      };
    }
    if (!spec.seriesIds.includes(value.seriesId)) {
      return {
        compatible: false,
        code: "SERIES_NOT_COMPARABLE",
        message:
          metric.kind === "MOVING_AVERAGE"
            ? strategyMetricSeriesId(metric) === value.seriesId
              ? `${metricLabel} cannot be compared with itself.`
              : `${metricLabel} compares only with moving averages of the same timeframe, so ${strategyValueLabel(value)} is not available here.`
            : `${strategyValueLabel(value)} is not a series ${metricLabel} can be compared with.`,
      };
    }
    return { compatible: true };
  }

  if (spec.kind === "NUMBER") {
    if (value.kind !== "NUMBER") {
      return {
        compatible: false,
        code: "VALUE_KIND_MISMATCH",
        message: `${metricLabel} is compared with a number you type.`,
      };
    }
    if (spec.integer && !Number.isInteger(value.value)) {
      return {
        compatible: false,
        code: "VALUE_OUT_OF_DOMAIN",
        message: `${metricLabel} counts whole disclosures, so its threshold must be a whole number.`,
      };
    }
    return Number.isFinite(value.value) &&
      value.value >= spec.min &&
      value.value <= spec.max
      ? { compatible: true }
      : {
          compatible: false,
          code: "VALUE_OUT_OF_DOMAIN",
          message: `${metricLabel} needs a threshold ${boundsText(spec.min, spec.max)}.`,
        };
  }

  if (spec.kind === "MONEY") {
    if (value.kind !== "MONEY") {
      return {
        compatible: false,
        code: "VALUE_KIND_MISMATCH",
        message: `${metricLabel} is compared with an amount of money.`,
      };
    }
    return Number.isFinite(value.value) &&
      value.value >= spec.min &&
      (spec.max === undefined || value.value <= spec.max)
      ? { compatible: true }
      : {
          compatible: false,
          code: "VALUE_OUT_OF_DOMAIN",
          message: `${metricLabel} needs an amount ${boundsText(spec.min, spec.max)}.`,
        };
  }

  if (spec.kind === "MULTIPLE") {
    if (value.kind !== "MULTIPLE") {
      return {
        compatible: false,
        code: "VALUE_KIND_MISMATCH",
        message: `${metricLabel} is compared with a multiple, such as 2.0x.`,
      };
    }
    return Number.isFinite(value.value) &&
      (spec.min === undefined || value.value >= spec.min) &&
      (spec.max === undefined || value.value <= spec.max)
      ? { compatible: true }
      : {
          compatible: false,
          code: "VALUE_OUT_OF_DOMAIN",
          message: `${metricLabel} needs a multiple ${boundsText(spec.min, spec.max)}.`,
        };
  }

  if (value.kind !== "PERCENT") {
    return {
      compatible: false,
      code: "VALUE_KIND_MISMATCH",
      message: `${metricLabel} is compared with a percentage.`,
    };
  }
  return Number.isFinite(value.value) &&
    (spec.min === undefined || value.value >= spec.min) &&
    (spec.max === undefined || value.value <= spec.max)
    ? { compatible: true }
    : {
        compatible: false,
        code: "VALUE_OUT_OF_DOMAIN",
        message: `${metricLabel} needs a percentage ${boundsText(spec.min, spec.max)}.`,
      };
}

function checkValueAgainstMetric(
  metric: StrategyMetric,
  value: StrategyValue,
  location: PredicateLocation,
  issues: ValidationContext,
): void {
  const result = checkStrategyValue(metric, value);
  if (!result.compatible) {
    issues.add(result.code, predicatePath(location, "VALUE"), result.message);
  }
}

/**
 * Whatever identifies a metric beside its kind, for duplicate detection.
 *
 * The whole configured metric for the alternative-data kinds, because two rows differing only in
 * measure, scope or lookback are different conditions. Keying them by kind alone would make
 * `Insider buyers is above 1 (20D)` and `Insider buyers is above 1 (60D)` look like one rule written
 * twice, and the second would be rejected as a duplicate.
 *
 * Relative Volume is in the same situation with its period, and a Fundamental Metric with its
 * identity: neither is parameterized by a catalog id, so a catalog-id key would make every period —
 * or all fifteen metrics — key alike. `RVOL 10 is above 2 AND RVOL 20 is above 2` and
 * `ROIC TTM is above 15% AND ROE TTM is above 15%` are two conditions each and must stay authorable;
 * two rows sharing a period or a metric are still one rule written twice.
 *
 * Exhaustive, with no fallback, so a kind parameterized by something new cannot collide silently.
 */
function predicateMetricKey(metric: StrategyMetric): string {
  switch (metric.kind) {
    case "INSIDER_ACTIVITY":
    case "CONGRESS_ACTIVITY":
      return alternativeDataMetricSignature(metric);
    case "RELATIVE_VOLUME":
      return String(metric.period);
    case "FUNDAMENTAL":
      return metric.metricId;
    case "MOVING_AVERAGE":
    case "OSCILLATOR":
      return metric.seriesId;
    case "MARGIN_OF_SAFETY":
      return metric.sourceId;
    case "PRICE":
    case "GAIN":
    case "LOSS":
      return "";
  }
}

/** Semantic identity of one Condition: same Metric, same operator, same Value. */
function predicateIdentity(
  metric: StrategyMetric,
  operator: string,
  value: StrategyValue,
): string {
  const valueKey =
    value.kind === "SERIES" ? value.seriesId : String(value.value);
  return `${metric.kind}:${predicateMetricKey(metric)}|${operator}|${value.kind}:${valueKey}`;
}

/**
 * The semantic identity of one Exit Rule, **for duplicate detection only**.
 *
 * Order-insensitive across the ANDed Conditions, because AND is commutative: `A AND B` and
 * `B AND A` are the same rule, and the product guarantee is that two *semantically identical* Exit
 * Rules are rejected. Writing one of them the other way round does not make FINAL EXIT occur any
 * more often, so it is the same mistake as writing it twice. The at-most-one Trigger is a separate
 * slot and stays where it is.
 *
 * Deliberately **not** a fingerprint, and deliberately not built by sorting one.
 * `strategySignalFingerprint` preserves authored order and is the identity
 * `StrategyVersion.definitionHash` and `MonitorSignalState.signalFingerprint` are keyed by; sorting
 * there would silently change what those mean for every strategy that already exists — appending
 * versions and resetting Monitor latches for documents nobody edited. This is a second, local
 * identity with exactly one job, and it never reaches persistence, a response or a hash.
 *
 * It reuses the canonical per-predicate serialization rather than defining a second one, so the two
 * can never disagree about which fields carry meaning.
 */
function exitRuleIdentity(signal: StrategySignal): string {
  const [conditions, trigger] = signalFingerprintValue(signal) as [
    unknown[],
    unknown,
  ];
  return JSON.stringify([
    conditions.map((condition) => JSON.stringify(condition)).sort(),
    trigger,
  ]);
}

/**
 * Validates one Condition or Trigger and returns its semantic identity when it is complete enough
 * to have one. A row whose metric, operator or value could not be read has no identity, so it
 * never participates in duplicate detection.
 */
function validatePredicate(
  raw: unknown,
  location: PredicateLocation,
  levelKind: StrategyLevelKind,
  issues: ValidationContext,
): string | undefined {
  const rowPath = predicatePath(location);
  if (!isRecord(raw)) {
    issues.add(
      "SHAPE_INVALID",
      rowPath,
      location.part === "TRIGGER"
        ? "A trigger must be a metric, an operator and a value."
        : "A condition must be a metric, an operator and a value.",
    );
    return undefined;
  }
  issues.rejectUnknownKeys(raw, PREDICATE_KEYS, rowPath);
  if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
    issues.add("SHAPE_INVALID", rowPath, "This row is missing its identifier.");
  } else {
    issues.claimId("PREDICATE", raw.id, rowPath, "condition or trigger");
  }

  const metric = parseMetric(raw.metric, location, levelKind, issues);
  const value = parseValue(raw.value, location, issues);

  // A metric that declares no Trigger operators is not available as a Trigger at all. It is
  // reported against the Metric, not the operator: "Relative Volume cannot be used as a trigger"
  // is the actual problem, where "does not support that trigger. Available: ." would name the
  // operator and then offer nothing. Returning here also keeps the row out of duplicate detection,
  // exactly like any other unreadable metric.
  if (metric && location.part === "TRIGGER" && triggerOperatorsFor(metric).length === 0) {
    issues.add(
      "METRIC_NOT_ALLOWED_IN_PART",
      predicatePath(location, "METRIC"),
      `${strategyMetricLabel(metric)} cannot be used as a trigger. Use it as a condition instead.`,
    );
    return undefined;
  }

  let operator: string | undefined;
  const operatorPath = predicatePath(location, "OPERATOR");
  if (metric) {
    const supported: readonly string[] =
      location.part === "TRIGGER"
        ? triggerOperatorsFor(metric)
        : conditionOperatorsFor(metric);
    if (typeof raw.operator !== "string" || !supported.includes(raw.operator)) {
      issues.add(
        "OPERATOR_NOT_SUPPORTED",
        operatorPath,
        `${strategyMetricLabel(metric)} does not support that ${location.part === "TRIGGER" ? "trigger" : "condition"}. Available: ${supported
          .map((candidate) =>
            location.part === "TRIGGER"
              ? triggerOperatorLabel(candidate as TriggerOperator)
              : conditionOperatorLabel(candidate as ConditionOperator),
          )
          .join(", ")}.`,
      );
    } else {
      operator = raw.operator;
    }
  }

  if (metric && value) {
    checkValueAgainstMetric(metric, value, location, issues);
  }

  return metric && value && operator
    ? predicateIdentity(metric, operator, value)
    : undefined;
}

/** Where one Signal lives: its level, and — inside FINAL EXIT — which Exit Rule owns it. */
type SignalLocation = {
  levelKind: StrategyLevelKind;
  levelIndex?: number;
  ruleIndex?: number;
};

function validateSignal(
  raw: unknown,
  location: SignalLocation,
  issues: ValidationContext,
): void {
  const { levelKind, levelIndex, ruleIndex } = location;
  // A Signal's own issues belong to the row that owns it: the Exit Rule inside FINAL EXIT, the
  // level everywhere else. That is what lets the Builder put the message under the right rule.
  const levelPath = issuePath(
    ruleIndex === undefined
      ? { levelKind, levelIndex, part: "LEVEL" }
      : { levelKind, ruleIndex, part: "EXIT_RULE" },
  );
  if (!isRecord(raw)) {
    issues.add(
      "SHAPE_INVALID",
      levelPath,
      ruleIndex === undefined
        ? "This level is missing its signal."
        : "This exit rule is missing its signal.",
    );
    return;
  }
  issues.rejectUnknownKeys(raw, SIGNAL_KEYS, levelPath);

  const conditions = raw.conditions;
  const trigger = raw.trigger;
  if (!Array.isArray(conditions)) {
    issues.add(
      "SHAPE_INVALID",
      levelPath,
      "A signal's conditions must be a list.",
    );
    return;
  }
  if (conditions.length === 0 && trigger === undefined) {
    issues.add(
      "SIGNAL_EMPTY",
      levelPath,
      "A signal needs at least one condition or a trigger.",
    );
  }
  if (conditions.length > STRATEGY_MAX_CONDITIONS_PER_SIGNAL) {
    issues.add(
      "TOO_MANY_CONDITIONS",
      levelPath,
      `A signal can hold at most ${STRATEGY_MAX_CONDITIONS_PER_SIGNAL} conditions.`,
    );
  }

  const seen = new Map<string, number>();
  conditions.forEach((condition, conditionIndex) => {
    const predicateLocation: PredicateLocation = {
      levelKind,
      levelIndex,
      ruleIndex,
      part: "CONDITION",
      conditionIndex,
    };
    const identity = validatePredicate(
      condition,
      predicateLocation,
      levelKind,
      issues,
    );
    if (identity === undefined) {
      return;
    }
    const firstIndex = seen.get(identity);
    if (firstIndex === undefined) {
      seen.set(identity, conditionIndex);
      return;
    }
    issues.add(
      "DUPLICATE_CONDITION",
      predicatePath(predicateLocation),
      `This condition repeats condition ${firstIndex + 1}. Combining a condition with itself changes nothing, so remove one of them.`,
    );
  });

  if (trigger !== undefined) {
    validatePredicate(
      trigger,
      { levelKind, levelIndex, ruleIndex, part: "TRIGGER" },
      levelKind,
      issues,
    );
  }
}

/**
 * One FINAL EXIT Exit Rule: an identity and the Signal it matches on.
 *
 * Its keys are exactly `id` and `signal`, so a rule cannot carry a nested rule list and the
 * supported grammar stays **OR of AND groups** by construction rather than by a runtime check.
 */
function validateExitRule(
  raw: unknown,
  ruleIndex: number,
  issues: ValidationContext,
): void {
  const rulePath = issuePath({
    levelKind: "FINAL_EXIT",
    ruleIndex,
    part: "EXIT_RULE",
  });
  if (!isRecord(raw)) {
    issues.add("SHAPE_INVALID", rulePath, "An exit rule must be an object.");
    return;
  }
  issues.rejectUnknownKeys(raw, EXIT_RULE_KEYS, rulePath);
  if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
    issues.add(
      "SHAPE_INVALID",
      rulePath,
      "This exit rule is missing its identifier.",
    );
  } else {
    issues.claimId("EXIT_RULE", raw.id, rulePath, "exit rule");
  }
  validateSignal(raw.signal, { levelKind: "FINAL_EXIT", ruleIndex }, issues);
}

/**
 * FINAL EXIT's Exit Rules: at least one, at most {@link STRATEGY_MAX_EXIT_RULES}, none repeating
 * another.
 *
 * A duplicate is rejected for the same reason a duplicate Condition is: ORing a rule with itself
 * changes nothing, so it is always a mistake rather than something to silently drop. Identity is
 * semantic — see {@link exitRuleIdentity} — not the rule's id, so two differently-keyed copies of
 * one rule are still caught, and so is one whose Conditions were merely written in another order.
 */
function validateExitRules(
  raw: unknown,
  issues: ValidationContext,
): void {
  const levelPath = issuePath({ levelKind: "FINAL_EXIT", part: "LEVEL" });
  if (!Array.isArray(raw)) {
    issues.add(
      "SHAPE_INVALID",
      levelPath,
      "FINAL EXIT's exit rules must be a list.",
    );
    return;
  }
  if (raw.length === 0) {
    issues.add(
      "EXIT_RULE_REQUIRED",
      levelPath,
      "FINAL EXIT needs at least one exit rule; remove FINAL EXIT instead of leaving it empty.",
    );
  }
  if (raw.length > STRATEGY_MAX_EXIT_RULES) {
    issues.add(
      "TOO_MANY_EXIT_RULES",
      levelPath,
      `FINAL EXIT can hold at most ${STRATEGY_MAX_EXIT_RULES} exit rules.`,
    );
  }

  const seen = new Map<string, number>();
  raw.forEach((rule, ruleIndex) => {
    const before = issues.issues.length;
    validateExitRule(rule, ruleIndex, issues);
    if (issues.issues.length !== before) {
      // A rule that did not validate has no canonical logic, so it never participates in duplicate
      // detection — exactly as an unreadable Condition row does not.
      return;
    }
    const identity = exitRuleIdentity((rule as StrategyExitRule).signal);
    const firstIndex = seen.get(identity);
    if (firstIndex === undefined) {
      seen.set(identity, ruleIndex);
      return;
    }
    issues.add(
      "DUPLICATE_EXIT_RULE",
      issuePath({ levelKind: "FINAL_EXIT", ruleIndex, part: "EXIT_RULE" }),
      `This exit rule repeats exit rule ${firstIndex + 1}. FINAL EXIT already occurs when that rule matches, so remove one of them.`,
    );
  });
}

function validateLevel(
  raw: unknown,
  levelKind: StrategyLevelKind,
  levelIndex: number | undefined,
  issues: ValidationContext,
): void {
  const levelPath = issuePath({ levelKind, levelIndex, part: "LEVEL" });
  if (!isRecord(raw)) {
    issues.add(
      "SHAPE_INVALID",
      levelPath,
      `A ${STRATEGY_LEVEL_LABELS[levelKind]} level must be an object.`,
    );
    return;
  }
  for (const key of unknownKeys(
    raw,
    levelKind === "FINAL_EXIT" ? FINAL_EXIT_KEYS : LEVEL_KEYS,
  )) {
    // A percentage on FINAL EXIT is the one unknown key with a product reason, so it is reported
    // against the percentage control rather than against the level as a whole.
    const isFinalExitPercentage =
      levelKind === "FINAL_EXIT" && key === "percentage";
    issues.add(
      "UNKNOWN_FIELD",
      isFinalExitPercentage
        ? issuePath({ levelKind, levelIndex, part: "PERCENTAGE" })
        : levelPath,
      `\`${key}\` is not part of a strategy.${
        isFinalExitPercentage
          ? " FINAL EXIT closes the entire remaining position, so it has no percentage."
          : ""
      }`,
    );
  }
  if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
    issues.add(
      "SHAPE_INVALID",
      levelPath,
      "This level is missing its identifier.",
    );
  } else {
    issues.claimId("LEVEL", raw.id, levelPath, "level");
  }

  if (levelKind === "FINAL_EXIT") {
    validateExitRules(raw.rules, issues);
    return;
  }

  const allowed: readonly number[] =
    levelKind === "BUY" ? BUY_LEVEL_PERCENTAGES : SELL_LEVEL_PERCENTAGES;
  if (typeof raw.percentage !== "number" || !allowed.includes(raw.percentage)) {
    issues.add(
      "PERCENTAGE_INVALID",
      issuePath({ levelKind, levelIndex, part: "PERCENTAGE" }),
      `A ${STRATEGY_LEVEL_LABELS[levelKind]} level percentage must be one of ${allowed.join("%, ")}%.`,
    );
  }

  validateSignal(raw.signal, { levelKind, levelIndex }, issues);
}

function validateLevelList(
  raw: unknown,
  levelKind: "BUY" | "SELL",
  maximum: number,
  issues: ValidationContext,
): void {
  const listPath = issuePath({ levelKind, part: "STRATEGY" });
  if (!Array.isArray(raw)) {
    issues.add(
      "SHAPE_INVALID",
      listPath,
      `A strategy's ${STRATEGY_LEVEL_LABELS[levelKind]} levels must be a list.`,
    );
    return;
  }
  if (levelKind === "BUY" && raw.length === 0) {
    issues.add(
      "BUY_LEVEL_REQUIRED",
      listPath,
      "A strategy needs at least one BUY level; without one it can never buy anything.",
    );
  }
  if (raw.length > maximum) {
    issues.add(
      "TOO_MANY_LEVELS",
      listPath,
      `A strategy can hold at most ${maximum} ${STRATEGY_LEVEL_LABELS[levelKind]} levels.`,
    );
  }
  raw.forEach((level, index) => {
    validateLevel(level, levelKind, index, issues);
  });
}

function validateDefinition(input: unknown, issues: ValidationContext): void {
  // Every persisted document reaches validation through this one upcast, so a version 1 row, a
  // version 1 backtest snapshot and a version 1 request body are all validated as the version 2
  // documents they are equivalent to — with one set of rules and one set of issue paths.
  const raw = upgradeStrategyDefinitionDocument(input);
  const strategyPath = issuePath({ part: "STRATEGY" });
  if (!isRecord(raw)) {
    issues.add(
      "SHAPE_INVALID",
      strategyPath,
      "A strategy definition must be an object.",
    );
    return;
  }
  issues.rejectUnknownKeys(
    raw,
    DEFINITION_KEYS,
    strategyPath,
    BACKTEST_FIELD_HINT,
  );
  if (raw.schemaVersion !== STRATEGY_SCHEMA_VERSION) {
    issues.add(
      "SHAPE_INVALID",
      strategyPath,
      `A strategy definition must declare schemaVersion ${STRATEGY_SCHEMA_VERSION} (version ${STRATEGY_LEGACY_SCHEMA_VERSION} is still accepted and upgraded).`,
    );
  }
  validateLevelList(raw.buyLevels, "BUY", STRATEGY_MAX_BUY_LEVELS, issues);
  validateLevelList(raw.sellLevels, "SELL", STRATEGY_MAX_SELL_LEVELS, issues);
  if (raw.finalExit !== undefined) {
    validateLevel(raw.finalExit, "FINAL_EXIT", undefined, issues);
  }
}

/**
 * Every issue in one strategy definition, in document order, or an empty list when it is valid.
 *
 * Non-throwing and path-addressed: the Builder renders these inline against the rows that produced
 * them, and the API returns the same objects in its 400 body. Input is `unknown` because both
 * callers receive documents they have not proven anything about yet.
 */
export function validateStrategyDefinition(
  definition: unknown,
): readonly StrategyValidationIssue[] {
  const issues = new ValidationContext();
  validateDefinition(definition, issues);
  return issues.issues;
}

// ---------------------------------------------------------------------------
// Document upgrade
// ---------------------------------------------------------------------------

/**
 * Upcasts a schema version 1 definition document to the equivalent version 2 one.
 *
 * Version 1 gave FINAL EXIT a single flat `signal`. Version 2 gives it `rules`, the ordered list of
 * alternatives combined with OR. The two are **logically identical for one rule** — an OR of a
 * single alternative is that alternative — so a stored version 1 document is upgraded rather than
 * migrated: nothing in the database is rewritten, no strategy version is appended, and no completed
 * backtest snapshot changes meaning.
 *
 * Three properties make that safe, and all three are tested:
 *
 * 1. **Deterministic.** The single Exit Rule reuses FINAL EXIT's own id rather than inventing one,
 *    so reading one immutable row twice produces byte-identical documents. Exit Rule ids live in
 *    their own namespace, so reusing the level's id is not a collision.
 * 2. **Semantics-preserving.** Only `schemaVersion` and the FINAL EXIT slot move; every other field
 *    is passed through untouched, including ones that are invalid, so validation still reports them
 *    against the rows that carry them.
 * 3. **Idempotent.** A version 2 document — or anything that is not a readable version 1 one — is
 *    returned as-is, so callers may apply it defensively without checking first.
 *
 * Input is `unknown` and the result is `unknown`: this converts a shape, it does not prove one.
 * Validation is what proves it.
 */
export function upgradeStrategyDefinitionDocument(definition: unknown): unknown {
  if (!isRecord(definition)) {
    return definition;
  }
  if (definition.schemaVersion !== STRATEGY_LEGACY_SCHEMA_VERSION) {
    return definition;
  }
  const upgraded: Record<string, unknown> = {
    ...definition,
    schemaVersion: STRATEGY_SCHEMA_VERSION,
  };
  const finalExit = definition.finalExit;
  if (
    isRecord(finalExit) &&
    typeof finalExit.id === "string" &&
    finalExit.rules === undefined &&
    finalExit.signal !== undefined
  ) {
    const { signal, ...rest } = finalExit;
    upgraded.finalExit = {
      ...rest,
      rules: [{ id: finalExit.id, signal }],
    };
  }
  return upgraded;
}

/** Every issue in a complete strategy — name, description and definition — in document order. */
export function validateStrategy(
  strategy: unknown,
): readonly StrategyValidationIssue[] {
  const issues = new ValidationContext();
  if (!isRecord(strategy)) {
    issues.add(
      "SHAPE_INVALID",
      issuePath({ part: "STRATEGY" }),
      "A strategy must be an object.",
    );
    return issues.issues;
  }
  issues.rejectUnknownKeys(
    strategy,
    STRATEGY_KEYS,
    issuePath({ part: "STRATEGY" }),
    BACKTEST_FIELD_HINT,
  );

  const namePath = issuePath({ part: "NAME" });
  if (typeof strategy.name !== "string") {
    issues.add("NAME_REQUIRED", namePath, "A strategy needs a name.");
  } else {
    const name = strategy.name.trim();
    if (name.length === 0) {
      issues.add("NAME_REQUIRED", namePath, "A strategy needs a name.");
    } else if (name.length > STRATEGY_NAME_MAX_LENGTH) {
      issues.add(
        "NAME_TOO_LONG",
        namePath,
        `A strategy name can be at most ${STRATEGY_NAME_MAX_LENGTH} characters.`,
      );
    }
  }

  if (strategy.description !== undefined) {
    const descriptionPath = issuePath({ part: "DESCRIPTION" });
    if (typeof strategy.description !== "string") {
      issues.add(
        "SHAPE_INVALID",
        descriptionPath,
        "A strategy description must be text.",
      );
    } else if (
      strategy.description.trim().length > STRATEGY_DESCRIPTION_MAX_LENGTH
    ) {
      issues.add(
        "DESCRIPTION_TOO_LONG",
        descriptionPath,
        `A strategy description can be at most ${STRATEGY_DESCRIPTION_MAX_LENGTH} characters.`,
      );
    }
  }

  validateDefinition(strategy.definition, issues);
  return issues.issues;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function buildMetric(metric: StrategyMetric): StrategyMetric {
  const alternative = asAlternativeDataMetric(metric);
  if (alternative) {
    return buildAlternativeDataMetric(alternative);
  }
  switch (metric.kind) {
    case "MOVING_AVERAGE":
      return { kind: "MOVING_AVERAGE", seriesId: metric.seriesId };
    case "OSCILLATOR":
      return { kind: "OSCILLATOR", seriesId: metric.seriesId };
    case "MARGIN_OF_SAFETY":
      return { kind: "MARGIN_OF_SAFETY", sourceId: metric.sourceId };
    case "RELATIVE_VOLUME":
      return { kind: "RELATIVE_VOLUME", period: metric.period };
    case "FUNDAMENTAL":
      return { kind: "FUNDAMENTAL", metricId: metric.metricId };
    case "PRICE":
      return { kind: "PRICE" };
    case "GAIN":
      return { kind: "GAIN" };
    case "LOSS":
      return { kind: "LOSS" };
    default:
      // Unreachable: every alternative-data kind is canonicalized above, by the module that owns
      // its shape. Kept so adding a metric kind is a type error here rather than a silent fallthrough.
      return metric;
  }
}

function buildValue(value: StrategyValue): StrategyValue {
  switch (value.kind) {
    case "SERIES":
      return { kind: "SERIES", seriesId: value.seriesId };
    case "NUMBER":
      return { kind: "NUMBER", value: value.value };
    case "PERCENT":
      return { kind: "PERCENT", value: value.value };
    case "MULTIPLE":
      return { kind: "MULTIPLE", value: value.value };
    case "MONEY":
      return { kind: "MONEY", value: value.value };
  }
}

/** The id the builders below give a row: the one it was authored with, unless a copy is re-keyed. */
type RowIdOf = (id: string) => string;

const keepRowId: RowIdOf = (id) => id;

function buildSignal(signal: StrategySignal, idOf: RowIdOf): StrategySignal {
  const normalized: StrategySignal = {
    conditions: signal.conditions.map((condition) => ({
      id: idOf(condition.id),
      metric: buildMetric(condition.metric),
      operator: condition.operator,
      value: buildValue(condition.value),
    })),
  };
  if (signal.trigger) {
    normalized.trigger = {
      id: idOf(signal.trigger.id),
      metric: buildMetric(signal.trigger.metric),
      operator: signal.trigger.operator,
      value: buildValue(signal.trigger.value),
    };
  }
  return normalized;
}

function buildDefinition(
  definition: StrategyDefinition,
  idOf: RowIdOf = keepRowId,
): StrategyDefinition {
  const normalized: StrategyDefinition = {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: definition.buyLevels.map((level) => ({
      id: idOf(level.id),
      signal: buildSignal(level.signal, idOf),
      percentage: level.percentage,
    })),
    sellLevels: definition.sellLevels.map((level) => ({
      id: idOf(level.id),
      signal: buildSignal(level.signal, idOf),
      percentage: level.percentage,
    })),
  };
  if (definition.finalExit) {
    normalized.finalExit = {
      id: idOf(definition.finalExit.id),
      // Exit Rule order is preserved exactly, like level and condition order. OR is commutative, so
      // reordering does not change what the strategy does — but it is what the user wrote, it is
      // what the Builder renumbers, and rewriting it would move their rules for them.
      rules: definition.finalExit.rules.map((rule) => ({
        id: idOf(rule.id),
        signal: buildSignal(rule.signal, idOf),
      })),
    };
  }
  return normalized;
}

/**
 * Validates and canonicalizes one strategy definition, throwing `StrategyValidationError` when it
 * is not valid.
 *
 * It calls `validateStrategyDefinition` first, so a rule can never be enforced on one path and not
 * the other. Normalization is deterministic and idempotent: it rebuilds the document with exactly
 * the canonical fields and **preserves level and condition order exactly**, because order is
 * product-meaningful. Conditions are never reordered, merged or deduplicated — a duplicate is an
 * error, not something to silently clean up.
 */
export function normalizeStrategyDefinition(
  definition: unknown,
): StrategyDefinition {
  // The upcast happens here as well as inside validation, because the canonical result must be
  // built from the *upgraded* document: a version 1 row validates cleanly and must then normalize
  // to the version 2 shape rather than back to the one it was stored in.
  const upgraded = upgradeStrategyDefinitionDocument(definition);
  const issues = validateStrategyDefinition(upgraded);
  if (issues.length > 0) {
    throw new StrategyValidationError(issues);
  }
  return buildDefinition(upgraded as StrategyDefinition);
}

/**
 * The same logic under entirely new identities: every level, FINAL EXIT, Exit Rule, condition and
 * trigger id is replaced by a fresh one from `nextId`, and nothing else changes — not a value, not
 * an operator, not the order of anything.
 *
 * This is what makes a copy of a strategy a different strategy rather than a second name for the
 * same one. A level id is the identity a Monitor's durable state is keyed by, and row ids are what
 * diagnostics address, so a copy that kept them would share its source's identities; a re-keyed
 * copy shares only its logic. The fingerprints ignore ids, so `strategyDefinitionFingerprint` —
 * and the persisted `definitionHash` derived from it — is unchanged, which is the proof that
 * nothing but identity moved.
 *
 * It walks the document with the canonical builder, so a row kind added to the document later is
 * re-keyed as soon as normalization learns to build it. `nextId` must return a value not used
 * anywhere else in the definition; a UUID per call does.
 */
export function rekeyStrategyDefinition(
  definition: StrategyDefinition,
  nextId: () => string,
): StrategyDefinition {
  return buildDefinition(definition, () => nextId());
}

// ---------------------------------------------------------------------------
// Definition fingerprint
// ---------------------------------------------------------------------------

/**
 * A canonical string identifying one strategy's **logic**, ignoring row identifiers.
 *
 * Ids are client-generated and exist so diagnostics can address a row; re-keying a row does not
 * change what the strategy does, so it must not create a new persisted version. Genuine reordering
 * does, which is why order is preserved rather than sorted — level order is product-meaningful.
 *
 * The value is a deterministic serialization, not a hash: hashing belongs to the persistence layer,
 * which has `node:crypto`, while the knowledge of which fields carry meaning belongs here with the
 * model. Two definitions produce the same string exactly when they express the same logic.
 *
 * It is led by {@link STRATEGY_FINGERPRINT_VERSION} rather than by the document's `schemaVersion`,
 * because the two answer different questions. `schemaVersion` describes the *document format*;
 * this describes the *logic*. A version 1 document and its version 2 upcast express identical
 * logic, so they must — and do — produce an identical fingerprint, which is what keeps every
 * existing `StrategyVersion.definitionHash` valid and stops the next save of an unedited strategy
 * appending a version that changes nothing.
 */
/**
 * The version of the fingerprint *serialization*, bumped only when the serialization itself starts
 * meaning something different — never when the persisted document format changes.
 */
const STRATEGY_FINGERPRINT_VERSION = 1;

export function strategyDefinitionFingerprint(
  definition: StrategyDefinition,
): string {
  return JSON.stringify([
    STRATEGY_FINGERPRINT_VERSION,
    definition.buyLevels.map((level) => [
      level.percentage,
      signalFingerprintValue(level.signal),
    ]),
    definition.sellLevels.map((level) => [
      level.percentage,
      signalFingerprintValue(level.signal),
    ]),
    definition.finalExit ? finalExitFingerprintValue(definition.finalExit) : null,
  ]);
}

/**
 * The same canonical serialization for **one** Signal.
 *
 * A consumer that tracks per-level state needs to know when *that level's* logic changed, not when
 * anything in the strategy did. Editing one condition appends a new strategy version, and treating
 * the version as the identity of every level would discard the state of every other, unchanged
 * level with it.
 *
 * It shares {@link strategyDefinitionFingerprint}'s serialization exactly rather than defining a
 * second one, so the two can never disagree about which fields carry meaning.
 */
export function strategySignalFingerprint(signal: StrategySignal): string {
  return JSON.stringify(signalFingerprintValue(signal));
}

/**
 * The canonical serialization of the whole FINAL EXIT level — every Exit Rule, in order.
 *
 * This is what a Monitor keys its durable FINAL EXIT state by, so editing *any* rule resets that
 * level and only that level, exactly as editing a BUY level's only signal resets that BUY level.
 *
 * A single-rule FINAL EXIT fingerprints **byte-identically to the same logic under schema version
 * 1**, because an OR of one alternative is that alternative. That is not a compatibility shim: it
 * is the same statement the upgrade makes, and it is what stops a deploy silently resetting the
 * transition state of every Monitor that has a FINAL EXIT.
 */
export function strategyFinalExitFingerprint(
  finalExit: StrategyFinalExit,
): string {
  return JSON.stringify(finalExitFingerprintValue(finalExit));
}

/**
 * The id-free value of one FINAL EXIT.
 *
 * `"OR"` leads the multi-rule form so it can never be confused with a single Signal's value, whose
 * first element is always the list of conditions.
 */
function finalExitFingerprintValue(finalExit: StrategyFinalExit): unknown {
  const rules = finalExit.rules.map((rule) =>
    signalFingerprintValue(rule.signal),
  );
  return rules.length === 1 ? rules[0] : ["OR", rules];
}

/** The canonical id-free value of one Signal. Shared by both fingerprints; never inlined twice. */
function signalFingerprintValue(signal: StrategySignal): unknown {
  const value = (input: StrategyValue): unknown =>
    input.kind === "SERIES"
      ? [input.kind, input.seriesId]
      : [input.kind, input.value];
  const metric = (input: StrategyMetric): unknown => {
    // A third element is **appended only for the kinds that are parameterized by something other
    // than a catalog id**, so every metric whose whole identity is `kind` plus a catalog id — the
    // moving averages, the oscillators, Margin of Safety, Price, Gain and Loss — serializes to
    // exactly the two elements it always did. That is what keeps every persisted
    // `StrategyVersion.definitionHash` valid and every non-RVOL Monitor latch in place.
    //
    // `alternativeDataMetricSignature` covers measure, lookback, scope and filters, so editing a
    // lookback or a scope correctly appends a version and resets that level.
    //
    // Relative Volume carries its period for the same reason: the period *is* the metric's
    // identity, and leaving it out made `RVOL 10 is above 2` and `RVOL 20 is above 2` serialize
    // identically — one definition hash and one Monitor latch for two different rules. Adding it
    // moved the stored hash of every existing RVOL strategy and reset the Monitor state of its
    // RVOL levels exactly once; that was the intended correction, because the state those rows
    // latched was never keyed to the logic it belonged to.
    //
    // A Fundamental Metric carries its catalog identity there from its first day, so `ROIC TTM` and
    // `ROE TTM` can never share a definition hash or a Monitor latch — and, the kind being new, no
    // stored hash moves.
    //
    // Exhaustive, with no fallback: a kind parameterized by something new must choose its
    // serialization here or fail to compile, rather than silently collapse into `[kind, null]`.
    switch (input.kind) {
      case "RELATIVE_VOLUME":
        return [input.kind, null, input.period];
      case "FUNDAMENTAL":
        return [input.kind, null, input.metricId];
      case "INSIDER_ACTIVITY":
      case "CONGRESS_ACTIVITY":
        return [input.kind, null, alternativeDataMetricSignature(input)];
      case "MOVING_AVERAGE":
      case "OSCILLATOR":
        return [input.kind, input.seriesId];
      case "MARGIN_OF_SAFETY":
        return [input.kind, input.sourceId];
      case "PRICE":
      case "GAIN":
      case "LOSS":
        return [input.kind, null];
    }
  };
  const predicate = (input: StrategyCondition | StrategyTrigger): unknown => [
    metric(input.metric),
    input.operator,
    value(input.value),
  ];
  return [
    signal.conditions.map(predicate),
    signal.trigger ? predicate(signal.trigger) : null,
  ];
}

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

/**
 * One row of `GET /strategies`.
 *
 * Counts rather than the definition, so the collection page renders without loading every
 * document — the same reasoning as `StockListSummaryResponse.itemCount`.
 */
export type StrategySummaryResponse = ContentOwnershipResponse & {
  id: string;
  name: string;
  description?: string;
  buyLevelCount: number;
  sellLevelCount: number;
  hasFinalExit: boolean;
  versionNumber: number;
  createdAt: string;
  updatedAt: string;
};

export type StrategyDetailResponse = StrategySummaryResponse & {
  definition: StrategyDefinition;
};

/**
 * Creates a strategy: its name plus its rules, saved in one atomic request.
 *
 * `definition` is required because a strategy needs at least one BUY level to be saveable, so
 * there is no name-only strategy to create. The Builder holds the draft until it is valid; an
 * omitted definition is validated as an empty one and rejected for the same reason.
 */
export type CreateStrategyRequest = {
  name: string;
  description?: string;
  definition: StrategyDefinition;
};

/** At least one field must be present. `description: null` clears the description. */
export type UpdateStrategyRequest = {
  name?: string;
  description?: string | null;
};

/** Replaces the COMPLETE definition atomically and returns the canonical normalized result. */
export type ReplaceStrategyDefinitionRequest = {
  definition: StrategyDefinition;
};

/**
 * Copies a strategy the caller can read — their own, or a built-in — into a new one they own.
 *
 * The name is the only thing the caller chooses. What a copy contains is decided by the server
 * from the source: its description and its current definition, re-keyed. There is deliberately no
 * `definition` field, so a copy can never be anything but the strategy it was made from.
 */
export type DuplicateStrategyRequest = {
  name: string;
};

/** The `code` a 400 carries when the canonical validator rejected a submitted strategy. */
export const STRATEGY_INVALID_CODE = "STRATEGY_INVALID" as const;

/**
 * The 400 body for an invalid strategy: the same path-addressed issues the Builder renders
 * inline, so a stale client or a concurrent edit produces row-level errors rather than a banner.
 */
export type StrategyValidationErrorResponse = {
  message: string;
  code: typeof STRATEGY_INVALID_CODE;
  issues: StrategyValidationIssue[];
};
