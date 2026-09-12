import type {
  StrategyDefinition,
  StrategySignal,
} from "@intrinsic/contracts";
import { Evaluability, evaluabilityAnd } from "./evaluability.js";
import type { EvaluationFrame } from "./frame.js";
import { isMarketDerivedPredicate, evaluateMarketSignal } from "./predicates.js";

/**
 * Which levels of a canonical Strategy a Monitor evaluates, and how it evaluates one.
 *
 * A Monitor evaluates the same Strategy language as a backtest, against current data instead of a
 * simulated portfolio (`ai/product/monitors.md`). It therefore has no position, no average cost, no
 * cost basis and no position epoch — so `Gain` and `Loss` are not Monitor-supported metrics at all.
 *
 * **A level whose logic depends on one of them is outside Monitor evaluation**, not a Monitor
 * metric that happens to be undecidable. `monitorStrategyLevels` does not return it, so no cycle
 * evaluates it, no Signal is produced for it, and no transition state is written as though it had
 * been attempted. `NOT_EVALUABLE` keeps its own, different meaning: a *Monitor-supported* metric
 * whose market or derived input was unavailable.
 *
 * The distinction is whole-level on purpose. Dropping only the Gain condition from
 * `Price < EMA200 AND Gain > 20%` would evaluate `Price < EMA200`, which is a different rule than
 * the user wrote and would emit Signals the Strategy never asked for.
 *
 * Backtest semantics are untouched: the day loop still evaluates Gain and Loss against live
 * position state through `position.ts`. A Strategy using them stays canonical and may be attached
 * to a Monitor; only what the Monitor *evaluates* is narrower.
 *
 * Every operator, tolerance, crossing definition and evaluability rule still comes from
 * `predicates.ts`, and what counts as position-dependent comes from `isPositionDependentMetric` in
 * `operands.ts` — there is no second list of metric names here.
 */

/**
 * Whether this Signal needs simulated position state to be decided at all.
 *
 * Covers the whole V1 Signal grammar: the ANDed Conditions and the at-most-one optional Trigger.
 * There are no nested boolean groups to walk (`AGENTS.md` invariant 11), so a Signal is
 * position-dependent exactly when one of those predicates is.
 */
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
 * The market-derived half is the canonical `evaluateMarketSignal`, and that is all a Monitor ever
 * needs: `monitorStrategyLevels` has already excluded every level that depends on position state,
 * so a Signal reaching here is fully market-derived.
 *
 * The position-dependent branch is therefore unreachable through the canonical path, and is kept
 * deliberately rather than removed. `evaluateMarketSignal` *skips* position-dependent predicates —
 * the backtest day loop ANDs them in afterwards against live position state — so the
 * empty-conjunction rule would make a Gain/Loss-only Signal vacuously TRUE and match every
 * monitored symbol on every scan. A caller that ever reached this function without filtering first
 * gets `NOT_EVALUABLE` instead of that.
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
 * The levels of a Strategy definition a Monitor evaluates, in canonical order — BUY levels, SELL
 * levels, FINAL EXIT.
 *
 * A Monitor reports a Signal for any of the Strategy's canonical levels, so it walks all three
 * families. The order is the definition's own, so two cycles over one definition address levels
 * identically.
 *
 * **Levels whose logic depends on `Gain` or `Loss` are omitted entirely.** A Monitor holds no
 * position, so those metrics are not part of what it evaluates; a level built on one is skipped
 * rather than attempted and recorded as undecidable. Omitting it here is what makes that true
 * everywhere at once: it is the single list the cycle both evaluates and reports as the visited set,
 * so an excluded level is also treated as absent by the unvisited-Signal reconciliation — which is
 * exactly the lifecycle a level removed from the Strategy already gets.
 *
 * A Strategy is never rejected for containing them, and the levels that do not depend on them
 * continue to evaluate normally.
 */
export function monitorStrategyLevels(
  definition: StrategyDefinition,
): MonitorStrategyLevel[] {
  const levels: MonitorStrategyLevel[] = [];
  const add = (
    id: string,
    kind: MonitorStrategyLevel["kind"],
    signal: StrategySignal,
  ) => {
    if (signalNeedsPositionState(signal)) {
      return;
    }
    levels.push({ id, kind, signal });
  };

  for (const level of definition.buyLevels) {
    add(level.id, "BUY", level.signal);
  }
  for (const level of definition.sellLevels) {
    add(level.id, "SELL", level.signal);
  }
  if (definition.finalExit) {
    add(definition.finalExit.id, "FINAL_EXIT", definition.finalExit.signal);
  }
  return levels;
}
