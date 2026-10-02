import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type { StockSplit } from "@intrinsic/domain";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaStockDataStore } from "./prisma-store.js";

/**
 * The provider's split list in PostgreSQL (`docs/decisions/valuation-ratios-v1.md`).
 *
 * The rules that read it are pinned by `valuation-ratios.test.ts`, and the loader's ingestion by
 * `service.test.ts`. These cases prove what only the real store can: that a read replaces the whole
 * list with its freshness in one transaction, and that two concurrent reads leave one list.
 */

loadRootEnv();
useTestDatabase();

describe("the stored split list", () => {
  const prisma = new PrismaClient();
  const store = new PrismaStockDataStore(prisma);
  const securityIds: string[] = [];

  async function createSecurity(): Promise<string> {
    const symbol = `SP${randomUUID().slice(0, 8).toUpperCase()}`;
    const created = await prisma.security.create({
      data: {
        providerSymbol: symbol,
        symbol,
        name: `${symbol} Corp`,
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    securityIds.push(created.id);
    return created.id;
  }

  function split(
    securityId: string,
    date: string,
    numerator: number,
    denominator: number,
    label: string | null = "stock-split",
  ): StockSplit {
    return { securityId, date, numerator, denominator, label };
  }

  afterAll(async () => {
    await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
    await prisma.$disconnect();
  });

  it("replaces the whole list and records the read, oldest first and exact", async () => {
    const securityId = await createSecurity();
    await store.replaceStockSplits({
      securityId,
      splits: [
        split(securityId, "2021-11-04", 523, 500),
        split(securityId, "1999-05-27", 2, 1),
      ],
      syncedAt: "2026-10-01T12:00:00.000Z",
    });
    expect(await store.getStockSplits(securityId)).toEqual([
      split(securityId, "1999-05-27", 2, 1),
      split(securityId, "2021-11-04", 523, 500),
    ]);

    // The provider corrected one entry and dropped the other: the stored list follows it whole.
    await store.replaceStockSplits({
      securityId,
      splits: [split(securityId, "2021-11-04", 1907, 2000, "spin-off")],
      syncedAt: "2026-10-02T12:00:00.000Z",
    });
    expect(await store.getStockSplits(securityId)).toEqual([
      split(securityId, "2021-11-04", 1907, 2000, "spin-off"),
    ]);
    const state = await store.getDatasetState(securityId, "STOCK_SPLIT", "");
    expect(state?.lastSyncedAt).toBe("2026-10-02T12:00:00.000Z");

    // An empty list is a list: nothing listed, read now.
    await store.replaceStockSplits({
      securityId,
      splits: [],
      syncedAt: "2026-10-03T12:00:00.000Z",
    });
    expect(await store.getStockSplits(securityId)).toEqual([]);
    expect(
      (await store.getDatasetState(securityId, "STOCK_SPLIT", ""))
        ?.lastSyncedAt,
    ).toBe("2026-10-03T12:00:00.000Z");
  });

  it("leaves one list when two reads replace it at once", async () => {
    const securityId = await createSecurity();
    const splits = [
      split(securityId, "2020-08-31", 4, 1),
      split(securityId, "2014-06-09", 7, 1),
    ];
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        store.replaceStockSplits({
          securityId,
          splits,
          syncedAt: `2026-10-01T12:00:0${index}.000Z`,
        }),
      ),
    );
    expect(await store.getStockSplits(securityId)).toHaveLength(2);
  });
});
