import type { StrategyDefinition } from "@intrinsic/contracts";
import type {
  BuyWindowConfiguration,
  LocalDate,
  SecurityId,
} from "@intrinsic/domain";
import type { EvaluationFrame } from "../frame.js";

/** One list member as the engine sees it: its projected frame plus its BUY eligibility. */
export type BacktestSecurityInput = {
  frame: EvaluationFrame;
  buyWindows: BuyWindowConfiguration;
};

/**
 * The benchmark as the engine sees it.
 *
 * Deliberately structural: the engine knows a code, a name and a date-aligned close series. It does
 * not know, and must never branch on, the fact that V1's `SP500` is currently backed by `SPY`.
 */
export type BenchmarkSeriesInput = {
  benchmarkId: string;
  code: string;
  name: string;
  dates: readonly LocalDate[];
  closes: Float64Array;
};

export type BacktestExecutionInput = {
  definition: StrategyDefinition;
  securities: readonly BacktestSecurityInput[];
  /** Null when the run has no comparable benchmark data; the portfolio curve still renders. */
  benchmark: BenchmarkSeriesInput | null;
  /**
   * The market's trading days over the run's period, from the engine's own reference series.
   *
   * This is a **system input, never a user choice**. It is what makes a portfolio exist from the
   * first day of its period while it still holds nothing but cash, and what keeps a monthly
   * contribution landing in months when none of the run's securities has listed yet.
   *
   * It is deliberately not `benchmark.dates`: the comparison benchmark is passive, and two runs
   * that differ only in what they are compared against must execute identically. Empty is
   * allowed — the calendar then falls back to the securities' own union.
   */
  executionCalendar: readonly LocalDate[];
  startDate: LocalDate;
  endDate: LocalDate;
  initialCapital: number;
  monthlyContribution: number;
  maximumPositions: number;
};

export type BacktestTradeAction = "BUY" | "SELL" | "FINAL_EXIT";

export type BacktestTradeRecord = {
  sequence: number;
  date: LocalDate;
  securityId: SecurityId;
  symbol: string;
  name: string;
  action: BacktestTradeAction;
  levelId: string | null;
  levelPercentage: number | null;
  shares: number;
  price: number;
  amount: number;
  fees: number;
  realizedPnl: number | null;
  realizedPnlPercent: number | null;
  cashAfter: number;
  sharesAfter: number;
  averageCostAfter: number | null;
};

export type BacktestEquityPoint = {
  date: LocalDate;
  cash: number;
  positionsValue: number;
  totalValue: number;
  investedCapital: number;
  /** Time-weighted growth index, 1.0 on the first simulated date. */
  returnIndex: number;
  /** Benchmark growth index on the same base, or null on a date it has no value at or before. */
  benchmarkIndex: number | null;
  openPositions: number;
};

export type BacktestOpenPosition = {
  securityId: SecurityId;
  symbol: string;
  name: string;
  openedDate: LocalDate;
  shares: number;
  averageCost: number;
  lastPrice: number;
  lastPriceDate: LocalDate;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  allocationPercent: number;
};

export type BacktestSummary = {
  firstSimulatedDate: LocalDate;
  lastSimulatedDate: LocalDate;
  tradingDays: number;
  investedCapital: number;
  finalCash: number;
  finalPositionsValue: number;
  finalValue: number;
  netProfit: number;
  portfolioReturnPercent: number;
  benchmarkReturnPercent: number | null;
  alphaPercent: number | null;
  portfolioCagrPercent: number | null;
  maxDrawdownPercent: number;
  benchmarkMaxDrawdownPercent: number | null;
  realizedPnl: number;
  unrealizedPnl: number;
  totalTrades: number;
  buyTrades: number;
  sellTrades: number;
  finalExitTrades: number;
  winningTrades: number;
  losingTrades: number;
  openPositions: number;
};

/**
 * A live snapshot of an in-flight run.
 *
 * It is a projection for the running UI, not the result: the durable result is written when the
 * simulation completes. Curves are already downsampled by the engine so the persisted payload stays
 * bounded however long the run is.
 */
export type BacktestCheckpoint = {
  simulatedThrough: LocalDate;
  /**
   * The calendar year this checkpoint completes, or null for an ordinary cadence checkpoint.
   *
   * A milestone is the progression a user follows on a decades-long run, so it must survive the
   * worker's write throttle. There are at most about thirty in a V1 run, which is what makes
   * persisting every one of them bounded and cheap.
   */
  milestone: string | null;
  /** Simulated trading dates completed, and how many the calendar holds in total. */
  completedDays: number;
  totalDays: number;
  cash: number;
  positionsValue: number;
  totalValue: number;
  investedCapital: number;
  netProfit: number;
  portfolioReturnPercent: number;
  benchmarkReturnPercent: number | null;
  alphaPercent: number | null;
  maxDrawdownPercent: number;
  tradeCount: number;
  openPositions: number;
  curve: readonly BacktestCurvePoint[];
  holdings: readonly BacktestCheckpointHolding[];
  recentTrades: readonly BacktestTradeRecord[];
};

/** One point of the downsampled comparison curve, in percentage growth from the run's start. */
export type BacktestCurvePoint = {
  date: LocalDate;
  portfolioReturnPercent: number;
  benchmarkReturnPercent: number | null;
};

export type BacktestCheckpointHolding = {
  securityId: SecurityId;
  symbol: string;
  name: string;
  shares: number;
  averageCost: number;
  lastPrice: number;
  lastPriceDate: LocalDate;
  marketValue: number;
  unrealizedPnlPercent: number;
  allocationPercent: number;
};

export type BacktestResult = {
  trades: readonly BacktestTradeRecord[];
  equity: readonly BacktestEquityPoint[];
  positions: readonly BacktestOpenPosition[];
  summary: BacktestSummary;
};

export type BacktestSimulationOptions = {
  /**
   * How many simulated trading days pass between checkpoints. Checkpoints are observation only:
   * they never read back into simulated state, so changing this cannot change a result.
   */
  checkpointEveryDays?: number;
  /** Maximum points in a checkpoint curve; the engine strides uniformly to stay under it. */
  maxCurvePoints?: number;
  /** How many of the most recent trades a checkpoint carries. */
  recentTradeCount?: number;
  onCheckpoint?: (checkpoint: BacktestCheckpoint) => void | Promise<void>;
};
