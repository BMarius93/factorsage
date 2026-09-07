import type {
  StrategyCondition,
  StrategySignal,
  StrategyTrigger,
} from "@intrinsic/contracts";
import type { LocalDate, SecurityId } from "@intrinsic/domain";
import { Evaluability, evaluabilityAll } from "./evaluability.js";
import { isPositionDependentMetric } from "./operands.js";
import {
  evaluateConditionValues,
  evaluateTriggerValues,
} from "./predicates.js";

/**
 * Simulated state of one open position.
 *
 * `epoch` increments each time a position is opened for a security. It is what stops a
 * closed-and-reopened position inheriting the previous one's history: without it a
 * `Loss crosses above 10%` could fire on a new position's first day by comparing against the old
 * position's loss.
 *
 * `previousSignedReturnPercent` is the value that **actually held** on the previous eligible
 * trading day, recorded when it was computed rather than recalculated from today's basis.
 */
export type PositionState = {
  securityId: SecurityId;
  symbol: string;
  name: string;
  epoch: number;
  openedDate: LocalDate;
  shares: number;
  /** Total cost of the shares currently held, under the AVERAGE_COST policy. */
  costTotal: number;
  buyLevelsFired: Set<string>;
  sellLevelsFired: Set<string>;
  previousSignedReturnPercent?: number;
  previousValueDate?: LocalDate;
  lastPrice: number;
  lastPriceDate: LocalDate;
  realizedPnl: number;
};

/**
 * How average cost evolves across repeated BUYs and partial SELLs inside one position lifecycle.
 *
 * `ai/product/strategies.md` fixes the Strategy-facing basis as **average cost**; how it evolves is
 * execution behaviour and therefore belongs to the engine, versioned in the run snapshot. Under
 * `AVERAGE_COST` a partial SELL reduces shares and cost proportionally, so the basis per share is
 * unchanged by a partial sell — which matches a product whose SELL percentage is a fraction of the
 * remaining position rather than a lot.
 */
export const COST_BASIS_POLICY = "AVERAGE_COST" as const;

export type CostBasisPolicyId = typeof COST_BASIS_POLICY;

export function averageCost(position: PositionState): number {
  return position.shares > 0
    ? position.costTotal / position.shares
    : Number.NaN;
}

/** `Gain = (Price - AverageCost) / AverageCost * 100`. Signed, never below -100 for a long position. */
export function gainPercent(close: number, basis: number): number {
  if (!Number.isFinite(close) || !Number.isFinite(basis) || basis <= 0) {
    return Number.NaN;
  }
  return ((close - basis) / basis) * 100;
}

/**
 * `Loss = max(0, (AverageCost - Price) / AverageCost * 100)`.
 *
 * Deliberately not the unclamped mirror of Gain: `Loss is above 10%` must read exactly as "the
 * price is more than 10% below average cost".
 */
export function lossPercent(close: number, basis: number): number {
  const gain = gainPercent(close, basis);
  return Number.isFinite(gain) ? Math.max(0, -gain) : Number.NaN;
}

/** Everything a position-dependent predicate needs on one date. */
export type PositionEvaluationContext = {
  /** Close of the evaluated date; `NaN` when the security has no row that day. */
  close: number;
  position: PositionState;
  /** The security's own previous eligible trading day, or undefined at the start of its frame. */
  previousDate?: LocalDate;
};

function currentSignedReturn(context: PositionEvaluationContext): number {
  return gainPercent(context.close, averageCost(context.position));
}

/**
 * The previous value of the position metric, available only when the same position was open on the
 * security's immediately preceding eligible trading day.
 */
function previousSignedReturn(context: PositionEvaluationContext): number {
  const { position, previousDate } = context;
  if (
    previousDate === undefined ||
    position.previousValueDate === undefined ||
    position.previousValueDate !== previousDate ||
    position.previousSignedReturnPercent === undefined
  ) {
    return Number.NaN;
  }
  return position.previousSignedReturnPercent;
}

function metricValue(kind: "GAIN" | "LOSS", signedReturn: number): number {
  if (!Number.isFinite(signedReturn)) {
    return Number.NaN;
  }
  return kind === "GAIN" ? signedReturn : Math.max(0, -signedReturn);
}

export function evaluatePositionCondition(
  condition: StrategyCondition,
  context: PositionEvaluationContext,
): Evaluability {
  const kind = condition.metric.kind;
  if (kind !== "GAIN" && kind !== "LOSS") {
    return Evaluability.NOT_EVALUABLE;
  }
  if (condition.value.kind === "SERIES") {
    // A position metric never compares against a market series; the canonical registry rejects it.
    return Evaluability.NOT_EVALUABLE;
  }
  return evaluateConditionValues(
    condition.operator,
    metricValue(kind, currentSignedReturn(context)),
    condition.value.value,
  );
}

export function evaluatePositionTrigger(
  trigger: StrategyTrigger,
  context: PositionEvaluationContext,
): Evaluability {
  const kind = trigger.metric.kind;
  if (kind !== "GAIN" && kind !== "LOSS") {
    return Evaluability.NOT_EVALUABLE;
  }
  if (trigger.value.kind === "SERIES") {
    return Evaluability.NOT_EVALUABLE;
  }
  return evaluateTriggerValues(
    trigger.operator,
    metricValue(kind, currentSignedReturn(context)),
    trigger.value.value,
    metricValue(kind, previousSignedReturn(context)),
    trigger.value.value,
  );
}

/**
 * The position-dependent half of one Signal.
 *
 * Every position-dependent predicate is evaluated even when the market gate is already FALSE:
 * short-circuiting would give the same level result but would leave per-predicate diagnostics
 * counting different day sets for the market and position halves.
 */
export function evaluatePositionSignal(
  signal: StrategySignal,
  context: PositionEvaluationContext,
): Evaluability {
  const results: Evaluability[] = [];
  for (const condition of signal.conditions) {
    if (isPositionDependentMetric(condition.metric)) {
      results.push(evaluatePositionCondition(condition, context));
    }
  }
  if (signal.trigger && isPositionDependentMetric(signal.trigger.metric)) {
    results.push(evaluatePositionTrigger(signal.trigger, context));
  }
  return evaluabilityAll(results);
}

/** Applies a BUY under the AVERAGE_COST policy. Fees are zero in V1 and enter through this seam. */
export function applyBuy(
  position: PositionState,
  shares: number,
  price: number,
  fees: number,
): void {
  position.shares += shares;
  position.costTotal += shares * price + fees;
}

/**
 * Applies a SELL under the AVERAGE_COST policy: shares and cost fall proportionally, so the basis
 * per share is unchanged and `Gain` keeps describing the same position after a partial sell.
 */
export function applySell(
  position: PositionState,
  shares: number,
  price: number,
  fees: number,
): { realizedPnl: number; costRemoved: number } {
  const basis = averageCost(position);
  const costRemoved = Number.isFinite(basis) ? basis * shares : 0;
  position.shares = Math.max(0, position.shares - shares);
  position.costTotal =
    position.shares === 0 ? 0 : position.costTotal - costRemoved;
  const realizedPnl = shares * price - costRemoved - fees;
  position.realizedPnl += realizedPnl;
  return { realizedPnl, costRemoved };
}
