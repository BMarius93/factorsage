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
  stockCachePayloadCodecs,
  type RedisCacheClient,
  type StockManifest,
} from "./cache.js";

/** The text a stored daily-state chunk holds, through the cache's own payload codec. */
function chunkText(value: string | Buffer | undefined): string {
  const decoded = stockCachePayloadCodecs().dailyState.decode(value ?? "");
  if (!decoded.ok) {
    throw new Error(decoded.reason);
  }
  return decoded.text;
}

class FakeRedis implements RedisCacheClient {
  /** Holds what the cache wrote: plain text, or a payload envelope's bytes. */
  readonly values = new Map<string, string | Buffer>();
  readonly sets = new Map<string, Set<string>>();
  readonly sortedSets = new Map<string, Map<string, number>>();

  readonly mgets: string[][] = [];
  /** Runs inside the next `MGET`, before its answer is read: another client's writes landing then. */
  beforeNextMget?: () => Promise<void>;
  /** Refuses every write script, as a `noeviction` Redis at `maxmemory` does (OOM). */
  refuseWrites = false;

  async get(key: string) {
    // A payload envelope is handed back as the bytes it was stored as, exactly like Redis would.
    return (this.values.get(key) as string | undefined) ?? null;
  }

  async mget(...keys: string[]) {
    this.mgets.push(keys);
    const hook = this.beforeNextMget;
    this.beforeNextMget = undefined;
    await hook?.();
    return keys.map(
      (key) => (this.values.get(key) as string | undefined) ?? null,
    );
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
      if (
        !this.sortedSets.get(keys[2]!)?.has(args[0]!) &&
        !this.sets.get(keys[3]!)?.has(args[0]!)
      )
        return 0;
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
    if (this.refuseWrites) {
      throw new Error(
        "OOM command not allowed when used memory > 'maxmemory'.",
      );
    }
    if (script.includes("touch-ready")) {
      const manifest = this.values.get(keys[0]!);
      if (!manifest || JSON.parse(String(manifest)).status !== "READY")
        return 0;
      if (this.sets.get(keys[3]!)?.has(args[0]!)) return 1;
      const sequence = await this.incr();
      await this.zadd(keys[1]!, sequence, args[0]!);
      return 1;
    }
    if (script.includes("publish-ready")) {
      const current = this.values.get(keys[0]!);
      if (args[4] ? current !== args[4] : current !== undefined) return 0;
      this.values.set(keys[0]!, args[0]!);
      await this.sadd(keys[1]!, keys[0]!);
      if (this.sets.get(keys[4]!)?.has(args[1]!)) {
        await this.zrem(keys[2]!, args[1]!);
        return 1;
      }
      const sequence = await this.incr();
      await this.zadd(keys[2]!, sequence, args[1]!);
      await this.evictBeyond(keys[2]!, keys[4]!, Number(args[2]), args[3]!);
      return 1;
    }
    if (script.includes("protected-ready")) {
      if (!this.sets.get(keys[0]!)?.has(args[0]!)) return 0;
      const manifest = this.values.get(keys[1]!);
      return manifest && JSON.parse(String(manifest)).status === "READY"
        ? 1
        : 0;
    }
    if (script.includes("unprotect-stocks")) {
      let removed = 0;
      for (const id of args.slice(2)) {
        if (!this.sets.get(keys[0]!)?.delete(id)) continue;
        removed += 1;
        const manifest = this.values.get(`${args[1]}:security:${id}:manifest`);
        if (manifest && JSON.parse(String(manifest)).status === "READY") {
          await this.zadd(keys[1]!, await this.incr(), id);
        }
      }
      await this.evictBeyond(keys[1]!, keys[0]!, Number(args[0]), args[1]!);
      return removed;
    }
    if (script.includes("protect-stocks")) {
      let added = 0;
      for (const id of args) {
        const set = this.sets.get(keys[0]!) ?? new Set<string>();
        if (!set.has(id)) added += 1;
        set.add(id);
        this.sets.set(keys[0]!, set);
        await this.zrem(keys[1]!, id);
      }
      return added;
    }
    if (script.includes("invalidate-manifest")) {
      const current = this.values.get(keys[0]!);
      if (current === undefined || current !== args[1]) return 0;
      if (JSON.parse(current).status !== "READY") return 0;
      await this.del(...(this.sets.get(keys[2]!) ?? []));
      await this.del(keys[2]!);
      await this.del(keys[0]!);
      await this.zrem(keys[1]!, args[0]!);
      return 1;
    }
    if (script.includes("renew-hydration")) {
      return this.values.get(keys[0]!) === args[0] ? 1 : 0;
    }
    if (script.includes("evict-resident-stock")) {
      if (
        !this.sortedSets.get(keys[1]!)?.has(args[0]!) &&
        !this.sets.get(keys[2]!)?.has(args[0]!)
      )
        return 0;
      await this.del(...(this.sets.get(keys[0]!) ?? []));
      await this.del(keys[0]!);
      await this.zrem(keys[1]!, args[0]!);
      return 1;
    }
    throw new Error("Unexpected Redis script");
  }

  /** The LRU capacity loop every publish runs; a protected victim is dropped from the LRU only. */
  private async evictBeyond(
    resident: string,
    protectedSet: string,
    capacity: number,
    namespace: string,
  ) {
    while ((await this.zcard(resident)) > capacity) {
      const victim = (await this.zrange(resident, 0, 0))[0];
      if (!victim) break;
      await this.zrem(resident, victim);
      if (this.sets.get(protectedSet)?.has(victim)) continue;
      const registry = `${namespace}:security:${victim}:keys`;
      await this.del(...(this.sets.get(registry) ?? []));
      await this.del(registry);
    }
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

describe("the protected tier", () => {
  const namespace = "stock-data:v2:test";
  async function publish(cache: RedisStockDataCache, id: string) {
    await cache.writeDailyPriceYears(
      id,
      [{ ...price("2020-01-02", 2), securityId: id }],
      [2020],
    );
    await cache.setManifest(readyManifest(id));
  }

  function keysOf(redis: FakeRedis, id: string) {
    return [...redis.values.keys()].filter((key) => key.includes(`:${id}:`));
  }

  it("keeps a protected stock resident outside the LRU: it takes no slot and is never a victim", async () => {
    const redis = new FakeRedis();
    const cache = new RedisStockDataCache(redis, 1, namespace);
    await expect(cache.protectStocks(["a"])).resolves.toBe(1);
    await publish(cache, "a");
    await publish(cache, "b");
    await publish(cache, "c");

    await expect(cache.hasResidentStock("a")).resolves.toBe(true);
    await expect(cache.hasResidentStock("b")).resolves.toBe(false);
    await expect(cache.hasResidentStock("c")).resolves.toBe(true);
    expect(keysOf(redis, "a")).not.toEqual([]);
    expect(keysOf(redis, "b")).toEqual([]);
    // The LRU holds only what it can evict.
    await expect(
      redis.zrange(`${namespace}:resident-stocks`, 0, 9),
    ).resolves.toEqual(["c"]);
    // A read of a protected stock does not give it an LRU position.
    await cache.readDailyPrices("a", { from: "2020-01-01", to: "2020-12-31" });
    await expect(
      redis.zrange(`${namespace}:resident-stocks`, 0, 9),
    ).resolves.toEqual(["c"]);
  });

  it("moves a stock between the tiers on designation, and applies capacity to one that leaves", async () => {
    const redis = new FakeRedis();
    const cache = new RedisStockDataCache(redis, 1, namespace);
    await publish(cache, "a");
    await cache.protectStocks(["a"]);
    // Designation frees the LRU slot the stock held.
    await expect(redis.zcard(`${namespace}:resident-stocks`)).resolves.toBe(0);
    await publish(cache, "b");
    await expect(cache.hasResidentStock("a")).resolves.toBe(true);
    await expect(cache.hasResidentStock("b")).resolves.toBe(true);

    // Leaving the tier, `a` rejoins the LRU as its most recent member; capacity evicts `b`.
    await expect(cache.reconcileProtectedStocks([])).resolves.toEqual({
      added: 0,
      removed: 1,
      designated: 0,
    });
    await expect(cache.protectedStocks()).resolves.toEqual([]);
    await expect(cache.hasResidentStock("a")).resolves.toBe(true);
    await expect(cache.hasResidentStock("b")).resolves.toBe(false);
    expect(keysOf(redis, "b")).toEqual([]);

    await expect(cache.reconcileProtectedStocks(["a", "b"])).resolves.toEqual({
      added: 2,
      removed: 0,
      designated: 2,
    });
    await expect(cache.protectedStocks()).resolves.toEqual(["a", "b"]);
    await expect(redis.zcard(`${namespace}:resident-stocks`)).resolves.toBe(0);
  });

  it("evicts a protected stock only when asked, keeping its designation", async () => {
    const redis = new FakeRedis();
    const cache = new RedisStockDataCache(redis, 1, namespace);
    await cache.protectStocks(["a"]);
    await publish(cache, "a");
    await cache.evict("a");
    expect(keysOf(redis, "a")).toEqual([]);
    await expect(cache.hasResidentStock("a")).resolves.toBe(false);
    await expect(cache.protectedStocks()).resolves.toEqual(["a"]);
    // Designated but not READY is not resident; publishing makes it resident again.
    await publish(cache, "a");
    await expect(cache.hasResidentStock("a")).resolves.toBe(true);
  });

  it("refreshes a protected stock in place, outside the LRU", async () => {
    const redis = new FakeRedis();
    const cache = new RedisStockDataCache(redis, 1, namespace);
    await cache.protectStocks(["a"]);
    await publish(cache, "a");
    const ready = (await cache.getManifest("a")) as StockManifest;
    const hydrating: StockManifest = {
      ...ready,
      status: "HYDRATING",
      hydrationId: "refresh",
    };
    await expect(cache.beginRefresh(ready, hydrating)).resolves.toBe(true);
    await expect(cache.completeHydration(hydrating, ready)).resolves.toBe(true);
    await expect(cache.hasResidentStock("a")).resolves.toBe(true);
    await expect(redis.zcard(`${namespace}:resident-stocks`)).resolves.toBe(0);
  });
});

describe("a Redis that refuses writes", () => {
  it("still serves a read it has already made, and reports the lost LRU access", async () => {
    // A `noeviction` Redis at `maxmemory` refuses the LRU's write after the read succeeded. The data
    // is in hand; failing the read over the recency bookkeeping turned a full cache into an outage
    // for every warm stock (OPS-03).
    const redis = new FakeRedis();
    const failures: string[] = [];
    const cache = new RedisStockDataCache(
      redis,
      2,
      "stock-data:v2:test",
      undefined,
      { onTouchFailed: ({ securityId }) => failures.push(securityId) },
    );
    await cache.setManifest(readyManifest(security.id));
    await cache.writeDailyPriceYears(
      security.id,
      [price("2021-03-01", 10)],
      [2021],
    );
    redis.refuseWrites = true;

    await expect(
      cache.readDailyPrices(security.id, {
        from: "2021-01-01",
        to: "2021-12-31",
      }),
    ).resolves.toEqual([price("2021-03-01", 10)]);
    expect(failures).toEqual([security.id]);
  });
});

describe("price reads across a refresh", () => {
  // Statements are no longer projected into Redis (`FINANCIAL_STATEMENT_VERSION` 2); the same
  // guarantee holds for every yearly family that still is.
  it("never returns years from two generations in one read", async () => {
    const redis = new FakeRedis();
    const cache = new RedisStockDataCache(redis, 2, "stock-data:v2:test");
    const ready = {
      ...readyManifest(security.id),
      coverageStart: "2024-01-02",
      coverageEnd: "2025-12-31",
    };
    await cache.setManifest(ready);
    await cache.writeDailyPriceYears(
      security.id,
      [price("2024-03-01", 1), price("2025-03-03", 1)],
      [2024, 2025],
    );
    const range = { from: "2024-01-02", to: "2025-12-31" };
    expect(await cache.readDailyPrices(security.id, range)).toHaveLength(2);

    // A refresh begins while the read is in flight and has rewritten one year of two when the
    // read's MGET lands: the answer would be one year old and one year new.
    const refreshing = {
      ...ready,
      status: "HYDRATING" as const,
      hydrationId: "refresh",
      hydratingAt: "2026-08-24T12:30:00.000Z",
    };
    redis.beforeNextMget = async () => {
      await cache.beginRefresh(ready, refreshing);
      await cache.writeDailyPriceYears(
        security.id,
        [price("2025-03-03", 2)],
        [2025],
        refreshing,
      );
    };
    await expect(cache.readDailyPrices(security.id, range)).resolves.toBeNull();
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
      const stored = redis.values.get(
        dailyStateChunkKey(namespace, security.id, year),
      ) as Buffer;
      // Stored compressed, inside the payload envelope; the text inside is the version-2 chunk.
      expect(Buffer.isBuffer(stored)).toBe(true);
      expect(stored.subarray(0, 2).toString("latin1")).toBe("FS");
      expect(chunkText(stored)).toMatch(/^\{"version":2,/);
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
      // Damage is written as legacy text, which the envelope reads as it always read JSON: the
      // chunk decoder is what must refuse it.
      redis.values.set(key, damage(chunkText(redis.values.get(key))));
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
