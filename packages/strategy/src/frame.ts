import type { LocalDate, SecurityId } from "@intrinsic/domain";
import { PRICE_OPERAND, type OperandKey } from "./operands.js";

/**
 * One security's operand values, projected once per run into compact columns.
 *
 * `NaN` is the single representation of an absent value. It is safe because every calculator in
 * the repository rejects non-finite inputs and the Prisma store already hands out JS doubles, so a
 * `Float64Array` introduces no precision the system does not already have.
 *
 * `dates` is ascending and holds exactly the eligible trading days of **this** security. There is
 * no market-wide calendar in the repository, so a portfolio loop forms the union of these axes.
 * `periodStartIndex` is the first index inside the requested backtest period: earlier rows exist
 * only to give a Trigger its `t - 1` value and must never produce an action.
 */
export type EvaluationFrame = {
  securityId: SecurityId;
  symbol: string;
  name: string;
  dates: readonly LocalDate[];
  /** Canonical end-of-day closes, aligned with `dates`. */
  closes: Float64Array;
  /** Every other projected operand column, aligned with `dates`. */
  columns: ReadonlyMap<OperandKey, Float64Array>;
  periodStartIndex: number;
};

/** Reads one operand at one frame index. Returns `NaN` when the value is unavailable. */
export function readOperand(
  frame: EvaluationFrame,
  key: OperandKey,
  index: number,
): number {
  if (index < 0 || index >= frame.dates.length) {
    return Number.NaN;
  }
  if (key === PRICE_OPERAND) {
    return frame.closes[index] ?? Number.NaN;
  }
  const column = frame.columns.get(key);
  if (!column) {
    return Number.NaN;
  }
  return column[index] ?? Number.NaN;
}

/**
 * Index of `date` in the frame, or -1 when this security did not trade that day.
 *
 * A portfolio loop walks the union calendar and asks each frame for its own index, so a missing
 * date is an ordinary answer, not an error: the security's predicates are simply NOT_EVALUABLE and
 * it takes no action.
 */
export function frameIndexOf(frame: EvaluationFrame, date: LocalDate): number {
  let low = 0;
  let high = frame.dates.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = frame.dates[middle] as LocalDate;
    if (candidate === date) {
      return middle;
    }
    if (candidate < date) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return -1;
}

/** Builds a frame, guarding the invariants the evaluator relies on rather than assuming them. */
export function createEvaluationFrame(input: {
  securityId: SecurityId;
  symbol: string;
  name: string;
  dates: readonly LocalDate[];
  closes: Float64Array;
  columns?: ReadonlyMap<OperandKey, Float64Array>;
  periodStartIndex: number;
}): EvaluationFrame {
  const { dates, closes } = input;
  if (closes.length !== dates.length) {
    throw new Error(
      `Evaluation frame for ${input.symbol} has ${closes.length} closes for ${dates.length} dates`,
    );
  }
  for (let index = 1; index < dates.length; index += 1) {
    if ((dates[index] as LocalDate) <= (dates[index - 1] as LocalDate)) {
      throw new Error(
        `Evaluation frame for ${input.symbol} is not strictly ascending at index ${index}`,
      );
    }
  }
  const columns = input.columns ?? new Map<OperandKey, Float64Array>();
  for (const [key, column] of columns) {
    if (column.length !== dates.length) {
      throw new Error(
        `Evaluation frame column '${key}' for ${input.symbol} has ${column.length} values for ${dates.length} dates`,
      );
    }
  }
  return {
    securityId: input.securityId,
    symbol: input.symbol,
    name: input.name,
    dates,
    closes,
    columns,
    periodStartIndex: input.periodStartIndex,
  };
}
