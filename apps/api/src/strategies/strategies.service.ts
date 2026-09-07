import { createHash } from "node:crypto";
import {
  emptyStrategyDefinition,
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  type StrategyDefinition,
  type StrategyDetailResponse,
  type StrategySummaryResponse,
} from "@intrinsic/contracts";
import type { Prisma } from "@intrinsic/database";
import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
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
    userId: string,
    input: { name: string; description: string | null; definition?: unknown },
  ): Promise<StrategyDetailResponse> {
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

  async deleteStrategy(userId: string, strategyId: string): Promise<void> {
    const deleted = await this.prisma.strategy.deleteMany({
      where: { id: strategyId, userId },
    });
    if (deleted.count === 0) {
      throw new StrategyNotFoundError();
    }
    this.logger.info({
      event: "strategy.deleted",
      actorUserId: userId,
      strategyId,
    });
  }
}
