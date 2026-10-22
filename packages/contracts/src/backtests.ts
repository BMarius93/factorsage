import type { StockSectorAssignmentResponse } from "./stock-sector-etfs.js";
import type { BuyWindowMode, BuyWindowRangeResponse } from "./stock-lists.js";
import { alternativeDataScope } from "./alternative-data.js";
import {
  collectAlternativeDataMetrics,
  describeCondition,
  describeTrigger,
  normalizeStrategyDefinition,
  upgradeStrategyDefinitionDocument,
  type StrategyDefinition,
  type StrategyScopeNames,
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
/**
 * The same guard for the built-in point-in-time index universe, whose distinct securities over a
 * thirty-year period are about twice its simultaneous members: every one is prepared, but only the
 * members and held positions of a year are evaluated in it. Sized from the S&P 500 universe's
 * measured worker footprint (`docs/decisions/sp500-historical-pit-v1.md` §8).
 */
export const BACKTEST_MAX_INDEX_UNIVERSE_SECURITIES = 2_000;
/** The most simultaneous members an index universe may hold at once for the engine to run it. */
export const BACKTEST_MAX_INDEX_UNIVERSE_CONSTITUENTS = 600;

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

/**
 * A run's user-facing identity: `Run #0001`, `Run #0002`, … — four digits, zero-padded, and wider
 * once an account passes 9,999 runs rather than wrapping.
 *
 * `runNumber` is sequential per user, allocated once at submission and never changed, so the label
 * is stable for the life of the run. The UUID `id` stays the technical identity every link uses.
 * The one place the label is spelled, so no surface formats it differently.
 */
export function backtestRunLabel(runNumber: number): string {
  return `Run #${String(runNumber).padStart(4, "0")}`;
}

/**
 * The Run ID a search names, if it names one: `Run #0012`, `run 12`, `#12`, `0012` and `12` all name
 * run 12. Anything else — including a number with other words around it — names none, and is
 * searched as text only. The inverse of {@link backtestRunLabel}, so a label copied from the page
 * finds its run.
 */
export function backtestRunNumberFromSearch(search: string): number | null {
  const match = /^\s*(?:run\s*)?#?\s*(\d{1,9})\s*$/i.exec(search);
  if (!match) {
    return null;
  }
  const runNumber = Number(match[1]);
  return Number.isSafeInteger(runNumber) && runNumber >= 1 ? runNumber : null;
}

/** One row of `GET /backtests`. */
export type BacktestRunSummaryResponse = {
  id: string;
  /** Sequential per user and immutable; rendered by {@link backtestRunLabel}. */
  runNumber: number;
  status: BacktestRunStatus;
  /**
   * The strategy and stock list the run was submitted with, exactly as on the run's
   * configuration: null once that entity has been deleted. Names are always the ones the run was
   * submitted with, stored with the run when it was queued, never the entity's current name.
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
  /**
   * The run's stored compound annual growth rate, null until it completes (and for a span too
   * short to annualize). The collection compares runs by it: cumulative returns over different
   * periods are not comparable.
   */
  portfolioCagrPercent: number | null;
};

/** Runs per page of the backtest collection by default, and the most one page may hold. */
export const BACKTEST_RUNS_PAGE_SIZE = 25;
export const BACKTEST_RUNS_MAX_PAGE_SIZE = 100;

/**
 * The orders the backtest collection can be read in, newest first by default. Every order ends on
 * the queue time and the run id, so a page boundary never splits or repeats equal keys.
 *
 * - `newest` / `oldest`: by queue time.
 * - `cagr`: by the stored annualized return, best first; runs without one (in flight, failed, too
 *   short to annualize) after every run that has one (BT-3).
 * - `strategy`: by the strategy name the run was submitted with, A–Z, ignoring case.
 */
export const BACKTEST_RUN_SORTS = [
  "newest",
  "oldest",
  "cagr",
  "strategy",
] as const;
export type BacktestRunSort = (typeof BACKTEST_RUN_SORTS)[number];

export const BACKTEST_RUN_DEFAULT_SORT: BacktestRunSort = "newest";

/**
 * The status filter of the backtest collection. `ACTIVE` is every run still queued or executing —
 * the runs holding a concurrency slot; `COMPLETED` and `FAILED` are the two terminal statuses.
 */
export const BACKTEST_RUN_STATUS_FILTERS = [
  "ACTIVE",
  "COMPLETED",
  "FAILED",
] as const;
export type BacktestRunStatusFilter =
  (typeof BACKTEST_RUN_STATUS_FILTERS)[number];

/** The longest search `GET /backtests` honours; a longer `q` is ignored. */
export const BACKTEST_RUN_QUERY_MAX_LENGTH = 100;

/**
 * One page of the caller's backtest runs: `GET /backtests?page=…`.
 *
 * Searched, filtered, ordered and paged in the database, so every page and every count is correct
 * across the whole history, not just the rows on screen, and no run's snapshot is read to build it.
 * As on the trade log, a page past the end is clamped to the last real one and reported as served,
 * and a filter or order the API did not recognise is reported as absent (and the default order).
 */
export type BacktestRunPageResponse = {
  runs: BacktestRunSummaryResponse[];
  /** 1-based, and the page actually served after clamping. */
  page: number;
  pageSize: number;
  /** The runs matching the search and the filter. */
  totalCount: number;
  /** At least 1, even when nothing matched. */
  pageCount: number;
  /** Every run the caller owns, whatever the search and filter: "no runs yet" vs "none match". */
  unfilteredCount: number;
  /** The search, the filter and the order the API actually applied. */
  q: string | null;
  status: BacktestRunStatusFilter | null;
  sort: BacktestRunSort;
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

function reasonBodyOf(
  signal: StrategySignal,
  names: StrategyScopeNames | undefined,
): BacktestTradeReasonBody {
  return {
    conditions: signal.conditions.map((condition) =>
      describeCondition(condition, names),
    ),
    ...(signal.trigger
      ? { trigger: describeTrigger(signal.trigger, names) }
      : {}),
  };
}

/**
 * The display names a run's own snapshot can vouch for: every actor it selected and every actor
 * group it froze, by the name each had at submission.
 *
 * Passed to {@link backtestTradeReasonIndex} so a scoped rule reads
 * `Congress buyers is above 1 (30D · Nancy Pelosi, Tommy Tuberville)` in the trade log from the
 * snapshot rather than from the catalog as it stands today, and a legacy group-scoped one
 * `(30D · House leadership)` — or `Selected group` if the run froze none.
 *
 * A run submitted before 2026-10-11 froze no actor labels, so a rule of its scoped to one member
 * finds no name here; the API fills those from the actor catalog, which never deletes a member.
 */
export function backtestSnapshotScopeNames(
  snapshot: Pick<BacktestRunSnapshot, "actorGroups" | "actors">,
): StrategyScopeNames {
  return {
    actors: Object.fromEntries(
      (snapshot.actors ?? []).map((actor) => [
        actor.actorId,
        actor.displayName,
      ]),
    ),
    groups: Object.fromEntries(
      (snapshot.actorGroups ?? []).map((group) => [group.groupId, group.name]),
    ),
  };
}

/**
 * Prepares {@link BacktestTradeReasonIndex} from the definition a run executed.
 *
 * `names` are the snapshot's own ({@link backtestSnapshotScopeNames}), so the descriptions are the
 * canonical sentences the Strategy logic preview prints, configuration included.
 */
export function backtestTradeReasonIndex(
  definition: StrategyDefinition,
  names?: StrategyScopeNames,
): BacktestTradeReasonIndex {
  const levels = new Map<string, BacktestTradeReasonBody>();
  const exitRules = new Map<string, BacktestTradeReasonBody>();
  for (const level of definition.buyLevels) {
    levels.set(level.id, reasonBodyOf(level.signal, names));
  }
  for (const level of definition.sellLevels) {
    levels.set(level.id, reasonBodyOf(level.signal, names));
  }
  const rules = definition.finalExit?.rules ?? [];
  rules.forEach((rule, index) => {
    exitRules.set(rule.id, {
      ...reasonBodyOf(rule.signal, names),
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
   * What the run's benchmark returned over **the same window** — from the same start (the previous
   * year's last simulated date, or the run's first simulated date) to the same `simulatedThrough`
   * — chained off the run's own benchmark growth index, which is the series every other benchmark
   * figure of the run comes from. A price return, exactly as the run's total benchmark return is.
   *
   * Null when the benchmark has no value at one end of that window — a benchmark whose history
   * begins after the window starts, or a run with no benchmark reading at all. Never estimated:
   * a figure over a shorter window would not be comparable with the Strategy's beside it.
   */
  benchmarkReturnPercent: number | null;
  /**
   * True when only part of the calendar year was simulated — the run's first year when it starts
   * after 1 January, its last when it ends before 31 December. The figure is still the true return
   * over the part that was simulated; nothing outside the requested period is fabricated.
   */
  partial: boolean;
};

/**
 * The benchmark side of {@link backtestAnnualReturns}: the benchmark's growth index on the run's
 * first simulated date, which is the base the first year's benchmark figure is measured from.
 *
 * The engine bases that index at 1.0 on the first date the benchmark has a value, so it is 1.0
 * whenever the benchmark had a value on the run's first simulated date — the same base the
 * Strategy's return index has — and null when the benchmark's history began later.
 */
export type BacktestAnnualBenchmarkBase = {
  readonly indexAtFirstSimulatedDate: number | null;
};

/**
 * Per-calendar-year returns, chained off the canonical time-weighted return index.
 *
 * ```text
 * annualReturn(year) = returnIndex(last simulated day of year)
 *                    / returnIndex(last simulated day of the previous year) - 1
 * ```
 *
 * The benchmark's figure for the same year reads the run's benchmark growth index on exactly the
 * same two dates — the Strategy's anchors — so the two numbers of a year always describe one
 * window:
 *
 * ```text
 * benchmarkAnnualReturn(year) = benchmarkIndex(last simulated day of year)
 *                             / benchmarkIndex(last simulated day of the previous year) - 1
 * ```
 *
 * with the first year divided by the index on the run's first simulated date (`benchmark`). A
 * missing reading at either anchor makes that year's benchmark figure null; it is never bridged
 * from a nearby date. Without `benchmark`, or without a `benchmarkIndex` on the points, every
 * benchmark figure is null.
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
  points: readonly {
    date: string;
    returnIndex: number;
    /** The run's benchmark growth index on the same date; null where it had no value. */
    benchmarkIndex?: number | null;
  }[],
  period: { startDate: string; endDate: string },
  benchmark?: BacktestAnnualBenchmarkBase,
): BacktestAnnualReturnResponse[] {
  type AnnualPoint = (typeof points)[number];
  const lastOfYear = new Map<string, AnnualPoint>();
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
  let previousBenchmarkIndex = usableIndex(
    benchmark?.indexAtFirstSimulatedDate,
  );
  return [...lastOfYear.keys()].sort().map((year) => {
    const point = lastOfYear.get(year) as AnnualPoint;
    const returnPercent = (point.returnIndex / previousIndex - 1) * 100;
    previousIndex = point.returnIndex;
    const benchmarkIndex = benchmark ? usableIndex(point.benchmarkIndex) : null;
    const benchmarkReturnPercent =
      benchmarkIndex === null || previousBenchmarkIndex === null
        ? null
        : (benchmarkIndex / previousBenchmarkIndex - 1) * 100;
    previousBenchmarkIndex = benchmarkIndex;
    return {
      year,
      simulatedThrough: point.date,
      returnPercent,
      benchmarkReturnPercent,
      partial:
        (year === startYear && startsMidYear) ||
        (year === endYear && endsMidYear),
    };
  });
}

/** A growth-index reading that can be divided by, or null: absent, non-finite or non-positive. */
function usableIndex(value: number | null | undefined): number | null {
  return value !== null &&
    value !== undefined &&
    Number.isFinite(value) &&
    value > 0
    ? value
    : null;
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
  /**
   * The benchmark's compound annual growth rate over the run's own simulated span, derived when
   * read with the engine's CAGR function from `benchmarkReturnPercent`; never stored. Null when the
   * run has no benchmark return or the span cannot be annualized.
   */
  benchmarkCagrPercent: number | null;
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
/**
 * Whether one ETF condition source could be evaluated by a run, in the aggregate: the actionable
 * answer to "why did my ETF conditions never fire?" (`ai/architecture/strategy-etf-conditions.md`
 * §7). `READY` still does not promise every session — dates before `firstSession`, indicator
 * warm-up and gaps are per-session absences — but a non-`READY` status names the operational cause.
 */
export type BacktestEtfConditionStatus =
  | "READY"
  /** The ETF's history was never bootstrapped to the floor; an operator action, not a data gap. */
  | "NOT_BOOTSTRAPPED"
  /** No completed tail read proves any stored bar final yet. */
  | "NOT_SYNCHRONIZED"
  /** Anchored and synchronized, but no finalized session holds a bar. */
  | "NO_FINALIZED_SESSIONS"
  /** The read failed during this run; re-running retries it. */
  | "LOAD_FAILED";

export type BacktestEtfConditionDiagnosticsResponse = {
  /** The stored source identity (`SP500`, `ETF_XLK`). */
  code: string;
  /** The display identity (`SPY`, `XLK`). */
  ticker: string;
  status: BacktestEtfConditionStatus;
  /** The first and newest finalized session the run's snapshot held, when `READY`. */
  firstSession?: string;
  latestSession?: string;
  /** The price-basis generation the run's ETF bars were read under, for reproducibility. */
  basisGeneration?: number;
  /**
   * The generation the run's snapshot recorded at submission, present only when it differs from
   * `basisGeneration`: the provider restated the fund's history (a re-base) between submission and
   * the run reading it, so the run computed on the restated history. Derived at read time from the
   * immutable snapshot and the immutable result; never stored.
   */
  submittedBasisGeneration?: number;
};

export type BacktestResultResponse = {
  summary: BacktestResultSummaryResponse;
  /** Per-calendar-year returns, non-cumulative. Empty for a run with no simulated year. */
  annualReturns: BacktestAnnualReturnResponse[];
  curve: BacktestCurvePointResponse[];
  /**
   * One row per ETF source the run's strategy read, in the definition's catalog order; absent for
   * a run whose strategy reads none — every run that existed before ETF conditions did. A sector
   * ETF a Stock's Sector rule read for some stock has its row here like any other.
   */
  etfConditions?: BacktestEtfConditionDiagnosticsResponse[];
  /**
   * Which sector ETF each stock's Stock's Sector rules read, from the run's snapshot, by symbol;
   * absent unless the strategy reads Stock's Sector. Derived at read time, never stored.
   */
  stockSectors?: StockSectorAssignmentResponse[];
};

// ---------------------------------------------------------------------------
// The paginated trade log
// ---------------------------------------------------------------------------

/** The default page of the trade log, and the largest page the API will serve. */
export const BACKTEST_TRADES_PAGE_SIZE = 50;
export const BACKTEST_TRADES_MAX_PAGE_SIZE = 200;

/**
 * The actions the trade log can be narrowed to: every `BacktestTradeAction`, and nothing else.
 *
 * `SELL` includes the end-of-backtest liquidations. They are sales and are stored as
 * `action: SELL`, with `source: END_OF_BACKTEST` saying who decided them, so the filter reads the
 * way the log reads: a `Sell 100%` row is found under Sell, and never under Final exit, which is a
 * decision the strategy made.
 */
export const BACKTEST_TRADE_ACTIONS = [
  "BUY",
  "SELL",
  "FINAL_EXIT",
] as const satisfies readonly BacktestTradeAction[];

/**
 * The two orders of the trade log, by the engine's execution `sequence`.
 *
 * `desc` (newest first) is the order the log has always been read in, and the default. `sequence`
 * is the order the engine executed in, so either direction is chronological and stable across
 * trades on the same date.
 */
export const BACKTEST_TRADE_ORDERS = ["desc", "asc"] as const;

export type BacktestTradeOrder = (typeof BACKTEST_TRADE_ORDERS)[number];

export const BACKTEST_TRADE_DEFAULT_ORDER: BacktestTradeOrder = "desc";

/**
 * What a reader narrowed the trade log to: one stock, one action, an order.
 *
 * One shape for the page and for the CSV export, so the file a reader downloads holds exactly the
 * trades the table could page through, in the same order.
 */
export type BacktestTradeLogQuery = {
  /** The traded symbol, exactly as the log prints it. Absent means every stock. */
  symbol?: string;
  /** Absent means every action. */
  action?: BacktestTradeAction;
  /** Absent means {@link BACKTEST_TRADE_DEFAULT_ORDER}. */
  order?: BacktestTradeOrder;
};

/**
 * One page of a completed run's trade log, newest trade first unless asked otherwise.
 *
 * Paged in the database rather than in the browser: an eighteen-thousand-trade run must not ship
 * eighteen thousand rows to display fifty of them, and `totalCount` comes from a count query rather
 * than from the length of a list nobody loaded. The filter is applied there too, so a filtered
 * count and every filtered page are correct across the whole log, not just the rows on screen.
 *
 * A page past the end is not an error. The API clamps to the last page and reports the `page` it
 * actually served, so a stale link or a hand-edited query parameter lands somewhere real.
 */
export type BacktestTradePageResponse = {
  items: BacktestTradeResponse[];
  /** 1-based, and the page actually served after clamping. */
  page: number;
  pageSize: number;
  /** The trades matching the filter; every trade the run executed when there is no filter. */
  totalCount: number;
  /** At least 1, even for a filter or a run that matched nothing. */
  pageCount: number;
  /** Every trade the run executed, terminal liquidations included, whatever the filter. */
  unfilteredCount: number;
  /**
   * Every distinct symbol the run traded, sorted: the stock filter's options.
   *
   * Independent of the filter, so narrowing to one action never removes a stock from the list it
   * was chosen from, and the browser never has to load the log to know what it holds.
   */
  symbols: string[];
  /**
   * The filter and the order the API actually applied. A value it did not recognise is reported
   * as absent (and the default order), never echoed back as if it had been honoured.
   */
  symbol: string | null;
  action: BacktestTradeAction | null;
  order: BacktestTradeOrder;
};

/** Anything outside these characters becomes a hyphen in an export file name. */
const EXPORT_FILENAME_UNSAFE = /[^A-Za-z0-9]+/g;

function exportFilenamePart(text: string, maxLength: number): string {
  return text
    .replace(EXPORT_FILENAME_UNSAFE, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

/**
 * The file name of a trade-log CSV export, e.g. `factorsage-trades-3f2a9c1d-AAPL-sell.csv`.
 *
 * Defined once because two places need it: the API's `Content-Disposition` header, and the browser,
 * which names the file it saves and cannot read that header across origins. It is built only from
 * ASCII letters, digits and hyphens, so it needs no quoting rules in a header and is a valid file
 * name on every platform. The filter is part of the name, so two exports of one run never claim to
 * be the same file.
 */
export function backtestTradesExportFilename(
  runId: string,
  query: BacktestTradeLogQuery = {},
): string {
  const parts = ["factorsage-trades", exportFilenamePart(runId, 8) || "run"];
  const symbol =
    query.symbol === undefined ? "" : exportFilenamePart(query.symbol, 24);
  if (symbol) {
    parts.push(symbol);
  }
  if (query.action) {
    parts.push(exportFilenamePart(query.action, 16).toLowerCase());
  }
  if (query.order === "asc") {
    parts.push("oldest-first");
  }
  return `${parts.join("-")}.csv`;
}

export type BacktestRunDetailResponse = {
  id: string;
  /** Sequential per user and immutable; rendered by {@link backtestRunLabel}. */
  runNumber: number;
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

/**
 * The snapshot document's versions.
 *
 * A snapshot is written at the **lowest version able to express it**, so the version is a statement
 * about what a worker must understand to execute this run rather than about when it was submitted:
 *
 * - `1` — everything a run could hold before 2026-10-11. Still written for every run whose strategy
 *   selects no member of Congress directly, so those snapshots, and their `snapshotHash`, are
 *   byte-for-byte what they always were.
 * - `2` — the frozen definition holds an `ACTORS` scope. A worker built before that scope existed
 *   refuses any version but `1` at the parse, which is the point: it would otherwise serialize the
 *   unknown scope as a group with no id, resolve it to nobody, and complete the run reporting zero
 *   congressional activity. A refusal is a failed run someone can re-submit; that would have been a
 *   wrong result nobody could see.
 *
 * {@link backtestSnapshotVersionFor} is the one place the choice is made.
 */
export const BACKTEST_SNAPSHOT_VERSION = 1;
export const BACKTEST_SNAPSHOT_VERSION_ACTOR_SELECTION = 2;
export const BACKTEST_SNAPSHOT_VERSIONS = [
  BACKTEST_SNAPSHOT_VERSION,
  BACKTEST_SNAPSHOT_VERSION_ACTOR_SELECTION,
] as const;
export type BacktestSnapshotVersion =
  (typeof BACKTEST_SNAPSHOT_VERSIONS)[number];

export function isBacktestSnapshotVersion(
  value: unknown,
): value is BacktestSnapshotVersion {
  return (BACKTEST_SNAPSHOT_VERSIONS as readonly unknown[]).includes(value);
}

/** The lowest snapshot version that can carry one frozen strategy definition. */
export function backtestSnapshotVersionFor(
  definition: StrategyDefinition,
): BacktestSnapshotVersion {
  return collectAlternativeDataMetrics(definition).some(
    (metric) => alternativeDataScope(metric)?.kind === "ACTORS",
  )
    ? BACKTEST_SNAPSHOT_VERSION_ACTOR_SELECTION
    : BACKTEST_SNAPSHOT_VERSION;
}

/** The point-in-time index universe a run's List carried, frozen at submission. */
export type BacktestSnapshotIndexUniverse = {
  kind: "POINT_IN_TIME_INDEX";
  indexKey: string;
  peakSimultaneousMembers: number;
};

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
  /**
   * Present on every security, and only, when the strategy reads Stock's Sector: the stock's FMP
   * sector as stored at submission and the sector ETF it resolved to — frozen here so the run, and
   * any re-execution of it, reads one fund per stock whatever the catalog says later
   * (`stock-sector-etfs.ts`). Absent otherwise, so every other snapshot is byte-for-byte unchanged.
   */
  sector?: BacktestSnapshotSecuritySector;
};

/**
 * One stock's frozen sector: the stored FMP name (null when it had none) and the sector ETF's code,
 * null when the sector was missing or not one of FMP's eleven. A null code makes the stock's
 * Stock's Sector rules not evaluable for the whole run; no other fund is substituted.
 */
export type BacktestSnapshotSecuritySector = {
  name: string | null;
  etfCode: string | null;
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
  members: { actorId: string; externalId: string; displayName: string }[];
};

/**
 * One member of Congress a run's strategy selects directly, as the run froze them.
 *
 * `actorId` is the identity and is what the frozen definition's `ACTORS` scope already holds — this
 * entry adds nothing execution reads. It exists for reporting: `externalId` (the bioguide id) says
 * who the member is independently of this database, and `displayName` is the label the member had at
 * submission, so a completed run names who it counted however the catalog reads later.
 */
export type BacktestSnapshotActor = {
  actorId: string;
  externalId: string;
  displayName: string;
};

/**
 * One ETF condition source as a run froze it: the stable code the definition names, the immutable
 * series it resolved to at submission, and the price basis then in force.
 *
 * The series is binding — execution reads that `seriesId` and nothing else. The basis generation is
 * a record, not a requirement: like a stock's, an ETF's basis is the one in force when the run
 * reads it, read once and never mixed (`docs/decisions/historical-price-basis-v1.md` §9). When it
 * differs from the one recorded here, the result says so (`submittedBasisGeneration`).
 */
export type BacktestSnapshotEtfSeries = {
  code: string;
  ticker: string;
  seriesId: string;
  seriesVersion: number;
  basisGeneration: number;
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
  snapshotVersion: BacktestSnapshotVersion;
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
    /**
     * Present only when the List is the built-in point-in-time index universe
     * (`docs/decisions/sp500-historical-pit-v1.md`): which index, and the most members its frozen
     * windows held at once inside the period, as the submission measured it. The worker checks the
     * figure against the frozen windows and its engine ceiling. Absent for every other List, so
     * their snapshots and `snapshotHash` are byte-for-byte what they always were.
     */
    universe?: BacktestSnapshotIndexUniverse;
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
  /**
   * Every member of Congress the frozen definition selects directly, with identity and label.
   *
   * The selection itself is in `strategy.definition` — an `ACTORS` scope holds its own ids — so
   * execution reads nothing here. This is the reporting half: who those ids were, by bioguide id and
   * by the name they had at submission.
   *
   * **Optional, absent on every run submitted before 2026-10-11** and on every run whose strategy
   * selects nobody directly, sorted by `actorId` so two submissions of one configuration are
   * byte-identical.
   */
  actors?: BacktestSnapshotActor[];
  /**
   * The ETF series behind every ETF-sourced condition of the frozen definition, pinned at
   * submission (`docs/decisions/strategy-etf-conditions-v1.md`;
   * `ai/architecture/strategy-etf-conditions.md` §6).
   *
   * The definition names a stable **code**; this section pins the immutable `seriesId` that code
   * resolved to, exactly as `benchmark` and `executionCalendar` pin theirs, so a catalog appending
   * a new series version can never change what a queued run's conditions read. Execution resolves
   * each context series by this id and never by code. `basisGeneration` is the price basis in
   * force at submission, recorded — not enforced — so a run that read a restated history says so
   * in its result, and a re-executed run whose numbers differ is explainable. ETF bars, like stock
   * bars, are replaced rather than versioned, which is the documented reproducibility boundary; a
   * run never mixes bases within itself either way, because it reads each ETF exactly once.
   *
   * **Optional, and absent on every run whose strategy reads no ETF** — including every run that
   * existed before the feature — so those snapshots and their `snapshotHash` stay byte-for-byte
   * what they always were. Sorted by `code`, so two submissions of one configuration are
   * byte-identical. The worker's snapshot parse requires this section and the definition's ETF
   * sources to agree exactly, and refuses the run otherwise: a definition reading an ETF nothing
   * pinned must never execute by silently resolving the catalog's current series.
   */
  etfSeries?: BacktestSnapshotEtfSeries[];
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
    priceBasisRevision: number;
    valuationRatioRevision: number;
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
