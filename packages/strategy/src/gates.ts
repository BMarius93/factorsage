import type { StrategyDefinition, StrategySignal } from "@intrinsic/contracts";
import { Evaluability } from "./evaluability.js";
import type { EvaluationFrame } from "./frame.js";
import { evaluateMarketSignal } from "./predicates.js";

/**
 * The precomputed market-derived result of one level over one security's whole frame.
 *
 * This is the product's "logical daily result series", materialized once per level per security so
 * the portfolio day loop reads an indexed byte instead of re-evaluating predicates. At one byte per
 * trading day it costs about 7.5 KB per level per security over thirty years.
 */
export type MarketGate = Uint8Array;

export function buildMarketGate(
  signal: StrategySignal,
  frame: EvaluationFrame,
): MarketGate {
  const gate = new Uint8Array(frame.dates.length);
  for (let index = 0; index < frame.dates.length; index += 1) {
    gate[index] = evaluateMarketSignal(signal, frame, index);
  }
  return gate;
}

/**
 * Every gate one strategy version needs for one security, keyed by level id.
 *
 * BUY levels are fully decided here: the product forbids Gain/Loss in BUY rules, so a BUY signal is
 * completely precomputable. SELL and FINAL EXIT gates carry only their market-derived half and are
 * ANDed with live position predicates while a position is open. FINAL EXIT keeps one gate per Exit
 * Rule, because each rule is ANDed with its own position half before the rules are ORed.
 */
export type StrategyGates = {
  buy: ReadonlyMap<string, MarketGate>;
  sell: ReadonlyMap<string, MarketGate>;
  /**
   * One gate per FINAL EXIT Exit Rule, in definition order, or null when the strategy has no
   * FINAL EXIT.
   *
   * Per rule rather than one combined gate, because the rules are ORed *after* each has been ANDed
   * with its own position-dependent half. Pre-combining the market halves would produce
   * `(marketA OR marketB) AND (positionA AND positionB)`, which is a different — and wrong —
   * strategy: it would let rule 1's market conditions satisfy rule 2's trigger.
   */
  finalExit: readonly MarketGate[] | null;
};

export function buildStrategyGates(
  definition: StrategyDefinition,
  frame: EvaluationFrame,
): StrategyGates {
  const buy = new Map<string, MarketGate>();
  for (const level of definition.buyLevels) {
    buy.set(level.id, buildMarketGate(level.signal, frame));
  }
  const sell = new Map<string, MarketGate>();
  for (const level of definition.sellLevels) {
    sell.set(level.id, buildMarketGate(level.signal, frame));
  }
  return {
    buy,
    sell,
    finalExit:
      definition.finalExit?.rules.map((rule) =>
        buildMarketGate(rule.signal, frame),
      ) ?? null,
  };
}

export function readGate(
  gate: MarketGate | undefined,
  index: number,
): Evaluability {
  if (!gate || index < 0 || index >= gate.length) {
    return Evaluability.NOT_EVALUABLE;
  }
  return (gate[index] ?? Evaluability.NOT_EVALUABLE) as Evaluability;
}
