import {
  findSelectableSeries,
  RELATIVE_VOLUME_PERIODS,
  type RelativeVolumePeriod,
  type SelectableSeries,
  type SelectableSeriesId,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyMetric,
  type StrategySignal,
  type StrategyTrigger,
  type StrategyValue,
} from "@intrinsic/contracts";
import { alternativeDataMetricOperand } from "./alternative-data.js";

/**
 * Identity of one value column an evaluation frame carries.
 *
 * An operand is anything that resolves to `number | absent` on one eligible trading day. Keys are
 * opaque strings built here and nowhere else: a frame projector and the evaluator must agree on
 * them, and neither may parse one apart.
 */
export type OperandKey = string;

/** Canonical end-of-day close. Deliberately not a catalog series, so it has its own key. */
export const PRICE_OPERAND: OperandKey = "price";

const SERIES_PREFIX = "series:";

/** A catalog series read straight off the materialized daily derived state. */
export function seriesOperand(seriesId: SelectableSeriesId): OperandKey {
  return `${SERIES_PREFIX}${seriesId}`;
}

/**
 * The catalog series a key addresses, or null when it addresses something else.
 *
 * The inverse of {@link seriesOperand}, and it lives here for the same reason the builder does: the
 * encoding is this module's, and a caller that needs to know which series a key names must ask
 * rather than slice the string itself.
 */
export function operandSeriesId(key: OperandKey): SelectableSeriesId | null {
  return key.startsWith(SERIES_PREFIX)
    ? (key.slice(SERIES_PREFIX.length) as SelectableSeriesId)
    : null;
}

const RELATIVE_VOLUME_PREFIX = "relative-volume:";

/**
 * Relative Volume for one supported period, read straight off the materialized daily derived state.
 *
 * It is its own key family rather than a `series:` key because Relative Volume is not a catalog
 * series: it is parameterized by period, has no catalog id, and is never a comparison Value.
 */
export function relativeVolumeOperand(
  period: RelativeVolumePeriod,
): OperandKey {
  return `${RELATIVE_VOLUME_PREFIX}${period}`;
}

/**
 * The Relative Volume period a key addresses, or null when it addresses something else.
 *
 * The inverse of {@link relativeVolumeOperand}, here for the same reason the builder is: the
 * encoding is this module's, and a caller that needs the period must ask rather than slice the
 * string itself.
 */
export function operandRelativeVolumePeriod(
  key: OperandKey,
): RelativeVolumePeriod | null {
  if (!key.startsWith(RELATIVE_VOLUME_PREFIX)) {
    return null;
  }
  const period = Number(key.slice(RELATIVE_VOLUME_PREFIX.length));
  return (RELATIVE_VOLUME_PERIODS as readonly number[]).includes(period)
    ? (period as RelativeVolumePeriod)
    : null;
}

/**
 * Margin of Safety against one explicitly selected intrinsic-value source.
 *
 * It is its own column because the formula, the `intrinsicValue > 0` rule and the per-model /
 * per-blend provenance gate are applied exactly once, during projection.
 */
export function marginOfSafetyOperand(
  sourceId: SelectableSeriesId,
): OperandKey {
  return `margin-of-safety:${sourceId}`;
}

/** Whether this metric needs simulated position state and therefore cannot be precomputed. */
export function isPositionDependentMetric(metric: StrategyMetric): boolean {
  return metric.kind === "GAIN" || metric.kind === "LOSS";
}

/** The frame column a Metric reads, or null when the metric is position-dependent. */
export function metricOperand(metric: StrategyMetric): OperandKey | null {
  // The alternative-data kinds are addressed by their whole configuration, which `alternative-data.ts`
  // owns; asking it first keeps that encoding in one module instead of repeating the signature here.
  const alternative = alternativeDataMetricOperand(metric);
  if (alternative) {
    return alternative;
  }
  switch (metric.kind) {
    case "PRICE":
      return PRICE_OPERAND;
    case "MOVING_AVERAGE":
    case "OSCILLATOR":
      return seriesOperand(metric.seriesId);
    case "RELATIVE_VOLUME":
      return relativeVolumeOperand(metric.period);
    case "MARGIN_OF_SAFETY":
      return marginOfSafetyOperand(metric.sourceId);
    case "GAIN":
    case "LOSS":
      return null;
    default:
      // Unreachable: every remaining kind is an alternative-data one, answered above.
      return null;
  }
}

/** The frame column a Value reads, or null when the Value is a constant. */
export function valueOperand(value: StrategyValue): OperandKey | null {
  return value.kind === "SERIES" ? seriesOperand(value.seriesId) : null;
}

/**
 * Every frame column a strategy version references, ascending and deduplicated.
 *
 * Projecting only these columns is what keeps a long multi-security run in tens of megabytes
 * instead of gigabytes (`ai/architecture/strategy-evaluation.md` §2.5). The ordering is stable so
 * two runs of the same definition request identical projections.
 */
export function collectOperands(definition: StrategyDefinition): OperandKey[] {
  const keys = new Set<OperandKey>();
  // Price is always projected: portfolio valuation, execution and Gain/Loss all need the close,
  // whether or not a predicate names it.
  keys.add(PRICE_OPERAND);

  const addSignal = (signal: StrategySignal): void => {
    const predicates: (StrategyCondition | StrategyTrigger)[] = [
      ...signal.conditions,
    ];
    if (signal.trigger) {
      predicates.push(signal.trigger);
    }
    for (const predicate of predicates) {
      const metric = metricOperand(predicate.metric);
      if (metric) {
        keys.add(metric);
      }
      const value = valueOperand(predicate.value);
      if (value) {
        keys.add(value);
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

  return [...keys].sort();
}

/**
 * The structured catalog identity behind an operand key, for a projector that has to decide which
 * `DailyDerivedState` field, intrinsic model or blend to read. Returns null for `PRICE`.
 *
 * The catalog stays the single source of that identity: nothing here re-derives a field name from
 * an id or a label.
 */
export function describeSeriesOperand(
  seriesId: SelectableSeriesId,
): SelectableSeries | undefined {
  return findSelectableSeries(seriesId);
}
