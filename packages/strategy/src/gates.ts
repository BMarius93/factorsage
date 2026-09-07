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
 * ANDed with live position predicates while a position is open.
 */
export type StrategyGates = {
  buy: ReadonlyMap<string, MarketGate>;
  sell: ReadonlyMap<string, MarketGate>;
  finalExit: MarketGate | null;
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
    finalExit: definition.finalExit
      ? buildMarketGate(definition.finalExit.signal, frame)
      : null,
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
