import { randomUUID } from "node:crypto";
import {
  ACTOR_SCOPE_MAX_ACTORS,
  actorScopeActorIds,
  alternativeDataScope,
  collectActorGroupIds,
  collectActorIds,
  collectAlternativeDataMetrics,
  embedActorGroupScopes,
  emptyStrategyDefinition,
  normalizeStrategyDefinition,
  rekeyStrategyDefinition,
  strategyMetricLabel,
  StrategyValidationError,
  type StrategyDefinition,
  type AuthUser,
  type StrategyDetailResponse,
  type StrategySummaryResponse,
  type StrategyValidationIssue,
} from "@intrinsic/contracts";
import type { Prisma } from "@intrinsic/database";
import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable } from "@nestjs/common";
import {
  SYSTEM_FIRST_ORDER,
  assertMutable,
  auditOf,
  mutableWhere,
  ownershipResponse,
  readableWhere,
  SystemContentProtectedError,
  type ContentViewer,
} from "../builtins/content-access";
import { PrismaService } from "../database/prisma.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { STRATEGIES_LOGGER } from "./strategies.tokens";
import type { ParsedUpdateStrategyRequest } from "./strategy-requests";
import {
  appendStrategyVersionIfChanged,
  definitionHashOf,
} from "./strategy-versions";

/**
 * Raised for a strategy that does not exist *or* belongs to another customer. The two cases are
 * deliberately indistinguishable, so knowing another user's strategy id reveals nothing. There is
 * no ADMIN bypass of customer content; built-ins are readable by everyone.
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
  viewer: ContentViewer,
): StrategySummaryResponse {
  return {
    ...ownershipResponse(row, viewer),
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

function detailOf(
  row: StrategyRow,
  viewer: ContentViewer,
): StrategyDetailResponse {
  const definition = readDefinition(row);
  return { ...summaryOf(row, definition, viewer), definition };
}

@Injectable()
export class StrategiesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EntitlementsService)
    private readonly entitlements: EntitlementsService,
    @Inject(STRATEGIES_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  /** Built-ins first, in operator order, then the caller's own. A Guest sees built-ins only. */
  async listForUser(viewer: ContentViewer): Promise<StrategySummaryResponse[]> {
    const rows = await this.prisma.strategy.findMany({
      where: readableWhere(viewer),
      orderBy: [...SYSTEM_FIRST_ORDER, ...STRATEGY_ORDER],
      include: STRATEGY_INCLUDE,
    });
    return rows.map((row) => summaryOf(row, readDefinition(row), viewer));
  }

  /**
   * What a definition must satisfy to be **written**, beyond being well-formed.
   *
   * The canonical validator in `@intrinsic/contracts` is pure, so it can check that a scope is
   * well-formed but never that the members it names are real — exactly as it can check a `Value`
   * but not whether a `Security` exists. This is that second half, and it lives at the write
   * boundary for the same reason `assertSecuritiesSupported` does. Two rules:
   *
   * 1. **Every selected member exists in the actor catalog.** The catalog is platform reference
   *    data with no owner, so there is nothing to be "accessible" beyond existing in it.
   * 2. **No Congress group.** Groups left the product on 2026-10-11. A stored version naming one
   *    still reads and still executes, which is why the validator itself keeps accepting the
   *    shape — but nothing may write another, whether typed into a request or carried over from
   *    the version being edited. The Builder's configuration dialog offers the group's members as
   *    a selection, so the way forward is one Apply rather than a dead end. A copy never reaches
   *    this rule with a group: `duplicateStrategy` has already turned it into a selection.
   *
   * Reported as an invalid strategy with the canonical `SCOPE_INVALID` code and a path, so the
   * Builder renders it as a validation issue rather than as a failed request.
   */
  private async assertScopesWritable(
    definition: StrategyDefinition,
  ): Promise<void> {
    const metrics = collectAlternativeDataMetrics(definition);
    const actorIds = collectActorIds(metrics);
    const known = new Set(
      actorIds.length === 0
        ? []
        : (
            await this.prisma.alternativeDataActor.findMany({
              where: { id: { in: actorIds } },
              select: { id: true },
            })
          ).map((actor) => actor.id),
    );

    const issues: StrategyValidationIssue[] = [];
    for (const metric of metrics) {
      const scope = alternativeDataScope(metric);
      if (!scope || scope.kind === "ANY") {
        continue;
      }
      if (scope.kind === "GROUP") {
        issues.push({
          code: "SCOPE_INVALID",
          path: { part: "STRATEGY" },
          message: `${strategyMetricLabel(metric)} uses a Congress group, and groups are no longer supported. Open its configuration and choose the members it counts.`,
        });
        continue;
      }
      const missing = (actorScopeActorIds(scope) ?? []).filter(
        (actorId) => !known.has(actorId),
      );
      if (missing.length > 0) {
        issues.push({
          code: "SCOPE_INVALID",
          path: { part: "STRATEGY" },
          message:
            missing.length === 1
              ? `${strategyMetricLabel(metric)} selects a member of Congress who is not available.`
              : `${strategyMetricLabel(metric)} selects ${missing.length} members of Congress who are not available.`,
        });
      }
    }
    if (issues.length > 0) {
      throw new StrategyValidationError(issues);
    }
  }

  /** The Strategy a viewer asked to change: 404 when unreadable, 403 when a read-only built-in. */
  private async findMutable(
    db: Pick<PrismaService, "strategy">,
    viewer: AuthUser,
    strategyId: string,
  ) {
    const row = await db.strategy.findFirst({
      where: { id: strategyId, ...readableWhere(viewer) },
      select: { id: true, ownership: true, userId: true, systemKey: true },
    });
    const strategy = assertMutable(row, viewer, "strategies");
    if (!strategy) {
      throw new StrategyNotFoundError();
    }
    return strategy;
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
    await this.assertScopesWritable(definition);

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
    return detailOf(row, user);
  }

  /**
   * Copies a strategy the caller can read — their own, or a built-in — into a new one they own.
   *
   * The copy holds the description and the **current** definition, as its own version 1; the
   * source's earlier versions are the source's history and stay with it. Every level, Exit Rule,
   * condition and trigger is re-keyed (`rekeyStrategyDefinition`): a level id is the identity a
   * Monitor's durable state is keyed by, so a copy that kept them would be the same strategy under
   * a second name rather than a new one. The logic is untouched, which is why the copy's
   * `definitionHash` equals the source's.
   *
   * **One exception, for a source saved before 2026-10-11 that still names a Congress group.** A
   * copy is a new strategy, and nothing new may name a group, so the copy's rule selects the
   * members the group holds at this moment instead (`embedLegacyGroups`). It counts exactly the
   * disclosures the source's rule counts today; its hash differs because the rule now says who
   * rather than which group, and it no longer follows the group afterwards. The source is not
   * converted — it is only read. A group that cannot be resolved refuses the copy, with the reason,
   * rather than producing a rule that counts nobody.
   *
   * Ownership is the caller's alone — no `SYSTEM` ownership, `systemKey`, display order or audit
   * column is carried over — and the source is only read. The strategy and its first version are
   * one nested write, so the copy exists whole or not at all.
   */
  async duplicateStrategy(
    user: AuthUser,
    strategyId: string,
    input: { name: string },
  ): Promise<StrategyDetailResponse> {
    // A copy is a new custom strategy, so it asks exactly what `createStrategy` asks.
    this.entitlements.assertCanCreateCustomStrategy(user);
    const userId = user.id;
    // Another customer's strategy reads as missing, exactly as it does on every other route.
    const source = await this.prisma.strategy.findFirst({
      where: { id: strategyId, ...readableWhere(user) },
      include: STRATEGY_INCLUDE,
    });
    if (!source) {
      throw new StrategyNotFoundError();
    }
    const rekeyed = normalizeStrategyDefinition(
      rekeyStrategyDefinition(readDefinition(source), randomUUID),
    );
    // The one thing a copy can carry that a fresh strategy cannot is a legacy Congress group, from
    // a source saved before groups left. Copying the reference would mint a new dependency on
    // something the product no longer has, so the copy holds the group's members instead.
    const { definition, embeddedGroups } = await this.embedLegacyGroups(
      user,
      rekeyed,
    );
    // And then a copy is a write like any other.
    await this.assertScopesWritable(definition);

    const row = await this.prisma.strategy.create({
      data: {
        userId,
        name: input.name,
        description: source.description,
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
      event: "strategy.duplicated",
      actorUserId: userId,
      strategyId: row.id,
      sourceStrategyId: strategyId,
      sourceOwnership: source.ownership,
      sourceVersionNumber: source.versions[0]?.versionNumber ?? 0,
      ...(embeddedGroups > 0 ? { embeddedGroups } : {}),
    });
    return detailOf(row, user);
  }

  /**
   * A definition with every legacy Congress group replaced by a selection of that group's members,
   * for a copy.
   *
   * The membership is read the way a backtest submission reads it when it freezes a group: only a
   * group the caller can read — a built-in one, or their own — so a copy can never embed somebody
   * else's selection. It never guesses. A group that is gone or not the caller's, a group with no
   * members, and a result the validator refuses are each a refusal with the reason, reported as an
   * invalid strategy so the client shows it as one: an empty selection is not a rule, and a copy
   * that silently counted nobody would be a different strategy from the one that was copied.
   */
  private async embedLegacyGroups(
    viewer: AuthUser,
    definition: StrategyDefinition,
  ): Promise<{ definition: StrategyDefinition; embeddedGroups: number }> {
    const groupIds = collectActorGroupIds(
      collectAlternativeDataMetrics(definition),
    );
    if (groupIds.length === 0) {
      return { definition, embeddedGroups: 0 };
    }
    const groups = await this.prisma.actorGroup.findMany({
      where: { id: { in: groupIds }, ...readableWhere(viewer) },
      select: {
        id: true,
        name: true,
        members: { orderBy: { createdAt: "asc" }, select: { actorId: true } },
      },
    });
    const byId = new Map(groups.map((group) => [group.id, group]));
    const way =
      "Open the original, choose the members that rule counts, and duplicate it then.";
    const issues: StrategyValidationIssue[] = [];
    const members = new Map<string, readonly string[]>();
    for (const groupId of groupIds) {
      const group = byId.get(groupId);
      const refusal = !group
        ? "a Congress group that is no longer available"
        : group.members.length === 0
          ? `the Congress group “${group.name}”, which has no members`
          : group.members.length > ACTOR_SCOPE_MAX_ACTORS
            ? `the Congress group “${group.name}”, which has more members than one rule can select`
            : undefined;
      if (refusal || !group) {
        issues.push({
          code: "SCOPE_INVALID",
          path: { part: "STRATEGY" },
          message: `This strategy cannot be duplicated: one of its rules counts ${refusal}. ${way}`,
        });
        continue;
      }
      members.set(
        groupId,
        group.members.map((member) => member.actorId),
      );
    }
    if (issues.length > 0) {
      throw new StrategyValidationError(issues);
    }
    return {
      definition: embedActorGroupScopes(definition, members),
      embeddedGroups: groupIds.length,
    };
  }

  async getStrategy(
    viewer: ContentViewer,
    strategyId: string,
  ): Promise<StrategyDetailResponse> {
    const row = await this.prisma.strategy.findFirst({
      where: { id: strategyId, ...readableWhere(viewer) },
      include: STRATEGY_INCLUDE,
    });
    if (!row) {
      throw new StrategyNotFoundError();
    }
    return detailOf(row, viewer);
  }

  /** Name and description live on the strategy identity and never create a version. */
  async updateStrategy(
    user: AuthUser,
    strategyId: string,
    patch: ParsedUpdateStrategyRequest,
  ): Promise<StrategySummaryResponse> {
    const userId = user.id;
    const target = await this.findMutable(this.prisma, user, strategyId);
    // `updateMany` re-applies the permission filter and the write in one atomic statement.
    const updated = await this.prisma.strategy.updateMany({
      where: { id: strategyId, ...mutableWhere(user) },
      data: {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined
          ? {}
          : { description: patch.description }),
        ...auditOf(target, user),
      },
    });
    if (updated.count === 0) {
      throw new StrategyNotFoundError();
    }

    const row = await this.prisma.strategy.findFirst({
      where: { id: strategyId, ...readableWhere(user) },
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
      ownership: row.ownership,
    });
    return summaryOf(row, readDefinition(row), user);
  }

  /**
   * Replaces the complete definition, appending a version only when the logic actually changed.
   *
   * The comparison is over the id-stripped fingerprint, so re-keying rows in the Builder never
   * churns the history while genuine reordering does. Existing version rows are never updated.
   */
  async replaceDefinition(
    user: AuthUser,
    strategyId: string,
    submitted: unknown,
  ): Promise<StrategyDetailResponse> {
    const userId = user.id;
    const definition = normalizeStrategyDefinition(submitted);
    await this.assertScopesWritable(definition);

    const { row, appended } = await this.prisma.$transaction(async (tx) => {
      const target = await this.findMutable(tx, user, strategyId);
      // Serializes concurrent replacements of one strategy — see `appendStrategyVersionIfChanged`.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Strategy" WHERE "id" = ${strategyId} FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new StrategyNotFoundError();
      }
      const appended = await appendStrategyVersionIfChanged(
        tx,
        strategyId,
        definition,
      );
      if (!appended) {
        return {
          appended,
          row: await tx.strategy.findUniqueOrThrow({
            where: { id: strategyId },
            include: STRATEGY_INCLUDE,
          }),
        };
      }
      return {
        appended,
        row: await tx.strategy.update({
          where: { id: strategyId },
          // Touch the strategy so the collection's newest-changed ordering reflects the edit.
          data: { updatedAt: new Date(), ...auditOf(target, user) },
          include: STRATEGY_INCLUDE,
        }),
      };
    });

    this.logger.info({
      event: "strategy.definition-replaced",
      actorUserId: userId,
      strategyId,
      ownership: row.ownership,
      appended,
      versionNumber: row.versions[0]?.versionNumber ?? 0,
    });
    return detailOf(row, user);
  }

  /**
   * Deletes a strategy the caller owns, unless a Monitor is still watching with it.
   *
   * The database refuses that case (`Monitor.strategyId` is `onDelete: Restrict`), so the guard is
   * the constraint rather than a check that could race a Monitor created a moment later. The count
   * is read only on the error path, to say how many.
   */
  async deleteStrategy(user: AuthUser, strategyId: string): Promise<void> {
    const userId = user.id;
    const target = await this.findMutable(this.prisma, user, strategyId);
    if (target.ownership === "SYSTEM") {
      throw new SystemContentProtectedError("strategies");
    }
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
