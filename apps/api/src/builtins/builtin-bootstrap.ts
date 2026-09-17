import { normalizeStrategyDefinition } from "@intrinsic/contracts";
import type { Prisma, PrismaClient } from "@intrinsic/database";
import {
  SUPPORTED_EXCHANGE_CODES,
  normalizeBuyWindowConfiguration,
} from "@intrinsic/domain";
import { crossMonitorConfigurationBoundary } from "../monitors/monitor-configuration-boundary";
import {
  appendStrategyVersionIfChanged,
  definitionHashOf,
} from "../strategies/strategy-versions";
import {
  BUILT_IN_LISTS,
  BUILT_IN_MONITORS,
  BUILT_IN_STRATEGIES,
  memberWindows,
  type BuiltInList,
  type BuiltInMonitor,
  type BuiltInStrategy,
} from "./builtin-catalog";

/**
 * Built-in content bootstrap (`docs/decisions/builtin-dashboard-signals-v1.md` section 7).
 *
 * - `create-missing` — the normal deploy step. Creates any built-in whose `systemKey` does not
 *   exist yet and leaves every existing one exactly as an administrator last left it.
 * - `reset` — an explicit development/restore command. Brings every built-in back to the canonical
 *   catalog: names, descriptions, members and windows, the Strategy definition (appending a
 *   version, as any edit does) and the Monitor binding (as a rebind, with its boundary semantics).
 *
 * Identity is `systemKey`, never a display name. Membership resolves existing canonical `Security`
 * rows only; a missing one fails the whole bootstrap before anything is written.
 *
 * Monitor state is not written here. The worker's reconstruction mode establishes each built-in
 * Monitor's lifecycle from closed history on its first cycle (`pnpm monitors:scan-once` runs one
 * immediately), through the same evaluator and reducer every live cycle uses.
 */

export type BuiltInBootstrapMode = "create-missing" | "reset";

export type BuiltInBootstrapAction = "created" | "reset" | "unchanged";

export type BuiltInBootstrapReport = {
  lists: Record<string, BuiltInBootstrapAction>;
  strategies: Record<string, BuiltInBootstrapAction>;
  monitors: Record<string, BuiltInBootstrapAction>;
};

export class BuiltInSecuritiesMissingError extends Error {
  constructor(readonly symbols: readonly string[]) {
    super(
      `Built-in lists need securities that are not in the catalog: ${symbols.join(", ")}. ` +
        "Run the security catalog synchronization first (POST /admin/securities/sync as an administrator), then bootstrap again.",
    );
    this.name = "BuiltInSecuritiesMissingError";
  }
}

export class BuiltInSecuritiesAmbiguousError extends Error {
  constructor(readonly symbols: readonly string[]) {
    super(
      `Built-in lists name symbols listed on more than one supported exchange: ${symbols.join(", ")}.`,
    );
    this.name = "BuiltInSecuritiesAmbiguousError";
  }
}

export type BuiltInCatalog = {
  lists: readonly BuiltInList[];
  strategies: readonly BuiltInStrategy[];
  monitors: readonly BuiltInMonitor[];
};

export const CANONICAL_BUILT_IN_CATALOG: BuiltInCatalog = {
  lists: BUILT_IN_LISTS,
  strategies: BUILT_IN_STRATEGIES,
  monitors: BUILT_IN_MONITORS,
};

export async function bootstrapBuiltIns(
  prisma: PrismaClient,
  mode: BuiltInBootstrapMode,
  catalog: BuiltInCatalog = CANONICAL_BUILT_IN_CATALOG,
  now: () => Date = () => new Date(),
): Promise<BuiltInBootstrapReport> {
  const securityIds = await resolveSecurities(prisma, catalog.lists);

  return prisma.$transaction(
    async (tx) => {
      const report: BuiltInBootstrapReport = {
        lists: {},
        strategies: {},
        monitors: {},
      };
      const listIds = new Map<string, string>();
      const strategyIds = new Map<string, string>();

      for (const list of catalog.lists) {
        const { id, action } = await upsertList(tx, list, securityIds, mode);
        listIds.set(list.systemKey, id);
        report.lists[list.systemKey] = action;
      }
      for (const strategy of catalog.strategies) {
        const { id, action } = await upsertStrategy(tx, strategy, mode);
        strategyIds.set(strategy.systemKey, id);
        report.strategies[strategy.systemKey] = action;
      }
      for (const monitor of catalog.monitors) {
        const stockListId = listIds.get(monitor.listKey);
        const strategyId = strategyIds.get(monitor.strategyKey);
        if (!stockListId || !strategyId) {
          throw new Error(
            `Built-in monitor ${monitor.systemKey} references an unknown list or strategy key`,
          );
        }
        report.monitors[monitor.systemKey] = await upsertMonitor(
          tx,
          monitor,
          { stockListId, strategyId },
          mode,
          now(),
        );
      }
      return report;
    },
    { timeout: 60_000 },
  );
}

/** Resolves every member symbol to exactly one canonical catalog row on a supported exchange. */
async function resolveSecurities(
  prisma: PrismaClient,
  lists: readonly BuiltInList[],
): Promise<Map<string, string>> {
  const symbols = [
    ...new Set(
      lists.flatMap((list) => list.members.map((member) => member.symbol)),
    ),
  ].sort();
  const rows = await prisma.security.findMany({
    where: {
      symbol: { in: symbols },
      exchangeCode: { in: [...SUPPORTED_EXCHANGE_CODES] },
    },
    select: { id: true, symbol: true },
  });
  const bySymbol = new Map<string, string[]>();
  for (const row of rows) {
    bySymbol.set(row.symbol, [...(bySymbol.get(row.symbol) ?? []), row.id]);
  }
  const missing = symbols.filter((symbol) => !bySymbol.has(symbol));
  if (missing.length > 0) {
    throw new BuiltInSecuritiesMissingError(missing);
  }
  const ambiguous = symbols.filter(
    (symbol) => (bySymbol.get(symbol)?.length ?? 0) > 1,
  );
  if (ambiguous.length > 0) {
    throw new BuiltInSecuritiesAmbiguousError(ambiguous);
  }
  return new Map(symbols.map((symbol) => [symbol, bySymbol.get(symbol)![0]!]));
}

async function upsertList(
  tx: Prisma.TransactionClient,
  list: BuiltInList,
  securityIds: Map<string, string>,
  mode: BuiltInBootstrapMode,
): Promise<{ id: string; action: BuiltInBootstrapAction }> {
  const existing = await tx.stockList.findUnique({
    where: { systemKey: list.systemKey },
    select: { id: true },
  });
  if (existing && mode === "create-missing") {
    return { id: existing.id, action: "unchanged" };
  }

  const stockListId = existing
    ? (
        await tx.stockList.update({
          where: { id: existing.id },
          data: {
            name: list.name,
            description: list.description,
            displayOrder: list.displayOrder,
            updatedByUserId: null,
          },
          select: { id: true },
        })
      ).id
    : (
        await tx.stockList.create({
          data: {
            ownership: "SYSTEM",
            systemKey: list.systemKey,
            name: list.name,
            description: list.description,
            displayOrder: list.displayOrder,
          },
          select: { id: true },
        })
      ).id;

  const wanted = new Set(
    list.members.map((member) => securityIds.get(member.symbol)!),
  );
  if (existing) {
    // A reset restores the canonical membership: anything an administrator added goes.
    await tx.stockListItem.deleteMany({
      where: { stockListId, securityId: { notIn: [...wanted] } },
    });
  }
  for (const member of list.members) {
    const securityId = securityIds.get(member.symbol)!;
    const windows = normalizeBuyWindowConfiguration(memberWindows(member));
    const item = await tx.stockListItem.upsert({
      where: { stockListId_securityId: { stockListId, securityId } },
      create: { stockListId, securityId, buyWindowMode: windows.mode },
      update: { buyWindowMode: windows.mode },
      select: { id: true },
    });
    await tx.stockListBuyWindow.deleteMany({
      where: { stockListItemId: item.id },
    });
    if (windows.ranges.length > 0) {
      await tx.stockListBuyWindow.createMany({
        data: windows.ranges.map((range) => ({
          stockListItemId: item.id,
          startDate: new Date(`${range.startDate}T00:00:00.000Z`),
          endDate: range.endDate
            ? new Date(`${range.endDate}T00:00:00.000Z`)
            : null,
        })),
      });
    }
  }
  return { id: stockListId, action: existing ? "reset" : "created" };
}

async function upsertStrategy(
  tx: Prisma.TransactionClient,
  strategy: BuiltInStrategy,
  mode: BuiltInBootstrapMode,
): Promise<{ id: string; action: BuiltInBootstrapAction }> {
  const definition = normalizeStrategyDefinition(strategy.definition);
  const existing = await tx.strategy.findUnique({
    where: { systemKey: strategy.systemKey },
    select: { id: true },
  });
  if (existing && mode === "create-missing") {
    return { id: existing.id, action: "unchanged" };
  }
  if (!existing) {
    const created = await tx.strategy.create({
      data: {
        ownership: "SYSTEM",
        systemKey: strategy.systemKey,
        name: strategy.name,
        description: strategy.description,
        displayOrder: strategy.displayOrder,
        versions: {
          create: {
            versionNumber: 1,
            definition: definition as unknown as Prisma.InputJsonValue,
            definitionHash: definitionHashOf(definition),
          },
        },
      },
      select: { id: true },
    });
    return { id: created.id, action: "created" };
  }
  await tx.$queryRaw`SELECT "id" FROM "Strategy" WHERE "id" = ${existing.id} FOR UPDATE`;
  // Versioned exactly like any edit: a restored definition is a new version, never a rewrite.
  await appendStrategyVersionIfChanged(tx, existing.id, definition);
  await tx.strategy.update({
    where: { id: existing.id },
    data: {
      name: strategy.name,
      description: strategy.description,
      displayOrder: strategy.displayOrder,
      updatedByUserId: null,
    },
  });
  return { id: existing.id, action: "reset" };
}

async function upsertMonitor(
  tx: Prisma.TransactionClient,
  monitor: BuiltInMonitor,
  binding: { stockListId: string; strategyId: string },
  mode: BuiltInBootstrapMode,
  now: Date,
): Promise<BuiltInBootstrapAction> {
  const existing = await tx.monitor.findUnique({
    where: { systemKey: monitor.systemKey },
    select: { id: true },
  });
  if (existing && mode === "create-missing") {
    return "unchanged";
  }
  if (!existing) {
    await tx.monitor.create({
      data: {
        ownership: "SYSTEM",
        systemKey: monitor.systemKey,
        name: monitor.name,
        displayOrder: monitor.displayOrder,
        strategyId: binding.strategyId,
        stockListId: binding.stockListId,
        isPublished: true,
        isGloballyEnabled: true,
      },
    });
    return "created";
  }

  const [current] = await tx.$queryRaw<
    { strategyId: string; stockListId: string }[]
  >`
    SELECT "strategyId", "stockListId" FROM "Monitor" WHERE "id" = ${existing.id} FOR UPDATE
  `;
  const rebound =
    current !== undefined &&
    (current.strategyId !== binding.strategyId ||
      current.stockListId !== binding.stockListId);
  if (rebound) {
    await crossMonitorConfigurationBoundary(tx, existing.id, now);
  }
  await tx.monitor.update({
    where: { id: existing.id },
    data: {
      name: monitor.name,
      displayOrder: monitor.displayOrder,
      isPublished: true,
      isGloballyEnabled: true,
      updatedByUserId: null,
      strategyId: binding.strategyId,
      stockListId: binding.stockListId,
      ...(rebound ? { configVersion: { increment: 1 }, lastScanAt: null } : {}),
    },
  });
  return "reset";
}
