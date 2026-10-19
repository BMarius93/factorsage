import type {
  DailyDerivedState,
  DailyPrice,
  DateRange,
  Security,
} from "@intrinsic/domain";
import {
  DAILY_STATE_CHUNK_DICTIONARY,
  DAILY_STATE_ENCODING_VERSION,
  decodeDailyStateChunk,
  encodeDailyStateChunk,
} from "./daily-state-chunk.js";
import {
  REDIS_DESIGNATION_ONLY,
  type ProtectedTierEligibility,
} from "./protected-tier.js";
import {
  DEFAULT_REDIS_PAYLOAD_CODEC,
  RedisPayloadCodec,
  type RedisPayloadCodecConfig,
} from "./redis-payload-codec.js";

/**
 * The payload codec of each compressible stock-cache family (`docs/decisions/redis-payload-codec-v1.md`).
 * Manifests, the identity row, registries and the LRU stay plain: Lua reads them.
 */
export type StockCachePayloadCodecs = {
  readonly prices: RedisPayloadCodec;
  readonly dailyState: RedisPayloadCodec;
};

export function stockCachePayloadCodecs(
  config: RedisPayloadCodecConfig = DEFAULT_REDIS_PAYLOAD_CODEC,
): StockCachePayloadCodecs {
  const zstd = config.codec === "zstd";
  return {
    prices: new RedisPayloadCodec(config),
    // The field dictionary every daily-state chunk repeats primes the compressor, so a year's chunk
    // does not pay for it again; readers know it whatever the writer's codec.
    dailyState: new RedisPayloadCodec(
      config,
      zstd ? DAILY_STATE_CHUNK_DICTIONARY : null,
      [DAILY_STATE_CHUNK_DICTIONARY],
    ),
  };
}

/**
 * Revision of the financial-statement projection a manifest was published under.
 *
 * 2: statements are no longer projected into Redis. No product read path consumed the statement
 * chunks (screening, charts and backtests read the unified daily state, and statement reads go to
 * PostgreSQL), yet they were three quarters of a resident security's keys. A manifest from
 * revision 1 still has statement chunks registered, so it is not current: its next hydration
 * deletes every registered key, statement chunks included, and republishes from PostgreSQL.
 */
export const FINANCIAL_STATEMENT_VERSION = 2;

/** The key namespace every stock-data cache key lives under (`AGENTS.md` invariant 16). */
export const STOCK_DATA_CACHE_NAMESPACE = "stock-data:v2";

/** How long a HYDRATING generation holds its keys before an abandoned one expires. */
export const DEFAULT_HYDRATION_TTL_MS = 15 * 60 * 1_000;

export type StockManifest = {
  securityId: string;
  status: "HYDRATING" | "READY";
  /**
   * The product horizon this manifest was produced under: the oldest day its surfaces may expose.
   * A manifest written under a different one is stale, because every projection it was published
   * for was cut at a boundary the loader no longer uses.
   */
  productHistoryYears: number;
  /**
   * The raw-price retention horizon this manifest was produced under.
   *
   * Recorded beside the product horizon rather than folded into it, because the two answer
   * different questions and can move independently. It is what stops a READY manifest from an
   * older, narrower retention policy from reporting that the wider policy is already satisfied:
   * `coverageStart` alone cannot say so, since a caller-scoped load legitimately leaves it above
   * the retention boundary. Redis is disposable, so a mismatch costs a rebuild from PostgreSQL,
   * never provider traffic for dates already covered.
   */
  priceRetentionYears: number;
  coverageStart?: string;
  coverageEnd?: string;
  canonicalHistoryStart?: string;
  canonicalHistoryEnd?: string;
  hydratedAt?: string;
  lastPriceRefreshAt?: string;
  lastFundamentalsRefreshAt?: string;
  hydrationId?: string;
  hydratingAt?: string;
  /**
   * `PRICE_DATASET_VERSION` the resident price history and its `coverageStart` were produced
   * under. A manifest from an earlier revision is stale regardless of how much it claims to
   * cover: its `coverageStart` was recorded under semantics the loader no longer trusts.
   */
  priceDatasetVersion: number;
  /** `FINANCIAL_STATEMENT_VERSION` the security was published under. */
  financialStatementVersion: number;
  /**
   * Methodology revision of the unified daily derived state. A change invalidates the cached
   * derived state so it is rebuilt; it never selects between coexisting stored methodologies.
   */
  derivedStateRevision: number;
  /**
   * `DAILY_STATE_ENCODING_VERSION` the security's `daily-state` chunks were written in. Only bytes
   * move with it, never a value: a manifest from another encoding (including one written before
   * the field existed) is simply not current, so the security's projection is rebuilt from
   * PostgreSQL before any of its chunks are read.
   */
  dailyStateEncodingVersion: number;
};

/**
 * What a cache reports without taking a logging dependency; the composition roots point it at their
 * structured logger, as they do with `onProviderRequest`.
 */
export type StockDataCacheObserver = {
  /**
   * A `daily-state` chunk was present but could not be decoded. The read is reported as a miss, so
   * the security is rebuilt from PostgreSQL rather than served from the chunk; this is what makes
   * that repair visible. `reason` names the check that failed.
   */
  onUnreadableChunk?: (chunk: {
    securityId: string;
    year: number;
    key: string;
    reason: string;
  }) => void;
  /**
   * Recording a read in the resident LRU failed after the read itself succeeded — a Redis that
   * refuses writes (`noeviction` at `maxmemory`, a read-only replica). The read is still served;
   * only the eviction order loses this access.
   */
  onTouchFailed?: (failure: { securityId: string; error: unknown }) => void;
  /**
   * The LRU admitted a security and, being over its count, evicted these — least recently used
   * first. Every registered key of each victim is already gone; PostgreSQL is untouched.
   */
  onLruEviction?: (eviction: { admitted: string; victims: string[] }) => void;
  /**
   * Designating a newly eligible snapshot of the protected universe failed (a Redis refusing writes).
   * Admissions still route by the snapshot itself; the designation is retried with the next one.
   */
  onDesignationSyncFailed?: (failure: {
    securities: number;
    error: unknown;
  }) => void;
};

export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  /**
   * `MGET` returning raw bytes, for the binary payload envelope (`redis-payload-codec.ts`). A client
   * without it — a test double — falls back to `mget`, which still reads legacy JSON payloads and
   * any value the double stored as-is.
   */
  mgetBuffer?(...keys: string[]): Promise<Array<Buffer | null>>;
  set(key: string, value: string): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  incr(key: string): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zcard(key: string): Promise<number>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zscore(key: string, member: string): Promise<string | null>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  /** `SCAN cursor MATCH pattern COUNT count`, for the tier audit; absent on test doubles. */
  scan?(
    cursor: string,
    pattern: string,
    count: number,
  ): Promise<[string, string[]]>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | Buffer>
  ): Promise<unknown>;
}

export interface StockDataCache {
  getSecurity(symbol: string): Promise<Security | null>;
  setSecurity(security: Security, hydrating?: StockManifest): Promise<void>;
  getManifest(securityId: string): Promise<StockManifest | null>;
  setManifest(manifest: StockManifest): Promise<void>;
  beginHydration(
    observed: StockManifest | null,
    hydrating: StockManifest,
  ): Promise<boolean>;
  beginRefresh(
    observed: StockManifest,
    hydrating: StockManifest,
  ): Promise<boolean>;
  completeHydration(
    hydrating: StockManifest,
    ready: StockManifest,
  ): Promise<boolean>;
  invalidateManifest(manifest: StockManifest | null): Promise<boolean>;
  /**
   * Whether `hydrating` is still the security's current generation, keeping it alive when it is.
   * Its holder checks between long phases and before durable writes: false means another lease
   * holder has taken the stock over, and nothing this generation produces can be published.
   */
  renewHydration(hydrating: StockManifest): Promise<boolean>;
  readDailyPrices(
    securityId: string,
    range: Required<DateRange>,
  ): Promise<DailyPrice[] | null>;
  writeDailyPriceYears(
    securityId: string,
    prices: readonly DailyPrice[],
    years: readonly number[],
    hydrating?: StockManifest,
  ): Promise<void>;
  /**
   * Reads the unified daily derived state from yearly chunks. There is one chunk family for the
   * whole derived state; never introduce a key per indicator, model, or blend.
   */
  readDailyDerivedState(
    securityId: string,
    range: Required<DateRange>,
  ): Promise<DailyDerivedState[] | null>;
  writeDailyDerivedStateYears(
    securityId: string,
    rows: readonly DailyDerivedState[],
    years: readonly number[],
    hydrating?: StockManifest,
  ): Promise<void>;
  hasResidentStock(securityId: string): Promise<boolean>;
  touch(securityId: string): Promise<void>;
  evict(securityId: string): Promise<void>;
}

/**
 * The stock cache: one key family, two residency tiers (`docs/decisions/stock-cache-tiers-v1.md`).
 *
 * - **Protected** — every security `eligibility` admits (the built-in point-in-time universes,
 *   current and former members), plus any `protectStocks` designated: resident outside the LRU,
 *   never a capacity victim, and none of its keys ever carries a TTL, in flight or READY.
 * - **LRU** — every other security: at most `lruMaxSecurities` distinct securities, counted once
 *   each by stable security id however many keys they own; the least recently used one is evicted
 *   whole when an admission passes the count.
 *
 * Both tiers are the same keys, codecs, manifests and generation fence, written by the one canonical
 * loader; a tier is only which residency rule the Lua scripts apply. Every admission (`beginHydration`,
 * `beginRefresh`, a READY publication, the first read of a resident security no tier counts) routes
 * by `eligibility` atomically inside its script, so no consumer can route differently.
 */
export class RedisStockDataCache implements StockDataCache {
  /** The eligibility snapshot whose designation Redis already holds (by identity). */
  private designated: ReadonlySet<string> | undefined;
  private designating: Promise<void> | undefined;

  constructor(
    private readonly redis: RedisCacheClient,
    private readonly lruMaxSecurities: number,
    private readonly namespace = STOCK_DATA_CACHE_NAMESPACE,
    private readonly hydrationTtlMs = DEFAULT_HYDRATION_TTL_MS,
    private readonly observer: StockDataCacheObserver = {},
    private readonly codecs: StockCachePayloadCodecs = stockCachePayloadCodecs(),
    private readonly eligibility: ProtectedTierEligibility = REDIS_DESIGNATION_ONLY,
  ) {
    if (!Number.isInteger(lruMaxSecurities) || lruMaxSecurities <= 0) {
      throw new Error("lruMaxSecurities must be a positive integer");
    }
    if (!Number.isInteger(hydrationTtlMs) || hydrationTtlMs <= 0) {
      throw new Error("hydrationTtlMs must be a positive integer");
    }
  }

  async getSecurity(symbol: string): Promise<Security | null> {
    return this.readJson<Security>(this.symbolSecurityKey(symbol));
  }

  async setSecurity(
    security: Security,
    hydrating?: StockManifest,
  ): Promise<void> {
    const key = this.symbolSecurityKey(security.symbol);
    await this.setRegistered(
      security.id,
      key,
      JSON.stringify(security),
      hydrating,
    );
  }

  async getManifest(securityId: string): Promise<StockManifest | null> {
    return this.readJson<StockManifest>(this.manifestKey(securityId));
  }

  async setManifest(manifest: StockManifest): Promise<void> {
    if (manifest.status === "READY") {
      if (!(await this.publishReady(null, manifest))) {
        throw new Error("Stock cache hydration generation changed");
      }
      return;
    }
    const observed = await this.getManifest(manifest.securityId);
    if (!(await this.beginHydration(observed, manifest))) {
      throw new Error("Stock cache hydration generation changed");
    }
  }

  async beginHydration(
    observed: StockManifest | null,
    hydrating: StockManifest,
  ): Promise<boolean> {
    const tier = await this.tierOf(hydrating.securityId);
    const result = await this.redis.eval(
      BEGIN_HYDRATION,
      4,
      this.manifestKey(hydrating.securityId),
      this.registryKey(hydrating.securityId),
      this.residentKey(),
      this.protectedKey(),
      hydrating.securityId,
      observed ? "1" : "0",
      observed ? JSON.stringify(observed) : "",
      JSON.stringify(hydrating),
      String(this.hydrationTtlMs),
      tier,
    );
    return result === 1;
  }

  async beginRefresh(
    observed: StockManifest,
    hydrating: StockManifest,
  ): Promise<boolean> {
    const tier = await this.tierOf(observed.securityId);
    const result = await this.redis.eval(
      BEGIN_REFRESH,
      4,
      this.manifestKey(observed.securityId),
      this.registryKey(observed.securityId),
      this.residentKey(),
      this.protectedKey(),
      observed.securityId,
      JSON.stringify(observed),
      JSON.stringify(hydrating),
      String(this.hydrationTtlMs),
      tier,
    );
    return result === 1;
  }

  async completeHydration(
    hydrating: StockManifest,
    ready: StockManifest,
  ): Promise<boolean> {
    return this.publishReady(hydrating, ready);
  }

  async renewHydration(hydrating: StockManifest): Promise<boolean> {
    const result = await this.redis.eval(
      RENEW_HYDRATION,
      2,
      this.manifestKey(hydrating.securityId),
      this.registryKey(hydrating.securityId),
      JSON.stringify(hydrating),
      String(this.hydrationTtlMs),
    );
    return result === 1;
  }

  /**
   * Removes a **READY** generation a reader could not be served from — the manifest, every key it
   * registered and its place in the resident set — provided it is still exactly the one observed.
   *
   * Never a HYDRATING one. That generation belongs to whoever holds the stock's load lock, and only
   * that holder (or the next one, taking an abandoned generation over under the same lock) may
   * replace it: deleting it from outside made the hydrating process fail at its next write with
   * "generation changed" (OPS-06), so a reader that finds a hydration in progress waits for the lock
   * instead. The status check is inside the script, so a generation that turns HYDRATING between
   * the reader's observation and this call is spared as well.
   */
  async invalidateManifest(manifest: StockManifest | null): Promise<boolean> {
    if (!manifest) {
      return false;
    }
    const result = await this.redis.eval(
      INVALIDATE_MANIFEST,
      3,
      this.manifestKey(manifest.securityId),
      this.residentKey(),
      this.registryKey(manifest.securityId),
      manifest.securityId,
      JSON.stringify(manifest),
    );
    return result === 1;
  }

  async readDailyPrices(
    securityId: string,
    range: Required<DateRange>,
  ): Promise<DailyPrice[] | null> {
    const manifest = await this.redis.get(this.manifestKey(securityId));
    if (!isReadyManifestPayload(manifest)) {
      return null;
    }
    const result = await this.readYearly<DailyPrice>(
      securityId,
      range,
      (year) => this.priceYearKey(securityId, year),
      (row) => row.date,
      this.codecs.prices,
    );
    // The manifest check and the yearly `MGET` are separate commands. A republish that began in
    // between — a history replaced after a re-base, above all — could otherwise hand back old years
    // beside new ones, so a manifest that moved during the read makes it a miss.
    if (!(await this.manifestUnchanged(securityId, manifest))) {
      return null;
    }
    if (result) {
      await this.recordAccess(securityId);
    }
    return result;
  }

  async writeDailyPriceYears(
    securityId: string,
    prices: readonly DailyPrice[],
    years: readonly number[],
    hydrating?: StockManifest,
  ): Promise<void> {
    await this.writeYearly(
      securityId,
      prices,
      years,
      (row) => row.date,
      (year) => this.priceYearKey(securityId, year),
      this.codecs.prices,
      hydrating,
    );
  }

  /**
   * One `MGET` of the range's yearly chunks, each decoded by the one canonical decoder
   * (`daily-state-chunk.ts`), only the rows inside the range materialized.
   *
   * Any year missing, or present but unreadable, makes the whole read a miss: a partial history is
   * never returned. The chunks are only read under a READY manifest that declares their encoding,
   * so a manifest published over version-1 chunks reads as a miss too, and the caller rebuilds the
   * projection from PostgreSQL. Each chunk's dates are validated strictly ascending within its own
   * year, and the years are read in order, so the concatenation is already in date order.
   */
  async readDailyDerivedState(
    securityId: string,
    range: Required<DateRange>,
  ): Promise<DailyDerivedState[] | null> {
    const payload = await this.redis.get(this.manifestKey(securityId));
    const manifest =
      payload === null ? null : (JSON.parse(payload) as StockManifest);
    if (
      manifest?.status !== "READY" ||
      manifest.dailyStateEncodingVersion !== DAILY_STATE_ENCODING_VERSION
    ) {
      return null;
    }
    const years = yearsInRange(range);
    const keys = years.map((year) => this.dailyStateYearKey(securityId, year));
    const payloads = await this.mgetPayloads(keys);
    // As for prices: a republish that began during the read makes it a miss rather than a mix.
    if (!(await this.manifestUnchanged(securityId, payload))) {
      return null;
    }
    const rows: DailyDerivedState[] = [];
    for (const [index, year] of years.entries()) {
      const payload = payloads[index];
      if (payload === null || payload === undefined) {
        return null;
      }
      const text = this.codecs.dailyState.decode(payload);
      if (!text.ok) {
        this.observer.onUnreadableChunk?.({
          securityId,
          year,
          key: keys[index] as string,
          reason: `envelope: ${text.reason}`,
        });
        return null;
      }
      const decoded = decodeDailyStateChunk(
        text.text,
        { securityId, year },
        range,
      );
      if (!decoded.ok) {
        this.observer.onUnreadableChunk?.({
          securityId,
          year,
          key: keys[index] as string,
          reason: decoded.reason,
        });
        return null;
      }
      for (const row of decoded.rows) {
        rows.push(row);
      }
    }
    await this.recordAccess(securityId);
    return rows;
  }

  /**
   * Publishes each requested year as one chunk in the current encoding, replacing that year whole.
   * A year with no rows is still published, empty, so reading it is a hit rather than a miss.
   */
  async writeDailyDerivedStateYears(
    securityId: string,
    rows: readonly DailyDerivedState[],
    years: readonly number[],
    hydrating?: StockManifest,
  ): Promise<void> {
    const byYear = new Map<number, DailyDerivedState[]>(
      years.map((year) => [year, []]),
    );
    for (const row of rows) {
      byYear.get(Number(row.date.slice(0, 4)))?.push(row);
    }
    for (const [year, yearRows] of byYear) {
      await this.setRegistered(
        securityId,
        this.dailyStateYearKey(securityId, year),
        this.codecs.dailyState.encode(
          encodeDailyStateChunk(securityId, year, yearRows),
        ),
        hydrating,
      );
    }
  }

  /**
   * Whether the security is resident: in the LRU, or protected under a READY manifest. A protected
   * security is resident outside the LRU (`docs/decisions/protected-stock-tier-v1.md`).
   */
  async hasResidentStock(securityId: string): Promise<boolean> {
    if ((await this.redis.zscore(this.residentKey(), securityId)) !== null) {
      return true;
    }
    return (
      (await this.redis.eval(
        PROTECTED_READY,
        2,
        this.protectedKey(),
        this.manifestKey(securityId),
        securityId,
      )) === 1
    );
  }

  /**
   * Records a read of a READY security: an LRU member becomes the most recently used one; a
   * protected one has no LRU position and nothing changes. Touching never adds an LRU member — that
   * would bypass the capacity — except for a READY security no tier counts at all (a Redis that lost
   * its LRU or its designation while the chunks survived), which is then **admitted** like any
   * publication: routed by eligibility, and under the LRU's capacity. Every LRU touch enforces the
   * count, so a capacity lowered by configuration takes effect at the next LRU read.
   */
  async touch(securityId: string): Promise<void> {
    const result = await this.redis.eval(
      TOUCH_READY,
      4,
      this.manifestKey(securityId),
      this.residentKey(),
      this.accessSequenceKey(),
      this.protectedKey(),
      securityId,
      String(this.lruMaxSecurities),
      this.namespace,
    );
    if (result !== 2) {
      this.reportEviction(securityId, result);
      return;
    }
    const tier = await this.tierOf(securityId);
    const admitted = await this.redis.eval(
      ADMIT_RESIDENT,
      4,
      this.manifestKey(securityId),
      this.residentKey(),
      this.accessSequenceKey(),
      this.protectedKey(),
      securityId,
      String(this.lruMaxSecurities),
      this.namespace,
      tier,
    );
    this.reportEviction(securityId, admitted);
  }

  /**
   * The LRU's record of a read that has already succeeded. Best-effort: the script's first write is
   * refused by a Redis that refuses writes, and failing a read whose data was already in hand would
   * turn a full cache into an outage for every warm stock (OPS-03).
   */
  private async recordAccess(securityId: string): Promise<void> {
    try {
      await this.touch(securityId);
    } catch (error: unknown) {
      this.observer.onTouchFailed?.({ securityId, error });
    }
  }

  /**
   * Deletes every registered key of a resident security. A protected security stays designated: it
   * is evicted, not unprotected, so its next read or the tier's publisher makes it resident again.
   */
  async evict(securityId: string): Promise<void> {
    await this.redis.eval(
      EVICT_RESIDENT_STOCK,
      3,
      this.registryKey(securityId),
      this.residentKey(),
      this.protectedKey(),
      securityId,
    );
  }

  /**
   * Adds securities to the protected tier: kept resident outside the LRU, never a capacity victim,
   * with no TTL once READY. A designated security already in the LRU leaves it, freeing its slot.
   * Idempotent, and never removes a designation.
   */
  async protectStocks(securityIds: readonly string[]): Promise<number> {
    if (securityIds.length === 0) {
      return 0;
    }
    let added = 0;
    for (const batch of batches(securityIds, PROTECTED_BATCH_SIZE)) {
      added += Number(
        await this.redis.eval(
          PROTECT_STOCKS,
          2,
          this.protectedKey(),
          this.residentKey(),
          ...batch,
        ),
      );
    }
    return added;
  }

  /**
   * Makes the protected tier exactly `securityIds`. A security that leaves the tier rejoins the LRU
   * as its most recently used member when it is READY, and the LRU's capacity then applies to it
   * like any other; one that joins leaves the LRU. Designations are derived from PostgreSQL by the
   * caller, so a flushed Redis is restored by reconciling again.
   */
  async reconcileProtectedStocks(
    securityIds: readonly string[],
  ): Promise<{ added: number; removed: number; designated: number }> {
    const desired = new Set(securityIds);
    const current = new Set(await this.redis.smembers(this.protectedKey()));
    const leaving = [...current].filter((id) => !desired.has(id));
    let removed = 0;
    for (const batch of batches(leaving, PROTECTED_BATCH_SIZE)) {
      const result = (await this.redis.eval(
        UNPROTECT_STOCKS,
        3,
        this.protectedKey(),
        this.residentKey(),
        this.accessSequenceKey(),
        String(this.lruMaxSecurities),
        this.namespace,
        String(this.hydrationTtlMs),
        ...batch,
      )) as unknown[];
      removed += Number(result[0]);
      const victims = result.slice(1).map(String);
      if (victims.length > 0) {
        this.observer.onLruEviction?.({ admitted: "(unprotected)", victims });
      }
    }
    const added = await this.protectStocks([...desired]);
    return { added, removed, designated: desired.size };
  }

  /** The securities designated to the protected tier, resident or not. */
  async protectedStocks(): Promise<string[]> {
    return (await this.redis.smembers(this.protectedKey())).sort();
  }

  /**
   * Checks both tiers' invariants over every manifest in the namespace
   * (`docs/decisions/stock-cache-tiers-v1.md` §5). Read-only. `eligible` is the canonical universe,
   * when the caller has it; without it only Redis's own designation is checked.
   */
  async auditTiers(
    eligible?: ReadonlySet<string>,
  ): Promise<StockCacheTierAudit> {
    if (!this.redis.scan) {
      throw new Error("The tier audit needs a Redis client that can SCAN");
    }
    const prefix = `${this.namespace}:security:`;
    const suffix = ":manifest";
    const manifestIds: string[] = [];
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        `${prefix}*${suffix}`,
        1_000,
      );
      cursor = next;
      for (const key of keys) {
        const id = key.slice(prefix.length, key.length - suffix.length);
        if (!id.includes(":")) {
          manifestIds.push(id);
        }
      }
    } while (cursor !== "0");
    const status = new Map<string, string>();
    for (const batch of batches([...new Set(manifestIds)], AUDIT_BATCH_SIZE)) {
      const payloads = await this.redis.mget(
        ...batch.map((id) => this.manifestKey(id)),
      );
      batch.forEach((id, index) => {
        const payload = payloads[index];
        if (payload) {
          status.set(id, (JSON.parse(payload) as StockManifest).status);
        }
      });
    }
    const designated = new Set(await this.redis.smembers(this.protectedKey()));
    const lru = await this.lruStocks();
    const lruSet = new Set(lru);
    const ready = [...status]
      .filter(([, value]) => value === "READY")
      .map(([id]) => id);
    const protectedReady = ready.filter((id) => designated.has(id));
    const keysWithTtl: Record<string, number> = {};
    for (const batch of batches(
      [...designated].filter((id) => status.has(id)),
      AUDIT_BATCH_SIZE,
    )) {
      const counts = (await this.redis.eval(
        AUDIT_PROTECTED_TTL,
        0,
        this.namespace,
        ...batch,
      )) as number[];
      batch.forEach((id, index) => {
        if (Number(counts[index]) > 0) {
          keysWithTtl[id] = Number(counts[index]);
        }
      });
    }
    const sorted = (values: Iterable<string>) => [...values].sort();
    const audit: StockCacheTierAudit = {
      namespace: this.namespace,
      manifests: status.size,
      protected: {
        designated: designated.size,
        ready: protectedReady.length,
        hydrating: [...designated].filter(
          (id) => status.get(id) === "HYDRATING",
        ).length,
        notResident: sorted([...designated].filter((id) => !status.has(id))),
        keysWithTtl,
      },
      lru: {
        capacity: this.lruMaxSecurities,
        members: lru.length,
        ready: lru.filter((id) => status.get(id) === "READY").length,
        withoutReadyManifest: sorted(
          lru.filter((id) => status.get(id) !== "READY"),
        ),
      },
      orphans: sorted(
        ready.filter((id) => !designated.has(id) && !lruSet.has(id)),
      ),
      dualResidency: sorted(lru.filter((id) => designated.has(id))),
      ...(eligible
        ? {
            eligibility: {
              eligible: eligible.size,
              notDesignated: sorted(
                [...eligible].filter((id) => !designated.has(id)),
              ),
              designatedNotEligible: sorted(
                [...designated].filter((id) => !eligible.has(id)),
              ),
              eligibleInLru: sorted(lru.filter((id) => eligible.has(id))),
            },
          }
        : {}),
      violations: [],
    };
    const violations = audit.violations;
    if (audit.lru.members > audit.lru.capacity) {
      violations.push(
        `LRU holds ${audit.lru.members} securities, above its capacity of ${audit.lru.capacity}`,
      );
    }
    if (audit.dualResidency.length > 0) {
      violations.push(
        `${audit.dualResidency.length} securities are in both tiers`,
      );
    }
    if (Object.keys(keysWithTtl).length > 0) {
      violations.push(
        `${Object.keys(keysWithTtl).length} protected securities have keys with a TTL`,
      );
    }
    if (audit.eligibility && audit.eligibility.eligibleInLru.length > 0) {
      violations.push(
        `${audit.eligibility.eligibleInLru.length} protected-eligible securities are in the LRU`,
      );
    }
    if (audit.orphans.length > 0) {
      violations.push(
        `${audit.orphans.length} READY securities are counted by neither tier (admitted at their next read)`,
      );
    }
    return audit;
  }

  /** The LRU's members, least recently used first. */
  async lruStocks(): Promise<string[]> {
    return this.redis.zrange(this.residentKey(), 0, -1);
  }

  /** The configured LRU capacity, in distinct securities. */
  get lruCapacity(): number {
    return this.lruMaxSecurities;
  }

  /** Whether the security's manifest is still exactly the one a read started under. */
  private async manifestUnchanged(
    securityId: string,
    observed: string | null,
  ): Promise<boolean> {
    return (await this.redis.get(this.manifestKey(securityId))) === observed;
  }

  private async readJson<T>(key: string): Promise<T | null> {
    const payload = await this.redis.get(key);
    return payload === null ? null : (JSON.parse(payload) as T);
  }

  /** `MGET` of payload bytes when the client can, so an enveloped payload is never mangled as text. */
  private async mgetPayloads(
    keys: readonly string[],
  ): Promise<Array<Buffer | string | null>> {
    return this.redis.mgetBuffer
      ? this.redis.mgetBuffer(...keys)
      : this.redis.mget(...keys);
  }

  private async readYearly<T>(
    securityId: string,
    range: Required<DateRange>,
    keyForYear: (year: number) => string,
    dateOf: (row: T) => string,
    codec: RedisPayloadCodec,
  ): Promise<T[] | null> {
    const years = yearsInRange(range);
    const keys = years.map(keyForYear);
    const payloads = await this.mgetPayloads(keys);
    if (payloads.some((payload) => payload === null)) {
      return null;
    }
    const rows: T[] = [];
    for (const [index, payload] of payloads.entries()) {
      const decoded = codec.decode(payload as Buffer | string);
      if (!decoded.ok) {
        // A damaged year is a miss like a missing one: the caller rebuilds from PostgreSQL.
        this.observer.onUnreadableChunk?.({
          securityId,
          year: years[index] as number,
          key: keys[index] as string,
          reason: `envelope: ${decoded.reason}`,
        });
        return null;
      }
      rows.push(...(JSON.parse(decoded.text) as T[]));
    }
    return rows
      .filter((row) => dateOf(row) >= range.from && dateOf(row) <= range.to)
      .sort((left, right) => dateOf(left).localeCompare(dateOf(right)));
  }

  private async writeYearly<T>(
    securityId: string,
    rows: readonly T[],
    years: readonly number[],
    dateOf: (row: T) => string,
    keyForYear: (year: number) => string,
    codec: RedisPayloadCodec,
    hydrating?: StockManifest,
  ): Promise<void> {
    const byYear = new Map<number, T[]>();
    for (const year of years) {
      byYear.set(year, []);
    }
    for (const row of rows) {
      const year = Number(dateOf(row).slice(0, 4));
      const bucket = byYear.get(year);
      if (bucket) {
        bucket.push(row);
      }
    }
    for (const [year, values] of byYear) {
      values.sort((left, right) => dateOf(left).localeCompare(dateOf(right)));
      const key = keyForYear(year);
      await this.setRegistered(
        securityId,
        key,
        codec.encode(JSON.stringify(values)),
        hydrating,
      );
    }
  }

  private async setRegistered(
    securityId: string,
    key: string,
    value: string | Buffer,
    hydrating?: StockManifest,
  ): Promise<void> {
    const result = await this.redis.eval(
      SET_REGISTERED,
      3,
      key,
      this.registryKey(securityId),
      this.manifestKey(securityId),
      value,
      hydrating ? JSON.stringify(hydrating) : "",
      String(this.hydrationTtlMs),
    );
    if (result !== 1) {
      throw new Error("Stock cache hydration generation changed");
    }
  }

  private async publishReady(
    hydrating: StockManifest | null,
    ready: StockManifest,
  ): Promise<boolean> {
    const tier = await this.tierOf(ready.securityId);
    const result = await this.redis.eval(
      PUBLISH_READY,
      5,
      this.manifestKey(ready.securityId),
      this.registryKey(ready.securityId),
      this.residentKey(),
      this.accessSequenceKey(),
      this.protectedKey(),
      JSON.stringify(ready),
      ready.securityId,
      String(this.lruMaxSecurities),
      this.namespace,
      hydrating ? JSON.stringify(hydrating) : "",
      tier,
    );
    return this.reportEviction(ready.securityId, result);
  }

  /**
   * An admitting script's reply: `0` refused, or `{1, victim…}` — admitted, with the securities the
   * LRU evicted to stay within its count, least recently used first.
   */
  private reportEviction(admitted: string, result: unknown): boolean {
    if (!Array.isArray(result)) {
      return result === 1;
    }
    if (Number(result[0]) !== 1) {
      return false;
    }
    const victims = result.slice(1).map(String);
    if (victims.length > 0) {
      this.observer.onLruEviction?.({ admitted, victims });
    }
    return true;
  }

  /**
   * The tier a security is admitted to: `P` when the canonical universe admits it, else `L`. The
   * scripts also honour a Redis designation (`protectStocks`), so `L` means "unless designated".
   *
   * A new eligibility snapshot is designated in Redis before it is acted on — the securities that
   * joined it leave the LRU with their data intact (promotion) — so the designation a Redis lost is
   * restored by the first admission of every process after it reloads the universe.
   */
  private async tierOf(securityId: string): Promise<"P" | "L"> {
    const eligible = await this.eligibility.eligible();
    if (eligible !== this.designated && eligible.size > 0) {
      await this.designate(eligible);
    }
    return eligible.has(securityId) ? "P" : "L";
  }

  private async designate(eligible: ReadonlySet<string>): Promise<void> {
    this.designating ??= (async () => {
      const previous = this.designated;
      const joined = [...eligible].filter((id) => !previous?.has(id));
      try {
        await this.protectStocks(joined);
        this.designated = eligible;
      } catch (error: unknown) {
        // Routing does not depend on it: every admission carries its own tier.
        this.observer.onDesignationSyncFailed?.({
          securities: joined.length,
          error,
        });
      }
    })().finally(() => {
      this.designating = undefined;
    });
    await this.designating;
  }

  private symbolSecurityKey(symbol: string): string {
    return `${this.namespace}:symbol:${encodeURIComponent(symbol.trim().toUpperCase())}:security`;
  }

  private manifestKey(securityId: string): string {
    return `${this.namespace}:security:${securityId}:manifest`;
  }

  private priceYearKey(securityId: string, year: number): string {
    return `${this.namespace}:security:${securityId}:prices:1D:${year}`;
  }

  private dailyStateYearKey(securityId: string, year: number): string {
    return dailyStateChunkKey(this.namespace, securityId, year);
  }

  private registryKey(securityId: string): string {
    return `${this.namespace}:security:${securityId}:keys`;
  }

  private residentKey(): string {
    return `${this.namespace}:resident-stocks`;
  }

  /** The protected tier's designation: a set of security ids, never in the LRU at the same time. */
  private protectedKey(): string {
    return `${this.namespace}:protected-stocks`;
  }

  private accessSequenceKey(): string {
    return `${this.namespace}:access-sequence`;
  }
}

/** What `auditTiers` found. `violations` is empty when both tiers hold their invariants. */
export type StockCacheTierAudit = {
  readonly namespace: string;
  /** Manifests in the namespace, READY or HYDRATING. */
  readonly manifests: number;
  readonly protected: {
    readonly designated: number;
    readonly ready: number;
    readonly hydrating: number;
    /** Designated, with no manifest: published again by `protect` or the next read. */
    readonly notResident: readonly string[];
    /** Per protected security, how many of its keys carry a TTL; must be empty. */
    readonly keysWithTtl: Readonly<Record<string, number>>;
  };
  readonly lru: {
    readonly capacity: number;
    readonly members: number;
    readonly ready: number;
    /** Members whose manifest is gone or HYDRATING: dropped at their next admission or eviction. */
    readonly withoutReadyManifest: readonly string[];
  };
  /** READY securities in neither tier. */
  readonly orphans: readonly string[];
  /** Securities in both tiers; must be empty. */
  readonly dualResidency: readonly string[];
  readonly eligibility?: {
    readonly eligible: number;
    readonly notDesignated: readonly string[];
    readonly designatedNotEligible: readonly string[];
    /** Must be empty. */
    readonly eligibleInLru: readonly string[];
  };
  readonly violations: string[];
};

export class NullStockDataCache implements StockDataCache {
  async getSecurity(_symbol: string): Promise<Security | null> {
    return null;
  }
  async setSecurity(
    _security: Security,
    _hydrating?: StockManifest,
  ): Promise<void> {}
  async getManifest(_securityId: string): Promise<StockManifest | null> {
    return null;
  }
  async setManifest(_manifest: StockManifest): Promise<void> {}
  async beginHydration(
    _observed: StockManifest | null,
    _hydrating: StockManifest,
  ): Promise<boolean> {
    return true;
  }
  async beginRefresh(
    _observed: StockManifest,
    _hydrating: StockManifest,
  ): Promise<boolean> {
    return false;
  }
  async completeHydration(
    _hydrating: StockManifest,
    _ready: StockManifest,
  ): Promise<boolean> {
    return true;
  }
  async renewHydration(_hydrating: StockManifest): Promise<boolean> {
    return true;
  }
  async invalidateManifest(_manifest: StockManifest | null): Promise<boolean> {
    return false;
  }
  async readDailyPrices(
    _securityId: string,
    _range: Required<DateRange>,
  ): Promise<DailyPrice[] | null> {
    return null;
  }
  async writeDailyPriceYears(
    _securityId: string,
    _prices: readonly DailyPrice[],
    _years: readonly number[],
    _hydrating?: StockManifest,
  ): Promise<void> {}
  async readDailyDerivedState(
    _securityId: string,
    _range: Required<DateRange>,
  ): Promise<DailyDerivedState[] | null> {
    return null;
  }
  async writeDailyDerivedStateYears(
    _securityId: string,
    _rows: readonly DailyDerivedState[],
    _years: readonly number[],
    _hydrating?: StockManifest,
  ): Promise<void> {}
  async hasResidentStock(_securityId: string): Promise<boolean> {
    return false;
  }
  async touch(_securityId: string): Promise<void> {}
  async evict(_securityId: string): Promise<void> {}
}

function isReadyManifestPayload(payload: string | null): payload is string {
  return (
    payload !== null &&
    (JSON.parse(payload) as StockManifest).status === "READY"
  );
}

export function yearsInRange(range: Required<DateRange>): number[] {
  const first = Number(range.from.slice(0, 4));
  const last = Number(range.to.slice(0, 4));
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/**
 * The key of one security's `daily-state` chunk for one year.
 *
 * One chunk family holds the whole daily derived state for a year — never a key per indicator,
 * model, blend or metric. The encoding version is part of the key, so chunks of two encodings never
 * share one. Keys are registered so
 * complete-stock LRU eviction removes every cached dataset for the security together.
 */
export function dailyStateChunkKey(
  namespace: string,
  securityId: string,
  year: number,
): string {
  return `${namespace}:security:${securityId}:daily-state:v${DAILY_STATE_ENCODING_VERSION}:${year}`;
}

/**
 * Lua shared by the admitting scripts (`docs/decisions/stock-cache-tiers-v1.md`).
 *
 * `next_sequence` is the LRU's clock: an `INCR`, never below the newest score already in the LRU, so
 * a counter lost on its own (an operator's `DEL`) cannot rank new accesses behind old ones.
 *
 * `enforce_capacity` evicts least-recently-used members until the LRU holds at most `max` distinct
 * securities, deleting every registered key of each victim in the same script — a security is never
 * half evicted, and no reader can count it as resident afterwards. A protected victim (impossible
 * while the scripts keep the tiers disjoint) only leaves the LRU; its keys stay.
 */
const LRU_LUA = `
local function next_sequence(resident, counter)
  local sequence = redis.call('INCR', counter)
  local newest = redis.call('ZRANGE', resident, -1, -1, 'WITHSCORES')
  if newest[2] ~= nil and tonumber(newest[2]) >= sequence then
    sequence = tonumber(newest[2]) + 1
    redis.call('SET', counter, string.format('%d', sequence))
  end
  return sequence
end
local function enforce_capacity(resident, protected, namespace, max, victims)
  while redis.call('ZCARD', resident) > max do
    local victim = redis.call('ZRANGE', resident, 0, 0)[1]
    if victim == nil then break end
    redis.call('ZREM', resident, victim)
    if redis.call('SISMEMBER', protected, victim) == 0 then
      local registry = namespace .. ':security:' .. victim .. ':keys'
      local keys = redis.call('SMEMBERS', registry)
      for _, key in ipairs(keys) do redis.call('DEL', key) end
      redis.call('DEL', registry)
      victims[#victims + 1] = victim
    end
  end
end
`;

/**
 * Starts a HYDRATING generation over exactly the observed manifest, replacing every key of the
 * previous one. A protected security (`ARGV[6]` `P`, or already designated) is designated here, and
 * its generation is **persistent**: no TTL on the manifest or the registry, so no key it writes ever
 * gets one (`set-registered` follows the manifest). An abandoned one is taken over by the next lease
 * holder, as any HYDRATING generation is. An LRU security's generation expires whole if abandoned.
 */
const BEGIN_HYDRATION = `
-- begin-hydration
local current = redis.call('GET', KEYS[1])
if ARGV[2] == '0' and current ~= false then return 0 end
if ARGV[2] == '1' and current ~= ARGV[3] then return 0 end
local keys = redis.call('SMEMBERS', KEYS[2])
for _, key in ipairs(keys) do redis.call('DEL', key) end
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[3], ARGV[1])
if ARGV[6] == 'P' then redis.call('SADD', KEYS[4], ARGV[1]) end
if redis.call('SISMEMBER', KEYS[4], ARGV[1]) == 1 then
  redis.call('SET', KEYS[1], ARGV[4])
  redis.call('SADD', KEYS[2], KEYS[1])
else
  redis.call('SET', KEYS[1], ARGV[4], 'PX', ARGV[5])
  redis.call('SADD', KEYS[2], KEYS[1])
  redis.call('PEXPIRE', KEYS[2], ARGV[5])
end
return 1
`;

/**
 * Turns a resident READY generation into a HYDRATING one that keeps its keys. Admitted for an LRU
 * member or a protected security (designated here when `ARGV[5]` is `P`). A protected refresh stays
 * persistent — its keys never get a TTL — where an LRU one expires whole if abandoned.
 */
const BEGIN_REFRESH = `
-- begin-refresh
if redis.call('GET', KEYS[1]) ~= ARGV[2] then return 0 end
if ARGV[5] == 'P' then redis.call('SADD', KEYS[4], ARGV[1]) end
local protected = redis.call('SISMEMBER', KEYS[4], ARGV[1]) == 1
if not protected and redis.call('ZSCORE', KEYS[3], ARGV[1]) == false then return 0 end
if protected then
  redis.call('SET', KEYS[1], ARGV[3])
  redis.call('SADD', KEYS[2], KEYS[1])
else
  redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[4])
  redis.call('SADD', KEYS[2], KEYS[1])
  local keys = redis.call('SMEMBERS', KEYS[2])
  for _, key in ipairs(keys) do redis.call('PEXPIRE', key, ARGV[4]) end
  redis.call('PEXPIRE', KEYS[2], ARGV[4])
end
redis.call('ZREM', KEYS[3], ARGV[1])
return 1
`;

/**
 * Writes one key of the security's current generation and registers it.
 *
 * A key written into a HYDRATING generation takes the manifest's **remaining** lifetime, so the
 * whole generation — manifest, registry and every chunk — always expires together and a READY
 * publication can never find a chunk gone before its manifest. The lifetime is extended only when
 * the hydration's own generation is less than half-way from expiry, and then for every registered
 * key at once. That replaced a re-expiry of every registered key on every write — K²/2 PEXPIREs for
 * a K-key hydration, about 48,000 for one 34-year stock (OPS-04) — with one pass per half-lifetime.
 *
 * A persistent generation (a protected security's: its manifest has no TTL, `PTTL` -1) writes
 * persistent keys, so nothing of the protected tier ever expires.
 */
const SET_REGISTERED = `
-- set-registered
local temporaryTtl = 0
local manifest = redis.call('GET', KEYS[3])
if ARGV[2] ~= '' then
  if manifest ~= ARGV[2] then return 0 end
  local remaining = redis.call('PTTL', KEYS[3])
  if remaining ~= -1 then
    if remaining <= 0 then return 0 end
    temporaryTtl = remaining
    local full = tonumber(ARGV[3])
    if temporaryTtl < full / 2 then
      local keys = redis.call('SMEMBERS', KEYS[2])
      for _, key in ipairs(keys) do redis.call('PEXPIRE', key, full) end
      redis.call('PEXPIRE', KEYS[2], full)
      temporaryTtl = full
    end
  end
elseif manifest ~= false then
  local ok, value = pcall(cjson.decode, manifest)
  if ok and value.status == 'HYDRATING' then
    local remaining = redis.call('PTTL', KEYS[3])
    if remaining ~= -1 then
      if remaining <= 0 then return 0 end
      temporaryTtl = remaining
    end
  end
end
if temporaryTtl > 0 then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', temporaryTtl)
else
  redis.call('SET', KEYS[1], ARGV[1])
end
redis.call('SADD', KEYS[2], KEYS[1])
return 1
`;

/**
 * Confirms a HYDRATING generation is still the current one and gives it its full lifetime again.
 * Its holder calls it between long phases — a provider read, a statement backfill, a derived
 * rebuild — which register no key and would otherwise let a slow hydration's generation expire
 * under a lease it still holds. A handful of calls per hydration, each one pass over the registered
 * keys, so every phase may last up to the whole lifetime. A persistent (protected) generation has no
 * lifetime to renew.
 */
const RENEW_HYDRATION = `
-- renew-hydration
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local remaining = redis.call('PTTL', KEYS[1])
if remaining == -1 then return 1 end
if remaining <= 0 then return 0 end
local full = tonumber(ARGV[2])
local keys = redis.call('SMEMBERS', KEYS[2])
for _, key in ipairs(keys) do redis.call('PEXPIRE', key, full) end
redis.call('PEXPIRE', KEYS[2], full)
return 1
`;

/**
 * A read's access: `0` not READY, `{1, victim…}` recorded (an LRU member moved to most recent, or a
 * protected security, which has no position), `2` READY but counted by neither tier — the caller then
 * admits it (`admit-resident`). Never adds an LRU member itself. An LRU read enforces the count
 * (`ARGV[2]`), which costs one `ZCARD` when nothing is over it: a capacity lowered by configuration is
 * then reached at the next LRU read, not only at the next admission. A protected read changes
 * nothing in the LRU.
 */
const TOUCH_READY = `
-- touch-ready
${LRU_LUA}
local manifest = redis.call('GET', KEYS[1])
if manifest == false then return 0 end
local ok, value = pcall(cjson.decode, manifest)
if not ok or value.status ~= 'READY' then return 0 end
-- A protected read never touches the LRU.
if redis.call('SISMEMBER', KEYS[4], ARGV[1]) == 1 then return {1} end
if redis.call('ZSCORE', KEYS[2], ARGV[1]) == false then return 2 end
redis.call('ZADD', KEYS[2], next_sequence(KEYS[2], KEYS[3]), ARGV[1])
local victims = {}
enforce_capacity(KEYS[2], KEYS[4], ARGV[3], tonumber(ARGV[2]), victims)
local reply = {1}
for _, victim in ipairs(victims) do reply[#reply + 1] = victim end
return reply
`;

/**
 * Admits a READY security no tier counts — its chunks outlived the LRU or the designation — under
 * the same rules as a publication: protected when `ARGV[4]` is `P` or it is designated, else the
 * LRU's newest member, with its capacity enforced. Replies `{1, victim…}`, or `0` when it is no
 * longer READY.
 */
const ADMIT_RESIDENT = `
-- admit-resident
${LRU_LUA}
local manifest = redis.call('GET', KEYS[1])
if manifest == false then return 0 end
local ok, value = pcall(cjson.decode, manifest)
if not ok or value.status ~= 'READY' then return 0 end
if ARGV[4] == 'P' then redis.call('SADD', KEYS[4], ARGV[1]) end
if redis.call('SISMEMBER', KEYS[4], ARGV[1]) == 1 then
  redis.call('ZREM', KEYS[2], ARGV[1])
  return {1}
end
redis.call('ZADD', KEYS[2], next_sequence(KEYS[2], KEYS[3]), ARGV[1])
local victims = {}
enforce_capacity(KEYS[2], KEYS[4], ARGV[3], tonumber(ARGV[2]), victims)
local reply = {1}
for _, victim in ipairs(victims) do reply[#reply + 1] = victim end
return reply
`;

/**
 * Publishes a READY generation over the one it observed (none, or its own HYDRATING one) and admits
 * the security to its tier: protected when `ARGV[6]` is `P` or it is designated — outside the LRU,
 * never counted, never a victim — else the LRU's newest member, evicting least-recently-used ones
 * beyond `ARGV[3]` distinct securities. Every registered key loses its in-flight TTL. Replies
 * `{1, victim…}`, or `0` when the generation changed.
 */
const PUBLISH_READY = `
-- publish-ready
${LRU_LUA}
local current = redis.call('GET', KEYS[1])
if ARGV[5] ~= '' then
  if current ~= ARGV[5] then return 0 end
elseif current ~= false then
  return 0
end
local registered = redis.call('SMEMBERS', KEYS[2])
for _, key in ipairs(registered) do redis.call('PERSIST', key) end
redis.call('PERSIST', KEYS[2])
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SADD', KEYS[2], KEYS[1])
if ARGV[6] == 'P' then redis.call('SADD', KEYS[5], ARGV[2]) end
if redis.call('SISMEMBER', KEYS[5], ARGV[2]) == 1 then
  redis.call('ZREM', KEYS[3], ARGV[2])
  return {1}
end
redis.call('ZADD', KEYS[3], next_sequence(KEYS[3], KEYS[4]), ARGV[2])
local victims = {}
enforce_capacity(KEYS[3], KEYS[5], ARGV[4], tonumber(ARGV[3]), victims)
local reply = {1}
for _, victim in ipairs(victims) do reply[#reply + 1] = victim end
return reply
`;

const INVALIDATE_MANIFEST = `
-- invalidate-manifest
local current = redis.call('GET', KEYS[1])
if current == false or current ~= ARGV[2] then return 0 end
local ok, value = pcall(cjson.decode, current)
if not ok or value.status ~= 'READY' then return 0 end
local keys = redis.call('SMEMBERS', KEYS[3])
for _, key in ipairs(keys) do redis.call('DEL', key) end
redis.call('DEL', KEYS[3])
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

const EVICT_RESIDENT_STOCK = `
-- evict-resident-stock
if redis.call('ZSCORE', KEYS[2], ARGV[1]) == false
  and redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 0 then return 0 end
local keys = redis.call('SMEMBERS', KEYS[1])
for _, key in ipairs(keys) do redis.call('DEL', key) end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

const PROTECTED_READY = `
-- protected-ready
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 0 then return 0 end
local manifest = redis.call('GET', KEYS[2])
if manifest == false then return 0 end
local ok, value = pcall(cjson.decode, manifest)
if ok and value.status == 'READY' then return 1 end
return 0
`;

const PROTECT_STOCKS = `
-- protect-stocks
local added = 0
for _, id in ipairs(ARGV) do
  added = added + redis.call('SADD', KEYS[1], id)
  redis.call('ZREM', KEYS[2], id)
end
return added
`;

/**
 * Removes designations. A READY security rejoins the LRU as its newest member, under its capacity; a
 * persistent HYDRATING one gets the in-flight lifetime an LRU generation has (`ARGV[3]`), so an
 * abandoned one expires instead of staying behind uncounted. Replies `{removed, victim…}`.
 */
const UNPROTECT_STOCKS = `
-- unprotect-stocks
${LRU_LUA}
local removed = 0
for index = 4, #ARGV do
  local id = ARGV[index]
  if redis.call('SREM', KEYS[1], id) == 1 then
    removed = removed + 1
    local manifestKey = ARGV[2] .. ':security:' .. id .. ':manifest'
    local manifest = redis.call('GET', manifestKey)
    if manifest ~= false then
      local ok, value = pcall(cjson.decode, manifest)
      if ok and value.status == 'READY' then
        redis.call('ZADD', KEYS[2], next_sequence(KEYS[2], KEYS[3]), id)
      elseif ok and value.status == 'HYDRATING' and redis.call('PTTL', manifestKey) == -1 then
        local registry = ARGV[2] .. ':security:' .. id .. ':keys'
        for _, key in ipairs(redis.call('SMEMBERS', registry)) do
          redis.call('PEXPIRE', key, ARGV[3])
        end
        redis.call('PEXPIRE', registry, ARGV[3])
        redis.call('PEXPIRE', manifestKey, ARGV[3])
      end
    end
  end
end
local victims = {}
enforce_capacity(KEYS[2], KEYS[1], ARGV[2], tonumber(ARGV[1]), victims)
local reply = {removed}
for _, victim in ipairs(victims) do reply[#reply + 1] = victim end
return reply
`;

/**
 * Per protected security of `ARGV[2..]`, how many of its registered keys (and its registry) carry a
 * TTL. Read-only.
 */
const AUDIT_PROTECTED_TTL = `
-- audit-protected-ttl
local counts = {}
for index = 2, #ARGV do
  local registry = ARGV[1] .. ':security:' .. ARGV[index] .. ':keys'
  local count = 0
  if redis.call('PTTL', registry) >= 0 then count = count + 1 end
  for _, key in ipairs(redis.call('SMEMBERS', registry)) do
    if redis.call('PTTL', key) >= 0 then count = count + 1 end
  end
  counts[#counts + 1] = count
end
return counts
`;

/** Securities per audit `MGET` and TTL script call. */
const AUDIT_BATCH_SIZE = 100;

/** Ids per protect/unprotect script call: bounded, so one call never blocks Redis for long. */
const PROTECTED_BATCH_SIZE = 500;

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
