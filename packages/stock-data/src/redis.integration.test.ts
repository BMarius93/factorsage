import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType, StockDataset } from "@intrinsic/database";
import {
  DAILY_OSCILLATORS,
  DAILY_RELATIVE_VOLUMES,
  FUNDAMENTAL_METRICS,
  INTRINSIC_VALUE_BLEND_IDS,
  INTRINSIC_VALUE_MODELS,
  MATERIALIZED_MOVING_AVERAGES,
  WEEKLY_MOVING_AVERAGES,
  type DailyDerivedState,
  type DailyPrice,
  type DateRange,
  type FinancialStatement,
  type FinancialStatementCadence,
  type FinancialStatementDraft,
  type FinancialStatementType,
} from "@intrinsic/domain";
import {
  FmpClient,
  FmpRateLimitError,
  FmpTransientError,
  type FmpStockProviderPort,
} from "@intrinsic/fmp";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  dailyStateChunkKey,
  RedisStockDataCache,
  type StockManifest,
} from "./cache.js";
import { RedlockLoadCoordinator } from "./coordination.js";
import { addDays, subtractYears } from "./dates.js";
import {
  buildDailyDerivedState,
  DAILY_DERIVED_STATE_VARIANT,
  DERIVED_STATE_REVISION,
} from "./derived-state.js";
import {
  DAILY_STATE_ENCODING_VERSION,
  decodeDailyStateChunk,
} from "./daily-state-chunk.js";
import { aggregateCompletedWeeks } from "./weekly.js";
import {
  DAILY_PRICE_VARIANT,
  PRICE_DATASET_VERSION,
  WEEKLY_PRICE_VARIANT,
} from "./ports.js";
import { RedisFmpRequestGate } from "./fmp-gate.js";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
} from "./redis-client.js";
import {
  generateHistory,
  referenceFundamentals,
  type HistoryScenario,
} from "./fundamental-metrics-oracle.test-helper.js";
import { weekdays } from "./fundamental-metrics.test-helper.js";
import { PrismaStockDataStore } from "./prisma-store.js";
import {
  CanonicalStockDataService,
  fundamentalsDatasetOperations,
  priceRetentionYears,
  type ProviderRequestEvent,
} from "./service.js";

loadRootEnv();
// PostgreSQL-backed cases below write through Prisma, so they use the dedicated test
// database rather than DATABASE_URL. Redis stays isolated by namespace, not by instance.
useTestDatabase();
/**
 * Redis is required infrastructure for this suite, and CI must never report green without it.
 *
 * Locally the suite stays environment-aware: a developer without `pnpm infra:up` skips it rather
 * than failing a whole run. In CI that would be silent coverage loss of the only Redis/PostgreSQL
 * parity tests, so a missing URL is a hard failure there instead. The same precedence as the API
 * infrastructure suite is used, so one variable configures both.
 */
const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "Redis-backed stock-data tests require TEST_REDIS_URL or REDIS_URL. CI must not skip them " +
      "silently: they are the only coverage proving the Redis cache and PostgreSQL agree on " +
      "every materialized series.",
  );
}
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
      expect(keys).toContain(dailyStateChunkKey(namespace, securityId, 2026));
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
    ).resolves.toMatchObject([
      { contentHash: "rev-1", values: { revenue: 100 } },
    ]);
    await expect(
      cacheB.readFinancialStatements(financialSecurityId, {
        statementTypes: ["INCOME"],
        cadence: "QUARTERLY",
        from: "2021-01-01",
        to: "2021-12-31",
      }),
    ).resolves.toMatchObject([
      { contentHash: "rev-2", values: { revenue: 200 } },
    ]);
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

  it("frees a concurrency slot whose holder crashed once its lease expires", async () => {
    // A process that dies mid-request never reaches the release, so its token stays in the
    // concurrent set. The gate must not treat that orphan as a live request forever: the token
    // carries a lease expiry as its score and the next admission sweeps expired ones first.
    const leakNamespace = `${namespace}:crashed-gate`;
    const options = {
      maxConcurrentRequests: 1,
      rateLimitPerWindow: 100,
      rateWindowMs: 1_000,
      maxQueueDepth: 10,
      maxQueueWaitMs: 2_000,
      requestLeaseMs: 100,
      namespace: leakNamespace,
      random: () => 0,
    };
    try {
      // The orphan: admitted "now" by a process that then vanished without releasing.
      const [seconds, microseconds] = await redisA.time();
      const nowMs =
        Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000);
      await redisA.zadd(
        `${leakNamespace}:concurrent`,
        nowMs + options.requestLeaseMs,
        "crashed-holder",
      );
      expect(await redisA.zcard(`${leakNamespace}:concurrent`)).toBe(1);

      const gate = new RedisFmpRequestGate(redisB, options);
      const startedAt = Date.now();
      // The only slot is held by the orphan, so this waits out its lease rather than failing or
      // running alongside it — and then runs.
      expect(await gate.run(async () => "ran")).toBe("ran");
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
        options.requestLeaseMs - 25,
      );
      expect(Date.now() - startedAt).toBeLessThan(options.maxQueueWaitMs);
      // The orphan was swept, and the completed request released its own token.
      expect(await redisA.zcard(`${leakNamespace}:concurrent`)).toBe(0);
    } finally {
      await redisA.del(
        `${leakNamespace}:concurrent`,
        `${leakNamespace}:rate-window`,
        `${leakNamespace}:cooldown-until`,
      );
    }
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
          DAILY_PRICE_VARIANT,
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
          DAILY_PRICE_VARIANT,
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
          DAILY_PRICE_VARIANT,
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
          variant: DAILY_PRICE_VARIANT,
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
      // Both callers reach past the product horizon, so both load targets snap to the shared
      // raw-price retention boundary — thirty-four years back, four behind what they may show.
      provider.rows.set("1992-08-24:2014-12-31", [
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
        {
          productHistoryYears: 30,
          now: () => new Date("2026-08-24T12:00:00.000Z"),
        },
      );
      const serviceB = new CanonicalStockDataService(
        storeB,
        provider,
        new RedisStockDataCache(new IoredisCacheClient(redisB), 10, namespace),
        new RedlockLoadCoordinator(redisB, {
          lockDurationMs: 2_000,
          lockWaitMs: 6_000,
        }),
        {
          productHistoryYears: 30,
          now: () => new Date("2026-08-24T12:00:00.000Z"),
        },
      );

      provider.delayMs = 3_500;
      const startedAt = Date.now();
      // Both windows reach past the retention horizon, so both resolve to the same load target:
      // whichever process wins the Redlock does the one delta and the other waits on it.
      const [older, newer] = await Promise.all([
        serviceA.getDailyPrices(symbol, {
          from: "1997-01-01",
          to: "2020-12-31",
        }),
        serviceB.getDailyPrices(symbol, {
          from: "1999-01-01",
          to: "2025-12-31",
        }),
      ]);

      expect(provider.ranges).toEqual([
        { from: "1992-08-24", to: "2014-12-31" },
      ]);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3_000);
      expect(older.map((row) => row.date)).toEqual(["2010-01-04"]);
      expect(newer.map((row) => row.date)).toEqual([
        "2010-01-04",
        "2022-01-03",
      ]);
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
        {
          productHistoryYears: 30,
          now: () => new Date("2026-08-24T12:00:00.000Z"),
        },
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
          variant: DAILY_PRICE_VARIANT,
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
        {
          productHistoryYears: 30,
          now: () => new Date("2026-08-24T12:00:00.000Z"),
        },
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

  it("round-trips every weekly field through Redis and rebuilds it identically after eviction", async () => {
    const suffix = randomUUID();
    const namespace = `stock-data:v2:test:weekly:${suffix}`;
    const symbol = `K${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
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
          name: "Weekly Cache Round Trip Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;

      // 205 Monday-Friday weeks warm up every catalog weekly period, including 200W.
      const prices: ReturnType<typeof integrationPrice>[] = [];
      for (let week = 0; week < 205; week += 1) {
        for (let day = 0; day < 5; day += 1) {
          const index = prices.length;
          prices.push(
            integrationPrice(
              security.id,
              addDays("2020-01-06", week * 7 + day),
              100 + (index % 31) * 0.5 + index * 0.05,
            ),
          );
        }
      }
      const lastDate = prices.at(-1)!.date;
      const weeklyBars = aggregateCompletedWeeks(prices, addDays(lastDate, 3));
      const rows = buildDailyDerivedState({ prices, weeklyBars });
      await store.saveDailyDerivedState({
        securityId: security.id,
        rows,
        weeklyPrices: weeklyBars,
        successfulCoverage: { from: prices[0]!.date, to: lastDate },
        syncedAt: "2026-08-24T12:00:00.000Z",
      });

      const persisted = await store.getDailyDerivedState(security.id, {
        from: prices[0]!.date,
        to: lastDate,
      });
      const years = [
        ...new Set(persisted.map((row) => Number(row.date.slice(0, 4)))),
      ];
      await cache.writeDailyDerivedStateYears(security.id, persisted, years);
      await cache.setManifest(readyManifest(security.id));

      // 1. A cache hit returns exactly what PostgreSQL holds, weekly fields included.
      const cached = await cache.readDailyDerivedState(security.id, {
        from: prices[0]!.date,
        to: lastDate,
      });
      expect(cached).toEqual(persisted);

      const cachedLast = cached?.at(-1);
      for (const average of MATERIALIZED_MOVING_AVERAGES) {
        expect(cachedLast?.[average.field]).toBeDefined();
        expect(cachedLast?.[average.field]).toBe(
          persisted.at(-1)?.[average.field],
        );
      }
      expect(DAILY_OSCILLATORS.length).toBeGreaterThan(0);
      for (const oscillator of DAILY_OSCILLATORS) {
        expect(cachedLast?.[oscillator.field]).toBeDefined();
        expect(cachedLast?.[oscillator.field]).toBe(
          persisted.at(-1)?.[oscillator.field],
        );
      }
      expect(DAILY_RELATIVE_VOLUMES.length).toBeGreaterThan(0);
      for (const entry of DAILY_RELATIVE_VOLUMES) {
        expect(cachedLast?.[entry.field]).toBeDefined();
        expect(cachedLast?.[entry.field]).toBe(persisted.at(-1)?.[entry.field]);
      }
      expect(cachedLast?.weeklySourceWeekStart).toBe(
        persisted.at(-1)?.weeklySourceWeekStart,
      );

      // 2. A warm-up row keeps its weekly and oscillator fields absent through serialization,
      //    never zero.
      const cachedFirst = cached?.[0];
      for (const average of WEEKLY_MOVING_AVERAGES) {
        expect(cachedFirst && average.field in cachedFirst).toBe(false);
      }
      for (const oscillator of DAILY_OSCILLATORS) {
        expect(cachedFirst && oscillator.field in cachedFirst).toBe(false);
      }
      for (const entry of DAILY_RELATIVE_VOLUMES) {
        expect(cachedFirst && entry.field in cachedFirst).toBe(false);
      }

      // 3. Eviction removes the complete stock, not a partial dataset.
      await cache.evict(security.id);
      await expect(cache.getManifest(security.id)).resolves.toBeNull();
      await expect(
        redis.smembers(`${namespace}:security:${security.id}:keys`),
      ).resolves.toEqual([]);
      await expect(
        cache.readDailyDerivedState(security.id, {
          from: prices[0]!.date,
          to: lastDate,
        }),
      ).resolves.toBeNull();

      // 4. Re-admission from the durable store reconstructs the identical daily state.
      const readmitted = await store.getDailyDerivedState(security.id, {
        from: prices[0]!.date,
        to: lastDate,
      });
      await cache.writeDailyDerivedStateYears(security.id, readmitted, years);
      await cache.setManifest(readyManifest(security.id));
      await expect(
        cache.readDailyDerivedState(security.id, {
          from: prices[0]!.date,
          to: lastDate,
        }),
      ).resolves.toEqual(persisted);
    } finally {
      if (securityId) {
        await cache.evict(securityId);
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

  it("round-trips the complete intrinsic-value payload through PostgreSQL and Redis", async () => {
    const suffix = randomUUID();
    const namespace = `stock-data:v2:test:intrinsic:${suffix}`;
    const symbol = `V${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
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
          name: "Intrinsic Payload Round Trip Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;

      // Fixture constants, not engine output: this asserts the persistence and projection path,
      // not the valuation methodology. Values are written as literals rather than computed from
      // blend weights so DECIMAL(20,8) round-tripping is exact rather than float-dependent.
      const complete: DailyDerivedState = {
        securityId: security.id,
        date: "2026-02-02",
        sma20d: 118.5,
        intrinsicValues: {
          DCF_FCFF: 182.5,
          RESIDUAL_INCOME: 151.25,
          DDM: 96.125,
          GRAHAM: 121.75,
        },
        intrinsicValueBlends: {
          BALANCED: 160.975,
          CONSERVATIVE: 155.275,
          DIVIDEND: 145.775,
        },
        dcfFcffSourceAsOf: "2026-01-30T21:00:00.000Z",
        residualIncomeSourceAsOf: "2026-01-28T21:00:00.000Z",
        ddmSourceAsOf: "2026-01-15T21:00:00.000Z",
        grahamSourceAsOf: "2026-01-05T21:00:00.000Z",
        intrinsicCurrency: "USD",
      };
      // Partial availability: DDM is not applicable, so its value, its own provenance instant and
      // the DIVIDEND blend that requires it are all absent. The other models are unaffected.
      const partial: DailyDerivedState = {
        securityId: security.id,
        date: "2026-02-03",
        sma20d: 119.25,
        intrinsicValues: {
          DCF_FCFF: 182.5,
          RESIDUAL_INCOME: 151.25,
          GRAHAM: 121.75,
        },
        intrinsicValueBlends: { BALANCED: 160.975, CONSERVATIVE: 155.275 },
        dcfFcffSourceAsOf: "2026-01-30T21:00:00.000Z",
        residualIncomeSourceAsOf: "2026-01-28T21:00:00.000Z",
        grahamSourceAsOf: "2026-01-05T21:00:00.000Z",
        intrinsicCurrency: "USD",
      };
      // No valuation is eligible yet at all: the row exists as a trading day and carries nothing.
      const none: DailyDerivedState = {
        securityId: security.id,
        date: "2026-02-04",
        sma20d: 120,
      };
      const written = [complete, partial, none];
      const range = { from: "2026-02-02", to: "2026-02-04" };

      await store.saveDailyDerivedState({
        securityId: security.id,
        rows: written,
        weeklyPrices: [],
        successfulCoverage: range,
        syncedAt: "2026-02-04T21:00:00.000Z",
      });

      // 1. PostgreSQL returns exactly what was written, ascending, with nothing added or lost.
      const persisted = await store.getDailyDerivedState(security.id, range);
      expect(persisted).toEqual(written);

      const [persistedComplete, persistedPartial, persistedNone] = persisted;

      // 2. Every catalog model and blend survives the round trip with its own value.
      for (const model of INTRINSIC_VALUE_MODELS) {
        expect(persistedComplete?.intrinsicValues?.[model]).toBe(
          complete.intrinsicValues?.[model],
        );
      }
      for (const blendId of INTRINSIC_VALUE_BLEND_IDS) {
        expect(persistedComplete?.intrinsicValueBlends?.[blendId]).toBe(
          complete.intrinsicValueBlends?.[blendId],
        );
      }

      // 3. Provenance is per model and each instant survives independently, as does the shared
      //    currency. A single row-level instant would collapse these four into one.
      expect(persistedComplete?.dcfFcffSourceAsOf).toBe(
        "2026-01-30T21:00:00.000Z",
      );
      expect(persistedComplete?.residualIncomeSourceAsOf).toBe(
        "2026-01-28T21:00:00.000Z",
      );
      expect(persistedComplete?.ddmSourceAsOf).toBe("2026-01-15T21:00:00.000Z");
      expect(persistedComplete?.grahamSourceAsOf).toBe(
        "2026-01-05T21:00:00.000Z",
      );
      expect(persistedComplete?.intrinsicCurrency).toBe("USD");

      // 4. Unavailable components stay absent rather than becoming zero or null.
      expect(persistedPartial?.intrinsicValues?.DDM).toBeUndefined();
      expect(persistedPartial?.intrinsicValueBlends?.DIVIDEND).toBeUndefined();
      expect(persistedPartial && "ddmSourceAsOf" in persistedPartial).toBe(
        false,
      );
      expect(persistedNone?.intrinsicValues).toBeUndefined();
      expect(persistedNone?.intrinsicValueBlends).toBeUndefined();
      expect(persistedNone?.intrinsicCurrency).toBeUndefined();

      const storedRows = await prisma.dailyDerivedState.findMany({
        where: { securityId: security.id },
        orderBy: { date: "asc" },
      });
      expect(storedRows[1]?.ddm).toBeNull();
      expect(storedRows[1]?.blendDividend).toBeNull();
      expect(storedRows[1]?.ddmSourceAsOf).toBeNull();
      expect(storedRows[2]?.dcfFcff).toBeNull();
      expect(storedRows[2]?.dcfFcffSourceAsOf).toBeNull();
      expect(storedRows[2]?.intrinsicCurrency).toBeNull();

      // 5. Hydrate the PostgreSQL read through the real Redis daily-state chunk and require exact
      //    parity: the cache is disposable, so it must never be a different projection.
      await cache.writeDailyDerivedStateYears(security.id, persisted, [2026]);
      await cache.setManifest(readyManifest(security.id));
      const cached = await cache.readDailyDerivedState(security.id, range);
      expect(cached).toEqual(persisted);
      expect(cached).toEqual(written);

      // The serialized chunk carries absence as absence, not as an explicit null or a zero.
      const chunk = await redis.get(
        dailyStateChunkKey(namespace, security.id, 2026),
      );
      expect(chunk).not.toBeNull();
      const decoded = decodeDailyStateChunk(chunk ?? "", {
        securityId: security.id,
        year: 2026,
      });
      const serialized = (decoded.ok ? decoded.rows : []) as Record<
        string,
        unknown
      >[];
      expect(serialized).toEqual(persisted);
      expect(serialized).toHaveLength(3);
      expect(Object.keys(serialized[1]?.intrinsicValues ?? {})).toEqual([
        "DCF_FCFF",
        "RESIDUAL_INCOME",
        "GRAHAM",
      ]);
      expect("ddmSourceAsOf" in (serialized[1] ?? {})).toBe(false);
      expect("intrinsicValues" in (serialized[2] ?? {})).toBe(false);
      expect("intrinsicCurrency" in (serialized[2] ?? {})).toBe(false);
      expect(chunk).not.toContain("null");

      // 6. Eviction removes the whole stock; re-admitting from the durable store reconstructs an
      //    identical payload, so a lost cache costs nothing but a rebuild.
      await cache.evict(security.id);
      await expect(
        cache.readDailyDerivedState(security.id, range),
      ).resolves.toBeNull();

      const readmitted = await store.getDailyDerivedState(security.id, range);
      await cache.writeDailyDerivedStateYears(security.id, readmitted, [2026]);
      await cache.setManifest(readyManifest(security.id));
      await expect(
        cache.readDailyDerivedState(security.id, range),
      ).resolves.toEqual(written);
    } finally {
      if (securityId) {
        await cache.evict(securityId);
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

describeInfrastructure(
  "Fundamental Metrics on the canonical derived-state path",
  () => {
    const NOW = new Date("2026-08-24T12:00:00.000Z");
    const TODAY = "2026-08-24";
    const SYNCED_AT = NOW.toISOString();
    const PRODUCT_YEARS = 30;

    /** Records every provider call; answers statement requests only when told to. */
    class CountingProvider implements FmpStockProviderPort {
      readonly calls: string[] = [];
      readonly statements = new Map<string, FinancialStatementDraft[]>();

      async getProfile(symbol: string) {
        this.calls.push(`profile:${symbol}`);
        return null;
      }

      async getDailyPrices(
        _symbol: string,
        _securityId: string,
        range: DateRange,
      ) {
        this.calls.push(`prices:${range.from}:${range.to}`);
        return [];
      }

      async getFinancialStatements(
        _symbol: string,
        _securityId: string,
        statementType: FinancialStatementType,
        cadence: FinancialStatementCadence,
        limit: number,
      ) {
        this.calls.push(`statements:${statementType}:${cadence}:${limit}`);
        return this.statements.get(`${statementType}:${cadence}`) ?? [];
      }
    }

    type Provisioned = {
      prisma: PrismaClient;
      redis: ReturnType<typeof createStockDataRedisClient>;
      store: PrismaStockDataStore;
      cache: RedisStockDataCache;
      namespace: string;
      securityId: string;
      symbol: string;
      provider: CountingProvider;
      requests: ProviderRequestEvent[];
      prices: DailyPrice[];
      service: (
        now?: Date,
        options?: {
          fundamentalsFreshnessMs?: number;
          recentPriceFreshnessMs?: number;
        },
      ) => CanonicalStockDataService;
      namespaceKeys: () => Promise<string[]>;
      dispose: () => Promise<void>;
    };

    /**
     * One security whose canonical source data is already durable — prices with coverage and tail
     * freshness over the whole retention horizon, every retained statement revision, and the
     * fundamentals and profile dataset states — and no derived state at all. Exactly what a
     * derived-only rebuild starts from, with nothing left for a provider to supply.
     */
    async function provision(
      firstTradingDay: string,
      statements: (securityId: string) => FinancialStatementDraft[],
    ): Promise<Provisioned> {
      const suffix = randomUUID();
      const namespace = `stock-data:v2:test:fundamentals:${suffix}`;
      const symbol = `M${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
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
      const provider = new CountingProvider();
      const requests: ProviderRequestEvent[] = [];
      const security = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Fundamental Metrics Integration Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      const prices = weekdays(firstTradingDay, TODAY, [
        "2021-07-05",
        "2022-12-26",
        "2023-07-04",
        "2024-12-25",
        "2025-01-01",
        "2025-07-04",
        "2026-01-01",
      ]).map((date, index) => ({
        securityId: security.id,
        date,
        open: 100,
        high: 110,
        low: 90,
        close: 100 + (index % 17) * 0.5 + index * 0.02,
        volume: 1_000 + (index % 7) * 100,
      }));
      const retentionStart = subtractYears(
        TODAY,
        priceRetentionYears(PRODUCT_YEARS),
      );
      await store.saveDailyPriceSync({
        securityId: security.id,
        prices,
        successfulCoverage: [{ from: retentionStart, to: TODAY }],
        syncedAt: SYNCED_AT,
        tailDate: TODAY,
        freshThrough: TODAY,
      });
      // Oldest filing first, so every restatement is a later filing of a known identity.
      const drafts = [...statements(security.id)].sort((left, right) =>
        left.filingDate.localeCompare(right.filingDate),
      );
      await store.saveFinancialStatements({
        securityId: security.id,
        statements: drafts,
        syncedAt: SYNCED_AT,
      });
      for (const operation of fundamentalsDatasetOperations(PRODUCT_YEARS)) {
        await store.upsertDatasetState({
          securityId: security.id,
          dataset: operation.dataset,
          variant: operation.variant,
          syncedAt: SYNCED_AT,
        });
      }
      await store.upsertDatasetState({
        securityId: security.id,
        dataset: "SECURITY_PROFILE",
        variant: "",
        syncedAt: SYNCED_AT,
      });

      const namespaceKeys = async () => {
        const keys: string[] = [];
        let cursor = "0";
        do {
          const [next, batch] = await redis.scan(
            cursor,
            "MATCH",
            `${namespace}:*`,
            "COUNT",
            500,
          );
          cursor = next;
          keys.push(...batch);
        } while (cursor !== "0");
        return keys.sort();
      };

      return {
        prisma,
        redis,
        store,
        cache,
        namespace,
        securityId: security.id,
        symbol,
        provider,
        requests,
        prices,
        service: (now = NOW, options = {}) =>
          new CanonicalStockDataService(
            store,
            provider,
            cache,
            new RedlockLoadCoordinator(redis, {
              lockDurationMs: 30_000,
              lockWaitMs: 30_000,
            }),
            {
              productHistoryYears: PRODUCT_YEARS,
              now: () => now,
              onProviderRequest: (event) => requests.push(event),
              ...options,
            },
          ),
        namespaceKeys,
        dispose: async () => {
          await cache.evict(security.id);
          const leftovers = await namespaceKeys();
          if (leftovers.length > 0) {
            await redis.del(...leftovers);
          }
          await prisma.security.deleteMany({ where: { id: security.id } });
          redis.disconnect();
          await prisma.$disconnect();
        },
      };
    }

    function draftsFrom(
      history: readonly FinancialStatement[],
    ): FinancialStatementDraft[] {
      return history.map(
        ({
          availableFromDate: _available,
          observedAt: _observed,
          contentHash: _hash,
          ...draft
        }) => draft,
      );
    }

    /** Half a DECIMAL(20,8) quantum, plus the double's own rounding for large magnitudes. */
    function expectStoredValue(
      actual: number | undefined,
      reference: number,
      context: string,
    ) {
      expect(actual, context).toBeTypeOf("number");
      expect(
        Math.abs((actual as number) - reference),
        `${context}: ${actual} vs ${reference}`,
      ).toBeLessThanOrEqual(5e-9 + 1e-12 * Math.abs(reference));
    }

    function expectRowsMatchOracle(
      rows: readonly DailyDerivedState[],
      revisions: readonly FinancialStatement[],
      securityId: string,
    ): { available: Map<string, number>; unavailable: Map<string, number> } {
      const available = new Map<string, number>();
      const unavailable = new Map<string, number>();
      for (const row of rows) {
        const reference = referenceFundamentals(
          revisions,
          securityId,
          row.date,
        );
        for (const metric of FUNDAMENTAL_METRICS) {
          const expected = reference[metric.field];
          const context = `${row.date} ${metric.field}`;
          if (expected === undefined) {
            expect(row, context).not.toHaveProperty(metric.field);
            unavailable.set(
              metric.field,
              (unavailable.get(metric.field) ?? 0) + 1,
            );
          } else {
            expectStoredValue(row[metric.field], expected, context);
            available.set(metric.field, (available.get(metric.field) ?? 0) + 1);
          }
        }
      }
      return { available, unavailable };
    }

    it("materializes, persists and publishes all fifteen metrics with no provider request, and rebuilds them identically after a Redis flush", async () => {
      const scenario: HistoryScenario = {
        seed: 5,
        fiscalYearEndMonth: 12,
        firstFiscalYear: 2015,
        fiscalYears: 12,
      };
      const fixture = await provision("2021-01-04", (securityId) =>
        draftsFrom(generateHistory(scenario, securityId)),
      );
      try {
        const range = { from: "2021-01-04", to: TODAY };
        const served = await fixture
          .service()
          .getDailyDerivedState(fixture.symbol, range);

        // 1. A derived-only rebuild: canonical source data was already durable.
        expect(fixture.provider.calls).toEqual([]);
        expect(fixture.requests).toEqual([]);

        // 2. PostgreSQL holds the independent oracle's value for every metric on every trading
        //    day, at storage precision, and absence exactly where the oracle has none.
        const persisted = await fixture.store.getDailyDerivedState(
          fixture.securityId,
          range,
        );
        expect(persisted.map((row) => row.date)).toEqual(
          fixture.prices.map((price) => price.date),
        );
        expect(served).toEqual(persisted);
        const revisions = await fixture.store.getFinancialStatementRevisions({
          securityId: fixture.securityId,
        });
        const { available, unavailable } = expectRowsMatchOracle(
          persisted,
          revisions,
          fixture.securityId,
        );
        for (const metric of FUNDAMENTAL_METRICS) {
          expect(available.get(metric.field) ?? 0, metric.id).toBeGreaterThan(
            50,
          );
          expect(unavailable.get(metric.field) ?? 0, metric.id).toBeGreaterThan(
            0,
          );
        }

        // 3. Redis serves exactly what PostgreSQL holds, across every yearly boundary.
        await expect(
          fixture.cache.readDailyDerivedState(fixture.securityId, range),
        ).resolves.toEqual(persisted);
        for (const year of [2022, 2023, 2024, 2025, 2026]) {
          const boundary = { from: `${year - 1}-12-20`, to: `${year}-01-12` };
          await expect(
            fixture.cache.readDailyDerivedState(fixture.securityId, boundary),
          ).resolves.toEqual(
            await fixture.store.getDailyDerivedState(
              fixture.securityId,
              boundary,
            ),
          );
        }
        const chunk = await fixture.redis.get(
          dailyStateChunkKey(fixture.namespace, fixture.securityId, 2025),
        );
        expect(chunk).toContain('"roicTtm"');
        expect(chunk).not.toContain("null");
        const chunk2025 = decodeDailyStateChunk(chunk ?? "", {
          securityId: fixture.securityId,
          year: 2025,
        });
        expect(chunk2025.ok && chunk2025.rows).toEqual(
          persisted.filter((row) => row.date.startsWith("2025-")),
        );

        // 4. The metrics live inside the existing yearly daily-state chunks: no key family of
        //    their own, and every key belongs to a family the cache already had.
        const keys = await fixture.namespaceKeys();
        expect(
          keys.some((key) =>
            /fundamental|roic|metric/i.test(
              key.slice(fixture.namespace.length),
            ),
          ),
        ).toBe(false);
        const prefix = `${fixture.namespace}:security:${fixture.securityId}:`;
        for (const key of keys) {
          const known =
            key === `${fixture.namespace}:resident-stocks` ||
            key === `${fixture.namespace}:access-sequence` ||
            key === `${fixture.namespace}:symbol:${fixture.symbol}:security` ||
            (key.startsWith(prefix) &&
              new RegExp(
                `^(manifest|keys|security|prices:1D:\\d{4}|daily-state:v${DAILY_STATE_ENCODING_VERSION}:\\d{4}|financials:[a-z-]+:(quarter|annual):v1:\\d{4})$`,
              ).test(key.slice(prefix.length)));
          expect(known, key).toBe(true);
        }

        // 5. A flush costs latency only: every key of the namespace is gone, and the next read
        //    reconstructs the identical history from PostgreSQL with no provider request and no
        //    recalculation.
        await fixture.redis.del(...keys);
        await expect(
          fixture.cache.readDailyDerivedState(fixture.securityId, range),
        ).resolves.toBeNull();
        const derivedWrites = vi.spyOn(fixture.store, "saveDailyDerivedState");
        const reconstructed = await fixture
          .service()
          .getDailyDerivedState(fixture.symbol, range);
        expect(reconstructed).toEqual(persisted);
        expect(derivedWrites).not.toHaveBeenCalled();
        expect(fixture.provider.calls).toEqual([]);
        expect(fixture.requests).toEqual([]);
        await expect(
          fixture.cache.readDailyDerivedState(fixture.securityId, range),
        ).resolves.toEqual(persisted);

        // 6. Complete-stock eviction removes the metrics with the rest of the stock.
        await fixture.cache.evict(fixture.securityId);
        await expect(
          fixture.redis.smembers(
            `${fixture.namespace}:security:${fixture.securityId}:keys`,
          ),
        ).resolves.toEqual([]);
        await expect(
          fixture.redis.exists(
            dailyStateChunkKey(fixture.namespace, fixture.securityId, 2025),
          ),
        ).resolves.toBe(0);

        // 7. Re-running the whole canonical rebuild from the same durable source data reproduces
        //    every persisted value exactly: the materialization is deterministic end to end.
        await fixture.prisma.stockDatasetCoverage.deleteMany({
          where: {
            securityId: fixture.securityId,
            dataset: StockDataset.DAILY_DERIVED_STATE,
          },
        });
        await fixture.prisma.stockDatasetState.deleteMany({
          where: {
            securityId: fixture.securityId,
            dataset: StockDataset.DAILY_DERIVED_STATE,
          },
        });
        derivedWrites.mockClear();
        const rebuilt = await fixture
          .service()
          .getDailyDerivedState(fixture.symbol, range);
        expect(derivedWrites).toHaveBeenCalledTimes(1);
        expect(rebuilt).toEqual(persisted);
        await expect(
          fixture.store.getDailyDerivedState(fixture.securityId, range),
        ).resolves.toEqual(persisted);
        expect(fixture.provider.calls).toEqual([]);
        expect(fixture.requests).toEqual([]);
      } finally {
        await fixture.dispose();
      }
    }, 120_000);

    it("persists a metric the column cannot hold as absence, and rebuilds the rest of the security", async () => {
      // A JPY-scale reporter whose single-unit denominators produce ratios of 10^12 or more.
      const scenario: HistoryScenario = {
        seed: 303,
        fiscalYearEndMonth: 3,
        firstFiscalYear: 2015,
        fiscalYears: 12,
        currency: { base: "JPY" },
        magnitude: 1e9,
        tinyDenominators: 0.2,
      };
      let drafts: FinancialStatementDraft[] = [];
      const fixture = await provision("2021-01-04", (securityId) => {
        drafts = draftsFrom(generateHistory(scenario, securityId));
        return drafts;
      });
      try {
        const range = { from: "2021-01-04", to: TODAY };

        // 1. The rebuild succeeds, and not one source statement was refused.
        const served = await fixture
          .service()
          .getDailyDerivedState(fixture.symbol, range);
        const revisions = await fixture.store.getFinancialStatementRevisions({
          securityId: fixture.securityId,
        });
        expect(revisions).toHaveLength(drafts.length);
        const persisted = await fixture.store.getDailyDerivedState(
          fixture.securityId,
          range,
        );
        expect(persisted.map((row) => row.date)).toEqual(
          fixture.prices.map((price) => price.date),
        );
        expect(served).toEqual(persisted);

        // 2. Every metric on every day is the oracle's, with its storable-range rule applied, and
        //    the rule removes real observations here: find them.
        expectRowsMatchOracle(persisted, revisions, fixture.securityId);
        const unstorable = new Map<string, string[]>();
        let othersPresent = 0;
        for (const row of persisted) {
          const strict = referenceFundamentals(
            revisions,
            fixture.securityId,
            row.date,
          );
          const unbounded = referenceFundamentals(
            revisions,
            fixture.securityId,
            row.date,
            { ignoreStorableRange: true },
          );
          for (const metric of FUNDAMENTAL_METRICS) {
            if (
              strict[metric.field] === undefined &&
              unbounded[metric.field] !== undefined
            ) {
              unstorable.set(metric.field, [
                ...(unstorable.get(metric.field) ?? []),
                row.date,
              ]);
              othersPresent += FUNDAMENTAL_METRICS.filter(
                (other) =>
                  other.field !== metric.field &&
                  row[other.field] !== undefined,
              ).length;
            }
          }
        }
        const unstorableDays = [...unstorable.values()].flat().length;
        expect(unstorableDays).toBeGreaterThan(500);
        expect(unstorable.size).toBeGreaterThan(5);
        // The other metrics of those days are still there.
        expect(othersPresent).toBeGreaterThan(unstorableDays);

        // 3. PostgreSQL holds NULL for every one of them: no clamp, no sentinel, no zero.
        for (const [field, dates] of unstorable) {
          const [stored] = await fixture.prisma.$queryRawUnsafe<
            { present: bigint }[]
          >(
            `SELECT count("${field}") AS present FROM "DailyDerivedState"
             WHERE "securityId" = $1 AND "date" = ANY($2::date[])`,
            fixture.securityId,
            dates,
          );
          expect(Number(stored?.present), field).toBe(0);
        }

        // 4. Redis holds the same absence: the key is missing from the chunk, never null or zero,
        //    and a flush reconstructs exactly the persisted rows.
        await expect(
          fixture.cache.readDailyDerivedState(fixture.securityId, range),
        ).resolves.toEqual(persisted);
        const years = new Set(
          [...unstorable.values()].flat().map((date) => date.slice(0, 4)),
        );
        for (const year of years) {
          const chunk = await fixture.redis.get(
            dailyStateChunkKey(
              fixture.namespace,
              fixture.securityId,
              Number(year),
            ),
          );
          expect(chunk, year).not.toBeNull();
          expect(chunk, year).not.toContain("null");
          const decoded = decodeDailyStateChunk(chunk!, {
            securityId: fixture.securityId,
            year: Number(year),
          });
          expect(decoded.ok, year).toBe(true);
          const rows = (decoded.ok ? decoded.rows : []) as Record<
            string,
            unknown
          >[];
          const byDate = new Map(rows.map((row) => [row.date, row]));
          for (const [field, dates] of unstorable) {
            for (const date of dates.filter((each) => each.startsWith(year))) {
              expect(byDate.get(date), `${date} ${field}`).not.toHaveProperty(
                field,
              );
            }
          }
        }
        await fixture.redis.del(...(await fixture.namespaceKeys()));
        const derivedWrites = vi.spyOn(fixture.store, "saveDailyDerivedState");
        await expect(
          fixture.service().getDailyDerivedState(fixture.symbol, range),
        ).resolves.toEqual(persisted);
        expect(derivedWrites).not.toHaveBeenCalled();
        await expect(
          fixture.cache.readDailyDerivedState(fixture.securityId, range),
        ).resolves.toEqual(persisted);
        expect(fixture.provider.calls).toEqual([]);
        expect(fixture.requests).toEqual([]);
      } finally {
        await fixture.dispose();
      }
    }, 120_000);

    /** Clean quarters FY2022 Q1..FY2026 Q2, each filed forty days after its period end. */
    function cleanQuarters(securityId: string): FinancialStatementDraft[] {
      const quarterEnds = ["03-31", "06-30", "09-30", "12-31"];
      const drafts: FinancialStatementDraft[] = [];
      for (let fiscalYear = 2022; fiscalYear <= 2026; fiscalYear += 1) {
        quarterEnds.forEach((end, index) => {
          if (fiscalYear === 2026 && index > 1) {
            return;
          }
          const period = `Q${index + 1}` as FinancialStatementDraft["period"];
          const fiscalDate = `${fiscalYear}-${end}`;
          const filingDate = addDays(fiscalDate, 40);
          const step = (fiscalYear - 2022) * 4 + index;
          const base = {
            securityId,
            fiscalDate,
            fiscalYear,
            period,
            reportedCurrency: "USD",
            filingDate,
          };
          drafts.push(
            {
              ...base,
              statementType: "INCOME",
              values: {
                revenue: 1_000 + step * 20,
                grossProfit: 400 + step * 5,
                operatingIncome: 150 + step * 3,
                netIncome: 100 + step * 2,
                epsDiluted: 1 + step / 100,
                weightedAverageShsOutDil: 100,
                ebitda: 220 + step * 3,
                ebit: 160 + step * 3,
                interestExpense: 12,
              },
            },
            {
              ...base,
              statementType: "CASH_FLOW",
              values: {
                operatingCashFlow: 180 + step * 4,
                capitalExpenditure: -60,
                commonDividendsPaid: -20,
              },
            },
            {
              ...base,
              statementType: "BALANCE_SHEET",
              values: {
                totalDebt: 800,
                totalStockholdersEquity: 1_500 + step * 10,
                cashAndShortTermInvestments: 300,
                totalAssets: 4_000 + step * 20,
                totalCurrentAssets: 1_200,
                totalCurrentLiabilities: 900,
                netDebt: 500,
              },
            },
          );
        });
      }
      return drafts;
    }

    it("rebuilds both statement families from a revision's availability and republishes the whole affected year", async () => {
      const fixture = await provision("2024-01-02", cleanQuarters);
      try {
        const range = { from: "2024-01-02", to: TODAY };
        await fixture.service().getDailyDerivedState(fixture.symbol, range);
        const before = await fixture.store.getDailyDerivedState(
          fixture.securityId,
          range,
        );
        const original = (
          await fixture.store.getFinancialStatementRevisions({
            securityId: fixture.securityId,
            statementType: "INCOME",
            cadence: "QUARTERLY",
          })
        ).find((each) => each.fiscalYear === 2026 && each.period === "Q1");
        expect(original?.availableFromDate).toBe("2026-05-11");

        // FY2026 Q1 (period end 2026-03-31, public since 2026-05-11) is restated by a filing on
        // 2026-08-10: gross profit and diluted EPS change, eligible from 2026-08-11.
        fixture.provider.statements.set("INCOME:QUARTERLY", [
          {
            securityId: fixture.securityId,
            statementType: "INCOME",
            fiscalDate: "2026-03-31",
            fiscalYear: 2026,
            period: "Q1",
            reportedCurrency: "USD",
            filingDate: "2026-08-10",
            values: {
              ...(original!.values as Record<string, number>),
              grossProfit: 900,
              epsDiluted: 3.5,
            },
          },
        ]);
        const derivedWrites = vi.spyOn(fixture.store, "saveDailyDerivedState");
        const refreshed = fixture.service(
          new Date("2026-08-24T19:00:00.000Z"),
          {
            fundamentalsFreshnessMs: 6 * 60 * 60 * 1_000,
            recentPriceFreshnessMs: 30 * 24 * 60 * 60 * 1_000,
          },
        );
        await refreshed.getDailyDerivedState(fixture.symbol, range);

        // Only the six bounded fundamentals refresh requests: no price or profile request.
        expect([...fixture.provider.calls].sort()).toEqual(
          [
            "statements:BALANCE_SHEET:ANNUAL:3",
            "statements:BALANCE_SHEET:QUARTERLY:12",
            "statements:CASH_FLOW:ANNUAL:3",
            "statements:CASH_FLOW:QUARTERLY:12",
            "statements:INCOME:ANNUAL:3",
            "statements:INCOME:QUARTERLY:12",
          ].sort(),
        );

        // One unified derived write, starting at the availability boundary of the changed fiscal
        // year's revisions (FY2026 Q1's original filing, public 2026-05-11) — never at its fiscal
        // period end, 2026-03-31.
        expect(derivedWrites).toHaveBeenCalledTimes(1);
        const written = derivedWrites.mock.calls[0]![0].rows;
        expect(written[0]?.date).toBe("2026-05-11");
        expect(written.every((row) => row.date >= "2026-05-11")).toBe(true);

        const after = await fixture.store.getDailyDerivedState(
          fixture.securityId,
          range,
        );
        const revisions = await fixture.store.getFinancialStatementRevisions({
          securityId: fixture.securityId,
        });
        expect(
          revisions.find(
            (each) =>
              each.statementType === "INCOME" &&
              each.fiscalYear === 2026 &&
              each.period === "Q1" &&
              each.filingDate === "2026-08-10",
          )?.availableFromDate,
        ).toBe("2026-08-11");

        // Every session before the revision's own availability is unchanged, value for value.
        expect(after.filter((row) => row.date < "2026-08-11")).toEqual(
          before.filter((row) => row.date < "2026-08-11"),
        );
        // From 2026-08-11 both statement-derived families moved, on the same session.
        const onEve = after.find((row) => row.date === "2026-08-10")!;
        const onDay = after.find((row) => row.date === "2026-08-11")!;
        expect(onDay.grossMarginTtm).not.toBe(onEve.grossMarginTtm);
        expect(onDay.epsGrowthTtmYoy).not.toBe(onEve.epsGrowthTtmYoy);
        expect(onDay.intrinsicValues?.GRAHAM).not.toBe(
          onEve.intrinsicValues?.GRAHAM,
        );
        // And every row still matches the independent oracle over the new revision set.
        expectRowsMatchOracle(after, revisions, fixture.securityId);

        // The mid-year rebuild republished the complete 2026 chunk, January included.
        const year = { from: "2026-01-01", to: TODAY };
        const persistedYear = await fixture.store.getDailyDerivedState(
          fixture.securityId,
          year,
        );
        expect(persistedYear[0]?.date).toBe("2026-01-02");
        await expect(
          fixture.cache.readDailyDerivedState(fixture.securityId, year),
        ).resolves.toEqual(persistedYear);
        await expect(
          fixture.cache.readDailyDerivedState(fixture.securityId, range),
        ).resolves.toEqual(after);
      } finally {
        await fixture.dispose();
      }
    }, 120_000);

    it.each([
      { direction: "earlier", fiscalDate: "2026-03-28" },
      { direction: "later", fiscalDate: "2026-04-03" },
    ])(
      "never backdates a revision that moves a period end $direction, and applies it from its observation",
      async ({ fiscalDate }) => {
        const fixture = await provision("2024-01-02", cleanQuarters);
        try {
          const range = { from: "2024-01-02", to: TODAY };
          await fixture.service().getDailyDerivedState(fixture.symbol, range);
          const before = await fixture.store.getDailyDerivedState(
            fixture.securityId,
            range,
          );
          const original = (
            await fixture.store.getFinancialStatementRevisions({
              securityId: fixture.securityId,
              statementType: "INCOME",
              cadence: "QUARTERLY",
            })
          ).find((each) => each.fiscalYear === 2026 && each.period === "Q1");
          expect(original).toMatchObject({
            fiscalDate: "2026-03-31",
            filingDate: "2026-05-10",
            availableFromDate: "2026-05-11",
          });

          // On 2026-08-24 the provider reports FY2026 Q1 with its period end moved and the same
          // filing date: a correction first observed now, not a filing public since 2026-05-11.
          fixture.provider.statements.set("INCOME:QUARTERLY", [
            {
              securityId: fixture.securityId,
              statementType: "INCOME",
              fiscalDate,
              fiscalYear: 2026,
              period: "Q1",
              reportedCurrency: "USD",
              filingDate: "2026-05-10",
              values: {
                ...(original!.values as Record<string, number>),
                grossProfit: 900,
                epsDiluted: 3.5,
              },
            },
          ]);
          await fixture
            .service(new Date("2026-08-24T19:00:00.000Z"), {
              fundamentalsFreshnessMs: 6 * 60 * 60 * 1_000,
              recentPriceFreshnessMs: 30 * 24 * 60 * 60 * 1_000,
            })
            .getDailyDerivedState(fixture.symbol, range);

          const revisions = await fixture.store.getFinancialStatementRevisions({
            securityId: fixture.securityId,
          });
          expect(
            revisions.find(
              (each) =>
                each.statementType === "INCOME" &&
                each.fiscalDate === fiscalDate,
            )?.availableFromDate,
          ).toBe("2026-08-24");

          // No session before the observation changed, for either statement-derived family.
          const after = await fixture.store.getDailyDerivedState(
            fixture.securityId,
            range,
          );
          expect(after.filter((row) => row.date < "2026-08-24")).toEqual(
            before.filter((row) => row.date < "2026-08-24"),
          );
          // From the observation both use the moved revision, whichever way its period end moved.
          const onEve = after.find((row) => row.date === "2026-08-21")!;
          const onDay = after.find((row) => row.date === "2026-08-24")!;
          expect(onDay.grossMarginTtm).not.toBe(onEve.grossMarginTtm);
          expect(onDay.epsGrowthTtmYoy).not.toBe(onEve.epsGrowthTtmYoy);
          expect(onDay.intrinsicValues?.GRAHAM).not.toBe(
            onEve.intrinsicValues?.GRAHAM,
          );
          expectRowsMatchOracle(after, revisions, fixture.securityId);
          await expect(
            fixture.cache.readDailyDerivedState(fixture.securityId, range),
          ).resolves.toEqual(after);
        } finally {
          await fixture.dispose();
        }
      },
      120_000,
    );
  },
);

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
    dailyState: dailyStateChunkKey(namespace, securityId, 2021),
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
    productHistoryYears: 30,
    priceRetentionYears: priceRetentionYears(30),
    coverageStart: "1996-08-24",
    coverageEnd: "2026-08-24",
    canonicalHistoryStart: "2019-12-31",
    canonicalHistoryEnd: "2021-01-04",
    hydratedAt: "2026-08-24T12:00:00.000Z",
    lastPriceRefreshAt: "2026-08-24T12:00:00.000Z",
    lastFundamentalsRefreshAt: "2026-08-24T12:00:00.000Z",
    priceDatasetVersion: PRICE_DATASET_VERSION,
    financialStatementVersion: 1,
    derivedStateRevision: DERIVED_STATE_REVISION,
    dailyStateEncodingVersion: DAILY_STATE_ENCODING_VERSION,
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
