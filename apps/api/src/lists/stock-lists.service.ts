import type {
  AuthUser,
  StockListComplianceResponse,
  StockListDetailResponse,
  StockListItemResponse,
  StockListSummaryResponse,
  UpdateStockListRequest,
} from "@intrinsic/contracts";
import type { Prisma } from "@intrinsic/database";
import {
  normalizeBuyWindowConfiguration,
  type BuyWindowConfiguration,
} from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable } from "@nestjs/common";
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
    },
    buyWindowMode: item.buyWindowMode,
    buyWindows: item.buyWindows.map((window) => ({
      startDate: fromDatabaseDate(window.startDate),
      endDate: window.endDate === null ? null : fromDatabaseDate(window.endDate),
    })),
  };
}

function detailResponse(
  list: ListDetailRow,
  compliance: StockListComplianceResponse,
): StockListDetailResponse {
  return {
    id: list.id,
    name: list.name,
    ...(list.description === null ? {} : { description: list.description }),
    createdAt: list.createdAt.toISOString(),
    updatedAt: list.updatedAt.toISOString(),
    items: list.items.map(itemResponse),
    compliance,
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
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EntitlementsService)
    private readonly entitlements: EntitlementsService,
    @Inject(LISTS_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  async listForUser(user: AuthUser): Promise<StockListSummaryResponse[]> {
    const lists = await this.prisma.stockList.findMany({
      where: { userId: user.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { _count: { select: { items: true } } },
    });
    return lists.map((list) => ({
      id: list.id,
      name: list.name,
      ...(list.description === null ? {} : { description: list.description }),
      itemCount: list._count.items,
      createdAt: list.createdAt.toISOString(),
      updatedAt: list.updatedAt.toISOString(),
      compliance: this.complianceOf(user, list._count.items),
    }));
  }

  /**
   * Current membership against the caller's current entitlements.
   *
   * Reading a List is never refused for being over the limit — a downgrade leaves content intact
   * and readable — so this is reported, not enforced.
   */
  private complianceOf(
    user: AuthUser,
    symbolCount: number,
  ): StockListComplianceResponse {
    const compliance = this.entitlements.getListCompliance(user, symbolCount);
    return {
      symbolCount: compliance.usage,
      symbolLimit: compliance.limit,
      compliant: compliance.compliant,
    };
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
    return detailResponse(list, this.complianceOf(user, list.items.length));
  }

  /**
   * Reads one of the caller's Lists.
   *
   * Never refused for exceeding the current plan: grandfathered content stays readable, and the
   * derived `compliance` is how the caller learns it is over the limit.
   */
  async getList(
    user: AuthUser,
    listId: string,
  ): Promise<StockListDetailResponse> {
    const list = await this.prisma.stockList.findFirst({
      where: { id: listId, userId: user.id },
      include: { items: { include: ITEM_INCLUDE, orderBy: ITEMS_ORDER } },
    });
    if (!list) {
      throw new StockListNotFoundError();
    }
    return detailResponse(list, this.complianceOf(user, list.items.length));
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
    const userId = user.id;
    // `updateMany` applies the ownership filter and the write in one atomic statement.
    const updated = await this.prisma.stockList.updateMany({
      where: { id: listId, userId },
      data: {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined
          ? {}
          : { description: patch.description }),
      },
    });
    if (updated.count === 0) {
      throw new StockListNotFoundError();
    }

    const list = await this.prisma.stockList.findFirst({
      where: { id: listId, userId },
      include: { _count: { select: { items: true } } },
    });
    if (!list) {
      // Deleted between the update and this read; to the caller it no longer exists.
      throw new StockListNotFoundError();
    }

    this.logger.info({ event: "stock-list.updated", actorUserId: userId, listId });
    return {
      id: list.id,
      name: list.name,
      ...(list.description === null ? {} : { description: list.description }),
      itemCount: list._count.items,
      createdAt: list.createdAt.toISOString(),
      updatedAt: list.updatedAt.toISOString(),
      compliance: this.complianceOf(user, list._count.items),
    };
  }

  /**
   * Deletes a list the caller owns, unless a Monitor is still watching it.
   *
   * The database refuses that case (`Monitor.stockListId` is `onDelete: Restrict`), so the guard is
   * the constraint rather than a check that could race a Monitor created a moment later. The count
   * is read only on the error path, to say how many.
   */
  async deleteList(userId: string, listId: string): Promise<void> {
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
      // Ownership only: a List the caller does not own reads as missing, exactly as every other
      // route answers.
      const list = await tx.stockList.findFirst({
        where: { id: listId, userId },
        select: { id: true },
      });
      if (!list) {
        throw new StockListNotFoundError();
      }
      await this.assertSecuritiesSupported(tx, securityIds);

      const [current, alreadyMembers] = await Promise.all([
        tx.stockListItem.count({ where: { stockListId: listId } }),
        tx.stockListItem.count({
          where: { stockListId: listId, securityId: { in: requested } },
        }),
      ]);
      await this.entitlements.assertListSymbolLimitIn(tx, userId, {
        current,
        adding: requested.length - alreadyMembers,
      });

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
    userId: string,
    listId: string,
    itemId: string,
  ): Promise<void> {
    // One statement walks the whole ownership chain: item -> list -> user.
    const deleted = await this.prisma.stockListItem.deleteMany({
      where: { id: itemId, stockListId: listId, stockList: { userId } },
    });
    if (deleted.count === 0) {
      throw new StockListItemNotFoundError();
    }
    this.logger.info({ event: "stock-list.item.removed", listId, itemId });
  }

  /**
   * Replaces one member's buy windows.
   *
   * Not entitlement-gated: it changes eligibility dates, never membership size, so it can neither
   * create nor worsen a capacity violation.
   */
  async replaceBuyWindows(
    userId: string,
    listId: string,
    itemId: string,
    submitted: BuyWindowConfiguration,
  ): Promise<StockListItemResponse> {
    // Throws BuyWindowValidationError before anything is touched.
    const canonical = normalizeBuyWindowConfiguration(submitted);

    const item = await this.prisma.$transaction(async (tx) => {
      // The ownership-filtered mode write doubles as a row lock on the item, so two concurrent
      // replacements serialize instead of interleaving their delete/insert phases.
      const updated = await tx.stockListItem.updateMany({
        where: { id: itemId, stockListId: listId, stockList: { userId } },
        data: { buyWindowMode: canonical.mode },
      });
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
