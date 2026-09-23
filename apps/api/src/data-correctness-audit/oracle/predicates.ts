import type {
  OracleMetric,
  OraclePredicate,
  OracleSignal,
  OracleValue,
} from "./strategy-model";
import { isPositionMetric } from "./strategy-model";

/**
 * Tri-state Strategy predicate evaluation, written from `ai/product/strategies.md` alone.
 *
 * - `is above` / `is below` are strict.
 * - `is close to` is `abs(metric - value) / abs(value) <= 2%`; a zero comparison value cannot be
 *   used safely and is NOT_EVALUABLE.
 * - `crosses above`: `m[t] > v[t] AND m[t-1] <= v[t-1]`; `crosses below` the mirror. Any of the four
 *   readings unavailable is NOT_EVALUABLE; `t-1` is the security's previous eligible row.
 * - Conditions and the optional Trigger are ANDed; NOT_EVALUABLE never produces a signal.
 * - FINAL EXIT is the OR of its Exit Rules.
 *
 * The three states are strings here on purpose, so nothing about the engine's numeric encoding can
 * leak into the oracle.
 */
export type Tri = "TRUE" | "FALSE" | "NOT_EVALUABLE";

/** The fixed product tolerance of `is close to` (strategies.md: "within 2%"). */
export const CLOSE_TO_TOLERANCE = 0.02;

export type MarketRow = {
  readonly date: string;
  readonly close: number;
  /** Operand readings keyed as the archive names them; absent or null means unavailable. */
  readonly values: ReadonlyMap<string, number>;
};

function finite(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

export function and(values: readonly Tri[]): Tri {
  // A signal fires only when every part is TRUE. A definite FALSE decides the conjunction even if
  // another part is unavailable; otherwise any unavailable part leaves it undecided.
  if (values.includes("FALSE")) {
    return "FALSE";
  }
  if (values.includes("NOT_EVALUABLE")) {
    return "NOT_EVALUABLE";
  }
  return "TRUE";
}

export function or(values: readonly Tri[]): Tri {
  if (values.includes("TRUE")) {
    return "TRUE";
  }
  if (values.includes("NOT_EVALUABLE")) {
    return "NOT_EVALUABLE";
  }
  return "FALSE";
}

export function compare(
  operator: OraclePredicate["operator"],
  metric: number,
  value: number,
): Tri {
  if (!finite(metric) || !finite(value)) {
    return "NOT_EVALUABLE";
  }
  if (operator === "IS_ABOVE") {
    return metric > value ? "TRUE" : "FALSE";
  }
  if (operator === "IS_BELOW") {
    return metric < value ? "TRUE" : "FALSE";
  }
  if (operator === "IS_CLOSE_TO") {
    if (value === 0) {
      return "NOT_EVALUABLE";
    }
    return Math.abs(metric - value) / Math.abs(value) <= CLOSE_TO_TOLERANCE
      ? "TRUE"
      : "FALSE";
  }
  throw new Error(`oracle: ${operator} is a Trigger operator, not a Condition`);
}

export function cross(
  operator: OraclePredicate["operator"],
  metric: number,
  value: number,
  previousMetric: number,
  previousValue: number,
): Tri {
  if (
    !finite(metric) ||
    !finite(value) ||
    !finite(previousMetric) ||
    !finite(previousValue)
  ) {
    return "NOT_EVALUABLE";
  }
  if (operator === "CROSSES_ABOVE") {
    return metric > value && previousMetric <= previousValue ? "TRUE" : "FALSE";
  }
  if (operator === "CROSSES_BELOW") {
    return metric < value && previousMetric >= previousValue ? "TRUE" : "FALSE";
  }
  throw new Error(`oracle: ${operator} is a Condition operator, not a Trigger`);
}

/** The archive's name for the column a market metric reads. */
export function metricKey(metric: OracleMetric): string | null {
  switch (metric.kind) {
    case "PRICE":
      return "price";
    case "MOVING_AVERAGE":
    case "OSCILLATOR":
      return `series:${metric.seriesId}`;
    case "MARGIN_OF_SAFETY":
      return `margin-of-safety:${metric.sourceId}`;
    default:
      return null;
  }
}

function read(row: MarketRow | null, key: string): number {
  if (!row) {
    return Number.NaN;
  }
  if (key === "price") {
    return row.close;
  }
  const value = row.values.get(key);
  return value === undefined || value === null ? Number.NaN : value;
}

function valueAt(value: OracleValue, row: MarketRow | null): number {
  if (value.kind === "SERIES") {
    return read(row, `series:${value.seriesId}`);
  }
  return value.value;
}

/** One market-derived predicate at `row`, with `previous` the security's previous eligible row. */
export function marketPredicate(
  predicateDefinition: OraclePredicate,
  isTrigger: boolean,
  row: MarketRow,
  previous: MarketRow | null,
): Tri {
  const key = metricKey(predicateDefinition.metric);
  if (key === null) {
    throw new Error("oracle: a position metric is not a market predicate");
  }
  const metric = read(row, key);
  const value = valueAt(predicateDefinition.value, row);
  if (!isTrigger) {
    return compare(predicateDefinition.operator, metric, value);
  }
  if (!previous) {
    return "NOT_EVALUABLE";
  }
  return cross(
    predicateDefinition.operator,
    metric,
    value,
    read(previous, key),
    valueAt(predicateDefinition.value, previous),
  );
}

/**
 * The position side of a Gain/Loss predicate.
 *
 * `Gain = (Price - AverageCost) / AverageCost * 100`, `Loss = max(0, -Gain)`. The previous reading
 * is the one that actually held on the security's previous eligible row for this same position,
 * or unavailable.
 */
export type PositionReadings = {
  readonly gain: number;
  readonly previousGain: number;
};

export function positionPredicate(
  predicateDefinition: OraclePredicate,
  isTrigger: boolean,
  readings: PositionReadings,
): Tri {
  const kind = predicateDefinition.metric.kind;
  if (kind !== "GAIN" && kind !== "LOSS") {
    throw new Error("oracle: not a position metric");
  }
  if (predicateDefinition.value.kind === "SERIES") {
    return "NOT_EVALUABLE";
  }
  const project = (gain: number): number =>
    !finite(gain) ? Number.NaN : kind === "GAIN" ? gain : Math.max(0, -gain);
  const threshold = predicateDefinition.value.value;
  if (!isTrigger) {
    return compare(
      predicateDefinition.operator,
      project(readings.gain),
      threshold,
    );
  }
  return cross(
    predicateDefinition.operator,
    project(readings.gain),
    threshold,
    project(readings.previousGain),
    threshold,
  );
}

/** The whole Signal: every Condition AND the optional Trigger, market and position parts alike. */
export function signalValue(
  signal: OracleSignal,
  row: MarketRow,
  previous: MarketRow | null,
  position: PositionReadings | null,
): Tri {
  const parts: Tri[] = [];
  const evaluate = (
    predicateDefinition: OraclePredicate,
    isTrigger: boolean,
  ): Tri => {
    if (isPositionMetric(predicateDefinition.metric)) {
      if (!position) {
        return "NOT_EVALUABLE";
      }
      return positionPredicate(predicateDefinition, isTrigger, position);
    }
    return marketPredicate(predicateDefinition, isTrigger, row, previous);
  };
  for (const condition of signal.conditions) {
    parts.push(evaluate(condition, false));
  }
  if (signal.trigger) {
    parts.push(evaluate(signal.trigger, true));
  }
  return and(parts);
}

export function gainPercent(close: number, averageCost: number): number {
  if (!finite(close) || !finite(averageCost) || averageCost <= 0) {
    return Number.NaN;
  }
  return ((close - averageCost) / averageCost) * 100;
}
