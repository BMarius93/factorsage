import {
  ACTOR_GROUP_MAX_MEMBERS,
  ACTOR_SEARCH_DEFAULT_LIMIT,
  ACTOR_SEARCH_MAX_LIMIT,
  ACTOR_SEARCH_MIN_TERM_LENGTH,
  type ActorGroupDetailResponse,
  type ActorGroupSummaryResponse,
  type AlternativeDataActorResponse,
  type AuthUser,
} from "@intrinsic/contracts";
import type { Prisma } from "@intrinsic/database";
import type { StructuredLogger } from "@intrinsic/observability";
import type { AlternativeDataStore } from "@intrinsic/stock-data";
import { Inject, Injectable } from "@nestjs/common";
import {
  SYSTEM_FIRST_ORDER,
  assertMutable,
  auditOf,
  ownershipResponse,
  readableWhere,
  SystemContentProtectedError,
  type ContentViewer,
} from "../builtins/content-access";
import { PrismaService } from "../database/prisma.service";
import {
  ALTERNATIVE_DATA_LOGGER,
  ALTERNATIVE_DATA_STORE_TOKEN,
} from "./alternative-data.tokens";

/**
 * Congress groups: the Lists product area's second collection.
 *
 * It follows `StockListsService` deliberately — the same ownership helpers, the same
 * indistinguishable "missing or not yours" 404, the same administrator rule for built-in content —
 * because a group is the same kind of object as a list: a reusable, user-owned, explicitly curated
 * set that a strategy references and a backtest freezes.
 *
 * Two things are deliberately **not** here. There is no plan limit: `ACTOR_GROUP_MAX_MEMBERS` is a
 * structural bound on the model, like `STRATEGY_MAX_BUY_LEVELS`, and
 * `docs/decisions/entitlements-v1.md` is the only place a commercial limit may be defined. And there
 * is no semantic or historical group — "current senators", "top hedge funds" — which
 * `docs/alternative-data-signals.md` keeps out of V1.
 */

/** Missing, or owned by someone else. Deliberately indistinguishable, administrators included. */
export class ActorGroupNotFoundError extends Error {
  constructor() {
    super("Actor group was not found");
    this.name = "ActorGroupNotFoundError";
  }
}

/** An actor id that is not in the canonical actor catalog. */
export class UnsupportedActorError extends Error {
  constructor(message = "One or more selected actors are not available") {
    super(message);
    this.name = "UnsupportedActorError";
  }
}

/** The group would exceed the structural member bound. */
export class ActorGroupFullError extends Error {
  constructor(readonly limit: number) {
    super(`A group can hold at most ${limit} actors`);
    this.name = "ActorGroupFullError";
  }
}

/**
 * A group cannot be deleted because a Strategy still references it.
 *
 * Refused for the same reason deleting a Stock List a Monitor watches is refused: the strategy would
 * silently start counting every actor instead of the curated set, changing what it means without
 * anyone editing it. The user edits the strategy first.
 */
export class ActorGroupInUseError extends Error {
  constructor(readonly strategyNames: readonly string[]) {
    super(
      strategyNames.length === 1
        ? `This group is used by the strategy "${strategyNames[0]}". Change that strategy first.`
        : `This group is used by ${strategyNames.length} strategies. Change them first.`,
    );
    this.name = "ActorGroupInUseError";
  }
}

const MEMBER_INCLUDE = {
  members: {
    orderBy: { createdAt: "asc" as const },
    include: {
      actor: true,
    },
  },
} satisfies Prisma.ActorGroupInclude;

type GroupDetailRow = Prisma.ActorGroupGetPayload<{
  include: typeof MEMBER_INCLUDE;
}>;

function actorResponse(actor: {
  id: string;
  externalId: string;
  displayName: string;
  chamber: "HOUSE" | "SENATE";
  state: string | null;
  district: string | null;
}): AlternativeDataActorResponse {
  return {
    id: actor.id,
    externalId: actor.externalId,
    displayName: actor.displayName,
    chamber: actor.chamber,
    ...(actor.state ? { state: actor.state } : {}),
    ...(actor.district ? { district: actor.district } : {}),
  };
}

function detailResponse(
  group: GroupDetailRow,
  viewer: ContentViewer,
): ActorGroupDetailResponse {
  return {
    ...ownershipResponse(group, viewer),
    id: group.id,
    name: group.name,
    ...(group.description === null ? {} : { description: group.description }),
    memberCount: group.members.length,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
    members: group.members.map((member) => actorResponse(member.actor)),
  };
}

/** One actor as every API surface reports it. */
function actorSummary(actor: {
  id: string;
  externalId: string;
  displayName: string;
  chamber: "HOUSE" | "SENATE";
  state?: string;
  district?: string;
}): AlternativeDataActorResponse {
  return {
    id: actor.id,
    externalId: actor.externalId,
    displayName: actor.displayName,
    chamber: actor.chamber,
    ...(actor.state ? { state: actor.state } : {}),
    ...(actor.district ? { district: actor.district } : {}),
  };
}

@Injectable()
export class ActorGroupsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ALTERNATIVE_DATA_STORE_TOKEN)
    private readonly actors: AlternativeDataStore,
    @Inject(ALTERNATIVE_DATA_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  /**
   * The canonical actors matching a search term.
   *
   * Readable without a session: the actor catalog is platform reference data grown by ingestion, not
   * anybody's content, and the Strategy Builder needs it to render a saved rule's scope. A blank term
   * returns the first page in name order so the picker opens on something rather than on nothing.
   */
  async searchActors(input: {
    term?: string;
    limit?: number;
  }): Promise<AlternativeDataActorResponse[]> {
    const term = input.term?.trim() ?? "";
    // A one-character term matches most of the catalog and is never what a user meant; it is treated
    // as no term rather than as an error, exactly as the stock search treats it.
    const effective = term.length >= ACTOR_SEARCH_MIN_TERM_LENGTH ? term : undefined;
    const limit = Math.min(
      Math.max(1, Math.trunc(input.limit ?? ACTOR_SEARCH_DEFAULT_LIMIT)),
      ACTOR_SEARCH_MAX_LIMIT,
    );
    const actors = await this.actors.searchActors({
      ...(effective === undefined ? {} : { term: effective }),
      limit,
    });
    return actors.map(actorSummary);
  }

  /** Actors by id, so a saved strategy's scope can be labelled without a search. */
  async findActors(
    ids: readonly string[],
  ): Promise<AlternativeDataActorResponse[]> {
    const actors = await this.actors.findActorsByIds(ids);
    return actors.map(actorSummary);
  }

  /** The groups a viewer can use: built-ins first in operator order, then their own, newest first. */
  async listForUser(
    viewer: ContentViewer,
  ): Promise<ActorGroupSummaryResponse[]> {
    const groups = await this.prisma.actorGroup.findMany({
      where: readableWhere(viewer),
      orderBy: [...SYSTEM_FIRST_ORDER, { createdAt: "desc" }, { id: "desc" }],
      include: { _count: { select: { members: true } } },
    });
    return groups.map((group) => ({
      ...ownershipResponse(group, viewer),
      id: group.id,
      name: group.name,
      ...(group.description === null ? {} : { description: group.description }),
      memberCount: group._count.members,
      createdAt: group.createdAt.toISOString(),
      updatedAt: group.updatedAt.toISOString(),
    }));
  }

  async getGroup(
    viewer: ContentViewer,
    groupId: string,
  ): Promise<ActorGroupDetailResponse> {
    const group = await this.prisma.actorGroup.findFirst({
      where: { id: groupId, ...readableWhere(viewer) },
      include: MEMBER_INCLUDE,
    });
    if (!group) {
      throw new ActorGroupNotFoundError();
    }
    return detailResponse(group, viewer);
  }

  async createGroup(
    user: AuthUser,
    input: { name: string; description?: string; actorIds: string[] },
  ): Promise<ActorGroupDetailResponse> {
    if (input.actorIds.length > ACTOR_GROUP_MAX_MEMBERS) {
      throw new ActorGroupFullError(ACTOR_GROUP_MAX_MEMBERS);
    }
    await this.assertActorsSupported(input.actorIds);
    // Members render in the order they were added, so each gets its own creation instant.
    const createdAt = Date.now();
    const group = await this.prisma.actorGroup.create({
      data: {
        userId: user.id,
        name: input.name,
        description: input.description ?? null,
        members: {
          create: input.actorIds.map((actorId, index) => ({
            actorId,
            createdAt: new Date(createdAt + index),
          })),
        },
      },
      include: MEMBER_INCLUDE,
    });
    this.logger.info({
      event: "actor-group.created",
      actorUserId: user.id,
      groupId: group.id,
      memberCount: group.members.length,
    });
    return detailResponse(group, user);
  }

  async updateGroup(
    user: AuthUser,
    groupId: string,
    patch: { name?: string; description?: string | null },
  ): Promise<ActorGroupSummaryResponse> {
    const existing = await this.findMutable(user, groupId);
    const group = await this.prisma.actorGroup.update({
      where: { id: existing.id },
      data: {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined
          ? {}
          : { description: patch.description }),
        ...auditOf(existing, user),
      },
      include: { _count: { select: { members: true } } },
    });
    this.logger.info({
      event: "actor-group.updated",
      actorUserId: user.id,
      groupId: group.id,
    });
    return {
      ...ownershipResponse(group, user),
      id: group.id,
      name: group.name,
      ...(group.description === null ? {} : { description: group.description }),
      memberCount: group._count.members,
      createdAt: group.createdAt.toISOString(),
      updatedAt: group.updatedAt.toISOString(),
    };
  }

  /**
   * Deletes a group the caller owns.
   *
   * Refused while a Strategy references it, and refused outright for built-in content — the same two
   * rules a Stock List follows. The referencing check reads the caller's strategy definitions and looks
   * for the group id inside them; the definition is a JSON document nothing queries into in SQL, so
   * this is deliberately a read-and-check rather than a foreign key.
   */
  async deleteGroup(user: AuthUser, groupId: string): Promise<void> {
    const existing = await this.findMutable(user, groupId);
    if (existing.ownership === "SYSTEM") {
      throw new SystemContentProtectedError("actor groups");
    }
    const referencing = await this.strategiesReferencing(user, groupId);
    if (referencing.length > 0) {
      throw new ActorGroupInUseError(referencing);
    }
    await this.prisma.actorGroup.delete({ where: { id: existing.id } });
    this.logger.info({
      event: "actor-group.deleted",
      actorUserId: user.id,
      groupId,
    });
  }

  /**
   * Adds members, skipping those already in the group.
   *
   * Idempotent, so a retried request is harmless, and the member bound is checked **inside** the
   * transaction against the membership it actually finds there — two concurrent adds cannot both pass a
   * check taken before either wrote.
   */
  async addMembers(
    user: AuthUser,
    groupId: string,
    actorIds: readonly string[],
  ): Promise<ActorGroupDetailResponse> {
    const existing = await this.findMutable(user, groupId);
    await this.assertActorsSupported(actorIds);
    const group = await this.prisma.$transaction(async (tx) => {
      const current = await tx.actorGroupMember.findMany({
        where: { groupId: existing.id },
        select: { actorId: true },
      });
      const currentIds = new Set(current.map((member) => member.actorId));
      const additions = actorIds.filter((actorId) => !currentIds.has(actorId));
      if (currentIds.size + additions.length > ACTOR_GROUP_MAX_MEMBERS) {
        throw new ActorGroupFullError(ACTOR_GROUP_MAX_MEMBERS);
      }
      if (additions.length > 0) {
        const createdAt = Date.now();
        await tx.actorGroupMember.createMany({
          data: additions.map((actorId, index) => ({
            groupId: existing.id,
            actorId,
            createdAt: new Date(createdAt + index),
          })),
          skipDuplicates: true,
        });
        await tx.actorGroup.update({
          where: { id: existing.id },
          data: auditOf(existing, user),
        });
      }
      return tx.actorGroup.findUniqueOrThrow({
        where: { id: existing.id },
        include: MEMBER_INCLUDE,
      });
    });
    this.logger.info({
      event: "actor-group.members-added",
      actorUserId: user.id,
      groupId: existing.id,
      requested: actorIds.length,
      memberCount: group.members.length,
    });
    return detailResponse(group, user);
  }

  /** Removing a member that is not in the group is a no-op, so a retry is harmless. */
  async removeMember(
    user: AuthUser,
    groupId: string,
    actorId: string,
  ): Promise<void> {
    const existing = await this.findMutable(user, groupId);
    await this.prisma.actorGroupMember.deleteMany({
      where: { groupId: existing.id, actorId },
    });
    this.logger.info({
      event: "actor-group.member-removed",
      actorUserId: user.id,
      groupId: existing.id,
    });
  }

  /**
   * The group a viewer asked to change, or a refusal.
   *
   * Missing and "another customer's" read identically (404); a built-in a non-administrator tried to
   * change is a 403. Exactly `StockListsService.findMutable`.
   */
  private async findMutable(viewer: AuthUser, groupId: string) {
    const row = await this.prisma.actorGroup.findFirst({
      where: { id: groupId, ...readableWhere(viewer) },
      select: { id: true, ownership: true, userId: true, systemKey: true },
    });
    const group = assertMutable(row, viewer, "actor groups");
    if (!group) {
      throw new ActorGroupNotFoundError();
    }
    return group;
  }

  /**
   * Every submitted actor must exist in the canonical catalog.
   *
   * The catalog is the identity authority, exactly as `Security` is for a stock list: the group
   * feature never creates actor rows and never consults the provider.
   */
  private async assertActorsSupported(
    actorIds: readonly string[],
  ): Promise<void> {
    if (actorIds.length === 0) {
      return;
    }
    const wanted = [...new Set(actorIds)];
    const found = await this.prisma.alternativeDataActor.count({
      where: { id: { in: wanted } },
    });
    if (found !== wanted.length) {
      throw new UnsupportedActorError();
    }
  }

  /**
   * The names of the caller's strategies whose current definition references one group.
   *
   * Only the **current** version of each strategy is checked. An older version that referenced the
   * group is history and is never executed again except through a completed backtest run, which carries
   * its own frozen copy of the membership — so it cannot be affected by the deletion either.
   */
  private async strategiesReferencing(
    user: AuthUser,
    groupId: string,
  ): Promise<string[]> {
    const strategies = await this.prisma.strategy.findMany({
      where: { userId: user.id },
      select: {
        name: true,
        versions: {
          orderBy: { versionNumber: "desc" },
          take: 1,
          select: { definition: true },
        },
      },
    });
    return strategies
      .filter((strategy) => {
        const definition = strategy.versions[0]?.definition;
        return (
          definition !== undefined &&
          JSON.stringify(definition).includes(groupId)
        );
      })
      .map((strategy) => strategy.name);
  }
}
