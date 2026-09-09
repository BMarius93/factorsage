import type { LocalDate, SecurityId } from "@intrinsic/domain";
import type { EvaluationFrame } from "../frame.js";
import type { OperandKey } from "../operands.js";
import type { BacktestEquityPoint, BacktestTradeRecord } from "./types.js";
import type { BacktestExecutionWindow } from "./window.js";

/**
 * A read-only view of what a running simulation consumed and what state it carried between
 * windows.
 *
 * This exists for **independent verification of a run**, not for the product: a developer capture
 * writes these payloads to a local archive so another engineer can replay the arithmetic from the
 * inputs the engine actually saw. Nothing here is a Backtest explanation — no reason strings, no
 * decision narrative — because an archive whose reasoning came from the same code as the decision
 * could only ever agree with it.
 *
 * Three rules hold this to observation:
 *
 * 1. every payload is built from state the engine already holds, and never read back;
 * 2. the shapes are **explicit allowlists**, never a serialization of engine internals, so adding a
 *    private field cannot silently start leaving the process;
 * 3. the callbacks fire at window boundaries and at funding, never inside the day loop's decisions,
 *    so an observer cannot reorder or delay one.
 *
 * `NaN` still means NOT_EVALUABLE here exactly as it does in `EvaluationFrame`. Encoding it for
 * transport is the consumer's job — this package has no serializer and no I/O.
 */

/** How external capital entered the run. Both scenarios and the Strategy receive it identically. */
export type BacktestFundingEventType =
  "INITIAL_CAPITAL" | "MONTHLY_CONTRIBUTION";

/**
 * One external cash flow, as the simulation actually applied it.
 *
 * Reported rather than derived so a reviewer can compare the funding schedule the snapshot and the
 * execution calendar imply against the deposits that genuinely happened.
 */
export type BacktestFundingEvent = {
  date: LocalDate;
  type: BacktestFundingEventType;
  amount: number;
  /** Strategy cash after the deposit, before the day's trading. */
  cashAfter: number;
  /** Cumulative external capital the run has received through this date. */
  investedCapitalAfter: number;
};

/** One open position, allowlisted field by field. */
export type BacktestPositionDiagnostics = {
  securityId: SecurityId;
  symbol: string;
  epoch: number;
  openedDate: LocalDate;
  shares: number;
  costTotal: number;
  /** `costTotal / shares`, or `NaN` for a position holding nothing. */
  averageCost: number;
  lastPrice: number;
  lastPriceDate: LocalDate;
  realizedPnl: number;
  /** BUY levels this lifecycle has consumed — settled, which is not the same as traded. */
  buyLevelsSettled: readonly string[];
  sellLevelsFired: readonly string[];
  /** The position-dependent value a Trigger compares against tomorrow, or null while unset. */
  previousSignedReturnPercent: number | null;
  previousValueDate: LocalDate | null;
};

/** The one preceding eligible row carried into the next window, per security. */
export type BacktestContextRowDiagnostics = {
  securityId: SecurityId;
  symbol: string;
  date: LocalDate;
  close: number;
  /** The operand readings that row held. `NaN` where the value was absent. */
  values: ReadonlyMap<OperandKey, number>;
};

/**
 * Everything a reviewer needs to check that a year boundary carried state rather than restarting
 * it. It is a cross-check, never an input: the next window continues from the live in-memory state
 * exactly as it always has, and nothing reads this back.
 */
export type BacktestStateDiagnostics = {
  simulatedThrough: LocalDate | null;
  completedDays: number;
  totalDays: number;
  cash: number;
  positionsValue: number;
  totalValue: number;
  investedCapital: number;
  realizedPnl: number;
  /** Time-weighted growth index carried across the boundary. */
  returnIndex: number;
  /** The previous date's total value, which the next chained return is measured against. */
  previousTotalValue: number;
  maxDrawdownPercent: number;
  benchmarkMaxDrawdownPercent: number | null;
  /** Next trade sequence number; a boundary must not reset it. */
  tradeSequence: number;
  tradeCount: number;
  equityPointCount: number;
  positions: readonly BacktestPositionDiagnostics[];
  /** Position epochs for every security that has ever opened one, including closed positions. */
  positionEpochs: readonly { securityId: SecurityId; epoch: number }[];
  comparison: {
    benchmarkShares: number;
    /** External capital the benchmark scenario holds but could not yet price. Normally zero. */
    benchmarkPendingCapital: number;
    cashBaselineValue: number;
  };
  contextRows: readonly BacktestContextRowDiagnostics[];
};

/**
 * The frames a window was actually simulated from, after the retained context row was spliced in.
 *
 * This is deliberately the **bound** frame rather than the one the loader returned: the row a
 * Trigger reads at `index - 1` on the first eligible date of a year is the retained one, and an
 * archive of the loader's output would not contain it.
 */
export type BacktestWindowOpenedDiagnostics = {
  window: BacktestExecutionWindow;
  frames: readonly EvaluationFrame[];
};

/** A finished window, with the rows it produced and the state it hands to the next one. */
export type BacktestWindowClosedDiagnostics = {
  window: BacktestExecutionWindow;
  /** Trades recorded inside this window, in execution order. */
  trades: readonly BacktestTradeRecord[];
  /** Equity points recorded inside this window, one per simulated date. */
  equity: readonly BacktestEquityPoint[];
  state: BacktestStateDiagnostics;
};

/**
 * An optional observer of a simulation's inputs and carried state.
 *
 * Every member is optional and every implementation is expected to be side-effect-free with
 * respect to the engine. The window callbacks may be asynchronous because they fire at boundaries;
 * `onFunding` is synchronous on purpose, so nothing new can suspend the day loop.
 */
export type BacktestDiagnosticsObserver = {
  onWindowOpened?(
    diagnostics: BacktestWindowOpenedDiagnostics,
  ): void | Promise<void>;
  onWindowClosed?(
    diagnostics: BacktestWindowClosedDiagnostics,
  ): void | Promise<void>;
  onFunding?(event: BacktestFundingEvent): void;
};
