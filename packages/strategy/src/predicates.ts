import {
  IS_CLOSE_TO_TOLERANCE,
  type ConditionOperator,
  type StrategyCondition,
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
 * Evaluates one Condition from two already-resolved numbers.
 *
 * `is above` and `is below` are strict, as `ai/product/strategies.md` states. `is close to` is
 * `abs(metric - value) / abs(value) <= 2%`, with the 2% tolerance owned by `@intrinsic/contracts`
 * so the Builder's help text and this evaluator read one constant. A zero comparison value makes
 * the ratio undefined, which is NOT_EVALUABLE rather than an invented fallback.
 */
export function evaluateConditionValues(
  operator: ConditionOperator,
  metric: number,
  value: number,
): Evaluability {
  if (!Number.isFinite(metric) || !Number.isFinite(value)) {
    return Evaluability.NOT_EVALUABLE;
  }
  switch (operator) {
    case "IS_ABOVE":
      return fromBoolean(metric > value);
    case "IS_BELOW":
      return fromBoolean(metric < value);
    case "IS_CLOSE_TO":
      if (value === 0) {
        return Evaluability.NOT_EVALUABLE;
      }
      return fromBoolean(
        Math.abs(metric - value) / Math.abs(value) <= IS_CLOSE_TO_TOLERANCE,
      );
  }
}

/**
 * Evaluates one Trigger from the current and previous resolved values.
 *
 * A Trigger is an event: it needs `t` and the immediately preceding eligible value of the same
 * series. If any of the four values is unavailable the Trigger is NOT_EVALUABLE — the evaluator
 * never searches backwards for a substitute.
 */
export function evaluateTriggerValues(
  operator: TriggerOperator,
  metric: number,
  value: number,
  previousMetric: number,
  previousValue: number,
): Evaluability {
  if (
    !Number.isFinite(metric) ||
    !Number.isFinite(value) ||
    !Number.isFinite(previousMetric) ||
    !Number.isFinite(previousValue)
  ) {
    return Evaluability.NOT_EVALUABLE;
  }
  switch (operator) {
    case "CROSSES_ABOVE":
      return fromBoolean(metric > value && previousMetric <= previousValue);
    case "CROSSES_BELOW":
      return fromBoolean(metric < value && previousMetric >= previousValue);
  }
}

/** Resolves the right-hand side of a predicate at one frame index. */
function resolveValue(
  value: StrategyValue,
  frame: EvaluationFrame,
  index: number,
): number {
  if (value.kind === "SERIES") {
    const key = valueOperand(value);
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
    resolveValue(condition.value, frame, index),
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
  return evaluateTriggerValues(
    trigger.operator,
    readOperand(frame, key, index),
    resolveValue(trigger.value, frame, index),
    readOperand(frame, key, index - 1),
    resolveValue(trigger.value, frame, index - 1),
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
