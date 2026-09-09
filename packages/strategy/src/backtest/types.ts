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
 * One list member's identity and BUY eligibility, fixed for the whole run.
 *
 * Separated from the frame because a windowed run projects a *different* frame for the same
 * security in every calendar year, while its identity and buy windows are the run's own frozen
 * snapshot and must not be re-derived from whichever year happens to be resident.
 */
export type BacktestSecuritySetup = {
  securityId: SecurityId;
  symbol: string;
  name: string;
  buyWindows: BuyWindowConfiguration;
};

/**
 * The projections one calendar-year window is simulated from.
 *
 * `frames` carries **one frame per run security, in the run's own order**, including an empty frame
 * for a security with no rows that year. A loader that dropped a security instead would silently
 * stop it trading; requiring the full set makes that a rejected window rather than a wrong result.
 *
 * Each frame covers its window plus whatever leading context the loader adds; the engine itself
 * carries the one preceding eligible row a Trigger needs across the boundary, so no loader window
 * has to be widened to make a crossing on the first trading day of January correct.
 */
export type BacktestWindowInput = {
  frames: readonly EvaluationFrame[];
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
   * A **system input, never a user choice, and required**. It is what makes a portfolio exist from
   * the first day of its period while it still holds nothing but cash, and what keeps a monthly
   * contribution landing in months when none of the run's securities has listed yet.
   *
   * It is deliberately not `benchmark.dates`: the comparison benchmark is passive, and two runs
   * that differ only in what they are compared against must execute identically.
   *
   * Empty is rejected rather than degraded. Silently simulating the securities' own union instead
   * would change which dates are a month's first trading day, and through them the result — a
   * different methodology than the run recorded, chosen by whether an auxiliary series happened to
   * load.
   */
  executionCalendar: readonly LocalDate[];
  startDate: LocalDate;
  endDate: LocalDate;
  initialCapital: number;
  monthlyContribution: number;
  maximumPositions: number;
};

/**
 * A windowed run's fixed inputs: everything except the per-year projections.
 *
 * Identical to `BacktestExecutionInput` apart from `securities`, which carries identity and BUY
 * eligibility only — the frames arrive one calendar-year window at a time through
 * `BacktestSimulation.consumeWindow`.
 */
export type BacktestSimulationInput = Omit<
  BacktestExecutionInput,
  "securities"
> & {
  securities: readonly BacktestSecuritySetup[];
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
  /**
   * Absolute value of the funded `S&P 500` comparison scenario, or null while the benchmark has no
   * close at or before this date.
   *
   * Not `initialCapital × benchmarkIndex`: the scenario receives the run's monthly contributions on
   * the same dates the Strategy does and buys fractional benchmark shares with them, so its value
   * depends on the price each contribution actually bought at. Scaling one growth index by the
   * contributed capital would only agree with it when there are no contributions at all.
   */
  benchmarkValue: number | null;
  /**
   * Absolute value of the `Cash` scenario: `initialCapital + cumulativeContributionsThrough(date)`.
   *
   * Deliberately **not** `cash` above, which is the Strategy's own uninvested balance. This is the
   * money the user put in and never invested, which under `zero-interest@1` earns nothing.
   */
  cashBaselineValue: number;
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
  /** The funded benchmark scenario's value on `simulatedThrough`, or null while unpriced. */
  benchmarkValue: number | null;
  /** The Cash scenario's value on `simulatedThrough`. */
  cashBaselineValue: number;
  tradeCount: number;
  openPositions: number;
  curve: readonly BacktestCurvePoint[];
  holdings: readonly BacktestCheckpointHolding[];
  recentTrades: readonly BacktestTradeRecord[];
};

/**
 * One point of the downsampled comparison curve.
 *
 * It carries both readings of the same day: the percentage growth the existing summary metrics and
 * alpha are built on, and the three absolute currency scenarios the chart now shows. They are
 * different presentations of one simulated day, never two simulations.
 */
export type BacktestCurvePoint = {
  date: LocalDate;
  portfolioReturnPercent: number;
  benchmarkReturnPercent: number | null;
  /** Total Strategy portfolio value: uninvested Strategy cash + market value of open positions. */
  strategyValue: number;
  /** Absolute value of the funded benchmark scenario, or null while it cannot be priced. */
  benchmarkValue: number | null;
  /** Absolute value of the never-invested scenario. */
  cashBaselineValue: number;
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
