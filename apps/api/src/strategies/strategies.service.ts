import { createHash } from "node:crypto";
import {
  emptyStrategyDefinition,
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  type StrategyDefinition,
  type AuthUser,
  type StrategyDetailResponse,
  type StrategySummaryResponse,
} from "@intrinsic/contracts";
import type { Prisma } from "@intrinsic/database";
import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { STRATEGIES_LOGGER } from "./strategies.tokens";
import type { ParsedUpdateStrategyRequest } from "./strategy-requests";

/**
 * Raised for a strategy that does not exist *or* is not owned by the caller. The two cases are
 * deliberately indistinguishable, so knowing another user's strategy id reveals nothing. There is
 * no ADMIN bypass, matching the stock-list slice.
 */
export class StrategyNotFoundError extends Error {
  constructor() {
    super("Strategy was not found");
    this.name = "StrategyNotFoundError";
  }
}

/**
 * Raised when a strategy cannot be deleted because a Monitor is still watching with it.
 *
 * Deleting it would take that Monitor and every Signal it ever produced with it, silently. Signal
 * history is a record of what was observed, so the deletion is refused and the user removes the
 * Monitor first — see `ai/product/monitors.md`.
 */
export class StrategyInUseByMonitorError extends Error {
  constructor(readonly monitorCount: number) {
    super(
      // The count is read after the constraint refused, so a Monitor deleted in between would
      // make it zero. Singular is the fallback rather than a literal "0 monitors".
      monitorCount > 1
        ? `This strategy is used by ${monitorCount} monitors. Delete them first.`
        : "This strategy is used by a monitor. Delete the monitor first.",
    );
    this.name = "StrategyInUseByMonitorError";
  }
}

/** Reads only the current version: the highest `versionNumber` for the strategy. */
const CURRENT_VERSION = {
  orderBy: { versionNumber: "desc" as const },
  take: 1,
} satisfies Prisma.Strategy$versionsArgs;

const STRATEGY_INCLUDE = {
  versions: CURRENT_VERSION,
} satisfies Prisma.StrategyInclude;

type StrategyRow = Prisma.StrategyGetPayload<{
  include: typeof STRATEGY_INCLUDE;
}>;

/** Strategies render newest-changed first; ids break same-tick ties. */
const STRATEGY_ORDER = [
  { updatedAt: "desc" as const },
  { id: "desc" as const },
];

/**
 * A referencing row blocked this delete. Matched by Prisma's stable error code, never by message.
 */
function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2003"
  );
}

function definitionHashOf(definition: StrategyDefinition): string {
  return createHash("sha256")
    .update(strategyDefinitionFingerprint(definition))
    .digest("hex");
}

/**
 * Parses a persisted document back through the canonical normalizer.
 *
 * A drifted or hand-edited row therefore fails loudly here rather than reaching the Builder as a
 * definition no UI control can represent. Every strategy is created with a version, so the
 * fallback is defensive only.
 */
function readDefinition(row: StrategyRow): StrategyDefinition {
  const version = row.versions[0];
  return version
    ? normalizeStrategyDefinition(version.definition)
    : emptyStrategyDefinition();
}

function summaryOf(
  row: StrategyRow,
  definition: StrategyDefinition,
): StrategySummaryResponse {
  return {
    id: row.id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    buyLevelCount: definition.buyLevels.length,
    sellLevelCount: definition.sellLevels.length,
    hasFinalExit: definition.finalExit !== undefined,
    versionNumber: row.versions[0]?.versionNumber ?? 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function detailOf(row: StrategyRow): StrategyDetailResponse {
  const definition = readDefinition(row);
  return { ...summaryOf(row, definition), definition };
}

@Injectable()
export class StrategiesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EntitlementsService)
    private readonly entitlements: EntitlementsService,
    @Inject(STRATEGIES_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  async listForUser(userId: string): Promise<StrategySummaryResponse[]> {
    const rows = await this.prisma.strategy.findMany({
      where: { userId },
      orderBy: STRATEGY_ORDER,
      include: STRATEGY_INCLUDE,
    });
    return rows.map((row) => summaryOf(row, readDefinition(row)));
  }

  /**
   * Creates a strategy and its first version in one statement.
   *
   * An omitted definition is validated exactly like a submitted empty one, so it is rejected for
   * having no BUY level. That is deliberate: a strategy with no BUY level can never buy anything
   * and is not saveable, so there is no name-only strategy to create and no persisted definition
   * that fails to normalize on the way back out.
   */
  async createStrategy(
    user: AuthUser,
    input: { name: string; description: string | null; definition?: unknown },
  ): Promise<StrategyDetailResponse> {
    // The only entitlement question a Strategy has. There is deliberately no quota on how many a
    // user may save, and deliberately no check on *what the definition contains*: every
    // authenticated plan has every indicator, condition, trigger, calculated series and
    // intrinsic-value primitive. Monetization is product capacity, never analytical primitives —
    // adding a per-primitive check here would be the exact paywall the decision document forbids.
    this.entitlements.assertCanCreateCustomStrategy(user);
    const userId = user.id;
    const definition = normalizeStrategyDefinition(
      input.definition ?? emptyStrategyDefinition(),
    );

    const row = await this.prisma.strategy.create({
      data: {
        userId,
        name: input.name,
        description: input.description,
        versions: {
          create: {
            versionNumber: 1,
            definition: definition as unknown as Prisma.InputJsonValue,
            definitionHash: definitionHashOf(definition),
          },
        },
      },
      include: STRATEGY_INCLUDE,
    });

    this.logger.info({
      event: "strategy.created",
      actorUserId: userId,
      strategyId: row.id,
      buyLevelCount: definition.buyLevels.length,
      sellLevelCount: definition.sellLevels.length,
    });
    return detailOf(row);
  }

  async getStrategy(
    userId: string,
    strategyId: string,
  ): Promise<StrategyDetailResponse> {
    const row = await this.prisma.strategy.findFirst({
      where: { id: strategyId, userId },
      include: STRATEGY_INCLUDE,
    });
    if (!row) {
      throw new StrategyNotFoundError();
    }
    return detailOf(row);
  }

  /** Name and description live on the strategy identity and never create a version. */
  async updateStrategy(
    userId: string,
    strategyId: string,
    patch: ParsedUpdateStrategyRequest,
  ): Promise<StrategySummaryResponse> {
    // `updateMany` applies the ownership filter and the write in one atomic statement.
    const updated = await this.prisma.strategy.updateMany({
      where: { id: strategyId, userId },
      data: {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined
          ? {}
          : { description: patch.description }),
      },
    });
    if (updated.count === 0) {
      throw new StrategyNotFoundError();
    }

    const row = await this.prisma.strategy.findFirst({
      where: { id: strategyId, userId },
      include: STRATEGY_INCLUDE,
    });
    if (!row) {
      // Deleted between the update and this read; to the caller it no longer exists.
      throw new StrategyNotFoundError();
    }
    this.logger.info({
      event: "strategy.updated",
      actorUserId: userId,
      strategyId,
    });
    return summaryOf(row, readDefinition(row));
  }

  /**
   * Replaces the complete definition, appending a version only when the logic actually changed.
   *
   * The comparison is over the id-stripped fingerprint, so re-keying rows in the Builder never
   * churns the history while genuine reordering does. Existing version rows are never updated.
   */
  async replaceDefinition(
    userId: string,
    strategyId: string,
    submitted: unknown,
  ): Promise<StrategyDetailResponse> {
    const definition = normalizeStrategyDefinition(submitted);
    const hash = definitionHashOf(definition);

    const row = await this.prisma.$transaction(async (tx) => {
      // Serializes concurrent replacements of one strategy. The next version number is read and
      // then written, so without a row lock two edits landing together both read the same current
      // version, both compute the same next number, and the loser surfaces the unique
      // `(strategyId, versionNumber)` constraint as a failed request instead of appending its own
      // version behind the winner. Ownership is part of the lock predicate, so a strategy the
      // caller does not own locks nothing and reads as missing, exactly like the read below.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "Strategy"
        WHERE "id" = ${strategyId} AND "userId" = ${userId}
        FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new StrategyNotFoundError();
      }
      const existing = await tx.strategy.findFirst({
        where: { id: strategyId, userId },
        include: STRATEGY_INCLUDE,
      });
      if (!existing) {
        throw new StrategyNotFoundError();
      }
      const current = existing.versions[0];
      if (current?.definitionHash === hash) {
        return existing;
      }
      await tx.strategyVersion.create({
        data: {
          strategyId,
          versionNumber: (current?.versionNumber ?? 0) + 1,
          definition: definition as unknown as Prisma.InputJsonValue,
          definitionHash: hash,
        },
      });
      return tx.strategy.update({
        where: { id: strategyId },
        // Touch the strategy so the collection's newest-changed ordering reflects the edit.
        data: { updatedAt: new Date() },
        include: STRATEGY_INCLUDE,
      });
    });

    this.logger.info({
      event: "strategy.definition-replaced",
      actorUserId: userId,
      strategyId,
      versionNumber: row.versions[0]?.versionNumber ?? 0,
    });
    return detailOf(row);
  }

  /**
   * Deletes a strategy the caller owns, unless a Monitor is still watching with it.
   *
   * The database refuses that case (`Monitor.strategyId` is `onDelete: Restrict`), so the guard is
   * the constraint rather than a check that could race a Monitor created a moment later. The count
   * is read only on the error path, to say how many.
   */
  async deleteStrategy(userId: string, strategyId: string): Promise<void> {
    try {
      const deleted = await this.prisma.strategy.deleteMany({
        where: { id: strategyId, userId },
      });
      if (deleted.count === 0) {
        throw new StrategyNotFoundError();
      }
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new StrategyInUseByMonitorError(
          await this.prisma.monitor.count({ where: { strategyId, userId } }),
        );
      }
      throw error;
    }
    this.logger.info({
      event: "strategy.deleted",
      actorUserId: userId,
      strategyId,
    });
  }
}
