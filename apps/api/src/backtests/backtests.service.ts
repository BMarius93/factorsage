import { createHash } from "node:crypto";
import {
  BACKTEST_MAX_SECURITIES,
  BACKTEST_RESULT_MAX_CURVE_POINTS,
  BACKTEST_RESULT_MAX_TRADES,
  BACKTEST_FAILURE_PHASES,
  BACKTEST_SNAPSHOT_VERSION,
  canonicalBacktestSnapshotDocument,
  isTerminalBacktestStatus,
  normalizeStrategyDefinition,
  type BacktestCurvePointResponse,
  type BacktestFailurePhase,
  type BacktestFailureResponse,
  type BacktestHoldingResponse,
  type BacktestLiveSnapshotResponse,
  type BacktestMilestoneResponse,
  type BacktestProgressResponse,
  type BacktestResultResponse,
  type BacktestResultSummaryResponse,
  type BacktestRunConfigurationResponse,
  type BacktestRunDetailResponse,
  type BacktestRunSnapshot,
  type BacktestRunStatus,
  type BacktestRunStrategyResponse,
  type BacktestRunSummaryResponse,
  type BacktestSnapshotSecurity,
  type BacktestTradeAction,
  type BacktestTradeResponse,
} from "@intrinsic/contracts";
import {
  BacktestTradeAction as TradeAction,
  type Prisma,
} from "@intrinsic/database";
import {
  DEFAULT_BENCHMARK_CODE,
  EXECUTION_CALENDAR_REFERENCE_CODE,
  normalizeBuyWindowConfiguration,
} from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import { BACKTEST_DATA_REVISIONS } from "@intrinsic/stock-data";
import { getBacktestWorkerConfig } from "@intrinsic/config";
import { BACKTEST_METHODOLOGY } from "@intrinsic/strategy";
import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { BACKTESTS_LOGGER } from "./backtests.tokens";
import type { ParsedCreateBacktestRunRequest } from "./backtest-requests";

/**
 * Raised for a run that does not exist *or* is not owned by the caller. The two cases are
 * deliberately indistinguishable, so knowing another user's run id reveals nothing. There is no
 * ADMIN bypass, matching the strategy and stock-list slices.
 */
export class BacktestRunNotFoundError extends Error {
  constructor() {
    super("Backtest run was not found");
    this.name = "BacktestRunNotFoundError";
  }
}

/**
 * A submitted configuration that cannot become a run.
 *
 * A strategy or list that belongs to someone else produces the *same* message as one that does not
 * exist, so submission cannot be used to probe another user's rows.
 */
export class BacktestConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacktestConfigurationError";
  }
}

/**
 * The system cannot accept backtests right now, and the submission is not why.
 *
 * Separate from `BacktestConfigurationError` because a 400 would tell the user to fix something
 * they did not do wrong: a missing engine-designated execution-calendar series is a deployment
 * state, and the honest answer is that the service is unavailable, not that the request is invalid.
 */
export class BacktestUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacktestUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/**
 * The detail read never loads equity points, trades or positions eagerly: a thirty-year run has
 * thousands of them and a QUEUED or RUNNING run has none worth reading. They are fetched, bounded,
 * only once a run is COMPLETED.
 */
/** Milestones are bounded by the thirty-year period limit, so the whole progression loads. */
const MILESTONE_ORDER = {
  orderBy: { sequence: "asc" as const },
} satisfies Prisma.BacktestRun$milestonesArgs;

const RUN_DETAIL_INCLUDE = {
  progress: true,
  summary: true,
  milestones: MILESTONE_ORDER,
} satisfies Prisma.BacktestRunInclude;

type RunDetailRow = Prisma.BacktestRunGetPayload<{
  include: typeof RUN_DETAIL_INCLUDE;
}>;

/** The collection page renders no live snapshot, so the progress JSON stays on the server. */
const RUN_LIST_INCLUDE = {
  progress: { select: { percent: true, message: true } },
  summary: {
    select: {
      portfolioReturnPercent: true,
      benchmarkReturnPercent: true,
      alphaPercent: true,
    },
  },
} satisfies Prisma.BacktestRunInclude;

type RunListRow = Prisma.BacktestRunGetPayload<{
  include: typeof RUN_LIST_INCLUDE;
}>;

const PROGRESS_INCLUDE = {
  progress: true,
  milestones: MILESTONE_ORDER,
} satisfies Prisma.BacktestRunInclude;

type RunProgressRow = Prisma.BacktestRunGetPayload<{
  include: typeof PROGRESS_INCLUDE;
}>;

type TradeRow = Prisma.BacktestTradeGetPayload<true>;
type EquityRow = Prisma.BacktestDailyEquityGetPayload<true>;
type PositionRow = Prisma.BacktestPositionGetPayload<true>;
type SummaryRow = Prisma.BacktestRunSummaryGetPayload<true>;
type MilestoneRow = Prisma.BacktestRunMilestoneGetPayload<true>;

const STOCK_LIST_ITEM_INCLUDE = {
  security: true,
  buyWindows: { orderBy: { startDate: "asc" as const } },
} satisfies Prisma.StockListItemInclude;

/** Runs render newest-queued first; ids break same-tick ties. */
const RUN_ORDER = [{ queuedAt: "desc" as const }, { id: "desc" as const }];

// ---------------------------------------------------------------------------
// Value conversion at the boundary
// ---------------------------------------------------------------------------

function toDatabaseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function fromDatabaseDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Prisma `Decimal` never crosses the HTTP boundary: the contract declares plain numbers. */
function toNumber(value: Prisma.Decimal): number {
  return value.toNumber();
}

function toNullableNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}

// ---------------------------------------------------------------------------
// Reading the immutable snapshot
// ---------------------------------------------------------------------------

function asDocument(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Projects the stored submission document.
 *
 * The API writes this document itself and nothing ever updates it, so a row that fails the
 * structural check is corruption rather than an expected state: it fails loudly here instead of
 * reaching the browser as a half-described configuration.
 */
function readSnapshot(value: Prisma.JsonValue): BacktestRunSnapshot {
  const document = asDocument(value);
  if (
    !document ||
    !asDocument(document.strategy) ||
    !asDocument(document.stockList) ||
    !Array.isArray(document.securities) ||
    !asDocument(document.period) ||
    !asDocument(document.capital) ||
    !asDocument(document.allocation) ||
    !asDocument(document.benchmark) ||
    !asDocument(document.methodology)
  ) {
    throw new Error(
      "Backtest run snapshot is not a complete submission document",
    );
  }
  return document as unknown as BacktestRunSnapshot;
}

// ---------------------------------------------------------------------------
// Reading the worker-written live snapshot
// ---------------------------------------------------------------------------

const LIVE_NUMBER_FIELDS = [
  "completedDays",
  "totalDays",
  "cash",
  "positionsValue",
  "totalValue",
  "investedCapital",
  "netProfit",
  "portfolioReturnPercent",
  "maxDrawdownPercent",
  "tradeCount",
  "openPositions",
] as const;

const LIVE_NULLABLE_NUMBER_FIELDS = [
  "benchmarkReturnPercent",
  "alphaPercent",
] as const;

const HOLDING_NUMBER_FIELDS = [
  "shares",
  "averageCost",
  "lastPrice",
  "marketValue",
  "unrealizedPnlPercent",
  "allocationPercent",
] as const;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasNumbers(
  document: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every((field) => isFiniteNumber(document[field]));
}

function hasNullableNumbers(
  document: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every(
    (field) => document[field] === null || isFiniteNumber(document[field]),
  );
}

function isTradeAction(value: unknown): value is BacktestTradeAction {
  return Object.values(TradeAction).some((action) => action === value);
}

function isCurvePoint(value: unknown): value is BacktestCurvePointResponse {
  const point = asDocument(value);
  return (
    point !== null &&
    typeof point.date === "string" &&
    isFiniteNumber(point.portfolioReturnPercent) &&
    (point.benchmarkReturnPercent === null ||
      isFiniteNumber(point.benchmarkReturnPercent))
  );
}

function isHolding(value: unknown): value is BacktestHoldingResponse {
  const holding = asDocument(value);
  return (
    holding !== null &&
    typeof holding.symbol === "string" &&
    typeof holding.name === "string" &&
    hasNumbers(holding, HOLDING_NUMBER_FIELDS)
  );
}

function isTrade(value: unknown): value is BacktestTradeResponse {
  const trade = asDocument(value);
  return (
    trade !== null &&
    isFiniteNumber(trade.sequence) &&
    typeof trade.date === "string" &&
    typeof trade.symbol === "string" &&
    typeof trade.name === "string" &&
    isTradeAction(trade.action) &&
    (trade.levelPercentage === null || isFiniteNumber(trade.levelPercentage)) &&
    hasNumbers(trade, ["shares", "price", "amount"]) &&
    hasNullableNumbers(trade, ["realizedPnl", "realizedPnlPercent"])
  );
}

/**
 * The worker writes the live snapshot in the contract's own shape, so this is a boundary check
 * rather than a translation.
 *
 * It is checked anyway because the column is untyped JSON that a different process wrote, possibly
 * a version behind. A snapshot that does not match is reported as "no live state yet" — a polling
 * client keeps polling — instead of failing the whole read.
 */
function readLiveSnapshot(
  value: Prisma.JsonValue | null | undefined,
): BacktestLiveSnapshotResponse | null {
  const document = asDocument(value);
  if (
    !document ||
    typeof document.simulatedThrough !== "string" ||
    !hasNumbers(document, LIVE_NUMBER_FIELDS) ||
    !hasNullableNumbers(document, LIVE_NULLABLE_NUMBER_FIELDS) ||
    !Array.isArray(document.curve) ||
    !document.curve.every(isCurvePoint) ||
    !Array.isArray(document.holdings) ||
    !document.holdings.every(isHolding) ||
    !Array.isArray(document.recentTrades) ||
    !document.recentTrades.every(isTrade)
  ) {
    return null;
  }
  return document as unknown as BacktestLiveSnapshotResponse;
}

// ---------------------------------------------------------------------------
// Mapping rows onto the contract
// ---------------------------------------------------------------------------

/**
 * Live state belongs to a run that is still executing.
 *
 * Both terminal statuses drop it. A COMPLETED run reports its durable result instead. A FAILED run
 * reports its reason: the partial curve, metrics, holdings and trades the dead attempt happened to
 * reach are not that run's outcome, and presenting them beside the failure would read as one.
 */
function liveOf(
  status: BacktestRunStatus,
  progress: { snapshot: Prisma.JsonValue | null } | null,
): BacktestLiveSnapshotResponse | null {
  return isTerminalBacktestStatus(status)
    ? null
    : readLiveSnapshot(progress?.snapshot);
}

/**
 * `failureDetail` is developer diagnostics and is never read here: provider names, stack traces
 * and internal identifiers must not cross the HTTP boundary.
 */
function failureOf(run: {
  status: BacktestRunStatus;
  failureCode: string | null;
  failureMessage: string | null;
  failurePhase: string | null;
}): BacktestFailureResponse | null {
  if (run.status !== "FAILED" && run.failureCode === null) {
    return null;
  }
  // The phase is validated against the contract rather than passed through: a stored value the
  // browser does not know how to label would be worse than none.
  const phase = (BACKTEST_FAILURE_PHASES as readonly string[]).includes(
    run.failurePhase ?? "",
  )
    ? (run.failurePhase as BacktestFailurePhase)
    : null;
  return {
    code: run.failureCode ?? "EXECUTION_FAILED",
    message: run.failureMessage ?? "The backtest could not be completed",
    phase,
  };
}

/**
 * The configuration a run executed, read from its immutable snapshot and never from the current
 * Strategy or Stock List rows — that is the reproducibility invariant.
 *
 * The ids come from the nullable foreign keys instead, so a deleted strategy reports `null` while
 * its snapshotted name still renders.
 */
function configurationOf(
  run: { strategyId: string | null; stockListId: string | null },
  snapshot: BacktestRunSnapshot,
): BacktestRunConfigurationResponse {
  return {
    strategyId: run.strategyId,
    strategyName: snapshot.strategy.name,
    strategyVersionNumber: snapshot.strategy.versionNumber,
    stockListId: run.stockListId,
    stockListName: snapshot.stockList.name,
    securityCount: snapshot.securities.length,
    startDate: snapshot.period.startDate,
    endDate: snapshot.period.endDate,
    initialCapital: snapshot.capital.initialCapital,
    monthlyContribution: snapshot.capital.monthlyContribution,
    maximumPositions: snapshot.allocation.maximumPositions,
    fullPositionPercent: snapshot.allocation.fullPositionFraction * 100,
    benchmark: {
      benchmarkId: snapshot.benchmark.benchmarkId,
      code: snapshot.benchmark.code,
      name: snapshot.benchmark.name,
      sourceKind: snapshot.benchmark.sourceKind,
      methodologyVersion: snapshot.benchmark.methodologyVersion,
    },
    methodology: snapshot.methodology,
  };
}

function summaryRowOf(row: RunListRow): BacktestRunSummaryResponse {
  const snapshot = readSnapshot(row.snapshot);
  return {
    id: row.id,
    status: row.status,
    strategyName: snapshot.strategy.name,
    stockListName: snapshot.stockList.name,
    benchmarkCode: snapshot.benchmark.code,
    benchmarkName: snapshot.benchmark.name,
    startDate: snapshot.period.startDate,
    endDate: snapshot.period.endDate,
    initialCapital: snapshot.capital.initialCapital,
    maximumPositions: snapshot.allocation.maximumPositions,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt === null ? null : row.startedAt.toISOString(),
    completedAt:
      row.completedAt === null ? null : row.completedAt.toISOString(),
    progressPercent: row.progress?.percent ?? 0,
    progressMessage: row.progress?.message ?? null,
    portfolioReturnPercent:
      row.summary === null
        ? null
        : toNumber(row.summary.portfolioReturnPercent),
    benchmarkReturnPercent:
      row.summary === null
        ? null
        : toNullableNumber(row.summary.benchmarkReturnPercent),
    alphaPercent:
      row.summary === null ? null : toNullableNumber(row.summary.alphaPercent),
  };
}

function resultSummaryOf(row: SummaryRow): BacktestResultSummaryResponse {
  return {
    firstSimulatedDate: fromDatabaseDate(row.firstSimulatedDate),
    lastSimulatedDate: fromDatabaseDate(row.lastSimulatedDate),
    tradingDays: row.tradingDays,
    investedCapital: toNumber(row.investedCapital),
    finalCash: toNumber(row.finalCash),
    finalPositionsValue: toNumber(row.finalPositionsValue),
    finalValue: toNumber(row.finalValue),
    netProfit: toNumber(row.netProfit),
    portfolioReturnPercent: toNumber(row.portfolioReturnPercent),
    benchmarkReturnPercent: toNullableNumber(row.benchmarkReturnPercent),
    alphaPercent: toNullableNumber(row.alphaPercent),
    portfolioCagrPercent: toNullableNumber(row.portfolioCagrPercent),
    maxDrawdownPercent: toNumber(row.maxDrawdownPercent),
    benchmarkMaxDrawdownPercent: toNullableNumber(
      row.benchmarkMaxDrawdownPercent,
    ),
    realizedPnl: toNumber(row.realizedPnl),
    unrealizedPnl: toNumber(row.unrealizedPnl),
    totalTrades: row.totalTrades,
    buyTrades: row.buyTrades,
    sellTrades: row.sellTrades,
    finalExitTrades: row.finalExitTrades,
    winningTrades: row.winningTrades,
    losingTrades: row.losingTrades,
    openPositions: row.openPositions,
  };
}

/** Growth indices are based at 1.0 on the first simulated date; the wire carries percentages. */
function curvePointOf(row: EquityRow): BacktestCurvePointResponse {
  return {
    date: fromDatabaseDate(row.date),
    portfolioReturnPercent: (toNumber(row.returnIndex) - 1) * 100,
    benchmarkReturnPercent:
      row.benchmarkIndex === null
        ? null
        : (toNumber(row.benchmarkIndex) - 1) * 100,
  };
}

/**
 * Thins the curve to a bounded number of evenly spaced points, always keeping the first and last.
 *
 * A thirty-year run has roughly 7,500 daily points; every one stays durably persisted, but the
 * detail payload must not grow with the period. Keeping the endpoints preserves the run's actual
 * start and final return rather than a sampled approximation of them.
 */
function downsampleCurve(
  points: readonly BacktestCurvePointResponse[],
): BacktestCurvePointResponse[] {
  const maximum = BACKTEST_RESULT_MAX_CURVE_POINTS;
  if (points.length <= maximum) {
    return [...points];
  }
  const lastIndex = points.length - 1;
  const step = lastIndex / (maximum - 1);
  const sampled: BacktestCurvePointResponse[] = [];
  for (let position = 0; position < maximum; position += 1) {
    const index =
      position === maximum - 1 ? lastIndex : Math.round(position * step);
    const point = points[index];
    if (point !== undefined) {
      sampled.push(point);
    }
  }
  return sampled;
}

function tradeOf(row: TradeRow): BacktestTradeResponse {
  return {
    sequence: row.sequence,
    date: fromDatabaseDate(row.date),
    symbol: row.symbol,
    name: row.name,
    action: row.action,
    levelPercentage: row.levelPercentage,
    shares: toNumber(row.shares),
    price: toNumber(row.price),
    amount: toNumber(row.amount),
    realizedPnl: toNullableNumber(row.realizedPnl),
    realizedPnlPercent: toNullableNumber(row.realizedPnlPercent),
  };
}

function holdingOf(row: PositionRow): BacktestHoldingResponse {
  return {
    symbol: row.symbol,
    name: row.name,
    shares: toNumber(row.shares),
    averageCost: toNumber(row.averageCost),
    lastPrice: toNumber(row.lastPrice),
    lastPriceDate: fromDatabaseDate(row.lastPriceDate),
    marketValue: toNumber(row.marketValue),
    unrealizedPnlPercent: toNumber(row.unrealizedPnlPercent),
    allocationPercent: toNumber(row.allocationPercent),
  };
}

function detailOf(
  row: RunDetailRow,
  result: BacktestResultResponse | null,
): BacktestRunDetailResponse {
  const snapshot = readSnapshot(row.snapshot);
  return {
    id: row.id,
    status: row.status,
    configuration: configurationOf(row, snapshot),
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt === null ? null : row.startedAt.toISOString(),
    completedAt:
      row.completedAt === null ? null : row.completedAt.toISOString(),
    progress: {
      percent: row.progress?.percent ?? 0,
      message: row.progress?.message ?? null,
      simulatedThrough:
        row.progress?.simulatedThrough == null
          ? null
          : fromDatabaseDate(row.progress.simulatedThrough),
      sequence: row.progress?.sequence ?? 0,
      updatedAt: row.progress?.updatedAt.toISOString() ?? null,
    },
    live: liveOf(row.status, row.progress),
    milestones: row.milestones.map(milestoneOf),
    result,
    failure: failureOf(row),
  };
}

/**
 * One completed year of the run.
 *
 * Milestones are ordered and never overwritten, which is what lets a browser that polls more slowly
 * than the worker simulates still see the whole progression a run went through.
 */
function milestoneOf(row: MilestoneRow): BacktestMilestoneResponse {
  return {
    sequence: row.sequence,
    year: row.year,
    simulatedThrough: fromDatabaseDate(row.simulatedThrough),
    percent: row.percent,
    completedDays: row.completedDays,
    totalDays: row.totalDays,
    cash: toNumber(row.cash),
    totalValue: toNumber(row.totalValue),
    investedCapital: toNumber(row.investedCapital),
    portfolioReturnPercent: toNumber(row.portfolioReturnPercent),
    benchmarkReturnPercent: toNullableNumber(row.benchmarkReturnPercent),
    alphaPercent: toNullableNumber(row.alphaPercent),
    maxDrawdownPercent: toNumber(row.maxDrawdownPercent),
    tradeCount: row.tradeCount,
    openPositions: row.openPositions,
  };
}

function progressOf(row: RunProgressRow): BacktestProgressResponse {
  return {
    runId: row.id,
    status: row.status,
    percent: row.progress?.percent ?? 0,
    message: row.progress?.message ?? null,
    simulatedThrough:
      row.progress?.simulatedThrough == null
        ? null
        : fromDatabaseDate(row.progress.simulatedThrough),
    sequence: row.progress?.sequence ?? 0,
    updatedAt: row.progress?.updatedAt.toISOString() ?? null,
    startedAt: row.startedAt === null ? null : row.startedAt.toISOString(),
    completedAt:
      row.completedAt === null ? null : row.completedAt.toISOString(),
    live: liveOf(row.status, row.progress),
    milestones: row.milestones.map(milestoneOf),
    failure: failureOf(row),
  };
}

@Injectable()
export class BacktestsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BACKTESTS_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  /**
   * Resolves a submitted configuration into an immutable snapshot and queues the durable work.
   *
   * Everything that can move a number is frozen here — the strategy version and its normalized
   * definition, the resolved securities with their canonical BUY windows, the period, the capital
   * assumptions, the derived full-position policy, the benchmark identity and every methodology
   * version — because `ai/product/backtests.md` requires that editing a Strategy or Stock List
   * afterwards never changes a running or completed run.
   */
  async submitRun(
    userId: string,
    input: ParsedCreateBacktestRunRequest,
  ): Promise<BacktestRunDetailResponse> {
    const startedAt = Date.now();
    const strategy = await this.prisma.strategy.findFirst({
      where: { id: input.strategyId, userId },
      include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } },
    });
    if (!strategy) {
      throw new BacktestConfigurationError(
        "The selected strategy was not found",
      );
    }
    const version = strategy.versions[0];
    if (!version) {
      throw new BacktestConfigurationError(
        "The selected strategy has no saved definition to run",
      );
    }
    // The canonical normalizer is the one parser of a stored definition, exactly as the strategy
    // read path uses it. A row it rejects is corruption, not a client mistake, so it is left to
    // surface as an internal failure rather than being reported as a bad submission.
    const definition = normalizeStrategyDefinition(version.definition);

    const stockList = await this.prisma.stockList.findFirst({
      where: { id: input.stockListId, userId },
      include: {
        items: {
          include: STOCK_LIST_ITEM_INCLUDE,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
    });
    if (!stockList) {
      throw new BacktestConfigurationError(
        "The selected stock list was not found",
      );
    }
    if (stockList.items.length === 0) {
      throw new BacktestConfigurationError(
        "The selected stock list is empty; add at least one stock before running a backtest",
      );
    }
    if (stockList.items.length > BACKTEST_MAX_SECURITIES) {
      throw new BacktestConfigurationError(
        `A backtest can cover at most ${BACKTEST_MAX_SECURITIES} stocks; this list has ${stockList.items.length}`,
      );
    }

    const benchmarkCode = input.benchmarkCode ?? DEFAULT_BENCHMARK_CODE;
    const benchmark = await this.prisma.benchmark.findFirst({
      where: { code: benchmarkCode, isActive: true },
      include: { series: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!benchmark) {
      throw new BacktestConfigurationError(
        `\`${benchmarkCode}\` is not a selectable benchmark`,
      );
    }
    const benchmarkSeries = benchmark.series[0];
    if (!benchmarkSeries) {
      throw new BacktestConfigurationError(
        `\`${benchmarkCode}\` has no reconciled series definition`,
      );
    }

    // The execution calendar's source is the engine's, not the user's. Resolved once here and
    // pinned, so the run keeps simulating the same dates however the catalog moves afterwards.
    //
    // Required, and therefore a refusal rather than a degradation: the calendar is part of the
    // methodology the snapshot records, so a run that cannot pin it would have to be executed under
    // a methodology it never recorded. Better to not create it.
    const executionCalendarSeries = (
      await this.prisma.benchmark.findFirst({
        where: { code: EXECUTION_CALENDAR_REFERENCE_CODE },
        include: { series: { orderBy: { version: "desc" }, take: 1 } },
      })
    )?.series[0];
    if (!executionCalendarSeries) {
      throw new BacktestUnavailableError(
        "Backtests are temporarily unavailable: the market calendar they run on is not registered.",
      );
    }

    // Sorted by symbol so two submissions of the same list produce byte-identical documents, which
    // is what makes `snapshotHash` a usable identity for "these are the same inputs".
    const securities: BacktestSnapshotSecurity[] = stockList.items
      .map((item) => {
        const buyWindows = normalizeBuyWindowConfiguration({
          mode: item.buyWindowMode,
          ranges: item.buyWindows.map((window) => ({
            startDate: fromDatabaseDate(window.startDate),
            endDate:
              window.endDate === null ? null : fromDatabaseDate(window.endDate),
          })),
        });
        return {
          securityId: item.security.id,
          symbol: item.security.symbol,
          name: item.security.name,
          exchangeCode: item.security.exchangeCode,
          currency: item.security.currency,
          buyWindowMode: buyWindows.mode,
          buyWindows: buyWindows.ranges.map((range) => ({
            startDate: range.startDate,
            endDate: range.endDate,
          })),
        };
      })
      .sort(
        (left, right) =>
          left.symbol.localeCompare(right.symbol) ||
          left.securityId.localeCompare(right.securityId),
      );

    const snapshot: BacktestRunSnapshot = {
      snapshotVersion: BACKTEST_SNAPSHOT_VERSION,
      submittedAt: new Date().toISOString(),
      strategy: {
        strategyId: strategy.id,
        name: strategy.name,
        versionId: version.id,
        versionNumber: version.versionNumber,
        definitionHash: version.definitionHash,
        definition,
      },
      stockList: { stockListId: stockList.id, name: stockList.name },
      securities,
      period: { startDate: input.startDate, endDate: input.endDate },
      capital: {
        initialCapital: input.initialCapital,
        monthlyContribution: input.monthlyContribution,
      },
      allocation: {
        maximumPositions: input.maximumPositions,
        fullPositionFraction: 1 / input.maximumPositions,
      },
      benchmark: {
        benchmarkId: benchmark.id,
        // The exact immutable series, pinned here and resolved by id at execution. A later catalog
        // change appends a new version and leaves this one — and its bars — untouched.
        seriesId: benchmarkSeries.id,
        seriesVersion: benchmarkSeries.version,
        code: benchmark.code,
        name: benchmark.name,
        sourceKind: benchmarkSeries.sourceKind,
        providerSymbol: benchmarkSeries.providerSymbol,
        methodologyVersion: benchmarkSeries.methodologyVersion,
        currency: benchmarkSeries.currency,
      },
      executionCalendar: {
        // The dates this run simulates come from a series the *engine* names, never from the
        // comparison above: two runs differing only in what they are compared against must
        // execute identically.
        referenceCode: EXECUTION_CALENDAR_REFERENCE_CODE,
        seriesId: executionCalendarSeries.id,
        seriesVersion: executionCalendarSeries.version,
      },
      methodology: { ...BACKTEST_METHODOLOGY },
      dataRevisions: { ...BACKTEST_DATA_REVISIONS },
    };
    // Taken over the canonical serialization from `@intrinsic/contracts`: `submittedAt` excluded
    // so the digest identifies inputs rather than a moment, and keys sorted so it can still be
    // re-derived from the `JSONB` column, which does not preserve key order.
    const snapshotHash = createHash("sha256")
      .update(canonicalBacktestSnapshotDocument(snapshot))
      .digest("hex");

    // One statement, therefore one transaction: the run, its durable queue row and its progress
    // row are created together, so the queue and the execution record can never disagree about
    // what work exists.
    const run = await this.prisma.backtestRun.create({
      data: {
        userId,
        strategyId: strategy.id,
        strategyVersionId: version.id,
        stockListId: stockList.id,
        benchmarkId: benchmark.id,
        benchmarkSeriesId: benchmarkSeries.id,
        executionCalendarSeriesId: executionCalendarSeries.id,
        status: "QUEUED",
        startDate: toDatabaseDate(input.startDate),
        endDate: toDatabaseDate(input.endDate),
        initialCapital: input.initialCapital,
        monthlyContribution: input.monthlyContribution,
        maximumPositions: input.maximumPositions,
        strategyName: strategy.name,
        stockListName: stockList.name,
        securityCount: securities.length,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        snapshotHash,
        job: {
          create: {
            status: "QUEUED",
            availableAt: new Date(),
            // The retry bound travels with the job row so recovery reads one durable value rather
            // than whichever worker process happens to reclaim it.
            maxAttempts: getBacktestWorkerConfig().maxAttempts,
          },
        },
        progress: { create: { percent: 0, message: "Queued", sequence: 0 } },
      },
      include: { ...RUN_DETAIL_INCLUDE, job: { select: { id: true } } },
    });

    this.logger.info({
      event: "backtest.queued",
      actorUserId: userId,
      runId: run.id,
      jobId: run.job?.id ?? null,
      strategyId: strategy.id,
      stockListId: stockList.id,
      benchmarkCode: benchmark.code,
      securityCount: securities.length,
      startDate: input.startDate,
      endDate: input.endDate,
      maximumPositions: input.maximumPositions,
      durationMs: Date.now() - startedAt,
    });
    return detailOf(run, null);
  }

  async listForUser(userId: string): Promise<BacktestRunSummaryResponse[]> {
    const rows = await this.prisma.backtestRun.findMany({
      where: { userId },
      orderBy: RUN_ORDER,
      include: RUN_LIST_INCLUDE,
    });
    return rows.map(summaryRowOf);
  }

  async getRun(
    userId: string,
    runId: string,
  ): Promise<BacktestRunDetailResponse> {
    const run = await this.prisma.backtestRun.findFirst({
      where: { id: runId, userId },
      include: RUN_DETAIL_INCLUDE,
    });
    if (!run) {
      throw new BacktestRunNotFoundError();
    }
    return detailOf(run, await this.readResult(run));
  }

  /**
   * The polling payload. It reads the run row and its single progress row and nothing else: the
   * running page fetches this about once a second, so it must never touch the equity or trade
   * tables of a run that is still growing them.
   */
  async getProgress(
    userId: string,
    runId: string,
  ): Promise<BacktestProgressResponse> {
    const run = await this.prisma.backtestRun.findFirst({
      where: { id: runId, userId },
      include: PROGRESS_INCLUDE,
    });
    if (!run) {
      throw new BacktestRunNotFoundError();
    }
    return progressOf(run);
  }

  /** The definition as of submission, from the snapshot — not the strategy's current version. */
  async getRunStrategy(
    userId: string,
    runId: string,
  ): Promise<BacktestRunStrategyResponse> {
    const run = await this.prisma.backtestRun.findFirst({
      where: { id: runId, userId },
      select: { snapshot: true },
    });
    if (!run) {
      throw new BacktestRunNotFoundError();
    }
    const snapshot = readSnapshot(run.snapshot);
    return {
      strategyName: snapshot.strategy.name,
      versionNumber: snapshot.strategy.versionNumber,
      definition: snapshot.strategy.definition,
    };
  }

  /**
   * Results exist only for a COMPLETED run. Trades are the most recent
   * `BACKTEST_RESULT_MAX_TRADES` by execution sequence; the summary's `totalTrades` always reports
   * the true count, and every row remains durably persisted.
   */
  private async readResult(
    run: RunDetailRow,
  ): Promise<BacktestResultResponse | null> {
    if (run.status !== "COMPLETED" || run.summary === null) {
      return null;
    }
    const [equity, trades, positions] = await Promise.all([
      this.prisma.backtestDailyEquity.findMany({
        where: { runId: run.id },
        orderBy: { date: "asc" },
      }),
      this.prisma.backtestTrade.findMany({
        where: { runId: run.id },
        orderBy: { sequence: "desc" },
        take: BACKTEST_RESULT_MAX_TRADES,
      }),
      this.prisma.backtestPosition.findMany({
        where: { runId: run.id },
        orderBy: [{ marketValue: "desc" }, { symbol: "asc" }],
      }),
    ]);
    return {
      summary: resultSummaryOf(run.summary),
      curve: downsampleCurve(equity.map(curvePointOf)),
      trades: trades.map(tradeOf),
      holdings: positions.map(holdingOf),
    };
  }
}
