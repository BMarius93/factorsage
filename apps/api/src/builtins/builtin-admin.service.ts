import type { BuiltInContentAdminResponse } from "@intrinsic/contracts";
import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

/**
 * The administrator's view of every built-in, published or not: what exists, who last changed it,
 * and — for Monitors — whether it is published, running, and how much it currently reports.
 * Editing goes through the ordinary List, Strategy and Monitor routes and editors.
 */
@Injectable()
export class BuiltInAdminService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async overview(): Promise<BuiltInContentAdminResponse> {
    const order = [
      { displayOrder: { sort: "asc" as const, nulls: "last" as const } },
      { name: "asc" as const },
    ];
    const [lists, strategies, monitors, states] = await Promise.all([
      this.prisma.stockList.findMany({
        where: { ownership: "SYSTEM" },
        orderBy: order,
        include: {
          _count: { select: { items: true } },
          updatedBy: { select: { email: true } },
        },
      }),
      this.prisma.strategy.findMany({
        where: { ownership: "SYSTEM" },
        orderBy: order,
        include: {
          versions: {
            orderBy: { versionNumber: "desc" },
            take: 1,
            select: { versionNumber: true },
          },
          updatedBy: { select: { email: true } },
        },
      }),
      this.prisma.monitor.findMany({
        where: { ownership: "SYSTEM" },
        orderBy: order,
        include: {
          strategy: { select: { name: true } },
          stockList: { select: { name: true } },
          updatedBy: { select: { email: true } },
        },
      }),
      this.prisma.monitorSignalState.groupBy({
        by: ["monitorId", "lifecycleState"],
        where: {
          monitor: { ownership: "SYSTEM" },
          lifecycleState: { in: ["ACTIVE", "PENDING_TRIGGER"] },
        },
        _count: { _all: true },
      }),
    ]);

    const common = (row: {
      id: string;
      systemKey: string | null;
      name: string;
      displayOrder: number | null;
      updatedAt: Date;
      updatedBy: { email: string } | null;
    }) => ({
      id: row.id,
      systemKey: row.systemKey ?? "",
      name: row.name,
      ...(row.displayOrder === null ? {} : { displayOrder: row.displayOrder }),
      updatedAt: row.updatedAt.toISOString(),
      ...(row.updatedBy ? { updatedByEmail: row.updatedBy.email } : {}),
    });
    const countOf = (monitorId: string, state: "ACTIVE" | "PENDING_TRIGGER") =>
      states.find(
        (entry) =>
          entry.monitorId === monitorId && entry.lifecycleState === state,
      )?._count._all ?? 0;

    return {
      lists: lists.map((row) => ({
        ...common(row),
        itemCount: row._count.items,
      })),
      strategies: strategies.map((row) => ({
        ...common(row),
        versionNumber: row.versions[0]?.versionNumber ?? 0,
      })),
      monitors: monitors.map((row) => ({
        ...common(row),
        isPublished: row.isPublished,
        isGloballyEnabled: row.isGloballyEnabled,
        strategyId: row.strategyId,
        strategyName: row.strategy.name,
        stockListId: row.stockListId,
        stockListName: row.stockList.name,
        ...(row.lastScanAt ? { lastScanAt: row.lastScanAt.toISOString() } : {}),
        activeCount: countOf(row.id, "ACTIVE"),
        pendingCount: countOf(row.id, "PENDING_TRIGGER"),
      })),
    };
  }
}
