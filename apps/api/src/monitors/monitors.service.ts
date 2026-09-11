import type {
  MonitorDetailResponse,
  MonitorSignalResponse,
  MonitorSummaryResponse,
} from "@intrinsic/contracts";
import type { Prisma } from "@intrinsic/database";
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
    return { ...summaryOf(row), signals: [] };
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
    return { ...summaryOf(row), signals: await this.listSignals(monitorId) };
  }

  /**
   * Updates the Monitor's name or whether it is enabled. Those are the only two things a user
   * controls; there is deliberately no cadence to update.
   *
   * Disabling stops future evaluations and nothing else. The persisted transition state is
   * **kept**, so re-enabling resumes with the trigger semantics intact rather than treating every
   * already-matched condition as newly matched — which `ai/product/monitors.md` requires.
   */
  async updateMonitor(
    userId: string,
    monitorId: string,
    patch: ParsedUpdateMonitorRequest,
  ): Promise<MonitorSummaryResponse> {
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

    const row = await this.prisma.monitor.findFirst({
      where: { id: monitorId, userId },
      include: MONITOR_INCLUDE,
    });
    if (!row) {
      // Deleted between the update and this read; to the caller it no longer exists.
      throw new MonitorNotFoundError();
    }
    this.logger.info({
      event: "monitor.updated",
      actorUserId: userId,
      monitorId,
      enabled: row.enabled,
    });
    return summaryOf(row);
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
