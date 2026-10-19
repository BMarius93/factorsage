/**
 * One OS process of the multi-process tier suite (`stock-cache-tiers.integration.test.ts`): its own
 * Redis connection and its own `RedisStockDataCache`, running a seeded random mix of admissions
 * (hydrate → write → publish), refreshes and reads against the shared namespace, then printing what
 * it did as one JSON line. Never run on its own.
 */
import type { DailyPrice } from "@intrinsic/domain";
import { RedisStockDataCache, type StockManifest } from "./cache.js";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
} from "./redis-client.js";

type ChildInput = {
  redisUrl: string;
  namespace: string;
  capacity: number;
  seed: number;
  operations: number;
  lruIds: string[];
  protectedIds: string[];
  years: number[];
};

const input = JSON.parse(
  process.env.STOCK_CACHE_TIER_CHILD ?? "{}",
) as ChildInput;

/** Deterministic per process: a failure replays from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function manifest(
  securityId: string,
  status: "READY" | "HYDRATING",
  generation: string,
): StockManifest {
  return {
    securityId,
    status,
    productHistoryYears: 30,
    priceRetentionYears: 34,
    coverageStart: `${input.years[0]}-01-01`,
    coverageEnd: `${input.years.at(-1)}-12-31`,
    hydrationId: generation,
    priceDatasetVersion: 1,
    financialStatementVersion: 2,
    derivedStateRevision: 1,
    dailyStateEncodingVersion: 2,
  };
}

function prices(securityId: string, year: number, close: number): DailyPrice[] {
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

async function main(): Promise<void> {
  const redis = createStockDataRedisClient(input.redisUrl);
  const eligible = new Set(input.protectedIds);
  const cache = new RedisStockDataCache(
    new IoredisCacheClient(redis),
    input.capacity,
    input.namespace,
    60_000,
    {},
    undefined,
    { eligible: async () => eligible },
  );
  const next = random(input.seed);
  const ids = [...input.lruIds, ...input.protectedIds];
  const counts = { published: 0, refused: 0, reads: 0, hits: 0, refreshes: 0 };
  for (let operation = 0; operation < input.operations; operation += 1) {
    const id = ids[Math.floor(next() * ids.length)] as string;
    const roll = next();
    const generation = `${input.seed}-${operation}`;
    if (roll < 0.45) {
      // An admission: a whole hydration, as the canonical loader writes one.
      const observed = await cache.getManifest(id);
      const hydrating = manifest(id, "HYDRATING", generation);
      if (!(await cache.beginHydration(observed, hydrating))) {
        counts.refused += 1;
        continue;
      }
      try {
        for (const year of input.years) {
          await cache.writeDailyPriceYears(
            id,
            prices(id, year, operation),
            [year],
            hydrating,
          );
        }
        if (
          await cache.completeHydration(
            hydrating,
            manifest(id, "READY", generation),
          )
        ) {
          counts.published += 1;
        } else {
          counts.refused += 1;
        }
      } catch {
        // Another process took the generation over: exactly what the fence is for.
        counts.refused += 1;
      }
    } else if (roll < 0.55) {
      const observed = await cache.getManifest(id);
      if (observed?.status !== "READY") {
        continue;
      }
      const hydrating = manifest(id, "HYDRATING", generation);
      if (await cache.beginRefresh(observed, hydrating)) {
        counts.refreshes += 1;
        const ready = manifest(id, "READY", generation);
        if (!(await cache.completeHydration(hydrating, ready))) {
          counts.refused += 1;
        }
      }
    } else {
      counts.reads += 1;
      const read = await cache.readDailyPrices(id, {
        from: `${input.years[0]}-01-01`,
        to: `${input.years.at(-1)}-12-31`,
      });
      if (read !== null) {
        counts.hits += 1;
        if (read.length !== input.years.length * 2) {
          throw new Error(
            `a partial history was served for ${id}: ${read.length} rows`,
          );
        }
      }
    }
  }
  redis.disconnect();
  process.stdout.write(`${JSON.stringify(counts)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
