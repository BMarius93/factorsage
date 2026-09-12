import {
  BACKTEST_SNAPSHOT_VERSION,
  STRATEGY_SCHEMA_VERSION,
  subtractYears,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import type { Prisma, PrismaClient } from "@intrinsic/database";
import { TEST_PERSONAS, type TestPersonaName } from "@intrinsic/testing";

/**
 * Deterministic entitlement fixtures for the test personas.
 *
 * Two kinds of state live here, and only the second one needs explaining.
 *
 * **Boundary state** — a list sitting exactly on a plan's limit, a persona already at its active-
 * Monitor capacity, a run already in flight. Reachable through the UI, but building it by clicking
 * would make every spec slow and would make the assertion about the clicking rather than about the
 * limit.
 *
 * **Post-downgrade state** — an eighty-three-symbol list on a FREE account, a completed twenty-year
 * backtest, four enabled Monitors where one is allowed. Deliberately *not* reachable through the
 * UI: that is the whole point of the downgrade rules. A user reaches it by having been on a higher
 * plan, so a fixture is the only honest way to represent it.
 *
 * **Reconciling, not merely idempotent.** Every run brings each fixture back to its exact declared
 * shape — membership is replaced, monitors are re-pointed, `enabled` is re-asserted. Rerunning the
 * seed is therefore also the reset: a spec that removed a symbol is undone by the next seed rather
 * than by a cleanup step that can itself fail.
 *
 * Nothing outside the reserved `ENT-` naming namespace is read or written, so a persona's own
 * manual work in a development database survives untouched.
 */

/** Everything this seeder owns is named with this prefix, and nothing else is touched. */
export const ENTITLEMENT_FIXTURE_PREFIX = "ENT-";

/** Catalog identity for the fixture universe. No market data: nothing here is executed. */
export const ENTITLEMENT_FIXTURE_SECURITY_COUNT = 100;

export function entitlementFixtureSymbol(index: number): string {
  return `ENTF${String(index + 1).padStart(3, "0")}`;
}

/** A minimal valid Strategy: one BUY level comparing price to a long moving average. */
export function entitlementFixtureDefinition(): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "ent-buy-1",
        percentage: 25,
        signal: {
          conditions: [
            {
              id: "ent-condition-1",
              metric: { kind: "PRICE" },
              operator: "IS_BELOW",
              value: { kind: "SERIES", seriesId: "SMA_200D" },
            },
          ],
        },
      },
    ],
    sellLevels: [],
  };
}

/** One declared List: a name inside the reserved namespace and an exact membership size. */
type ListFixture = {
  readonly key: string;
  readonly name: string;
  readonly symbolCount: number;
  readonly description: string;
};

/** One declared Monitor: which List it watches and the `enabled` intent it must hold. */
type MonitorFixture = {
  readonly key: string;
  readonly name: string;
  readonly listKey: string;
  readonly enabled: boolean;
  /**
   * Fixed creation instant. The active-Monitor rule is positional — the first `N` enabled
   * Monitors by `(createdAt, id)` hold the plan's slots — so a fixture that let the database
   * choose `createdAt` would decide *which* Monitor is blocked by insertion timing.
   */
  readonly createdAt: string;
};

/** A run pinned mid-flight, so "already running" is a state rather than a race. */
type InFlightRunFixture = {
  readonly key: string;
  readonly listKey: string;
  readonly years: number;
};

/** A run that finished under a plan the persona no longer has. */
type CompletedRunFixture = {
  readonly key: string;
  readonly listKey: string;
  readonly years: number;
};

type PersonaFixture = {
  readonly lists: readonly ListFixture[];
  readonly monitors: readonly MonitorFixture[];
  readonly inFlightRuns: readonly InFlightRunFixture[];
  readonly completedRuns: readonly CompletedRunFixture[];
};

/**
 * The declared fixture state, persona by persona.
 *
 * Read it as the answer to "what must be true before Playwright runs". Each persona's state is
 * disjoint from every other's, which is what lets specs for different plans share a database
 * without ordering rules between them.
 */
export const ENTITLEMENT_FIXTURES: Readonly<
  Partial<Record<TestPersonaName, PersonaFixture>>
> = {
  FREE_USER: {
    lists: [
      {
        key: "atLimit",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Free At Limit`,
        symbolCount: 10,
        description: "Exactly the FREE symbol limit, so the next add is the one that is refused.",
      },
      {
        key: "small",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Free Small`,
        symbolCount: 3,
        description: "Comfortably inside FREE, so a refusal can only be about something else.",
      },
      {
        key: "overBacktestLimit",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Free Over Backtest Limit`,
        symbolCount: 11,
        description:
          "One past the FREE backtest symbol limit. Seeded rather than built, because FREE " +
          "cannot create it.",
      },
    ],
    monitors: [
      {
        key: "only",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Free Monitor`,
        listKey: "small",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    inFlightRuns: [{ key: "running", listKey: "small", years: 1 }],
    completedRuns: [],
  },

  STARTER_USER: {
    lists: [
      {
        key: "wide",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Starter Wide`,
        symbolCount: 40,
        description: "Past every FREE limit and inside STARTER's, which is the contrast under test.",
      },
      {
        key: "small",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Starter Small`,
        symbolCount: 3,
        description: "Comfortably inside STARTER.",
      },
    ],
    monitors: [
      {
        key: "one",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Starter Monitor 1`,
        listKey: "small",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        key: "two",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Starter Monitor 2`,
        listKey: "small",
        enabled: true,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      {
        key: "three",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Starter Monitor 3`,
        listKey: "small",
        enabled: true,
        createdAt: "2026-01-03T00:00:00.000Z",
      },
    ],
    inFlightRuns: [{ key: "running", listKey: "small", years: 1 }],
    completedRuns: [],
  },

  PRO_USER: {
    lists: [
      {
        key: "wide",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Pro Wide`,
        symbolCount: 80,
        description: "Past every STARTER limit and inside PRO's.",
      },
    ],
    // Four enabled Monitors: past STARTER's capacity of three, comfortably inside PRO's ten.
    //
    // Exactly **one** run is pinned in flight, and the count is the whole point. It is what lets a
    // spec show PRO accepting a second concurrent run where FREE and STARTER are refused, while
    // still leaving PRO's other slot free — this is also the default development account and the
    // persona every other E2E spec signs in as, so pinning both would break the backtest journey
    // that submits one of its own.
    monitors: [
      {
        key: "one",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Pro Monitor 1`,
        listKey: "wide",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        key: "two",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Pro Monitor 2`,
        listKey: "wide",
        enabled: true,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      {
        key: "three",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Pro Monitor 3`,
        listKey: "wide",
        enabled: true,
        createdAt: "2026-01-03T00:00:00.000Z",
      },
      {
        key: "four",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Pro Monitor 4`,
        listKey: "wide",
        enabled: true,
        createdAt: "2026-01-04T00:00:00.000Z",
      },
    ],
    inFlightRuns: [{ key: "running", listKey: "wide", years: 1 }],
    completedRuns: [],
  },

  ADMIN_USER: {
    // An administrator on the FREE plan holding a list six times FREE's limit. The list is
    // compliant, and the only thing making it so is the persisted role.
    lists: [
      {
        key: "oversized",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Admin Wide`,
        symbolCount: 60,
        description:
          "Far past the FREE plan this administrator is on. Compliant because the role lifts " +
          "capacity, which is exactly what this fixture is for.",
      },
    ],
    monitors: [],
    inFlightRuns: [],
    completedRuns: [],
  },

  DOWNGRADED_USER: {
    lists: [
      {
        key: "oversized",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Downgraded Oversized`,
        symbolCount: 83,
        description:
          "The decision document's own example: a list built on PRO, still intact on FREE.",
      },
      {
        key: "compliant",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Downgraded Compliant`,
        symbolCount: 2,
        description: "Inside FREE, so a Monitor watching it is blocked only by capacity.",
      },
    ],
    // The oldest Monitor watches the oversized list, so it holds the single FREE slot and is
    // blocked for *compliance*; the rest are blocked for *capacity*. One fixture, both reasons,
    // and the order is fixed by `createdAt` rather than by insertion timing.
    monitors: [
      {
        key: "onOversizedList",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Downgraded Monitor 1`,
        listKey: "oversized",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        key: "second",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Downgraded Monitor 2`,
        listKey: "compliant",
        enabled: true,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      {
        key: "third",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Downgraded Monitor 3`,
        listKey: "compliant",
        enabled: true,
        createdAt: "2026-01-03T00:00:00.000Z",
      },
      {
        key: "disabled",
        name: `${ENTITLEMENT_FIXTURE_PREFIX}Downgraded Monitor 4 (off)`,
        listKey: "compliant",
        enabled: false,
        createdAt: "2026-01-04T00:00:00.000Z",
      },
    ],
    inFlightRuns: [],
    // Twenty years over eighty-three symbols: a configuration FREE can neither rerun nor rebuild.
    completedRuns: [{ key: "historic", listKey: "oversized", years: 20 }],
  },
};

export type SeededEntitlementFixtures = {
  readonly securities: number;
  readonly personas: readonly {
    readonly persona: TestPersonaName;
    readonly lists: number;
    readonly monitors: number;
    readonly inFlightRuns: number;
    readonly completedRuns: number;
  }[];
};

/** Resolves the persona rows, failing by name so a missing seed is actionable. */
async function resolvePersonaIds(
  prisma: PrismaClient,
  emails: Readonly<Record<TestPersonaName, string>>,
): Promise<Map<TestPersonaName, string>> {
  const resolved = new Map<TestPersonaName, string>();
  for (const [name, email] of Object.entries(emails) as [
    TestPersonaName,
    string,
  ][]) {
    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: { id: true },
    });
    if (!user) {
      throw new Error(
        `Test persona ${name} does not exist in this database. Run \`pnpm test:users:seed\` first.`,
      );
    }
    resolved.set(name, user.id);
  }
  return resolved;
}

/** Creates or reconciles the fixture catalog rows. Never deletes: lists may reference them. */
async function seedFixtureSecurities(
  prisma: PrismaClient,
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < ENTITLEMENT_FIXTURE_SECURITY_COUNT; index += 1) {
    const symbol = entitlementFixtureSymbol(index);
    const existing = await prisma.security.findFirst({
      where: { symbol, exchangeCode: "NASDAQ" },
      select: { id: true },
    });
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const created = await prisma.security.create({
      data: {
        providerSymbol: symbol,
        symbol,
        name: `Entitlement Fixture ${symbol}`,
        exchangeCode: "NASDAQ",
        exchangeName: "NASDAQ Global Select",
        currency: "USD",
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
      },
      select: { id: true },
    });
    ids.push(created.id);
  }
  return ids;
}

/** The persona's single fixture Strategy, reconciled to the canonical definition. */
async function reconcileStrategy(
  prisma: PrismaClient,
  userId: string,
  persona: TestPersonaName,
): Promise<string> {
  const name = `${ENTITLEMENT_FIXTURE_PREFIX}${persona} Strategy`;
  const definition = entitlementFixtureDefinition();
  const existing = await prisma.strategy.findFirst({
    where: { userId, name },
    select: { id: true, versions: { select: { id: true }, take: 1 } },
  });
  if (existing) {
    return existing.id;
  }
  const created = await prisma.strategy.create({
    data: {
      userId,
      name,
      versions: {
        create: {
          versionNumber: 1,
          definition: definition as unknown as Prisma.InputJsonValue,
          definitionHash: `${ENTITLEMENT_FIXTURE_PREFIX}${persona}`,
        },
      },
    },
    select: { id: true },
  });
  return created.id;
}

/** Brings one List to its declared membership exactly, creating it if it is absent. */
async function reconcileList(
  prisma: PrismaClient,
  userId: string,
  fixture: ListFixture,
  securityIds: readonly string[],
): Promise<string> {
  const wanted = securityIds.slice(0, fixture.symbolCount);
  const existing = await prisma.stockList.findFirst({
    where: { userId, name: fixture.name },
    select: { id: true },
  });

  const listId =
    existing?.id ??
    (
      await prisma.stockList.create({
        data: { userId, name: fixture.name, description: fixture.description },
        select: { id: true },
      })
    ).id;

  // Replaced as a set: a spec that removed a symbol is undone here rather than accumulating drift.
  const current = await prisma.stockListItem.findMany({
    where: { stockListId: listId },
    select: { id: true, securityId: true },
  });
  const wantedSet = new Set(wanted);
  const surplus = current.filter((row) => !wantedSet.has(row.securityId));
  if (surplus.length > 0) {
    await prisma.stockListItem.deleteMany({
      where: { id: { in: surplus.map((row) => row.id) } },
    });
  }
  const held = new Set(current.map((row) => row.securityId));
  const missing = wanted.filter((securityId) => !held.has(securityId));
  if (missing.length > 0) {
    await prisma.stockListItem.createMany({
      data: missing.map((securityId) => ({ stockListId: listId, securityId })),
      skipDuplicates: true,
    });
  }
  await prisma.stockList.update({
    where: { id: listId },
    data: { description: fixture.description },
  });
  return listId;
}

function fixtureSnapshot(input: {
  strategyId: string;
  strategyVersionId: string;
  /**
   * The label a spec finds this run by.
   *
   * It has to be the *snapshot's* strategy name: a run is rendered from its immutable submission
   * document, so the denormalized `strategyName` column is not what reaches the page.
   */
  label: string;
  listId: string;
  listName: string;
  securities: readonly { id: string; symbol: string }[];
  startDate: string;
  endDate: string;
  benchmark: { id: string; seriesId: string; code: string; name: string };
}): Prisma.InputJsonValue {
  return {
    snapshotVersion: BACKTEST_SNAPSHOT_VERSION,
    submittedAt: `${input.startDate}T00:00:00.000Z`,
    strategy: {
      strategyId: input.strategyId,
      name: input.label,
      versionId: input.strategyVersionId,
      versionNumber: 1,
      definitionHash: `${ENTITLEMENT_FIXTURE_PREFIX}historic`,
      definition: entitlementFixtureDefinition(),
    },
    stockList: { stockListId: input.listId, name: input.listName },
    securities: input.securities.map((security) => ({
      securityId: security.id,
      symbol: security.symbol,
      name: `Entitlement Fixture ${security.symbol}`,
      exchangeCode: "NASDAQ",
      currency: "USD",
      buyWindowMode: "FULL",
      buyWindows: [],
    })),
    period: { startDate: input.startDate, endDate: input.endDate },
    capital: { initialCapital: 100_000, monthlyContribution: 0 },
    allocation: { maximumPositions: 10, fullPositionFraction: 0.1 },
    benchmark: {
      benchmarkId: input.benchmark.id,
      seriesId: input.benchmark.seriesId,
      seriesVersion: 1,
      code: input.benchmark.code,
      name: input.benchmark.name,
      sourceKind: "FMP_SYMBOL",
      providerSymbol: "SPY",
      methodologyVersion: 1,
      currency: "USD",
    },
    executionCalendar: {
      referenceCode: input.benchmark.code,
      seriesId: input.benchmark.seriesId,
      seriesVersion: 1,
    },
    methodology: { fixture: true },
    dataRevisions: { fixture: true },
  } as unknown as Prisma.InputJsonValue;
}

export type EntitlementFixtureSeedInput = {
  readonly prisma: PrismaClient;
  readonly emails: Readonly<Record<TestPersonaName, string>>;
  /** Injectable so the seeded periods are reproducible in a test. */
  readonly today?: string;
};

/**
 * Reconciles every declared fixture. Safe to rerun, and rerunning is the reset.
 */
export async function seedEntitlementFixtures(
  input: EntitlementFixtureSeedInput,
): Promise<SeededEntitlementFixtures> {
  const { prisma } = input;
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const personaIds = await resolvePersonaIds(prisma, input.emails);
  const securityIds = await seedFixtureSecurities(prisma);
  const securityRows = await prisma.security.findMany({
    where: { id: { in: securityIds } },
    select: { id: true, symbol: true },
  });
  const symbolById = new Map(securityRows.map((row) => [row.id, row.symbol]));

  // Runs need a benchmark and a series to point at. The fixture owns its own so it can never
  // disturb `SP500`, which real runs and the E2E stock data depend on.
  const benchmarkCode = `${ENTITLEMENT_FIXTURE_PREFIX}BENCHMARK`;
  const benchmark =
    (await prisma.benchmark.findFirst({
      where: { code: benchmarkCode },
      include: { series: { orderBy: { version: "desc" }, take: 1 } },
    })) ??
    (await prisma.benchmark.create({
      data: {
        code: benchmarkCode,
        name: "Entitlement Fixture Benchmark",
        isActive: false,
        series: {
          create: {
            version: 1,
            sourceKind: "FMP_SYMBOL",
            providerSymbol: "SPY",
            currency: "USD",
            methodologyVersion: 1,
          },
        },
      },
      include: { series: { orderBy: { version: "desc" }, take: 1 } },
    }));
  const benchmarkSeriesId = benchmark.series[0]?.id ?? "";

  const summary: SeededEntitlementFixtures["personas"][number][] = [];

  for (const personaName of Object.keys(
    ENTITLEMENT_FIXTURES,
  ) as TestPersonaName[]) {
    const fixture = ENTITLEMENT_FIXTURES[personaName];
    const userId = personaIds.get(personaName);
    if (!fixture || !userId) {
      continue;
    }

    const listIds = new Map<string, string>();
    for (const listFixture of fixture.lists) {
      listIds.set(
        listFixture.key,
        await reconcileList(prisma, userId, listFixture, securityIds),
      );
    }
    const strategyId = await reconcileStrategy(prisma, userId, personaName);

    // Monitors are reconciled by name, so `enabled` and the watched List are re-asserted even
    // after a spec toggled them.
    for (const monitorFixture of fixture.monitors) {
      const stockListId = listIds.get(monitorFixture.listKey);
      if (!stockListId) {
        continue;
      }
      const existing = await prisma.monitor.findFirst({
        where: { userId, name: monitorFixture.name },
        select: { id: true },
      });
      if (existing) {
        await prisma.monitor.update({
          where: { id: existing.id },
          data: {
            strategyId,
            stockListId,
            enabled: monitorFixture.enabled,
            createdAt: new Date(monitorFixture.createdAt),
          },
        });
      } else {
        await prisma.monitor.create({
          data: {
            userId,
            name: monitorFixture.name,
            strategyId,
            stockListId,
            enabled: monitorFixture.enabled,
            createdAt: new Date(monitorFixture.createdAt),
          },
        });
      }
    }

    const version = await prisma.strategyVersion.findFirstOrThrow({
      where: { strategyId },
      orderBy: { versionNumber: "desc" },
      select: { id: true },
    });

    // Runs are replaced wholesale: a pinned "running" run must not accumulate one copy per seed,
    // and a spec cannot have changed one in a way worth preserving.
    await prisma.backtestRun.deleteMany({
      where: { userId, strategyName: { startsWith: ENTITLEMENT_FIXTURE_PREFIX } },
    });

    for (const run of fixture.inFlightRuns) {
      const listId = listIds.get(run.listKey);
      const listFixture = fixture.lists.find((entry) => entry.key === run.listKey);
      if (!listId || !listFixture) {
        continue;
      }
      const securities = securityIds
        .slice(0, listFixture.symbolCount)
        .map((id) => ({ id, symbol: symbolById.get(id) ?? id }));
      const startDate = subtractYears(today, run.years);
      await prisma.backtestRun.create({
        data: {
          userId,
          strategyId,
          strategyVersionId: version.id,
          stockListId: listId,
          benchmarkId: benchmark.id,
          benchmarkSeriesId,
          executionCalendarSeriesId: benchmarkSeriesId,
          status: "RUNNING",
          startDate: new Date(`${startDate}T00:00:00.000Z`),
          endDate: new Date(`${today}T00:00:00.000Z`),
          initialCapital: 100_000,
          monthlyContribution: 0,
          maximumPositions: 10,
          strategyName: `${ENTITLEMENT_FIXTURE_PREFIX}In Flight`,
          stockListName: listFixture.name,
          securityCount: securities.length,
          startedAt: new Date(),
          snapshot: fixtureSnapshot({
            strategyId,
            strategyVersionId: version.id,
            label: `${ENTITLEMENT_FIXTURE_PREFIX}In Flight`,
            listId,
            listName: listFixture.name,
            securities,
            startDate,
            endDate: today,
            benchmark: {
              id: benchmark.id,
              seriesId: benchmarkSeriesId,
              code: benchmark.code,
              name: benchmark.name,
            },
          }),
          snapshotHash: `${ENTITLEMENT_FIXTURE_PREFIX}${personaName}-${run.key}`,
          progress: {
            create: { percent: 42, message: "Simulating", sequence: 1 },
          },
          // Held by a worker that does not exist, on a lease that does not expire. The real worker
          // therefore never claims it (the job is not `QUEUED`) and never recovers it (the lease
          // is live), so "one run already in flight" stays true for as long as the fixture does
          // — with no worker, no market data and no race.
          job: {
            create: {
              status: "CLAIMED",
              availableAt: new Date(),
              attempts: 1,
              maxAttempts: 3,
              claimedBy: `${ENTITLEMENT_FIXTURE_PREFIX}pinned`,
              claimedAt: new Date(),
              leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
              heartbeatAt: new Date(),
            },
          },
        },
      });
    }

    for (const run of fixture.completedRuns) {
      const listId = listIds.get(run.listKey);
      const listFixture = fixture.lists.find((entry) => entry.key === run.listKey);
      if (!listId || !listFixture) {
        continue;
      }
      const securities = securityIds
        .slice(0, listFixture.symbolCount)
        .map((id) => ({ id, symbol: symbolById.get(id) ?? id }));
      const startDate = subtractYears(today, run.years);
      await prisma.backtestRun.create({
        data: {
          userId,
          strategyId,
          strategyVersionId: version.id,
          stockListId: listId,
          benchmarkId: benchmark.id,
          benchmarkSeriesId,
          executionCalendarSeriesId: benchmarkSeriesId,
          status: "COMPLETED",
          startDate: new Date(`${startDate}T00:00:00.000Z`),
          endDate: new Date(`${today}T00:00:00.000Z`),
          initialCapital: 100_000,
          monthlyContribution: 0,
          maximumPositions: 10,
          strategyName: `${ENTITLEMENT_FIXTURE_PREFIX}Historic Run`,
          stockListName: listFixture.name,
          securityCount: securities.length,
          startedAt: new Date(`${startDate}T00:00:00.000Z`),
          completedAt: new Date(`${today}T00:00:00.000Z`),
          snapshot: fixtureSnapshot({
            strategyId,
            strategyVersionId: version.id,
            label: `${ENTITLEMENT_FIXTURE_PREFIX}Historic Run`,
            listId,
            listName: listFixture.name,
            securities,
            startDate,
            endDate: today,
            benchmark: {
              id: benchmark.id,
              seriesId: benchmarkSeriesId,
              code: benchmark.code,
              name: benchmark.name,
            },
          }),
          snapshotHash: `${ENTITLEMENT_FIXTURE_PREFIX}${personaName}-${run.key}`,
          progress: {
            create: { percent: 100, message: "Backtest complete", sequence: 1 },
          },
          // A result row is what makes the run readable rather than merely present: the detail
          // page renders results only for a COMPLETED run that has one.
          summary: {
            create: {
              firstSimulatedDate: new Date(`${startDate}T00:00:00.000Z`),
              lastSimulatedDate: new Date(`${today}T00:00:00.000Z`),
              tradingDays: 252 * run.years,
              investedCapital: 100_000,
              finalCash: 12_500,
              finalPositionsValue: 175_000,
              finalValue: 187_500,
              netProfit: 87_500,
              portfolioReturnPercent: 87.5,
              benchmarkReturnPercent: 62.5,
              alphaPercent: 25,
              portfolioCagrPercent: 3.2,
              maxDrawdownPercent: 18.4,
              benchmarkMaxDrawdownPercent: 21.1,
              realizedPnl: 40_000,
              unrealizedPnl: 47_500,
              totalTrades: 24,
              buyTrades: 14,
              sellTrades: 9,
              finalExitTrades: 1,
              winningTrades: 16,
              losingTrades: 8,
              openPositions: 4,
            },
          },
        },
      });
    }

    summary.push({
      persona: personaName,
      lists: fixture.lists.length,
      monitors: fixture.monitors.length,
      inFlightRuns: fixture.inFlightRuns.length,
      completedRuns: fixture.completedRuns.length,
    });
  }

  return { securities: securityIds.length, personas: summary };
}

/** The persona emails this seeder needs, in the shape {@link seedEntitlementFixtures} expects. */
export function entitlementFixturePersonaEmails(
  resolve: (name: TestPersonaName) => string,
): Record<TestPersonaName, string> {
  const emails = {} as Record<TestPersonaName, string>;
  for (const name of Object.keys(TEST_PERSONAS) as TestPersonaName[]) {
    emails[name] = resolve(name);
  }
  return emails;
}
