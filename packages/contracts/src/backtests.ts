import type { BuyWindowMode, BuyWindowRangeResponse } from "./stock-lists.js";
import type { StrategyDefinition } from "./strategies.js";

/**
 * The one canonical Backtest contract: submission, run state, live progress and results.
 *
 * `ai/product/backtests.md` is the product decision this file serves and
 * `ai/architecture/backtest-execution.md` describes the execution it reports on. Neither is
 * restated here. The web app consumes these types directly and must never keep a second copy.
 *
 * Vocabulary note: a **Backtest configuration** is Strategy + Stock List + execution inputs; a
 * **Backtest run** is one immutable execution of it. A Strategy never gains a run parameter.
 */

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

/**
 * How a benchmark's market data is sourced. V1 ships `FMP_SYMBOL` only; the union exists so a
 * future index-backed or composite benchmark is an added member rather than a reinterpretation.
 */
export const BENCHMARK_SOURCE_KINDS = ["FMP_SYMBOL"] as const;

export type BenchmarkSourceKind = (typeof BENCHMARK_SOURCE_KINDS)[number];

/**
 * One selectable benchmark.
 *
 * Deliberately **not** a `Security`: a benchmark is passive comparison data that is never bought,
 * never consumes cash and never occupies a position slot. The provider symbol behind it is a
 * server-side implementation detail and is not part of this contract — the browser selects
 * `SP500`, not `SPY`.
 */
export type BenchmarkResponse = {
  id: string;
  code: string;
  name: string;
  description?: string;
  currency: string;
};

/** The V1 default selection. One canonical code, so no surface keeps its own benchmark list. */
export const DEFAULT_BENCHMARK_CODE = "SP500" as const;

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/** Shared submission limits, so the browser UI and the API cannot disagree. */
export const BACKTEST_MIN_INITIAL_CAPITAL = 1;
export const BACKTEST_MAX_INITIAL_CAPITAL = 1_000_000_000;
export const BACKTEST_MAX_MONTHLY_CONTRIBUTION = 10_000_000;
export const BACKTEST_MIN_MAXIMUM_POSITIONS = 1;
export const BACKTEST_MAX_MAXIMUM_POSITIONS = 100;
/** Matches the loader's retention horizon: nothing older than this is materializable. */
export const BACKTEST_MAX_PERIOD_YEARS = 30;
/** Guards the run before it starts rather than letting a worker exhaust memory mid-execution. */
export const BACKTEST_MAX_SECURITIES = 200;

export type CreateBacktestRunRequest = {
  strategyId: string;
  stockListId: string;
  /** Canonical benchmark code, e.g. `SP500`. Omitted means the V1 default. */
  benchmarkCode?: string;
  startDate: string;
  endDate: string;
  initialCapital: number;
  /** Omitted or `0` means no recurring contribution. */
  monthlyContribution?: number;
  maximumPositions: number;
};

/** The `code` a 400 carries when a submitted backtest configuration was rejected. */
export const BACKTEST_INVALID_CODE = "BACKTEST_INVALID" as const;

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one run. `QUEUED` is durable work waiting for a worker; `PREPARING_DATA` is
 * hydration and frame projection; `RUNNING` is the simulation; `FINALIZING` persists results.
 * `COMPLETED` and `FAILED` are terminal, and a client stops polling there.
 */
export const BACKTEST_RUN_STATUSES = [
  "QUEUED",
  "PREPARING_DATA",
  "RUNNING",
  "FINALIZING",
  "COMPLETED",
  "FAILED",
] as const;

export type BacktestRunStatus = (typeof BACKTEST_RUN_STATUSES)[number];

/** The one product label per status; no surface keeps a second map. */
export const BACKTEST_RUN_STATUS_LABELS = {
  QUEUED: "Queued",
  PREPARING_DATA: "Preparing data",
  RUNNING: "Running",
  FINALIZING: "Finalizing",
  COMPLETED: "Completed",
  FAILED: "Failed",
} as const satisfies Record<BacktestRunStatus, string>;

export function isTerminalBacktestStatus(status: BacktestRunStatus): boolean {
  return status === "COMPLETED" || status === "FAILED";
}

/**
 * Benchmark identity **as the run executed it**, read from the immutable submission snapshot.
 *
 * `sourceKind` and `methodologyVersion` are included so a completed run stays interpretable after
 * the benchmark catalog changes what backs a code.
 */
export type BacktestBenchmarkSnapshotResponse = {
  benchmarkId: string;
  code: string;
  name: string;
  sourceKind: BenchmarkSourceKind;
  methodologyVersion: number;
};

/** The methodology versions a run executed under, straight from its snapshot. */
export type BacktestMethodologyResponse = {
  calendar: string;
  executionCalendar: string;
  candidateOrdering: string;
  execution: string;
  executionCosts: string;
  contribution: string;
  returns: string;
  costBasis: string;
};

/**
 * The configuration a run executed, projected from its immutable snapshot rather than from the
 * current Strategy or Stock List rows — editing either afterwards never changes this.
 */
export type BacktestRunConfigurationResponse = {
  /** Null when the underlying strategy has since been deleted; the snapshot still describes it. */
  strategyId: string | null;
  strategyName: string;
  strategyVersionNumber: number;
  stockListId: string | null;
  stockListName: string;
  securityCount: number;
  startDate: string;
  endDate: string;
  initialCapital: number;
  monthlyContribution: number;
  maximumPositions: number;
  /** Derived, never entered: `100 / maximumPositions`. */
  fullPositionPercent: number;
  benchmark: BacktestBenchmarkSnapshotResponse;
  methodology: BacktestMethodologyResponse;
};

/** One row of `GET /backtests`. */
export type BacktestRunSummaryResponse = {
  id: string;
  status: BacktestRunStatus;
  strategyName: string;
  stockListName: string;
  benchmarkCode: string;
  benchmarkName: string;
  startDate: string;
  endDate: string;
  initialCapital: number;
  maximumPositions: number;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  progressPercent: number;
  progressMessage: string | null;
  portfolioReturnPercent: number | null;
  benchmarkReturnPercent: number | null;
  alphaPercent: number | null;
};

// ---------------------------------------------------------------------------
// Curves, trades, holdings
// ---------------------------------------------------------------------------

/**
 * One point of the comparison curve, in percentage growth from the run's first simulated date.
 *
 * Both series are normalized to the same starting point, which is what makes them directly
 * comparable. `benchmarkReturnPercent` is null on a date the benchmark has no value at or before —
 * a gap is reported, never fabricated.
 */
export type BacktestCurvePointResponse = {
  date: string;
  portfolioReturnPercent: number;
  benchmarkReturnPercent: number | null;
};

export type BacktestTradeAction = "BUY" | "SELL" | "FINAL_EXIT";

export type BacktestTradeResponse = {
  sequence: number;
  date: string;
  symbol: string;
  name: string;
  action: BacktestTradeAction;
  levelPercentage: number | null;
  shares: number;
  price: number;
  amount: number;
  realizedPnl: number | null;
  realizedPnlPercent: number | null;
};

export type BacktestHoldingResponse = {
  symbol: string;
  name: string;
  shares: number;
  averageCost: number;
  lastPrice: number;
  /**
   * The date `lastPrice` was quoted on.
   *
   * Usually the run's last simulated date. It is earlier when the security stopped producing
   * prices before the run ended — a security whose history simply ends is carried at its last real
   * close rather than marked to a price that was never quoted. Surfacing the date is what makes
   * that visible instead of silent; see `ai/product/backtests.md`.
   */
  lastPriceDate: string;
  marketValue: number;
  unrealizedPnlPercent: number;
  allocationPercent: number;
};

// ---------------------------------------------------------------------------
// Live progress
// ---------------------------------------------------------------------------

/**
 * The live snapshot the running page renders before a run finishes.
 *
 * It is a bounded projection of in-flight state, not the result: curves are downsampled and only
 * the most recent trades are carried, so the payload stays the same size whether the run covers one
 * year or thirty.
 */
export type BacktestLiveSnapshotResponse = {
  simulatedThrough: string;
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
  curve: BacktestCurvePointResponse[];
  holdings: BacktestHoldingResponse[];
  recentTrades: BacktestTradeResponse[];
};

/**
 * One completed calendar year of a run.
 *
 * The live snapshot is a replacement — each checkpoint overwrites the previous one — so a browser
 * polling more slowly than the worker simulates sees only wherever the run had got to. Milestones
 * are the ordered progression that survives that: every completed year is persisted and none is
 * ever overwritten, so a run that finishes between two polls still reports the whole progression it
 * actually went through. A V1 run is capped at thirty years, so this list is at most about thirty
 * small entries and carries no curve of its own.
 */
export type BacktestMilestoneResponse = {
  /** 1-based order of completion. A client keeps the highest sequence it has consumed. */
  sequence: number;
  /** The calendar year this milestone completes, as `YYYY`. */
  year: string;
  simulatedThrough: string;
  percent: number;
  completedDays: number;
  totalDays: number;
  cash: number;
  totalValue: number;
  investedCapital: number;
  portfolioReturnPercent: number;
  benchmarkReturnPercent: number | null;
  alphaPercent: number | null;
  maxDrawdownPercent: number;
  tradeCount: number;
  openPositions: number;
};

/**
 * Why a run failed, in terms safe to show a user.
 *
 * `code` is stable and machine-readable; `message` is product prose. Provider names, credentials,
 * stack traces and internal identifiers never cross this boundary — the developer detail stays in
 * the run's server-side diagnostics.
 */
export type BacktestFailureResponse = {
  code: string;
  message: string;
  /**
   * The phase that failed, as a product-safe label.
   *
   * It is the first thing a user needs in order to act: "preparing data" points at the stocks in
   * the list and their history, "running" at the strategy and the simulation, "finalizing" at
   * saving the result. Null for a run that failed before a phase was entered.
   */
  phase: BacktestFailurePhase | null;
};

/** The phases a run can fail in, in the order it passes through them. */
export const BACKTEST_FAILURE_PHASES = [
  "PREPARING_DATA",
  "RUNNING",
  "FINALIZING",
] as const;

export type BacktestFailurePhase = (typeof BACKTEST_FAILURE_PHASES)[number];

/** The one product label per failure phase; no surface keeps a second map. */
export const BACKTEST_FAILURE_PHASE_LABELS = {
  PREPARING_DATA: "Preparing data",
  RUNNING: "Running",
  FINALIZING: "Finalizing",
} as const satisfies Record<BacktestFailurePhase, string>;

/** Stable failure codes. Anything unexpected is reported as `EXECUTION_FAILED`. */
export const BACKTEST_FAILURE_CODES = [
  "DATA_UNAVAILABLE",
  /**
   * The run's pinned execution calendar could not be read.
   *
   * Distinct from `DATA_UNAVAILABLE` because it is not about the user's stocks: the calendar is a
   * system input that decides which dates are simulated, so a run that cannot read it must stop
   * rather than quietly simulate a different set of dates.
   */
  "EXECUTION_CALENDAR_UNAVAILABLE",
  "NO_TRADING_DAYS",
  "EXECUTION_FAILED",
  "ABANDONED",
] as const;

export type BacktestFailureCode = (typeof BACKTEST_FAILURE_CODES)[number];

/**
 * The polling payload. Deliberately small: the running page fetches this about once a second and
 * must not re-download the configuration or a completed result on every tick.
 *
 * `sequence` is a monotonic checkpoint counter. A client keeps the highest sequence it has seen and
 * discards an out-of-order response, so a slow request can never overwrite newer state.
 */
export type BacktestProgressResponse = {
  runId: string;
  status: BacktestRunStatus;
  percent: number;
  message: string | null;
  simulatedThrough: string | null;
  sequence: number;
  updatedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  live: BacktestLiveSnapshotResponse | null;
  /** Every completed year so far, ascending. Bounded by the thirty-year period limit. */
  milestones: BacktestMilestoneResponse[];
  failure: BacktestFailureResponse | null;
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type BacktestResultSummaryResponse = {
  firstSimulatedDate: string;
  lastSimulatedDate: string;
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

/** How many curve points and trades a completed result carries over the wire. */
export const BACKTEST_RESULT_MAX_CURVE_POINTS = 1_500;
export const BACKTEST_RESULT_MAX_TRADES = 500;

/**
 * A completed run's result, sufficient to render the detail page without replaying the simulation.
 *
 * The curve is downsampled to `BACKTEST_RESULT_MAX_CURVE_POINTS` and the trade log to the most
 * recent `BACKTEST_RESULT_MAX_TRADES`; `totalTrades` on the summary always reports the true count.
 * Every point and every trade remains durably persisted.
 */
export type BacktestResultResponse = {
  summary: BacktestResultSummaryResponse;
  curve: BacktestCurvePointResponse[];
  trades: BacktestTradeResponse[];
  holdings: BacktestHoldingResponse[];
};

export type BacktestRunDetailResponse = {
  id: string;
  status: BacktestRunStatus;
  configuration: BacktestRunConfigurationResponse;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  progress: {
    percent: number;
    message: string | null;
    simulatedThrough: string | null;
    sequence: number;
    updatedAt: string | null;
  };
  live: BacktestLiveSnapshotResponse | null;
  /** Every completed year of the run, ascending. Bounded by the thirty-year period limit. */
  milestones: BacktestMilestoneResponse[];
  result: BacktestResultResponse | null;
  failure: BacktestFailureResponse | null;
};

/**
 * The normalized strategy definition a run executed, available on demand for the detail page's
 * "what did this run actually apply?" surface. It comes from the run snapshot, so it is the
 * definition as of submission even if the strategy has changed since.
 */
export type BacktestRunStrategyResponse = {
  strategyName: string;
  versionNumber: number;
  definition: StrategyDefinition;
};

// ---------------------------------------------------------------------------
// Polling cadence
// ---------------------------------------------------------------------------

/**
 * Client polling intervals. V1 uses plain polling: no WebSocket, no SSE.
 *
 * A running simulation checkpoints every few simulated days, so about one request a second keeps
 * the chart visibly growing; queued and preparing states change slowly and are polled lazily.
 */
export const BACKTEST_RUNNING_POLL_INTERVAL_MS = 1_000;
export const BACKTEST_PENDING_POLL_INTERVAL_MS = 2_500;

// ---------------------------------------------------------------------------
// The immutable submission snapshot
// ---------------------------------------------------------------------------

export const BACKTEST_SNAPSHOT_VERSION = 1;

/**
 * One resolved list member, frozen at submission.
 *
 * A Stock List is mutable configuration; a run must never depend on its current state. Editing the
 * list, changing a buy window or deleting the list entirely leaves this untouched.
 */
export type BacktestSnapshotSecurity = {
  securityId: string;
  symbol: string;
  name: string;
  exchangeCode: string;
  currency: string;
  buyWindowMode: BuyWindowMode;
  /** Canonical normalized ranges as of submission; always empty for `FULL`. */
  buyWindows: BuyWindowRangeResponse[];
};

/**
 * Everything needed to reproduce one run, written once and never updated.
 *
 * This is the reproducibility authority `ai/product/backtests.md` requires. It is a server-side
 * document rather than a browser payload — it lives here because `@intrinsic/contracts` is the one
 * package both the API that writes it and the worker that executes it may depend on, exactly like
 * the Strategy definition document beside it.
 *
 * `providerSymbol` is included for the benchmark so a completed run records which series actually
 * produced its comparison numbers; the browser-facing benchmark snapshot deliberately omits it.
 */
export type BacktestRunSnapshot = {
  snapshotVersion: typeof BACKTEST_SNAPSHOT_VERSION;
  submittedAt: string;
  strategy: {
    strategyId: string;
    name: string;
    versionId: string;
    versionNumber: number;
    definitionHash: string;
    definition: StrategyDefinition;
  };
  stockList: {
    stockListId: string;
    name: string;
  };
  securities: BacktestSnapshotSecurity[];
  period: {
    startDate: string;
    endDate: string;
  };
  capital: {
    initialCapital: number;
    monthlyContribution: number;
  };
  allocation: {
    maximumPositions: number;
    /** Derived at submission and frozen: `1 / maximumPositions`. Never a user input. */
    fullPositionFraction: number;
  };
  benchmark: {
    benchmarkId: string;
    /**
     * The immutable series this run compares against, pinned at submission.
     *
     * Execution resolves the benchmark by this id and never by `code`: the catalog can append a
     * new definition at any moment, and a queued run must keep reading exactly the series it was
     * submitted against.
     */
    seriesId: string;
    seriesVersion: number;
    code: string;
    name: string;
    sourceKind: BenchmarkSourceKind;
    providerSymbol: string;
    methodologyVersion: number;
    currency: string;
  };
  /**
   * Where the run's simulated dates come from — a system input, never the user's comparison
   * choice, and **required**.
   *
   * It decides which dates are simulated, when a contribution lands and what the return index is
   * based at, so it is part of the snapshotted methodology. A run that could not pin it is not
   * submitted, and a run that cannot read it fails rather than executing a different methodology.
   */
  executionCalendar: {
    referenceCode: string;
    seriesId: string;
    seriesVersion: number;
  };
  methodology: BacktestMethodologyResponse;
  /**
   * The data revisions in force at submission.
   *
   * A completed run's stored results are immutable, but the derived state and price coverage it
   * read are *replaced* rather than versioned on a methodology bump. Recording the revisions does
   * not make a re-execution reproducible — it makes the difference explainable instead of
   * mysterious.
   */
  dataRevisions: {
    priceDatasetVersion: number;
    derivedStateRevision: number;
  };
};

/**
 * The canonical serialization a run's `snapshotHash` is taken over.
 *
 * Two properties matter, and neither is free:
 *
 * 1. **`submittedAt` is excluded.** The hash answers "did these two runs execute the same inputs
 *    under the same methodology?", which is a question about configuration, not about when someone
 *    pressed the button. Including the timestamp would make every hash unique and the column
 *    meaningless.
 * 2. **Object keys are sorted.** The snapshot is stored in a `JSONB` column, which does not preserve
 *    key order, so a digest over the writer's own key order could never be re-derived from the
 *    stored row. Sorting makes the hash verifiable against what PostgreSQL actually holds.
 *
 * Array order is preserved: the order of securities and of strategy levels is meaning, not
 * formatting.
 */
export function canonicalBacktestSnapshotDocument(
  snapshot: BacktestRunSnapshot,
): string {
  const hashable = { ...snapshot } as Partial<BacktestRunSnapshot>;
  delete hashable.submittedAt;
  return JSON.stringify(sortKeysDeeply(hashable));
}

function sortKeysDeeply(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeeply);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return Object.fromEntries(
      entries.map(([key, entryValue]) => [key, sortKeysDeeply(entryValue)]),
    );
  }
  return value;
}
