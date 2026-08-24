import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  IntrinsicValueModel,
  PrismaClient,
  SecurityType,
  StockDataset,
} from "@intrinsic/database";
import type { DateRange } from "@intrinsic/domain";
import {
  FmpClient,
  FmpRateLimitError,
  FmpTransientError,
  type FmpStockProviderPort,
} from "@intrinsic/fmp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisStockDataCache, type StockManifest } from "./cache.js";
import { RedlockLoadCoordinator } from "./coordination.js";
import { RedisFmpRequestGate } from "./fmp-gate.js";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
} from "./redis-client.js";
import { PrismaStockDataStore } from "./prisma-store.js";
import { CanonicalStockDataService } from "./service.js";

loadRootEnv();
const redisUrl = process.env.REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;
const describeInfrastructure =
  redisUrl && process.env.DATABASE_URL ? describe : describe.skip;

describeRedis("real Redis stock-data infrastructure", () => {
  const suffix = randomUUID();
  const namespace = `stock-data:v2:test:${suffix}`;
  const securityId = `security-${suffix}`;
  const redisA = createStockDataRedisClient(
    redisUrl ?? "redis://localhost:6379",
  );
  const redisB = createStockDataRedisClient(
    redisUrl ?? "redis://localhost:6379",
  );
  const cacheA = new RedisStockDataCache(
    new IoredisCacheClient(redisA),
    1,
    namespace,
  );
  const cacheB = new RedisStockDataCache(
    new IoredisCacheClient(redisB),
    1,
    namespace,
  );

  beforeAll(async () => {
    await redisA.ping();
    await redisB.ping();
  });

  afterAll(async () => {
    const registered = await redisA.smembers(
      `${namespace}:security:${securityId}:keys`,
    );
    const otherRegistered = await redisA.smembers(
      `${namespace}:security:security-other:keys`,
    );
    await redisA.del(
      ...registered,
      ...otherRegistered,
      `${namespace}:security:${securityId}:keys`,
      `${namespace}:security:security-other:keys`,
      `${namespace}:resident-stocks`,
      `${namespace}:access-sequence`,
      `${namespace}:gate:concurrent`,
      `${namespace}:gate:rate-window`,
      `${namespace}:gate:cooldown-until`,
      `stock-data:load:${namespace}:lock`,
      `stock-data:load:${namespace}:exception`,
      `stock-data:load:${namespace}:timeout`,
    );
    redisA.disconnect();
    redisB.disconnect();
  });

  it("writes yearly chunks, slices years, merges the current year, and publishes READY", async () => {
    await cacheA.writeDailyPriceYears(
      securityId,
      [
        stockPrice(securityId, "2019-12-31", 1),
        stockPrice(securityId, "2020-01-02", 2),
        stockPrice(securityId, "2021-01-04", 3),
      ],
      [2019, 2020, 2021],
    );
    await cacheA.setManifest(readyManifest(securityId));

    await expect(
      cacheB.readDailyPrices(securityId, {
        from: "2019-12-31",
        to: "2021-01-04",
      }),
    ).resolves.toHaveLength(3);

    const closedYear = await redisA.get(
      `${namespace}:security:${securityId}:prices:1D:2019`,
    );
    await cacheB.writeDailyPriceYears(
      securityId,
      [
        stockPrice(securityId, "2021-01-04", 3),
        stockPrice(securityId, "2021-01-05", 4),
      ],
      [2021],
    );
    expect(
      await redisA.get(`${namespace}:security:${securityId}:prices:1D:2019`),
    ).toBe(closedYear);
    await expect(cacheA.getManifest(securityId)).resolves.toMatchObject({
      status: "READY",
    });
  });

  it("shares global LRU order and evicts every registered key for one stock", async () => {
    await cacheA.touch(securityId);
    await cacheB.writeDailyPriceYears(
      "security-other",
      [stockPrice("security-other", "2021-01-04", 3)],
      [2021],
    );
    await cacheB.setManifest(readyManifest("security-other"));

    await expect(cacheA.hasResidentStock(securityId)).resolves.toBe(false);
    expect(
      await redisA.smembers(`${namespace}:security:${securityId}:keys`),
    ).toEqual([]);
    expect(
      await redisA.get(`${namespace}:security:${securityId}:prices:1D:2021`),
    ).toBeNull();
  });

  it("orders touch and capacity eviction atomically across clients", async () => {
    const lruNamespace = `${namespace}:atomic-lru`;
    const lruA = new RedisStockDataCache(
      new IoredisCacheClient(redisA),
      2,
      lruNamespace,
    );
    const lruB = new RedisStockDataCache(
      new IoredisCacheClient(redisB),
      2,
      lruNamespace,
    );
    const stocks = ["a", "b", "c"].map((id) => `security-${id}`);
    try {
      for (const stock of stocks.slice(0, 2)) {
        await lruA.writeDailyPriceYears(
          stock,
          [stockPrice(stock, "2021-01-04", 3)],
          [2021],
        );
        await lruA.setManifest(readyManifest(stock));
      }
      await lruA.touch(stocks[0]!);
      await lruB.writeDailyPriceYears(
        stocks[2]!,
        [stockPrice(stocks[2]!, "2021-01-04", 4)],
        [2021],
      );
      await lruB.setManifest(readyManifest(stocks[2]!));

      await expect(lruA.hasResidentStock(stocks[0]!)).resolves.toBe(true);
      await expect(lruA.hasResidentStock(stocks[1]!)).resolves.toBe(false);
      await expect(lruA.hasResidentStock(stocks[2]!)).resolves.toBe(true);
      await lruA.touch(stocks[1]!);
      await expect(lruA.hasResidentStock(stocks[1]!)).resolves.toBe(false);
      expect(await redisA.zcard(`${lruNamespace}:resident-stocks`)).toBe(2);
    } finally {
      for (const stock of stocks) {
        const registry = `${lruNamespace}:security:${stock}:keys`;
        const keys = await redisA.smembers(registry);
        if (keys.length > 0) await redisA.del(...keys);
        await redisA.del(registry);
      }
      await redisA.del(
        `${lruNamespace}:resident-stocks`,
        `${lruNamespace}:access-sequence`,
      );
    }
  });

  it("makes eviction and refresh admission atomic", async () => {
    await cacheA.writeDailyPriceYears(
      securityId,
      [stockPrice(securityId, "2021-01-04", 3)],
      [2021],
    );
    const manifest = readyManifest(securityId);
    await cacheA.setManifest(manifest);
    const hydrating = {
      ...manifest,
      status: "HYDRATING" as const,
      hydrationId: "refresh-race",
      hydratingAt: "2026-08-24T12:01:00.000Z",
    };

    const [beganRefresh] = await Promise.all([
      cacheA.beginRefresh(manifest, hydrating),
      cacheB.evict(securityId),
    ]);

    const cachedManifest = await cacheA.getManifest(securityId);
    const cachedPrices = await redisA.get(
      `${namespace}:security:${securityId}:prices:1D:2021`,
    );
    if (beganRefresh) {
      expect(cachedManifest?.status).toBe("HYDRATING");
      expect(cachedPrices).not.toBeNull();
    } else {
      expect(cachedManifest).toBeNull();
      expect(cachedPrices).toBeNull();
    }
  });

  it("coordinates separate instances so the second caller rechecks READY", async () => {
    const options = { lockDurationMs: 2_000, lockWaitMs: 5_000 };
    const coordinatorA = new RedlockLoadCoordinator(redisA, options);
    const coordinatorB = new RedlockLoadCoordinator(redisB, options);
    let ready = false;
    let hydrationCalls = 0;
    let releaseFirst = (): void => {};
    const blocker = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const work = async () => {
      if (ready) return "READY";
      hydrationCalls += 1;
      markStarted();
      await blocker;
      ready = true;
      return "HYDRATED";
    };

    const first = coordinatorA.run(`${namespace}:lock`, work);
    await started;
    const second = coordinatorB.run(`${namespace}:lock`, work);
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "HYDRATED",
      "READY",
    ]);
    expect(hydrationCalls).toBe(1);
  });

  it("releases a distributed lock after an exception", async () => {
    const options = { lockDurationMs: 2_000, lockWaitMs: 2_000 };
    const coordinatorA = new RedlockLoadCoordinator(redisA, options);
    const coordinatorB = new RedlockLoadCoordinator(redisB, options);
    await expect(
      coordinatorA.run(`${namespace}:exception`, async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(
      coordinatorB.run(`${namespace}:exception`, async () => "recovered"),
    ).resolves.toBe("recovered");
  });

  it("times out a waiter in finite time when the lock remains unavailable", async () => {
    const holder = new RedlockLoadCoordinator(redisA, {
      lockDurationMs: 2_000,
      lockWaitMs: 2_000,
    });
    const waiter = new RedlockLoadCoordinator(redisB, {
      lockDurationMs: 2_000,
      lockWaitMs: 400,
      retryDelayMs: 50,
    });
    let releaseHolder = (): void => {};
    const blocker = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let markStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = holder.run(`${namespace}:timeout`, async () => {
      markStarted();
      await blocker;
    });
    await started;
    const startedAt = Date.now();

    await expect(
      waiter.run(`${namespace}:timeout`, async () => "unexpected"),
    ).rejects.toThrow();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    releaseHolder();
    await first;
  });

  it("shares concurrency, rate, and cooldown backpressure across gate instances", async () => {
    const options = {
      maxConcurrentRequests: 1,
      rateLimitPerWindow: 1,
      rateWindowMs: 60,
      maxQueueDepth: 10,
      maxQueueWaitMs: 2_000,
      requestLeaseMs: 1_000,
      namespace: `${namespace}:gate`,
      random: () => 0,
    };
    const gateA = new RedisFmpRequestGate(redisA, options);
    const gateB = new RedisFmpRequestGate(redisB, options);
    let active = 0;
    let maximumActive = 0;
    let releaseFirst = (): void => {};
    const blocker = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = gateA.run(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      markStarted();
      await blocker;
      active -= 1;
      return 1;
    });
    await started;
    const secondStartedAt = Date.now();
    const second = gateB.run(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      active -= 1;
      return 2;
    });
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(maximumActive).toBe(1);
    expect(Date.now() - secondStartedAt).toBeGreaterThanOrEqual(40);

    await gateA.publishCooldown(120);
    const cooldownStartedAt = Date.now();
    const cooldownRequest = gateB.run(async () => 3);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(await redisA.zcard(`${namespace}:gate:concurrent`)).toBe(0);
    await cooldownRequest;
    expect(Date.now() - cooldownStartedAt).toBeGreaterThanOrEqual(100);
  });

  it("shares the full monotonic provider cooldown across clients", async () => {
    const gateOptions = {
      maxConcurrentRequests: 1,
      rateLimitPerWindow: 10,
      rateWindowMs: 1_000,
      maxQueueDepth: 10,
      maxQueueWaitMs: 100,
      requestLeaseMs: 1_000,
      namespace: `${namespace}:gate`,
      random: () => 0,
    };
    const gateA = new RedisFmpRequestGate(redisA, gateOptions);
    const gateB = new RedisFmpRequestGate(redisB, gateOptions);
    const firstFetch = async () =>
      new Response("[]", {
        status: 429,
        headers: { "retry-after": "120" },
      });
    const secondFetchCalls: string[] = [];
    const secondFetch = async () => {
      secondFetchCalls.push("called");
      return new Response("[]");
    };
    const clientA = new FmpClient(
      () => ({
        apiKey: "integration-secret",
        timeoutMs: 1_000,
        maxRetries: 2,
        maxRetryWaitMs: 30_000,
      }),
      firstFetch,
      { gate: gateA, random: () => 0 },
    );
    const clientB = new FmpClient(
      () => ({
        apiKey: "integration-secret",
        timeoutMs: 1_000,
        maxRetries: 0,
      }),
      secondFetch,
      { gate: gateB },
    );

    await expect(clientA.getProfile("AAPL")).rejects.toBeInstanceOf(
      FmpRateLimitError,
    );
    const beforeShorterPublish = await redisA.pttl(
      `${namespace}:gate:cooldown-until`,
    );
    await gateB.publishCooldown(20_000);
    const afterShorterPublish = await redisA.pttl(
      `${namespace}:gate:cooldown-until`,
    );
    expect(beforeShorterPublish).toBeGreaterThan(119_000);
    expect(afterShorterPublish).toBeGreaterThan(119_000);
    await expect(clientB.getProfile("AAPL")).rejects.toBeInstanceOf(
      FmpTransientError,
    );
    expect(secondFetchCalls).toEqual([]);
  });
});

describeInfrastructure("cross-process canonical hydration", () => {
  it("compacts durable coverage transactionally without advancing historical-only freshness", async () => {
    const suffix = randomUUID();
    const symbol = `C${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    const prismaA = new PrismaClient();
    const prismaB = new PrismaClient();
    const storeA = new PrismaStockDataStore(prismaA);
    const storeB = new PrismaStockDataStore(prismaB);
    let securityId: string | undefined;
    try {
      const security = await prismaA.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Coverage Compaction Integration Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;
      await prismaA.stockDatasetCoverage.create({
        data: {
          securityId: security.id,
          dataset: StockDataset.DAILY_PRICE,
          variant: "another-price-variant",
          fromDate: new Date("2026-01-01T00:00:00.000Z"),
          toDate: new Date("2026-12-31T00:00:00.000Z"),
          lastSuccessfulSyncAt: new Date("2026-01-01T01:00:00.000Z"),
        },
      });
      const saveCoverage = (
        store: PrismaStockDataStore,
        from: string,
        to: string,
        syncedAt: string,
        fresh = false,
      ) =>
        store.saveDailyPriceSync({
          securityId: security.id,
          prices: [],
          successfulCoverage: [{ from, to }],
          syncedAt,
          tailDate: "2026-08-24",
          ...(fresh ? { freshThrough: "2026-08-24" } : {}),
        });

      await saveCoverage(
        storeA,
        "2026-01-01",
        "2026-01-10",
        "2026-08-24T01:00:00.000Z",
        true,
      );
      await saveCoverage(
        storeB,
        "2026-01-01",
        "2026-01-10",
        "2026-08-24T00:30:00.000Z",
        true,
      );
      await saveCoverage(
        storeA,
        "2026-01-05",
        "2026-01-15",
        "2026-08-24T02:00:00.000Z",
      );
      await saveCoverage(
        storeA,
        "2026-01-16",
        "2026-01-20",
        "2026-08-24T03:00:00.000Z",
      );
      await saveCoverage(
        storeA,
        "2026-02-10",
        "2026-02-15",
        "2026-08-24T04:00:00.000Z",
      );
      await Promise.all([
        saveCoverage(
          storeA,
          "2026-01-21",
          "2026-01-25",
          "2026-08-24T05:00:00.000Z",
        ),
        saveCoverage(
          storeB,
          "2026-01-26",
          "2026-01-31",
          "2026-08-24T06:00:00.000Z",
        ),
      ]);

      await expect(
        storeA.getDatasetCoverage(
          security.id,
          "DAILY_PRICE",
          "split-adjusted-eod-full",
          { from: "2026-01-01", to: "2026-12-31" },
        ),
      ).resolves.toEqual([
        { from: "2026-01-01", to: "2026-01-31" },
        { from: "2026-02-10", to: "2026-02-15" },
      ]);
      expect(
        await prismaA.stockDatasetCoverage.count({
          where: {
            securityId: security.id,
            variant: "another-price-variant",
          },
        }),
      ).toBe(1);
      await expect(
        storeA.getLatestCoverageSyncContainingDate(
          security.id,
          "DAILY_PRICE",
          "split-adjusted-eod-full",
          "2026-08-24",
        ),
      ).resolves.toBe("2026-08-24T01:00:00.000Z");

      await expect(
        storeA.saveDailyPriceSync({
          securityId: security.id,
          prices: [integrationPrice(security.id, "2026-03-01", 11)],
          successfulCoverage: [{ from: "2026-03-01", to: "2026-03-01" }],
          syncedAt: "2026-08-24T06:30:00.000Z",
          tailDate: "2026-08-24",
          assertOwned: () => {
            throw new Error("lease lost before commit");
          },
        }),
      ).rejects.toThrow("lease lost before commit");
      expect(
        await prismaA.dailyPrice.count({
          where: {
            securityId: security.id,
            date: new Date("2026-03-01T00:00:00.000Z"),
          },
        }),
      ).toBe(0);

      await expect(
        storeA.saveDailyPriceSync({
          securityId: security.id,
          prices: [
            {
              ...integrationPrice(security.id, "2026-02-01", 10),
              volume: 1.5,
            },
          ],
          successfulCoverage: [{ from: "2026-02-01", to: "2026-02-09" }],
          syncedAt: "2026-08-24T07:00:00.000Z",
          tailDate: "2026-08-24",
        }),
      ).rejects.toThrow();
      await expect(
        storeA.getDatasetCoverage(
          security.id,
          "DAILY_PRICE",
          "split-adjusted-eod-full",
          { from: "2026-01-01", to: "2026-12-31" },
        ),
      ).resolves.toEqual([
        { from: "2026-01-01", to: "2026-01-31" },
        { from: "2026-02-10", to: "2026-02-15" },
      ]);
    } finally {
      if (securityId) {
        await prismaA.security.deleteMany({ where: { id: securityId } });
      }
      await prismaA.$disconnect();
      await prismaB.$disconnect();
    }
  });

  it("uses one FMP delta for two service instances with different projections", async () => {
    const suffix = randomUUID();
    const namespace = `stock-data:v2:test:service:${suffix}`;
    const symbol = `T${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    const prismaA = new PrismaClient();
    const prismaB = new PrismaClient();
    const redisA = createStockDataRedisClient(
      redisUrl ?? "redis://localhost:6379",
    );
    const redisB = createStockDataRedisClient(
      redisUrl ?? "redis://localhost:6379",
    );
    const provider = new IntegrationProvider();
    let securityId: string | undefined;
    try {
      const security = await prismaA.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Hydration Integration Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;
      provider.securityId = security.id;
      await prismaA.dailyPrice.create({
        data: {
          securityId: security.id,
          date: new Date("2022-01-03T00:00:00.000Z"),
          open: 150,
          high: 150,
          low: 150,
          close: 150,
          volume: 100n,
        },
      });
      await prismaA.stockDatasetCoverage.create({
        data: {
          securityId: security.id,
          dataset: StockDataset.DAILY_PRICE,
          variant: "split-adjusted-eod-full",
          fromDate: new Date("2015-01-01T00:00:00.000Z"),
          toDate: new Date("2026-08-24T00:00:00.000Z"),
          lastSuccessfulSyncAt: new Date("2026-08-24T12:00:00.000Z"),
        },
      });
      await prismaA.stockDatasetState.create({
        data: {
          securityId: security.id,
          dataset: StockDataset.DAILY_PRICE,
          variant: "split-adjusted-eod-full:recent-tail",
          earliestDate: new Date("2026-08-24T00:00:00.000Z"),
          latestDate: new Date("2026-08-24T00:00:00.000Z"),
          lastSuccessfulSyncAt: new Date("2026-08-24T12:00:00.000Z"),
        },
      });
      provider.rows.set("1996-08-24:2014-12-31", [
        integrationPrice(security.id, "2010-01-04", 30),
      ]);
      const serviceA = new CanonicalStockDataService(
        new PrismaStockDataStore(prismaA),
        provider,
        new RedisStockDataCache(new IoredisCacheClient(redisA), 10, namespace),
        new RedlockLoadCoordinator(redisA, {
          lockDurationMs: 2_000,
          lockWaitMs: 6_000,
        }),
        { historyYears: 30, now: () => new Date("2026-08-24T12:00:00.000Z") },
      );
      const serviceB = new CanonicalStockDataService(
        new PrismaStockDataStore(prismaB),
        provider,
        new RedisStockDataCache(new IoredisCacheClient(redisB), 10, namespace),
        new RedlockLoadCoordinator(redisB, {
          lockDurationMs: 2_000,
          lockWaitMs: 6_000,
        }),
        { historyYears: 30, now: () => new Date("2026-08-24T12:00:00.000Z") },
      );

      provider.delayMs = 3_500;
      const startedAt = Date.now();
      const [older, newer] = await Promise.all([
        serviceA.getDailyPrices(symbol, {
          from: "2010-01-01",
          to: "2020-12-31",
        }),
        serviceB.getDailyPrices(symbol, {
          from: "2021-01-01",
          to: "2025-12-31",
        }),
      ]);

      expect(provider.ranges).toEqual([
        { from: "1996-08-24", to: "2014-12-31" },
      ]);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3_000);
      expect(older.map((row) => row.date)).toEqual(["2010-01-04"]);
      expect(newer.map((row) => row.date)).toEqual(["2022-01-03"]);
    } finally {
      if (securityId) {
        const cache = new RedisStockDataCache(
          new IoredisCacheClient(redisA),
          10,
          namespace,
        );
        await cache.evict(securityId);
        await prismaA.security.deleteMany({ where: { id: securityId } });
      }
      redisA.disconnect();
      redisB.disconnect();
      await prismaA.$disconnect();
      await prismaB.$disconnect();
    }
  });

  it("calculates a blend from the highest complete common persisted version", async () => {
    const suffix = randomUUID();
    const namespace = `stock-data:v2:test:blend:${suffix}`;
    const symbol = `B${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    const prisma = new PrismaClient();
    const redis = createStockDataRedisClient(
      redisUrl ?? "redis://localhost:6379",
    );
    const store = new PrismaStockDataStore(prisma);
    const cache = new RedisStockDataCache(
      new IoredisCacheClient(redis),
      10,
      namespace,
    );
    let securityId: string | undefined;
    try {
      const security = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Blend Version Integration Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;
      await prisma.intrinsicValue.createMany({
        data: [
          [IntrinsicValueModel.DCF_FCFF, 100, 1],
          [IntrinsicValueModel.RESIDUAL_INCOME, 80, 1],
          [IntrinsicValueModel.GRAHAM, 60, 1],
          [IntrinsicValueModel.DCF_FCFF, 200, 2],
        ].map(([model, valuePerShare, calculationVersion]) => ({
          securityId: security.id,
          valuationDate: new Date("2025-02-01T00:00:00.000Z"),
          sourceDataAsOf: new Date("2025-02-01T12:00:00.000Z"),
          model: model as IntrinsicValueModel,
          valuePerShare: valuePerShare as number,
          currency: "USD",
          calculationVersion: calculationVersion as number,
        })),
      });
      await cache.setManifest(readyManifest(security.id));
      const service = new CanonicalStockDataService(
        store,
        new IntegrationProvider(),
        cache,
        new RedlockLoadCoordinator(redis, {
          lockDurationMs: 5_000,
          lockWaitMs: 5_000,
        }),
        { historyYears: 30, now: () => new Date("2026-08-24T12:00:00.000Z") },
      );

      const publicPoints = await store.getIntrinsicValues(security.id, {
        from: "2025-02-01",
        to: "2025-02-01",
      });
      const blends = await service.getIntrinsicValueBlends(symbol, {
        from: "2025-02-01",
        to: "2025-02-01",
        blendIds: ["BALANCED"],
      });

      expect(
        publicPoints.find((point) => point.model === "DCF_FCFF")
          ?.calculationVersion,
      ).toBe(2);
      expect(blends).toMatchObject([
        { valuePerShare: 86, calculationVersion: 1, blendVersion: 1 },
      ]);
    } finally {
      if (securityId) {
        await cache.evict(securityId);
        await prisma.security.deleteMany({ where: { id: securityId } });
      }
      redis.disconnect();
      await prisma.$disconnect();
    }
  });

  it("recovers stale HYDRATING state and removes registered orphan chunks", async () => {
    const suffix = randomUUID();
    const namespace = `stock-data:v2:test:recovery:${suffix}`;
    const symbol = `R${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    const prisma = new PrismaClient();
    const redis = createStockDataRedisClient(
      redisUrl ?? "redis://localhost:6379",
    );
    const cache = new RedisStockDataCache(
      new IoredisCacheClient(redis),
      10,
      namespace,
    );
    const provider = new IntegrationProvider();
    let securityId: string | undefined;
    try {
      const security = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Hydration Recovery Integration Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;
      await prisma.dailyPrice.create({
        data: {
          securityId: security.id,
          date: new Date("2026-08-20T00:00:00.000Z"),
          open: 200,
          high: 200,
          low: 200,
          close: 200,
          volume: 100n,
        },
      });
      await prisma.stockDatasetCoverage.create({
        data: {
          securityId: security.id,
          dataset: StockDataset.DAILY_PRICE,
          variant: "split-adjusted-eod-full",
          fromDate: new Date("1996-08-24T00:00:00.000Z"),
          toDate: new Date("2026-08-24T00:00:00.000Z"),
          lastSuccessfulSyncAt: new Date("2026-08-24T12:00:00.000Z"),
        },
      });
      await prisma.stockDatasetState.create({
        data: {
          securityId: security.id,
          dataset: StockDataset.DAILY_PRICE,
          variant: "split-adjusted-eod-full:recent-tail",
          earliestDate: new Date("2026-08-24T00:00:00.000Z"),
          latestDate: new Date("2026-08-24T00:00:00.000Z"),
          lastSuccessfulSyncAt: new Date("2026-08-24T12:00:00.000Z"),
        },
      });
      const staleYearKey = `${namespace}:security:${security.id}:prices:1D:1990`;
      await cache.writeDailyPriceYears(
        security.id,
        [stockPrice(security.id, "1990-01-02", 1)],
        [1990],
      );
      const ready = readyManifest(security.id);
      await cache.setManifest(ready);
      const staleHydration = {
        ...ready,
        status: "HYDRATING" as const,
        hydrationId: "crashed-process",
        hydratingAt: "2026-08-24T11:00:00.000Z",
      };
      await expect(cache.beginRefresh(ready, staleHydration)).resolves.toBe(
        true,
      );
      await expect(cache.hasResidentStock(security.id)).resolves.toBe(false);

      const service = new CanonicalStockDataService(
        new PrismaStockDataStore(prisma),
        provider,
        cache,
        new RedlockLoadCoordinator(redis, {
          lockDurationMs: 5_000,
          lockWaitMs: 5_000,
        }),
        { historyYears: 30, now: () => new Date("2026-08-24T12:00:00.000Z") },
      );
      await expect(
        service.getDailyPrices(symbol, {
          from: "2026-08-01",
          to: "2026-08-24",
        }),
      ).resolves.toEqual([integrationPrice(security.id, "2026-08-20", 200)]);

      expect(provider.ranges).toEqual([]);
      await expect(cache.getManifest(security.id)).resolves.toMatchObject({
        status: "READY",
      });
      await expect(cache.hasResidentStock(security.id)).resolves.toBe(true);
      expect(await redis.get(staleYearKey)).toBeNull();
      expect(
        await redis.smembers(`${namespace}:security:${security.id}:keys`),
      ).not.toContain(staleYearKey);
    } finally {
      if (securityId) {
        const registry = `${namespace}:security:${securityId}:keys`;
        const keys = await redis.smembers(registry);
        if (keys.length > 0) await redis.del(...keys);
        await redis.del(registry);
        await prisma.security.deleteMany({ where: { id: securityId } });
      }
      await redis.del(
        `${namespace}:resident-stocks`,
        `${namespace}:access-sequence`,
      );
      redis.disconnect();
      await prisma.$disconnect();
    }
  });
});

class IntegrationProvider implements FmpStockProviderPort {
  securityId = "";
  readonly ranges: Required<DateRange>[] = [];
  readonly rows = new Map<string, ReturnType<typeof integrationPrice>[]>();
  delayMs = 0;

  async getProfile() {
    return null;
  }

  async getDailyPrices(_symbol: string, _securityId: string, range: DateRange) {
    if (!range.from || !range.to) throw new Error("Expected bounded range");
    this.ranges.push({ from: range.from, to: range.to });
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.delayMs);
      });
    }
    return this.rows.get(`${range.from}:${range.to}`) ?? [];
  }
}

function integrationPrice(securityId: string, date: string, close: number) {
  return {
    securityId,
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 100,
  };
}

function stockPrice(securityId: string, date: string, close: number) {
  return {
    securityId,
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 100,
  };
}

function readyManifest(securityId: string): StockManifest {
  return {
    securityId,
    status: "READY",
    historyYears: 30,
    coverageStart: "1996-08-24",
    coverageEnd: "2026-08-24",
    canonicalHistoryStart: "2019-12-31",
    canonicalHistoryEnd: "2021-01-04",
    hydratedAt: "2026-08-24T12:00:00.000Z",
    lastPriceRefreshAt: "2026-08-24T12:00:00.000Z",
    priceDatasetVersion: 1,
    dailyTechnicalVersion: 1,
    weeklyVersion: 2,
  };
}
