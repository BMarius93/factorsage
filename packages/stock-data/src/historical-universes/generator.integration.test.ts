import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient, SecurityType } from "@intrinsic/database";
import type { LocalDate } from "@intrinsic/domain";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replaceDividendEvents } from "../dividends.js";
import { loadProtectedTierSecurityIds } from "../index-membership/prisma-store.js";
import { addCalendarDays } from "./engine.js";
import {
  generateHistoricalUniverses,
  loadGenerationPeriods,
} from "./generator.js";

// Before any PrismaClient in this file is constructed.
useTestDatabase();

/**
 * The generator end to end over a small synthetic Dow Jones index in PostgreSQL: thirty lines, one
 * of them a constituent the provider holds nothing for, one member whose dividends were never
 * ingested, two members priced only from 2019, and one that leaves the index and returns.
 *
 * - Dogs of the Dow ranks by indicated yield, which rises with the member's number.
 * - Small Dogs takes the five lowest as-traded prices of the Dogs; member 29 split 4-for-1 in 2022, so
 *   its stored (split-adjusted) price is low throughout but its as-traded price is not before 2022.
 */

const prisma = new PrismaClient();
const RUN = randomUUID().slice(0, 8);
const KEYS = [
  "dogs-of-the-dow",
  "small-dogs-of-the-dow",
  "dow30-top10-momentum",
] as const;
const FIRST = "2018-01-02";
const LAST = "2026-09-30";
const LATE_PRICED = new Set([3, 4]);
const NOT_INGESTED = 1;
const SPLIT_MEMBER = 29;
const RETURNING = 25;
const securities: string[] = [];

function weekdays(from: string, to: string): LocalDate[] {
  const sessions: LocalDate[] = [];
  for (let day = from as LocalDate; day <= to; day = addCalendarDays(day, 1)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) sessions.push(day);
  }
  return sessions;
}

const at = (date: string) => new Date(`${date}T00:00:00.000Z`);

/** Member `n`'s stored close: flat, so yield ranks by dividend; momentum rises with `n`. */
function closeOf(member: number, index: number): number {
  const base = member === SPLIT_MEMBER ? 15 : 20 + member;
  return base * (1 + (member / 3000) * (index / 252));
}

async function cleanUp(): Promise<void> {
  await prisma.historicalUniverse.deleteMany({
    where: { key: { in: [...KEYS, "sp500-sector-energy"] } },
  });
  await prisma.historicalUniverseGeneration.deleteMany({
    where: { universeKey: { in: [...KEYS, "sp500-sector-energy"] } },
  });
  await prisma.indexConstituent.deleteMany({ where: { indexKey: "DOW30" } });
  await prisma.indexMembershipSync.deleteMany({ where: { indexKey: "DOW30" } });
  if (securities.length > 0) {
    await prisma.security.deleteMany({ where: { id: { in: securities } } });
  }
}

async function addPrices(
  securityId: string,
  member: number,
  sessions: readonly LocalDate[],
  offset: number,
) {
  const rows = sessions.map((session, index) => {
    const close = new Prisma.Decimal(
      closeOf(member, offset + index).toFixed(6),
    );
    return {
      securityId,
      date: at(session),
      open: close,
      high: close,
      low: close,
      close,
      volume: BigInt(1_000_000 + member * 1_000),
    };
  });
  for (let start = 0; start < rows.length; start += 5_000) {
    await prisma.dailyPrice.createMany({
      data: rows.slice(start, start + 5_000),
    });
  }
}

beforeAll(async () => {
  await cleanUp();
  const sessions = weekdays(FIRST, LAST);
  const sync = await prisma.indexMembershipSync.create({
    data: {
      indexKey: "DOW30",
      status: "COMPLETED",
      algorithmVersion: 1,
      completedAt: new Date(),
      sourceDigest: `digest-${RUN}`,
    },
  });
  for (let member = 1; member <= 29; member += 1) {
    const security = await prisma.security.create({
      data: {
        providerSymbol: `HU${RUN}${member}`.toUpperCase(),
        symbol: `HU${RUN}${member}`.toUpperCase(),
        name: `Historical Universe Member ${member}`,
        exchangeCode: "NYSE",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    securities.push(security.id);
    const priced = LATE_PRICED.has(member)
      ? sessions.filter((session) => session >= "2019-03-01")
      : sessions;
    await addPrices(
      security.id,
      member,
      priced,
      sessions.length - priced.length,
    );
    if (member === SPLIT_MEMBER) {
      await prisma.stockSplit.create({
        data: {
          securityId: security.id,
          date: at("2022-06-06"),
          numerator: new Prisma.Decimal(4),
          denominator: new Prisma.Decimal(1),
          label: "stock-split",
        },
      });
    }
    if (member !== NOT_INGESTED) {
      const quarterly = Array.from({ length: 40 }, (_, quarter) => {
        const exDate = addCalendarDays(
          "2016-02-10" as LocalDate,
          Math.round(quarter * 91.3),
        );
        return {
          exDate,
          recordDate: null,
          paymentDate: null,
          declarationDate: addCalendarDays(exDate, -20),
          amount: member * 0.01,
          adjustedAmount: member * 0.01,
          frequency: "Quarterly",
        };
      });
      await replaceDividendEvents(prisma, {
        securityId: security.id,
        rows: quarterly,
        syncedAt: new Date(),
      });
    }
    const periods =
      member === RETURNING
        ? [
            {
              startDate: null,
              endDate: at("2022-06-15"),
              quality: "START_BEFORE_LOG" as const,
            },
            {
              startDate: at("2024-03-01"),
              endDate: null,
              quality: "CONFIRMED" as const,
            },
          ]
        : [
            {
              startDate: null,
              endDate: null,
              quality: "START_BEFORE_LOG" as const,
            },
          ];
    await prisma.indexConstituent.create({
      data: {
        indexKey: "DOW30",
        constituentKey: `TEST:${RUN}:${member}`,
        origin: "CURRENT",
        ticker: security.symbol,
        name: security.name,
        tickerHistory: [],
        securityId: security.id,
        resolution: "RESOLVED",
        syncId: sync.id,
        periods: { create: periods },
      },
    });
  }
  // A line the provider holds nothing for: it counts against coverage, never as a candidate.
  await prisma.indexConstituent.create({
    data: {
      indexKey: "DOW30",
      constituentKey: `TEST:${RUN}:unresolved`,
      origin: "CURRENT",
      ticker: "GONE",
      name: "Unpriced Former Member",
      tickerHistory: [],
      resolution: "NO_PROVIDER_DATA",
      syncId: sync.id,
      periods: {
        create: [
          { startDate: null, endDate: null, quality: "START_BEFORE_LOG" },
        ],
      },
    },
  });
}, 120_000);

afterAll(async () => {
  await cleanUp();
  await prisma.$disconnect();
});

const member = (n: number) => securities[n - 1] as string;

describe("historical universe generator", () => {
  it("ranks, measures, validates and stores each universe", async () => {
    const outcomes = await generateHistoricalUniverses({
      prisma,
      keys: [...KEYS, "sp500-sector-energy"],
    });
    const byKey = new Map(outcomes.map((outcome) => [outcome.key, outcome]));

    // A sector universe needs a historical classification no V1 source provides.
    expect(byKey.get("sp500-sector-energy")).toMatchObject({
      outcome: "BLOCKED",
    });
    expect(
      await prisma.historicalUniverse.findUnique({
        where: { key: "sp500-sector-energy" },
      }),
    ).toMatchObject({ status: "BLOCKED", latestGenerationId: null });

    const dogs = byKey.get("dogs-of-the-dow");
    if (dogs?.outcome !== "GENERATED") throw new Error("dogs not generated");
    // December 2018 fails: two members unpriced and one line unresolved leave 26 of 30 with data.
    expect(
      dogs.validation.byYear.find((entry) => entry.year === "2018")?.failing,
    ).toBe(1);
    expect(dogs.validation.reliableFrom).toBe("2019-12-31");
    expect(dogs.validation.publishFrom).toBe("2020-01-01");
    expect(dogs.validation.verdict).toBe("VALIDATED");
    expect(dogs.summary.peakSimultaneousMembers).toBe(10);

    const generation =
      await prisma.historicalUniverseGeneration.findUniqueOrThrow({
        where: { id: dogs.generationId },
      });
    const diagnostics = generation.diagnostics as unknown as {
      date: string;
      parentLines: number;
      withData: number;
      unavailable: Record<string, number>;
    }[];
    const december2020 = diagnostics.find(
      (entry) => entry.date === "2020-12-31",
    );
    expect(december2020).toMatchObject({
      parentLines: 30,
      withData: 28,
      unavailable: { DIVIDENDS_NOT_INGESTED: 1 },
    });

    // The ten highest yields; member 25 left the index in June 2022 and is no candidate while out.
    const selections = await prisma.historicalUniverseSelection.findMany({
      where: {
        generationId: dogs.generationId,
        reconstitutionDate: at("2022-12-30"),
      },
      orderBy: { rank: "asc" },
    });
    expect(selections.map((row) => row.securityId)).toEqual(
      [29, 28, 27, 26, 24, 23, 22, 21, 20, 19].map(member),
    );
    expect(selections[0]?.effectiveDate.toISOString().slice(0, 10)).toBe(
      "2022-12-31",
    );

    // Small Dogs is never reliable before the Dogs it is drawn from.
    const small = byKey.get("small-dogs-of-the-dow");
    if (small?.outcome !== "GENERATED")
      throw new Error("small dogs not generated");
    expect(small.validation.reliableFrom).toBe("2019-12-31");
  }, 300_000);

  it("clips a member's selection to its parent membership and re-admits it on return", async () => {
    const periodsOf = async (key: string) => {
      const universe = await prisma.historicalUniverse.findUniqueOrThrow({
        where: { key },
      });
      return loadGenerationPeriods(
        prisma,
        universe.latestGenerationId as string,
      );
    };
    const dogs = await periodsOf("dogs-of-the-dow");
    // Selected from December 2018, out of the index from 2022-06-16, selected again in December 2024.
    expect(dogs.get(member(RETURNING))).toEqual([
      { startDate: "2019-01-01", endDate: "2022-06-15" },
      { startDate: "2025-01-01", endDate: null },
    ]);
    expect(dogs.get(member(20))).toEqual([
      { startDate: "2019-01-01", endDate: null },
    ]);
    // Monthly: re-admitted at the first month-end after it rejoined.
    const momentum = await periodsOf("dow30-top10-momentum");
    expect(momentum.get(member(RETURNING))).toEqual([
      { startDate: "2019-01-01", endDate: "2022-06-15" },
      { startDate: "2024-03-30", endDate: null },
    ]);
    expect(momentum.has(member(7))).toBe(false);
  });

  it("reads the as-traded price for Small Dogs, from the Dogs' own selection", async () => {
    const universe = await prisma.historicalUniverse.findUniqueOrThrow({
      where: { key: "small-dogs-of-the-dow" },
    });
    const ranked = async (date: string) =>
      (
        await prisma.historicalUniverseSelection.findMany({
          where: {
            generationId: universe.latestGenerationId as string,
            reconstitutionDate: at(date),
          },
          orderBy: { rank: "asc" },
        })
      ).map((row) => row.securityId);
    // Before its split, member 29 traded at four times its stored price: not one of the cheapest.
    expect(await ranked("2021-12-31")).toEqual(
      [20, 21, 22, 23, 24].map(member),
    );
    // After it, it is the cheapest Dog; member 25 is out of the index, so 19 is a Dog.
    expect(await ranked("2022-12-30")).toEqual(
      [29, 19, 20, 21, 22].map(member),
    );
  });

  it("writes nothing when rerun over unchanged data, and one generation when new sessions arrive", async () => {
    const before = await prisma.historicalUniverseGeneration.count({
      where: { universeKey: { in: [...KEYS] } },
    });
    const rerun = await generateHistoricalUniverses({
      prisma,
      keys: [...KEYS],
    });
    expect(rerun.map((outcome) => outcome.outcome)).toEqual([
      "UNCHANGED",
      "UNCHANGED",
      "UNCHANGED",
    ]);
    expect(
      await prisma.historicalUniverseGeneration.count({
        where: { universeKey: { in: [...KEYS] } },
      }),
    ).toBe(before);

    // October's first sessions complete September: the monthly universe gains a reconstitution.
    const october = weekdays("2026-10-01", "2026-10-06");
    const offset = weekdays(FIRST, LAST).length;
    for (let n = 1; n <= 29; n += 1) {
      await addPrices(member(n), n, october, offset);
    }
    const incremental = await generateHistoricalUniverses({
      prisma,
      keys: [...KEYS],
    });
    const outcomeOf = (key: string) =>
      incremental.find((outcome) => outcome.key === key)?.outcome;
    expect(outcomeOf("dow30-top10-momentum")).toBe("GENERATED");
    expect(outcomeOf("dogs-of-the-dow")).toBe("UNCHANGED");
    const momentum = incremental.find(
      (outcome) => outcome.key === "dow30-top10-momentum",
    );
    expect(
      momentum?.outcome === "GENERATED"
        ? momentum.summary.lastReconstitution
        : null,
    ).toBe("2026-09-30");
    // The superseded generation is gone with its rows; the unpublished universe keeps one.
    expect(
      await prisma.historicalUniverseGeneration.count({
        where: { universeKey: "dow30-top10-momentum" },
      }),
    ).toBe(1);
  }, 300_000);

  it("never admits a constituent of an unprotected index to the protected tier", async () => {
    const eligible = new Set(await loadProtectedTierSecurityIds(prisma));
    expect(securities.some((id) => eligible.has(id))).toBe(false);
  });
});
