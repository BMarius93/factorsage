import type {
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

function detailResponse(list: ListDetailRow): StockListDetailResponse {
  return {
    id: list.id,
    name: list.name,
    ...(list.description === null ? {} : { description: list.description }),
    createdAt: list.createdAt.toISOString(),
    updatedAt: list.updatedAt.toISOString(),
    items: list.items.map(itemResponse),
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

@Injectable()
export class StockListsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LISTS_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  async listForUser(userId: string): Promise<StockListSummaryResponse[]> {
    const lists = await this.prisma.stockList.findMany({
      where: { userId },
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
    }));
  }

  async createList(
    userId: string,
    input: { name: string; description?: string; securityIds: string[] },
  ): Promise<StockListDetailResponse> {
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
      listId: list.id,
      itemCount: list.items.length,
    });
    return detailResponse(list);
  }

  async getList(
    userId: string,
    listId: string,
  ): Promise<StockListDetailResponse> {
    const list = await this.prisma.stockList.findFirst({
      where: { id: listId, userId },
      include: { items: { include: ITEM_INCLUDE, orderBy: ITEMS_ORDER } },
    });
    if (!list) {
      throw new StockListNotFoundError();
    }
    return detailResponse(list);
  }

  async updateList(
    userId: string,
    listId: string,
    patch: UpdateStockListRequest,
  ): Promise<StockListSummaryResponse> {
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

    this.logger.info({ event: "stock-list.updated", listId });
    return {
      id: list.id,
      name: list.name,
      ...(list.description === null ? {} : { description: list.description }),
      itemCount: list._count.items,
      createdAt: list.createdAt.toISOString(),
      updatedAt: list.updatedAt.toISOString(),
    };
  }

  async deleteList(userId: string, listId: string): Promise<void> {
    // Items and buy windows go with the list through the FK cascades.
    const deleted = await this.prisma.stockList.deleteMany({
      where: { id: listId, userId },
    });
    if (deleted.count === 0) {
      throw new StockListNotFoundError();
    }
    this.logger.info({ event: "stock-list.deleted", listId });
  }

  async addItems(
    userId: string,
    listId: string,
    securityIds: string[],
  ): Promise<StockListDetailResponse> {
    const added = await this.prisma.$transaction(async (tx) => {
      const list = await tx.stockList.findFirst({
        where: { id: listId, userId },
        select: { id: true },
      });
      if (!list) {
        throw new StockListNotFoundError();
      }
      await this.assertSecuritiesSupported(tx, securityIds);

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
      listId,
      requested: securityIds.length,
      added,
    });
    return this.getList(userId, listId);
  }

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
