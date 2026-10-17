import {
  IS_CLOSE_TO_TOLERANCE,
  strategyMetricSource,
  type ConditionOperator,
  type StrategyCondition,
  type StrategyMetricSource,
  type StrategySignal,
  type StrategyTrigger,
  type StrategyValue,
  type TriggerOperator,
} from "@intrinsic/contracts";
import { Evaluability, evaluabilityAll, fromBoolean } from "./evaluability.js";
import { readOperand, type EvaluationFrame } from "./frame.js";
import {
  isPositionDependentMetric,
  metricOperand,
  valueOperand,
} from "./operands.js";

/**
 * An operator this engine does not define reached evaluation.
 *
 * Unreachable for a validated document, but a run snapshot is executed after an upcast and never
 * revalidated (`AGENTS.md` invariant 12), so a document naming an operator the product no longer has
 * could arrive here. It must stop the run: the alternative — returning nothing — reads as TRUE under
 * `evaluabilityAnd` and would make the rule silently always hold.
 */
export class UnsupportedStrategyOperatorError extends Error {
  constructor(operator: unknown) {
    super(`Unsupported strategy operator: ${String(operator)}`);
    this.name = "UnsupportedStrategyOperatorError";
  }
}

/**
 * Evaluates one Condition from two already-resolved numbers.
 *
 * `is above` and `is below` are strict — `>` and `<` — as `ai/product/strategies.md` states, and
 * there is no inclusive form. `is close to` is `abs(metric - value) / abs(value) <= 2%`, inclusive
 * and decided as decimals (`isCloseTo`), with the 2%
 * tolerance owned by `@intrinsic/contracts` so the Builder's help text and this evaluator read one
 * constant. A zero comparison value makes the ratio undefined, which is NOT_EVALUABLE rather than an
 * invented fallback.
 *
 * The operator is judged before the numbers, so an operator this engine does not define stops the
 * run on the first session it is evaluated at — not only once its data first happens to exist, which
 * for a rule whose data never resolves would be never.
 */
export function evaluateConditionValues(
  operator: ConditionOperator,
  metric: number,
  value: number,
): Evaluability {
  switch (operator) {
    case "IS_ABOVE":
      return bothResolved(metric, value)
        ? fromBoolean(metric > value)
        : Evaluability.NOT_EVALUABLE;
    case "IS_BELOW":
      return bothResolved(metric, value)
        ? fromBoolean(metric < value)
        : Evaluability.NOT_EVALUABLE;
    case "IS_CLOSE_TO":
      return bothResolved(metric, value) && value !== 0
        ? fromBoolean(isCloseTo(metric, value))
        : Evaluability.NOT_EVALUABLE;
    default:
      throw new UnsupportedStrategyOperatorError(operator);
  }
}

/**
 * How far past the exact 2% boundary a binary result may sit and still be the boundary itself,
 * relative to the allowed distance.
 *
 * The operands are decimals: stored at eight decimal places, or typed by the user. Their binary
 * doubles are not exact, so a pair that is exactly 2% apart in decimal can land a few units in the
 * last place on either side of the tolerance. 30.6 against 30 computed 0.0200000000000000466 and
 * read as outside, while 102 against 100 read as inside (PRED-01). The rounding error of
 * `abs(metric - value)` against `0.02 * abs(value)` is about 1e-14 of the allowed distance, so
 * 1e-12 absorbs it a hundredfold. A real eight-decimal difference from the boundary is at least
 * 1e-8, which exceeds this slack for every comparison value below 500,000.
 */
const CLOSE_TO_BOUNDARY_SLACK = 1e-12;

/**
 * `abs(metric - value) <= 2% of abs(value)`, inclusive, decided as the decimals the operands
 * represent (`ai/product/strategies.md`, "is close to"). The caller has already refused a zero or an
 * unresolved `value`.
 */
export function isCloseTo(metric: number, value: number): boolean {
  const allowed = IS_CLOSE_TO_TOLERANCE * Math.abs(value);
  return (
    Math.abs(metric - value) <= allowed + allowed * CLOSE_TO_BOUNDARY_SLACK
  );
}

/**
 * Evaluates one Trigger from the current and previous resolved values.
 *
 * A Trigger is an event: it needs `t` and the immediately preceding eligible value of the same
 * series. If any of the four values is unavailable the Trigger is NOT_EVALUABLE — the evaluator
 * never searches backwards for a substitute. As for a Condition, the operator is judged first.
 */
export function evaluateTriggerValues(
  operator: TriggerOperator,
  metric: number,
  value: number,
  previousMetric: number,
  previousValue: number,
): Evaluability {
  switch (operator) {
    case "CROSSES_ABOVE":
      return bothResolved(metric, value) &&
        bothResolved(previousMetric, previousValue)
        ? fromBoolean(metric > value && previousMetric <= previousValue)
        : Evaluability.NOT_EVALUABLE;
    case "CROSSES_BELOW":
      return bothResolved(metric, value) &&
        bothResolved(previousMetric, previousValue)
        ? fromBoolean(metric < value && previousMetric >= previousValue)
        : Evaluability.NOT_EVALUABLE;
    default:
      throw new UnsupportedStrategyOperatorError(operator);
  }
}

/** Whether both sides of a comparison resolved; either one missing leaves it NOT_EVALUABLE. */
function bothResolved(metric: number, value: number): boolean {
  return Number.isFinite(metric) && Number.isFinite(value);
}

/**
 * Resolves the right-hand side of a predicate at one frame index.
 *
 * `source` is the predicate metric's own data source: a `SERIES` Value compares with the same
 * instrument its Metric reads, so an ETF-sourced condition resolves both sides from the same ETF's
 * columns and a stock one from the security's.
 */
function resolveValue(
  value: StrategyValue,
  source: StrategyMetricSource | undefined,
  frame: EvaluationFrame,
  index: number,
): number {
  if (value.kind === "SERIES") {
    const key = valueOperand(value, source);
    return key === null ? Number.NaN : readOperand(frame, key, index);
  }
  return value.value;
}

/** Whether a predicate can be decided from market history alone. */
export function isMarketDerivedPredicate(
  predicate: StrategyCondition | StrategyTrigger,
): boolean {
  return !isPositionDependentMetric(predicate.metric);
}

export function evaluateMarketCondition(
  condition: StrategyCondition,
  frame: EvaluationFrame,
  index: number,
): Evaluability {
  const key = metricOperand(condition.metric);
  if (key === null) {
    return Evaluability.NOT_EVALUABLE;
  }
  return evaluateConditionValues(
    condition.operator,
    readOperand(frame, key, index),
    resolveValue(
      condition.value,
      strategyMetricSource(condition.metric),
      frame,
      index,
    ),
  );
}

export function evaluateMarketTrigger(
  trigger: StrategyTrigger,
  frame: EvaluationFrame,
  index: number,
): Evaluability {
  const key = metricOperand(trigger.metric);
  if (key === null || index <= 0) {
    // At frame index 0 there is no previous eligible value, so every Trigger is NOT_EVALUABLE.
    return Evaluability.NOT_EVALUABLE;
  }
  const source = strategyMetricSource(trigger.metric);
  return evaluateTriggerValues(
    trigger.operator,
    readOperand(frame, key, index),
    resolveValue(trigger.value, source, frame, index),
    readOperand(frame, key, index - 1),
    resolveValue(trigger.value, source, frame, index - 1),
  );
}

/**
 * The market-derived half of one Signal on one date.
 *
 * Position-dependent predicates are excluded and evaluated live against simulated state; a Signal
 * with no market-derived predicate is vacuously TRUE here by the empty-conjunction rule.
 */
export function evaluateMarketSignal(
  signal: StrategySignal,
  frame: EvaluationFrame,
  index: number,
): Evaluability {
  const results: Evaluability[] = [];
  for (const condition of signal.conditions) {
    if (isMarketDerivedPredicate(condition)) {
      results.push(evaluateMarketCondition(condition, frame, index));
    }
  }
  if (signal.trigger && isMarketDerivedPredicate(signal.trigger)) {
    results.push(evaluateMarketTrigger(signal.trigger, frame, index));
  }
  return evaluabilityAll(results);
}

/**
 * What one predicate read on one date, for the record a Monitor keeps of why a lifecycle changed
 * (`docs/decisions/monitor-eod-v2.md` §5).
 *
 * The numbers are the exact operands the evaluator compared — the same `readOperand` and value
 * resolution, the same comparison — so a stored explanation can never disagree with the decision it
 * explains. An operand that did not resolve is `null`, never zero.
 */
export type PredicateEvidence = {
  id: string;
  role: "CONDITION" | "TRIGGER";
  result: "TRUE" | "FALSE" | "NOT_EVALUABLE";
  metric: number | null;
  value: number | null;
  /** A Trigger's previous-session operands. */
  previousMetric?: number | null;
  previousValue?: number | null;
};

/** The market-derived predicates of one Signal on one date, each with the operands it compared. */
export function explainMarketSignal(
  signal: StrategySignal,
  frame: EvaluationFrame,
  index: number,
): PredicateEvidence[] {
  const evidence: PredicateEvidence[] = [];
  for (const condition of signal.conditions) {
    if (!isMarketDerivedPredicate(condition)) {
      continue;
    }
    const key = metricOperand(condition.metric);
    const metric = key === null ? Number.NaN : readOperand(frame, key, index);
    const value = resolveValue(
      condition.value,
      strategyMetricSource(condition.metric),
      frame,
      index,
    );
    evidence.push({
      id: condition.id,
      role: "CONDITION",
      result: evaluabilityName(
        evaluateMarketCondition(condition, frame, index),
      ),
      metric: finiteOrNull(metric),
      value: finiteOrNull(value),
    });
  }
  const trigger = signal.trigger;
  if (trigger && isMarketDerivedPredicate(trigger)) {
    const key = metricOperand(trigger.metric);
    const source = strategyMetricSource(trigger.metric);
    const at = (position: number): { metric: number; value: number } =>
      key === null || position < 0
        ? { metric: Number.NaN, value: Number.NaN }
        : {
            metric: readOperand(frame, key, position),
            value: resolveValue(trigger.value, source, frame, position),
          };
    const now = at(index);
    const previous = at(index - 1);
    evidence.push({
      id: trigger.id,
      role: "TRIGGER",
      result: evaluabilityName(evaluateMarketTrigger(trigger, frame, index)),
      metric: finiteOrNull(now.metric),
      value: finiteOrNull(now.value),
      previousMetric: finiteOrNull(previous.metric),
      previousValue: finiteOrNull(previous.value),
    });
  }
  return evidence;
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function evaluabilityName(value: Evaluability): PredicateEvidence["result"] {
  return value === Evaluability.TRUE
    ? "TRUE"
    : value === Evaluability.FALSE
      ? "FALSE"
      : "NOT_EVALUABLE";
}
