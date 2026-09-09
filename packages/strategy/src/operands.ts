import {
  findSelectableSeries,
  type SelectableSeries,
  type SelectableSeriesId,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyMetric,
  type StrategySignal,
  type StrategyTrigger,
  type StrategyValue,
} from "@intrinsic/contracts";

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

/** A catalog series read straight off the materialized daily derived state. */
export function seriesOperand(seriesId: SelectableSeriesId): OperandKey {
  return `series:${seriesId}`;
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
  switch (metric.kind) {
    case "PRICE":
      return PRICE_OPERAND;
    case "MOVING_AVERAGE":
    case "OSCILLATOR":
      return seriesOperand(metric.seriesId);
    case "MARGIN_OF_SAFETY":
      return marginOfSafetyOperand(metric.sourceId);
    case "GAIN":
    case "LOSS":
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
  if (definition.finalExit) {
    addSignal(definition.finalExit.signal);
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
