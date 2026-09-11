import type {
  StrategyCondition,
  StrategySignal,
  StrategyTrigger,
} from "@intrinsic/contracts";
import type { LocalDate, SecurityId } from "@intrinsic/domain";
import {
  MONEY_ZERO,
  quantizeMoney,
  quantizePrice,
  toNumber,
  type MoneyValue,
} from "./backtest/money.js";
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
  /**
   * Shares held, exact.
   *
   * A `Decimal` rather than a number because the persisted scale is ten and the largest quantity
   * the validation matrix produced — 2,415,434,113.5728870 — is seventeen significant digits,
   * already beyond float64. A share count that cannot be represented cannot satisfy
   * `amount == shares x price`.
   */
  shares: MoneyValue;
  /**
   * Basis per share, and the **canonical** cost state of the position.
   *
   * Cost total is derived from this rather than accumulated beside it, which is what makes a
   * partial SELL leave the basis per share unchanged *by construction* instead of by cancellation.
   * Accumulating a cost total and dividing it independently was measured to drift by 3.4e-3 over a
   * thousand partial sells at the $1 contract minimum; carrying the basis directly drifts by zero.
   */
  averageCostValue: MoneyValue;
  /**
   * Total cost of the shares currently held, also canonical.
   *
   * Both are carried because neither alone is sufficient at the extremes. Deriving the basis from
   * an accumulated cost total drifts across partial sells (measured at 3.4e-3 over a thousand
   * cycles at the $1 minimum). Deriving the cost total from an eight-decimal basis loses $10.44 on
   * a 2.4-billion-share, $2.6-billion position, because that is what eight decimals are worth at
   * that share count. So the basis is pinned — a partial sell never moves it — and the cost total
   * is reduced by the cost actually removed, each exact at its own declared scale.
   */
  costTotalValue: MoneyValue;
  /**
   * BUY levels whose allocation opportunity this position lifecycle has consumed.
   *
   * Settled, not "fired": a level lands here in three ways, and only the first is a trade. It
   * filled (fully or as far as the cash went); it was already at or above its target so there was
   * nothing to buy; or a *larger* target was reached in this lifecycle, which supersedes every
   * smaller one. Calling that set "fired" would claim signals happened that did not.
   *
   * The trade log remains the record of what actually executed.
   */
  buyLevelsSettled: Set<string>;
  sellLevelsFired: Set<string>;
  previousSignedReturnPercent?: number;
  previousValueDate?: LocalDate;
  lastPrice: number;
  lastPriceDate: LocalDate;
  realizedPnl: MoneyValue;
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

/**
 * The basis per share as a plain number, for the `Gain` / `Loss` predicates.
 *
 * Those are percentages compared against a Strategy threshold, not ledger values: they are never
 * persisted and never reconciled, so a float is the right representation and the exact basis stays
 * in {@link PositionState.averageCostValue}.
 */
export function averageCost(position: PositionState): number {
  return position.shares.gt(0)
    ? toNumber(position.averageCostValue)
    : Number.NaN;
}

/** The exact basis per share. */
export function averageCostValue(position: PositionState): MoneyValue {
  return position.averageCostValue;
}

/** Total cost of the shares currently held. */
export function costTotal(position: PositionState): MoneyValue {
  return position.costTotalValue;
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

/**
 * Applies a BUY under the AVERAGE_COST policy.
 *
 * Takes the **canonical amount that will be persisted**, not a price to re-multiply: the basis has
 * to be re-averaged from the same value the trade row and the cash mutation use, or the three
 * disagree. Fees are zero in V1 and enter through this seam.
 */
export function applyBuy(
  position: PositionState,
  shares: MoneyValue,
  amount: MoneyValue,
  fees: MoneyValue,
): void {
  position.costTotalValue = quantizeMoney(
    position.costTotalValue.plus(amount).plus(fees),
  );
  position.shares = position.shares.plus(shares);
  position.averageCostValue = quantizePrice(
    position.costTotalValue.div(position.shares),
  );
}

/**
 * Applies a SELL under the AVERAGE_COST policy: shares and cost fall proportionally, so the basis
 * per share is unchanged and `Gain` keeps describing the same position after a partial sell.
 */
export function applySell(
  position: PositionState,
  shares: MoneyValue,
  price: MoneyValue,
  fees: MoneyValue,
): { realizedPnl: MoneyValue; costRemoved: MoneyValue; proceeds: MoneyValue } {
  const closesPosition = shares.gte(position.shares);
  // A full exit removes exactly the whole basis, so the position closes at precisely zero rather
  // than at whatever a proportional calculation happened to leave behind.
  const costRemoved = closesPosition
    ? position.costTotalValue
    : quantizeMoney(position.averageCostValue.times(shares));
  const proceeds = quantizeMoney(price.times(shares));
  position.shares = closesPosition
    ? MONEY_ZERO
    : position.shares.minus(shares);
  position.costTotalValue = closesPosition
    ? MONEY_ZERO
    : quantizeMoney(position.costTotalValue.minus(costRemoved));
  if (closesPosition) {
    position.averageCostValue = MONEY_ZERO;
  }
  // The basis per share is deliberately untouched on a partial sell: that is the AVERAGE_COST
  // policy, and it is why `Gain` keeps describing the same position afterwards.
  const realizedPnl = quantizeMoney(proceeds.minus(costRemoved).minus(fees));
  position.realizedPnl = quantizeMoney(position.realizedPnl.plus(realizedPnl));
  return { realizedPnl, costRemoved, proceeds };
}
