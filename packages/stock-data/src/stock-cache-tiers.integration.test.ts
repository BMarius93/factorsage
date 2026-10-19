import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { loadRootEnv } from "@intrinsic/config";
import type { DailyPrice } from "@intrinsic/domain";
import { afterAll, describe, expect, it } from "vitest";
import {
  RedisStockDataCache,
  type StockDataCacheObserver,
  type StockManifest,
} from "./cache.js";
import type { ProtectedTierEligibility } from "./protected-tier.js";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
} from "./redis-client.js";
import {
  deleteRedisNamespace,
  redisKeysUnder,
} from "./redis-namespace.test-helper.js";

/**
 * The two stock-cache tiers on a real Redis (`docs/decisions/stock-cache-tiers-v1.md`): the
 * count-bounded LRU and the protected tier, operated at once by several clients and by several OS
 * processes. No PostgreSQL: what is checked is residency — which keys exist, with which TTL, counted
 * by which tier — so every security is published directly through the cache, exactly as the
 * canonical loader publishes one.
 */

loadRootEnv();
const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "The stock-cache tier suite requires TEST_REDIS_URL or REDIS_URL; CI must not skip it.",
  );
}
const describeRedis = redisUrl ? describe : describe.skip;

const YEARS = [2019, 2020, 2021, 2022, 2023];

function manifest(
  securityId: string,
  status: "READY" | "HYDRATING",
  generation = "g1",
): StockManifest {
  return {
    securityId,
    status,
    productHistoryYears: 30,
    priceRetentionYears: 34,
    coverageStart: "2019-01-01",
    coverageEnd: "2023-12-31",
    hydrationId: generation,
    priceDatasetVersion: 1,
    financialStatementVersion: 2,
    derivedStateRevision: 1,
    dailyStateEncodingVersion: 2,
  };
}

function prices(securityId: string, year: number, close = 10): DailyPrice[] {
  return [
    {
      securityId,
      date: `${year}-01-04`,
      open: close,
      high: close,
      low: close,
      close,
      volume: 100,
    },
    {
      securityId,
      date: `${year}-06-01`,
      open: close,
      high: close,
      low: close,
      close,
      volume: 100,
    },
  ];
}

const staticEligibility = (
  ids: Iterable<string>,
): ProtectedTierEligibility & { ids: Set<string> } => {
  let snapshot: ReadonlySet<string> = new Set(ids);
  return {
    get ids() {
      return new Set(snapshot);
    },
    set ids(next: Set<string>) {
      snapshot = new Set(next);
    },
    eligible: async () => snapshot,
  };
};

describeRedis("stock cache tiers on real Redis", () => {
  const root = `stock-data:v2:test:tiers:${randomUUID()}`;
  const redis = createStockDataRedisClient(
    redisUrl ?? "redis://localhost:6379",
  );
  const otherClient = createStockDataRedisClient(
    redisUrl ?? "redis://localhost:6379",
  );
  let suites = 0;

  afterAll(async () => {
    await deleteRedisNamespace(redis, root);
    redis.disconnect();
    otherClient.disconnect();
  });

  function namespace(): string {
    suites += 1;
    return `${root}:${suites}`;
  }

  function cacheOn(
    ns: string,
    capacity: number,
    options: {
      eligibility?: ProtectedTierEligibility;
      observer?: StockDataCacheObserver;
      client?: typeof redis;
      hydrationTtlMs?: number;
    } = {},
  ): RedisStockDataCache {
    return new RedisStockDataCache(
      new IoredisCacheClient(options.client ?? redis),
      capacity,
      ns,
      options.hydrationTtlMs ?? 60_000,
      options.observer ?? {},
      undefined,
      options.eligibility,
    );
  }

  /** A whole hydration, as the canonical loader writes one: begin, every year, publish. */
  async function hydrate(
    cache: RedisStockDataCache,
    securityId: string,
    generation = "g1",
    afterBegin?: (hydrating: StockManifest) => Promise<void>,
  ): Promise<void> {
    const hydrating = manifest(securityId, "HYDRATING", generation);
    expect(
      await cache.beginHydration(
        await cache.getManifest(securityId),
        hydrating,
      ),
    ).toBe(true);
    await cache.setSecurity(
      {
        id: securityId,
        symbol: `S${securityId.slice(-6).toUpperCase()}`,
        name: securityId,
        exchangeCode: "NYSE",
        currency: "USD",
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
      },
      hydrating,
    );
    for (const year of YEARS) {
      await cache.writeDailyPriceYears(
        securityId,
        prices(securityId, year),
        [year],
        hydrating,
      );
    }
    await afterBegin?.(hydrating);
    expect(
      await cache.completeHydration(
        hydrating,
        manifest(securityId, "READY", generation),
      ),
    ).toBe(true);
  }

  const securityKeys = (ns: string, securityId: string) =>
    redisKeysUnder(redis, `${ns}:security:${securityId}`);

  /** Every key of the security with its value and TTL: what "untouched" is compared on. */
  async function digest(ns: string, securityId: string) {
    const keys = await securityKeys(ns, securityId);
    return Promise.all(
      keys.map(async (key) => ({
        key,
        value:
          (await redis.type(key)) === "set"
            ? (await redis.smembers(key)).sort().join(",")
            : ((await redis.getBuffer(key))?.toString("base64") ?? null),
        ttl: await redis.pttl(key),
      })),
    );
  }

  const lru = (ns: string) => redis.zrange(`${ns}:resident-stocks`, "0", "-1");

  it("counts each security once by id, evicts exactly the least recently used whole, and reads move recency", async () => {
    const ns = namespace();
    const evictions: { admitted: string; victims: string[] }[] = [];
    const cache = cacheOn(ns, 3, {
      observer: { onLruEviction: (event) => evictions.push(event) },
    });
    const reader = cacheOn(ns, 3, { client: otherClient });
    const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map(
      (id) => `sec-${id}`,
    ) as [string, string, string, string, string];

    for (const id of [a, b, c]) {
      await hydrate(cache, id);
    }
    // Several keys each (manifest, registry, five price years), one LRU member each.
    expect((await securityKeys(ns, a)).length).toBeGreaterThan(5);
    expect(await lru(ns)).toEqual([a, b, c]);
    // Republishing a resident security never counts it twice.
    await hydrate(cache, b, "g2");
    expect(await lru(ns)).toEqual([a, c, b]);

    // A read from another client is an access: `a` becomes the most recently used.
    expect(
      await reader.readDailyPrices(a, { from: "2019-01-01", to: "2023-12-31" }),
    ).toHaveLength(10);
    expect(await lru(ns)).toEqual([c, b, a]);

    await hydrate(cache, d);
    expect(evictions).toEqual([{ admitted: d, victims: [c] }]);
    expect(await lru(ns)).toEqual([b, a, d]);
    // The victim is gone whole — every chunk, its identity row and its registry — and nothing else.
    expect(await securityKeys(ns, c)).toEqual([]);
    expect(
      await redis.exists(`${ns}:symbol:S${c.slice(-6).toUpperCase()}:security`),
    ).toBe(0);
    for (const id of [a, b, d]) {
      expect(
        await cache.readDailyPrices(id, {
          from: "2019-01-01",
          to: "2023-12-31",
        }),
      ).toHaveLength(10);
    }
    expect(await lru(ns)).toEqual([a, b, d]);

    await hydrate(cache, e);
    expect(evictions.at(-1)).toEqual({ admitted: e, victims: [a] });
    expect(await lru(ns)).toEqual([b, d, e]);
    expect(await redis.zcard(`${ns}:resident-stocks`)).toBe(3);
    const audit = await cache.auditTiers();
    expect(audit.violations).toEqual([]);
    expect(audit.lru).toMatchObject({ capacity: 3, members: 3, ready: 3 });
  });

  it("never adds an LRU member on a touch, and re-admits a READY security no tier counts under the capacity", async () => {
    const ns = namespace();
    const cache = cacheOn(ns, 2);
    const ids = ["x", "y", "z"].map((id) => `sec-${id}`) as [
      string,
      string,
      string,
    ];
    await hydrate(cache, ids[0]);
    await hydrate(cache, ids[1]);
    // The LRU is lost while the chunks survive (an operator's DEL, a partial restore).
    await redis.del(`${ns}:resident-stocks`);
    await hydrate(cache, ids[2]);
    expect(await lru(ns)).toEqual([ids[2]]);
    expect((await cache.auditTiers()).orphans).toEqual([ids[0], ids[1]]);

    // Each read admits its orphan like a publication: the capacity holds at every step.
    await cache.readDailyPrices(ids[0], {
      from: "2019-01-01",
      to: "2023-12-31",
    });
    expect(await lru(ns)).toEqual([ids[2], ids[0]]);
    await cache.readDailyPrices(ids[1], {
      from: "2019-01-01",
      to: "2023-12-31",
    });
    expect(await lru(ns)).toEqual([ids[0], ids[1]]);
    expect(await securityKeys(ns, ids[2])).toEqual([]);
    expect((await cache.auditTiers()).violations).toEqual([]);

    // A lost access counter alone cannot rank new accesses behind old ones.
    await redis.del(`${ns}:access-sequence`);
    await cache.touch(ids[0]);
    expect(await lru(ns)).toEqual([ids[1], ids[0]]);
  });

  it("routes eligible securities to the protected tier at admission, never gives their keys a TTL, and keeps them out of the LRU's count", async () => {
    const ns = namespace();
    const [p1, p2, l1, l2] = ["p1", "p2", "l1", "l2"].map(
      (id) => `sec-${id}`,
    ) as [string, string, string, string];
    const eligibility = staticEligibility([p1, p2]);
    const cache = cacheOn(ns, 1, { eligibility });
    const ttls: number[] = [];
    // During the hydration too: a protected generation is persistent from its first key.
    await hydrate(cache, p1, "g1", async () => {
      for (const key of await securityKeys(ns, p1)) {
        ttls.push(await redis.pttl(key));
      }
    });
    expect(ttls.length).toBeGreaterThan(5);
    expect(new Set(ttls)).toEqual(new Set([-1]));
    await hydrate(cache, p2);
    expect((await cache.protectedStocks()).sort()).toEqual([p1, p2].sort());
    expect(await lru(ns)).toEqual([]);

    const before = [await digest(ns, p1), await digest(ns, p2)];
    await hydrate(cache, l1);
    await hydrate(cache, l2);
    expect(await lru(ns)).toEqual([l2]);
    expect(await securityKeys(ns, l1)).toEqual([]);
    expect([await digest(ns, p1), await digest(ns, p2)]).toEqual(before);
    expect(await cache.hasResidentStock(p1)).toBe(true);

    // A refresh of a protected security keeps every key persistent, even when it is abandoned.
    const ready = (await cache.getManifest(p1)) as StockManifest;
    const refresh = manifest(p1, "HYDRATING", "refresh");
    expect(await cache.beginRefresh(ready, refresh)).toBe(true);
    for (const key of await securityKeys(ns, p1)) {
      expect(await redis.pttl(key), key).toBe(-1);
    }
    expect(await cache.renewHydration(refresh)).toBe(true);
    // The next lease holder takes the abandoned generation over and publishes it.
    await hydrate(cache, p1, "takeover");
    expect(await cache.getManifest(p1)).toMatchObject({
      status: "READY",
      hydrationId: "takeover",
    });
    expect(await lru(ns)).toEqual([l2]);

    const audit = await cache.auditTiers(await eligibility.eligible());
    expect(audit.violations).toEqual([]);
    expect(audit.protected).toMatchObject({
      designated: 2,
      ready: 2,
      keysWithTtl: {},
    });
    expect(audit.eligibility).toMatchObject({
      eligible: 2,
      notDesignated: [],
      eligibleInLru: [],
    });
  });

  it("restores a lost designation from eligibility, and promotes an LRU member that becomes eligible without rewriting it", async () => {
    const ns = namespace();
    const [p1, l1, l2] = ["p1", "l1", "l2"].map((id) => `sec-${id}`) as [
      string,
      string,
      string,
    ];
    const eligibility = staticEligibility([p1]);
    const cache = cacheOn(ns, 2, { eligibility });
    await hydrate(cache, p1);
    await hydrate(cache, l1);
    await hydrate(cache, l2);
    expect(await lru(ns)).toEqual([l1, l2]);

    // Redis loses the designation (a flush of that one key, a restore from an older snapshot).
    await redis.del(`${ns}:protected-stocks`);
    // Another process, starting after the loss, routes by PostgreSQL's universe at its first read.
    const restarted = cacheOn(ns, 2, { eligibility, client: otherClient });
    expect(
      await restarted.readDailyPrices(p1, {
        from: "2019-01-01",
        to: "2023-12-31",
      }),
    ).toHaveLength(10);
    expect(await restarted.protectedStocks()).toEqual([p1]);
    expect(await lru(ns)).toEqual([l1, l2]);

    // `l1` joins the universe (a new constituent): its next snapshot designates it, and its data
    // leaves the LRU as it is — the same bytes, no rehydration, its slot freed.
    const kept = await digest(ns, l1);
    eligibility.ids = new Set([p1, l1]);
    expect(
      await restarted.readDailyPrices(l2, {
        from: "2019-01-01",
        to: "2023-12-31",
      }),
    ).toHaveLength(10);
    await restarted.touch(l1);
    await hydrate(restarted, "sec-l3");
    expect((await restarted.protectedStocks()).sort()).toEqual([l1, p1].sort());
    expect(await lru(ns)).toEqual([l2, "sec-l3"]);
    expect(await digest(ns, l1)).toEqual(kept);
    expect(
      (await restarted.auditTiers(await eligibility.eligible())).violations,
    ).toEqual([]);

    // Leaving the universe is explicit (`reconcileProtectedStocks`): back into the LRU, under its count.
    await restarted.reconcileProtectedStocks([p1]);
    expect(await lru(ns)).toEqual(["sec-l3", l1]);
    expect(await securityKeys(ns, l2)).toEqual([]);
  });

  it("keeps the LRU within its count and every security whole across concurrent OS processes", async () => {
    const ns = namespace();
    const capacity = 4;
    const lruIds = Array.from({ length: 12 }, (_, index) => `sec-lru-${index}`);
    const protectedIds = ["sec-pro-0", "sec-pro-1", "sec-pro-2"];
    const viteNode = join(
      dirname(
        createRequire(
          createRequire(__filename).resolve("vitest/package.json"),
        ).resolve("vite-node/package.json"),
      ),
      "vite-node.mjs",
    );
    const helper = join(__dirname, "stock-cache-tiers.child.test-helper.ts");

    let sampling = true;
    let maxObserved = 0;
    const sampler = (async () => {
      while (sampling) {
        maxObserved = Math.max(
          maxObserved,
          await otherClient.zcard(`${ns}:resident-stocks`),
        );
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();
    const children = [1, 2, 3, 4].map(
      (seed) =>
        new Promise<{ published: number; reads: number; hits: number }>(
          (resolve, reject) => {
            const child = spawn(process.execPath, [viteNode, helper], {
              env: {
                ...process.env,
                STOCK_CACHE_TIER_CHILD: JSON.stringify({
                  redisUrl,
                  namespace: ns,
                  capacity,
                  seed,
                  operations: 250,
                  lruIds,
                  protectedIds,
                  years: YEARS,
                }),
              },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let out = "";
            let err = "";
            child.stdout.on(
              "data",
              (chunk: Buffer) => (out += chunk.toString()),
            );
            child.stderr.on(
              "data",
              (chunk: Buffer) => (err += chunk.toString()),
            );
            child.on("exit", (code) => {
              if (code === 0) {
                resolve(JSON.parse(out.trim().split("\n").at(-1) ?? "{}"));
              } else {
                reject(new Error(`child ${seed} exited ${code}: ${err}`));
              }
            });
          },
        ),
    );
    const results = await Promise.all(children);
    sampling = false;
    await sampler;

    expect(
      results.reduce((sum, result) => sum + result.published, 0),
    ).toBeGreaterThan(50);
    expect(
      results.reduce((sum, result) => sum + result.hits, 0),
    ).toBeGreaterThan(50);
    // Never over the count, at any instant another client looked.
    expect(maxObserved).toBeLessThanOrEqual(capacity);

    const cache = cacheOn(ns, capacity, {
      eligibility: staticEligibility(protectedIds),
    });
    const audit = await cache.auditTiers(new Set(protectedIds));
    expect(audit.violations).toEqual([]);
    expect(audit.lru.members).toBeLessThanOrEqual(capacity);
    expect(audit.dualResidency).toEqual([]);
    const members = new Set(await lru(ns));
    for (const id of lruIds) {
      const keys = await securityKeys(ns, id);
      if (members.has(id)) {
        // Resident: whole, readable, persistent.
        expect(
          await cache.readDailyPrices(id, {
            from: "2019-01-01",
            to: "2023-12-31",
          }),
          id,
        ).toHaveLength(10);
      } else {
        // Evicted: nothing left behind, unless a generation is still in flight (it expires whole).
        for (const key of keys) {
          expect(await redis.pttl(key), key).toBeGreaterThan(0);
        }
      }
    }
    for (const id of protectedIds) {
      const status = (await cache.getManifest(id))?.status;
      if (status !== undefined) {
        for (const key of await securityKeys(ns, id)) {
          expect(await redis.pttl(key), key).toBe(-1);
        }
      }
    }
  }, 120_000);
});
