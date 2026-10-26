import { randomUUID } from "node:crypto";
import { FMP_STOCK_SECTORS } from "@intrinsic/contracts";
import { Prisma, PrismaClient, SecurityType } from "@intrinsic/database";
import {
  ECONOMIC_SUPERSECTORS,
  type EconomicSupersector,
  type HistoricalUniverseDefinition,
  type LocalDate,
} from "@intrinsic/domain";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

/**
 * The supersector methodology over the same synthetic index, as declarative definitions outside the
 * catalog: the catalog's three draw from the S&P 500, which other suites' fixtures use.
 */
const SUPERSECTORS = Object.keys(
  ECONOMIC_SUPERSECTORS,
) as EconomicSupersector[];
const supersectorKey = (supersector: EconomicSupersector) =>
  `test-${RUN}-${supersector.toLowerCase()}`;
const SUPERSECTOR_DEFINITIONS: HistoricalUniverseDefinition[] =
  SUPERSECTORS.map((supersector, index) => ({
    key: supersectorKey(supersector),
    name: `Test ${supersector}`,
    description: "A synthetic supersector universe.",
    category: "ECONOMIC_SUPERSECTORS",
    audience: "INTERNAL",
    displayOrder: index + 1,
    method: {
      kind: "CLASSIFICATION",
      indexKey: "DOW30",
      scheme: "CURRENT_SECTOR",
      sectors: ECONOMIC_SUPERSECTORS[supersector],
    },
    methodologyVersion: 1,
    methodology: "Test.",
    requires: [
      "INDEX_MEMBERSHIP",
      "DAILY_PRICES",
      "CURRENT_SECTOR_CLASSIFICATION",
    ],
  }));
const ALL_KEYS = [
  ...KEYS,
  "sp500-sector-energy",
  ...SUPERSECTOR_DEFINITIONS.map((definition) => definition.key),
];

async function cleanUp(): Promise<void> {
  await prisma.historicalUniverse.deleteMany({
    where: { key: { in: ALL_KEYS } },
  });
  await prisma.historicalUniverseGeneration.deleteMany({
    where: { universeKey: { in: ALL_KEYS } },
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

/**
 * Members 1–27 take FMP's eleven sectors in turn (member 12's spelled loosely), member 28 has none
 * and member 29 one outside the eleven. So: Cyclical 2, 6, 9, 10, 13, 17, 20, 21, 24; Defensive 4,
 * 7, 8, 15, 18, 19, 26; Sensitive 1, 3, 5, 11, 12, 14, 16, 22, 23, 25, 27. Member 4 is priced only
 * from March 2019 and member 25 leaves the index and returns.
 */
describe("retrospectively classified universes", () => {
  const sectorOf = (n: number): string | null =>
    n === 28
      ? null
      : n === 29
        ? "Conglomerates"
        : n === 12
          ? "  technology "
          : (FMP_STOCK_SECTORS[(n - 1) % 11] as string);
  const CYCLICAL = [2, 6, 9, 10, 13, 17, 20, 21, 24];
  const DEFENSIVE = [4, 7, 8, 15, 18, 19, 26];
  const SENSITIVE = [1, 3, 5, 11, 12, 14, 16, 22, 23, 25, 27];
  const generate = () =>
    generateHistoricalUniverses({
      prisma,
      keys: [],
      definitions: SUPERSECTOR_DEFINITIONS,
    });
  const periodsOf = async (supersector: EconomicSupersector) => {
    const universe = await prisma.historicalUniverse.findUniqueOrThrow({
      where: { key: supersectorKey(supersector) },
    });
    return loadGenerationPeriods(prisma, universe.latestGenerationId as string);
  };
  const outcomeOf = (
    outcomes: Awaited<ReturnType<typeof generate>>,
    supersector: EconomicSupersector,
  ) => {
    const outcome = outcomes.find(
      (entry) => entry.key === supersectorKey(supersector),
    );
    if (outcome?.outcome !== "GENERATED" && outcome?.outcome !== "UNCHANGED") {
      throw new Error(`${supersector} not generated`);
    }
    return outcome;
  };

  beforeAll(async () => {
    for (let n = 1; n <= 29; n += 1) {
      await prisma.security.update({
        where: { id: member(n) },
        data: { sector: sectorOf(n) },
      });
    }
    for (const [n, syncedAt] of [
      [1, "2026-10-23T18:00:00.000Z"],
      [2, "2026-10-24T12:00:00.000Z"],
    ] as const) {
      await prisma.stockDatasetState.create({
        data: {
          securityId: member(n),
          dataset: "SECURITY_PROFILE",
          lastSuccessfulSyncAt: new Date(syncedAt),
        },
      });
    }
  });

  it("holds each classified member in exactly one group, over its own index windows, without a provider call", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("the generator must not call a provider");
    });
    vi.stubGlobal("fetch", fetchSpy);
    let outcomes: Awaited<ReturnType<typeof generate>>;
    try {
      outcomes = await generate();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
      "GENERATED",
      "GENERATED",
      "GENERATED",
    ]);
    const groups = {
      CYCLICAL: await periodsOf("CYCLICAL"),
      DEFENSIVE: await periodsOf("DEFENSIVE"),
      SENSITIVE: await periodsOf("SENSITIVE"),
    };
    expect([...groups.CYCLICAL.keys()].sort()).toEqual(
      CYCLICAL.map(member).sort(),
    );
    expect([...groups.DEFENSIVE.keys()].sort()).toEqual(
      DEFENSIVE.map(member).sort(),
    );
    expect([...groups.SENSITIVE.keys()].sort()).toEqual(
      SENSITIVE.map(member).sort(),
    );
    // Mutually exclusive, and the unclassified are in none.
    const all = Object.values(groups).flatMap((periods) => [...periods.keys()]);
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain(member(28));
    expect(all).not.toContain(member(29));
    // The index's own windows: from the floor, exit and re-entry untouched.
    expect(groups.SENSITIVE.get(member(25))).toEqual([
      { startDate: "1996-01-02", endDate: "2022-06-15" },
      { startDate: "2024-03-01", endDate: null },
    ]);
    expect(groups.CYCLICAL.get(member(2))).toEqual([
      { startDate: "1996-01-02", endDate: null },
    ]);

    // Two of 29 securities unclassified is under the 95 % gate: reported, and not publishable.
    const cyclical = outcomeOf(outcomes, "CYCLICAL");
    expect(cyclical.validation.verdict).toBe("DRAFT");
    expect(cyclical.validation.reasons).toEqual([
      {
        code: "CLASSIFICATION_INCOMPLETE",
        classifiedShare: 0.931,
        minimum: 0.95,
      },
    ]);
    expect(cyclical.summary.classification).toMatchObject({
      source: "FMP_COMPANY_PROFILE_SECTOR",
      timing: "RETROSPECTIVE",
      mappingVersion: 1,
      indexSecurities: 29,
      classifiedSecurities: 27,
      unclassifiedSecurities: 2,
      bySector: {
        FINANCIALS: 3,
        CONSUMER_DISCRETIONARY: 2,
        MATERIALS: 2,
        REAL_ESTATE: 2,
      },
      asOf: {
        earliest: "2026-10-23T18:00:00.000Z",
        latest: "2026-10-24T12:00:00.000Z",
        withoutProfileSync: 25,
      },
    });
    expect(
      cyclical.summary.classification?.unclassified.map((entry) => [
        entry.securityId,
        entry.reason,
        entry.stored,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [member(28), "MISSING", null],
        [member(29), "UNSUPPORTED", "Conglomerates"],
      ]),
    );
  }, 300_000);

  it("reports each checkpoint's classification and the group's own price coverage", async () => {
    const universe = await prisma.historicalUniverse.findUniqueOrThrow({
      where: { key: supersectorKey("DEFENSIVE") },
      include: { latestGeneration: true },
    });
    const diagnostics = universe.latestGeneration?.diagnostics as unknown as {
      date: string;
      parentLines: number;
      parentMembers: number;
      classification: Record<string, number>;
    }[];
    expect(
      diagnostics.find((entry) => entry.date === "2020-12-31"),
    ).toMatchObject({
      parentLines: 30,
      parentMembers: 29,
      classification: {
        classified: 27,
        unclassified: 2,
        groupMembers: 7,
        groupPriced: 7,
      },
    });
    // Member 4 is unpriced until March 2019: six of seven, under 90 %.
    expect(
      diagnostics.find((entry) => entry.date === "2018-12-31"),
    ).toMatchObject({
      classification: { groupMembers: 7, groupPriced: 6 },
    });
    const validation = universe.latestGeneration?.validation as unknown as {
      warnings: { code: string; coveredFrom?: string | null }[];
    };
    expect(validation.warnings.map((warning) => warning.code)).toEqual([
      "RETROSPECTIVE_CLASSIFICATION",
      "UNCLASSIFIED_MEMBERS",
      "INCOMPLETE_PRICE_COVERAGE",
      "SURVIVORSHIP_BIAS",
    ]);
    expect(
      validation.warnings.find(
        (warning) => warning.code === "INCOMPLETE_PRICE_COVERAGE",
      )?.coveredFrom,
    ).toBe("2019-03-29");
    const summary = universe.latestGeneration?.summary as unknown as {
      classification: { byYear: Record<string, unknown>[] };
    };
    expect(
      summary.classification.byYear.find((entry) => entry.year === "2020"),
    ).toMatchObject({ priceCoverage: 1, minPriceCoverage: 1 });
    expect(
      summary.classification.byYear.find((entry) => entry.year === "2018"),
    ).toMatchObject({
      indexLines: 30,
      indexMembers: 29,
      constituentCoverage: 0.9667,
      classifiedShare: 0.931,
      groupMembers: 7,
      // The year's last checkpoint still lacks member 4.
      priceCoverage: 0.8571,
      minPriceCoverage: 0.8571,
    });
  });

  it("writes nothing when rerun, and regenerates when the provider's classification changes", async () => {
    const rerun = await generate();
    expect(rerun.map((outcome) => outcome.outcome)).toEqual([
      "UNCHANGED",
      "UNCHANGED",
      "UNCHANGED",
    ]);

    // Member 29 gains a sector, and member 2 moves from Financial Services to Healthcare.
    await prisma.security.update({
      where: { id: member(29) },
      data: { sector: "Industrials" },
    });
    await prisma.security.update({
      where: { id: member(2) },
      data: { sector: "Healthcare" },
    });
    const changed = await generate();
    expect(changed.map((outcome) => outcome.outcome)).toEqual([
      "GENERATED",
      "GENERATED",
      "GENERATED",
    ]);
    const cyclical = await periodsOf("CYCLICAL");
    const defensive = await periodsOf("DEFENSIVE");
    const sensitive = await periodsOf("SENSITIVE");
    expect(cyclical.has(member(2))).toBe(false);
    // Retrospective by construction: today's sector over the whole history.
    expect(defensive.get(member(2))).toEqual([
      { startDate: "1996-01-02", endDate: null },
    ]);
    expect(sensitive.has(member(29))).toBe(true);

    // 28 of 29 classified passes the gate: published from the floor, its coverage disclosed.
    const outcome = outcomeOf(changed, "SENSITIVE");
    expect(outcome.validation).toMatchObject({
      verdict: "VALIDATED",
      reasons: [],
      publishFrom: "1996-01-02",
    });
    expect(outcome.summary.peakSimultaneousMembers).toBe(12);
    expect(outcome.summary.classification?.unclassified).toEqual([
      expect.objectContaining({ securityId: member(28), reason: "MISSING" }),
    ]);
    expect(
      (
        await prisma.historicalUniverse.findUniqueOrThrow({
          where: { key: supersectorKey("SENSITIVE") },
        })
      ).status,
    ).toBe("VALIDATED");
  }, 300_000);
});
