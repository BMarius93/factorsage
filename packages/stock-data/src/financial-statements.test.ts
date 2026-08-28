import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import { describe, expect, it } from "vitest";
import { PrismaStockDataStore } from "./prisma-store.js";

loadRootEnv();

const describeInfrastructure = process.env.DATABASE_URL
  ? describe
  : describe.skip;

function statement(overrides: Record<string, unknown> = {}) {
  return {
    securityId: "security-1",
    statementType: "INCOME" as const,
    fiscalDate: "2020-03-31",
    fiscalYear: 2020,
    period: "Q1" as const,
    reportedCurrency: "USD",
    filingDate: "2020-04-20",
    values: { revenue: 100 },
    ...overrides,
  };
}

describeInfrastructure("financial statement persistence", () => {
  it("deduplicates unchanged rows and keeps the initial PIT availability one day after filing", async () => {
    const prisma = new PrismaClient();
    const suffix = randomUUID();
    const symbol = `F${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    let securityId: string | undefined;
    try {
      const security = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Financial Statement Dedup Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;
      const store = new PrismaStockDataStore(prisma);

      await expect(
        store.saveFinancialStatements({
          securityId,
          statements: [statement({ securityId })],
          syncedAt: "2020-04-20T16:00:00.000Z",
        }),
      ).resolves.toEqual({ insertedRevisionCount: 1, unchangedCount: 0 });

      await expect(
        store.saveFinancialStatements({
          securityId,
          statements: [statement({ securityId })],
          syncedAt: "2020-04-21T16:00:00.000Z",
        }),
      ).resolves.toEqual({ insertedRevisionCount: 0, unchangedCount: 1 });

      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
          asOf: "2020-04-20",
        }),
      ).resolves.toEqual([]);
      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
          asOf: "2020-04-21",
        }),
      ).resolves.toHaveLength(1);
    } finally {
      if (securityId) {
        await prisma.security.deleteMany({ where: { id: securityId } });
      }
      await prisma.$disconnect();
    }
  });

  it("preserves filing-date revisions and prevents same-filing-date changes from backdating before observedAt", async () => {
    const prisma = new PrismaClient();
    const suffix = randomUUID();
    const symbol = `R${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    let securityId: string | undefined;
    try {
      const security = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Financial Statement Revision Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;
      const store = new PrismaStockDataStore(prisma);

      await store.saveFinancialStatements({
        securityId,
        statements: [
          statement({
            securityId,
            filingDate: "2020-04-20",
            reportedCurrency: "USD",
            values: { revenue: 100 },
          }),
        ],
        syncedAt: "2020-04-20T16:00:00.000Z",
      });
      await store.saveFinancialStatements({
        securityId,
        statements: [
          statement({
            securityId,
            filingDate: "2020-05-20",
            values: { revenue: 200 },
          }),
        ],
        syncedAt: "2020-05-21T16:00:00.000Z",
      });

      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
        }),
      ).resolves.toMatchObject([{ values: { revenue: 200 } }]);
      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
          asOf: "2020-05-01",
        }),
      ).resolves.toMatchObject([{ values: { revenue: 100 } }]);

      await store.saveFinancialStatements({
        securityId,
        statements: [
          statement({
            securityId,
            filingDate: "2020-04-20",
            values: { revenue: 300 },
          }),
        ],
        syncedAt: "2020-04-25T16:00:00.000Z",
      });

      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
          asOf: "2020-04-24",
        }),
      ).resolves.toMatchObject([{ values: { revenue: 100 } }]);
      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
          asOf: "2020-04-25",
        }),
      ).resolves.toMatchObject([{ values: { revenue: 300 } }]);
    } finally {
      if (securityId) {
        await prisma.security.deleteMany({ where: { id: securityId } });
      }
      await prisma.$disconnect();
    }
  });

  it("treats changed content with an earlier filing date as observed-later availability", async () => {
    const prisma = new PrismaClient();
    const suffix = randomUUID();
    const symbol = `E${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    let securityId: string | undefined;
    try {
      const security = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Financial Statement Earlier Filing Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;
      const store = new PrismaStockDataStore(prisma);

      await store.saveFinancialStatements({
        securityId,
        statements: [
          statement({
            securityId,
            filingDate: "2020-05-20",
            values: { revenue: 200 },
          }),
        ],
        syncedAt: "2020-05-21T16:00:00.000Z",
      });

      await store.saveFinancialStatements({
        securityId,
        statements: [
          statement({
            securityId,
            filingDate: "2020-04-20",
            values: { revenue: 300 },
          }),
        ],
        syncedAt: "2020-06-01T09:00:00.000Z",
      });

      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
          asOf: "2020-05-31",
        }),
      ).resolves.toMatchObject([{ values: { revenue: 200 } }]);
      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
          asOf: "2020-06-01",
        }),
      ).resolves.toMatchObject([{ values: { revenue: 300 } }]);
    } finally {
      if (securityId) {
        await prisma.security.deleteMany({ where: { id: securityId } });
      }
      await prisma.$disconnect();
    }
  });

  it("applies same-filing multi-revision batch availability against planned revisions", async () => {
    const prisma = new PrismaClient();
    const suffix = randomUUID();
    const symbol = `M${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    let securityId: string | undefined;
    try {
      const security = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Financial Statement Multi Revision Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;
      const store = new PrismaStockDataStore(prisma);

      await expect(
        store.saveFinancialStatements({
          securityId,
          statements: [
            statement({
              securityId,
              filingDate: "2020-04-20",
              values: { revenue: 100 },
            }),
            statement({
              securityId,
              filingDate: "2020-04-20",
              values: { revenue: 150 },
            }),
          ],
          syncedAt: "2020-05-10T10:30:00.000Z",
        }),
      ).resolves.toEqual({ insertedRevisionCount: 2, unchangedCount: 0 });

      const rows = await prisma.financialStatement.findMany({
        where: { securityId },
        orderBy: [{ observedAt: "asc" }, { contentHash: "asc" }],
      });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.availableFromDate.toISOString().slice(0, 10)).sort()).toEqual([
        "2020-04-21",
        "2020-05-10",
      ]);

      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
          asOf: "2020-05-09",
        }),
      ).resolves.toMatchObject([{ values: { revenue: 100 } }]);
      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
          asOf: "2020-05-10",
        }),
      ).resolves.toMatchObject([{ values: { revenue: 150 } }]);
    } finally {
      if (securityId) {
        await prisma.security.deleteMany({ where: { id: securityId } });
      }
      await prisma.$disconnect();
    }
  });

  it("computes contentHash independently of securityId", async () => {
    const prisma = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
    const symbolA = `H${suffix}A`;
    const symbolB = `H${suffix}B`;
    let securityIdA: string | undefined;
    let securityIdB: string | undefined;
    try {
      const [securityA, securityB] = await Promise.all([
        prisma.security.create({
          data: {
            providerSymbol: symbolA,
            symbol: symbolA,
            name: "Financial Statement Hash A",
            exchangeCode: "NASDAQ",
            currency: "USD",
            type: SecurityType.STOCK,
            isAdr: false,
            isActivelyTrading: true,
          },
        }),
        prisma.security.create({
          data: {
            providerSymbol: symbolB,
            symbol: symbolB,
            name: "Financial Statement Hash B",
            exchangeCode: "NASDAQ",
            currency: "USD",
            type: SecurityType.STOCK,
            isAdr: false,
            isActivelyTrading: true,
          },
        }),
      ]);
      securityIdA = securityA.id;
      securityIdB = securityB.id;
      const store = new PrismaStockDataStore(prisma);

      await store.saveFinancialStatements({
        securityId: securityIdA,
        statements: [statement({ securityId: securityIdA })],
        syncedAt: "2020-04-20T16:00:00.000Z",
      });
      await store.saveFinancialStatements({
        securityId: securityIdB,
        statements: [statement({ securityId: securityIdB })],
        syncedAt: "2020-04-20T16:00:00.000Z",
      });

      const [rowA, rowB] = await Promise.all([
        prisma.financialStatement.findFirst({ where: { securityId: securityIdA } }),
        prisma.financialStatement.findFirst({ where: { securityId: securityIdB } }),
      ]);
      expect(rowA?.contentHash).toBeTruthy();
      expect(rowA?.contentHash).toBe(rowB?.contentHash);
    } finally {
      if (securityIdA) {
        await prisma.security.deleteMany({ where: { id: securityIdA } });
      }
      if (securityIdB) {
        await prisma.security.deleteMany({ where: { id: securityIdB } });
      }
      await prisma.$disconnect();
    }
  });

  it("rejects statements whose securityId does not match the save input securityId", async () => {
    const prisma = new PrismaClient();
    const suffix = randomUUID();
    const symbol = `S${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    let securityId: string | undefined;
    try {
      const security = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Financial Statement Security Mismatch Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;
      const store = new PrismaStockDataStore(prisma);

      await expect(
        store.saveFinancialStatements({
          securityId,
          statements: [statement({ securityId: "different-security" })],
          syncedAt: "2020-04-20T16:00:00.000Z",
        }),
      ).rejects.toThrow("Financial statement securityId mismatch");
    } finally {
      if (securityId) {
        await prisma.security.deleteMany({ where: { id: securityId } });
      }
      await prisma.$disconnect();
    }
  });
});