import type { AlternativeActorType } from "./alternative-data.js";
import type { BuyWindowMode, BuyWindowRangeResponse } from "./stock-lists.js";
import {
  describeCondition,
  describeTrigger,
  normalizeStrategyDefinition,
  upgradeStrategyDefinitionDocument,
  type StrategyDefinition,
  type StrategySignal,
} from "./strategies.js";

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
/**
 * The product horizon: nothing older than this is selectable, projectable or backtestable.
 *
 * Matches `STOCK_HISTORY_YEARS` and `STOCK_DETAILS_MAX_HISTORY_YEARS`, and deliberately **not** the
 * loader's raw-price retention horizon, which reaches four years further back as internal
 * calculation warm-up and is exposed by nothing
 * (`docs/decisions/price-retention-warmup-horizon.md`).
 */
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
  cashYield: string;
  strategyEvaluation: string;
  contribution: string;
  returns: string;
  /**
   * What the absolute Strategy / benchmark / Cash comparison values mean.
   *
   * Separate from `returns`, which still governs the percentage-growth curves and every metric
   * derived from them. A run completed before this version recorded none, and its result carries no
   * funded benchmark value.
   */
  comparisonScenarios: string;
  /**
   * How a run ends.
   *
   * Absent on a run submitted before FactorSage liquidated remaining positions at the end of the
   * period — those runs finished holding their open positions, and their stored result says so.
   * Optional rather than backfilled: a snapshot is never rewritten.
   */
  terminalLiquidation?: string;
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
  /**
   * The strategy and stock list the run was submitted with, exactly as on the run's
   * configuration: null once that entity has been deleted. Names always come from the snapshot.
   */
  strategyId: string | null;
  strategyName: string;
  stockListId: string | null;
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
 * One point of the comparison curve: the same simulated day, read two ways.
 *
 * **The absolute scenarios are the primary presentation.** `strategyValue`, `benchmarkValue` and
 * `cashBaselineValue` are three currency-valued lines on one axis, all funded by the *same*
 * external cash flows on the *same* dates — the same initial capital and the same monthly
 * contributions — so a difference between them is a difference in what the money did rather than in
 * how much of it there was:
 *
 * ```text
 * Strategy   strategyUninvestedCash(d) + marketValueOfOpenPositions(d)
 * S&P 500    accumulated fractional benchmark shares, marked at the close in effect on d
 * Cash       initialCapital + cumulativeContributionsThrough(d), never invested
 * ```
 *
 * `portfolioReturnPercent` and `benchmarkReturnPercent` remain the percentage-growth reading the
 * summary metrics and alpha are built on, unchanged and still normalized to the run's first
 * simulated date.
 *
 * Two things can legitimately be null, and neither is ever fabricated:
 * `benchmarkReturnPercent`/`benchmarkValue` on a date the benchmark has no close at or before it,
 * and `benchmarkValue` on a run completed before the funded scenario existed — its value is not
 * derivable from a growth index once the run has contributions, so it is reported as absent.
 */
export type BacktestCurvePointResponse = {
  date: string;
  portfolioReturnPercent: number;
  benchmarkReturnPercent: number | null;
  /** Total Strategy portfolio value: uninvested Strategy cash plus open positions at market. */
  strategyValue: number;
  /** The funded benchmark scenario's absolute value, or null when it has none. */
  benchmarkValue: number | null;
  /**
   * The `Cash` scenario's absolute value.
   *
   * Deliberately its own name: it is **not** the Strategy's uninvested cash, which is reported as
   * `cash` on the live snapshot and `finalCash` on the result summary.
   */
  cashBaselineValue: number;
};

export type BacktestTradeAction = "BUY" | "SELL" | "FINAL_EXIT";

/**
 * What put a trade in the log.
 *
 * `STRATEGY` is a BUY, a SELL or a FINAL EXIT the strategy's own signal produced. `END_OF_BACKTEST`
 * is the terminal liquidation: at the end of the requested period FactorSage sells every remaining
 * position at its canonical final execution price, so a completed run ends in cash.
 *
 * It is a **separate axis from the action**, deliberately. A liquidation is a sale and reads as one
 * — `Sell 100%` — so it must not become a fourth action, and it must never be confused with the
 * strategy's FINAL EXIT, which is a decision the strategy made. Execution methodology and strategy
 * logic are different things; see `ai/architecture/backtest-execution.md`.
 */
export const BACKTEST_TRADE_SOURCES = ["STRATEGY", "END_OF_BACKTEST"] as const;

export type BacktestTradeSource = (typeof BACKTEST_TRADE_SOURCES)[number];

/**
 * Why one trade happened, in the canonical Strategy description language.
 *
 * Structured rather than one rendered sentence, exactly like `DashboardRowReason`: the server owns
 * which rule fired and says so in canonical labels, and the browser decides how to draw it. The
 * strings come from `describeCondition` / `describeTrigger`, so a Strategy metric is never named
 * twice in two places.
 *
 * It is always derived from the run's **immutable snapshot**, never from the strategy as it stands
 * today: editing a strategy after a run must not rewrite the run's history.
 */
export type BacktestTradeReason =
  | {
      kind: "STRATEGY";
      /** The FINAL EXIT Exit Rule's 1-based position, when the level has more than one. */
      exitRule?: number;
      /** Canonical Condition descriptions, ANDed. */
      conditions: string[];
      /** The canonical Trigger description, when the level carries one. */
      trigger?: string;
    }
  | { kind: "END_OF_BACKTEST" };

export type BacktestTradeResponse = {
  sequence: number;
  date: string;
  symbol: string;
  name: string;
  action: BacktestTradeAction;
  /** Strategy decision, or FactorSage ending the simulation. Never folded into `action`. */
  source: BacktestTradeSource;
  levelPercentage: number | null;
  shares: number;
  price: number;
  amount: number;
  realizedPnl: number | null;
  realizedPnlPercent: number | null;
  /**
   * The rule that actually produced this trade, or null when the run did not record enough to say
   * which one did — a FINAL EXIT with several Exit Rules, executed before the engine recorded the
   * matching rule's identity. Null is the honest answer there: naming every alternative would claim
   * they all matched.
   */
  reason: BacktestTradeReason | null;
};

/**
 * One run's levels and Exit Rules, prepared once so a page of trades costs no repeated parsing.
 *
 * Built from the run's snapshotted definition and read per trade. Keeping it explicit is what stops
 * a trade log of eighteen thousand rows re-describing the same strategy eighteen thousand times.
 */
export type BacktestTradeReasonIndex = {
  readonly levels: ReadonlyMap<string, BacktestTradeReasonBody>;
  readonly exitRules: ReadonlyMap<string, BacktestTradeReasonBody>;
  /** How many alternatives FINAL EXIT offers; 1 needs no rule number, 0 means it has none. */
  readonly exitRuleCount: number;
};

export type BacktestTradeReasonBody = {
  conditions: string[];
  trigger?: string;
  /** 1-based position among FINAL EXIT's Exit Rules; absent for BUY and SELL levels. */
  exitRule?: number;
};

function reasonBodyOf(signal: StrategySignal): BacktestTradeReasonBody {
  return {
    conditions: signal.conditions.map(describeCondition),
    ...(signal.trigger ? { trigger: describeTrigger(signal.trigger) } : {}),
  };
}

/** Prepares {@link BacktestTradeReasonIndex} from the definition a run executed. */
export function backtestTradeReasonIndex(
  definition: StrategyDefinition,
): BacktestTradeReasonIndex {
  const levels = new Map<string, BacktestTradeReasonBody>();
  const exitRules = new Map<string, BacktestTradeReasonBody>();
  for (const level of definition.buyLevels) {
    levels.set(level.id, reasonBodyOf(level.signal));
  }
  for (const level of definition.sellLevels) {
    levels.set(level.id, reasonBodyOf(level.signal));
  }
  const rules = definition.finalExit?.rules ?? [];
  rules.forEach((rule, index) => {
    exitRules.set(rule.id, {
      ...reasonBodyOf(rule.signal),
      // A lone alternative is not a choice, so it is not numbered — the same rule the Strategy
      // logic preview applies.
      ...(rules.length > 1 ? { exitRule: index + 1 } : {}),
    });
  });
  return { levels, exitRules, exitRuleCount: rules.length };
}

/**
 * The reason one persisted trade carries, resolved against the run's own snapshot.
 *
 * A FINAL EXIT resolves through `exitRuleId` — the alternative the engine recorded as the one that
 * matched. A run whose FINAL EXIT had exactly one alternative needs no recorded identity, because
 * there is nothing to choose between.
 */
export function backtestTradeReason(
  index: BacktestTradeReasonIndex,
  trade: {
    source: BacktestTradeSource;
    action: BacktestTradeAction;
    levelId: string | null;
    exitRuleId: string | null;
  },
): BacktestTradeReason | null {
  if (trade.source === "END_OF_BACKTEST") {
    return { kind: "END_OF_BACKTEST" };
  }
  const body =
    trade.action === "FINAL_EXIT"
      ? ((trade.exitRuleId === null
          ? undefined
          : index.exitRules.get(trade.exitRuleId)) ??
        // One alternative is unambiguous even for a run recorded before the identity existed.
        (index.exitRuleCount === 1
          ? [...index.exitRules.values()][0]
          : undefined))
      : trade.levelId === null
        ? undefined
        : index.levels.get(trade.levelId);
  if (!body) {
    return null;
  }
  return {
    kind: "STRATEGY",
    ...(body.exitRule === undefined ? {} : { exitRule: body.exitRule }),
    conditions: body.conditions,
    ...(body.trigger === undefined ? {} : { trigger: body.trigger }),
  };
}

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
// Annual returns
// ---------------------------------------------------------------------------

/**
 * What one calendar year of a run returned — **that year only, never cumulative**.
 *
 * A thirty-year run reports thirty independent figures. `1998 +139.83%` means the portfolio grew
 * by 139.83% during 1998, not that it stood 139.83% above where it started in 1996.
 */
export type BacktestAnnualReturnResponse = {
  /** `YYYY`. */
  year: string;
  /** The last simulated date inside this year: the date the year's return is measured to. */
  simulatedThrough: string;
  /** Return over this year's simulated portion, cash-flow adjusted. Not cumulative. */
  returnPercent: number;
  /**
   * True when only part of the calendar year was simulated — the run's first year when it starts
   * after 1 January, its last when it ends before 31 December. The figure is still the true return
   * over the part that was simulated; nothing outside the requested period is fabricated.
   */
  partial: boolean;
};

/**
 * Per-calendar-year returns, chained off the canonical time-weighted return index.
 *
 * ```text
 * annualReturn(year) = returnIndex(last simulated day of year)
 *                    / returnIndex(last simulated day of the previous year) - 1
 * ```
 *
 * The index is the run's own `time-weighted-index@1` growth index, based at 1.0 before the first
 * simulated day, so a monthly contribution raises portfolio value without inventing return. That is
 * the whole reason this is derived from the index rather than from `(end - start) / start` over
 * portfolio value: a year that received twelve deposits would otherwise report the deposits as
 * performance. The first year divides by 1.0, which is the base of that index and not a fabricated
 * starting point.
 *
 * Chaining every year's `(1 + r)` reproduces the run's total portfolio return exactly, which is what
 * makes the two readings one methodology rather than two.
 *
 * `points` may be the run's daily equity or its per-year milestones; only the last point of each
 * calendar year is read, so both produce the same answer. Order does not matter.
 */
export function backtestAnnualReturns(
  points: readonly { date: string; returnIndex: number }[],
  period: { startDate: string; endDate: string },
): BacktestAnnualReturnResponse[] {
  const lastOfYear = new Map<string, { date: string; returnIndex: number }>();
  for (const point of points) {
    if (!Number.isFinite(point.returnIndex) || point.returnIndex <= 0) {
      // A non-positive growth index is not a reading; dividing by one would report a wipeout that
      // the portfolio value never had.
      continue;
    }
    const year = point.date.slice(0, 4);
    const held = lastOfYear.get(year);
    if (!held || point.date >= held.date) {
      lastOfYear.set(year, point);
    }
  }

  const startYear = period.startDate.slice(0, 4);
  const endYear = period.endDate.slice(0, 4);
  const startsMidYear = period.startDate.slice(5) > "01-01";
  const endsMidYear = period.endDate.slice(5) < "12-31";

  let previousIndex = 1;
  return [...lastOfYear.keys()].sort().map((year) => {
    const point = lastOfYear.get(year) as {
      date: string;
      returnIndex: number;
    };
    const returnPercent = (point.returnIndex / previousIndex - 1) * 100;
    previousIndex = point.returnIndex;
    return {
      year,
      simulatedThrough: point.date,
      returnPercent,
      partial:
        (year === startYear && startsMidYear) ||
        (year === endYear && endsMidYear),
    };
  });
}

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
  /**
   * Compound annual growth rate of the time-weighted index over the part simulated so far.
   *
   * The same calculation the completed summary reports, so the KPI tile carries a real number while
   * a run executes instead of a placeholder. Null before the run has spanned a measurable period.
   */
  portfolioCagrPercent: number | null;
  maxDrawdownPercent: number;
  /** The funded benchmark scenario on `simulatedThrough`, or null while it cannot be priced. */
  benchmarkValue: number | null;
  /** The `Cash` scenario on `simulatedThrough`. Never the Strategy's uninvested `cash` above. */
  cashBaselineValue: number;
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
  /**
   * The run was queued under a methodology this build does not implement.
   *
   * A deploy between queueing and claiming would otherwise let a worker execute today's rules and
   * store the result under the versions the snapshot recorded yesterday.
   */
  "ENGINE_VERSION_MISMATCH",
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
  /**
   * Positions still open on the final simulated date.
   *
   * **Zero for every run executed under terminal liquidation**, which sells all remaining positions
   * at the end of the requested period. The field stays because a run completed before that rule
   * existed reports what it actually held, and rewriting its result to match a later methodology is
   * exactly what the immutability invariant forbids.
   */
  openPositions: number;
};

/** How many curve points a completed result carries over the wire. */
export const BACKTEST_RESULT_MAX_CURVE_POINTS = 1_500;

/**
 * A completed run's result, sufficient to render the detail page without replaying the simulation.
 *
 * The curve is downsampled to `BACKTEST_RESULT_MAX_CURVE_POINTS`; every point remains durably
 * persisted. The trade log is **not** here: it is paginated from the database through
 * `GET /backtests/{runId}/trades`, because a long run has tens of thousands of trades and a bounded
 * tail of them is neither the whole log nor a usable page of one.
 *
 * Final holdings are not here either, and deliberately so: a completed run ends in cash.
 */
export type BacktestResultResponse = {
  summary: BacktestResultSummaryResponse;
  /** Per-calendar-year returns, non-cumulative. Empty for a run with no simulated year. */
  annualReturns: BacktestAnnualReturnResponse[];
  curve: BacktestCurvePointResponse[];
};

// ---------------------------------------------------------------------------
// The paginated trade log
// ---------------------------------------------------------------------------

/** The default page of the trade log, and the largest page the API will serve. */
export const BACKTEST_TRADES_PAGE_SIZE = 50;
export const BACKTEST_TRADES_MAX_PAGE_SIZE = 200;

/**
 * One page of a completed run's trade log, newest trade first.
 *
 * Paged in the database rather than in the browser: an eighteen-thousand-trade run must not ship
 * eighteen thousand rows to display fifty of them, and `totalCount` comes from a count query rather
 * than from the length of a list nobody loaded.
 *
 * A page past the end is not an error. The API clamps to the last page and reports the `page` it
 * actually served, so a stale link or a hand-edited query parameter lands somewhere real.
 */
export type BacktestTradePageResponse = {
  items: BacktestTradeResponse[];
  /** 1-based, and the page actually served after clamping. */
  page: number;
  pageSize: number;
  /** Every trade the run executed, terminal liquidations included. */
  totalCount: number;
  /** At least 1, even for a run that traded nothing. */
  pageCount: number;
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
 * One actor group as a run froze it.
 *
 * `actorIds` are this product's canonical ids, in the group's own member order. They are the identity
 * execution filters by; the names beside them are labels for reporting and are never matched on.
 */
export type BacktestSnapshotActorGroup = {
  groupId: string;
  name: string;
  actorType: AlternativeActorType;
  members: { actorId: string; externalId: string; displayName: string }[];
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
/** One recorded revision a build cannot honour. */
export type BacktestRevisionMismatch = {
  field: string;
  /** What this build implements, or null when it does not know the field at all. */
  expected: string | null;
  /** What the run recorded, or null when it recorded nothing usable. */
  actual: string | null;
};

/**
 * Every difference between a recorded revision set and what a build supports, in **both**
 * directions.
 *
 * The obvious half is a value this build disagrees with, or one the run never recorded. The other
 * half is the one that bites during a rolling deploy: a *newer* API writes a snapshot naming a
 * revision an *older* worker has never heard of. Comparing only the keys this build knows would
 * find nothing wrong, and the old worker would execute a run governed by a decision it cannot
 * implement — the same reproducibility failure, arriving from the opposite direction.
 *
 * `BACKTEST_SNAPSHOT_VERSION` does not cover this: adding a methodology field does not bump it, and
 * in practice several have been added without one. So the key sets must match exactly.
 *
 * Lives here rather than in the engine because it is about the shape of the snapshot, and because
 * both the execution methodology (`@intrinsic/strategy`) and the data revisions
 * (`@intrinsic/stock-data`) are compared the same way and must not grow two implementations.
 */
export function revisionMismatches(
  recorded: unknown,
  supported: Readonly<Record<string, string | number>>,
): BacktestRevisionMismatch[] {
  const document =
    typeof recorded === "object" &&
    recorded !== null &&
    !Array.isArray(recorded)
      ? (recorded as Record<string, unknown>)
      : {};
  const scalar = (value: unknown): string | null =>
    typeof value === "string" || typeof value === "number"
      ? String(value)
      : null;

  const mismatches: BacktestRevisionMismatch[] = [];
  for (const [field, expected] of Object.entries(supported)) {
    const actual = document[field];
    if (actual !== expected) {
      mismatches.push({
        field,
        expected: String(expected),
        actual: scalar(actual),
      });
    }
  }
  for (const field of Object.keys(document)) {
    // `hasOwn`, not `in`: a snapshot key that happens to name something on `Object.prototype`
    // (`constructor`, `__proto__`) would otherwise look supported and slip through unchecked.
    if (!Object.prototype.hasOwnProperty.call(supported, field)) {
      // Recorded by a build that knew something this one does not.
      mismatches.push({
        field,
        expected: null,
        actual: scalar(document[field]),
      });
    }
  }
  return mismatches;
}

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
  /**
   * The actor groups the strategy references, with their membership **frozen at submission**.
   *
   * An actor group is mutable configuration, exactly like a Stock List, so a run must never depend on
   * its current state: `docs/alternative-data-signals.md` requires that editing a group later can
   * never change the semantics or the results of a run that already exists. Freezing the member ids
   * here is what implements that — execution resolves a `GROUP` scope through this list and never
   * through the database.
   *
   * Each member carries its identity *and* its label, so a completed run can still name the actors it
   * counted even after one has been renamed — or after the group itself has been deleted.
   *
   * **Optional, and absent on every run submitted before this feature.** A strategy that references no
   * group has nothing to freeze, so the field is omitted rather than written as an empty list; that
   * also means no existing snapshot changes, and `BACKTEST_SNAPSHOT_VERSION` does not move.
   */
  actorGroups?: BacktestSnapshotActorGroup[];
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
   * These are checked, not merely recorded: a worker refuses a run whose data interpretation it
   * cannot honour, exactly as it refuses an incompatible execution methodology. What they do *not*
   * promise is that re-fetching provider data years later returns the same historical rows — V1
   * does not persist raw provider vintages, and a provider correcting a row can change a **new**
   * backtest. A completed run's stored results are immutable either way.
   */
  dataRevisions: {
    priceDatasetVersion: number;
    derivedStateRevision: number;
    fundamentalsVariantVersion: number;
    benchmarkPriceDatasetVersion: number;
  };
};

/**
 * A run snapshot's frozen strategy definition, brought up to the current document schema.
 *
 * ## Why a snapshot needs this at all
 *
 * A `StrategyVersion` row is read through `normalizeStrategyDefinition` on every path, so a stored
 * strategy is upgraded wherever it is loaded. A run snapshot is not a strategy row: it is an
 * immutable copy taken at submission and it is the reproducibility authority (`AGENTS.md`
 * invariant 12), so a run queued, recovered or retried across a release still carries whatever
 * document schema was current when it was submitted — a run submitted before FINAL EXIT gained
 * Exit Rules holds `schemaVersion: 1` with a flat `finalExit.signal`.
 *
 * ## Why there are two of these, and not one
 *
 * The two consumers owe different things, so collapsing them would make one of them wrong:
 *
 * - {@link withExecutableStrategyDefinition} is for the **worker**. Its boundary's job is to run
 *   what was submitted, and the API already validated that document when it wrote it, so this
 *   applies the document upcast and nothing else. Adding validation there would let a snapshot the
 *   worker has always executed start being refused because a *later* release tightened a rule,
 *   which is precisely the retroactive reinterpretation invariant 12 forbids.
 * - {@link withCanonicalStrategyDefinition} is for the **API response**. Its boundary's job is to
 *   honour a published contract — `BacktestRunStrategyResponse.definition` is the current
 *   `StrategyDefinition` — so it canonicalizes fully, exactly as the strategy read path does. A
 *   document it cannot canonicalize is corruption and surfaces as such rather than being returned
 *   under a contract it does not satisfy.
 *
 * Both share two rules:
 *
 * 1. **The input is never mutated.** A new snapshot object with a new `strategy` object is
 *    returned; the caller's document — and therefore the `JSONB` row it was read from — is left
 *    exactly as submitted. Nothing here writes, and no caller may persist the result.
 * 2. **The projection is semantics-preserving.** The upcast rewrites `schemaVersion` and the FINAL
 *    EXIT slot and nothing else; a version 1 FINAL EXIT becomes the single Exit Rule it always
 *    meant. Neither reinterprets a rule.
 */
export function withExecutableStrategyDefinition(
  snapshot: BacktestRunSnapshot,
): BacktestRunSnapshot {
  const definition = upgradeStrategyDefinitionDocument(
    snapshot.strategy.definition,
  ) as StrategyDefinition;
  return definition === snapshot.strategy.definition
    ? snapshot
    : { ...snapshot, strategy: { ...snapshot.strategy, definition } };
}

/** The snapshot's definition as the current API contract publishes it. See above for why this is separate. */
export function withCanonicalStrategyDefinition(
  snapshot: BacktestRunSnapshot,
): BacktestRunSnapshot {
  const definition = normalizeStrategyDefinition(snapshot.strategy.definition);
  return {
    ...snapshot,
    strategy: { ...snapshot.strategy, definition },
  };
}

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
