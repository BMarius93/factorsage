import { BuyWindowMode, ContentOwnership, type PrismaClient } from "@intrinsic/database";
import type { PointInTimeIndexUniverse } from "@intrinsic/domain";
import type { ProjectedIndexListMember } from "@intrinsic/stock-data";

/**
 * Writes a point-in-time universe's built-in List from its canonical membership
 * (`docs/decisions/sp500-historical-pit-v1.md` §5).
 *
 * The List is a projection, not an editor's content: its members and their windows are exactly the
 * projection, in one transaction, every time. A member whose windows are unchanged is left alone (so
 * a re-projection of an unchanged membership writes nothing but the audit stamp), a member that
 * changed has its windows replaced whole, and a security the membership no longer carries is
 * removed. Backtests already submitted are unaffected: a run snapshots the List when it is
 * submitted, never reads it again.
 */
export async function writeIndexUniverseList(input: {
  readonly prisma: PrismaClient;
  readonly universe: PointInTimeIndexUniverse;
  readonly members: readonly ProjectedIndexListMember[];
}): Promise<{
  listId: string;
  added: number;
  changed: number;
  unchanged: number;
  removed: number;
  windows: number;
}> {
  const { universe, members } = input;
  return input.prisma.$transaction(
    async (tx) => {
      const list = await tx.stockList.upsert({
        where: { systemKey: universe.listSystemKey },
        create: {
          ownership: ContentOwnership.SYSTEM,
          systemKey: universe.listSystemKey,
          name: universe.listName,
          description: universe.listDescription,
          displayOrder: 0,
        },
        update: {
          name: universe.listName,
          description: universe.listDescription,
        },
        select: { id: true },
      });
      const existing = await tx.stockListItem.findMany({
        where: { stockListId: list.id },
        include: { buyWindows: { orderBy: { startDate: "asc" } } },
      });
      const bySecurity = new Map(existing.map((item) => [item.securityId, item]));
      const wanted = new Set(members.map((member) => member.securityId));

      const removedIds = existing
        .filter((item) => !wanted.has(item.securityId))
        .map((item) => item.id);
      if (removedIds.length > 0) {
        await tx.stockListItem.deleteMany({ where: { id: { in: removedIds } } });
      }

      let added = 0;
      let changed = 0;
      let unchanged = 0;
      const windowsToCreate: {
        stockListItemId: string;
        startDate: Date;
        endDate: Date | null;
      }[] = [];
      const replaceFor: string[] = [];
      const fresh = members.filter((member) => !bySecurity.has(member.securityId));
      if (fresh.length > 0) {
        await tx.stockListItem.createMany({
          data: fresh.map((member) => ({
            stockListId: list.id,
            securityId: member.securityId,
            buyWindowMode: BuyWindowMode.CUSTOM,
          })),
        });
        added = fresh.length;
      }
      const items = new Map(
        (
          await tx.stockListItem.findMany({
            where: { stockListId: list.id },
            select: { id: true, securityId: true },
          })
        ).map((item) => [item.securityId, item.id]),
      );
      for (const member of members) {
        const previous = bySecurity.get(member.securityId);
        const itemId = items.get(member.securityId) as string;
        if (previous) {
          const same =
            previous.buyWindowMode === BuyWindowMode.CUSTOM &&
            previous.buyWindows.length === member.ranges.length &&
            previous.buyWindows.every((window, index) => {
              const range = member.ranges[index];
              return (
                range !== undefined &&
                iso(window.startDate) === range.startDate &&
                (window.endDate === null ? null : iso(window.endDate)) === range.endDate
              );
            });
          if (same) {
            unchanged += 1;
            continue;
          }
          changed += 1;
          replaceFor.push(itemId);
          if (previous.buyWindowMode !== BuyWindowMode.CUSTOM) {
            await tx.stockListItem.update({
              where: { id: itemId },
              data: { buyWindowMode: BuyWindowMode.CUSTOM },
            });
          }
        }
        for (const range of member.ranges) {
          windowsToCreate.push({
            stockListItemId: itemId,
            startDate: new Date(`${range.startDate}T00:00:00.000Z`),
            endDate: range.endDate === null ? null : new Date(`${range.endDate}T00:00:00.000Z`),
          });
        }
      }
      for (let offset = 0; offset < replaceFor.length; offset += 500) {
        await tx.stockListBuyWindow.deleteMany({
          where: { stockListItemId: { in: replaceFor.slice(offset, offset + 500) } },
        });
      }
      for (let offset = 0; offset < windowsToCreate.length; offset += 500) {
        await tx.stockListBuyWindow.createMany({
          data: windowsToCreate.slice(offset, offset + 500),
        });
      }
      await tx.stockList.update({
        where: { id: list.id },
        data: { updatedAt: new Date() },
      });
      return {
        listId: list.id,
        added,
        changed,
        unchanged,
        removed: removedIds.length,
        windows: members.reduce((total, member) => total + member.ranges.length, 0),
      };
    },
    { timeout: 120_000 },
  );
}

function iso(value: Date): string {
  return value.toISOString().slice(0, 10);
}
