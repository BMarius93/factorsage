import type {
  DailyDerivedState,
  DailyPrice,
  Security,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import { DERIVED_STATE_REVISION } from "./derived-state.js";
import { DAILY_STATE_ENCODING_VERSION } from "./daily-state-chunk.js";
import { PRICE_DATASET_VERSION } from "./ports.js";
import { priceRetentionYears } from "./service.js";
import {
  dailyStateChunkKey,
  RedisStockDataCache,
  type RedisCacheClient,
  type StockManifest,
} from "./cache.js";

class FakeRedis implements RedisCacheClient {
  readonly values = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  readonly sortedSets = new Map<string, Map<string, number>>();

  readonly mgets: string[][] = [];

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async mget(...keys: string[]) {
    this.mgets.push(keys);
    return keys.map((key) => this.values.get(key) ?? null);
  }

  async set(key: string, value: string) {
    this.values.set(key, value);
    return "OK";
  }

  async sadd(key: string, ...members: string[]) {
    const set = this.sets.get(key) ?? new Set<string>();
    members.forEach((member) => set.add(member));
    this.sets.set(key, set);
    return members.length;
  }

  async smembers(key: string) {
    return [...(this.sets.get(key) ?? [])];
  }

  sequence = 0;
  async incr() {
    this.sequence += 1;
    return this.sequence;
  }

  async zadd(key: string, score: number, member: string) {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    set.set(member, score);
    this.sortedSets.set(key, set);
    return 1;
  }

  async zcard(key: string) {
    return this.sortedSets.get(key)?.size ?? 0;
  }

  async zrange(key: string, start: number, stop: number) {
    return [...(this.sortedSets.get(key) ?? [])]
      .sort(
        (left, right) => left[1] - right[1] || left[0].localeCompare(right[0]),
      )
      .slice(start, stop + 1)
      .map(([member]) => member);
  }

  async zscore(key: string, member: string) {
    const score = this.sortedSets.get(key)?.get(member);
    return score === undefined ? null : String(score);
  }

  async zrem(key: string, ...members: string[]) {
    members.forEach((member) => this.sortedSets.get(key)?.delete(member));
    return members.length;
  }

  async del(...keys: string[]) {
    keys.forEach((key) => {
      this.values.delete(key);
      this.sets.delete(key);
    });
    return keys.length;
  }

  async eval(script: string, numberOfKeys: number, ...values: string[]) {
    const keys = values.slice(0, numberOfKeys);
    const args = values.slice(numberOfKeys);
    if (script.includes("begin-hydration")) {
      const current = this.values.get(keys[0]!);
      if (args[1] === "0" && current !== undefined) return 0;
      if (args[1] === "1" && current !== args[2]) return 0;
      await this.del(...(this.sets.get(keys[1]!) ?? []));
      await this.del(keys[1]!);
      await this.zrem(keys[2]!, args[0]!);
      this.values.set(keys[0]!, args[3]!);
      await this.sadd(keys[1]!, keys[0]!);
      return 1;
    }
    if (script.includes("begin-refresh")) {
      if (this.values.get(keys[0]!) !== args[1]) return 0;
      if (!this.sortedSets.get(keys[2]!)?.has(args[0]!)) return 0;
      this.values.set(keys[0]!, args[2]!);
      await this.sadd(keys[1]!, keys[0]!);
      await this.zrem(keys[2]!, args[0]!);
      return 1;
    }
    if (script.includes("set-registered")) {
      if (args[1] && this.values.get(keys[2]!) !== args[1]) return 0;
      this.values.set(keys[0]!, args[0]!);
      await this.sadd(keys[1]!, keys[0]!);
      return 1;
    }
    if (script.includes("touch-ready")) {
      const manifest = this.values.get(keys[0]!);
      if (!manifest || JSON.parse(manifest).status !== "READY") return 0;
      const sequence = await this.incr();
      await this.zadd(keys[1]!, sequence, args[0]!);
      return 1;
    }
    if (script.includes("publish-ready")) {
      const current = this.values.get(keys[0]!);
      if (args[4] ? current !== args[4] : current !== undefined) return 0;
      this.values.set(keys[0]!, args[0]!);
      await this.sadd(keys[1]!, keys[0]!);
      const sequence = await this.incr();
      await this.zadd(keys[2]!, sequence, args[1]!);
      while ((await this.zcard(keys[2]!)) > Number(args[2])) {
        const victim = (await this.zrange(keys[2]!, 0, 0))[0];
        if (!victim) break;
        const registry = `${args[3]}:security:${victim}:keys`;
        await this.del(...(this.sets.get(registry) ?? []));
        await this.del(registry);
        await this.zrem(keys[2]!, victim);
      }
      return 1;
    }
    if (script.includes("invalidate-manifest")) {
      if (this.values.get(keys[0]!) !== args[1]) return 0;
      await this.del(keys[0]!);
      await this.zrem(keys[1]!, args[0]!);
      return 1;
    }
    if (script.includes("evict-resident-stock")) {
      if (!this.sortedSets.get(keys[1]!)?.has(args[0]!)) return 0;
      await this.del(...(this.sets.get(keys[0]!) ?? []));
      await this.del(keys[0]!);
      await this.zrem(keys[1]!, args[0]!);
      return 1;
    }
    throw new Error("Unexpected Redis script");
  }
}

const security: Security = {
  id: "security-aapl",
  symbol: "AAPL",
  name: "Apple Inc.",
  exchangeCode: "NASDAQ",
  currency: "USD",
  type: "STOCK",
  isAdr: false,
  isActivelyTrading: true,
};

function price(date: string, close: number): DailyPrice {
  return {
    securityId: security.id,
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
    productHistoryYears: 30,
    priceRetentionYears: priceRetentionYears(30),
    coverageStart: "1996-08-24",
    coverageEnd: "2026-08-24",
    canonicalHistoryStart: "2019-01-02",
    canonicalHistoryEnd: "2021-12-31",
    hydratedAt: "2026-08-24T12:00:00.000Z",
    lastPriceRefreshAt: "2026-08-24T12:00:00.000Z",
    lastFundamentalsRefreshAt: "2026-08-24T12:00:00.000Z",
    priceDatasetVersion: PRICE_DATASET_VERSION,
    financialStatementVersion: 1,
    derivedStateRevision: DERIVED_STATE_REVISION,
    dailyStateEncodingVersion: DAILY_STATE_ENCODING_VERSION,
  };
}

describe("canonical yearly stock cache", () => {
  it("rejects writes and READY publication from a stale hydration generation", async () => {
    const redis = new FakeRedis();
    const cache = new RedisStockDataCache(redis, 2, "stock-data:v2:test");
    const ready = readyManifest(security.id);
    const first = {
      ...ready,
      status: "HYDRATING" as const,
      hydrationId: "first",
      hydratingAt: "2026-08-24T12:01:00.000Z",
    };
    const successor = {
      ...first,
      hydrationId: "successor",
      hydratingAt: "2026-08-24T12:02:00.000Z",
    };
    await cache.setManifest(ready);
    await expect(cache.beginRefresh(ready, first)).resolves.toBe(true);
    await expect(cache.beginHydration(first, successor)).resolves.toBe(true);

    await expect(
      cache.writeDailyPriceYears(
        security.id,
        [price("2026-08-24", 5)],
        [2026],
        first,
      ),
    ).rejects.toThrow("generation changed");
    await expect(cache.setSecurity(security, first)).rejects.toThrow(
      "generation changed",
    );
    await expect(cache.completeHydration(first, ready)).resolves.toBe(false);
    await expect(cache.getManifest(security.id)).resolves.toEqual(successor);
  });

  it("does not invalidate a successor manifest", async () => {
    const redis = new FakeRedis();
    const cache = new RedisStockDataCache(redis, 2, "stock-data:v2:test");
    const observed = readyManifest(security.id);
    const successor = {
      ...observed,
      lastPriceRefreshAt: "2026-08-24T13:00:00.000Z",
    };
    await cache.setManifest(observed);
    const hydrating = {
      ...observed,
      status: "HYDRATING" as const,
      hydrationId: "successor",
      hydratingAt: "2026-08-24T12:30:00.000Z",
    };
    await expect(cache.beginRefresh(observed, hydrating)).resolves.toBe(true);
    await expect(cache.completeHydration(hydrating, successor)).resolves.toBe(
      true,
    );
    await expect(cache.setManifest(observed)).rejects.toThrow(
      "generation changed",
    );

    await expect(cache.invalidateManifest(observed)).resolves.toBe(false);
    await expect(cache.getManifest(security.id)).resolves.toEqual(successor);
  });

  it("writes yearly price chunks and slices across year boundaries", async () => {
    const redis = new FakeRedis();
    const cache = new RedisStockDataCache(redis, 2, "stock-data:v2:test");
    await cache.writeDailyPriceYears(
      security.id,
      [
        price("2019-12-31", 1),
        price("2020-01-02", 2),
        price("2020-12-31", 3),
        price("2021-01-04", 4),
      ],
      [2019, 2020, 2021],
    );
    await cache.setManifest(readyManifest(security.id));

    await expect(
      cache.readDailyPrices(security.id, {
        from: "2019-12-31",
        to: "2021-01-04",
      }),
    ).resolves.toEqual([
      price("2019-12-31", 1),
      price("2020-01-02", 2),
      price("2020-12-31", 3),
      price("2021-01-04", 4),
    ]);
    expect([...redis.values.keys()]).toEqual(
      expect.arrayContaining([
        "stock-data:v2:test:security:security-aapl:prices:1D:2019",
        "stock-data:v2:test:security:security-aapl:prices:1D:2020",
        "stock-data:v2:test:security:security-aapl:prices:1D:2021",
      ]),
    );
  });

  it("rewrites only the requested current-year chunk", async () => {
    const redis = new FakeRedis();
    const cache = new RedisStockDataCache(redis, 2, "stock-data:v2:test");
    await cache.writeDailyPriceYears(
      security.id,
      [price("2025-12-31", 5), price("2026-08-20", 6)],
      [2025, 2026],
    );
    await cache.setManifest(readyManifest(security.id));
    const oldYearBefore = redis.values.get(
      "stock-data:v2:test:security:security-aapl:prices:1D:2025",
    );
    await cache.writeDailyPriceYears(
      security.id,
      [price("2026-08-20", 6), price("2026-08-21", 7)],
      [2026],
    );

    expect(
      redis.values.get(
        "stock-data:v2:test:security:security-aapl:prices:1D:2025",
      ),
    ).toBe(oldYearBefore);
    await expect(
      cache.readDailyPrices(security.id, {
        from: "2026-08-20",
        to: "2026-08-21",
      }),
    ).resolves.toHaveLength(2);
  });

  it("publishes READY only through the stock manifest", async () => {
    const cache = new RedisStockDataCache(
      new FakeRedis(),
      2,
      "stock-data:v2:test",
    );
    await cache.setManifest(readyManifest(security.id));
    await expect(cache.getManifest(security.id)).resolves.toMatchObject({
      status: "READY",
      canonicalHistoryStart: "2019-01-02",
    });
    await expect(cache.hasResidentStock(security.id)).resolves.toBe(true);
  });

  it("uses a Redis-global sequence for LRU and evicts a complete stock", async () => {
    const redis = new FakeRedis();
    const cacheA = new RedisStockDataCache(redis, 1, "stock-data:v2:test");
    const cacheB = new RedisStockDataCache(redis, 1, "stock-data:v2:test");
    await cacheA.setSecurity(security);
    await cacheA.writeDailyPriceYears(
      security.id,
      [price("2020-01-02", 2)],
      [2020],
    );
    await cacheA.setManifest(readyManifest(security.id));

    const microsoft = { ...security, id: "security-msft", symbol: "MSFT" };
    await cacheB.setSecurity(microsoft);
    await cacheB.writeDailyPriceYears(
      microsoft.id,
      [{ ...price("2020-01-02", 3), securityId: microsoft.id }],
      [2020],
    );
    await cacheB.setManifest(readyManifest(microsoft.id));

    expect(
      [...redis.values.keys()].some((key) => key.includes(security.id)),
    ).toBe(false);
    await expect(cacheB.hasResidentStock(microsoft.id)).resolves.toBe(true);
  });
});

describe("columnar daily-state chunks in the yearly cache", () => {
  const namespace = "stock-data:v2:test";

  function derived(
    date: string,
    sma20d: number,
    roicTtm?: number,
  ): DailyDerivedState {
    return {
      securityId: security.id,
      date,
      sma20d,
      ...(roicTtm === undefined ? {} : { roicTtm }),
    };
  }

  // A December-to-January boundary with a leap day and a gap of absence across the new year.
  const rows = [
    derived("2023-12-28", 1, 7),
    derived("2023-12-29", 2),
    derived("2024-01-02", 3),
    derived("2024-01-03", 4, 7.5),
    derived("2024-02-29", 5, 7.5),
    derived("2024-12-31", 6, 0),
    derived("2025-01-02", 7, 0),
  ];

  async function residentCache(
    observer: ConstructorParameters<typeof RedisStockDataCache>[4] = {},
  ) {
    const redis = new FakeRedis();
    const cache = new RedisStockDataCache(
      redis,
      2,
      namespace,
      undefined,
      observer,
    );
    await cache.writeDailyDerivedStateYears(
      security.id,
      rows,
      [2023, 2024, 2025],
    );
    await cache.setManifest(readyManifest(security.id));
    return { redis, cache };
  }

  it("publishes one versioned chunk per year and reads a range across year boundaries in one MGET", async () => {
    const { redis, cache } = await residentCache();
    for (const year of [2023, 2024, 2025]) {
      expect(
        redis.values.get(dailyStateChunkKey(namespace, security.id, year)),
      ).toMatch(/^\{"version":2,/);
    }
    expect(dailyStateChunkKey(namespace, security.id, 2024)).toBe(
      "stock-data:v2:test:security:security-aapl:daily-state:v2:2024",
    );
    redis.mgets.length = 0;
    await expect(
      cache.readDailyDerivedState(security.id, {
        from: "2023-12-29",
        to: "2025-01-02",
      }),
    ).resolves.toEqual(rows.slice(1));
    expect(redis.mgets).toEqual([
      [2023, 2024, 2025].map((year) =>
        dailyStateChunkKey(namespace, security.id, year),
      ),
    ]);
    await expect(
      cache.readDailyDerivedState(security.id, {
        from: "2024-01-01",
        to: "2024-02-29",
      }),
    ).resolves.toEqual(rows.slice(2, 5));
    await expect(
      cache.readDailyDerivedState(security.id, {
        from: "2024-03-01",
        to: "2024-12-30",
      }),
    ).resolves.toEqual([]);
  });

  it("reads nothing under a manifest that does not declare the current encoding", async () => {
    const { redis, cache } = await residentCache();
    const range = { from: "2023-12-28", to: "2025-01-02" };
    await expect(
      cache.readDailyDerivedState(security.id, range),
    ).resolves.toHaveLength(7);
    // The manifest an older deployment left behind: READY, and silent about the encoding.
    const manifestKey = `${namespace}:security:${security.id}:manifest`;
    for (const stale of [1, undefined]) {
      const manifest: Partial<StockManifest> = {
        ...readyManifest(security.id),
        dailyStateEncodingVersion: stale,
      };
      if (stale === undefined) {
        delete manifest.dailyStateEncodingVersion;
      }
      redis.values.set(manifestKey, JSON.stringify(manifest));
      await expect(
        cache.readDailyDerivedState(security.id, range),
      ).resolves.toBeNull();
    }
  });

  it("treats a missing year as a miss, never as a shorter history", async () => {
    const { redis, cache } = await residentCache();
    await redis.del(dailyStateChunkKey(namespace, security.id, 2024));
    await expect(
      cache.readDailyDerivedState(security.id, {
        from: "2023-12-28",
        to: "2025-01-02",
      }),
    ).resolves.toBeNull();
    // A range that does not touch the lost year is still served.
    await expect(
      cache.readDailyDerivedState(security.id, {
        from: "2025-01-01",
        to: "2025-01-02",
      }),
    ).resolves.toEqual([rows[6]]);
  });

  it.each([
    ["corrupt bytes", () => '{"version":2,"securityId"'],
    ["a version-1 row array", () => JSON.stringify(rows.slice(2, 6))],
    [
      "an unknown future version",
      (payload: string) => payload.replace('{"version":2,', '{"version":3,'),
    ],
  ])(
    "reports %s in one year as unreadable and reads a miss",
    async (_name, damage) => {
      const unreadable: { year: number; key: string; reason: string }[] = [];
      const { redis, cache } = await residentCache({
        onUnreadableChunk: (chunk) => unreadable.push(chunk),
      });
      const key = dailyStateChunkKey(namespace, security.id, 2024);
      redis.values.set(key, damage(redis.values.get(key) as string));
      await expect(
        cache.readDailyDerivedState(security.id, {
          from: "2023-12-28",
          to: "2025-01-02",
        }),
      ).resolves.toBeNull();
      expect(unreadable).toEqual([
        expect.objectContaining({ securityId: security.id, year: 2024, key }),
      ]);
    },
  );

  it("evicts the columnar chunks with the rest of the stock", async () => {
    const { redis, cache } = await residentCache();
    await cache.touch(security.id);
    await cache.evict(security.id);
    expect(
      [...redis.values.keys()].filter((key) => key.includes(security.id)),
    ).toEqual([]);
    await expect(
      cache.readDailyDerivedState(security.id, {
        from: "2024-01-01",
        to: "2024-12-31",
      }),
    ).resolves.toBeNull();
  });
});
