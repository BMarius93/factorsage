import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  PrismaClient,
  SecurityType,
  StockDataset,
} from "@intrinsic/database";
import type { DateRange, FinancialStatement } from "@intrinsic/domain";
import {
  FmpClient,
  FmpRateLimitError,
  FmpTransientError,
  type FmpStockProviderPort,
} from "@intrinsic/fmp";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RedisStockDataCache, type StockManifest } from "./cache.js";
import { RedlockLoadCoordinator } from "./coordination.js";
import {
  DAILY_DERIVED_STATE_VARIANT,
  DERIVED_STATE_REVISION,
} from "./derived-state.js";
import { WEEKLY_PRICE_VARIANT } from "./ports.js";
import { RedisFmpRequestGate } from "./fmp-gate.js";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
} from "./redis-client.js";
import { PrismaStockDataStore } from "./prisma-store.js";
import { CanonicalStockDataService } from "./service.js";

loadRootEnv();
// PostgreSQL-backed cases below write through Prisma, so they use the dedicated test
// database rather than DATABASE_URL. Redis stays isolated by namespace, not by instance.
useTestDatabase();
const redisUrl = process.env.REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;
const describeInfrastructure = redisUrl ? describe : describe.skip;

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

  it("round-trips intrinsic fields through the shared daily-state chunks without new keys", async () => {
    // Its own security id, so the shared generation/LRU state of the other cases cannot interfere.
    const securityId = `security-${randomUUID()}`;
    const rows = [
      {
        securityId,
        date: "2026-08-20",
        sma20d: 121.5,
        intrinsicValues: { DCF_FCFF: 178.8977101328, GRAHAM: 148 },
        intrinsicValueBlends: { BALANCED: 148.8039930756 },
        dcfFcffSourceAsOf: "2026-01-05T00:00:00.000Z",
        grahamSourceAsOf: "2025-11-02T00:00:00.000Z",
        intrinsicCurrency: "USD",
      },
      { securityId, date: "2026-08-21", sma20d: 122 },
    ];

    try {
      await cacheA.writeDailyDerivedStateYears(securityId, rows, [2026]);
      await cacheA.setManifest(readyManifest(securityId));

      // The unified daily-state chunk carries intrinsic fields through the existing serialization.
      await expect(
        cacheB.readDailyDerivedState(securityId, {
          from: "2026-08-20",
          to: "2026-08-21",
        }),
      ).resolves.toEqual(rows);
      // No separate intrinsic dataset or key family is introduced.
      const keys = await redisA.smembers(
        `${namespace}:security:${securityId}:keys`,
      );
      expect(
        keys.filter((key) => /intrinsic|valuation|blend/i.test(key)),
      ).toEqual([]);
      expect(keys.some((key) => key.includes(":daily-state:2026"))).toBe(true);
    } finally {
      await cacheA.evict(securityId);
    }
  });

  it("stores immutable financial revisions in yearly chunks and preserves asOf selection", async () => {
    const financialSecurityId = `${securityId}-financials`;
    await cacheA.evict(financialSecurityId);
    const first = financialRow(financialSecurityId, {
      fiscalDate: "2021-03-31",
      filingDate: "2021-04-20",
      availableFromDate: "2021-04-21",
      observedAt: "2021-04-20T12:00:00.000Z",
      contentHash: "rev-1",
      values: { revenue: 100 },
    });
    const second = financialRow(financialSecurityId, {
      fiscalDate: "2021-03-31",
      filingDate: "2021-05-20",
      availableFromDate: "2021-05-21",
      observedAt: "2021-05-20T12:00:00.000Z",
      contentHash: "rev-2",
      values: { revenue: 200 },
    });
    await cacheA.writeFinancialStatementYears(
      financialSecurityId,
      [first, second],
      "INCOME",
      "QUARTERLY",
      [2021],
    );
    await cacheA.setManifest(readyManifest(financialSecurityId));

    await expect(
      cacheB.readFinancialStatements(financialSecurityId, {
        statementTypes: ["INCOME"],
        cadence: "QUARTERLY",
        from: "2021-01-01",
        to: "2021-12-31",
        asOf: "2021-05-01",
      }),
    ).resolves.toMatchObject([{ contentHash: "rev-1", values: { revenue: 100 } }]);
    await expect(
      cacheB.readFinancialStatements(financialSecurityId, {
        statementTypes: ["INCOME"],
        cadence: "QUARTERLY",
        from: "2021-01-01",
        to: "2021-12-31",
      }),
    ).resolves.toMatchObject([{ contentHash: "rev-2", values: { revenue: 200 } }]);
    await cacheA.evict(financialSecurityId);
  });

  it("shares global LRU order and evicts every registered key for one stock", async () => {
    await cacheA.writeDailyPriceYears(
      securityId,
      [stockPrice(securityId, "2021-01-04", 3)],
      [2021],
    );
    await cacheA.writeFinancialStatementYears(
      securityId,
      [financialRow(securityId)],
      "INCOME",
      "QUARTERLY",
      [2021],
    );
    await cacheA.setManifest(readyManifest(securityId));
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
    expect(
      await redisA.get(
        `${namespace}:security:${securityId}:financials:income:quarter:v1:2021`,
      ),
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

  it("expires an abandoned HYDRATING generation without another stock access", async () => {
    const ttlNamespace = `${namespace}:abandoned-hydration`;
    const ttlSecurityId = `${securityId}-abandoned`;
    const symbol = "ABANDONED";
    const hydrationTtlMs = 300;
    const cache = new RedisStockDataCache(
      new IoredisCacheClient(redisA),
      2,
      ttlNamespace,
      hydrationTtlMs,
    );
    const hydrating = hydratingManifest(ttlSecurityId, "abandoned");
    const keys = hydrationKeys(ttlNamespace, ttlSecurityId, symbol);

    await expect(cache.beginHydration(null, hydrating)).resolves.toBe(true);
    await cache.setSecurity(cacheSecurity(ttlSecurityId, symbol));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 180);
    });
    await writeRepresentativeHydration(cache, ttlSecurityId, hydrating);
    expect(await redisA.pttl(keys.registry)).toBeGreaterThan(0);
    expect(await redisA.pttl(keys.security)).toBeGreaterThan(0);
    expect(await redisA.pttl(keys.price)).toBeGreaterThan(0);
    expect(await redisA.pttl(keys.dailyState)).toBeGreaterThan(0);
    expect(await redisA.pttl(keys.financial)).toBeGreaterThan(0);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 150);
    });

    expect(await redisA.get(keys.manifest)).not.toBeNull();
    expect(await redisA.get(keys.security)).not.toBeNull();
    expect(await redisA.get(keys.price)).not.toBeNull();
    expect(await redisA.get(keys.dailyState)).not.toBeNull();
    expect(await redisA.get(keys.financial)).not.toBeNull();

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });

    expect(await redisA.get(keys.manifest)).toBeNull();
    expect(await redisA.exists(keys.registry)).toBe(0);
    expect(await redisA.get(keys.security)).toBeNull();
    expect(await redisA.get(keys.price)).toBeNull();
    expect(await redisA.get(keys.dailyState)).toBeNull();
    expect(await redisA.get(keys.financial)).toBeNull();
    await expect(cache.hasResidentStock(ttlSecurityId)).resolves.toBe(false);
  });

  it("persists a successful READY generation beyond the hydration TTL", async () => {
    const ttlNamespace = `${namespace}:ready-hydration`;
    const ttlSecurityId = `${securityId}-ready`;
    const symbol = "READYTTL";
    const hydrationTtlMs = 300;
    const cache = new RedisStockDataCache(
      new IoredisCacheClient(redisA),
      2,
      ttlNamespace,
      hydrationTtlMs,
    );
    const hydrating = hydratingManifest(ttlSecurityId, "successful");
    const keys = hydrationKeys(ttlNamespace, ttlSecurityId, symbol);
    try {
      await expect(cache.beginHydration(null, hydrating)).resolves.toBe(true);
      await cache.setSecurity(cacheSecurity(ttlSecurityId, symbol), hydrating);
      await writeRepresentativeHydration(cache, ttlSecurityId, hydrating);
      await expect(
        cache.completeHydration(hydrating, readyManifest(ttlSecurityId)),
      ).resolves.toBe(true);
      expect(await redisA.pttl(keys.manifest)).toBe(-1);
      expect(await redisA.pttl(keys.registry)).toBe(-1);
      expect(await redisA.pttl(keys.security)).toBe(-1);
      expect(await redisA.pttl(keys.price)).toBe(-1);
      expect(await redisA.pttl(keys.dailyState)).toBe(-1);
      expect(await redisA.pttl(keys.financial)).toBe(-1);

      await new Promise<void>((resolve) => {
        setTimeout(resolve, hydrationTtlMs + 100);
      });

      expect(await redisA.get(keys.manifest)).not.toBeNull();
      expect(await redisA.exists(keys.registry)).toBe(1);
      expect(await redisA.get(keys.security)).not.toBeNull();
      expect(await redisA.get(keys.price)).not.toBeNull();
      expect(await redisA.get(keys.dailyState)).not.toBeNull();
      expect(await redisA.get(keys.financial)).not.toBeNull();
      await expect(cache.hasResidentStock(ttlSecurityId)).resolves.toBe(true);
    } finally {
      await cache.evict(ttlSecurityId);
      await redisA.del(`${ttlNamespace}:access-sequence`);
    }
  });

  it("does not persist successor keys from a stale hydration generation", async () => {
    const ttlNamespace = `${namespace}:stale-hydration`;
    const ttlSecurityId = `${securityId}-stale`;
    const symbol = "STALETTL";
    const hydrationTtlMs = 500;
    const cache = new RedisStockDataCache(
      new IoredisCacheClient(redisA),
      2,
      ttlNamespace,
      hydrationTtlMs,
    );
    const first = hydratingManifest(ttlSecurityId, "first");
    const successor = hydratingManifest(ttlSecurityId, "successor");
    const keys = hydrationKeys(ttlNamespace, ttlSecurityId, symbol);
    try {
      await expect(cache.beginHydration(null, first)).resolves.toBe(true);
      await writeRepresentativeHydration(cache, ttlSecurityId, first);
      await expect(cache.beginHydration(first, successor)).resolves.toBe(true);
      await cache.setSecurity(cacheSecurity(ttlSecurityId, symbol), successor);
      await writeRepresentativeHydration(cache, ttlSecurityId, successor);

      await expect(
        cache.completeHydration(first, readyManifest(ttlSecurityId)),
      ).resolves.toBe(false);

      await expect(cache.getManifest(ttlSecurityId)).resolves.toEqual(
        successor,
      );
      expect(await redisA.pttl(keys.registry)).toBeGreaterThan(0);
      expect(await redisA.pttl(keys.security)).toBeGreaterThan(0);
      expect(await redisA.pttl(keys.price)).toBeGreaterThan(0);
      expect(await redisA.pttl(keys.dailyState)).toBeGreaterThan(0);
      expect(await redisA.pttl(keys.financial)).toBeGreaterThan(0);
      await expect(cache.hasResidentStock(ttlSecurityId)).resolves.toBe(false);
    } finally {
      const registered = await redisA.smembers(keys.registry);
      if (registered.length > 0) await redisA.del(...registered);
      await redisA.del(
        keys.registry,
        `${ttlNamespace}:resident-stocks`,
        `${ttlNamespace}:access-sequence`,
      );
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
    const remainingRateWindow = await redisA.pttl(
      `${namespace}:gate:rate-window`,
    );
    expect(remainingRateWindow).toBeGreaterThan(0);
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
    expect(Date.now() - secondStartedAt).toBeGreaterThanOrEqual(
      Math.max(1, remainingRateWindow - 20),
    );

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

  it("admits backlog starts against the rate window in which they actually begin", async () => {
    const backlogNamespace = `${namespace}:backlog-gate`;
    const rateWindowMs = 200;
    const options = {
      maxConcurrentRequests: 1,
      rateLimitPerWindow: 2,
      rateWindowMs,
      maxQueueDepth: 10,
      maxQueueWaitMs: 2_000,
      requestLeaseMs: 1_000,
      namespace: backlogNamespace,
      random: () => 0,
      sleep: (delayMs: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(delayMs, 5));
        }),
    };
    const gateA = new RedisFmpRequestGate(redisA, options);
    const gateB = new RedisFmpRequestGate(redisB, options);
    let releaseFirst = (): void => {};
    const blocker = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted = (): void => {};
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const queuedStarts: number[] = [];
    try {
      const first = gateA.run(async () => {
        markFirstStarted();
        await blocker;
      });
      await firstStarted;
      const queued = [gateB, gateA, gateB].map((gate) =>
        gate.run(async () => {
          queuedStarts.push(Date.now());
        }),
      );

      await new Promise<void>((resolve) => {
        setTimeout(resolve, rateWindowMs + 50);
      });
      releaseFirst();
      await Promise.all([first, ...queued]);

      expect(queuedStarts).toHaveLength(3);
      expect(queuedStarts[2]! - queuedStarts[0]!).toBeGreaterThanOrEqual(
        rateWindowMs - 25,
      );
    } finally {
      releaseFirst();
      await redisA.del(
        `${backlogNamespace}:concurrent`,
        `${backlogNamespace}:rate-window`,
        `${backlogNamespace}:cooldown-until`,
      );
    }
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
  it("records current daily and weekly state when derived output is empty", async () => {
    const suffix = randomUUID();
    const symbol = `E${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    const prisma = new PrismaClient();
    let securityId: string | undefined;
    try {
      const security = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Empty Derived State Integration Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;
      const store = new PrismaStockDataStore(prisma);

      await store.saveDailyDerivedState({
        securityId: security.id,
        rows: [],
        weeklyPrices: [],
        successfulCoverage: { from: "2026-08-24", to: "2026-08-24" },
        syncedAt: "2026-08-24T12:00:00.000Z",
      });

      const derivedState = await prisma.stockDatasetState.findUnique({
        where: {
          securityId_dataset_variant: {
            securityId: security.id,
            dataset: StockDataset.DAILY_DERIVED_STATE,
            variant: DAILY_DERIVED_STATE_VARIANT,
          },
        },
      });
      expect(derivedState).not.toBeNull();
      expect(derivedState).not.toHaveProperty("calculationVersion");
      await expect(
        prisma.stockDatasetState.findUnique({
          where: {
            securityId_dataset_variant: {
              securityId: security.id,
              dataset: StockDataset.WEEKLY_PRICE,
              variant: WEEKLY_PRICE_VARIANT,
            },
          },
        }),
      ).resolves.not.toBeNull();
    } finally {
      if (securityId) {
        await prisma.security.deleteMany({ where: { id: securityId } });
      }
      await prisma.$disconnect();
    }
  });

  it("keeps derived technical state writes on a single valid transaction client", async () => {
    const suffix = randomUUID();
    const symbol = `V${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    const prisma = new PrismaClient();
    let securityId: string | undefined;
    try {
      const security = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Transaction Lifecycle Corp",
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
        store.saveDailyPriceSync({
          securityId: security.id,
          prices: [
            {
              securityId: security.id,
              date: "2026-08-20",
              open: 100,
              high: 110,
              low: 95,
              close: 105,
              volume: 2500,
            },
          ],
          successfulCoverage: [{ from: "2026-08-20", to: "2026-08-20" }],
          syncedAt: "2026-08-24T12:00:00.000Z",
          tailDate: "2026-08-24",
          freshThrough: "2026-08-24",
        }),
      ).resolves.toEqual({ earliestChangedDate: "2026-08-20" });

      await expect(
        store.saveDailyDerivedState({
          securityId: security.id,
          rows: [
            {
              securityId: security.id,
              date: "2026-08-20",
              sma20d: 102,
              sma50d: 101,
              sma100d: 100,
              sma200d: 99,
              ema20d: 104,
              ema50d: 103,
              ema200d: 102,
            },
          ],
          weeklyPrices: [
            {
              securityId: security.id,
              weekStartDate: "2026-08-17",
              weekEndDate: "2026-08-21",
              eligibleDate: "2026-08-21",
              open: 101,
              high: 108,
              low: 96,
              close: 104,
              volume: 3000,
            },
          ],
          successfulCoverage: { from: "2026-08-17", to: "2026-08-21" },
          syncedAt: "2026-08-24T12:00:00.000Z",
        }),
      ).resolves.toBeUndefined();

      await expect(
        prisma.stockDatasetState.findUnique({
          where: {
            securityId_dataset_variant: {
              securityId: security.id,
              dataset: StockDataset.DAILY_DERIVED_STATE,
              variant: DAILY_DERIVED_STATE_VARIANT,
            },
          },
        }),
      ).resolves.not.toBeNull();
      await expect(
        prisma.stockDatasetState.findUnique({
          where: {
            securityId_dataset_variant: {
              securityId: security.id,
              dataset: StockDataset.WEEKLY_PRICE,
              variant: WEEKLY_PRICE_VARIANT,
            },
          },
        }),
      ).resolves.not.toBeNull();
    } finally {
      if (securityId) {
        await prisma.security.deleteMany({ where: { id: securityId } });
      }
      await prisma.$disconnect();
    }
  });

  it("persists multi-year derived datasets with a short per-dataset transaction", async () => {
    const suffix = randomUUID();
    const symbol = `W${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    const prisma = new PrismaClient();
    let securityId: string | undefined;
    try {
      const security = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Multi Year Hydration Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;
      const store = new PrismaStockDataStore(prisma);

      const technicals = Array.from({ length: 5_000 }, (_, index) => {
        const date = new Date(Date.UTC(2021, 0, 1 + index));
        return {
          securityId: security.id,
          date: date.toISOString().slice(0, 10),
          sma20d: 100 + index * 0.01,
          sma50d: 101 + index * 0.01,
          sma100d: 102 + index * 0.01,
          sma200d: 103 + index * 0.01,
          ema20d: 104 + index * 0.01,
          ema50d: 105 + index * 0.01,
          ema200d: 106 + index * 0.01,
          calculationVersion: 1,
        };
      });

      const weeklyPrices = Array.from({ length: 1_000 }, (_, index) => {
        const start = new Date(Date.UTC(2021, 0, 4 + index * 7));
        const end = new Date(Date.UTC(2021, 0, 10 + index * 7));
        const eligible = new Date(Date.UTC(2021, 0, 11 + index * 7));
        return {
          securityId: security.id,
          weekStartDate: start.toISOString().slice(0, 10),
          weekEndDate: end.toISOString().slice(0, 10),
          eligibleDate: eligible.toISOString().slice(0, 10),
          open: 100 + index,
          high: 110 + index,
          low: 90 + index,
          close: 105 + index,
          volume: 1_000 + index,
        };
      });

      await expect(
        store.saveDailyDerivedState({
          securityId: security.id,
          rows: technicals,
          weeklyPrices,
          successfulCoverage: { from: "2021-01-01", to: "2026-08-21" },
          syncedAt: "2026-08-24T12:00:00.000Z",
        }),
      ).resolves.toBeUndefined();

      // Exactly one derived row per (securityId, date); no parallel methodology rows.
      await expect(
        prisma.dailyDerivedState.count({ where: { securityId: security.id } }),
      ).resolves.toBe(technicals.length);
      await expect(
        prisma.weeklyPrice.count({ where: { securityId: security.id } }),
      ).resolves.toBe(weeklyPrices.length);
    } finally {
      if (securityId) {
        await prisma.security.deleteMany({ where: { id: securityId } });
      }
      await prisma.$disconnect();
    }
  });

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
      const storeA = new PrismaStockDataStore(prismaA);
      const storeB = new PrismaStockDataStore(prismaB);
      const derivedWritesA = vi.spyOn(storeA, "saveDailyDerivedState");
      const derivedWritesB = vi.spyOn(storeB, "saveDailyDerivedState");
      const cacheA = new RedisStockDataCache(
        new IoredisCacheClient(redisA),
        10,
        namespace,
      );
      const serviceA = new CanonicalStockDataService(
        storeA,
        provider,
        cacheA,
        new RedlockLoadCoordinator(redisA, {
          lockDurationMs: 2_000,
          lockWaitMs: 6_000,
        }),
        { historyYears: 30, now: () => new Date("2026-08-24T12:00:00.000Z") },
      );
      const serviceB = new CanonicalStockDataService(
        storeB,
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
      await expect(
        prismaA.stockDatasetState.findUnique({
          where: {
            securityId_dataset_variant: {
              securityId: security.id,
              dataset: StockDataset.DAILY_DERIVED_STATE,
              variant: DAILY_DERIVED_STATE_VARIANT,
            },
          },
        }),
      ).resolves.not.toBeNull();
      await expect(
        prismaA.stockDatasetState.findUnique({
          where: {
            securityId_dataset_variant: {
              securityId: security.id,
              dataset: StockDataset.WEEKLY_PRICE,
              variant: WEEKLY_PRICE_VARIANT,
            },
          },
        }),
      ).resolves.not.toBeNull();
      // One current derived row per trading day; the schema cannot hold a second methodology.
      const derivedDates = (
        await prismaA.dailyDerivedState.findMany({
          where: { securityId: security.id },
          select: { date: true },
        })
      ).map((row) => row.date.toISOString().slice(0, 10));
      expect(new Set(derivedDates).size).toBe(derivedDates.length);
      expect(
        derivedWritesA.mock.calls.length + derivedWritesB.mock.calls.length,
      ).toBe(1);

      await cacheA.evict(security.id);
      provider.ranges.length = 0;
      await serviceA.getDailyPrices(symbol, {
        from: "2021-01-01",
        to: "2025-12-31",
      });

      expect(provider.ranges).toEqual([]);
      expect(
        derivedWritesA.mock.calls.length + derivedWritesB.mock.calls.length,
      ).toBe(1);
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

  it("serves a daily-materialized blend series straight from stored derived state", async () => {
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
          name: "Blend Materialization Integration Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;
      const dates = ["2025-02-03", "2025-02-04", "2025-02-05"];
      await prisma.dailyDerivedState.createMany({
        data: dates.map((date) => ({
          securityId: security.id,
          date: new Date(`${date}T00:00:00.000Z`),
          dcfFcff: 100,
          residualIncome: 80,
          graham: 60,
          blendBalanced: 86,
          // BALANCED components each carry their own provenance; the blend derives the max.
          dcfFcffSourceAsOf: new Date("2025-02-03T12:00:00.000Z"),
          residualIncomeSourceAsOf: new Date("2025-01-28T12:00:00.000Z"),
          grahamSourceAsOf: new Date("2025-01-20T12:00:00.000Z"),
          intrinsicCurrency: "USD",
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

      // Historical derived reads are keyed on securityId + date range and come back ascending.
      const rows = await store.getDailyDerivedState(security.id, {
        from: "2025-02-03",
        to: "2025-02-05",
      });
      expect(rows.map((row) => row.date)).toEqual(dates);

      const blends = await service.getIntrinsicValueBlends(symbol, {
        from: "2025-02-03",
        to: "2025-02-05",
        blendIds: ["BALANCED"],
      });

      // The same eligible blend repeated per trading day is intentional materialization.
      expect(blends.map((point) => point.valuationDate)).toEqual(dates);
      expect(blends.map((point) => point.valuePerShare)).toEqual([86, 86, 86]);
      expect(blends.map((point) => point.sourceDataAsOf)).toEqual(
        dates.map(() => "2025-02-03T12:00:00.000Z"),
      );
      expect(blends[0]).not.toHaveProperty("blendVersion");
      expect(blends[0]).not.toHaveProperty("calculationVersion");
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

  async getFinancialStatements(
    _symbol: string,
    _securityId: string,
    _statementType: "INCOME" | "BALANCE_SHEET" | "CASH_FLOW",
    _cadence: "QUARTERLY" | "ANNUAL",
    _limit: number,
  ) {
    return [];
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

function hydratingManifest(
  securityId: string,
  hydrationId: string,
): StockManifest {
  return {
    ...readyManifest(securityId),
    status: "HYDRATING",
    hydrationId,
    hydratingAt: "2026-08-24T12:00:00.000Z",
  };
}

function hydrationKeys(namespace: string, securityId: string, symbol: string) {
  const prefix = `${namespace}:security:${securityId}`;
  return {
    manifest: `${prefix}:manifest`,
    registry: `${prefix}:keys`,
    security: `${namespace}:symbol:${symbol}:security`,
    price: `${prefix}:prices:1D:2021`,
    dailyState: `${prefix}:daily-state:2021`,
    financial: `${prefix}:financials:income:quarter:v1:2021`,
  };
}

function cacheSecurity(securityId: string, symbol: string) {
  return {
    id: securityId,
    symbol,
    name: `${symbol} Corp`,
    exchangeCode: "NASDAQ",
    currency: "USD",
    type: "STOCK" as const,
    isAdr: false,
    isActivelyTrading: true,
  };
}

async function writeRepresentativeHydration(
  cache: RedisStockDataCache,
  securityId: string,
  hydrating: StockManifest,
) {
  await cache.writeDailyPriceYears(
    securityId,
    [stockPrice(securityId, "2021-01-04", 3)],
    [2021],
    hydrating,
  );
  await cache.writeDailyDerivedStateYears(
    securityId,
    [
      {
        securityId,
        date: "2021-01-04",
        sma20d: 3,
        weeklySourceWeekStart: "2020-12-28",
      },
    ],
    [2021],
    hydrating,
  );
  await cache.writeFinancialStatementYears(
    securityId,
    [financialRow(securityId)],
    "INCOME",
    "QUARTERLY",
    [2021],
    hydrating,
  );
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
    lastFundamentalsRefreshAt: "2026-08-24T12:00:00.000Z",
    priceDatasetVersion: 1,
    financialStatementVersion: 1,
    derivedStateRevision: DERIVED_STATE_REVISION,
  };
}

function financialRow(
  securityId: string,
  overrides: Partial<FinancialStatement> = {},
): FinancialStatement {
  return {
    securityId,
    statementType: "INCOME",
    fiscalDate: "2021-03-31",
    fiscalYear: 2021,
    period: "Q1",
    reportedCurrency: "USD",
    filingDate: "2021-04-20",
    availableFromDate: "2021-04-21",
    observedAt: "2021-04-20T12:00:00.000Z",
    contentHash: "baseline",
    values: { revenue: 100 },
    ...overrides,
  };
}
