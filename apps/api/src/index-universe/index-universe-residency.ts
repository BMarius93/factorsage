import type { PrismaClient } from "@intrinsic/database";
import type { MarketIndexKey } from "@intrinsic/domain";
import type { StructuredLogger as Logger } from "@intrinsic/observability";
import {
  inspectRedisEvictionPolicy,
  loadProtectedTierSecurityIds,
  type CanonicalStockDataService,
  type DurableProjectionRefusal,
  type PrismaStockDataStore,
  type RedisEvictionAssessment,
  type RedisStockDataCache,
  type StockCacheTierAudit,
  type createStockDataRedisClient,
} from "@intrinsic/stock-data";
import { universeSecurities } from "./index-universe-ingest.js";

type Redis = ReturnType<typeof createStockDataRedisClient>;

/**
 * Makes the point-in-time universe's whole history resident in the stock cache's protected tier
 * (`docs/decisions/protected-stock-tier-v1.md`), from PostgreSQL alone.
 *
 * 1. The designation is reconciled from PostgreSQL — every admitted security of the universe —
 *    before anything is published, so each publication lands outside the LRU.
 * 2. Each security is published by `publishDurableProjection`: its retained price history and
 *    daily derived state exactly as PostgreSQL holds them. Nothing reaches the provider (the
 *    runtime this runs in has no provider) and nothing is recalculated. A security already
 *    resident over its durable coverage is left untouched, so a second run costs reads only.
 * 3. Before publishing, the projected footprint is checked against Redis's `maxmemory` and the
 *    optional budget; a tier that would not fit is refused rather than pushed into an OOM.
 * 4. Afterwards the tier is measured exactly — `MEMORY USAGE` of every registered key — and every
 *    designated security's residency is verified.
 *
 * A Redis whose own eviction policy could evict any key (`allkeys-*`, not accepted by the operator)
 * is refused before anything is written.
 */
export type ProtectedResidencySummary = {
  indexKey: MarketIndexKey;
  designation: { designated: number; added: number; removed: number };
  outcomes: {
    published: number;
    alreadyResident: number;
    refused: Partial<Record<DurableProjectionRefusal, string[]>>;
    failed: { symbol: string; error: string }[];
  };
  verification: {
    resident: number;
    notResident: string[];
  };
  memory: {
    before: RedisMemory;
    after: RedisMemory;
    tier: TierFootprint;
  };
  providerRequests: number;
  durationMs: number;
  stoppedEarly: boolean;
};

export type RedisMemory = {
  usedMemoryBytes: number;
  maxMemoryBytes: number;
  maxMemoryPolicy: string;
  keys: number;
};

export type TierFootprint = {
  securities: number;
  keys: number;
  bytes: number;
  byFamily: Record<string, { keys: number; bytes: number }>;
  perSecurityBytes: { mean: number; p50: number; p95: number; max: number };
};

/** What one resident security costs before any is measured: rounded up from measured residents. */
const DEFAULT_SECURITY_BYTES = 1_500_000;
/** The share of `maxmemory` the projected tier may reach. */
const MAX_MEMORY_HEADROOM = 0.85;

export async function runProtectedResidency(input: {
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly store: PrismaStockDataStore;
  readonly cache: RedisStockDataCache;
  readonly stockData: CanonicalStockDataService;
  readonly namespace: string;
  readonly indexKey: MarketIndexKey;
  readonly concurrency: number;
  /** Refuses a tier projected above this many bytes, whatever `maxmemory` allows. */
  readonly memoryBudgetBytes: number | null;
  readonly dryRun: boolean;
  readonly logger: Logger;
  readonly providerRequests: ReadonlyMap<string, number>;
  readonly shouldStop: () => boolean;
  /** `REDIS_ACCEPTED_EVICTION_POLICY`, when an operator accepted an `allkeys-*` policy. */
  readonly acceptedEvictionPolicy?: string;
}): Promise<ProtectedResidencySummary> {
  const { logger } = input;
  const startedAt = Date.now();
  const members = await universeSecurities(input.prisma, input.indexKey);
  const securities = await input.store.findSecuritiesByIds(
    members.map((member) => member.securityId),
  );
  const ids = securities.map((security) => security.id).sort();
  const before = await redisMemory(input.redis);
  // A tier Redis itself may evict is no protected tier (`stock-cache-tiers-v1.md` §4).
  const eviction = await inspectRedisEvictionPolicy(input.redis, {
    ...(input.acceptedEvictionPolicy
      ? { acceptedPolicy: input.acceptedEvictionPolicy }
      : {}),
  });
  if (eviction.verdict === "UNSAFE") {
    throw new Error(
      `Refusing to publish the protected tier: ${eviction.detail}`,
    );
  }

  // The footprint check runs before any write: a tier that would not fit is never started.
  const resident = await residentIds(input.cache, ids);
  const measuredResidents = await measureTier(
    input.redis,
    input.namespace,
    [...resident].slice(0, 25),
  );
  const perSecurity =
    measuredResidents.securities > 0
      ? Math.max(
          measuredResidents.perSecurityBytes.p95,
          DEFAULT_SECURITY_BYTES / 2,
        )
      : DEFAULT_SECURITY_BYTES;
  const projectedBytes = (ids.length - resident.size) * perSecurity;
  if (
    before.maxMemoryBytes > 0 &&
    before.usedMemoryBytes + projectedBytes >
      before.maxMemoryBytes * MAX_MEMORY_HEADROOM
  ) {
    throw new Error(
      `Refusing to publish: ${ids.length - resident.size} securities at ~${perSecurity} bytes would ` +
        `take Redis to ${before.usedMemoryBytes + projectedBytes} of its ${before.maxMemoryBytes}-byte maxmemory`,
    );
  }
  if (
    input.memoryBudgetBytes !== null &&
    ids.length * perSecurity > input.memoryBudgetBytes
  ) {
    throw new Error(
      `Refusing to publish: ${ids.length} securities at ~${perSecurity} bytes exceed the ` +
        `${input.memoryBudgetBytes}-byte budget`,
    );
  }
  logger.info({
    event: "index.protect.started",
    indexKey: input.indexKey,
    securities: ids.length,
    alreadyResident: resident.size,
    projectedBytes,
    dryRun: input.dryRun,
  });

  const designation = input.dryRun
    ? { designated: ids.length, added: 0, removed: 0 }
    : await input.cache.reconcileProtectedStocks(ids);

  let published = 0;
  let alreadyResident = 0;
  const refused: Partial<Record<DurableProjectionRefusal, string[]>> = {};
  const failed: { symbol: string; error: string }[] = [];
  let stoppedEarly = false;
  const requestsBefore = sumRequests(input.providerRequests);
  if (!input.dryRun) {
    let next = 0;
    let done = 0;
    const worker = async () => {
      for (;;) {
        if (input.shouldStop()) {
          stoppedEarly = true;
          return;
        }
        const security = securities[next];
        next += 1;
        if (!security) {
          return;
        }
        try {
          const result =
            await input.stockData.publishDurableProjection(security);
          if (result.status === "PUBLISHED") {
            published += 1;
          } else if (result.status === "ALREADY_RESIDENT") {
            alreadyResident += 1;
          } else {
            (refused[result.reason] ??= []).push(security.symbol);
            logger.warn({
              event: "index.protect.refused",
              symbol: security.symbol,
              reason: result.reason,
              ...(result.detail ? { detail: result.detail } : {}),
            });
          }
        } catch (error) {
          failed.push({
            symbol: security.symbol,
            error: error instanceof Error ? error.message : String(error),
          });
          logger.error({
            event: "index.protect.failed",
            symbol: security.symbol,
            err: error,
          });
        }
        done += 1;
        if (done % 50 === 0) {
          logger.info({
            event: "index.protect.progress",
            done,
            total: securities.length,
            published,
            alreadyResident,
            elapsedMs: Date.now() - startedAt,
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, input.concurrency) }, () => worker()),
    );
  }

  const nowResident = await residentIds(input.cache, ids);
  const tier = await measureTier(input.redis, input.namespace, [
    ...nowResident,
  ]);
  const bySymbol = new Map(
    securities.map((security) => [security.id, security.symbol]),
  );
  return {
    indexKey: input.indexKey,
    designation,
    outcomes: { published, alreadyResident, refused, failed },
    verification: {
      resident: nowResident.size,
      notResident: ids
        .filter((id) => !nowResident.has(id))
        .map((id) => bySymbol.get(id) ?? id)
        .sort(),
    },
    memory: { before, after: await redisMemory(input.redis), tier },
    providerRequests: sumRequests(input.providerRequests) - requestsBefore,
    durationMs: Date.now() - startedAt,
    stoppedEarly,
  };
}

async function residentIds(
  cache: RedisStockDataCache,
  ids: readonly string[],
): Promise<Set<string>> {
  const resident = new Set<string>();
  for (const id of ids) {
    if (await cache.hasResidentStock(id)) {
      resident.add(id);
    }
  }
  return resident;
}

/** Exact bytes of the given securities' registered keys, by key family. Contents are never read. */
export async function measureTier(
  redis: Redis,
  namespace: string,
  securityIds: readonly string[],
): Promise<TierFootprint> {
  const byFamily: Record<string, { keys: number; bytes: number }> = {};
  const perSecurity: number[] = [];
  let keys = 0;
  for (const securityId of securityIds) {
    const registry = `${namespace}:security:${securityId}:keys`;
    const members = [registry, ...(await redis.smembers(registry))];
    const pipeline = redis.pipeline();
    for (const key of members) {
      pipeline.call("MEMORY", "USAGE", key, "SAMPLES", "0");
    }
    const results = (await pipeline.exec()) ?? [];
    let total = 0;
    for (const [index, key] of members.entries()) {
      const bytes = Number(results[index]?.[1] ?? 0);
      const family = keyFamily(namespace, securityId, key);
      const entry = (byFamily[family] ??= { keys: 0, bytes: 0 });
      entry.keys += 1;
      entry.bytes += bytes;
      total += bytes;
      keys += 1;
    }
    perSecurity.push(total);
  }
  perSecurity.sort((left, right) => left - right);
  const at = (share: number) =>
    perSecurity.length === 0
      ? 0
      : (perSecurity[
          Math.min(
            perSecurity.length - 1,
            Math.floor(share * perSecurity.length),
          )
        ] as number);
  const bytes = perSecurity.reduce((sum, value) => sum + value, 0);
  return {
    securities: perSecurity.length,
    keys,
    bytes,
    byFamily,
    perSecurityBytes: {
      mean:
        perSecurity.length === 0 ? 0 : Math.round(bytes / perSecurity.length),
      p50: at(0.5),
      p95: at(0.95),
      max: perSecurity.at(-1) ?? 0,
    },
  };
}

function keyFamily(namespace: string, securityId: string, key: string): string {
  const prefix = `${namespace}:security:${securityId}:`;
  if (!key.startsWith(prefix)) {
    return key.startsWith(`${namespace}:symbol:`) ? "security" : "other";
  }
  const rest = key.slice(prefix.length);
  if (rest === "keys" || rest === "manifest") {
    return rest;
  }
  // `prices:1D:2024` → `prices:1D`; `daily-state:v2:2024` → `daily-state:v2`
  return rest.replace(/:\d{4}$/, "");
}

export async function redisMemory(redis: Redis): Promise<RedisMemory> {
  const info = await redis.info("memory");
  const field = (name: string): string =>
    new RegExp(`^${name}:(.*)$`, "m").exec(info)?.[1]?.trim() ?? "";
  return {
    usedMemoryBytes: Number(field("used_memory")),
    maxMemoryBytes: Number(field("maxmemory")),
    maxMemoryPolicy: field("maxmemory_policy"),
    keys: await redis.dbsize(),
  };
}

function sumRequests(requests: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const count of requests.values()) {
    total += count;
  }
  return total;
}

export type TierAuditSummary = {
  eviction: RedisEvictionAssessment;
  memory: RedisMemory;
  audit: StockCacheTierAudit;
  footprint: { protected: TierFootprint; lru: TierFootprint };
};

/**
 * Both stock-cache tiers as they stand (`docs/decisions/stock-cache-tiers-v1.md` §5): the cache's
 * own invariant audit against PostgreSQL's universe, the exact bytes each tier holds, and how Redis
 * itself may evict. Read-only, and never reaches the provider.
 */
export async function runTierAudit(input: {
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly cache: RedisStockDataCache;
  readonly namespace: string;
  readonly acceptedEvictionPolicy?: string;
}): Promise<TierAuditSummary> {
  const eligible = new Set(await loadProtectedTierSecurityIds(input.prisma));
  const audit = await input.cache.auditTiers(eligible);
  const designated = await input.cache.protectedStocks();
  const lru = await input.cache.lruStocks();
  return {
    eviction: await inspectRedisEvictionPolicy(input.redis, {
      ...(input.acceptedEvictionPolicy
        ? { acceptedPolicy: input.acceptedEvictionPolicy }
        : {}),
    }),
    memory: await redisMemory(input.redis),
    audit,
    footprint: {
      protected: await measureTier(input.redis, input.namespace, designated),
      lru: await measureTier(input.redis, input.namespace, lru),
    },
  };
}
