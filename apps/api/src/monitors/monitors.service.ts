import type {
  MonitorDetailResponse,
  MonitorMatchedLevelResponse,
  MonitorSecurityEvaluationResponse,
  MonitorSecurityStatus,
  MonitorSignalResponse,
  MonitorSummaryResponse,
} from "@intrinsic/contracts";
import { normalizeStrategyDefinition } from "@intrinsic/contracts";
import type { Prisma } from "@intrinsic/database";
import { monitorStrategyLevels } from "@intrinsic/strategy";
import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { MONITORS_LOGGER } from "./monitors.tokens";
import type { ParsedUpdateMonitorRequest } from "./monitor-requests";

/**
 * Raised for a monitor that does not exist *or* is not owned by the caller. The two cases are
 * deliberately indistinguishable, so knowing another user's monitor id reveals nothing. There is
 * no ADMIN bypass, matching the strategy and stock-list slices.
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

function summaryOf(row: MonitorRow): MonitorSummaryResponse {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
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
  };
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
  lastScanAt: Date | null;
  memberSince: Date;
}): MonitorSecurityStatus {
  if (input.matched) {
    return "MATCHED";
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
    @Inject(MONITORS_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  async listForUser(userId: string): Promise<MonitorSummaryResponse[]> {
    const rows = await this.prisma.monitor.findMany({
      where: { userId },
      orderBy: MONITOR_ORDER,
      include: MONITOR_INCLUDE,
    });
    return rows.map(summaryOf);
  }

  /**
   * Creates a Monitor over the caller's own Strategy and Stock List.
   *
   * Both references are checked against the caller in the same transaction as the insert, so a
   * Monitor can never be created over someone else's strategy or list — a foreign key alone would
   * have accepted any id that exists.
   */
  async createMonitor(
    userId: string,
    input: {
      name: string;
      strategyId: string;
      stockListId: string;
      enabled: boolean;
    },
  ): Promise<MonitorDetailResponse> {
    const row = await this.prisma.$transaction(async (tx) => {
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
    return {
      ...summaryOf(row),
      securities: await this.listSecurityEvaluations(
        row,
        await this.monitoredLevelIds(input.strategyId),
      ),
      signals: [],
    };
  }

  async getMonitor(
    userId: string,
    monitorId: string,
  ): Promise<MonitorDetailResponse> {
    const row = await this.prisma.monitor.findFirst({
      where: { id: monitorId, userId },
      include: MONITOR_INCLUDE,
    });
    if (!row) {
      throw new MonitorNotFoundError();
    }
    // Three independent reads, issued together: the levels this Monitor actually evaluates, the
    // monitored universe with its current status, and the newest Signals. None is per security or
    // per Signal.
    const [monitoredLevelIds, signals] = await Promise.all([
      this.monitoredLevelIds(row.strategyId),
      this.listSignals(monitorId),
    ]);
    return {
      ...summaryOf(row),
      securities: await this.listSecurityEvaluations(row, monitoredLevelIds),
      signals,
    };
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
          security: {
            select: {
              id: true,
              symbol: true,
              name: true,
              exchangeCode: true,
              exchangeName: true,
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

    return items.map((item) => {
      const rows = bySecurity.get(item.security.id) ?? [];
      const matchedLevels: MonitorMatchedLevelResponse[] = rows
        .filter((row) => row.activeSignal !== null)
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
      const statusSince = rows.reduce<Date | null>(
        (newest, row) =>
          newest === null || row.lastOutcomeAt > newest
            ? row.lastOutcomeAt
            : newest,
        null,
      );
      return {
        security: {
          id: item.security.id,
          symbol: item.security.symbol,
          name: item.security.name,
          exchangeCode: item.security.exchangeCode,
          ...(item.security.exchangeName === null
            ? {}
            : { exchangeName: item.security.exchangeName }),
        },
        status: securityStatusOf({
          rows,
          matched: matchedLevels.length > 0,
          lastScanAt: monitor.lastScanAt,
          memberSince: item.createdAt,
        }),
        matchedLevels,
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
    userId: string,
    monitorId: string,
    patch: ParsedUpdateMonitorRequest,
  ): Promise<MonitorSummaryResponse> {
    if (patch.strategyId !== undefined || patch.stockListId !== undefined) {
      return this.rebindMonitor(userId, monitorId, patch);
    }

    // `updateMany` applies the ownership filter and the write in one atomic statement.
    const updated = await this.prisma.monitor.updateMany({
      where: { id: monitorId, userId },
      data: {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      },
    });
    if (updated.count === 0) {
      throw new MonitorNotFoundError();
    }

    const row = await this.readOwnMonitor(userId, monitorId);
    this.logger.info({
      event: "monitor.updated",
      actorUserId: userId,
      monitorId,
      enabled: row.enabled,
    });
    return summaryOf(row);
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
    userId: string,
    monitorId: string,
    patch: ParsedUpdateMonitorRequest,
  ): Promise<MonitorSummaryResponse> {
    const now = new Date();
    const outcome = await this.prisma.$transaction(async (tx) => {
      // The Monitor row is locked first, before anything else in this transaction touches state or
      // Signals. A cycle committing a transition locks the same row (`FOR SHARE`) before its own
      // state writes, so both orders agree and the two cannot deadlock. Ownership is part of the
      // lock predicate, so a Monitor the caller does not own locks nothing and reads as missing.
      const locked = await tx.$queryRaw<
        { strategyId: string; stockListId: string }[]
      >`
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
          where: { id: nextStrategyId, userId },
          select: { id: true },
        });
        if (!strategy) {
          throw new MonitorReferenceNotFoundError("strategy");
        }
      }
      if (nextStockListId !== current.stockListId) {
        const stockList = await tx.stockList.findFirst({
          where: { id: nextStockListId, userId },
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
        resolvedSignals = (
          await tx.monitorSignal.updateMany({
            where: { monitorId, resolvedAt: null },
            data: { resolvedAt: now },
          })
        ).count;
        clearedStates = (
          await tx.monitorSignalState.deleteMany({ where: { monitorId } })
        ).count;
      }

      const row = await tx.monitor.update({
        where: { id: monitorId },
        data: {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          strategyId: nextStrategyId,
          stockListId: nextStockListId,
          ...(rebound
            ? { configVersion: { increment: 1 }, lastScanAt: null }
            : {}),
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
    return summaryOf(outcome.row);
  }

  /** Re-reads the caller's own Monitor, or reports it missing if it vanished underneath. */
  private async readOwnMonitor(
    userId: string,
    monitorId: string,
  ): Promise<MonitorRow> {
    const row = await this.prisma.monitor.findFirst({
      where: { id: monitorId, userId },
      include: MONITOR_INCLUDE,
    });
    if (!row) {
      // Deleted between the update and this read; to the caller it no longer exists.
      throw new MonitorNotFoundError();
    }
    return row;
  }

  async deleteMonitor(userId: string, monitorId: string): Promise<void> {
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
      },
      levelKind: row.levelKind,
      levelId: row.levelId,
      kind: row.hasTrigger ? ("TRIGGER" as const) : ("CONDITION" as const),
      observationDate: row.observationDate.toISOString().slice(0, 10),
      observationPrice: Number(row.observationPrice),
      detectedAt: row.detectedAt.toISOString(),
      ...(row.resolvedAt === null
        ? {}
        : { resolvedAt: row.resolvedAt.toISOString() }),
    }));
  }
}
