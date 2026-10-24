import type {
  AuthUser,
  MonitorEligibility,
  MonitorDetailResponse,
  MonitorDetailSummaryResponse,
  MonitorMatchedLevelResponse,
  MonitorSecurityEvaluationResponse,
  MonitorCoverageResponse,
  MonitorSecurityStatus,
  MonitorSignalPageResponse,
  MonitorSignalResponse,
  MonitorSummaryResponse,
  MonitorSynchronizationResponse,
  MonitorWaitingLevelResponse,
} from "@intrinsic/contracts";
import {
  collectStrategyEtfSources,
  findStrategyEtfSource,
  MONITOR_SECURITY_STATUSES,
  normalizeStrategyDefinition,
  STRATEGY_ETF_SOURCES,
  stockSectorAssignment,
  strategyReadsStockSector,
  type MonitorEtfSourceStatusResponse,
  type StockSectorAssignmentResponse,
  type StrategyEtfSourceCode,
} from "@intrinsic/contracts";
import { getMonitorFairUseConfig } from "@intrinsic/config";
import { requestMonitorEvaluation, type Prisma } from "@intrinsic/database";
import { monitorStrategyLevels } from "@intrinsic/strategy";
import {
  benchmarkSessionFinalizedAt,
  MARKET_OVERVIEW_HISTORY_FLOOR,
  type BenchmarkDataService,
} from "@intrinsic/stock-data";
import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable } from "@nestjs/common";
import {
  assertMutable,
  auditOf,
  isAdministrator,
  ownershipResponse,
  SYSTEM_FIRST_ORDER,
  SystemContentProtectedError,
  type ContentViewer,
} from "../builtins/content-access";
import { isOngoingListMember } from "@intrinsic/domain";
import { PrismaService } from "../database/prisma.service";
import { eodToday } from "../eod-today";
import { EntitlementsService } from "../entitlements/entitlements.service";
import {
  crossMonitorConfigurationBoundary,
  reboundMonitorFields,
} from "./monitor-configuration-boundary";
import { BENCHMARK_DATA_SERVICE } from "../benchmarks/benchmarks.tokens";
import {
  MONITOR_ETF_STATUS_OPTIONS,
  MONITORS_LOGGER,
} from "./monitors.tokens";
import { monitorStateSince } from "./signal-since";
import { readSignalTable } from "./monitor-signal-table";
import type { SignalTableQuery } from "./monitor-requests";
import {
  BUILT_IN_MONITOR_KEYS,
  type ParsedUpdateMonitorRequest,
} from "./monitor-requests";
import { visibleMonitorWhere } from "./monitor-visibility";
import { readMonitorSynchronization } from "./monitor-synchronization";

/**
 * Raised for a monitor that does not exist *or* belongs to another customer (or is an unpublished
 * built-in, for a non-administrator). The cases are deliberately indistinguishable, so knowing
 * another user's monitor id reveals nothing. There is no ADMIN bypass of customer content.
 */
export class MonitorNotFoundError extends Error {
  constructor() {
    super("Monitor was not found");
    this.name = "MonitorNotFoundError";
  }
}

/** Raised when the referenced Strategy or Stock List is not the caller's, or does not exist. */
export class MonitorReferenceNotFoundError extends Error {
  constructor(readonly reference: "strategy" | "stockList") {
    super(
      reference === "strategy"
        ? "Strategy was not found"
        : "Stock list was not found",
    );
    this.name = "MonitorReferenceNotFoundError";
  }
}

/** A well-formed request that asks for something this Monitor does not have. */
export class MonitorRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonitorRequestError";
  }
}

/**
 * Switching on one more Monitor would pass the deployment's operational fair-use ceiling. Not an
 * entitlement — the plan says unlimited — so it is a `409` with its own code, never a `403`.
 */
export class MonitorFairUseLimitError extends Error {
  constructor(readonly limit: number) {
    super(
      `You have ${limit} active monitors, the fair-use limit for one account. Switch one off, or contact support if you need more.`,
    );
    this.name = "MonitorFairUseLimitError";
  }
}

// Re-exported for the modules that read it from here.
export { visibleMonitorWhere };

/**
 * The operational fair-use ceiling, decided in the same transaction and under the same per-user
 * entitlement lock the entitlement check just took, so it cannot be raced either. Only enabled
 * customer Monitors count; a disabled one, and every built-in, cost nothing.
 */
async function assertMonitorFairUse(
  tx: Prisma.TransactionClient,
  userId: string,
  excludeMonitorId?: string,
): Promise<void> {
  const { maxEnabledPerUser } = getMonitorFairUseConfig();
  const enabled = await tx.monitor.count({
    where: {
      userId,
      enabled: true,
      ...(excludeMonitorId ? { id: { not: excludeMonitorId } } : {}),
    },
  });
  if (enabled + 1 > maxEnabledPerUser) {
    throw new MonitorFairUseLimitError(maxEnabledPerUser);
  }
}

/** How many Signals a detail response carries. Newest first; the collection page pages later. */
const SIGNAL_PAGE_SIZE = 100;

const MONITOR_INCLUDE = {
  strategy: { select: { id: true, name: true } },
  stockList: { select: { id: true, name: true, _count: { select: { items: true } } } },
  _count: { select: { signals: { where: { resolvedAt: null } } } },
} satisfies Prisma.MonitorInclude;

type MonitorRow = Prisma.MonitorGetPayload<{ include: typeof MONITOR_INCLUDE }>;

/** Monitors render newest-changed first; ids break same-tick ties. */
const MONITOR_ORDER = [{ updatedAt: "desc" as const }, { id: "desc" as const }];

/**
 * Projects one Monitor, with its derived operational status attached.
 *
 * `eligibility` is resolved over the owner's **complete** Monitor set, because the active-capacity
 * rule is positional. A Monitor whose eligibility could not be resolved falls back to reporting
 * its own intent, which is the honest answer when the derivation is unavailable rather than a
 * claim that it is scanning.
 */
function summaryOf(
  row: MonitorRow,
  eligibility: MonitorEligibility | undefined,
  viewer: ContentViewer,
  /** Built-ins this viewer has disabled for their own account. */
  disabledBuiltIns: ReadonlySet<string> = new Set(),
  /** Where the evaluation stands against its activity window, when it is running. */
  synchronization?: MonitorSynchronizationResponse,
): MonitorSummaryResponse {
  const system = row.ownership === "SYSTEM";
  // A built-in has no owner and no plan: whether it runs is the operator's global switch alone.
  const status = system
    ? row.isGloballyEnabled
      ? "ACTIVE"
      : "DISABLED"
    : (eligibility?.status ?? (row.enabled ? "ACTIVE" : "DISABLED"));
  return {
    ...ownershipResponse(row, viewer),
    id: row.id,
    name: row.name,
    // The one user-facing switch. A built-in's is this viewer's own choice — absent a stored one,
    // the default, enabled — and never the shared Monitor's evaluation, which is `isGloballyEnabled`.
    enabled: system ? !disabledBuiltIns.has(row.id) : row.enabled,
    strategyId: row.strategy.id,
    strategyName: row.strategy.name,
    stockListId: row.stockList.id,
    stockListName: row.stockList.name,
    securityCount: row.stockList._count.items,
    activeSignalCount: row._count.signals,
    ...(row.lastScanAt === null
      ? {}
      : { lastScanAt: row.lastScanAt.toISOString() }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    operationalStatus: status,
    ...(!system && eligibility?.blockedReason
      ? { blockedReason: eligibility.blockedReason }
      : {}),
    ...(system
      ? {
          isPublished: row.isPublished,
          isGloballyEnabled: row.isGloballyEnabled,
          ...(row.displayOrder === null ? {} : { displayOrder: row.displayOrder }),
        }
      : {}),
    ...(status === "ACTIVE" && synchronization ? { synchronization } : {}),
  };
}

/** Whether the worker evaluates this Monitor now: the operator's switch, or the owner's plan. */
function isRunning(
  row: Pick<MonitorRow, "id" | "ownership" | "isGloballyEnabled">,
  eligibility: ReadonlyMap<string, MonitorEligibility>,
): boolean {
  return row.ownership === "SYSTEM"
    ? row.isGloballyEnabled
    : (eligibility.get(row.id)?.executionEligible ?? false);
}

/**
 * What one security's persisted state truthfully says, and nothing more.
 *
 * The order of the tests is the product rule. An active Signal is the only thing that means
 * "currently matching". A level that recorded a decided outcome is what makes `NO_MATCH` a
 * statement about an evaluation rather than about absence. Only when every level this security has
 * is `NOT_EVALUABLE` is the security itself not evaluable.
 *
 * **No recorded state at all is the interesting case.** A cycle that cannot decide a level it has
 * never decided before deliberately writes no row — `monitor-repository.ts` calls absence the
 * honest "unknown" — so "never visited" and "visited, never decidable" look identical in the state
 * table. They are separated here by the two facts that do distinguish them: a Monitor that has
 * never completed a cycle has checked nothing, and a security added to the List after the last
 * completed cycle has not been reached by one yet. Anything else was visited, and produced no
 * decision.
 */
function securityStatusOf(input: {
  rows: readonly { lastOutcome: string }[];
  matched: boolean;
  waiting: boolean;
  lastScanAt: Date | null;
  memberSince: Date;
}): MonitorSecurityStatus {
  if (input.matched) {
    return "MATCHED";
  }
  if (input.waiting) {
    return "WAITING_FOR_TRIGGER";
  }
  if (input.rows.some((row) => row.lastOutcome !== "NOT_EVALUABLE")) {
    return "NO_MATCH";
  }
  if (input.rows.length > 0) {
    return "NOT_EVALUABLE";
  }
  if (input.lastScanAt === null || input.memberSince > input.lastScanAt) {
    return "NOT_CHECKED";
  }
  return "NOT_EVALUABLE";
}

@Injectable()
export class MonitorsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EntitlementsService)
    private readonly entitlements: EntitlementsService,
    @Inject(MONITORS_LOGGER) private readonly logger: StructuredLogger,
    @Inject(BENCHMARK_DATA_SERVICE)
    private readonly benchmarks: BenchmarkDataService,
    @Inject(MONITOR_ETF_STATUS_OPTIONS)
    private readonly etfStatusOptions: { publicationDelayMs: number },
  ) {}

  /**
   * Every Monitor a viewer can see: their own, plus the built-ins they may read.
   *
   * The collection page presents the two as separate sections, so a Guest gets the published
   * built-ins rather than a redirect to sign in, and an administrator additionally sees the
   * unpublished ones. Every row carries the one Enabled / Disabled switch — a built-in's being this
   * viewer's own choice — and, while it is evaluated, its synchronization.
   */
  async listForUser(viewer: ContentViewer): Promise<MonitorSummaryResponse[]> {
    const [rows, eligibility, disabled] = await Promise.all([
      this.prisma.monitor.findMany({
        where: visibleMonitorWhere(viewer),
        orderBy: [...SYSTEM_FIRST_ORDER, ...MONITOR_ORDER],
        include: MONITOR_INCLUDE,
      }),
      viewer
        ? this.entitlements.getMonitorExecutionEligibility(viewer.id)
        : Promise.resolve(new Map<string, MonitorEligibility>()),
      this.disabledBuiltInMonitors(viewer),
    ]);
    const synchronization = await readMonitorSynchronization(
      this.prisma,
      rows.filter((row) => isRunning(row, eligibility)),
    );
    return rows.map((row) =>
      summaryOf(
        row,
        eligibility.get(row.id),
        viewer,
        disabled,
        synchronization.get(row.id),
      ),
    );
  }

  /**
   * One Monitor's summary as this viewer sees it — their own choice for a built-in, the owner's
   * eligibility, the synchronization — read after a change, so the answer is the stored state.
   */
  private async summaryForViewer(
    viewer: AuthUser,
    monitorId: string,
  ): Promise<MonitorSummaryResponse> {
    const row = await this.readVisibleMonitor(viewer, monitorId);
    const [eligibility, disabled] = await Promise.all([
      row.userId === null
        ? Promise.resolve(new Map<string, MonitorEligibility>())
        : this.entitlements.getMonitorExecutionEligibility(row.userId),
      this.disabledBuiltInMonitors(viewer),
    ]);
    const synchronization = isRunning(row, eligibility)
      ? (await readMonitorSynchronization(this.prisma, [row])).get(row.id)
      : undefined;
    return summaryOf(
      row,
      eligibility.get(row.id),
      viewer,
      disabled,
      synchronization,
    );
  }

  /**
   * Which built-ins this viewer has disabled for their own account.
   *
   * Only an override is stored (`docs/decisions/builtin-dashboard-signals-v1.md` §5.2, §17b), so the
   * absent case is the default — enabled — rather than a missing value, and a Guest, who is never
   * given a row, simply has none.
   */
  private async disabledBuiltInMonitors(
    viewer: ContentViewer,
  ): Promise<ReadonlySet<string>> {
    if (!viewer) {
      return new Set<string>();
    }
    const preferences = await this.prisma.userBuiltInMonitorPreference.findMany(
      { where: { userId: viewer.id, enabled: false }, select: { monitorId: true } },
    );
    return new Set(preferences.map((entry) => entry.monitorId));
  }

  /**
   * Creates a Monitor over the caller's own Strategy and Stock List.
   *
   * Both references are checked against the caller in the same transaction as the insert, so a
   * Monitor can never be created over someone else's strategy or list — a foreign key alone would
   * have accepted any id that exists.
   *
   * The active-capacity check happens in that same transaction, and only when the Monitor is being
   * created **enabled**: creating a disabled Monitor is not an active Monitor, and there is no
   * quota on how many a user may store. Taking the entitlement lock inside the transaction is what
   * stops two concurrent creations from each seeing the same active count and both succeeding.
   */
  async createMonitor(
    user: AuthUser,
    input: {
      name: string;
      strategyId: string;
      stockListId: string;
      enabled: boolean;
    },
  ): Promise<MonitorDetailResponse> {
    const userId = user.id;
    const row = await this.prisma.$transaction(async (tx) => {
      if (input.enabled) {
        await this.entitlements.assertCanEnableMonitor(tx, userId);
        await assertMonitorFairUse(tx, userId);
        // Running from now: its window is caught up by the next pass, not the next interval.
        await requestMonitorEvaluation(tx);
      }
      const strategy = await tx.strategy.findFirst({
        where: { id: input.strategyId, userId },
        select: { id: true },
      });
      if (!strategy) {
        throw new MonitorReferenceNotFoundError("strategy");
      }
      const stockList = await tx.stockList.findFirst({
        where: { id: input.stockListId, userId },
        select: { id: true },
      });
      if (!stockList) {
        throw new MonitorReferenceNotFoundError("stockList");
      }
      return tx.monitor.create({
        data: {
          userId,
          name: input.name,
          strategyId: input.strategyId,
          stockListId: input.stockListId,
          enabled: input.enabled,
          // Its members are evaluated over the rolling 30-day activity window
          // (`docs/decisions/monitor-eod-v2.md` §12).
          windowReplay: true,
        },
        include: MONITOR_INCLUDE,
      });
    });

    this.logger.info({
      event: "monitor.created",
      actorUserId: userId,
      monitorId: row.id,
      strategyId: input.strategyId,
      stockListId: input.stockListId,
      enabled: input.enabled,
    });
    // A new Monitor has produced nothing yet, but its universe is already known: every member
    // reports `NOT_CHECKED` until a cycle reaches it.
    const eligibility = await this.entitlements.getMonitorExecutionEligibility(
      userId,
    );
    const synchronization = isRunning(row, eligibility)
      ? (await readMonitorSynchronization(this.prisma, [row])).get(row.id)
      : undefined;
    return {
      ...summaryOf(
        row,
        eligibility.get(row.id),
        user,
        new Set(),
        synchronization,
      ),
      securities: await this.listSecurityEvaluations(
        row,
        await this.monitoredLevelIds(input.strategyId),
      ),
      signals: [],
    };
  }

  async getMonitor(
    viewer: ContentViewer,
    monitorId: string,
  ): Promise<MonitorDetailResponse> {
    const { row, eligibility, disabled, synchronization, etfSources, securities } =
      await this.readMonitorDetail(viewer, monitorId);
    const [signals, coverage] = await Promise.all([
      this.listSignals(monitorId),
      this.coverageOf(
        row.id,
        securities.map((entry) => entry.security.id),
        row.stockList._count.items,
      ),
    ]);
    return {
      ...summaryOf(
        row,
        eligibility.get(row.id),
        viewer,
        disabled,
        synchronization,
      ),
      securities,
      signals,
      coverage,
      ...(etfSources.statuses.length > 0
        ? { etfSources: etfSources.statuses }
        : {}),
      ...(etfSources.stockSectors
        ? { stockSectors: etfSources.stockSectors }
        : {}),
    };
  }

  /**
   * The Monitor's page as it renders (`?view=summary`): the full detail without every member's row
   * and without the newest Signals, which the page never shows, and with the members counted. The
   * members are still evaluated here, exactly as for the full detail — the counts and the coverage
   * are of the same rows — they are only not sent.
   */
  async getMonitorSummary(
    viewer: ContentViewer,
    monitorId: string,
  ): Promise<MonitorDetailSummaryResponse> {
    const { row, eligibility, disabled, synchronization, etfSources, securities } =
      await this.readMonitorDetail(viewer, monitorId);
    const byStatus = Object.fromEntries(
      MONITOR_SECURITY_STATUSES.map((status) => [status, 0]),
    ) as Record<MonitorSecurityStatus, number>;
    for (const entry of securities) {
      byStatus[entry.status] += 1;
    }
    return {
      ...summaryOf(
        row,
        eligibility.get(row.id),
        viewer,
        disabled,
        synchronization,
      ),
      memberCounts: { total: securities.length, byStatus },
      coverage: await this.coverageOf(
        row.id,
        securities.map((entry) => entry.security.id),
        row.stockList._count.items,
      ),
      ...(etfSources.statuses.length > 0
        ? { etfSources: etfSources.statuses }
        : {}),
      ...(etfSources.stockSectors
        ? { stockSectors: etfSources.stockSectors }
        : {}),
    };
  }

  /** What both views of the detail read: the row, its eligibility, ETF sources and members. */
  private async readMonitorDetail(viewer: ContentViewer, monitorId: string) {
    const row = await this.prisma.monitor.findFirst({
      where: { id: monitorId, ...visibleMonitorWhere(viewer) },
      include: MONITOR_INCLUDE,
    });
    if (!row) {
      throw new MonitorNotFoundError();
    }
    // Independent reads, issued together: the levels this Monitor actually evaluates, its owner's
    // eligibility and its ETF sources. None is per security.
    const [monitoredLevelIds, eligibility, etfSources, disabled] =
      await Promise.all([
        this.monitoredLevelIds(row.strategyId),
        row.userId === null
          ? Promise.resolve(new Map<string, MonitorEligibility>())
          : this.entitlements.getMonitorExecutionEligibility(row.userId),
        this.etfSourceStatuses(row.strategyId, row.stockListId),
        this.disabledBuiltInMonitors(viewer),
      ]);
    const [securities, synchronization] = await Promise.all([
      this.listSecurityEvaluations(row, monitoredLevelIds),
      isRunning(row, eligibility)
        ? readMonitorSynchronization(this.prisma, [row]).then((all) =>
            all.get(row.id),
          )
        : Promise.resolve(undefined),
    ]);
    return {
      row,
      eligibility,
      disabled,
      synchronization,
      etfSources,
      securities,
    };
  }

  /**
   * The Monitor's Signal table (`docs/decisions/monitor-eod-v2.md` §6), visible exactly where the
   * Monitor itself is.
   */
  async getSignalTable(
    viewer: ContentViewer,
    monitorId: string,
    query: SignalTableQuery,
  ): Promise<MonitorSignalPageResponse> {
    const row = await this.prisma.monitor.findFirst({
      where: { id: monitorId, ...visibleMonitorWhere(viewer) },
      select: { id: true, strategyId: true },
    });
    if (!row) {
      throw new MonitorNotFoundError();
    }
    return readSignalTable(this.prisma, this.logger, row, query);
  }

  /**
   * How far evaluation has reached: the newest session any current member was evaluated through,
   * and how many current members have reached it — read from the members' durable checkpoints.
   */
  private async coverageOf(
    monitorId: string,
    currentSecurityIds: readonly string[],
    listedMembers: number,
  ): Promise<MonitorCoverageResponse> {
    const checkpoints =
      currentSecurityIds.length === 0
        ? []
        : await this.prisma.monitorEvaluationCheckpoint.findMany({
            where: { monitorId, securityId: { in: [...currentSecurityIds] } },
            select: { evaluatedThrough: true },
          });
    const sessions = checkpoints.map((checkpoint) =>
      checkpoint.evaluatedThrough.toISOString().slice(0, 10),
    );
    const latest = sessions.reduce<string | undefined>(
      (newest, session) =>
        newest === undefined || session > newest ? session : newest,
      undefined,
    );
    return {
      ...(latest ? { latestSession: latest } : {}),
      evaluatedMembers: sessions.filter((session) => session === latest).length,
      currentMembers: currentSecurityIds.length,
      listedMembers,
    };
  }

  /**
   * The current availability of each ETF source this Monitor's Strategy reads — derived at read
   * time from the series' durable refresh state, never persisted, and never a provider request.
   * Empty for a Strategy that reads none, and empty rather than failing when the Strategy cannot
   * be read: the availability note must not take the whole detail page down.
   *
   * A Strategy reading Stock's Sector also reads, for each monitored stock, the sector ETF its
   * current FMP sector maps to — exactly as the next scan will resolve it — so those funds have
   * their rows here too, and `stockSectors` says which stock reads which, or that a stock's sector
   * is missing or unsupported and its Stock's Sector rules cannot be evaluated.
   */
  private async etfSourceStatuses(
    strategyId: string,
    stockListId: string,
  ): Promise<{
    statuses: MonitorEtfSourceStatusResponse[];
    stockSectors?: StockSectorAssignmentResponse[];
  }> {
    let codes: readonly StrategyEtfSourceCode[];
    let stockSectors: StockSectorAssignmentResponse[] | undefined;
    try {
      const version = await this.prisma.strategyVersion.findFirst({
        where: { strategyId },
        orderBy: { versionNumber: "desc" },
        select: { definition: true },
      });
      if (!version) {
        return { statuses: [] };
      }
      const definition = normalizeStrategyDefinition(version.definition);
      codes = collectStrategyEtfSources(definition);
      if (strategyReadsStockSector(definition)) {
        const items = await this.prisma.stockListItem.findMany({
          where: { stockListId },
          select: { security: { select: { symbol: true, sector: true } } },
        });
        stockSectors = items
          .map((item) =>
            stockSectorAssignment(item.security.symbol, item.security.sector),
          )
          .sort((left, right) => left.symbol.localeCompare(right.symbol));
        const sectorCodes = new Set(
          stockSectors.flatMap((assignment) =>
            assignment.code ? [assignment.code] : [],
          ),
        );
        codes = STRATEGY_ETF_SOURCES.map((etf) => etf.code).filter(
          (code) => codes.includes(code) || sectorCodes.has(code),
        );
      }
    } catch {
      return { statuses: [] };
    }
    if (codes.length === 0) {
      return { statuses: [], ...(stockSectors ? { stockSectors } : {}) };
    }
    const statuses: MonitorEtfSourceStatusResponse[] = [];
    for (const code of codes) {
      const ticker = findStrategyEtfSource(code)?.ticker ?? code;
      try {
        const benchmark = await this.benchmarks.getBenchmark(code);
        const state = await this.benchmarks.benchmarkRefreshState(
          benchmark.series,
        );
        if (state.coverageEnd === undefined) {
          statuses.push({ code, ticker, status: "NOT_BOOTSTRAPPED" });
          continue;
        }
        const missing = await this.benchmarks.missingBenchmarkCoverage(
          benchmark.series,
          { from: MARKET_OVERVIEW_HISTORY_FLOOR, to: state.coverageEnd },
        );
        if (missing.length > 0) {
          statuses.push({ code, ticker, status: "NOT_BOOTSTRAPPED" });
          continue;
        }
        if (state.lastTailSyncAt === undefined || state.latestBar === undefined) {
          statuses.push({ code, ticker, status: "NOT_SYNCHRONIZED" });
          continue;
        }
        // The newest stored bar is usable exactly when its session's close plus the publication
        // delay has passed AND the tail was read at or after that instant — the same rule the
        // evaluation path applies. Until then the bar may still be the provisional mid-session
        // reading, so conditions evaluate through an earlier session.
        const finalizedAt = benchmarkSessionFinalizedAt(
          state.latestBar,
          this.etfStatusOptions.publicationDelayMs,
        ).getTime();
        const synced =
          finalizedAt <= Date.now() &&
          finalizedAt <= Date.parse(state.lastTailSyncAt);
        statuses.push({
          code,
          ticker,
          status: synced ? "READY" : "AWAITING_SESSION",
          ...(synced ? { latestSession: state.latestBar } : {}),
        });
      } catch (err) {
        this.logger.warn({
          event: "monitor.etf-source.status-failed",
          code,
          err,
        });
        statuses.push({ code, ticker, status: "NOT_SYNCHRONIZED" });
      }
    }
    return { statuses, ...(stockSectors ? { stockSectors } : {}) };
  }

  /**
   * The canonical level ids this Monitor's current Strategy version is actually evaluated on.
   *
   * Read through `monitorStrategyLevels`, the same function the worker walks, so the API cannot
   * develop its own opinion about which levels a Monitor supports — levels depending on `Gain` or
   * `Loss` are excluded there and are therefore excluded here by construction.
   *
   * Why the status table needs this at all: a level can stop being evaluated without its state row
   * disappearing. Removing it from the Strategy, or editing it so it now depends on `Gain`, leaves
   * the row behind with the latch the unvisited-Signal sweep reset it to. Counting that as "a level
   * decided a non-match" would report a decision the current configuration never made.
   *
   * A definition that cannot be normalized is a should-never-happen — it was normalized on write —
   * and is not allowed to fail the request: `null` means "unknown", and the caller then filters
   * nothing rather than blanking the whole table.
   */
  private async monitoredLevelIds(
    strategyId: string,
  ): Promise<ReadonlySet<string> | null> {
    const version = await this.prisma.strategyVersion.findFirst({
      where: { strategyId },
      orderBy: { versionNumber: "desc" },
      select: { id: true, definition: true },
    });
    if (!version) {
      return new Set();
    }
    try {
      const definition = normalizeStrategyDefinition(version.definition);
      return new Set(monitorStrategyLevels(definition).map((level) => level.id));
    } catch (err) {
      this.logger.error({
        event: "monitor.strategy.definition.unreadable",
        strategyId,
        strategyVersionId: version.id,
        err,
      });
      return null;
    }
  }

  /**
   * The Monitor's current universe, each security carrying what durable state says about it.
   *
   * A **projection**, never a re-evaluation: `MonitorSignalState` is what the worker decided, and
   * the API neither re-runs the evaluator nor infers an outcome the worker did not record.
   *
   * Two queries for the whole table — the list's members, and this Monitor's states with whatever
   * Signal each one currently points at.
   */
  private async listSecurityEvaluations(
    monitor: {
      id: string;
      stockListId: string;
      lastScanAt: Date | null;
    },
    /** Levels the Monitor evaluates; `null` when the Strategy could not be read. */
    monitoredLevelIds: ReadonlySet<string> | null,
  ): Promise<MonitorSecurityEvaluationResponse[]> {
    const [items, states] = await Promise.all([
      this.prisma.stockListItem.findMany({
        where: { stockListId: monitor.stockListId },
        select: {
          createdAt: true,
          buyWindowMode: true,
          buyWindows: { select: { startDate: true, endDate: true } },
          security: {
            select: {
              id: true,
              symbol: true,
              name: true,
              exchangeCode: true,
              exchangeName: true,
              // The mark the row renders, from the profile the catalog persists.
              profile: { select: { logoUrl: true } },
            },
          },
        },
        orderBy: { security: { symbol: "asc" } },
      }),
      this.prisma.monitorSignalState.findMany({
        where: { monitorId: monitor.id },
        select: {
          securityId: true,
          levelId: true,
          levelKind: true,
          lastOutcome: true,
          lastOutcomeAt: true,
          lifecycleState: true,
          lifecycleSince: true,
          lifecycleSinceDate: true,
          activeSignal: {
            select: {
              id: true,
              hasTrigger: true,
              observationPrice: true,
              detectedAt: true,
            },
          },
        },
      }),
    ]);

    const bySecurity = new Map<string, typeof states>();
    for (const state of states) {
      // A row belonging to a level the Monitor no longer evaluates says nothing about the current
      // configuration, so it does not get to decide a status.
      if (monitoredLevelIds !== null && !monitoredLevelIds.has(state.levelId)) {
        continue;
      }
      const bucket = bySecurity.get(state.securityId);
      if (bucket) {
        bucket.push(state);
      } else {
        bySecurity.set(state.securityId, [state]);
      }
    }

    // The Monitor universe is the List's **current** members — "Always eligible", or an open-ended
    // period that has begun by the newest finalized session (`docs/decisions/monitor-eod-v2.md`
    // §4). A member outside it is not monitored, so it is not listed as unchecked or undecided.
    const finalizedThrough = eodToday();
    const current = items.filter((item) =>
      isOngoingListMember(
        {
          mode: item.buyWindowMode,
          ranges: item.buyWindows.map((window) => ({
            startDate: window.startDate.toISOString().slice(0, 10),
            endDate: window.endDate?.toISOString().slice(0, 10) ?? null,
          })),
        },
        finalizedThrough,
      ),
    );

    return current.map((item) => {
      const rows = bySecurity.get(item.security.id) ?? [];
      const matchedLevels: MonitorMatchedLevelResponse[] = rows
        .filter(
          (row) => row.lifecycleState === "ACTIVE" && row.activeSignal !== null,
        )
        .map((row) => {
          const signal = row.activeSignal as NonNullable<
            typeof row.activeSignal
          >;
          return {
            levelId: row.levelId,
            levelKind: row.levelKind,
            kind: signal.hasTrigger ? ("TRIGGER" as const) : ("CONDITION" as const),
            signalId: signal.id,
            observationPrice: Number(signal.observationPrice),
            detectedAt: signal.detectedAt.toISOString(),
          };
        });
      const waitingLevels: MonitorWaitingLevelResponse[] = rows
        .filter((row) => row.lifecycleState === "PENDING_TRIGGER")
        .map((row) => ({
          levelId: row.levelId,
          levelKind: row.levelKind,
          // The session the setup began on, not the scan that recorded it (AUD-05).
          since: monitorStateSince({
            observationDate: row.lifecycleSinceDate,
            enteredAt: row.lifecycleSince,
          }),
        }));
      const statusSince = rows.reduce<Date | null>((newest, row) => {
        const changed =
          row.lifecycleSince > row.lastOutcomeAt
            ? row.lifecycleSince
            : row.lastOutcomeAt;
        return newest === null || changed > newest ? changed : newest;
      }, null);
      return {
        security: {
          id: item.security.id,
          symbol: item.security.symbol,
          name: item.security.name,
          exchangeCode: item.security.exchangeCode,
          ...(item.security.exchangeName === null
            ? {}
            : { exchangeName: item.security.exchangeName }),
          ...(item.security.profile?.logoUrl
            ? { logoUrl: item.security.profile.logoUrl }
            : {}),
        },
        status: securityStatusOf({
          rows,
          matched: matchedLevels.length > 0,
          waiting: waitingLevels.length > 0,
          lastScanAt: monitor.lastScanAt,
          memberSince: item.createdAt,
        }),
        matchedLevels,
        waitingLevels,
        ...(statusSince === null
          ? {}
          : { statusSince: statusSince.toISOString() }),
      };
    });
  }

  /**
   * Updates a Monitor: its name, whether it is enabled, and which Strategy and Stock List it
   * watches. There is still deliberately no cadence to update.
   *
   * Two different operations share this route, and they are kept apart on purpose:
   *
   * - **Identity only** — name and `enabled`. Neither invalidates anything: disabling stops future
   *   evaluations and nothing else, and the persisted transition state is **kept** so re-enabling
   *   resumes with trigger semantics intact rather than treating every already-matched condition as
   *   newly matched. One atomic statement, no lock, no reset.
   * - **A rebind** — a different `strategyId` or `stockListId`. That crosses a configuration
   *   boundary and is handled by `rebindMonitor`.
   *
   * Which one this is is decided by comparing **values**, never by which keys the client sent: an
   * edit form naturally submits the Strategy and List it was prepopulated with, and resubmitting the
   * same ones must not reset a thing.
   */
  async updateMonitor(
    user: AuthUser,
    monitorId: string,
    patch: ParsedUpdateMonitorRequest,
  ): Promise<MonitorSummaryResponse> {
    const visible = await this.prisma.monitor.findFirst({
      where: { id: monitorId, ...visibleMonitorWhere(user) },
      select: { ownership: true },
    });
    if (!visible) {
      throw new MonitorNotFoundError();
    }
    if (visible.ownership === "SYSTEM") {
      // A built-in's `enabled` is the caller's own choice for their account, which any signed-in
      // viewer may make; everything else about it is the operator's, an administrator's alone. The
      // operator's part goes first, so a refused one leaves the choice unwritten too.
      const { enabled, ...operatorPatch } = patch;
      if (Object.values(operatorPatch).some((value) => value !== undefined)) {
        await this.applyMonitorPatch(user, monitorId, operatorPatch);
      }
      if (enabled !== undefined) {
        await this.setBuiltInEnabled(user, monitorId, enabled);
      }
      return this.summaryForViewer(user, monitorId);
    }
    await this.applyMonitorPatch(user, monitorId, patch);
    return this.summaryForViewer(user, monitorId);
  }

  /**
   * Records a signed-in viewer's own Enabled / Disabled choice for a built-in
   * (`docs/decisions/builtin-dashboard-signals-v1.md` §17b).
   *
   * One `UserBuiltInMonitorPreference` row, this user's alone: it decides whether they receive the
   * built-in's Dashboard results and nothing else — the shared Monitor keeps being evaluated once
   * for everybody, no other user's choice moves, and no Monitor allowance is consumed. A published
   * built-in for everyone; an unpublished one only for the administrators who can see it.
   */
  private async setBuiltInEnabled(
    user: AuthUser,
    monitorId: string,
    enabled: boolean,
  ): Promise<void> {
    const monitor = await this.prisma.monitor.findFirst({
      where: {
        id: monitorId,
        ownership: "SYSTEM",
        ...(isAdministrator(user) ? {} : { isPublished: true }),
      },
      select: { id: true },
    });
    if (!monitor) {
      throw new MonitorNotFoundError();
    }
    await this.prisma.userBuiltInMonitorPreference.upsert({
      where: { userId_monitorId: { userId: user.id, monitorId } },
      create: { userId: user.id, monitorId, enabled },
      update: { enabled },
    });
    this.logger.info({
      event: "monitor.built-in-choice.updated",
      actorUserId: user.id,
      monitorId,
      enabled,
    });
  }

  /**
   * Applies a Monitor change the caller is allowed to make on the Monitor itself: its name, whether
   * a customer's own Monitor is enabled, which Strategy and Stock List it watches, and — for an
   * administrator on a built-in — the operator's switches. There is still deliberately no cadence.
   *
   * Two different operations share it, and they are kept apart on purpose:
   *
   * - **Identity only** — name and `enabled`. Neither invalidates anything: disabling stops future
   *   evaluations and nothing else, and the persisted transition state and checkpoints are **kept**
   *   so re-enabling resumes with trigger semantics intact and catches up only the sessions it
   *   missed (`docs/decisions/monitor-eod-v2.md` §12). One atomic statement, no lock, no reset.
   * - **A rebind** — a different `strategyId` or `stockListId`. That crosses a configuration
   *   boundary and is handled by `rebindMonitor`.
   *
   * Which one this is is decided by comparing **values**, never by which keys the client sent: an
   * edit form naturally submits the Strategy and List it was prepopulated with, and resubmitting the
   * same ones must not reset a thing.
   */
  private async applyMonitorPatch(
    user: AuthUser,
    monitorId: string,
    patch: ParsedUpdateMonitorRequest,
  ): Promise<void> {
    const userId = user.id;
    const target = await this.findMutable(user, monitorId);
    const builtInKeys = BUILT_IN_MONITOR_KEYS.filter((key) => patch[key] !== undefined);
    if (target.ownership === "USER" && builtInKeys.length > 0) {
      throw new MonitorRequestError(
        `\`${builtInKeys[0]}\` applies to built-in monitors only`,
      );
    }

    if (patch.strategyId !== undefined || patch.stockListId !== undefined) {
      await this.rebindMonitor(user, target.ownership, monitorId, patch);
      return;
    }

    // Switching a Monitor on is a capacity decision, so the check and the write share one
    // transaction. `excludeMonitorId` keeps it idempotent: re-saving a Monitor that is already
    // enabled must not count it against its own limit and refuse a no-op.
    //
    // Switching one *off* is never refused. A user over capacity after a downgrade has to be able
    // to reduce their active set — refusing the one operation that fixes the situation would be
    // a trap. A built-in consumes nobody's capacity.
    const updated = await this.prisma.$transaction(async (tx) => {
      if (target.ownership === "USER" && patch.enabled === true) {
        await this.entitlements.assertCanEnableMonitor(tx, userId, {
          excludeMonitorId: monitorId,
        });
        await assertMonitorFairUse(tx, userId, monitorId);
      }
      // Switched on: its missing sessions are caught up by the next pass, not the next interval.
      // Switching a customer's own Monitor off can hand its plan slot to the next one, which then
      // starts the same way.
      if (
        patch.enabled === true ||
        (patch.enabled === false && target.ownership === "USER") ||
        patch.isGloballyEnabled === true
      ) {
        await requestMonitorEvaluation(tx);
      }
      // `updateMany` applies the ownership filter and the write in one atomic statement.
      return tx.monitor.updateMany({
        where:
          target.ownership === "SYSTEM"
            ? { id: monitorId, ownership: "SYSTEM" }
            : { id: monitorId, userId },
        data: {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.isPublished === undefined
            ? {}
            : { isPublished: patch.isPublished }),
          ...(patch.isGloballyEnabled === undefined
            ? {}
            : { isGloballyEnabled: patch.isGloballyEnabled }),
          // Switched off: it is no longer watched, so sessions that finalize until the evaluation
          // sees it running again are not reported as newly observed when it catches up over them
          // (`docs/decisions/monitor-eod-v2.md` §3).
          ...(patch.enabled === false || patch.isGloballyEnabled === false
            ? { watchingSince: null }
            : {}),
          ...(patch.displayOrder === undefined
            ? {}
            : { displayOrder: patch.displayOrder }),
          ...auditOf(target, user),
        },
      });
    });
    if (updated.count === 0) {
      throw new MonitorNotFoundError();
    }

    const row = await this.readVisibleMonitor(user, monitorId);
    this.logger.info({
      event: "monitor.updated",
      actorUserId: userId,
      monitorId,
      ownership: row.ownership,
      enabled: row.enabled,
      ...(row.ownership === "SYSTEM"
        ? {
            isPublished: row.isPublished,
            isGloballyEnabled: row.isGloballyEnabled,
          }
        : {}),
    });
  }

  /**
   * The Monitor a viewer asked to change: 404 when not visible to them, 403 when it is a built-in
   * and they are not an administrator.
   */
  private async findMutable(user: AuthUser, monitorId: string) {
    const row = await this.prisma.monitor.findFirst({
      where: {
        id: monitorId,
        OR: [
          { userId: user.id },
          { ownership: "SYSTEM", ...(isAdministrator(user) ? {} : { isPublished: true }) },
        ],
      },
      select: { id: true, ownership: true, userId: true, systemKey: true },
    });
    const monitor = assertMutable(row, user, "monitors");
    if (!monitor) {
      throw new MonitorNotFoundError();
    }
    return monitor;
  }

  /**
   * Points a Monitor at a different Strategy and/or Stock List.
   *
   * This is **not** the same thing as editing the Strategy or List it already references. Those are
   * live: their contents change what is watched on the next cycle with no request at all, and the
   * level-fingerprint rules in `monitor-repository.ts` decide which latched state survives. A
   * rebind replaces *which* Strategy or List is watched, and the state left behind describes a
   * level of a Strategy, or a member of a List, that this Monitor no longer evaluates. So:
   *
   * - every Signal still active under the replaced configuration is **resolved** — it stops being
   *   current, which it no longer is;
   * - Signal rows are **never deleted**: a Signal records what was observed, and history survives a
   *   configuration change;
   * - the transition state is **discarded**, so no latch from the old configuration can decide an
   *   edge in the new one, and no fingerprint coincidence between two Strategies can carry one over;
   * - `lastScanAt` is **cleared**, because the configuration now named has not been checked;
   * - `configVersion` is **incremented**, which is what stops a cycle already evaluating the
   *   replaced configuration from committing into the new one.
   *
   * Ownership of both new references is verified inside the same transaction as the write, exactly
   * as creation does — a foreign key alone would accept any id that exists.
   */
  private async rebindMonitor(
    user: AuthUser,
    ownership: "USER" | "SYSTEM",
    monitorId: string,
    patch: ParsedUpdateMonitorRequest,
  ): Promise<void> {
    const userId = user.id;
    const system = ownership === "SYSTEM";
    // A customer's Monitor watches the customer's own content; a built-in watches built-ins only —
    // and only standard ones. A built-in Monitor's Signals are public on every Dashboard, so one
    // bound to a premium List or Strategy would publish what premium content withholds
    // (`docs/decisions/entitlements-v2.md` §6); a premium reference reads as missing here.
    const referenceOwner = system
      ? { ownership: "SYSTEM" as const, premium: false }
      : { userId };
    const now = new Date();
    const outcome = await this.prisma.$transaction(async (tx) => {
      // A rebind may also switch the Monitor on, so it is the same capacity decision — taken
      // before the Monitor row is locked, so this transaction acquires the per-user entitlement
      // lock and the Monitor row lock in the one order every writer uses.
      if (!system && patch.enabled === true) {
        await this.entitlements.assertCanEnableMonitor(tx, userId, {
          excludeMonitorId: monitorId,
        });
        await assertMonitorFairUse(tx, userId, monitorId);
      }
      // The Monitor row is locked first, before anything else in this transaction touches state or
      // Signals. A cycle committing a transition locks the same row (`FOR SHARE`) before its own
      // state writes, so both orders agree and the two cannot deadlock. Ownership is part of the
      // lock predicate, so a Monitor the caller does not own locks nothing and reads as missing.
      const locked = system
        ? await tx.$queryRaw<{ strategyId: string; stockListId: string }[]>`
            SELECT "strategyId", "stockListId"
            FROM "Monitor"
            WHERE "id" = ${monitorId} AND "ownership" = 'SYSTEM'
            FOR UPDATE
          `
        : await tx.$queryRaw<{ strategyId: string; stockListId: string }[]>`
            SELECT "strategyId", "stockListId"
            FROM "Monitor"
            WHERE "id" = ${monitorId} AND "userId" = ${userId}
            FOR UPDATE
          `;
      const current = locked[0];
      if (!current) {
        throw new MonitorNotFoundError();
      }

      const nextStrategyId = patch.strategyId ?? current.strategyId;
      const nextStockListId = patch.stockListId ?? current.stockListId;

      // Only what actually changes is verified. Re-submitting the Monitor's own Strategy costs no
      // query, and a reference that is already attached cannot become unowned.
      if (nextStrategyId !== current.strategyId) {
        const strategy = await tx.strategy.findFirst({
          where: { id: nextStrategyId, ...referenceOwner },
          select: { id: true },
        });
        if (!strategy) {
          throw new MonitorReferenceNotFoundError("strategy");
        }
      }
      if (nextStockListId !== current.stockListId) {
        const stockList = await tx.stockList.findFirst({
          where: { id: nextStockListId, ...referenceOwner },
          select: { id: true },
        });
        if (!stockList) {
          throw new MonitorReferenceNotFoundError("stockList");
        }
      }

      const rebound =
        nextStrategyId !== current.strategyId ||
        nextStockListId !== current.stockListId;

      let resolvedSignals = 0;
      let clearedStates = 0;
      if (rebound) {
        ({ resolvedSignals, clearedStates } =
          await crossMonitorConfigurationBoundary(tx, monitorId, now));
      }
      // A new configuration, a Monitor switched on, or a slot freed by one switched off: evaluated
      // by the next pass.
      if (
        rebound ||
        patch.enabled !== undefined ||
        patch.isGloballyEnabled === true
      ) {
        await requestMonitorEvaluation(tx);
      }

      const row = await tx.monitor.update({
        where: { id: monitorId },
        data: {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.isPublished === undefined
            ? {}
            : { isPublished: patch.isPublished }),
          ...(patch.isGloballyEnabled === undefined
            ? {}
            : { isGloballyEnabled: patch.isGloballyEnabled }),
          // Switched off: it is no longer watched, so sessions that finalize until the evaluation
          // sees it running again are not reported as newly observed when it catches up over them
          // (`docs/decisions/monitor-eod-v2.md` §3).
          ...(patch.enabled === false || patch.isGloballyEnabled === false
            ? { watchingSince: null }
            : {}),
          ...(patch.displayOrder === undefined
            ? {}
            : { displayOrder: patch.displayOrder }),
          ...(system ? { updatedByUserId: userId } : {}),
          strategyId: nextStrategyId,
          stockListId: nextStockListId,
          ...(rebound ? reboundMonitorFields() : {}),
        },
        include: MONITOR_INCLUDE,
      });
      return {
        row,
        rebound,
        resolvedSignals,
        clearedStates,
        previousStrategyId: current.strategyId,
        previousStockListId: current.stockListId,
      };
    });

    this.logger.info({
      event: outcome.rebound ? "monitor.rebound" : "monitor.updated",
      actorUserId: userId,
      monitorId,
      enabled: outcome.row.enabled,
      ...(outcome.rebound
        ? {
            previousStrategyId: outcome.previousStrategyId,
            strategyId: outcome.row.strategyId,
            previousStockListId: outcome.previousStockListId,
            stockListId: outcome.row.stockListId,
            configVersion: outcome.row.configVersion,
            resolvedSignals: outcome.resolvedSignals,
            clearedStates: outcome.clearedStates,
          }
        : {}),
    });
  }

  /** Re-reads a Monitor the caller can see, or reports it missing if it vanished underneath. */
  private async readVisibleMonitor(
    user: AuthUser,
    monitorId: string,
  ): Promise<MonitorRow> {
    const row = await this.prisma.monitor.findFirst({
      where: { id: monitorId, ...visibleMonitorWhere(user) },
      include: MONITOR_INCLUDE,
    });
    if (!row) {
      // Deleted between the update and this read; to the caller it no longer exists.
      throw new MonitorNotFoundError();
    }
    return row;
  }

  async deleteMonitor(user: AuthUser, monitorId: string): Promise<void> {
    const userId = user.id;
    const target = await this.findMutable(user, monitorId);
    if (target.ownership === "SYSTEM") {
      throw new SystemContentProtectedError("monitors");
    }
    const deleted = await this.prisma.monitor.deleteMany({
      where: { id: monitorId, userId },
    });
    if (deleted.count === 0) {
      throw new MonitorNotFoundError();
    }
    this.logger.info({
      event: "monitor.deleted",
      actorUserId: userId,
      monitorId,
    });
  }

  /**
   * The Monitor's Signals, newest first.
   *
   * Both condition-only matches and trigger events are Signals. `kind` says which one produced a
   * row so the UI can explain it; it is not a second product concept.
   */
  private async listSignals(
    monitorId: string,
  ): Promise<MonitorSignalResponse[]> {
    const rows = await this.prisma.monitorSignal.findMany({
      where: { monitorId },
      orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
      take: SIGNAL_PAGE_SIZE,
      include: {
        security: {
          select: {
            id: true,
            symbol: true,
            name: true,
            exchangeCode: true,
            exchangeName: true,
            // The mark the row renders, from the profile the catalog persists.
            profile: { select: { logoUrl: true } },
          },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      security: {
        id: row.security.id,
        symbol: row.security.symbol,
        name: row.security.name,
        exchangeCode: row.security.exchangeCode,
        ...(row.security.exchangeName === null
          ? {}
          : { exchangeName: row.security.exchangeName }),
        ...(row.security.profile?.logoUrl
          ? { logoUrl: row.security.profile.logoUrl }
          : {}),
      },
      levelKind: row.levelKind,
      levelId: row.levelId,
      kind: row.hasTrigger ? ("TRIGGER" as const) : ("CONDITION" as const),
      observationDate: row.observationDate.toISOString().slice(0, 10),
      observationPrice: Number(row.observationPrice),
      observationBasis: row.observationBasis,
      detectedAt: row.detectedAt.toISOString(),
      ...(row.resolvedAt === null
        ? {}
        : { resolvedAt: row.resolvedAt.toISOString() }),
      ...(row.resolvedObservationDate === null
        ? {}
        : {
            resolvedObservationDate: row.resolvedObservationDate
              .toISOString()
              .slice(0, 10),
          }),
      ...(row.resolutionReason === null
        ? {}
        : { resolutionReason: row.resolutionReason }),
      reconstructed: row.reconstructed,
    }));
  }
}
