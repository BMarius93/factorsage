import type {
  StrategyDefinition,
  StrategySignal,
} from "@intrinsic/contracts";
import { Evaluability, evaluabilityAnd } from "./evaluability.js";
import type { EvaluationFrame } from "./frame.js";
import { isMarketDerivedPredicate, evaluateMarketSignal } from "./predicates.js";

/**
 * Evaluating a canonical Strategy Signal with **no position state**.
 *
 * A Monitor evaluates the same Strategy language as a backtest, against current data instead of a
 * simulated portfolio (`ai/product/monitors.md`). It therefore has no position, no average cost and
 * no position epoch — so `Gain` and `Loss` have nothing to be measured against.
 *
 * `ai/product/strategies.md` already decides what that means: a predicate is `NOT_EVALUABLE` when
 * the market data, derived data, previous trigger value **or position state** it needs is
 * unavailable. This module applies that existing rule; it does not define a second one. Every
 * operator, tolerance, crossing definition and evaluability rule still comes from `predicates.ts`.
 */

/** Whether this Signal needs simulated position state to be decided at all. */
export function signalNeedsPositionState(signal: StrategySignal): boolean {
  for (const condition of signal.conditions) {
    if (!isMarketDerivedPredicate(condition)) {
      return true;
    }
  }
  return signal.trigger !== undefined && !isMarketDerivedPredicate(signal.trigger);
}

/**
 * One Signal on one frame index, evaluated without a position.
 *
 * The market-derived half is the canonical `evaluateMarketSignal`. Every position-dependent
 * predicate contributes `NOT_EVALUABLE`, ANDed in with the same Kleene algebra the backtest uses —
 * which is why a Signal whose market half is definitively FALSE still reports FALSE rather than
 * overstating the gap, and why a Signal that consists only of Gain/Loss can never match here.
 *
 * Without this the empty-conjunction rule would make such a Signal vacuously TRUE: `evaluateMarketSignal`
 * deliberately skips position-dependent predicates because the backtest day loop ANDs them in
 * afterwards against live position state. A Monitor has no such second half, so it must supply the
 * missing operand's evaluability itself instead of inheriting a vacuous TRUE.
 */
export function evaluateSignalWithoutPosition(
  signal: StrategySignal,
  frame: EvaluationFrame,
  index: number,
): Evaluability {
  const market = evaluateMarketSignal(signal, frame, index);
  if (!signalNeedsPositionState(signal)) {
    return market;
  }
  return evaluabilityAnd(market, Evaluability.NOT_EVALUABLE);
}

/** One Strategy level as a Monitor addresses it: canonical id, kind, and the Signal to evaluate. */
export type MonitorStrategyLevel = {
  id: string;
  kind: "BUY" | "SELL" | "FINAL_EXIT";
  signal: StrategySignal;
};

/**
 * Every level of a Strategy definition in canonical order — BUY levels, SELL levels, FINAL EXIT.
 *
 * A Monitor reports a Signal for any of the Strategy's canonical levels, so it walks all three
 * families. The order is the definition's own, so two cycles over one definition address levels
 * identically.
 */
export function monitorStrategyLevels(
  definition: StrategyDefinition,
): MonitorStrategyLevel[] {
  const levels: MonitorStrategyLevel[] = [];
  for (const level of definition.buyLevels) {
    levels.push({ id: level.id, kind: "BUY", signal: level.signal });
  }
  for (const level of definition.sellLevels) {
    levels.push({ id: level.id, kind: "SELL", signal: level.signal });
  }
  if (definition.finalExit) {
    levels.push({
      id: definition.finalExit.id,
      kind: "FINAL_EXIT",
      signal: definition.finalExit.signal,
    });
  }
  return levels;
}
