import { randomUUID } from "node:crypto";
import {
  normalizeStrategyDefinition,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { PrismaClient } from "@intrinsic/database";
import { EXECUTION_CALENDAR_REFERENCE_CODE } from "@intrinsic/domain";
import {
  QA_MATRIX_EXPECTED_LISTS,
  QA_MATRIX_EXPECTED_STRATEGIES,
  QA_MATRIX_NAME_PREFIX,
  QA_MATRIX_SECURITIES,
  QA_MATRIX_STRATEGIES,
  currentAsOfDate,
  qaMatrixFixtures,
  useTestDatabase,
} from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadQaMatrixExecutionCalendar,
  seedQaMatrixFixtures,
} from "./seed-qa-matrix";

// Before any Prisma client is constructed.
useTestDatabase();

/**
 * The QA-MATRIX seed against real PostgreSQL.
 *
 * It proves what the definitions alone cannot: that seeding produces exactly ten strategies and ten
 * lists owned by the intended account, that the persisted membership and buy-window boundaries are
 * the fixtures literally, that a second seed changes nothing at all, that a drifted fixture is
 * repaired rather than duplicated, and that no other user's identically named rows are ever read or
 * written.
 *
 * It uses an isolated randomized user rather than the `QA_USER` persona, exactly as every other
 * DB-backed suite does — `resolveQaMatrixOwner`, the one piece that binds the seed to the persona,
 * is covered offline in `seed-qa-matrix.test.ts`.
 */
describe("QA-MATRIX fixture seeding", () => {
  // One clock and one calendar for the whole suite. The fixtures are a pure function of both, so
  // pinning them here is what makes "a second seed writes nothing" a statement about the seeder
  // rather than about how long the suite took to run.
  //
  // The calendar is read from **this database's** pinned execution-calendar series, by the same
  // function the seeder uses, so the assertions below compare persisted boundaries against the
  // dates a run in this database would actually simulate — not against a capture, and not against
  // anything the matrix computed.
  const asOfDate = currentAsOfDate();
  let executionDates: readonly string[];
  let fixtures: ReturnType<typeof qaMatrixFixtures>;
  let QA_MATRIX_LISTS: ReturnType<typeof qaMatrixFixtures>["lists"];

  const suffix = randomUUID();
  const ownerEmail = `qa-matrix-owner-${suffix}@example.test`;
  const intruderEmail = `qa-matrix-intruder-${suffix}@example.test`;

  let prisma: PrismaClient;
  let ownerId: string;
  let intruderId: string;

  const strategySelect = {
    name: true,
    description: true,
    userId: true,
    createdAt: true,
    updatedAt: true,
    versions: {
      select: { versionNumber: true, definition: true, definitionHash: true },
      orderBy: { versionNumber: "asc" as const },
    },
  };

  const listSelect = {
    name: true,
    description: true,
    userId: true,
    createdAt: true,
    updatedAt: true,
    items: {
      select: {
        buyWindowMode: true,
        security: { select: { symbol: true } },
        buyWindows: {
          select: { startDate: true, endDate: true },
          orderBy: { startDate: "asc" as const },
        },
      },
      orderBy: { securityId: "asc" as const },
    },
  };

  /** Everything about the seeded state that a second seed must leave identical. */
  async function persistedState(userId: string) {
    const strategies = await prisma.strategy.findMany({
      where: { userId },
      orderBy: { name: "asc" },
      select: strategySelect,
    });
    const lists = await prisma.stockList.findMany({
      where: { userId },
      orderBy: { name: "asc" },
      select: listSelect,
    });
    return { strategies, lists };
  }

  function isoDate(value: Date): string {
    return value.toISOString().slice(0, 10);
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    executionDates = await loadQaMatrixExecutionCalendar(prisma);
    fixtures = qaMatrixFixtures(asOfDate, executionDates);
    QA_MATRIX_LISTS = fixtures.lists;
    const owner = await prisma.user.create({
      data: { email: ownerEmail, emailVerifiedAt: new Date() },
      select: { id: true },
    });
    ownerId = owner.id;
    const intruder = await prisma.user.create({
      data: { email: intruderEmail, emailVerifiedAt: new Date() },
      select: { id: true },
    });
    intruderId = intruder.id;
    await seedQaMatrixFixtures(prisma, ownerId, fixtures);
  });

  afterAll(async () => {
    // Only this suite's own users; the catalog rows the seed created are shared fixtures and are
    // deliberately left in place, exactly like the ones `pnpm test:securities:seed` writes.
    await prisma.user.deleteMany({
      where: { id: { in: [ownerId, intruderId] } },
    });
    await prisma.$disconnect();
  });

  it("seeds exactly ten matrix strategies and ten matrix lists", async () => {
    const strategies = await prisma.strategy.findMany({
      where: { userId: ownerId, name: { startsWith: QA_MATRIX_NAME_PREFIX } },
      select: { name: true },
    });
    const lists = await prisma.stockList.findMany({
      where: { userId: ownerId, name: { startsWith: QA_MATRIX_NAME_PREFIX } },
      select: { name: true },
    });

    expect(strategies).toHaveLength(QA_MATRIX_EXPECTED_STRATEGIES);
    expect(lists).toHaveLength(QA_MATRIX_EXPECTED_LISTS);
    expect(strategies.map((row) => row.name).sort()).toEqual(
      QA_MATRIX_STRATEGIES.map((fixture) => fixture.name).sort(),
    );
    expect(lists.map((row) => row.name).sort()).toEqual(
      QA_MATRIX_LISTS.map((fixture) => fixture.name).sort(),
    );
  });

  it("owns every fixture with the intended account and creates no duplicates", async () => {
    const { strategies, lists } = await persistedState(ownerId);
    for (const row of [...strategies, ...lists]) {
      expect(row.userId).toBe(ownerId);
    }
    // Names are the seed's reconciliation key, so a duplicate would make the fixture ambiguous.
    expect(new Set(strategies.map((row) => row.name)).size).toBe(
      strategies.length,
    );
    expect(new Set(lists.map((row) => row.name)).size).toBe(lists.length);
    // The owner has nothing outside the reserved namespace either: the seed created only fixtures.
    expect(
      strategies.every((row) => row.name.startsWith(QA_MATRIX_NAME_PREFIX)),
    ).toBe(true);
    expect(
      lists.every((row) => row.name.startsWith(QA_MATRIX_NAME_PREFIX)),
    ).toBe(true);
  });

  it("round-trips every strategy definition through persistence unchanged", async () => {
    for (const fixture of QA_MATRIX_STRATEGIES) {
      const row = await prisma.strategy.findFirstOrThrow({
        where: { userId: ownerId, name: fixture.name },
        select: strategySelect,
      });
      expect(row.description).toBe(fixture.description);
      expect(row.versions).toHaveLength(1);
      const stored = row.versions[0]!
        .definition as unknown as StrategyDefinition;
      // Byte-for-byte the fixture, and still canonical when read back through the one normalizer
      // the API and worker both parse a stored definition with.
      expect(stored).toEqual(fixture.definition);
      expect(normalizeStrategyDefinition(stored)).toEqual(fixture.definition);
    }
  });

  it("persists exactly the intended securities and buy-window boundaries", async () => {
    for (const fixture of QA_MATRIX_LISTS) {
      const row = await prisma.stockList.findFirstOrThrow({
        where: { userId: ownerId, name: fixture.name },
        select: listSelect,
      });
      expect(row.description).toBe(fixture.description);

      const persisted = row.items
        .map((item) => ({
          symbol: item.security.symbol,
          mode: item.buyWindowMode,
          ranges: item.buyWindows.map((window) => ({
            startDate: isoDate(window.startDate),
            endDate: window.endDate === null ? null : isoDate(window.endDate),
          })),
        }))
        .sort((left, right) => left.symbol.localeCompare(right.symbol));
      const expected = fixture.members
        .map((member) => ({
          symbol: member.symbol as string,
          mode: member.mode,
          ranges: member.ranges.map((range) => ({ ...range })),
        }))
        .sort((left, right) => left.symbol.localeCompare(right.symbol));

      // Exact membership, exact mode, and inclusive boundaries as the exact calendar dates the
      // fixture states — a `@db.Date` off-by-one would change what a run may buy.
      expect(persisted, fixture.name).toEqual(expected);
    }
  });

  it("resolves every membership to a real catalog security identity", async () => {
    const symbols = new Set(
      QA_MATRIX_LISTS.flatMap((fixture) =>
        fixture.members.map((member) => member.symbol),
      ),
    );
    for (const symbol of symbols) {
      const fixture = QA_MATRIX_SECURITIES.find(
        (entry) => entry.symbol === symbol,
      )!;
      const security = await prisma.security.findFirstOrThrow({
        where: { symbol, exchangeCode: fixture.exchangeCode },
        select: { providerSymbol: true, currency: true, type: true },
      });
      // The catalog is the identity authority; membership stores a foreign key, never a symbol.
      expect(security.providerSymbol).toBe(symbol);
      expect(security.currency).toBe("USD");
      expect(security.type).toBe("STOCK");
    }
  });

  it("persists every L10 boundary as a date the pinned execution calendar contains", async () => {
    const fixture = QA_MATRIX_LISTS.find((entry) => entry.id === "L10")!;
    const row = await prisma.stockList.findFirstOrThrow({
      where: { userId: ownerId, name: fixture.name },
      select: listSelect,
    });
    // The authoritative set, read from this database exactly as the worker reads it before a run.
    const authoritative = new Set(executionDates);

    // Two things at once: that the round trip through a `@db.Date` column and a UTC parse preserves
    // the exact calendar date, and that the date it preserved is one the engine would simulate. An
    // off-by-one here would silently move a boundary onto a day no run ever reaches.
    for (const item of row.items) {
      expect(item.buyWindows.length).toBeGreaterThan(0);
      for (const window of item.buyWindows) {
        const startDate = isoDate(window.startDate);
        const endDate =
          window.endDate === null ? null : isoDate(window.endDate);
        expect(
          authoritative.has(startDate),
          `${item.security.symbol} persisted an opening boundary of ${startDate}, which the pinned execution calendar does not contain`,
        ).toBe(true);
        expect(endDate).not.toBeNull();
        expect(
          authoritative.has(endDate as string),
          `${item.security.symbol} persisted a closing boundary of ${endDate}, which the pinned execution calendar does not contain`,
        ).toBe(true);
      }
    }
  });

  it("reads its calendar from the same series a submitted run pins", async () => {
    // Not a parallel query with the same shape — the same rows. If the seeder and the worker could
    // disagree about which series is authoritative, the fixtures would name dates the runs skip.
    const series = (
      await prisma.benchmark.findFirst({
        where: { code: EXECUTION_CALENDAR_REFERENCE_CODE },
        include: { series: { orderBy: { version: "desc" }, take: 1 } },
      })
    )?.series[0];
    expect(series).toBeDefined();
    const bars = await prisma.benchmarkDailyPrice.count({
      where: { seriesId: series!.id },
    });
    expect(executionDates).toHaveLength(bars);
    expect(fixtures.calendar.length).toBe(bars);
    expect(fixtures.calendar.has(fixtures.periods.periodEnd)).toBe(true);
  });

  it("creates no backtest runs", async () => {
    expect(await prisma.backtestRun.count({ where: { userId: ownerId } })).toBe(
      0,
    );
  });

  it("leaves the persisted state byte-identical when seeded a second time", async () => {
    const before = await persistedState(ownerId);
    const result = await seedQaMatrixFixtures(prisma, ownerId, fixtures);
    const after = await persistedState(ownerId);

    expect(after).toEqual(before);
    // Including the timestamps: nothing was written, so nothing moved `updatedAt`.
    expect(result.strategiesCreated + result.strategiesUpdated).toBe(0);
    expect(result.listsCreated + result.listsUpdated).toBe(0);
    expect(result.securitiesCreated).toBe(0);
    expect(result.staleRemoved).toBe(0);
  });

  it("repairs a drifted fixture instead of duplicating it", async () => {
    const fixture = QA_MATRIX_STRATEGIES[3]!;
    const before = await prisma.strategy.findFirstOrThrow({
      where: { userId: ownerId, name: fixture.name },
      select: { id: true, versions: { select: { versionNumber: true } } },
    });
    // Drift the identity the way an edit through the product would: a changed description, plus a
    // definition that no longer matches the fixture.
    await prisma.strategy.update({
      where: { id: before.id },
      data: { description: "hand-edited" },
    });
    await prisma.strategyVersion.create({
      data: {
        strategyId: before.id,
        versionNumber: before.versions.length + 1,
        definition: QA_MATRIX_STRATEGIES[0]!.definition as never,
        definitionHash: "drifted",
      },
    });

    const result = await seedQaMatrixFixtures(prisma, ownerId, fixtures);
    expect(result.strategiesUpdated).toBe(1);
    expect(result.strategiesCreated).toBe(0);

    const after = await prisma.strategy.findMany({
      where: { userId: ownerId, name: fixture.name },
      select: {
        id: true,
        description: true,
        versions: {
          select: { versionNumber: true, definition: true },
          orderBy: { versionNumber: "desc" },
        },
      },
    });
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before.id);
    expect(after[0]!.description).toBe(fixture.description);
    // Appended, never rewritten: an earlier version may be referenced by a completed run.
    expect(after[0]!.versions[0]!.definition).toEqual(fixture.definition);
    expect(after[0]!.versions.length).toBeGreaterThan(before.versions.length);
  });

  it("removes a stale list member so the persisted list matches the definition exactly", async () => {
    const fixture = QA_MATRIX_LISTS[1]!;
    const list = await prisma.stockList.findFirstOrThrow({
      where: { userId: ownerId, name: fixture.name },
      select: { id: true },
    });
    // A security the fixture does not define, added the way a user would.
    const intruderSecurity = await prisma.security.findFirstOrThrow({
      where: { symbol: "MRNA" },
      select: { id: true },
    });
    const stale = await prisma.stockListItem.create({
      data: {
        stockListId: list.id,
        securityId: intruderSecurity.id,
        buyWindowMode: "CUSTOM",
        buyWindows: {
          create: { startDate: new Date("2020-01-01T00:00:00.000Z") },
        },
      },
      select: { id: true },
    });

    const result = await seedQaMatrixFixtures(prisma, ownerId, fixtures);
    expect(result.listsUpdated).toBe(1);

    expect(
      await prisma.stockListItem.findUnique({ where: { id: stale.id } }),
    ).toBeNull();
    // The window rows cascade with the membership rather than being orphaned.
    expect(
      await prisma.stockListBuyWindow.count({
        where: { stockListItemId: stale.id },
      }),
    ).toBe(0);
    const items = await prisma.stockListItem.findMany({
      where: { stockListId: list.id },
      select: { security: { select: { symbol: true } } },
    });
    expect(items.map((item) => item.security.symbol).sort()).toEqual(
      fixture.members.map((member) => member.symbol as string).sort(),
    );
  });

  it("replaces a drifted buy window rather than merging into it", async () => {
    const fixture = QA_MATRIX_LISTS.find((entry) => entry.id === "L10")!;
    const member = fixture.members[0]!;
    const item = await prisma.stockListItem.findFirstOrThrow({
      where: {
        stockList: { userId: ownerId, name: fixture.name },
        security: { symbol: member.symbol },
      },
      select: { id: true },
    });
    await prisma.stockListBuyWindow.deleteMany({
      where: { stockListItemId: item.id },
    });
    await prisma.stockListBuyWindow.create({
      data: {
        stockListItemId: item.id,
        startDate: new Date("2001-01-01T00:00:00.000Z"),
        endDate: new Date("2002-01-01T00:00:00.000Z"),
      },
    });

    await seedQaMatrixFixtures(prisma, ownerId, fixtures);

    const windows = await prisma.stockListBuyWindow.findMany({
      where: { stockListItemId: item.id },
      orderBy: { startDate: "asc" },
      select: { startDate: true, endDate: true },
    });
    expect(
      windows.map((window) => ({
        startDate: isoDate(window.startDate),
        endDate: window.endDate === null ? null : isoDate(window.endDate),
      })),
    ).toEqual(member.ranges.map((range) => ({ ...range })));
  });

  it("removes a fixture the definitions no longer contain", async () => {
    const retired = `${QA_MATRIX_NAME_PREFIX}S99-retired`;
    await prisma.strategy.create({
      data: {
        userId: ownerId,
        name: retired,
        versions: {
          create: {
            versionNumber: 1,
            definition: QA_MATRIX_STRATEGIES[0]!.definition as never,
            definitionHash: "retired",
          },
        },
      },
    });

    const result = await seedQaMatrixFixtures(prisma, ownerId, fixtures);
    expect(result.staleRemoved).toBe(1);
    expect(
      await prisma.strategy.count({
        where: { userId: ownerId, name: retired },
      }),
    ).toBe(0);
    expect(
      await prisma.strategy.count({
        where: { userId: ownerId, name: { startsWith: QA_MATRIX_NAME_PREFIX } },
      }),
    ).toBe(QA_MATRIX_EXPECTED_STRATEGIES);
  });

  it("leaves the QA account's own non-matrix strategies and lists alone", async () => {
    const personal = await prisma.strategy.create({
      data: {
        userId: ownerId,
        name: "My own strategy",
        versions: {
          create: {
            versionNumber: 1,
            definition: QA_MATRIX_STRATEGIES[0]!.definition as never,
            definitionHash: "personal",
          },
        },
      },
      select: { id: true, updatedAt: true },
    });

    await seedQaMatrixFixtures(prisma, ownerId, fixtures);

    const after = await prisma.strategy.findUnique({
      where: { id: personal.id },
      select: { updatedAt: true },
    });
    // Every delete is filtered by the reserved prefix as well as by owner.
    expect(after?.updatedAt).toEqual(personal.updatedAt);
    await prisma.strategy.delete({ where: { id: personal.id } });
  });

  it("cannot touch another user's identically named entities", async () => {
    const fixture = QA_MATRIX_STRATEGIES[0]!;
    const listFixture = QA_MATRIX_LISTS[0]!;
    const foreignStrategy = await prisma.strategy.create({
      data: {
        userId: intruderId,
        name: fixture.name,
        description: "someone else's",
        versions: {
          create: {
            versionNumber: 1,
            definition: QA_MATRIX_STRATEGIES[1]!.definition as never,
            definitionHash: "foreign",
          },
        },
      },
      select: { id: true, description: true, updatedAt: true },
    });
    const foreignList = await prisma.stockList.create({
      data: {
        userId: intruderId,
        name: listFixture.name,
        description: "someone else's",
      },
      select: { id: true, description: true, updatedAt: true },
    });

    await seedQaMatrixFixtures(prisma, ownerId, fixtures);

    // The other account's rows are neither reconciled into fixtures nor deleted as duplicates:
    // every read, write and delete the seed issues is filtered by the resolved owner's id.
    expect(
      await prisma.strategy.findUnique({
        where: { id: foreignStrategy.id },
        select: { description: true, updatedAt: true, userId: true },
      }),
    ).toEqual({
      description: foreignStrategy.description,
      updatedAt: foreignStrategy.updatedAt,
      userId: intruderId,
    });
    expect(
      await prisma.stockList.findUnique({
        where: { id: foreignList.id },
        select: {
          description: true,
          updatedAt: true,
          userId: true,
          items: { select: { id: true } },
        },
      }),
    ).toEqual({
      description: foreignList.description,
      updatedAt: foreignList.updatedAt,
      userId: intruderId,
      items: [],
    });
    expect(
      await prisma.strategy.count({
        where: { userId: ownerId, name: { startsWith: QA_MATRIX_NAME_PREFIX } },
      }),
    ).toBe(QA_MATRIX_EXPECTED_STRATEGIES);
  });
});
