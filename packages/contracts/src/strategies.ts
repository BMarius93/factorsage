import {
  comparableMovingAverages,
  findSelectableSeries,
  INTRINSIC_VALUE_SERIES,
  MOVING_AVERAGE_SERIES,
  OSCILLATOR_SERIES,
  PRICE_COMPARABLE_SERIES,
  type SelectableSeriesId,
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
 * A Strategy Metric.
 *
 * `Price` is the canonical end-of-day close and is deliberately not a catalog entry, so it is its
 * own kind. Moving averages and RSI are addressed through their **catalog ids**, never a parallel
 * enum. `Margin of Safety` is a first-class metric parameterized by the intrinsic-value source it
 * reads — never a comparison operator, and never a global valuation setting on the Strategy.
 */
export type StrategyMetric =
  | { kind: "PRICE" }
  | { kind: "MOVING_AVERAGE"; seriesId: SelectableSeriesId }
  | { kind: "OSCILLATOR"; seriesId: SelectableSeriesId }
  | { kind: "MARGIN_OF_SAFETY"; sourceId: SelectableSeriesId }
  | { kind: "GAIN" }
  | { kind: "LOSS" };

export type StrategyMetricKind = StrategyMetric["kind"];

/** Canonical metric order, used to build the Builder's grouped option list. */
export const STRATEGY_METRIC_KINDS = [
  "PRICE",
  "MOVING_AVERAGE",
  "OSCILLATOR",
  "MARGIN_OF_SAFETY",
  "GAIN",
  "LOSS",
] as const satisfies readonly StrategyMetricKind[];

/**
 * The right-hand side of a Condition or Trigger, in product vocabulary.
 *
 * `SERIES` compares against another canonical series; `NUMBER` is a plain user-entered threshold
 * (RSI); `PERCENT` is a user-entered percentage (Margin of Safety, Gain, Loss). The distinction
 * between `NUMBER` and `PERCENT` is a unit, which is what lets one renderer print `30` and `25%`
 * without a per-metric formatting rule in feature code.
 */
export type StrategyValue =
  | { kind: "SERIES"; seriesId: SelectableSeriesId }
  | { kind: "NUMBER"; value: number }
  | { kind: "PERCENT"; value: number };

export type StrategyValueKind = StrategyValue["kind"];

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

/** FINAL EXIT carries no percentage at all: the type makes the product rule unrepresentable. */
export type StrategyFinalExit = { id: string; signal: StrategySignal };

export const STRATEGY_SCHEMA_VERSION = 1;

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

/** A complete Strategy as authored: identity fields plus the definition document. */
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

export const STRATEGY_METRIC_GROUPS = [
  "PRICE",
  "MOVING_AVERAGES",
  "OSCILLATORS",
  "VALUATION",
  "POSITION",
] as const;

export type StrategyMetricGroupId = (typeof STRATEGY_METRIC_GROUPS)[number];

/**
 * Group headings for the Metric select.
 *
 * The top-level grouping is Strategy metadata the series catalog does not define, so it lives here
 * once. Inside a catalog-backed group the order is the catalog's own.
 */
export const STRATEGY_METRIC_GROUP_LABELS = {
  PRICE: "Price",
  MOVING_AVERAGES: "Moving averages",
  OSCILLATORS: "Oscillators",
  VALUATION: "Valuation",
  POSITION: "Position",
} as const satisfies Record<StrategyMetricGroupId, string>;

/**
 * The permitted Values for one Metric.
 *
 * `min`/`max` are omitted where the metric has no bound on that side: Margin of Safety has no
 * lower bound and Gain has no upper one, and an invented bound would reject a legitimate rule.
 */
export type StrategyValueSpec =
  | { kind: "SERIES"; seriesIds: readonly SelectableSeriesId[] }
  | { kind: "NUMBER"; min: number; max: number; step: number }
  | { kind: "PERCENT"; min?: number; max?: number };

type StrategyMetricDefinitionBase = {
  kind: StrategyMetricKind;
  /** Catalog-backed identities carry no label here; theirs comes from the catalog. */
  label?: string;
  group: StrategyMetricGroupId;
  /**
   * The catalog ids this metric may be instantiated with: the moving averages, the RSI periods, or
   * the intrinsic-value sources a Margin of Safety metric can read. Absent for the metrics that
   * take no parameter.
   */
  parameterSeriesIds?: readonly SelectableSeriesId[];
  conditionOperators: readonly ConditionOperator[];
  triggerOperators: readonly TriggerOperator[];
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
    | { valueSource?: undefined; value: StrategyValueSpec }
  );

const ALL_LEVEL_KINDS: readonly StrategyLevelKind[] = STRATEGY_LEVEL_KINDS;
const POSITION_LEVEL_KINDS: readonly StrategyLevelKind[] = [
  "SELL",
  "FINAL_EXIT",
];

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
    group: "PRICE",
    conditionOperators: PRICE_SCALE_CONDITION_OPERATORS,
    triggerOperators: TRIGGER_OPERATORS,
    value: { kind: "SERIES", seriesIds: catalogIds(PRICE_COMPARABLE_SERIES) },
    allowedIn: ALL_LEVEL_KINDS,
  },
  MOVING_AVERAGE: {
    kind: "MOVING_AVERAGE",
    group: "MOVING_AVERAGES",
    parameterSeriesIds: catalogIds(MOVING_AVERAGE_SERIES),
    conditionOperators: PRICE_SCALE_CONDITION_OPERATORS,
    triggerOperators: TRIGGER_OPERATORS,
    valueSource: "COMPARABLE_MOVING_AVERAGES",
    allowedIn: ALL_LEVEL_KINDS,
  },
  OSCILLATOR: {
    kind: "OSCILLATOR",
    group: "OSCILLATORS",
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
  MARGIN_OF_SAFETY: {
    kind: "MARGIN_OF_SAFETY",
    label: "Margin of Safety",
    group: "VALUATION",
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
  GAIN: {
    kind: "GAIN",
    label: "Gain",
    group: "POSITION",
    conditionOperators: COMPARISON_OPERATORS,
    triggerOperators: TRIGGER_OPERATORS,
    /** Signed, and unbounded above: a long position cannot lose more than its whole cost. */
    value: { kind: "PERCENT", min: -100 },
    allowedIn: POSITION_LEVEL_KINDS,
  },
  LOSS: {
    kind: "LOSS",
    label: "Loss",
    group: "POSITION",
    conditionOperators: COMPARISON_OPERATORS,
    triggerOperators: TRIGGER_OPERATORS,
    /** Non-negative by definition, clamped at zero, and capped by the position's own cost. */
    value: { kind: "PERCENT", min: 0, max: 100 },
    allowedIn: POSITION_LEVEL_KINDS,
  },
};

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
  if (definition.valueSource === "COMPARABLE_MOVING_AVERAGES") {
    const seriesId = strategyMetricSeriesId(metric);
    return {
      kind: "SERIES",
      seriesIds: seriesId ? catalogIds(comparableMovingAverages(seriesId)) : [],
    };
  }
  return definition.value;
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

export type StrategyMetricOption = {
  metric: StrategyMetric;
  label: string;
  group: StrategyMetricGroupId;
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
    default:
      return { kind };
  }
}

function buildMetricOptions(
  levelKind: StrategyLevelKind,
): readonly StrategyMetricOption[] {
  const options: StrategyMetricOption[] = [];
  for (const group of STRATEGY_METRIC_GROUPS) {
    for (const kind of STRATEGY_METRIC_KINDS) {
      const definition = STRATEGY_METRIC_DEFINITIONS[kind];
      if (definition.group !== group) {
        continue;
      }
      if (!definition.allowedIn.includes(levelKind)) {
        continue;
      }
      const metrics: StrategyMetric[] = definition.parameterSeriesIds
        ? definition.parameterSeriesIds.map((seriesId) =>
            instantiateMetric(kind, seriesId),
          )
        : [{ kind } as StrategyMetric];
      for (const metric of metrics) {
        options.push({ metric, label: strategyMetricLabel(metric), group });
      }
    }
  }
  return options;
}

const METRIC_OPTIONS_BY_LEVEL: Record<
  StrategyLevelKind,
  readonly StrategyMetricOption[]
> = {
  BUY: buildMetricOptions("BUY"),
  SELL: buildMetricOptions("SELL"),
  FINAL_EXIT: buildMetricOptions("FINAL_EXIT"),
};

/**
 * Every Metric selectable in one level kind, grouped and in canonical order.
 *
 * `Gain` and `Loss` are simply absent for BUY: they are position-dependent and no position exists
 * before the first buy. No component filters this list further.
 */
export function strategyMetricOptions(
  levelKind: StrategyLevelKind,
): readonly StrategyMetricOption[] {
  return METRIC_OPTIONS_BY_LEVEL[levelKind];
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
 * The one Metric label.
 *
 * For every catalog-backed identity it is `findSelectableSeries(id).label` and nothing else.
 * `Margin of Safety (DCF (FCFF))` reads poorly, so the composition happens here, in one function —
 * a composition of the catalog label, never a second label map.
 */
export function strategyMetricLabel(metric: StrategyMetric): string {
  switch (metric.kind) {
    case "MOVING_AVERAGE":
    case "OSCILLATOR":
      return seriesLabel(metric.seriesId);
    case "MARGIN_OF_SAFETY":
      return `${metricBaseLabel("MARGIN_OF_SAFETY")} (${seriesLabel(
        metric.sourceId,
      )})`;
    default:
      return metricBaseLabel(metric.kind);
  }
}

export function strategyValueLabel(value: StrategyValue): string {
  switch (value.kind) {
    case "SERIES":
      return seriesLabel(value.seriesId);
    case "NUMBER":
      return String(value.value);
    case "PERCENT":
      return `${value.value}%`;
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
  | { kind: "CONDITION"; text: string; connector?: "AND" }
  | { kind: "TRIGGER"; text: string }
  | { kind: "EMPTY"; levelKind: StrategyLevelKind };

export function describeCondition(condition: StrategyCondition): string {
  return `${strategyMetricLabel(condition.metric)} ${conditionOperatorLabel(
    condition.operator,
  )} ${strategyValueLabel(condition.value)}`;
}

export function describeTrigger(trigger: StrategyTrigger): string {
  return `${strategyMetricLabel(trigger.metric)} ${triggerOperatorLabel(
    trigger.operator,
  )} ${strategyValueLabel(trigger.value)}`;
}

function describeSignal(signal: StrategySignal): StrategyPreviewLine[] {
  const lines: StrategyPreviewLine[] = signal.conditions.map(
    (condition, index) =>
      index === 0
        ? { kind: "CONDITION", text: describeCondition(condition) }
        : {
            kind: "CONDITION",
            text: describeCondition(condition),
            connector: "AND",
          },
  );
  if (signal.trigger) {
    lines.push({ kind: "TRIGGER", text: describeTrigger(signal.trigger) });
  }
  return lines;
}

/**
 * The whole Strategy as ordered preview lines: BUY levels, then SELL levels, then FINAL EXIT.
 *
 * An incomplete level renders an explicit `EMPTY` line rather than vanishing, so the preview shows
 * what is missing instead of silently under-reporting the strategy. Output is deterministic: the
 * same definition always produces the same lines in the same order.
 */
export function describeStrategy(
  definition: StrategyDefinition,
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
    const body = describeSignal(signal);
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
    appendLevel("FINAL_EXIT", definition.finalExit.signal);
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

export const STRATEGY_METRIC_HELP = {
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
    examples: [
      {
        given: "RSI 14D is below 30",
        result: "true on every date RSI 14D is under 30",
        meaning: "A state that can stay true for several days in a row.",
      },
      {
        given: "RSI 14D crosses above 30",
        result: "true only on the date it moves from 30 or below to above 30",
        meaning: "A single event, not a state.",
      },
    ],
    notEvaluableWhen:
      "The period is still warming up, so RSI has no value for the date. RSI 14D needs fifteen closes before its first value.",
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
} as const satisfies Record<StrategyMetricKind, StrategyHelpEntry>;

export const STRATEGY_OPERATOR_HELP = {
  IS_ABOVE: {
    summary: "A state: the metric is strictly greater than the value.",
    detail:
      "Conditions describe a state that can stay true for many days in a row. V1 has no `above or equal` variant.",
  },
  IS_BELOW: {
    summary: "A state: the metric is strictly less than the value.",
    detail:
      "Conditions describe a state that can stay true for many days in a row. V1 has no `below or equal` variant.",
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
} as const satisfies Record<
  ConditionOperator | TriggerOperator,
  StrategyHelpEntry
>;

export const STRATEGY_LEVEL_HELP = {
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
} as const satisfies Record<StrategyLevelKind, StrategyHelpEntry>;

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
  "PERCENTAGE_INVALID",
  "METRIC_NOT_ALLOWED_IN_LEVEL",
  "METRIC_SERIES_UNSUPPORTED",
  "OPERATOR_NOT_SUPPORTED",
  "VALUE_KIND_MISMATCH",
  "VALUE_OUT_OF_DOMAIN",
  "SERIES_UNKNOWN",
  "SERIES_NOT_COMPARABLE",
  "DUPLICATE_CONDITION",
] as const;

export type StrategyValidationCode = (typeof STRATEGY_VALIDATION_CODES)[number];

export type StrategyIssuePart =
  | "STRATEGY"
  | "NAME"
  | "DESCRIPTION"
  | "LEVEL"
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
const FINAL_EXIT_KEYS = ["id", "signal"] as const;
const SIGNAL_KEYS = ["conditions", "trigger"] as const;
const PREDICATE_KEYS = ["id", "metric", "operator", "value"] as const;

const METRIC_KEYS: Record<StrategyMetricKind, readonly string[]> = {
  PRICE: ["kind"],
  MOVING_AVERAGE: ["kind", "seriesId"],
  OSCILLATOR: ["kind", "seriesId"],
  MARGIN_OF_SAFETY: ["kind", "sourceId"],
  GAIN: ["kind"],
  LOSS: ["kind"],
};

const VALUE_KEYS: Record<StrategyValueKind, readonly string[]> = {
  SERIES: ["kind", "seriesId"],
  NUMBER: ["kind", "value"],
  PERCENT: ["kind", "value"],
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

class IssueList {
  readonly issues: StrategyValidationIssue[] = [];

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

function parseMetric(
  raw: unknown,
  location: PredicateLocation,
  levelKind: StrategyLevelKind,
  issues: IssueList,
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
        definition.group === "POSITION"
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
      `${seriesLabel(seriesId)} cannot be used as a ${STRATEGY_METRIC_GROUP_LABELS[definition.group].toLowerCase()} metric.`,
    );
    return undefined;
  }
  return instantiateMetric(kind, seriesId);
}

function parseValue(
  raw: unknown,
  location: PredicateLocation,
  issues: IssueList,
): StrategyValue | undefined {
  const path = predicatePath(location, "VALUE");
  if (!isRecord(raw)) {
    issues.add("SHAPE_INVALID", path, "Choose a value for this rule.");
    return undefined;
  }
  const kind = raw.kind;
  if (kind !== "SERIES" && kind !== "NUMBER" && kind !== "PERCENT") {
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
  return kind === "NUMBER"
    ? { kind: "NUMBER", value: raw.value }
    : { kind: "PERCENT", value: raw.value };
}

function checkValueAgainstMetric(
  metric: StrategyMetric,
  value: StrategyValue,
  location: PredicateLocation,
  issues: IssueList,
): void {
  const path = predicatePath(location, "VALUE");
  const spec = valueSpecFor(metric);
  const metricLabel = strategyMetricLabel(metric);

  if (spec.kind === "SERIES") {
    if (value.kind !== "SERIES") {
      issues.add(
        "VALUE_KIND_MISMATCH",
        path,
        `${metricLabel} is compared with another series, not with a typed number.`,
      );
      return;
    }
    if (!spec.seriesIds.includes(value.seriesId)) {
      issues.add(
        "SERIES_NOT_COMPARABLE",
        path,
        metric.kind === "MOVING_AVERAGE"
          ? strategyMetricSeriesId(metric) === value.seriesId
            ? `${metricLabel} cannot be compared with itself.`
            : `${metricLabel} compares only with moving averages of the same timeframe, so ${strategyValueLabel(value)} is not available here.`
          : `${strategyValueLabel(value)} is not a series ${metricLabel} can be compared with.`,
      );
    }
    return;
  }

  if (spec.kind === "NUMBER") {
    if (value.kind !== "NUMBER") {
      issues.add(
        "VALUE_KIND_MISMATCH",
        path,
        `${metricLabel} is compared with a number you type.`,
      );
      return;
    }
    if (
      !Number.isFinite(value.value) ||
      value.value < spec.min ||
      value.value > spec.max
    ) {
      issues.add(
        "VALUE_OUT_OF_DOMAIN",
        path,
        `${metricLabel} needs a threshold ${boundsText(spec.min, spec.max)}.`,
      );
    }
    return;
  }

  if (value.kind !== "PERCENT") {
    issues.add(
      "VALUE_KIND_MISMATCH",
      path,
      `${metricLabel} is compared with a percentage.`,
    );
    return;
  }
  if (
    !Number.isFinite(value.value) ||
    (spec.min !== undefined && value.value < spec.min) ||
    (spec.max !== undefined && value.value > spec.max)
  ) {
    issues.add(
      "VALUE_OUT_OF_DOMAIN",
      path,
      `${metricLabel} needs a percentage ${boundsText(spec.min, spec.max)}.`,
    );
  }
}

/** Semantic identity of one Condition: same Metric, same operator, same Value. */
function predicateIdentity(
  metric: StrategyMetric,
  operator: string,
  value: StrategyValue,
): string {
  const seriesId = strategyMetricSeriesId(metric) ?? "";
  const valueKey =
    value.kind === "SERIES" ? value.seriesId : String(value.value);
  return `${metric.kind}:${seriesId}|${operator}|${value.kind}:${valueKey}`;
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
  issues: IssueList,
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
  }

  const metric = parseMetric(raw.metric, location, levelKind, issues);
  const value = parseValue(raw.value, location, issues);

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

function validateSignal(
  raw: unknown,
  levelKind: StrategyLevelKind,
  levelIndex: number | undefined,
  issues: IssueList,
): void {
  const levelPath = issuePath({ levelKind, levelIndex, part: "LEVEL" });
  if (!isRecord(raw)) {
    issues.add("SHAPE_INVALID", levelPath, "This level is missing its signal.");
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
    const location: PredicateLocation = {
      levelKind,
      levelIndex,
      part: "CONDITION",
      conditionIndex,
    };
    const identity = validatePredicate(condition, location, levelKind, issues);
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
      predicatePath(location),
      `This condition repeats condition ${firstIndex + 1}. Combining a condition with itself changes nothing, so remove one of them.`,
    );
  });

  if (trigger !== undefined) {
    validatePredicate(
      trigger,
      { levelKind, levelIndex, part: "TRIGGER" },
      levelKind,
      issues,
    );
  }
}

function validateLevel(
  raw: unknown,
  levelKind: StrategyLevelKind,
  levelIndex: number | undefined,
  issues: IssueList,
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
  }

  if (levelKind !== "FINAL_EXIT") {
    const allowed: readonly number[] =
      levelKind === "BUY" ? BUY_LEVEL_PERCENTAGES : SELL_LEVEL_PERCENTAGES;
    if (
      typeof raw.percentage !== "number" ||
      !allowed.includes(raw.percentage)
    ) {
      issues.add(
        "PERCENTAGE_INVALID",
        issuePath({ levelKind, levelIndex, part: "PERCENTAGE" }),
        `A ${STRATEGY_LEVEL_LABELS[levelKind]} level percentage must be one of ${allowed.join("%, ")}%.`,
      );
    }
  }

  validateSignal(raw.signal, levelKind, levelIndex, issues);
}

function validateLevelList(
  raw: unknown,
  levelKind: "BUY" | "SELL",
  maximum: number,
  issues: IssueList,
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

function validateDefinition(raw: unknown, issues: IssueList): void {
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
      `A strategy definition must declare schemaVersion ${STRATEGY_SCHEMA_VERSION}.`,
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
  const issues = new IssueList();
  validateDefinition(definition, issues);
  return issues.issues;
}

/** Every issue in a complete strategy — name, description and definition — in document order. */
export function validateStrategy(
  strategy: unknown,
): readonly StrategyValidationIssue[] {
  const issues = new IssueList();
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
  switch (metric.kind) {
    case "MOVING_AVERAGE":
      return { kind: "MOVING_AVERAGE", seriesId: metric.seriesId };
    case "OSCILLATOR":
      return { kind: "OSCILLATOR", seriesId: metric.seriesId };
    case "MARGIN_OF_SAFETY":
      return { kind: "MARGIN_OF_SAFETY", sourceId: metric.sourceId };
    case "PRICE":
      return { kind: "PRICE" };
    case "GAIN":
      return { kind: "GAIN" };
    case "LOSS":
      return { kind: "LOSS" };
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
  }
}

function buildSignal(signal: StrategySignal): StrategySignal {
  const normalized: StrategySignal = {
    conditions: signal.conditions.map((condition) => ({
      id: condition.id,
      metric: buildMetric(condition.metric),
      operator: condition.operator,
      value: buildValue(condition.value),
    })),
  };
  if (signal.trigger) {
    normalized.trigger = {
      id: signal.trigger.id,
      metric: buildMetric(signal.trigger.metric),
      operator: signal.trigger.operator,
      value: buildValue(signal.trigger.value),
    };
  }
  return normalized;
}

function buildDefinition(definition: StrategyDefinition): StrategyDefinition {
  const normalized: StrategyDefinition = {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: definition.buyLevels.map((level) => ({
      id: level.id,
      signal: buildSignal(level.signal),
      percentage: level.percentage,
    })),
    sellLevels: definition.sellLevels.map((level) => ({
      id: level.id,
      signal: buildSignal(level.signal),
      percentage: level.percentage,
    })),
  };
  if (definition.finalExit) {
    normalized.finalExit = {
      id: definition.finalExit.id,
      signal: buildSignal(definition.finalExit.signal),
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
  const issues = validateStrategyDefinition(definition);
  if (issues.length > 0) {
    throw new StrategyValidationError(issues);
  }
  return buildDefinition(definition as StrategyDefinition);
}

/**
 * Validates and canonicalizes a complete strategy, throwing `StrategyValidationError` when it is
 * not valid. The name is trimmed and a blank description becomes absent.
 */
export function normalizeStrategy(strategy: unknown): StrategyDraft {
  const issues = validateStrategy(strategy);
  if (issues.length > 0) {
    throw new StrategyValidationError(issues);
  }
  const input = strategy as StrategyDraft;
  const description = input.description?.trim();
  const normalized: StrategyDraft = {
    name: input.name.trim(),
    definition: buildDefinition(input.definition),
  };
  if (description !== undefined && description.length > 0) {
    normalized.description = description;
  }
  return normalized;
}
