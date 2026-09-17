import {
  strategyFinalExitFingerprint,
  strategySignalFingerprint,
  type StrategyDefinition,
  type StrategySignal,
} from "@intrinsic/contracts";
import {
  Evaluability,
  evaluabilityAnd,
  evaluabilityAny,
} from "./evaluability.js";
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

/**
 * One Strategy level as a Monitor addresses it.
 *
 * `rules` is the level's complete logic as a disjunction: BUY and SELL always carry exactly one
 * Signal, and FINAL EXIT carries its Exit Rules in definition order. Modelling every level as a
 * one-or-more list rather than branching on kind is what keeps the Monitor cycle free of a FINAL
 * EXIT special case — it evaluates, fingerprints and reports all three families identically.
 *
 * `fingerprint` and `hasTrigger` are resolved here rather than by each caller, so the durable
 * transition state and the API's view of a level cannot develop separate opinions about when a
 * level's logic changed or whether its match is an event.
 */
export type MonitorStrategyLevel = {
  id: string;
  kind: "BUY" | "SELL" | "FINAL_EXIT";
  /** The level's alternatives, ORed. Always at least one. */
  rules: readonly StrategySignal[];
  /**
   * The identity each alternative's rule-local lifecycle is stored under, parallel to `rules`:
   * the level id for BUY and SELL, each Exit Rule's own id for FINAL EXIT.
   */
  ruleIds: readonly string[];
  /** The canonical id-free serialization of this level's whole logic. */
  fingerprint: string;
  /**
   * Whether a match of this level is an **event** on one observation date rather than a state that
   * persists.
   *
   * A level is an event exactly when **every** alternative is triggered. Mixed FINAL EXIT — one
   * rule with a Trigger, one without — is a state, because the condition-only rule can stay true
   * for days and event semantics would re-emit a Signal for it on every session. A single-rule
   * level is unchanged: this is `signal.trigger !== undefined`, as it always was.
   */
  hasTrigger: boolean;
};

/**
 * The levels of a Strategy definition a Monitor evaluates, in canonical order — BUY levels, SELL
 * levels, FINAL EXIT.
 *
 * A Monitor reports a Signal for any of the Strategy's canonical levels, so it walks all three
 * families. The order is the definition's own, so two cycles over one definition address levels
 * identically. FINAL EXIT is **one** level however many Exit Rules it holds: its alternatives are
 * ways for one action to match, not separate levels, so they share one id, one durable state row
 * and one Signal lifecycle.
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
    rules: readonly StrategySignal[],
    ruleIds: readonly string[],
    fingerprint: string,
  ) => {
    // Whole-level, and for a disjunction that means *any* alternative: dropping a Gain-dependent
    // Exit Rule from `(Price < EMA200) OR (Gain > 20%)` would leave a rule that matches on strictly
    // fewer days than the user wrote, and a Monitor reporting "no match" from a subset of someone's
    // logic is the same misreport as evaluating half a conjunction.
    if (rules.some(signalNeedsPositionState)) {
      return;
    }
    levels.push({
      id,
      kind,
      rules,
      ruleIds,
      fingerprint,
      hasTrigger: rules.every((signal) => signal.trigger !== undefined),
    });
  };

  for (const level of definition.buyLevels) {
    add(
      level.id,
      "BUY",
      [level.signal],
      [level.id],
      strategySignalFingerprint(level.signal),
    );
  }
  for (const level of definition.sellLevels) {
    add(
      level.id,
      "SELL",
      [level.signal],
      [level.id],
      strategySignalFingerprint(level.signal),
    );
  }
  if (definition.finalExit) {
    add(
      definition.finalExit.id,
      "FINAL_EXIT",
      definition.finalExit.rules.map((rule) => rule.signal),
      definition.finalExit.rules.map((rule) => rule.id),
      strategyFinalExitFingerprint(definition.finalExit),
    );
  }
  return levels;
}

/**
 * One whole level on one frame index, evaluated without a position: its alternatives, ORed.
 *
 * FINAL EXIT remains **one** level producing **one** result, so two Exit Rules matching on the same
 * observation are one match, not two. There is nothing to deduplicate downstream because nothing
 * downstream ever sees more than one answer.
 *
 * Each alternative is evaluated in full — no short-circuit — so a level's result does not depend on
 * the order its rules happen to be written in, and `NOT_EVALUABLE` is only reported when no rule
 * was decidably TRUE.
 */
export function evaluateLevelWithoutPosition(
  rules: readonly StrategySignal[],
  frame: EvaluationFrame,
  index: number,
): Evaluability {
  return evaluabilityAny(
    rules.map((signal) => evaluateSignalWithoutPosition(signal, frame, index)),
  );
}
