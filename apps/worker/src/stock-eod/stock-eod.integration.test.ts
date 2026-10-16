import { randomUUID } from "node:crypto";
import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type { DailyPrice, DateRange } from "@intrinsic/domain";
import type { FmpStockProviderPort } from "@intrinsic/fmp";
import { createLogger } from "@intrinsic/observability";
import {
  CanonicalStockDataService,
  EodFinalityPolicy,
  InMemoryLoadCoordinator,
  IoredisCacheClient,
  PrismaStockDataStore,
  RedisStockDataCache,
  WEEKDAY_TRADING_CALENDAR,
  createStockDataRedisClient,
} from "@intrinsic/stock-data";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaMonitorRepository } from "../monitor/monitor-repository.js";
import { StockEodRefreshRun } from "./refresh-run.js";

/**
 * The stock EOD preparation against PostgreSQL and Redis, with the real Monitor repository and the
 * real canonical loader — only the provider is a double. It proves what the unit cases cannot: the
 * universe is read from real Monitors and Lists, a security many Monitors watch is fetched once,
 * members outside their ongoing membership are never fetched, and a security already final for the
 * session costs no provider request and no Redis work, even after Redis lost it.
 */

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error("Stock EOD integration tests require TEST_REDIS_URL or REDIS_URL.");
}
const describeWithRedis = redisUrl ? describe : describe.skip;

/** Wednesday 2026-10-14, 16:35 in New York: the session is final. */
const NOW = new Date("2026-10-14T20:35:00.000Z");
const SESSION = "2026-10-14";
const LISTED = "2026-07-01";

function weekdays(from: string, to: string): string[] {
  const dates: string[] = [];
  for (
    let cursor = new Date(`${from}T00:00:00.000Z`);
    cursor <= new Date(`${to}T00:00:00.000Z`);
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
  }
  return dates;
}

class HistoryProvider implements FmpStockProviderPort {
  readonly priceRequests: { symbol: string; from: string; to: string }[] = [];
  readonly profileRequests: string[] = [];

  async getProfile(symbol: string) {
    this.profileRequests.push(symbol);
    return null;
  }

  async getDailyPrices(symbol: string, securityId: string, range: DateRange) {
    if (!range.from || !range.to) throw new Error("Expected bounded range");
    this.priceRequests.push({ symbol, from: range.from, to: range.to });
    return weekdays(LISTED, SESSION)
      .filter((date) => date >= range.from! && date <= range.to!)
      .map(
        (date, index): DailyPrice => ({
          securityId,
          date,
          open: 100 + index * 0.1,
          high: 101 + index * 0.1,
          low: 99 + index * 0.1,
          close: 100 + index * 0.1,
          volume: 1_000,
        }),
      );
  }

  async getFinancialStatements() {
    return [];
  }
}

const DEFINITION: StrategyDefinition = {
  schemaVersion: STRATEGY_SCHEMA_VERSION,
  buyLevels: [
    {
      id: "buy-1",
      percentage: 100,
      signal: {
        conditions: [
          {
            id: "c-1",
            metric: { kind: "PRICE" },
            operator: "IS_ABOVE",
            value: { kind: "SERIES", seriesId: "SMA_20D" },
          },
        ],
      },
    },
  ],
  sellLevels: [],
} as StrategyDefinition;

describeWithRedis("the stock EOD preparation on PostgreSQL and Redis", () => {
  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(redisUrl ?? "redis://localhost:6379");
  const namespace = `stock-data:v2:test:stock-eod:${randomUUID()}`;
  const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
  const securityIds: string[] = [];
  const systemRows: { monitorId: string; strategyId: string; stockListId: string }[] = [];
  const createdMonitorIds = new Set<string>();

  afterAll(async () => {
    for (const row of systemRows) {
      await prisma.monitor.deleteMany({ where: { id: row.monitorId } });
      await prisma.stockList.deleteMany({ where: { id: row.stockListId } });
      await prisma.strategy.deleteMany({ where: { id: row.strategyId } });
    }
    await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
    const keys = await redis.keys(`${namespace}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    await prisma.$disconnect();
    await redis.quit();
  });

  async function createSecurity(symbol: string) {
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
        ipoDate: new Date(`${LISTED}T00:00:00.000Z`),
      },
    });
    securityIds.push(created.id);
    return created;
  }

  async function createSystemMonitor(
    members: {
      securityId: string;
      windows?: { startDate: string; endDate: string | null }[];
    }[],
  ) {
    const key = randomUUID();
    const strategy = await prisma.strategy.create({
      data: {
        ownership: "SYSTEM",
        systemKey: `test-strategy-${key}`,
        name: "Built-in strategy",
        versions: {
          create: {
            versionNumber: 1,
            definition: DEFINITION as never,
            definitionHash: randomUUID(),
          },
        },
      },
    });
    const stockList = await prisma.stockList.create({
      data: {
        ownership: "SYSTEM",
        systemKey: `test-list-${key}`,
        name: "Built-in list",
        items: {
          create: members.map((member) => ({
            securityId: member.securityId,
            buyWindowMode: member.windows ? "CUSTOM" : "FULL",
            ...(member.windows
              ? {
                  buyWindows: {
                    create: member.windows.map((window) => ({
                      startDate: new Date(`${window.startDate}T00:00:00.000Z`),
                      endDate: window.endDate
                        ? new Date(`${window.endDate}T00:00:00.000Z`)
                        : null,
                    })),
                  },
                }
              : {}),
          })),
        },
      },
    });
    const monitor = await prisma.monitor.create({
      data: {
        ownership: "SYSTEM",
        systemKey: `test-monitor-${key}`,
        name: "Built-in monitor",
        strategyId: strategy.id,
        stockListId: stockList.id,
      },
    });
    systemRows.push({
      monitorId: monitor.id,
      strategyId: strategy.id,
      stockListId: stockList.id,
    });
    createdMonitorIds.add(monitor.id);
    return monitor.id;
  }

  it("fetches each watched security once, never a member outside its ongoing membership, and nothing once final", async () => {
    const shared = await createSecurity(`EODA${suffix}`);
    const ended = await createSecurity(`EODB${suffix}`);
    const notYet = await createSecurity(`EODC${suffix}`);
    await createSystemMonitor([
      { securityId: shared.id },
      { securityId: ended.id, windows: [{ startDate: "2026-07-01", endDate: "2026-09-30" }] },
    ]);
    await createSystemMonitor([
      { securityId: shared.id },
      { securityId: notYet.id, windows: [{ startDate: "2027-01-04", endDate: null }] },
    ]);

    const provider = new HistoryProvider();
    let providerRequests = 0;
    const cache = new RedisStockDataCache(new IoredisCacheClient(redis), 10, namespace);
    const service = new CanonicalStockDataService(
      new PrismaStockDataStore(prisma),
      provider,
      cache,
      new InMemoryLoadCoordinator(),
      {
        productHistoryYears: 30,
        fundamentalsFreshnessMs: 30 * 24 * 60 * 60 * 1000,
        now: () => NOW,
        onProviderRequest: () => {
          providerRequests += 1;
        },
      },
    );
    const repository = new PrismaMonitorRepository(prisma);
    const run = new StockEodRefreshRun(
      service,
      {
        // The real repository, narrowed to this test's Monitors: other suites share the database.
        listActiveMonitors: async () =>
          (await repository.listActiveMonitors()).filter((monitor) =>
            createdMonitorIds.has(monitor.monitorId),
          ),
      },
      createLogger({ service: "worker", level: "silent" }),
      {
        policy: new EodFinalityPolicy({
          calendar: WEEKDAY_TRADING_CALENDAR,
          now: () => NOW,
        }),
        runBudgetMs: 60_000,
        securityConcurrency: 2,
        followUpMs: 30_000,
        providerRequests: () => providerRequests,
        now: () => NOW,
      },
    );

    const first = await run.run(1, () => false);
    expect(first.expectedSession).toBe(SESSION);
    expect(first.universe).toBe(1);
    expect(first.outcomes).toMatchObject([
      { securityId: shared.id, outcome: "READY", prepared: true, latestVerifiedBar: SESSION },
    ]);
    const requestedSymbols = new Set([
      ...provider.priceRequests.map((request) => request.symbol),
      ...provider.profileRequests,
    ]);
    expect(requestedSymbols).toEqual(new Set([shared.symbol]));
    expect(provider.priceRequests.every((request) => request.to <= SESSION)).toBe(true);
    expect(first.providerReads).toBeGreaterThan(0);

    // The session is stored, read after it became final: the next run asks nothing.
    const second = await run.run(2, () => false);
    expect(second.outcomes).toMatchObject([
      { securityId: shared.id, outcome: "READY", prepared: false },
    ]);
    expect(second.providerReads).toBe(0);

    // Redis losing the stock changes nothing: readiness is PostgreSQL's answer.
    await cache.evict(shared.id);
    const third = await run.run(3, () => false);
    expect(third.providerReads).toBe(0);
    expect(third.outcomes[0]).toMatchObject({ outcome: "READY", prepared: false });
    expect(await cache.getManifest(shared.id)).toBeNull();
  });

  /**
   * Pre-release audit 2026-10-16, finding OPS-02 (`docs/audits/pre-release-audit-2026-10-16.md`).
   *
   * The child decides "nothing to do" from the **price** tail alone. When the derived state is behind a
   * current price tail — exactly what a `DERIVED_STATE_REVISION` bump leaves for every security, and
   * what a crash between the price save and the derived rebuild leaves for one — it reported READY and
   * never repaired it, while the Monitor waited for `derivedThrough` (failed on `bebf3dc7`). It now
   * takes the ordinary preparation path, which rebuilds the gap from PostgreSQL.
   */
  it("OPS-02: repairs derived state that is behind a current price tail", async () => {
    const security = await createSecurity(`EODD${suffix}`);
    await createSystemMonitor([{ securityId: security.id }]);
    const provider = new HistoryProvider();
    const cache = new RedisStockDataCache(new IoredisCacheClient(redis), 10, namespace);
    const service = new CanonicalStockDataService(
      new PrismaStockDataStore(prisma),
      provider,
      cache,
      new InMemoryLoadCoordinator(),
      {
        productHistoryYears: 30,
        fundamentalsFreshnessMs: 30 * 24 * 60 * 60 * 1000,
        now: () => NOW,
      },
    );
    const repository = new PrismaMonitorRepository(prisma);
    const run = new StockEodRefreshRun(
      service,
      {
        listActiveMonitors: async () =>
          (await repository.listActiveMonitors()).filter((monitor) =>
            createdMonitorIds.has(monitor.monitorId),
          ),
      },
      createLogger({ service: "worker", level: "silent" }),
      {
        policy: new EodFinalityPolicy({
          calendar: WEEKDAY_TRADING_CALENDAR,
          now: () => NOW,
        }),
        runBudgetMs: 60_000,
        securityConcurrency: 2,
        followUpMs: 30_000,
        providerRequests: () => 0,
        now: () => NOW,
      },
    );
    await run.run(1, () => false);
    const row = (await service.findSecuritiesByIds([security.id]))[0]!;
    expect((await service.stockRefreshState(row)).derivedThrough).toBe(SESSION);

    // A revision bump: the current derived variant has no rows, no coverage and no state, while the
    // price tail stays exactly as current as it was.
    await prisma.dailyDerivedState.deleteMany({ where: { securityId: security.id } });
    await prisma.stockDatasetCoverage.deleteMany({
      where: { securityId: security.id, dataset: "DAILY_DERIVED_STATE" },
    });
    await prisma.stockDatasetState.deleteMany({
      where: { securityId: security.id, dataset: "DAILY_DERIVED_STATE" },
    });
    await cache.evict(security.id);
    expect((await service.stockRefreshState(row)).derivedThrough).toBeUndefined();

    await run.run(2, () => false);
    expect((await service.stockRefreshState(row)).derivedThrough).toBe(SESSION);
  });

  it("OPS-02: repairs it from PostgreSQL even while the cached projection still reads as current", async () => {
    const security = await createSecurity(`EODR${suffix}`);
    await createSystemMonitor([{ securityId: security.id }]);
    const provider = new HistoryProvider();
    const cache = new RedisStockDataCache(new IoredisCacheClient(redis), 10, namespace);
    const service = new CanonicalStockDataService(
      new PrismaStockDataStore(prisma),
      provider,
      cache,
      new InMemoryLoadCoordinator(),
      {
        productHistoryYears: 30,
        fundamentalsFreshnessMs: 30 * 24 * 60 * 60 * 1000,
        now: () => NOW,
      },
    );
    const repository = new PrismaMonitorRepository(prisma);
    const run = new StockEodRefreshRun(
      service,
      {
        listActiveMonitors: async () =>
          (await repository.listActiveMonitors()).filter((monitor) =>
            createdMonitorIds.has(monitor.monitorId),
          ),
      },
      createLogger({ service: "worker", level: "silent" }),
      {
        policy: new EodFinalityPolicy({
          calendar: WEEKDAY_TRADING_CALENDAR,
          now: () => NOW,
        }),
        runBudgetMs: 60_000,
        securityConcurrency: 2,
        followUpMs: 30_000,
        providerRequests: () => 0,
        now: () => NOW,
      },
    );
    await run.run(1, () => false);
    const row = (await service.findSecuritiesByIds([security.id]))[0]!;
    expect((await service.stockRefreshState(row)).derivedThrough).toBe(SESSION);

    // The derived state disappears from PostgreSQL alone — rows, coverage and state — with the
    // price tail exactly as current as it was.
    await prisma.dailyDerivedState.deleteMany({ where: { securityId: security.id } });
    await prisma.stockDatasetCoverage.deleteMany({
      where: { securityId: security.id, dataset: "DAILY_DERIVED_STATE" },
    });
    await prisma.stockDatasetState.deleteMany({
      where: { securityId: security.id, dataset: "DAILY_DERIVED_STATE" },
    });
    // The Redis projection is left exactly as it was: READY, current and covering, so nothing on the
    // cache side asks for a rebuild. Only PostgreSQL knows the derived state is gone.
    expect((await cache.getManifest(security.id))?.status).toBe("READY");
    expect((await service.stockRefreshState(row)).derivedThrough).toBeUndefined();
    const priceRequestsBefore = provider.priceRequests.length;

    await run.run(2, () => false);
    expect(provider.priceRequests.length).toBe(priceRequestsBefore);
    expect((await service.stockRefreshState(row)).derivedThrough).toBe(SESSION);
  });
});
