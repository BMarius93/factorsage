import { createHash } from "node:crypto";
import { VALUATION_RATIO_IDS } from "@intrinsic/contracts";
import type { PrismaClient } from "@intrinsic/database";
import {
  CanonicalStockDataService,
  IoredisCacheClient,
  PrismaStockDataStore,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  createStockDataRedisClient,
} from "@intrinsic/stock-data";
import { readOracleRows } from "./real-data";

/**
 * Redis is a disposable projection, never a valuation truth (AGENTS.md invariants 8 and 16): the
 * same Stock Details valuation read, for every ratio, must answer byte for byte the same
 *
 * - cold (the namespace empty: hydrated from PostgreSQL),
 * - warm (read again),
 * - after an explicit eviction of the security,
 * - after the whole namespace is flushed,
 * - after an LRU eviction (a cache that holds one security, made to hold another first),
 * - and for several cold readers at once, from separate service instances,
 *
 * with the provider refusing every request — a valuation read must never reach it because a
 * projection is missing — and with no Redis key that holds a valuation (a ratio is projected when
 * it is read, never cached per session).
 */
export type CacheParityReport = {
  securities: number;
  reads: number;
  digests: Record<string, Record<string, string>>;
  mismatches: string[];
  providerCalls: string[];
  keyFamilies: string[];
  valuationKeys: string[];
};

export async function auditCacheParity(input: {
  prisma: PrismaClient;
  redisUrl: string;
  securityIds: readonly string[];
  log: (line: string) => void;
}): Promise<CacheParityReport> {
  const providerCalls: string[] = [];
  const refuse = (call: string): never => {
    providerCalls.push(call);
    throw new Error(
      `the cache parity audit may not reach the provider (${call})`,
    );
  };
  const provider = {
    getProfile: async (symbol: string) => refuse(`profile ${symbol}`),
    getDailyPrices: async (symbol: string) => refuse(`prices ${symbol}`),
    getFinancialStatements: async (symbol: string) =>
      refuse(`statements ${symbol}`),
    getStockSplits: async (symbol: string) => refuse(`splits ${symbol}`),
  } as never;
  const redis = createStockDataRedisClient(input.redisUrl);
  const namespace = `stock-data:v2:valuation-cache-parity:${Date.now()}`;
  const tenYears = 10 * 365 * 24 * 60 * 60 * 1_000;
  const store = new PrismaStockDataStore(input.prisma);
  let clock = new Date();
  const serviceOn = (cache: RedisStockDataCache) =>
    new CanonicalStockDataService(
      store,
      provider,
      cache,
      new RedlockLoadCoordinator(redis, {
        lockDurationMs: 120_000,
        lockWaitMs: 120_000,
      }),
      {
        productHistoryYears: 30,
        now: () => clock,
        recentPriceFreshnessMs: tenYears,
        fundamentalsFreshnessMs: tenYears,
      },
    );
  const cache = new RedisStockDataCache(
    new IoredisCacheClient(redis),
    50,
    namespace,
  );
  const service = serviceOn(cache);
  const smallCache = new RedisStockDataCache(
    new IoredisCacheClient(redis),
    1,
    `${namespace}:lru`,
  );
  const small = serviceOn(smallCache);
  const digests: CacheParityReport["digests"] = {};
  const mismatches: string[] = [];
  const keyFamilies = new Set<string>();
  let reads = 0;

  const flush = async (pattern: string) => {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        1000,
      );
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
  };
  const scanFamilies = async () => {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${namespace}*`,
        "COUNT",
        1000,
      );
      cursor = next;
      for (const key of keys) {
        keyFamilies.add(
          key
            .slice(namespace.length)
            .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<security>")
            .replace(/:\d{4}$/, ":<year>"),
        );
      }
    } while (cursor !== "0");
  };

  try {
    const securities = await Promise.all(
      input.securityIds.map((id) => readOracleRows(input.prisma, id)),
    );
    for (const rows of securities) {
      clock = new Date(`${rows.coverageEnd}T12:00:00.000Z`);
      const range = {
        from: rows.sessions.at(-750)?.date ?? rows.sessions[0]!.date,
        to: rows.coverageEnd,
      };
      const readAll = async (reader: CanonicalStockDataService) => {
        const answers = await Promise.all(
          VALUATION_RATIO_IDS.map((ratio) =>
            reader.getDailyValuationRatio(rows.symbol, ratio, range),
          ),
        );
        reads += answers.length;
        return createHash("sha256")
          .update(JSON.stringify(answers))
          .digest("hex");
      };
      const cold = await readAll(service);
      const warm = await readAll(service);
      await cache.evict(rows.securityId);
      const evicted = await readAll(service);
      await flush(`${namespace}:*`);
      const flushed = await readAll(service);
      await scanFamilies();
      // Concurrent cold readers, each its own service instance, on an emptied namespace.
      await flush(`${namespace}:*`);
      const concurrent = await Promise.all(
        [service, serviceOn(cache), serviceOn(cache)].map((reader) =>
          readAll(reader),
        ),
      );
      const cases: Record<string, string> = {
        cold,
        warm,
        evicted,
        flushed,
        ...Object.fromEntries(
          concurrent.map((digest, index) => [`concurrent-${index}`, digest]),
        ),
      };
      digests[rows.symbol] = cases;
      for (const [name, digest] of Object.entries(cases)) {
        if (digest !== cold) {
          mismatches.push(`${rows.symbol} ${name}`);
        }
      }
      input.log(
        `${rows.symbol}: ${Object.keys(cases).length} answers, ${new Set(Object.values(cases)).size} distinct`,
      );
    }
    // LRU: a cache that holds one security, made to hold the second, then asked for the first.
    const [first, second] = securities;
    if (first && second) {
      const answer = async (rows: typeof first) => {
        clock = new Date(`${rows.coverageEnd}T12:00:00.000Z`);
        const range = {
          from: rows.sessions.at(-750)?.date ?? rows.sessions[0]!.date,
          to: rows.coverageEnd,
        };
        const answers = await Promise.all(
          VALUATION_RATIO_IDS.map((ratio) =>
            small.getDailyValuationRatio(rows.symbol, ratio, range),
          ),
        );
        reads += answers.length;
        return createHash("sha256")
          .update(JSON.stringify(answers))
          .digest("hex");
      };
      await answer(first);
      await answer(second);
      const afterLru = await answer(first);
      (digests[first.symbol] as Record<string, string>)["after-lru-eviction"] =
        afterLru;
      if (afterLru !== digests[first.symbol]?.cold) {
        mismatches.push(`${first.symbol} after-lru-eviction`);
      }
    }
  } finally {
    await flush(`${namespace}*`);
    redis.disconnect();
  }
  const families = [...keyFamilies].sort();
  return {
    securities: input.securityIds.length,
    reads,
    digests,
    mismatches,
    providerCalls,
    keyFamilies: families,
    valuationKeys: families.filter((family) => /valuation|ratio/i.test(family)),
  };
}
