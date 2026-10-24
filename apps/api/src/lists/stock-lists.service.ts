import type {
  AuthUser,
  HistoricalUniverseCatalogResponse,
  StockListComplianceResponse,
  StockListDetailResponse,
  StockListItemResponse,
  StockListSummaryResponse,
  StockListUniverseResponse,
  UpdateStockListRequest,
} from "@intrinsic/contracts";
import type { Prisma } from "@intrinsic/database";
import {
  CATALOG_HISTORICAL_UNIVERSES,
  HISTORICAL_UNIVERSE_CATEGORIES,
  HISTORICAL_UNIVERSE_CATEGORY_LABELS,
  HISTORICAL_UNIVERSE_FLOOR,
  maintainedUniverseForList,
  maintainedUniverseOf,
  normalizeBuyWindowConfiguration,
  peakSimultaneousMembers,
  publishedListFloor,
  unavailableRequirements,
  type BuyWindowConfiguration,
  type HistoricalUniverseDefinition,
  type MaintainedUniverse,
} from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable } from "@nestjs/common";
import {
  SYSTEM_FIRST_ORDER,
  assertMutable,
  assertPremiumAccessible,
  auditOf,
  mutableWhere,
  ownershipResponse,
  readableWhere,
  SystemContentMaintainedError,
  SystemContentProtectedError,
  viewerEntitlements,
  type ContentViewer,
} from "../builtins/content-access";
import { PrismaService } from "../database/prisma.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { LISTS_LOGGER } from "./lists.tokens";

/**
 * Raised for a list that does not exist *or* is not owned by the caller. The two cases are
 * deliberately indistinguishable so knowing another user's list id reveals nothing.
 */
export class StockListNotFoundError extends Error {
  constructor() {
    super("Stock list was not found");
    this.name = "StockListNotFoundError";
  }
}

/**
 * Raised when a list cannot be deleted because a Monitor is still watching it.
 *
 * Deleting it would take that Monitor and every Signal it ever produced with it, silently. Signal
 * history is a record of what was observed, so the deletion is refused and the user removes the
 * Monitor first — see `ai/product/monitors.md`.
 */
export class StockListInUseByMonitorError extends Error {
  constructor(readonly monitorCount: number) {
    super(
      // The count is read after the constraint refused, so a Monitor deleted in between would
      // make it zero. Singular is the fallback rather than a literal "0 monitors".
      monitorCount > 1
        ? `This list is used by ${monitorCount} monitors. Delete them first.`
        : "This list is used by a monitor. Delete the monitor first.",
    );
    this.name = "StockListInUseByMonitorError";
  }
}

/**
 * Raised when a maintained historical universe is duplicated (`historical-universes-v1.md` §6).
 *
 * A copy would be an ordinary customer List carrying a premium universe's membership: it would stop
 * being maintained, so it would stop being point-in-time, and it would stay usable after a downgrade
 * — the premium universe without the plan. No plan unlocks it.
 */
export class MaintainedUniverseCopyError extends Error {
  constructor() {
    super(
      "This built-in universe is maintained by FactorSage and cannot be duplicated. Use it directly in a backtest or a monitor.",
    );
    this.name = "MaintainedUniverseCopyError";
  }
}

/** Same non-leaking semantics as {@link StockListNotFoundError}, for one membership row. */
export class StockListItemNotFoundError extends Error {
  constructor() {
    super("Stock list item was not found");
    this.name = "StockListItemNotFoundError";
  }
}

/**
 * A submitted security id that is not in the `Security` catalog. The catalog is the identity
 * authority: the list feature never creates catalog rows and never consults the provider.
 */
export class UnsupportedSecurityError extends Error {
  constructor() {
    super("One or more selected securities are not in the supported catalog");
    this.name = "UnsupportedSecurityError";
  }
}

const ITEM_INCLUDE = {
  security: {
    select: {
      id: true,
      symbol: true,
      name: true,
      exchangeCode: true,
      exchangeName: true,
      // The company mark, from the profile the catalog persists. A left join on an indexed
      // primary key, so the list stays one query and still renders a real logo per member.
      profile: { select: { logoUrl: true } },
    },
  },
  buyWindows: { orderBy: { startDate: "asc" as const } },
} satisfies Prisma.StockListItemInclude;

type ItemRow = Prisma.StockListItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

type ListDetailRow = Prisma.StockListGetPayload<{
  include: { items: { include: typeof ITEM_INCLUDE } };
}>;

function toDatabaseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function fromDatabaseDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function itemResponse(item: ItemRow): StockListItemResponse {
  return {
    id: item.id,
    security: {
      id: item.security.id,
      symbol: item.security.symbol,
      name: item.security.name,
      exchangeCode: item.security.exchangeCode,
      ...(item.security.exchangeName
        ? { exchangeName: item.security.exchangeName }
        : {}),
      ...(item.security.profile?.logoUrl
        ? { logoUrl: item.security.profile.logoUrl }
        : {}),
    },
    buyWindowMode: item.buyWindowMode,
    buyWindows: item.buyWindows.map((window) => ({
      startDate: fromDatabaseDate(window.startDate),
      endDate: window.endDate === null ? null : fromDatabaseDate(window.endDate),
    })),
  };
}

/**
 * The maintained historical universe a List carries — an index's membership or a universe derived
 * from one: only the SYSTEM List whose `systemKey` names one. A customer's List never does.
 */
function maintainedUniverse(list: {
  ownership: "USER" | "SYSTEM";
  systemKey: string | null;
}): MaintainedUniverse | null {
  return list.ownership === "SYSTEM"
    ? maintainedUniverseForList(list.systemKey)
    : null;
}

/** Why a catalog universe is unavailable, as the Lists page says it. */
function unavailableReasonOf(
  definition: HistoricalUniverseDefinition,
  status: string | undefined,
): string {
  if (unavailableRequirements(definition).includes("HISTORICAL_SECTOR_CLASSIFICATION")) {
    return "Historical data unavailable: no point-in-time sector classification is available for past members, and today's sectors are never applied to the past.";
  }
  if (status === "BLOCKED") {
    return "Historical data unavailable: a dataset this universe requires is not available.";
  }
  return "Historical data unavailable: its point-in-time data has not been validated yet.";
}

/** How a premium refusal names this List: a point-in-time universe, or a premium predefined List. */
function premiumKindOf(list: {
  ownership: "USER" | "SYSTEM";
  systemKey: string | null;
}): "LIST" | "INDEX_UNIVERSE" {
  return maintainedUniverse(list) ? "INDEX_UNIVERSE" : "LIST";
}

/**
 * A universe's measured size, from its members' windows: distinct securities, the most members at
 * once since the floor, and the members today.
 */
export function universeResponse(
  universe: MaintainedUniverse,
  windows: readonly BuyWindowConfiguration[],
  today: string,
  syncedAt: Date | null,
): StockListUniverseResponse {
  return {
    kind: "POINT_IN_TIME_INDEX",
    indexKey: universe.indexKey,
    universeKey: universe.universeKey,
    category: universe.category,
    derived: universe.derived,
    distinctSecurities: windows.length,
    peakSimultaneousMembers: peakSimultaneousMembers(windows, {
      from: universe.membershipFloor,
      to: today,
    }).peak,
    currentMembers: windows.filter((configuration) =>
      configuration.ranges.some((range) => range.endDate === null),
    ).length,
    membershipFloor: universe.membershipFloor,
    syncedAt: syncedAt?.toISOString() ?? null,
  };
}

function detailResponse(
  list: ListDetailRow,
  compliance: StockListComplianceResponse,
  viewer: ContentViewer,
  universe?: StockListUniverseResponse,
): StockListDetailResponse {
  return {
    ...ownershipResponse(list, viewer),
    // A maintained universe is edited by its synchronization, never through the List routes.
    ...(universe ? { canEdit: false } : {}),
    id: list.id,
    name: list.name,
    ...(list.description === null ? {} : { description: list.description }),
    createdAt: list.createdAt.toISOString(),
    updatedAt: list.updatedAt.toISOString(),
    items: list.items.map(itemResponse),
    compliance,
    ...(universe ? { universe } : {}),
  };
}

/** Membership renders in the order stocks were added; ids break created-in-same-tick ties. */
const ITEMS_ORDER = [
  { createdAt: "asc" as const },
  { id: "asc" as const },
];

/**
 * Translates a foreign-key violation from a membership write into the same stable product error
 * the pre-write validation produces, so a row vanishing between validation and write cannot leak
 * a raw database exception. Checked structurally to keep the Prisma runtime out of this module's
 * imports.
 */
function translateForeignKeyRace(error: unknown): never {
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2003"
  ) {
    const constraint = String(
      (error as { meta?: { constraint?: unknown; field_name?: unknown } }).meta
        ?.constraint ??
        (error as { meta?: { field_name?: unknown } }).meta?.field_name ??
        "",
    );
    if (constraint.toLowerCase().includes("security")) {
      throw new UnsupportedSecurityError();
    }
    throw new StockListNotFoundError();
  }
  throw error;
}

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

@Injectable()
export class StockListsService {
  /**
   * Each maintained universe's measured size, by List, with the version it was measured at.
   *
   * Measuring reads every member's windows — a thousand-odd members for the S&P 500 universe — and
   * `GET /lists` is what every collection page and every picker reads. The measure changes only
   * when the universe's projection rewrites its members, and that projection is the List's only
   * writer and always stamps `StockList.updatedAt` in the same transaction; so the List's
   * `updatedAt`, its member count and the day (the peak is measured up to today) identify a
   * measure exactly. `syncedAt` is not part of it: it is read fresh on every request.
   */
  private readonly universeMeasures = new Map<
    string,
    { readonly version: string; readonly measure: StockListUniverseResponse }
  >();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EntitlementsService)
    private readonly entitlements: EntitlementsService,
    @Inject(LISTS_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  /**
   * The Lists a viewer can use: every built-in first, in operator order, then the caller's own,
   * newest first. A Guest sees the built-ins only.
   */
  async listForUser(viewer: ContentViewer): Promise<StockListSummaryResponse[]> {
    const lists = await this.prisma.stockList.findMany({
      where: readableWhere(viewer),
      orderBy: [
        ...SYSTEM_FIRST_ORDER,
        { createdAt: "desc" },
        { id: "desc" },
      ],
      include: { _count: { select: { items: true } } },
    });
    const universes = new Map<string, StockListUniverseResponse>();
    for (const list of lists) {
      const universe = maintainedUniverse(list);
      if (universe) {
        universes.set(
          list.id,
          await this.measureUniverseOnce(list, universe),
        );
      }
    }
    return lists.map((list) => this.summaryOf(list, viewer, universes.get(list.id)));
  }

  /**
   * The historical universe catalog, grouped for the Lists page (`historical-universes-v1.md` §6):
   * every catalog universe with its availability, read from two small PostgreSQL queries. Nothing
   * here reads a membership or reaches the provider.
   */
  async universeCatalog(viewer: ContentViewer): Promise<HistoricalUniverseCatalogResponse> {
    const keys = CATALOG_HISTORICAL_UNIVERSES.map((definition) => definition.key);
    const [lists, states] = await Promise.all([
      this.prisma.stockList.findMany({
        where: { ownership: "SYSTEM", systemKey: { in: keys } },
        select: { id: true, systemKey: true, _count: { select: { items: true } } },
      }),
      this.prisma.historicalUniverse.findMany({
        where: { key: { in: keys } },
        select: {
          key: true,
          status: true,
          statusReasons: true,
          publishedGeneration: { select: { validation: true } },
        },
      }),
    ]);
    const listOf = new Map(lists.map((list) => [list.systemKey, list]));
    const stateOf = new Map(states.map((state) => [state.key, state]));
    const locked = !viewerEntitlements(viewer).builtInContent.canUsePremium;
    return {
      categories: HISTORICAL_UNIVERSE_CATEGORIES.filter((category) => category !== "RESEARCH").map(
        (category) => ({
          key: category,
          label: HISTORICAL_UNIVERSE_CATEGORY_LABELS[category],
          universes: CATALOG_HISTORICAL_UNIVERSES.filter(
            (definition) => definition.category === category,
          )
            .sort((left, right) => left.displayOrder - right.displayOrder)
            .map((definition) => {
              const list = listOf.get(definition.key);
              const state = stateOf.get(definition.key);
              // Publication is the only writer of a catalog universe's List, so a List with members
              // is a published universe — the S&P 500's predates the catalog's states — and it stays
              // available while a newer generation of it is still being validated.
              const available = list !== undefined && list._count.items > 0;
              const validation = state?.publishedGeneration?.validation as
                | { publishFrom?: string | null }
                | null
                | undefined;
              return {
                key: definition.key,
                name: maintainedUniverseOf(definition).listName,
                description: definition.description,
                premium: true as const,
                locked,
                availability: available ? ("AVAILABLE" as const) : ("UNAVAILABLE" as const),
                listId: available ? (list?.id ?? null) : null,
                availableFrom: available
                  ? (publishedListFloor(definition.key, validation?.publishFrom ?? null) ??
                    HISTORICAL_UNIVERSE_FLOOR)
                  : null,
                unavailableReason: available ? null : unavailableReasonOf(definition, state?.status),
              };
            }),
        }),
      ),
    };
  }

  /**
   * A maintained universe's measured size for the collection: measured once per version of its
   * membership (see `universeMeasures`), with its last synchronization read fresh.
   */
  private async measureUniverseOnce(
    list: {
      readonly id: string;
      readonly updatedAt: Date;
      readonly _count: { readonly items: number };
    },
    universe: MaintainedUniverse,
  ): Promise<StockListUniverseResponse> {
    const version = [
      list.updatedAt.toISOString(),
      list._count.items,
      new Date().toISOString().slice(0, 10),
    ].join("|");
    const cached = this.universeMeasures.get(list.id);
    if (cached?.version === version) {
      const sync = await this.latestSync(universe);
      return { ...cached.measure, syncedAt: sync?.toISOString() ?? null };
    }
    const measure = await this.measureUniverse(list.id, universe);
    this.universeMeasures.set(list.id, { version, measure });
    return measure;
  }

  /** When the universe's membership was last synchronized, if ever. */
  private async latestSync(
    universe: MaintainedUniverse,
  ): Promise<Date | null> {
    const sync = await this.prisma.indexMembershipSync.findFirst({
      where: { indexKey: universe.indexKey, status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true },
    });
    return sync?.completedAt ?? null;
  }

  /** A maintained universe's measured size, read from its members' windows. */
  private async measureUniverse(
    listId: string,
    universe: MaintainedUniverse,
    loaded?: readonly { buyWindowMode: "FULL" | "CUSTOM"; buyWindows: { startDate: Date; endDate: Date | null }[] }[],
  ): Promise<StockListUniverseResponse> {
    const items =
      loaded ??
      (await this.prisma.stockListItem.findMany({
        where: { stockListId: listId },
        select: {
          buyWindowMode: true,
          buyWindows: { select: { startDate: true, endDate: true } },
        },
      }));
    return universeResponse(
      universe,
      items.map((item) => ({
        mode: item.buyWindowMode,
        ranges: item.buyWindows.map((window) => ({
          startDate: fromDatabaseDate(window.startDate),
          endDate: window.endDate === null ? null : fromDatabaseDate(window.endDate),
        })),
      })),
      new Date().toISOString().slice(0, 10),
      await this.latestSync(universe),
    );
  }

  private summaryOf(
    list: Prisma.StockListGetPayload<{
      include: { _count: { select: { items: true } } };
    }>,
    viewer: ContentViewer,
    universe?: StockListUniverseResponse,
  ): StockListSummaryResponse {
    return {
      ...ownershipResponse(list, viewer),
      ...(universe ? { canEdit: false } : {}),
      id: list.id,
      name: list.name,
      ...(list.description === null ? {} : { description: list.description }),
      itemCount: list._count.items,
      createdAt: list.createdAt.toISOString(),
      updatedAt: list.updatedAt.toISOString(),
      compliance: this.complianceOf(list, viewer, list._count.items),
      ...(universe ? { universe } : {}),
    };
  }

  /**
   * Current membership against the caller's current entitlements.
   *
   * Reading a List is never refused for being over the limit — a downgrade leaves content intact
   * and readable — so this is reported, not enforced. A built-in is platform content, not a
   * customer List, and no plan limit applies to it.
   */
  private complianceOf(
    list: { ownership: "USER" | "SYSTEM" },
    viewer: ContentViewer,
    symbolCount: number,
  ): StockListComplianceResponse {
    if (list.ownership === "SYSTEM" || !viewer) {
      return { symbolCount, symbolLimit: null, compliant: true };
    }
    const compliance = this.entitlements.getListCompliance(viewer, symbolCount);
    return {
      symbolCount: compliance.usage,
      symbolLimit: compliance.limit,
      compliant: compliance.compliant,
    };
  }

  /**
   * The List a viewer asked to change, or a refusal.
   *
   * Missing and "another customer's" read identically (404). A built-in the viewer may not change
   * is a 403; an administrator may change it.
   */
  private async findMutable(
    db: Pick<PrismaService, "stockList">,
    viewer: AuthUser,
    listId: string,
  ) {
    const row = await db.stockList.findFirst({
      where: { id: listId, ...readableWhere(viewer) },
      select: { id: true, ownership: true, userId: true, systemKey: true },
    });
    const list = assertMutable(row, viewer, "lists");
    if (!list) {
      throw new StockListNotFoundError();
    }
    const universe = maintainedUniverse(list);
    if (universe) {
      throw new SystemContentMaintainedError(universe.listName);
    }
    return list;
  }

  /**
   * Creates a custom List.
   *
   * The two entitlement questions are asked before anything is read or written: may this caller
   * have custom Lists at all, and does the requested membership fit their plan. Neither can race
   * anything — the List does not exist yet — so both are answered from the request's trusted
   * principal rather than by opening a transaction.
   */
  async createList(
    user: AuthUser,
    input: { name: string; description?: string; securityIds: string[] },
  ): Promise<StockListDetailResponse> {
    const userId = user.id;
    this.entitlements.assertCanCreateCustomList(user);
    // Duplicates collapse to one membership row, so they must not count toward the limit either.
    const requested = [...new Set(input.securityIds)];
    this.entitlements.assertListSymbolLimit(user, {
      current: 0,
      adding: requested.length,
    });
    await this.assertSecuritiesSupported(this.prisma, input.securityIds);

    const list = await this.prisma.stockList
      .create({
        data: {
          userId,
          name: input.name,
          description: input.description ?? null,
          items: {
            create: input.securityIds.map((securityId) => ({ securityId })),
          },
        },
        include: { items: { include: ITEM_INCLUDE, orderBy: ITEMS_ORDER } },
      })
      .catch(translateForeignKeyRace);

    this.logger.info({
      event: "stock-list.created",
      actorUserId: userId,
      listId: list.id,
      itemCount: list.items.length,
    });
    return detailResponse(
      list,
      this.complianceOf(list, user, list.items.length),
      user,
    );
  }

  /**
   * Copies a List the caller can read — their own, or a built-in — into a new List they own.
   *
   * The copy is configuration, not history: the description, every member in the source's order,
   * and each member's buy-window mode and canonical ranges, all under new identities. Nothing that
   * records past activity comes with it — backtest runs and Monitors keep referencing the source —
   * and the source is only read. Ownership is the caller's alone: no `SYSTEM` ownership,
   * `systemKey`, display order or administrator audit column is carried over, so a copy of a
   * built-in is an ordinary customer List, editable and deletable like any other.
   *
   * It is a new custom List, so it answers exactly the entitlement questions `createList` does, for
   * the size the copy will have. A built-in is exempt from the symbol limit because it is platform
   * content; a customer's copy of one is not, so duplicating is never a way past the plan.
   *
   * The source is read and the copy written in one transaction, so a failure part-way leaves
   * nothing behind. It runs at `REPEATABLE READ` because the source is read by more than one
   * statement — the members, then their windows — and at the default isolation a membership edit
   * committing between the two could hand the copy a `CUSTOM` member with no ranges, a state no
   * writer may persist. Nothing here updates an existing row, so the stricter snapshot costs no
   * serialization failures.
   */
  async duplicateList(
    user: AuthUser,
    listId: string,
    input: { name: string },
  ): Promise<StockListDetailResponse> {
    const userId = user.id;
    this.entitlements.assertCanCreateCustomList(user);

    const { list, sourceOwnership } = await this.prisma.$transaction(
      async (tx) => {
        // Another customer's List reads as missing, exactly as it does on every other route.
        const source = await tx.stockList.findFirst({
          where: { id: listId, ...readableWhere(user) },
          select: {
            ownership: true,
            premium: true,
            systemKey: true,
            description: true,
            items: {
              orderBy: ITEMS_ORDER,
              select: {
                securityId: true,
                buyWindowMode: true,
                buyWindows: {
                  orderBy: { startDate: "asc" },
                  select: { startDate: true, endDate: true },
                },
              },
            },
          },
        });
        if (!source) {
          throw new StockListNotFoundError();
        }
        if (maintainedUniverse(source)) {
          throw new MaintainedUniverseCopyError();
        }
        // A copy is ordinary content the customer owns, so the premium gate has to stand at the
        // copy: otherwise duplicating first would be the way around it (entitlements-v2 §6).
        assertPremiumAccessible(source, user, premiumKindOf(source));
        this.entitlements.assertListSymbolLimit(user, {
          current: 0,
          adding: source.items.length,
        });

        // Members render in the order they were added, so each gets its own creation instant, in the
        // source's order. Sharing one would leave the copy's order to its new, random ids.
        const createdAt = Date.now();
        const list = await tx.stockList.create({
          data: {
            userId,
            name: input.name,
            description: source.description,
            items: {
              create: source.items.map((item, index) => ({
                securityId: item.securityId,
                buyWindowMode: item.buyWindowMode,
                createdAt: new Date(createdAt + index),
                buyWindows: {
                  create: item.buyWindows.map((window) => ({
                    startDate: window.startDate,
                    endDate: window.endDate,
                  })),
                },
              })),
            },
          },
          include: { items: { include: ITEM_INCLUDE, orderBy: ITEMS_ORDER } },
        });
        return { list, sourceOwnership: source.ownership };
      },
      { isolationLevel: "RepeatableRead" },
    );

    this.logger.info({
      event: "stock-list.duplicated",
      actorUserId: userId,
      listId: list.id,
      sourceListId: listId,
      sourceOwnership,
      itemCount: list.items.length,
    });
    return detailResponse(
      list,
      this.complianceOf(list, user, list.items.length),
      user,
    );
  }

  /**
   * Reads one of the caller's Lists, or a built-in.
   *
   * Never refused for exceeding the current plan: grandfathered content stays readable, and the
   * derived `compliance` is how the caller learns it is over the limit.
   */
  async getList(
    viewer: ContentViewer,
    listId: string,
  ): Promise<StockListDetailResponse> {
    // A premium built-in's membership is the premium content itself
    // (`docs/decisions/entitlements-v2.md` §6), so it is decided before a single member is loaded.
    // The collection still names it, with its size, and marks it `locked`.
    const head = await this.prisma.stockList.findFirst({
      where: { id: listId, ...readableWhere(viewer) },
      select: { ownership: true, premium: true, systemKey: true },
    });
    if (!head) {
      throw new StockListNotFoundError();
    }
    assertPremiumAccessible(head, viewer, premiumKindOf(head));

    const list = await this.prisma.stockList.findFirst({
      where: { id: listId, ...readableWhere(viewer) },
      include: { items: { include: ITEM_INCLUDE, orderBy: ITEMS_ORDER } },
    });
    if (!list) {
      throw new StockListNotFoundError();
    }
    const universe = maintainedUniverse(list);
    return detailResponse(
      list,
      this.complianceOf(list, viewer, list.items.length),
      viewer,
      universe ? await this.measureUniverse(list.id, universe, list.items) : undefined,
    );
  }

  /**
   * Renames a List or changes its description.
   *
   * Deliberately **not** entitlement-gated. `docs/decisions/entitlements-v1.md` lists renaming an
   * oversized List among the operations that stay allowed after a downgrade: it changes nothing
   * about capacity, and refusing it would make grandfathered content read-only for no product
   * reason.
   */
  async updateList(
    user: AuthUser,
    listId: string,
    patch: UpdateStockListRequest,
  ): Promise<StockListSummaryResponse> {
    const target = await this.findMutable(this.prisma, user, listId);
    // `updateMany` re-applies the permission filter and the write in one atomic statement.
    const updated = await this.prisma.stockList.updateMany({
      where: { id: listId, ...mutableWhere(user) },
      data: {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined
          ? {}
          : { description: patch.description }),
        ...auditOf(target, user),
      },
    });
    if (updated.count === 0) {
      throw new StockListNotFoundError();
    }

    const list = await this.prisma.stockList.findFirst({
      where: { id: listId, ...readableWhere(user) },
      include: { _count: { select: { items: true } } },
    });
    if (!list) {
      // Deleted between the update and this read; to the caller it no longer exists.
      throw new StockListNotFoundError();
    }

    this.logger.info({
      event: "stock-list.updated",
      actorUserId: user.id,
      listId,
      ownership: list.ownership,
    });
    return this.summaryOf(list, user);
  }

  /**
   * Deletes a list the caller owns, unless a Monitor is still watching it.
   *
   * The database refuses that case (`Monitor.stockListId` is `onDelete: Restrict`), so the guard is
   * the constraint rather than a check that could race a Monitor created a moment later. The count
   * is read only on the error path, to say how many.
   */
  async deleteList(user: AuthUser, listId: string): Promise<void> {
    const userId = user.id;
    const target = await this.findMutable(this.prisma, user, listId);
    if (target.ownership === "SYSTEM") {
      throw new SystemContentProtectedError("lists");
    }
    try {
      // Items and buy windows go with the list through the FK cascades.
      const deleted = await this.prisma.stockList.deleteMany({
        where: { id: listId, userId },
      });
      if (deleted.count === 0) {
        throw new StockListNotFoundError();
      }
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new StockListInUseByMonitorError(
          await this.prisma.monitor.count({ where: { stockListId: listId, userId } }),
        );
      }
      throw error;
    }
    this.logger.info({ event: "stock-list.deleted", listId });
  }

  /**
   * Adds members, up to the plan's symbol capacity.
   *
   * The capacity check counts only memberships this request would genuinely **create**: ids the
   * List already holds collapse to nothing through `skipDuplicates`, so counting them would refuse
   * an idempotent re-submission that changes the List's size by zero.
   *
   * Everything happens inside one transaction that takes the caller's entitlement lock first.
   * Without it two concurrent adds would each read the pre-add membership, each conclude there is
   * room, and together push the List past the limit — the check would be advice rather than
   * enforcement.
   *
   * The lock is taken **before** the List is read, not after. Locking the List row first and
   * reaching for the entitlement lock second would deadlock against a backtest submission or a
   * Monitor creation: both hold the entitlement lock and then take the foreign-key share lock that
   * any insert referencing this List requires. One acquisition order for every writer is what
   * removes that entirely — and the per-user lock is already the serialization, so no row lock on
   * the List is needed on top of it.
   *
   * This is the enforcement point the downgrade rules turn on: an oversized List rejects additions
   * here while removals, renames and reads elsewhere stay open.
   */
  async addItems(
    user: AuthUser,
    listId: string,
    securityIds: string[],
  ): Promise<StockListDetailResponse> {
    const userId = user.id;
    const requested = [...new Set(securityIds)];
    const added = await this.prisma.$transaction(async (tx) => {
      await this.entitlements.lockUserScope(tx, userId);
      // A List the caller does not own reads as missing, exactly as every other route answers; a
      // built-in is changeable by an administrator only.
      const list = await this.findMutable(tx, user, listId);
      await this.assertSecuritiesSupported(tx, securityIds);

      const [current, alreadyMembers] = await Promise.all([
        tx.stockListItem.count({ where: { stockListId: listId } }),
        tx.stockListItem.count({
          where: { stockListId: listId, securityId: { in: requested } },
        }),
      ]);
      // A built-in is platform content: no customer's plan limits its membership.
      if (list.ownership === "USER") {
        await this.entitlements.assertListSymbolLimitIn(tx, userId, {
          current,
          adding: requested.length - alreadyMembers,
        });
      } else {
        await tx.stockList.update({
          where: { id: listId },
          data: auditOf(list, user),
        });
      }

      // `skipDuplicates` makes re-submission and concurrent adds converge on one membership row
      // instead of surfacing the unique constraint as an error.
      const created = await tx.stockListItem
        .createMany({
          data: securityIds.map((securityId) => ({
            stockListId: listId,
            securityId,
          })),
          skipDuplicates: true,
        })
        .catch(translateForeignKeyRace);
      return created.count;
    });

    this.logger.info({
      event: "stock-list.items.added",
      actorUserId: userId,
      listId,
      requested: securityIds.length,
      added,
    });
    return this.getList(user, listId);
  }

  /**
   * Removes one member.
   *
   * Deliberately never entitlement-gated. It is the corrective operation an over-limit List needs:
   * refusing it would strand a downgraded user with a List they can neither use nor fix.
   */
  async removeItem(
    user: AuthUser,
    listId: string,
    itemId: string,
  ): Promise<void> {
    const list = await this.findMutable(this.prisma, user, listId);
    // One statement walks the whole permission chain: item -> list -> owner (or administrator).
    const deleted = await this.prisma.stockListItem.deleteMany({
      where: { id: itemId, stockListId: listId, stockList: mutableWhere(user) },
    });
    if (deleted.count === 0) {
      throw new StockListItemNotFoundError();
    }
    if (list.ownership === "SYSTEM") {
      await this.prisma.stockList.update({
        where: { id: listId },
        data: auditOf(list, user),
      });
    }
    this.logger.info({
      event: "stock-list.item.removed",
      actorUserId: user.id,
      listId,
      itemId,
    });
  }

  /**
   * Replaces one member's buy windows.
   *
   * Not entitlement-gated: it changes eligibility dates, never membership size, so it can neither
   * create nor worsen a capacity violation.
   */
  async replaceBuyWindows(
    user: AuthUser,
    listId: string,
    itemId: string,
    submitted: BuyWindowConfiguration,
  ): Promise<StockListItemResponse> {
    // Throws BuyWindowValidationError before anything is touched.
    const canonical = normalizeBuyWindowConfiguration(submitted);

    const item = await this.prisma.$transaction(async (tx) => {
      const list = await this.findMutable(tx, user, listId);
      // The permission-filtered mode write doubles as a row lock on the item, so two concurrent
      // replacements serialize instead of interleaving their delete/insert phases.
      const updated = await tx.stockListItem.updateMany({
        where: {
          id: itemId,
          stockListId: listId,
          stockList: mutableWhere(user),
        },
        data: { buyWindowMode: canonical.mode },
      });
      if (list.ownership === "SYSTEM" && updated.count > 0) {
        await tx.stockList.update({
          where: { id: listId },
          data: auditOf(list, user),
        });
      }
      if (updated.count === 0) {
        throw new StockListItemNotFoundError();
      }

      // The complete configuration is replaced as a set; FULL therefore ends with zero rows.
      await tx.stockListBuyWindow.deleteMany({
        where: { stockListItemId: itemId },
      });
      if (canonical.ranges.length > 0) {
        await tx.stockListBuyWindow.createMany({
          data: canonical.ranges.map((range) => ({
            stockListItemId: itemId,
            startDate: toDatabaseDate(range.startDate),
            endDate:
              range.endDate === null ? null : toDatabaseDate(range.endDate),
          })),
        });
      }

      return tx.stockListItem.findUniqueOrThrow({
        where: { id: itemId },
        include: ITEM_INCLUDE,
      });
    });

    this.logger.info({
      event: "stock-list.buy-windows.updated",
      actorUserId: user.id,
      listId,
      itemId,
      mode: canonical.mode,
      rangeCount: canonical.ranges.length,
    });
    return itemResponse(item);
  }

  /**
   * Every submitted id must resolve to an existing catalog row. Runs against the caller's
   * transaction client so membership writes cannot race a concurrent catalog change past it.
   */
  private async assertSecuritiesSupported(
    db: Pick<PrismaService, "security">,
    securityIds: string[],
  ): Promise<void> {
    if (securityIds.length === 0) {
      return;
    }
    const found = await db.security.findMany({
      where: { id: { in: securityIds } },
      select: { id: true },
    });
    if (found.length !== securityIds.length) {
      this.logger.debug({
        event: "stock-list.securities.rejected",
        requested: securityIds.length,
        found: found.length,
      });
      throw new UnsupportedSecurityError();
    }
  }
}
