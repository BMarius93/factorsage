import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@intrinsic/database";
import type { LocalDate } from "@intrinsic/domain";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clipPeriods,
  parseHistoricalUniversesArguments,
  publishFloorOf,
  publishHistoricalUniverse,
  PublicationRefusedError,
} from "./historical-universes";
import { runDividendIngestion } from "./index-universe/index-universe-dividends";

// Before any PrismaClient in this file is constructed.
useTestDatabase();

const prisma = new PrismaClient();
const RUN = randomUUID().slice(0, 8);
const KEY = "sp500-top100-market-cap";
const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};
const securities: string[] = [];
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

async function cleanUp() {
  await prisma.stockList.deleteMany({ where: { systemKey: KEY } });
  await prisma.historicalUniverse.deleteMany({
    where: { key: { in: [KEY, "sp500-top25-market-cap"] } },
  });
  await prisma.historicalUniverseGeneration.deleteMany({
    where: { universeKey: { in: [KEY, "sp500-top25-market-cap"] } },
  });
  await prisma.indexConstituent.deleteMany({
    where: { constituentKey: { startsWith: `HU-TEST:${RUN}` } },
  });
  if (securities.length > 0) {
    await prisma.security.deleteMany({ where: { id: { in: securities } } });
  }
}

/** A generation of `KEY` with a validation and two securities' periods. */
async function generation(validation: Record<string, unknown>) {
  const created = await prisma.historicalUniverseGeneration.create({
    data: {
      universeKey: KEY,
      methodologyVersion: 1,
      engineVersion: 1,
      status: "COMPLETED",
      inputDigest: randomUUID(),
      completedAt: new Date(),
      validation: validation as Prisma.InputJsonValue,
      periods: {
        create: [
          {
            securityId: securities[0] as string,
            startDate: day("2010-01-01"),
            endDate: day("2015-06-30"),
          },
          {
            securityId: securities[0] as string,
            startDate: day("2016-01-01"),
            endDate: null,
          },
          {
            securityId: securities[1] as string,
            startDate: day("2012-01-01"),
            endDate: day("2014-12-31"),
          },
        ],
      },
    },
  });
  await prisma.historicalUniverse.upsert({
    where: { key: KEY },
    create: {
      key: KEY,
      status: "DRAFT",
      methodologyVersion: 1,
      latestGenerationId: created.id,
    },
    update: { latestGenerationId: created.id },
  });
  return created.id;
}

beforeAll(async () => {
  await cleanUp();
  for (const index of [1, 2]) {
    const security = await prisma.security.create({
      data: {
        providerSymbol: `HUP${RUN}${index}`.toUpperCase(),
        symbol: `HUP${RUN}${index}`.toUpperCase(),
        name: `Publication Test ${index}`,
        exchangeCode: "NYSE",
        currency: "USD",
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    securities.push(security.id);
  }
});

afterAll(async () => {
  await cleanUp();
  await prisma.$disconnect();
});

describe("historical universes command", () => {
  it("parses its commands and refuses an unknown universe", () => {
    expect(
      parseHistoricalUniversesArguments([
        "generate",
        "--keys",
        "dogs-of-the-dow",
      ]).keys,
    ).toEqual(["dogs-of-the-dow"]);
    expect(
      parseHistoricalUniversesArguments(["generate", "--catalog"]).keys,
    ).toHaveLength(23);
    expect(parseHistoricalUniversesArguments(["publish", KEY]).keys).toEqual([
      KEY,
    ]);
    expect(() => parseHistoricalUniversesArguments(["generate"])).toThrow(
      /needs universes/,
    );
    expect(() =>
      parseHistoricalUniversesArguments(["publish", "no-such-universe"]),
    ).toThrow(/No historical universe/);
  });

  it("starts a derived universe's List at its reliable period, and the S&P 500's at its floor", () => {
    expect(
      publishFloorOf({ key: KEY } as never, { publishFrom: "2015-01-01" }),
    ).toBe("2015-01-01");
    expect(
      publishFloorOf({ key: "sp500-historical-pit" } as never, {
        publishFrom: "2016-01-01",
      }),
    ).toBe("1996-01-02");
    const clipped = clipPeriods(
      new Map([
        [
          "a",
          [
            {
              startDate: "2010-01-01" as LocalDate,
              endDate: "2014-12-31" as LocalDate,
            },
          ],
        ],
        ["b", [{ startDate: "2012-01-01" as LocalDate, endDate: null }]],
      ]),
      "2015-01-01" as LocalDate,
    );
    expect([...clipped.entries()]).toEqual([
      ["b", [{ startDate: "2015-01-01", endDate: null }]],
    ]);
  });

  it("refuses a blocked universe with its reason", async () => {
    await prisma.historicalUniverse.upsert({
      where: { key: "sp500-sector-energy" },
      create: {
        key: "sp500-sector-energy",
        status: "BLOCKED",
        methodologyVersion: 1,
        statusReasons: [
          {
            code: "DATA_UNAVAILABLE",
            detail: "HISTORICAL_SECTOR_CLASSIFICATION",
          },
        ],
      },
      update: {},
    });
    try {
      await expect(
        publishHistoricalUniverse({
          prisma,
          key: "sp500-sector-energy",
          logger: silent,
        }),
      ).rejects.toThrow(/is blocked: .*HISTORICAL_SECTOR_CLASSIFICATION/);
    } finally {
      await prisma.historicalUniverse.delete({
        where: { key: "sp500-sector-energy" },
      });
    }
  });

  it("refuses an internal universe, a missing generation and a draft", async () => {
    await expect(
      publishHistoricalUniverse({
        prisma,
        key: "sp500-top25-market-cap",
        logger: silent,
      }),
    ).rejects.toThrow(/internal research universe/);
    await expect(
      publishHistoricalUniverse({ prisma, key: KEY, logger: silent }),
    ).rejects.toThrow(PublicationRefusedError);
    await generation({
      verdict: "DRAFT",
      reliableFrom: null,
      publishFrom: null,
      reasons: [{ code: "NO_RELIABLE_PERIOD", detail: "test" }],
    });
    await expect(
      publishHistoricalUniverse({ prisma, key: KEY, logger: silent }),
    ).rejects.toThrow(/did not validate/);
    expect(await prisma.stockList.count({ where: { systemKey: KEY } })).toBe(0);
  });

  it("projects a validated generation into its List from its reliable period", async () => {
    const generationId = await generation({
      verdict: "VALIDATED",
      reliableFrom: "2014-12-31",
      publishFrom: "2015-01-01",
      reasons: [],
    });
    const published = await publishHistoricalUniverse({
      prisma,
      key: KEY,
      logger: silent,
    });
    expect(published).toMatchObject({
      key: KEY,
      generationId,
      publishFrom: "2015-01-01",
      distinctSecurities: 1,
      peakSimultaneousMembers: 1,
    });
    const list = await prisma.stockList.findUniqueOrThrow({
      where: { systemKey: KEY },
      include: {
        items: { include: { buyWindows: { orderBy: { startDate: "asc" } } } },
      },
    });
    expect(list).toMatchObject({
      ownership: "SYSTEM",
      premium: true,
      name: "S&P 500 Top 100 by Market Cap",
    });
    // The second security's membership ended before the reliable period: it is not in the List.
    expect(list.items.map((item) => item.securityId)).toEqual([securities[0]]);
    expect(
      list.items[0]?.buyWindows.map((window) => [
        window.startDate.toISOString().slice(0, 10),
        window.endDate?.toISOString().slice(0, 10) ?? null,
      ]),
    ).toEqual([
      ["2015-01-01", "2015-06-30"],
      ["2016-01-01", null],
    ]);
    expect(
      await prisma.historicalUniverse.findUniqueOrThrow({
        where: { key: KEY },
      }),
    ).toMatchObject({
      status: "PUBLISHED",
      publishedGenerationId: generationId,
    });
  });
});

describe("dividend ingestion", () => {
  it("stores each security's history once, resumes where it stopped, and reports failures", async () => {
    const sync = await prisma.indexMembershipSync.create({
      data: {
        indexKey: "DOW30",
        status: "COMPLETED",
        algorithmVersion: 1,
        completedAt: new Date(),
      },
    });
    for (const [index, securityId] of securities.entries()) {
      await prisma.indexConstituent.create({
        data: {
          indexKey: "DOW30",
          constituentKey: `HU-TEST:${RUN}:${index}`,
          origin: "CURRENT",
          ticker: `T${index}`,
          name: `T${index}`,
          tickerHistory: [],
          securityId,
          resolution: "RESOLVED",
          syncId: sync.id,
        },
      });
    }
    const asked: string[] = [];
    const provider = (failing: string | null) => ({
      getDividends: async (symbol: string) => {
        asked.push(symbol);
        if (symbol === failing) {
          throw new Error("provider unavailable");
        }
        return {
          rows: [
            {
              exDate: "2024-02-09",
              recordDate: null,
              paymentDate: null,
              declarationDate: "2024-01-25",
              amount: 0.5,
              adjustedAmount: 0.25,
              frequency: "Quarterly",
            },
          ],
          dropped: 0,
        };
      },
    });
    const run = (failing: string | null) =>
      runDividendIngestion({
        prisma,
        indexKeys: ["DOW30"],
        provider: provider(failing),
        refresh: false,
        symbols: null,
        limit: null,
        concurrency: 1,
        logger: silent as never,
        shouldStop: () => false,
      });
    const symbols = (
      await prisma.security.findMany({
        where: { id: { in: securities } },
        orderBy: { providerSymbol: "asc" },
      })
    ).map((row) => row.providerSymbol);
    try {
      const first = await run(symbols[1] as string);
      expect(first).toMatchObject({
        selected: 2,
        succeeded: 1,
        failed: 1,
        rowsStored: 1,
      });
      expect(first.failures[0]?.error).toContain("provider unavailable");
      // The second run asks only for the security not yet synchronized.
      asked.length = 0;
      const second = await run(null);
      expect(second).toMatchObject({
        alreadySynchronized: 1,
        selected: 1,
        succeeded: 1,
      });
      expect(asked).toEqual([symbols[1]]);
      expect(
        await prisma.dividendEvent.count({
          where: { securityId: { in: securities } },
        }),
      ).toBe(2);
      const third = await run(null);
      expect(third.selected).toBe(0);
    } finally {
      await prisma.dividendEvent.deleteMany({
        where: { securityId: { in: securities } },
      });
      await prisma.stockDatasetState.deleteMany({
        where: { securityId: { in: securities } },
      });
      await prisma.indexConstituent.deleteMany({
        where: { constituentKey: { startsWith: `HU-TEST:${RUN}` } },
      });
      await prisma.indexMembershipSync.delete({ where: { id: sync.id } });
    }
  });
});
