import { createHash } from "node:crypto";
import {
  alternativeDataScope,
  collectActorGroupIds,
  collectActorIds,
  collectAlternativeDataMetrics,
  collectStrategyEtfSources,
  findStrategyEtfSource,
  resolveStockSectorEtf,
  stockSectorEtfTicker,
  strategyReadsStockSector,
  type BacktestEtfConditionDiagnosticsResponse,
  type BacktestSnapshotSecuritySector,
  type StockSectorAssignmentResponse,
  type StrategyEtfSourceCode,
  type BacktestSnapshotActor,
  type BacktestSnapshotActorGroup,
  type BacktestSnapshotEtfSeries,
  type StrategyDefinition,
  type StrategyScopeNames,
  backtestAnnualReturns,
  backtestPeriodYears,
  backtestSnapshotScopeNames,
  backtestTradeReason,
  backtestTradeReasonIndex,
  BACKTEST_MAX_INDEX_UNIVERSE_CONSTITUENTS,
  BACKTEST_MAX_INDEX_UNIVERSE_SECURITIES,
  BACKTEST_MAX_SECURITIES,
  BACKTEST_RESULT_MAX_CURVE_POINTS,
  BACKTEST_TRADES_MAX_PAGE_SIZE,
  BACKTEST_TRADES_PAGE_SIZE,
  BACKTEST_TRADE_DEFAULT_ORDER,
  backtestTradesExportFilename,
  BACKTEST_FAILURE_PHASES,
  backtestSnapshotVersionFor,
  backtestRunNumberFromSearch,
  canonicalBacktestSnapshotDocument,
  isTerminalBacktestStatus,
  normalizeStrategyDefinition,
  withCanonicalStrategyDefinition,
  type BacktestAnnualReturnResponse,
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
  type BacktestRunPageResponse,
  type BacktestRunSort,
  BACKTEST_RUN_DEFAULT_SORT,
  BACKTEST_RUNS_MAX_PAGE_SIZE,
  BACKTEST_RUNS_PAGE_SIZE,
  type BacktestSnapshotSecurity,
  type AuthUser,
  type BacktestTradeAction,
  type BacktestTradeLogQuery,
  type BacktestTradeOrder,
  type BacktestTradePageResponse,
  type BacktestTradeReasonIndex,
  type BacktestTradeResponse,
  type BacktestTradeSource,
  type BacktestQueueStateResponse,
} from "@intrinsic/contracts";
import {
  allocateBacktestRunNumber,
  type BacktestJobStatus,
  BacktestTradeAction as TradeAction,
  BacktestTradeSource as TradeSource,
  ContentOwnership,
  Prisma,
} from "@intrinsic/database";
import {
  benchmarkDisplayName,
  DEFAULT_BENCHMARK_CODE,
  normalizeBuyWindowConfiguration,
  peakSimultaneousMembers,
  maintainedUniverseForList,
} from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import { BACKTEST_DATA_REVISIONS } from "@intrinsic/stock-data";
import {
  getBacktestAdmissionConfig,
  getBacktestWorkerConfig,
} from "@intrinsic/config";
import { BACKTEST_METHODOLOGY, cagrPercent } from "@intrinsic/strategy";
import { Inject, Injectable } from "@nestjs/common";
import {
  assertPremiumAccessible,
  readableWhere,
} from "../builtins/content-access";
import { PrismaService } from "../database/prisma.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import {
  BACKTESTS_LOGGER,
  EXECUTION_CALENDAR_REFERENCE,
} from "./backtests.tokens";
import type {
  BacktestRunListQuery,
  ParsedCreateBacktestRunRequest,
} from "./backtest-requests";
import {
  tradeLogCsvHeader,
  tradeLogCsvRecord,
  UTF8_BOM,
  type TradeLogCsvTrade,
} from "./trade-log-csv";

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

/**
 * The deployment-wide queue is full (`BACKTEST_QUEUE_MAX_QUEUED`): admission backpressure, never an
 * entitlement. The caller's plan allows the run; the deployment cannot accept more waiting work
 * right now, so the answer is `503` with a `Retry-After`, and nothing was created.
 */
export class BacktestQueueFullError extends Error {
  constructor(
    readonly queued: number,
    readonly retryAfterSeconds: number,
  ) {
    super(
      `Backtests are in high demand right now and the queue is full. Try again in ${
        retryAfterSeconds <= 90
          ? "a minute"
          : `about ${Math.round(retryAfterSeconds / 60)} minutes`
      }.`,
    );
    this.name = "BacktestQueueFullError";
  }
}

/** A run that already reached `COMPLETED` or `FAILED` cannot be cancelled. */
export class BacktestNotCancellableError extends Error {
  constructor(readonly status: BacktestRunStatus) {
    super(
      status === "COMPLETED"
        ? "This backtest has already completed"
        : "This backtest has already finished",
    );
    this.name = "BacktestNotCancellableError";
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

/** What the read surface needs of the durable queue row: its state and its place in the queue. */
const RUN_JOB_SELECT = {
  select: {
    id: true,
    status: true,
    availableAt: true,
    createdAt: true,
    cancelRequestedAt: true,
  },
} satisfies Prisma.BacktestRunInclude["job"];

const RUN_DETAIL_INCLUDE = {
  progress: true,
  summary: true,
  milestones: MILESTONE_ORDER,
  job: RUN_JOB_SELECT,
} satisfies Prisma.BacktestRunInclude;

type RunDetailRow = Prisma.BacktestRunGetPayload<{
  include: typeof RUN_DETAIL_INCLUDE;
}>;

/** The collection page renders no live snapshot, so the progress JSON stays on the server. */
/**
 * What one row of the collection reads: stored columns and three one-row relations, never the
 * snapshot. The names were stored with the run when it was queued, from the very values its snapshot
 * recorded, so a row reads exactly what it would have read from the snapshot, without opening it.
 */
const RUN_INDEX_SELECT = {
  id: true,
  runNumber: true,
  status: true,
  strategyId: true,
  strategyName: true,
  stockListId: true,
  stockListName: true,
  benchmarkName: true,
  startDate: true,
  endDate: true,
  initialCapital: true,
  maximumPositions: true,
  queuedAt: true,
  startedAt: true,
  completedAt: true,
  // The code is the benchmark's stable product code; source and methodology belong to the immutable
  // series the run pinned. With the stored name, they are the snapshot's own benchmark identity.
  benchmark: { select: { code: true } },
  benchmarkSeries: { select: { sourceKind: true, methodologyVersion: true } },
  progress: { select: { percent: true, message: true } },
  summary: {
    select: {
      portfolioReturnPercent: true,
      benchmarkReturnPercent: true,
      alphaPercent: true,
      // The stored annualized return, so the collection can compare runs of different lengths
      // (BT-3) without computing a figure of its own.
      portfolioCagrPercent: true,
    },
  },
} satisfies Prisma.BacktestRunSelect;

type RunIndexRow = Prisma.BacktestRunGetPayload<{
  select: typeof RUN_INDEX_SELECT;
}>;

/** `%`, `_` and `\` in a search are text, not wildcards or escapes. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** The caller's runs matching the search and the filter, as one SQL condition. */
function runListCondition(
  userId: string,
  { q, status }: BacktestRunListQuery,
): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`run."userId" = ${userId}`];
  if (status === "ACTIVE") {
    conditions.push(
      Prisma.sql`run."status" NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
    );
  } else if (status !== undefined) {
    conditions.push(Prisma.sql`run."status" = ${status}::"BacktestRunStatus"`);
  }
  if (q !== undefined) {
    const pattern = likePattern(q);
    // A search that names a Run ID (`Run #0012`, `#12`, `12`) also finds that run.
    const runNumber = backtestRunNumberFromSearch(q);
    const byRunNumber =
      runNumber === null
        ? Prisma.empty
        : Prisma.sql` OR run."runNumber" = ${runNumber}`;
    conditions.push(
      Prisma.sql`(run."strategyName" ILIKE ${pattern} OR run."stockListName" ILIKE ${pattern} OR run."benchmarkName" ILIKE ${pattern}${byRunNumber})`,
    );
  }
  return Prisma.join(conditions, " AND ");
}

/**
 * Each order, ending on the queue time and the id so equal keys always land the same way and a page
 * boundary never splits or repeats them.
 */
const RUN_LIST_ORDER: Readonly<Record<BacktestRunSort, Prisma.Sql>> = {
  newest: Prisma.sql`run."queuedAt" DESC, run."id" DESC`,
  oldest: Prisma.sql`run."queuedAt" ASC, run."id" ASC`,
  // Runs without an annualized return yet sort after every run that has one (BT-3).
  cagr: Prisma.sql`summary."portfolioCagrPercent" DESC NULLS LAST, run."queuedAt" DESC, run."id" DESC`,
  // Case-insensitive, as a reader expects "alpha" beside "Alpha", whatever the database collation.
  strategy: Prisma.sql`lower(run."strategyName") ASC, run."queuedAt" DESC, run."id" DESC`,
};

const PROGRESS_INCLUDE = {
  progress: true,
  milestones: MILESTONE_ORDER,
  job: RUN_JOB_SELECT,
} satisfies Prisma.BacktestRunInclude;

type RunJobState = {
  status: BacktestJobStatus;
  cancelRequestedAt: Date | null;
} | null;

/**
 * A cancellation the owner asked for that has not taken effect yet: the job is still `CLAIMED`,
 * and its worker stops at the next checkpoint. Once it has, the run itself reads `CANCELLED`.
 */
function cancellationOf(
  job: RunJobState,
): { requestedAt: string } | undefined {
  return job?.status === "CLAIMED" && job.cancelRequestedAt
    ? { requestedAt: job.cancelRequestedAt.toISOString() }
    : undefined;
}

type RunProgressRow = Prisma.BacktestRunGetPayload<{
  include: typeof PROGRESS_INCLUDE;
}>;

type TradeRow = Prisma.BacktestTradeGetPayload<true>;
type EquityRow = Prisma.BacktestDailyEquityGetPayload<true>;

/** The equity columns a chart point is projected from; every other column stays in the database. */
export const CURVE_EQUITY_SELECT = {
  date: true,
  returnIndex: true,
  benchmarkIndex: true,
  totalValue: true,
  benchmarkValue: true,
  cashBaselineValue: true,
} satisfies Prisma.BacktestDailyEquitySelect;

type CurveEquityRow = Prisma.BacktestDailyEquityGetPayload<{
  select: typeof CURVE_EQUITY_SELECT;
}>;
type SummaryRow = Prisma.BacktestRunSummaryGetPayload<true>;
type MilestoneRow = Prisma.BacktestRunMilestoneGetPayload<true>;

const STOCK_LIST_ITEM_INCLUDE = {
  security: true,
  buyWindows: { orderBy: { startDate: "asc" as const } },
} satisfies Prisma.StockListItemInclude;

// ---------------------------------------------------------------------------
// Value conversion at the boundary
// ---------------------------------------------------------------------------

function toDatabaseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function fromDatabaseDate(value: Date): string {
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
/**
 * Each ETF's diagnostics row, with the basis generation its snapshot recorded at submission when
 * the run read another one.
 *
 * Both sides are immutable — the snapshot written at submission, the rows written with the result —
 * so this is a fact about the run, derived at read time rather than stored. A different generation
 * means the provider restated the fund's history (a re-base) after submission and the run computed
 * on the restated history: one basis, read once, but not the one in force when it was submitted.
 */
function withSubmittedBasis(
  rows: readonly BacktestEtfConditionDiagnosticsResponse[],
  pins: readonly BacktestSnapshotEtfSeries[],
): BacktestEtfConditionDiagnosticsResponse[] {
  return rows.map((row) => {
    const pinned = pins.find((pin) => pin.code === row.code)?.basisGeneration;
    return pinned !== undefined &&
      row.basisGeneration !== undefined &&
      pinned !== row.basisGeneration
      ? { ...row, submittedBasisGeneration: pinned }
      : row;
  });
}

/** The run's frozen sector assignments, by symbol; nothing when no rule reads Stock's Sector. */
function stockSectorsOf(
  snapshot: BacktestRunSnapshot,
): { stockSectors?: StockSectorAssignmentResponse[] } {
  if (!snapshot.securities.some((security) => security.sector !== undefined)) {
    return {};
  }
  return {
    stockSectors: snapshot.securities.map((security) => ({
      symbol: security.symbol,
      sector: security.sector?.name ?? null,
      code: security.sector?.etfCode ?? null,
      ticker: security.sector?.etfCode
        ? stockSectorEtfTicker(security.sector.etfCode as StrategyEtfSourceCode)
        : null,
    })),
  };
}

/** One stock's sector as a snapshot freezes it: the stored FMP name and its sector ETF, or nulls. */
function frozenSector(
  sector: string | null | undefined,
): BacktestSnapshotSecuritySector {
  const resolution = resolveStockSectorEtf(sector);
  return {
    name: sector?.trim() ? sector.trim() : null,
    etfCode: resolution.status === "RESOLVED" ? resolution.code : null,
  };
}

export function readSnapshot(value: Prisma.JsonValue): BacktestRunSnapshot {
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
  "cashBaselineValue",
  "tradeCount",
  "openPositions",
] as const;

const LIVE_NULLABLE_NUMBER_FIELDS = [
  "benchmarkReturnPercent",
  "alphaPercent",
  "portfolioCagrPercent",
  "benchmarkValue",
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

function isTradeSource(value: unknown): value is BacktestTradeSource {
  return Object.values(TradeSource).some((source) => source === value);
}

function isCurvePoint(value: unknown): value is BacktestCurvePointResponse {
  const point = asDocument(value);
  return (
    point !== null &&
    typeof point.date === "string" &&
    isFiniteNumber(point.portfolioReturnPercent) &&
    (point.benchmarkReturnPercent === null ||
      isFiniteNumber(point.benchmarkReturnPercent)) &&
    isFiniteNumber(point.strategyValue) &&
    isFiniteNumber(point.cashBaselineValue) &&
    (point.benchmarkValue === null || isFiniteNumber(point.benchmarkValue))
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
    isTradeSource(trade.source) &&
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
      // The catalog's current words for the same series (BT-1); the snapshot itself is untouched.
      name: benchmarkDisplayName(snapshot.benchmark),
      sourceKind: snapshot.benchmark.sourceKind,
      methodologyVersion: snapshot.benchmark.methodologyVersion,
    },
    methodology: snapshot.methodology,
    ...stockListClassificationOf(snapshot),
  };
}

/**
 * The classification a retrospectively classified universe's run rests on, from the catalog entry
 * its snapshot's frozen `universeKey` names — the snapshot itself is untouched.
 */
function stockListClassificationOf(
  snapshot: BacktestRunSnapshot,
): Pick<BacktestRunConfigurationResponse, "stockListClassification"> {
  const universeKey = snapshot.stockList.universe?.universeKey;
  const classification = universeKey ? maintainedUniverseForList(universeKey)?.classification : null;
  if (!classification) {
    return {};
  }
  return {
    stockListClassification: {
      timing: classification.timing,
      scheme: classification.scheme,
      methodLabel: classification.methodLabel,
      underlyingIndex: classification.underlyingIndex,
      sectors: [...classification.sectorNames],
      disclosure: classification.disclosure,
    },
  };
}

function summaryRowOf(row: RunIndexRow): BacktestRunSummaryResponse {
  return {
    id: row.id,
    runNumber: row.runNumber,
    status: row.status,
    // The nullable foreign keys, as `configurationOf` reads them: an id links while the entity
    // exists and becomes null after it is deleted, while the stored name keeps describing it.
    strategyId: row.strategyId,
    strategyName: row.strategyName,
    stockListId: row.stockListId,
    stockListName: row.stockListName,
    benchmarkCode: row.benchmark.code,
    // The catalog's current words for the same series (BT-1), exactly as `configurationOf` derives
    // them from the snapshot.
    benchmarkName: benchmarkDisplayName({
      code: row.benchmark.code,
      name: row.benchmarkName,
      sourceKind: row.benchmarkSeries.sourceKind,
      methodologyVersion: row.benchmarkSeries.methodologyVersion,
    }),
    startDate: fromDatabaseDate(row.startDate),
    endDate: fromDatabaseDate(row.endDate),
    initialCapital: toNumber(row.initialCapital),
    maximumPositions: row.maximumPositions,
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
    portfolioCagrPercent:
      row.summary === null
        ? null
        : toNullableNumber(row.summary.portfolioCagrPercent),
  };
}

export function resultSummaryOf(
  row: SummaryRow,
): BacktestResultSummaryResponse {
  const firstSimulatedDate = fromDatabaseDate(row.firstSimulatedDate);
  const lastSimulatedDate = fromDatabaseDate(row.lastSimulatedDate);
  const benchmarkReturnPercent = toNullableNumber(row.benchmarkReturnPercent);
  return {
    firstSimulatedDate,
    lastSimulatedDate,
    tradingDays: row.tradingDays,
    investedCapital: toNumber(row.investedCapital),
    finalCash: toNumber(row.finalCash),
    finalPositionsValue: toNumber(row.finalPositionsValue),
    finalValue: toNumber(row.finalValue),
    netProfit: toNumber(row.netProfit),
    portfolioReturnPercent: toNumber(row.portfolioReturnPercent),
    benchmarkReturnPercent,
    alphaPercent: toNullableNumber(row.alphaPercent),
    portfolioCagrPercent: toNullableNumber(row.portfolioCagrPercent),
    // Read-time, never stored: the engine's own `cagrPercent` applied to the stored benchmark
    // return over the run's own simulated span — the figure the portfolio's CAGR is measured on,
    // so the two annualized returns compare like for like (BT-2).
    benchmarkCagrPercent:
      benchmarkReturnPercent === null
        ? null
        : cagrPercent(
            1 + benchmarkReturnPercent / 100,
            firstSimulatedDate,
            lastSimulatedDate,
          ),
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

/**
 * One persisted day as the chart consumes it.
 *
 * Growth indices are based at 1.0 on the first simulated date and are carried as percentages; the
 * three absolute scenarios are carried as currency. `strategyValue` is `totalValue`, which every
 * run has always stored. `benchmarkValue` is null for a run completed before the funded scenario
 * existed — the column was never backfilled, because a funded portfolio is not derivable from a
 * growth index once a run has contributions.
 */
export function curvePointOf(
  row: CurveEquityRow,
): BacktestCurvePointResponse {
  return {
    date: fromDatabaseDate(row.date),
    portfolioReturnPercent: (toNumber(row.returnIndex) - 1) * 100,
    benchmarkReturnPercent:
      row.benchmarkIndex === null
        ? null
        : (toNumber(row.benchmarkIndex) - 1) * 100,
    strategyValue: toNumber(row.totalValue),
    benchmarkValue: toNullableNumber(row.benchmarkValue),
    cashBaselineValue: toNumber(row.cashBaselineValue),
  };
}

/**
 * Thins the curve to a bounded number of evenly spaced points, always keeping the first and last.
 *
 * A thirty-year run has roughly 7,500 daily points; every one stays durably persisted, but the
 * detail payload must not grow with the period. Keeping the endpoints preserves the run's actual
 * start and final return rather than a sampled approximation of them.
 */
export function downsampleCurve(
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

/**
 * One persisted trade, with the rule that produced it described from the run's own snapshot.
 *
 * The index is prepared once per request rather than per row: a page of fifty trades otherwise
 * re-parses and re-describes the same strategy fifty times for an answer that cannot change.
 */
function tradeOf(
  row: TradeRow,
  reasons: BacktestTradeReasonIndex,
): BacktestTradeResponse {
  return {
    sequence: row.sequence,
    date: fromDatabaseDate(row.date),
    symbol: row.symbol,
    name: row.name,
    action: row.action,
    source: row.source,
    levelPercentage: row.levelPercentage,
    shares: toNumber(row.shares),
    price: toNumber(row.price),
    amount: toNumber(row.amount),
    realizedPnl: toNullableNumber(row.realizedPnl),
    realizedPnlPercent: toNullableNumber(row.realizedPnlPercent),
    reason: backtestTradeReason(reasons, row),
  };
}

/**
 * The trades a trade-log filter selects — always inside one run.
 *
 * Neither `symbol` nor `action` is indexed, and no index was added for them: the run's rows are
 * found through `(runId, sequence)` and the filter is applied to them, so the work is bounded by
 * one run's trade count (about twenty thousand for the longest runs the product produces), never
 * by the table's.
 */
function tradeLogWhere(
  runId: string,
  query: BacktestTradeLogQuery,
): Prisma.BacktestTradeWhereInput {
  return {
    runId,
    ...(query.symbol === undefined ? {} : { symbol: query.symbol }),
    ...(query.action === undefined ? {} : { action: query.action }),
  };
}

/** Rows read per round trip while exporting: what bounds an export's memory, whatever the run. */
const TRADE_EXPORT_BATCH_SIZE = 1_000;

/**
 * The columns an export prints and nothing more: twenty thousand rows do not need the cash and
 * position bookkeeping each trade also stores.
 */
const TRADE_EXPORT_SELECT = {
  sequence: true,
  date: true,
  symbol: true,
  name: true,
  action: true,
  source: true,
  levelId: true,
  exitRuleId: true,
  levelPercentage: true,
  shares: true,
  price: true,
  amount: true,
  realizedPnl: true,
  realizedPnlPercent: true,
} satisfies Prisma.BacktestTradeSelect;

type TradeExportRow = Prisma.BacktestTradeGetPayload<{
  select: typeof TRADE_EXPORT_SELECT;
}>;

/**
 * One exported trade: the stored decimals exactly as persisted, and the same reason the page shows.
 */
function tradeExportRecordOf(
  row: TradeExportRow,
  reasons: BacktestTradeReasonIndex,
): TradeLogCsvTrade {
  return {
    sequence: row.sequence,
    date: fromDatabaseDate(row.date),
    symbol: row.symbol,
    name: row.name,
    action: row.action,
    source: row.source,
    levelPercentage: row.levelPercentage,
    shares: row.shares,
    price: row.price,
    amount: row.amount,
    realizedPnl: row.realizedPnl,
    realizedPnlPercent: row.realizedPnlPercent,
    reason: backtestTradeReason(reasons, row),
  };
}

/** Code-unit order, so the stock filter lists symbols the same way whatever the database collation. */
function compareSymbols(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Where an export stands, for the events that describe it. Never its content. */
type TradeExportLogFields = {
  actorUserId: string;
  runId: string;
  symbol: string | null;
  action: BacktestTradeAction | null;
  order: BacktestTradeOrder;
};

/**
 * Per-calendar-year returns, chained off the run's persisted time-weighted return index.
 *
 * Derived rather than stored: the index is already on every equity row, `backtestAnnualReturns` is
 * the one canonical chaining of it, and the rows are in memory for the curve anyway — so a run
 * completed long before annual returns were reported still answers with the same arithmetic as one
 * completed today. The period comes from the run's own requested dates, which is what decides
 * whether its first or last year was only partly simulated.
 *
 * Each year's benchmark figure is chained the same way off the persisted `benchmarkIndex` of the
 * same rows — the series the run's total benchmark return is read from — on the same anchor
 * dates. The rows arrive in date order, so the first is the run's first simulated date; its
 * benchmark reading is the base of the first year's figure, and is null when the benchmark had no
 * value yet, which leaves that year's benchmark figure unavailable rather than measured over a
 * shorter window.
 */
export function annualReturnsOf(
  equity: readonly Pick<EquityRow, "date" | "returnIndex" | "benchmarkIndex">[],
  run: { startDate: Date; endDate: Date },
): BacktestAnnualReturnResponse[] {
  const first = equity[0];
  return backtestAnnualReturns(
    equity.map((row) => ({
      date: fromDatabaseDate(row.date),
      returnIndex: toNumber(row.returnIndex),
      benchmarkIndex: toNullableNumber(row.benchmarkIndex),
    })),
    {
      startDate: fromDatabaseDate(run.startDate),
      endDate: fromDatabaseDate(run.endDate),
    },
    {
      indexAtFirstSimulatedDate:
        first === undefined ? null : toNullableNumber(first.benchmarkIndex),
    },
  );
}

function detailOf(
  row: RunDetailRow,
  result: BacktestResultResponse | null,
  queue?: BacktestQueueStateResponse,
): BacktestRunDetailResponse {
  const snapshot = readSnapshot(row.snapshot);
  const cancellation = cancellationOf(row.job);
  return {
    id: row.id,
    runNumber: row.runNumber,
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
    ...(cancellation ? { cancellation } : {}),
    ...(queue ? { queue } : {}),
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

function progressOf(
  row: RunProgressRow,
  queue?: BacktestQueueStateResponse,
): BacktestProgressResponse {
  const cancellation = cancellationOf(row.job);
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
    ...(cancellation ? { cancellation } : {}),
    ...(queue ? { queue } : {}),
  };
}

/** How many runs' trade-log aggregates the API keeps; the oldest go first. */
const TRADE_LOG_CACHE_SIZE = 500;

/** A finished run's trade log, as every page of it reports it: fixed once the run is terminal. */
type FinishedTradeLog = {
  /** The run's status and completion time it was read at: a retried run reads again. */
  readonly version: string;
  readonly symbols: string[];
  readonly tradeCount: number;
};

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > TRADE_LOG_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
}

@Injectable()
export class BacktestsService {
  /**
   * Each run's trade reasons, by run id: described from its immutable snapshot, so the snapshot —
   * the run's largest document — is read once per run rather than on every page and every export.
   * Only reasons the snapshot names on its own are kept (see `tradeReasonsOf`).
   */
  private readonly tradeReasons = new Map<string, BacktestTradeReasonIndex>();

  /**
   * Each finished run's traded symbols and trade count. A terminal run's trades are never written
   * again, so every page reports the same two; they are read once per run and completion.
   */
  private readonly finishedTradeLogs = new Map<string, FinishedTradeLog>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EntitlementsService)
    private readonly entitlements: EntitlementsService,
    @Inject(BACKTESTS_LOGGER) private readonly logger: StructuredLogger,
    @Inject(EXECUTION_CALENDAR_REFERENCE)
    private readonly executionCalendarReference: string,
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
    user: AuthUser,
    input: ParsedCreateBacktestRunRequest,
  ): Promise<BacktestRunDetailResponse> {
    const startedAt = Date.now();
    const userId = user.id;

    // Entitlements first, before a single row is read. A live backtest is the most expensive
    // operation the product offers, and `docs/decisions/entitlements-v1.md` requires a forbidden
    // operation to be refused before expensive downstream work rather than after it.
    //
    // Depth is checked here too, because it is decidable from the submitted period alone. Note
    // what it does *not* touch: Stock Details history stays full for every plan, Guests included.
    // The cap is on what a backtest may simulate, never on what a chart may show.
    this.entitlements.assertCanRunLiveBacktest(user);
    this.entitlements.assertBacktestHistoricalDepth(
      user,
      backtestPeriodYears(input.startDate, input.endDate),
    );

    // The caller's own Strategy and List, or a built-in: built-ins are selectable wherever the
    // caller's plan allows a Backtest at all, and are snapshotted exactly like the caller's own.
    const strategy = await this.prisma.strategy.findFirst({
      where: { id: input.strategyId, ...readableWhere(user) },
      include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } },
    });
    if (!strategy) {
      throw new BacktestConfigurationError(
        "The selected strategy was not found",
      );
    }
    // A premium built-in Strategy runs only on a plan that includes premium content
    // (`docs/decisions/entitlements-v2.md` §6) — refused before its definition is read.
    assertPremiumAccessible(strategy, user, "STRATEGY");
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
      where: { id: input.stockListId, ...readableWhere(user) },
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
    // A maintained historical universe — an index's membership or a universe derived from one — is
    // measured differently from every other List (`docs/decisions/sp500-historical-pit-v1.md` §5,
    // `historical-universes-v1.md` §6): by the most members it held at once in the period, against
    // its own entitlement and its own engine ceiling. Only the SYSTEM List itself, which no customer
    // can copy.
    const indexUniverse =
      stockList.ownership === ContentOwnership.SYSTEM
        ? maintainedUniverseForList(stockList.systemKey)
        : null;
    // Premium before size: a plan without premium content is told that, not that a universe is
    // larger than a limit (entitlements-v2 §6). A point-in-time universe is premium by definition.
    assertPremiumAccessible(
      indexUniverse ? { ownership: stockList.ownership, premium: true } : stockList,
      user,
      indexUniverse ? "INDEX_UNIVERSE" : "LIST",
    );
    if (!indexUniverse) {
      // The commercial capacity first: it is what every customer meets — the largest plan limit
      // equals the engine ceiling below — and it is also what refuses a List that became oversized
      // through a downgrade: the run is rejected, while the List itself stays intact and readable.
      this.entitlements.assertBacktestUniverseLimit(user, {
        kind: "LIST",
        symbols: stockList.items.length,
      });
      // The absolute engine guard, which only an administrator, whose plan limits are lifted, can
      // reach.
      if (stockList.items.length > BACKTEST_MAX_SECURITIES) {
        throw new BacktestConfigurationError(
          `A backtest can cover at most ${BACKTEST_MAX_SECURITIES} stocks; this list has ${stockList.items.length}`,
        );
      }
    }

    const benchmarkCode = input.benchmarkCode ?? DEFAULT_BENCHMARK_CODE;
    // `isBacktestSelectable` as well as `isActive`, and the same refusal for both. An internal
    // market reference — `SP500_INDEX`, `DJIA_INDEX`, `VIX_INDEX` — is a perfectly live series that
    // the Dashboard reads and the loader hydrates; it is simply not something a user may compare a
    // portfolio against, so naming one here is rejected exactly like naming a benchmark that does
    // not exist. Leaving it to the picker would have made the rule presentational.
    const benchmark = await this.prisma.benchmark.findFirst({
      where: {
        code: benchmarkCode,
        isActive: true,
        isBacktestSelectable: true,
      },
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
        where: { code: this.executionCalendarReference },
        include: { series: { orderBy: { version: "desc" }, take: 1 } },
      })
    )?.series[0];
    if (!executionCalendarSeries) {
      throw new BacktestUnavailableError(
        "Backtests are temporarily unavailable: the market calendar they run on is not registered.",
      );
    }

    // Stock's Sector rules read, for each stock, the sector ETF its FMP sector maps to. The stock's
    // sector as stored now is frozen beside it — the product's accepted rule is the current
    // classification, not a historical one — so the run, and any re-execution of it, reads one fund
    // per stock whatever the catalog says later. Only when a rule needs it: every other snapshot is
    // byte-for-byte what it always was.
    const readsSector = strategyReadsStockSector(definition);
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
          ...(readsSector
            ? { sector: frozenSector(item.security.sector) }
            : {}),
        };
      })
      .sort(
        (left, right) =>
          left.symbol.localeCompare(right.symbol) ||
          left.securityId.localeCompare(right.securityId),
      )
      // An index universe's member that was never a member during the period can never be bought
      // in it, and so never held: it is left out of the run rather than prepared for nothing. Every
      // other List keeps every member, exactly as before.
      .filter(
        (security) =>
          !indexUniverse ||
          security.buyWindowMode === "FULL" ||
          security.buyWindows.some(
            (window) =>
              window.startDate <= input.endDate &&
              (window.endDate === null || window.endDate >= input.startDate),
          ),
      );

    let universe: BacktestRunSnapshot["stockList"]["universe"];
    if (indexUniverse) {
      const peak = peakSimultaneousMembers(
        securities.map((security) => ({
          mode: security.buyWindowMode,
          ranges: security.buyWindows,
        })),
        { from: input.startDate, to: input.endDate },
      );
      if (peak.peak === 0) {
        throw new BacktestConfigurationError(
          `No constituent of ${stockList.name} was a member between ${input.startDate} and ${input.endDate}`,
        );
      }
      this.entitlements.assertBacktestUniverseLimit(user, {
        kind: "POINT_IN_TIME_INDEX",
        peakSimultaneousMembers: peak.peak,
      });
      if (
        securities.length > BACKTEST_MAX_INDEX_UNIVERSE_SECURITIES ||
        peak.peak > BACKTEST_MAX_INDEX_UNIVERSE_CONSTITUENTS
      ) {
        throw new BacktestConfigurationError(
          `An index-universe backtest can cover at most ${BACKTEST_MAX_INDEX_UNIVERSE_SECURITIES} securities and ${BACKTEST_MAX_INDEX_UNIVERSE_CONSTITUENTS} simultaneous members; this period holds ${securities.length} and ${peak.peak}`,
        );
      }
      universe = {
        kind: "POINT_IN_TIME_INDEX",
        indexKey: indexUniverse.indexKey,
        ...(indexUniverse.derived ? { universeKey: indexUniverse.universeKey } : {}),
        peakSimultaneousMembers: peak.peak,
      };
    }

    // Actor groups are mutable configuration, exactly like the stock list above, so the run freezes
    // their membership here. Execution resolves a `GROUP` scope through this frozen list and never
    // through the database, which is what makes "editing a group never changes an existing run" a
    // property of the data rather than a promise.
    const actorGroups = await this.freezeActorGroups(user, definition);
    // The members a rule selects directly are already frozen — the selection is part of the
    // definition below. What is frozen here is who they are: the bioguide id and the name each had
    // today, so the completed run can still say whose activity it counted.
    const actors = await this.freezeActors(definition);
    // The ETF series behind every ETF-sourced condition, pinned exactly as the comparison
    // benchmark and the execution calendar are: the definition names a stable code, this resolves
    // the immutable series it means today, and execution reads that id back whatever the catalog
    // does afterwards. The price-basis generation in force now is recorded beside it, so a later
    // re-executed run whose numbers differ is explainable rather than mysterious.
    const etfSeries = await this.freezeEtfSeries(definition, securities);

    const snapshot: BacktestRunSnapshot = {
      // The lowest version able to express this run. A strategy that selects no member directly is
      // written exactly as it always was; one that does is written at a version a worker built
      // before the selection existed refuses outright, instead of executing it as "nobody".
      snapshotVersion: backtestSnapshotVersionFor(definition),
      submittedAt: new Date().toISOString(),
      strategy: {
        strategyId: strategy.id,
        name: strategy.name,
        versionId: version.id,
        versionNumber: version.versionNumber,
        definitionHash: version.definitionHash,
        definition,
      },
      stockList: {
        stockListId: stockList.id,
        name: stockList.name,
        ...(universe ? { universe } : {}),
      },
      securities,
      // Omitted rather than written empty when the strategy references no group, so a snapshot only
      // carries the field when it means something.
      ...(actorGroups.length > 0 ? { actorGroups } : {}),
      ...(actors.length > 0 ? { actors } : {}),
      ...(etfSeries.length > 0 ? { etfSeries } : {}),
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
        referenceCode: this.executionCalendarReference,
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

    // One transaction: the concurrency check, the run, its durable queue row and its progress row
    // commit together.
    //
    // The check has to be *inside* it. Counting the caller's runs in flight and then creating one
    // in a separate statement is the textbook TOCTOU: two submissions landing together both read
    // the same count, both pass, and a plan that allows one backtest runs two. The assertion takes
    // the caller's entitlement lock first, so those two submissions serialize and the second one
    // sees the first one's run.
    //
    // The Run ID is allocated in the same transaction, after the concurrency check: a refused or
    // failed submission rolls the allocation back with it, so only committed runs consume a number.
    const run = await this.prisma.$transaction(async (tx) => {
      await this.entitlements.assertBacktestConcurrency(tx, userId);
      // Admission backpressure, after the plan's own limit (`BACKTEST_QUEUE_MAX_QUEUED`). Not an
      // entitlement and not a lock: a bound on how much work may wait deployment-wide, read at the
      // moment of submission. Two submissions racing past it overshoot by at most one each.
      const admission = getBacktestAdmissionConfig();
      const queued = await tx.backtestJob.count({ where: { status: "QUEUED" } });
      if (queued >= admission.queueMaxQueued) {
        throw new BacktestQueueFullError(queued, admission.queueFullRetryAfterSeconds);
      }
      const runNumber = await allocateBacktestRunNumber(tx, userId);
      return tx.backtestRun.create({
      data: {
        userId,
        runNumber,
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
        // The same value as the snapshot's `benchmark.name`, so the collection never opens it.
        benchmarkName: benchmark.name,
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
      include: RUN_DETAIL_INCLUDE,
      });
    });

    this.logger.info({
      event: "backtest.queued",
      actorUserId: userId,
      runId: run.id,
      runNumber: run.runNumber,
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
    return detailOf(run, null, await this.queueStateOf(run));
  }

  /**
   * Every run of the caller matching the search and the filter, in the order asked for: the
   * unpaged `GET /backtests`, kept for the callers that read the whole list (the New backtest form
   * asks only for `ACTIVE` runs). The collection page reads `pageForUser` instead.
   */
  async listForUser(
    userId: string,
    query: BacktestRunListQuery = {},
  ): Promise<BacktestRunSummaryResponse[]> {
    const ids = await this.orderedRunIds(userId, query);
    return this.runRows(ids);
  }

  /**
   * One page of the caller's runs: searched, filtered, ordered and counted in the database, so the
   * counts and every page describe the whole history, and no run's snapshot is read to build it.
   *
   * A page past the end is clamped rather than refused, as on the trade log: a stale link or a
   * hand-edited page lands on the last real page.
   */
  async pageForUser(
    userId: string,
    request: BacktestRunListQuery & { page?: number; pageSize?: number } = {},
  ): Promise<BacktestRunPageResponse> {
    const sort = request.sort ?? BACKTEST_RUN_DEFAULT_SORT;
    const query: BacktestRunListQuery = { ...request, sort };
    const filtered = request.q !== undefined || request.status !== undefined;
    const pageSize = Math.min(
      Math.max(Math.trunc(request.pageSize ?? BACKTEST_RUNS_PAGE_SIZE), 1),
      BACKTEST_RUNS_MAX_PAGE_SIZE,
    );
    const [totalCount, unfilteredCount] = await Promise.all([
      this.countRuns(userId, query),
      filtered ? this.countRuns(userId, {}) : null,
    ]);
    const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
    const page = Math.min(
      Math.max(Math.trunc(request.page ?? 1), 1),
      pageCount,
    );
    const ids = await this.orderedRunIds(userId, query, {
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      runs: await this.runRows(ids),
      page,
      pageSize,
      totalCount,
      pageCount,
      unfilteredCount: unfilteredCount ?? totalCount,
      q: request.q ?? null,
      status: request.status ?? null,
      sort,
    };
  }

  private async countRuns(
    userId: string,
    query: BacktestRunListQuery,
  ): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS "count"
      FROM "BacktestRun" AS run
      WHERE ${runListCondition(userId, query)}`;
    return row?.count ?? 0;
  }

  /**
   * The ids of the matching runs, in order, one page of them when asked. The order is decided in
   * SQL because two orders are not expressible as a Prisma `orderBy`: a strategy name read without
   * regard to case, and the annualized return with the runs that have none last.
   */
  private async orderedRunIds(
    userId: string,
    query: BacktestRunListQuery,
    window?: { readonly skip: number; readonly take: number },
  ): Promise<string[]> {
    const sort = query.sort ?? BACKTEST_RUN_DEFAULT_SORT;
    const summaryJoin =
      sort === "cagr"
        ? Prisma.sql`LEFT JOIN "BacktestRunSummary" AS summary ON summary."runId" = run."id"`
        : Prisma.empty;
    const limit = window
      ? Prisma.sql`LIMIT ${window.take} OFFSET ${window.skip}`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT run."id"
      FROM "BacktestRun" AS run
      ${summaryJoin}
      WHERE ${runListCondition(userId, query)}
      ORDER BY ${RUN_LIST_ORDER[sort]}
      ${limit}`;
    return rows.map((row) => row.id);
  }

  /** The rows for these ids, in the same order. */
  private async runRows(
    ids: readonly string[],
  ): Promise<BacktestRunSummaryResponse[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.prisma.backtestRun.findMany({
      where: { id: { in: [...ids] } },
      select: RUN_INDEX_SELECT,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [summaryRowOf(row)] : [];
    });
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
    return detailOf(run, await this.readResult(run), await this.queueStateOf(run));
  }

  /**
   * Where a waiting run stands in the deployment-wide queue, or nothing for any other run.
   *
   * Two indexed counts. `ahead` counts what was queued before this run — an upper bound on what
   * starts first, because the claim orders owners fairly rather than strictly first-in-first-out.
   */
  private async queueStateOf(run: {
    status: BacktestRunStatus;
    job: {
      id: string;
      status: BacktestJobStatus;
      availableAt: Date;
      createdAt: Date;
    } | null;
  }): Promise<BacktestQueueStateResponse | undefined> {
    if (run.status !== "QUEUED" || run.job?.status !== "QUEUED") {
      return undefined;
    }
    const now = new Date();
    const [counts] = await this.prisma.$queryRaw<
      { ahead: bigint; executing: bigint }[]
    >`
      SELECT
        (SELECT count(*) FROM "BacktestJob" j
          WHERE j."status" = 'QUEUED'
            AND j."cancelRequestedAt" IS NULL
            AND (j."availableAt", j."createdAt", j."id")
                < (${run.job.availableAt}, ${run.job.createdAt}, ${run.job.id})) AS ahead,
        (SELECT count(*) FROM "BacktestJob" j
          WHERE j."status" = 'CLAIMED'
            AND (j."leaseExpiresAt" IS NULL OR j."leaseExpiresAt" > ${now})) AS executing
    `;
    return {
      ahead: Number(counts?.ahead ?? 0),
      executing: Number(counts?.executing ?? 0),
      capacity: getBacktestAdmissionConfig().globalMaxRunning,
    };
  }

  /**
   * Stops the caller's run (`ai/architecture/backtest-execution.md`, "Cancellation").
   *
   * - **Queued**: cancelled at once. It held no slot, so nothing else changes.
   * - **Executing**: the request is recorded on the job, which keeps `CLAIMED` — and its execution
   *   slot — until the worker that holds it stops at its next checkpoint (within seconds) and
   *   records `CANCELLED`, or its lease expires and recovery does. Capacity is therefore released
   *   only once execution has actually stopped, so a cancellation can never let a fifth run start
   *   beside four that are still computing. A run that reaches its final write before the worker
   *   sees the request completes normally.
   * - **Already cancelled**: answered as it is — the request is idempotent, so a double click or a
   *   retried request is harmless.
   * - **Completed or failed**: refused with `409`; there is nothing left to stop.
   *
   * The job row is locked first, then the run — the order the claim and recovery use — so a
   * cancellation and a claim of the same job serialize instead of deadlocking.
   */
  async cancelRun(
    userId: string,
    runId: string,
  ): Promise<BacktestRunDetailResponse> {
    const now = new Date();
    const outcome = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          jobId: string;
          jobStatus: BacktestJobStatus;
          runStatus: BacktestRunStatus;
        }[]
      >`
        SELECT j."id" AS "jobId", j."status" AS "jobStatus", r."status" AS "runStatus"
        FROM "BacktestRun" r
        JOIN "BacktestJob" j ON j."runId" = r."id"
        WHERE r."id" = ${runId} AND r."userId" = ${userId}
        FOR UPDATE OF j
      `;
      const row = rows[0];
      if (!row) {
        throw new BacktestRunNotFoundError();
      }
      if (row.runStatus === "CANCELLED") {
        return "ALREADY_CANCELLED" as const;
      }
      if (row.runStatus === "COMPLETED" || row.runStatus === "FAILED") {
        throw new BacktestNotCancellableError(row.runStatus);
      }
      if (row.jobStatus === "QUEUED") {
        await tx.$executeRaw`
          UPDATE "BacktestJob"
          SET "status" = 'CANCELLED',
              "cancelRequestedAt" = ${now},
              "lastError" = 'Cancelled by its owner',
              "updatedAt" = ${now}
          WHERE "id" = ${row.jobId}
        `;
        await tx.$executeRaw`
          UPDATE "BacktestRun"
          SET "status" = 'CANCELLED',
              "completedAt" = ${now},
              "updatedAt" = ${now}
          WHERE "id" = ${runId}
        `;
        await tx.$executeRaw`
          UPDATE "BacktestRunProgress"
          SET "message" = 'Cancelled by its owner',
              "snapshot" = NULL,
              "sequence" = "sequence" + 1,
              "updatedAt" = ${now}
          WHERE "runId" = ${runId}
        `;
        return "CANCELLED" as const;
      }
      // Executing (or between attempts): the worker holding it acknowledges at a checkpoint.
      await tx.$executeRaw`
        UPDATE "BacktestJob"
        SET "cancelRequestedAt" = COALESCE("cancelRequestedAt", ${now}),
            "updatedAt" = ${now}
        WHERE "id" = ${row.jobId}
      `;
      return "REQUESTED" as const;
    });

    this.logger.info({
      event: "backtest.cancel.requested",
      actorUserId: userId,
      runId,
      outcome,
    });
    return this.getRun(userId, runId);
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
    return progressOf(run, await this.queueStateOf(run));
  }

  /**
   * The definition as of submission, from the snapshot — not the strategy's current version.
   *
   * Projected through `withCanonicalStrategyDefinition`, because the response contract is the
   * **current** `StrategyDefinition`. A run submitted before FINAL EXIT gained Exit Rules froze a
   * `schemaVersion: 1` document, and returning that verbatim would publish a shape the contract
   * does not describe — a client reading `finalExit.rules` would find nothing there.
   *
   * The projection is read-only and semantics-preserving: the stored `JSONB` row keeps the exact
   * document that was submitted, which is what makes it the reproducibility authority, while the
   * API answers in the shape it promises. A document that cannot be canonicalized is corruption and
   * surfaces as an internal failure, exactly as a corrupt `StrategyVersion` row does on the
   * strategy read path.
   */
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
    const snapshot = withCanonicalStrategyDefinition(
      readSnapshot(run.snapshot),
    );
    return {
      strategyName: snapshot.strategy.name,
      versionNumber: snapshot.strategy.versionNumber,
      definition: snapshot.strategy.definition,
    };
  }

  /**
   * One page of a completed run's trade log, newest first unless asked otherwise.
   *
   * Paged in PostgreSQL, not in the browser: a thirty-year run can execute tens of thousands of
   * trades, and the page a user is looking at is fifty of them. `(runId, sequence)` is already
   * unique, so the unfiltered window and count read an index rather than the table. A filter on a
   * stock or an action is applied in the same queries, so the count, the page count and every page
   * describe the filtered log as a whole — see `tradeLogWhere` for what that costs.
   *
   * A page past the end is clamped rather than refused: a stale link or a hand-edited query
   * parameter should land on the last page, not on an error.
   */
  async getTrades(
    userId: string,
    runId: string,
    request: BacktestTradeLogQuery & { page?: number; pageSize?: number } = {},
  ): Promise<BacktestTradePageResponse> {
    const run = await this.ownedTradeLogRun(userId, runId);
    const order = request.order ?? BACKTEST_TRADE_DEFAULT_ORDER;
    const where = tradeLogWhere(run.id, request);
    const filtered =
      request.symbol !== undefined || request.action !== undefined;

    const pageSize = Math.min(
      Math.max(Math.trunc(request.pageSize ?? BACKTEST_TRADES_PAGE_SIZE), 1),
      BACKTEST_TRADES_MAX_PAGE_SIZE,
    );
    // A finished run's symbols and trade count are fixed: read once, then reused by every page.
    const finished = await this.finishedTradeLog(run);
    const [totalCount, unfilteredCount, symbols] = await Promise.all([
      finished && !filtered
        ? finished.tradeCount
        : this.prisma.backtestTrade.count({ where }),
      filtered
        ? (finished?.tradeCount ??
          this.prisma.backtestTrade.count({ where: { runId: run.id } }))
        : null,
      finished?.symbols ?? this.tradedSymbols(run.id),
    ]);
    const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
    const page = Math.min(
      Math.max(Math.trunc(request.page ?? 1), 1),
      pageCount,
    );

    const rows = await this.prisma.backtestTrade.findMany({
      where,
      // Newest first is the order the log has always been read in, and the default. `sequence` is
      // the engine's own execution order, so either direction is stable across equal dates too.
      orderBy: { sequence: order },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const reasons = await this.tradeReasonsOf(run.id);
    return {
      items: rows.map((row) => tradeOf(row, reasons)),
      page,
      pageSize,
      totalCount,
      pageCount,
      unfilteredCount: unfilteredCount ?? totalCount,
      symbols,
      symbol: request.symbol ?? null,
      action: request.action ?? null,
      order,
    };
  }

  /**
   * The run's trade log as CSV: every trade the filter selects, in the order asked for — the whole
   * filtered log, not the page on screen.
   *
   * Ownership is resolved before anything is returned, so another user's run answers `404` exactly
   * as the page does. The rows are then read lazily, a batch at a time by keyset on
   * `(runId, sequence)`, and handed to the caller as text chunks while the response streams: memory
   * stays one batch whatever the run's length. A completed run's trades never change, so reading
   * them in batches outside one transaction cannot interleave two versions of the log.
   *
   * Every trade carries the reason the page shows, resolved once from the run's own snapshot.
   */
  async exportTrades(
    userId: string,
    runId: string,
    query: BacktestTradeLogQuery,
  ): Promise<{ filename: string; content: AsyncGenerator<string> }> {
    const startedAt = Date.now();
    const run = await this.ownedTradeLogRun(userId, runId);
    const order = query.order ?? BACKTEST_TRADE_DEFAULT_ORDER;
    const reasons = await this.tradeReasonsOf(run.id);
    const fields: TradeExportLogFields = {
      actorUserId: userId,
      runId: run.id,
      symbol: query.symbol ?? null,
      action: query.action ?? null,
      order,
    };
    this.logger.info({ event: "backtest.trades.export.started", ...fields });
    return {
      filename: backtestTradesExportFilename(run.id, { ...query, order }),
      content: this.tradeExportChunks(
        tradeLogWhere(run.id, query),
        order,
        reasons,
        fields,
        startedAt,
      ),
    };
  }

  /**
   * The export's text, one chunk per batch: the byte-order mark and the header ride with the first
   * batch, so a database that cannot answer at all fails the request before anything is sent.
   *
   * It logs how the export ended, with its row count and duration and never its content: completed,
   * failed (the error is rethrown, so the response is cut off rather than ended as if whole), or
   * aborted when the consumer stopped reading — the client went away mid-download.
   */
  private async *tradeExportChunks(
    where: Prisma.BacktestTradeWhereInput,
    order: BacktestTradeOrder,
    reasons: BacktestTradeReasonIndex,
    fields: TradeExportLogFields,
    startedAt: number,
  ): AsyncGenerator<string> {
    let rowCount = 0;
    let settled = false;
    try {
      let pending = `${UTF8_BOM}${tradeLogCsvHeader()}`;
      let cursor: number | undefined;
      for (;;) {
        const rows = await this.prisma.backtestTrade.findMany({
          where:
            cursor === undefined
              ? where
              : {
                  ...where,
                  sequence: order === "desc" ? { lt: cursor } : { gt: cursor },
                },
          orderBy: { sequence: order },
          take: TRADE_EXPORT_BATCH_SIZE,
          select: TRADE_EXPORT_SELECT,
        });
        rowCount += rows.length;
        pending += rows
          .map((row) => tradeLogCsvRecord(tradeExportRecordOf(row, reasons)))
          .join("");
        if (pending.length > 0) {
          yield pending;
          pending = "";
        }
        const last = rows.at(-1);
        if (last === undefined || rows.length < TRADE_EXPORT_BATCH_SIZE) {
          break;
        }
        cursor = last.sequence;
      }
      settled = true;
      this.logger.info({
        event: "backtest.trades.export.completed",
        ...fields,
        rowCount,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      settled = true;
      this.logger.error({
        event: "backtest.trades.export.failed",
        ...fields,
        rowCount,
        durationMs: Date.now() - startedAt,
        err,
      });
      throw err;
    } finally {
      if (!settled) {
        this.logger.info({
          event: "backtest.trades.export.aborted",
          ...fields,
          rowCount,
          durationMs: Date.now() - startedAt,
        });
      }
    }
  }

  /** The run a trade-log read is about, scoped to its owner: another user's run is not found. */
  private async ownedTradeLogRun(
    userId: string,
    runId: string,
  ): Promise<{
    id: string;
    status: BacktestRunStatus;
    completedAt: Date | null;
  }> {
    // Ownership on every read; the snapshot only when the run's reasons are not described yet.
    const run = await this.prisma.backtestRun.findFirst({
      where: { id: runId, userId },
      select: { id: true, status: true, completedAt: true },
    });
    if (!run) {
      throw new BacktestRunNotFoundError();
    }
    return run;
  }

  /** The run's trade reasons, described from its snapshot the first time they are asked for. */
  private async tradeReasonsOf(
    runId: string,
  ): Promise<BacktestTradeReasonIndex> {
    const cached = this.tradeReasons.get(runId);
    if (cached) {
      return cached;
    }
    const { snapshot } = await this.prisma.backtestRun.findUniqueOrThrow({
      where: { id: runId },
      select: { snapshot: true },
    });
    const { reasons, fromSnapshot } = await this.tradeReasonIndexOf(snapshot);
    // Reasons that borrowed an actor's current name are described afresh, so a rename shows.
    if (fromSnapshot) {
      remember(this.tradeReasons, runId, reasons);
    }
    return reasons;
  }

  /**
   * A finished run's traded symbols and trade count, read once per completion; `null` while the
   * run is still queued or executing, when its log may still grow and every page reads it afresh.
   */
  private async finishedTradeLog(run: {
    id: string;
    status: BacktestRunStatus;
    completedAt: Date | null;
  }): Promise<FinishedTradeLog | null> {
    if (!isTerminalBacktestStatus(run.status)) {
      return null;
    }
    const version = `${run.status}|${run.completedAt?.toISOString() ?? ""}`;
    const cached = this.finishedTradeLogs.get(run.id);
    if (cached?.version === version) {
      return cached;
    }
    const [symbols, tradeCount] = await Promise.all([
      this.tradedSymbols(run.id),
      this.prisma.backtestTrade.count({ where: { runId: run.id } }),
    ]);
    const entry = { version, symbols, tradeCount };
    remember(this.finishedTradeLogs, run.id, entry);
    return entry;
  }

  /**
   * The run's own frozen definition — never the strategy as it stands today — described once for a
   * whole page or export, naming any member or actor group by the name the run froze.
   */
  private async tradeReasonIndexOf(
    snapshotDocument: Prisma.JsonValue,
  ): Promise<{ reasons: BacktestTradeReasonIndex; fromSnapshot: boolean }> {
    const snapshot = withCanonicalStrategyDefinition(
      readSnapshot(snapshotDocument),
    );
    const { names, fromSnapshot } = await this.snapshotScopeNames(snapshot);
    return {
      reasons: backtestTradeReasonIndex(snapshot.strategy.definition, names),
      fromSnapshot,
    };
  }

  /**
   * Every distinct symbol the run traded, sorted: the stock filter's options.
   *
   * A `GROUP BY` over the run's own rows, so the browser learns what the log holds without loading
   * it. Two securities that share a symbol share an option, exactly as they share a label in the
   * log the option filters.
   */
  private async tradedSymbols(runId: string): Promise<string[]> {
    const groups = await this.prisma.backtestTrade.groupBy({
      by: ["symbol"],
      where: { runId },
    });
    return groups.map((group) => group.symbol).sort(compareSymbols);
  }

  /**
   * Freezes the identity and label of every member of Congress the strategy selects directly.
   *
   * A member the catalog no longer holds refuses the submission, for the reason a missing group
   * does: the run would otherwise count nobody where its author named somebody. The catalog never
   * deletes a member, so this is a corrupt or hand-written definition rather than a state a user
   * reaches — which is exactly when a refusal is better than a result.
   *
   * Sorted by id, like the selection itself, so two submissions of one configuration produce
   * byte-identical documents.
   */
  private async freezeActors(
    definition: StrategyDefinition,
  ): Promise<BacktestSnapshotActor[]> {
    const actorIds = collectActorIds(collectAlternativeDataMetrics(definition));
    if (actorIds.length === 0) {
      return [];
    }
    const actors = await this.prisma.alternativeDataActor.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, externalId: true, displayName: true },
    });
    if (actors.length !== actorIds.length) {
      throw new BacktestConfigurationError(
        "This strategy selects a member of Congress who is no longer available; edit the strategy before running it",
      );
    }
    return actors
      .map((actor) => ({
        actorId: actor.id,
        externalId: actor.externalId,
        displayName: actor.displayName,
      }))
      .sort((left, right) => left.actorId.localeCompare(right.actorId));
  }

  /**
   * The names a run's trade reasons print: the snapshot's own, completed from the actor catalog.
   *
   * The snapshot is the authority and always wins — a member is named as they were at submission.
   * The catalog fills only what the snapshot never froze: a run submitted before 2026-10-11 whose
   * rule was scoped to one member carries that member's id and no label, and would otherwise read
   * `1 selected member` although who it was is known. The catalog is reference data keyed by a
   * stable external identity and never deletes a member, and a name is presentation — it is never
   * matched on and nothing about the run's result is read from it.
   */
  /**
   * The names the run's reasons are described with, and whether they came from the snapshot alone:
   * a run recorded before snapshots named their actors falls back to the actors' current names.
   */
  private async snapshotScopeNames(
    snapshot: BacktestRunSnapshot,
  ): Promise<{ names: StrategyScopeNames; fromSnapshot: boolean }> {
    const names = backtestSnapshotScopeNames(snapshot);
    const unnamed = collectActorIds(
      collectAlternativeDataMetrics(snapshot.strategy.definition),
    ).filter((actorId) => names.actors?.[actorId] === undefined);
    if (unnamed.length === 0) {
      return { names, fromSnapshot: true };
    }
    const actors = await this.prisma.alternativeDataActor.findMany({
      where: { id: { in: unnamed } },
      select: { id: true, displayName: true },
    });
    return {
      names: {
        ...names,
        actors: {
          ...Object.fromEntries(
            actors.map((actor) => [actor.id, actor.displayName]),
          ),
          ...names.actors,
        },
      },
      fromSnapshot: false,
    };
  }

  /**
   * Freezes the membership of every actor group the strategy references.
   *
   * Three rules, and each is a refusal rather than a degradation:
   *
   * 1. **A group that no longer exists, or belongs to someone else, refuses the submission.** A run
   *    that silently treated it as empty would execute a strategy that reads "any member of Congress"
   *    while its author wrote "Congress Watchlist", and would report a result nobody could explain.
   * 2. **An empty group is accepted.** It is a legitimate state — a group being built — and it counts
   *    nothing, which is honest and what the evaluator already does.
   *
   * Members are frozen in the group's own order, and each carries its identity and its label so a
   * completed run can still name the actors it counted after a rename or a deletion.
   */
  private async freezeActorGroups(
    user: AuthUser,
    definition: StrategyDefinition,
  ): Promise<BacktestSnapshotActorGroup[]> {
    const metrics = collectAlternativeDataMetrics(definition);
    const groupIds = collectActorGroupIds(metrics);
    if (groupIds.length === 0) {
      return [];
    }
    const groups = await this.prisma.actorGroup.findMany({
      where: { id: { in: groupIds }, ...readableWhere(user) },
      include: {
        members: {
          orderBy: { createdAt: "asc" },
          include: {
            actor: {
              select: { id: true, externalId: true, displayName: true },
            },
          },
        },
      },
    });
    const byId = new Map(groups.map((group) => [group.id, group]));
    const frozen: BacktestSnapshotActorGroup[] = [];
    for (const metric of metrics) {
      const scope = alternativeDataScope(metric);
      if (scope?.kind !== "GROUP") {
        continue;
      }
      const group = byId.get(scope.groupId);
      if (!group) {
        throw new BacktestConfigurationError(
          "This strategy references an actor group that no longer exists; edit the strategy before running it",
        );
      }
      if (frozen.some((entry) => entry.groupId === group.id)) {
        continue;
      }
      frozen.push({
        groupId: group.id,
        name: group.name,
        members: group.members.map((member) => ({
          actorId: member.actor.id,
          externalId: member.actor.externalId,
          displayName: member.actor.displayName,
        })),
      });
    }
    // Sorted so two submissions of one configuration produce byte-identical documents, exactly as the
    // securities list is sorted — which is what keeps `snapshotHash` an identity of inputs.
    return frozen.sort((left, right) => left.groupId.localeCompare(right.groupId));
  }

  /**
   * Results exist only for a COMPLETED run.
   *
   * The trade log is deliberately absent: it is paginated from the database through
   * `getTrades`, because a bounded tail of a long run's trades is neither the whole log nor a
   * usable page of one. Final holdings are absent too — a run executed under terminal liquidation
   * ends in cash, and a run completed before that rule existed still reports its own stored summary
   * truthfully, which is what the immutability invariant requires.
   */
  private async readResult(
    run: RunDetailRow,
  ): Promise<BacktestResultResponse | null> {
    if (run.status !== "COMPLETED" || run.summary === null) {
      return null;
    }
    const equity = await this.prisma.backtestDailyEquity.findMany({
      where: { runId: run.id },
      orderBy: { date: "asc" },
    });
    const etfConditions = run.summary.etfConditionDiagnostics;
    return {
      summary: resultSummaryOf(run.summary),
      annualReturns: annualReturnsOf(equity, run),
      curve: downsampleCurve(equity.map(curvePointOf)),
      // Written by the worker with the rest of the result. Absent for every run whose strategy
      // reads no ETF — and for every run completed before the column existed, whose value is NULL.
      ...(Array.isArray(etfConditions) && etfConditions.length > 0
        ? {
            etfConditions: withSubmittedBasis(
              etfConditions as unknown as BacktestEtfConditionDiagnosticsResponse[],
              readSnapshot(run.snapshot).etfSeries ?? [],
            ),
          }
        : {}),
      // Which sector ETF each stock's Stock's Sector rules read, exactly as the snapshot froze it.
      ...stockSectorsOf(readSnapshot(run.snapshot)),
    };
  }

  /**
   * The immutable ETF series behind each source the definition reads, with the price basis now in
   * force. Every source is one of the twenty catalog ETFs, which the validator already proved, so a
   * code that cannot resolve here is a system problem — an unreconciled catalog — and the
   * submission is refused the way an unregistered execution calendar is, not blamed on the caller.
   */
  private async freezeEtfSeries(
    definition: StrategyDefinition,
    securities: readonly BacktestSnapshotSecurity[],
  ): Promise<BacktestSnapshotEtfSeries[]> {
    // The funds the definition names, and the sector ETFs its Stock's Sector rules will read for
    // these stocks — each pinned once, however many stocks share it.
    const codes = [
      ...new Set<StrategyEtfSourceCode>([
        ...collectStrategyEtfSources(definition),
        ...securities.flatMap((security) =>
          security.sector?.etfCode
            ? [security.sector.etfCode as StrategyEtfSourceCode]
            : [],
        ),
      ]),
    ];
    const frozen: BacktestSnapshotEtfSeries[] = [];
    for (const code of codes) {
      const benchmark = await this.prisma.benchmark.findFirst({
        where: { code, isActive: true },
        include: { series: { orderBy: { version: "desc" }, take: 1 } },
      });
      const series = benchmark?.series[0];
      if (!series) {
        throw new BacktestUnavailableError(
          `Backtests using ${findStrategyEtfSource(code)?.ticker ?? code} are temporarily unavailable: its market-data series is not registered.`,
        );
      }
      const basis = await this.prisma.benchmarkSeriesPriceBasis.findUnique({
        where: { seriesId: series.id },
      });
      frozen.push({
        code,
        ticker: findStrategyEtfSource(code)?.ticker ?? code,
        seriesId: series.id,
        seriesVersion: series.version,
        // No row means generation 0: the series has never been re-based.
        basisGeneration: basis?.generation ?? 0,
      });
    }
    return frozen.sort((left, right) => left.code.localeCompare(right.code));
  }
}
