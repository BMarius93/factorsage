import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import type { BenchmarkDailyPrice } from "@intrinsic/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BENCHMARK_CHUNK_ENCODING_VERSION } from "./benchmark-chunk.js";
import { RedisBenchmarkDataCache } from "./benchmark-cache.js";
import {
  BENCHMARK_PRICE_DATASET_VERSION,
  type BenchmarkCacheHead,
} from "./benchmark-ports.js";
import {
  FINANCIAL_STATEMENT_VERSION,
  RedisStockDataCache,
  type RedisCacheClient,
  type StockManifest,
} from "./cache.js";
import { DAILY_STATE_ENCODING_VERSION } from "./daily-state-chunk.js";
import { DERIVED_STATE_REVISION } from "./derived-state.js";
import { PRICE_DATASET_VERSION } from "./ports.js";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
} from "./redis-client.js";
import { priceRetentionYears } from "./service.js";

loadRootEnv();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "Benchmark cache protocol tests require TEST_REDIS_URL or REDIS_URL: they are the proof that a " +
      "reader never combines two publications.",
  );
}
const describeCache = redisUrl ? describe : describe.skip;

const SERIES = `series-${randomUUID()}`;

function bar(date: string, close: number): BenchmarkDailyPrice {
  return {
    seriesId: SERIES,
    date,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
  };
}

/** One publication's bars: a year per key, every close carrying the publication's mark. */
function history(mark: number, years: readonly number[]) {
  return new Map(
    years.map((year) => [
      year,
      [
        bar(`${year}-01-02`, mark + year),
        bar(`${year}-06-01`, mark + year + 0.5),
      ],
    ]),
  );
}

function headFor(
  digests: Record<number, string>,
  ranges = [{ from: "2018-01-01", to: "2021-12-31" }],
): BenchmarkCacheHead {
  const years = Object.keys(digests).map(Number).sort();
  return {
    seriesId: SERIES,
    chunkEncodingVersion: BENCHMARK_CHUNK_ENCODING_VERSION,
    priceDatasetVersion: BENCHMARK_PRICE_DATASET_VERSION,
    basisGeneration: 0,
    residentRanges: ranges,
    chunks: Object.fromEntries(
      Object.entries(digests).map(([year, digest]) => [year, digest]),
    ),
    bars: years.length * 2,
    ...(years.length > 0
      ? { firstDate: `${years[0]}-01-02`, lastDate: `${years.at(-1)}-06-01` }
      : {}),
    materializedAt: new Date().toISOString(),
  };
}

/** A Redis client that counts what reads ask for and can run a hook before the next `MGET`. */
class ObservedClient implements RedisCacheClient {
  readonly mgets: string[][] = [];
  beforeNextMget: (() => Promise<void>) | null = null;

  constructor(private readonly inner: IoredisCacheClient) {}

  get(key: string) {
    return this.inner.get(key);
  }
  async mget(...keys: string[]) {
    const hook = this.beforeNextMget;
    this.beforeNextMget = null;
    if (hook) {
      await hook();
    }
    this.mgets.push(keys);
    return this.inner.mget(...keys);
  }
  /** The byte-level `MGET` the cache reads chunks with: one command, counted like `mget`. */
  async mgetBuffer(...keys: string[]) {
    const hook = this.beforeNextMget;
    this.beforeNextMget = null;
    if (hook) {
      await hook();
    }
    this.mgets.push(keys);
    return this.inner.mgetBuffer(...keys);
  }
  set(key: string, value: string) {
    return this.inner.set(key, value);
  }
  sadd(key: string, ...members: string[]) {
    return this.inner.sadd(key, ...members);
  }
  smembers(key: string) {
    return this.inner.smembers(key);
  }
  incr(key: string) {
    return this.inner.incr(key);
  }
  zadd(key: string, score: number, member: string) {
    return this.inner.zadd(key, score, member);
  }
  zcard(key: string) {
    return this.inner.zcard(key);
  }
  zrange(key: string, start: number, stop: number) {
    return this.inner.zrange(key, start, stop);
  }
  zscore(key: string, member: string) {
    return this.inner.zscore(key, member);
  }
  zrem(key: string, ...members: string[]) {
    return this.inner.zrem(key, ...members);
  }
  del(...keys: string[]) {
    return this.inner.del(...keys);
  }
  eval(script: string, numberOfKeys: number, ...args: Array<string | Buffer>) {
    return this.inner.eval(script, numberOfKeys, ...args);
  }
}

describeCache("benchmark cache publication protocol", () => {
  const namespace = `benchmark:test:${randomUUID().slice(0, 8)}`;
  const prefix = `${namespace}:benchmark:${SERIES}`;
  const redis = createStockDataRedisClient(
    redisUrl ?? "redis://localhost:6379",
  );
  const client = new ObservedClient(new IoredisCacheClient(redis));
  const unreadable: { key: string; reason: string }[] = [];
  const cache = new RedisBenchmarkDataCache(client, {
    namespace,
    stageTtlMs: 1_500,
    observer: { onUnreadableChunk: (chunk) => unreadable.push(chunk) },
  });

  async function clear(pattern = `${namespace}*`): Promise<void> {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  /** Commits one publication over whatever head is current. */
  async function commit(
    mark: number,
    years: readonly number[],
    digest = (year: number) => `m${mark}y${year}`,
  ): Promise<BenchmarkCacheHead> {
    const head = headFor(
      Object.fromEntries(years.map((year) => [year, digest(year)])),
    );
    const outcome = await cache.publish({
      expected: await cache.getHead(SERIES),
      head,
      stage: history(mark, years),
    });
    expect(outcome).toBe("COMMITTED");
    return head;
  }

  beforeAll(async () => {
    await redis.ping();
  });

  beforeEach(async () => {
    await clear();
    // The series' generation fence, as a publisher establishes it from PostgreSQL. Every head in
    // this suite is on generation 0.
    await cache.fenceGeneration(SERIES, 0);
    client.mgets.length = 0;
    unreadable.length = 0;
  });

  afterAll(async () => {
    await clear();
    redis.disconnect();
  });

  it("commits a head and its chunks with no expiry anywhere", async () => {
    await commit(1000, [2019, 2020]);

    const keys = await redis.keys(`${prefix}*`);
    expect(keys.sort()).toEqual(
      [
        `${prefix}:chunks`,
        `${prefix}:daily-price:v1:2019:m1000y2019`,
        `${prefix}:daily-price:v1:2020:m1000y2020`,
        `${prefix}:generation`,
        `${prefix}:head`,
      ].sort(),
    );
    for (const key of keys) {
      // -1: the key exists and has no TTL. Residency is a property of the data, never of a timer.
      expect(await redis.pttl(key)).toBe(-1);
    }
  });

  it("answers a bounded read from the head with one MGET of exactly the years it needs", async () => {
    await commit(1000, [2018, 2019, 2020, 2021]);

    const read = await cache.readDailyPrices(SERIES, {
      from: "2020-01-01",
      to: "2020-12-31",
    });

    expect(read?.rows.map((row) => row.close)).toEqual([3020, 3020.5]);
    expect(client.mgets).toEqual([
      [`${prefix}:daily-price:v1:2020:m1000y2020`],
    ]);
  });

  it("answers a range reaching outside coverage with every stored bar, and the coverage to report the rest", async () => {
    await commit(1000, [2018, 2019, 2020, 2021]);
    const read = await cache.readDailyPrices(SERIES, {
      from: "2017-06-01",
      to: "2018-06-30",
    });

    // The head is a complete image of PostgreSQL: the bars it holds, and the coverage that says the
    // part before 2018 was never asked for. The caller reports that part as missing.
    expect(read?.rows.map((row) => row.date)).toEqual([
      "2018-01-02",
      "2018-06-01",
    ]);
    expect(read?.head.residentRanges).toEqual([
      { from: "2018-01-01", to: "2021-12-31" },
    ]);
    // Only the year that exists was read; 2017 has no chunk.
    expect(client.mgets).toEqual([
      [`${prefix}:daily-price:v1:2018:m1000y2018`],
    ]);
  });

  it("reads everything through a date from the start of the published history", async () => {
    await commit(1000, [2018, 2019, 2020]);
    const read = await cache.readHistoryThrough(SERIES, "2019-03-31");

    expect(read?.from).toBe("2018-01-01");
    expect(read?.rows.map((row) => row.date)).toEqual([
      "2018-01-02",
      "2018-06-01",
      "2019-01-02",
    ]);
    // A date before the history begins is an empty answer, not an error.
    await expect(
      cache.readHistoryThrough(SERIES, "2017-12-31"),
    ).resolves.toMatchObject({ rows: [], from: "2018-01-01" });
  });

  it("knows when a chunk its head names has gone, so residency can repair it", async () => {
    const head = await commit(1000, [2019, 2020]);
    await expect(cache.chunksPresent(head)).resolves.toBe(true);

    await redis.del(`${prefix}:daily-price:v1:2019:m1000y2019`);

    await expect(cache.chunksPresent(head)).resolves.toBe(false);
  });

  it("never lets a reader combine two publications: one that loses the race re-reads the new head", async () => {
    await commit(1000, [2019, 2020]);
    // Between this reader's GET of the head and its MGET of the chunks, a new publication of every
    // year — a re-base, say — commits and removes the old chunks.
    client.beforeNextMget = async () => {
      await commit(2000, [2019, 2020]);
    };

    const read = await cache.readDailyPrices(SERIES, {
      from: "2019-01-01",
      to: "2020-12-31",
    });

    // All of the new publication, none of the old one.
    expect(read?.rows.map((row) => row.close)).toEqual([
      4019, 4019.5, 4020, 4020.5,
    ]);
    expect(client.mgets).toHaveLength(2);
    expect(client.mgets[0]).toEqual([
      `${prefix}:daily-price:v1:2019:m1000y2019`,
      `${prefix}:daily-price:v1:2020:m1000y2020`,
    ]);
  });

  it("reuses an unchanged year's chunk and replaces only the changed one", async () => {
    await commit(1000, [2019, 2020]);
    const head = headFor({ 2019: "m1000y2019", 2020: "m2000y2020" });
    const outcome = await cache.publish({
      expected: await cache.getHead(SERIES),
      head,
      stage: new Map([[2020, history(2000, [2020]).get(2020)!]]),
    });

    expect(outcome).toBe("COMMITTED");
    expect((await redis.keys(`${prefix}:daily-price:*`)).sort()).toEqual([
      `${prefix}:daily-price:v1:2019:m1000y2019`,
      `${prefix}:daily-price:v1:2020:m2000y2020`,
    ]);
  });

  it("refuses a commit whose expected head has moved, and changes nothing", async () => {
    const stale = await cache.getHead(SERIES);
    await commit(1000, [2019]);
    const current = await redis.get(`${prefix}:head`);

    const outcome = await cache.publish({
      expected: stale,
      head: headFor({ 2019: "m3000y2019" }),
      stage: history(3000, [2019]),
    });

    expect(outcome).toBe("CONFLICT");
    expect(await redis.get(`${prefix}:head`)).toBe(current);
  });

  it("refuses a head that names a chunk that does not exist", async () => {
    await commit(1000, [2019]);
    const before = await redis.get(`${prefix}:head`);

    const outcome = await cache.publish({
      expected: await cache.getHead(SERIES),
      head: headFor({ 2019: "m1000y2019", 2020: "never-staged" }),
      stage: new Map(),
    });

    expect(outcome).toBe("MISSING_CHUNKS");
    expect(await redis.get(`${prefix}:head`)).toBe(before);
  });

  it("exposes nothing of an interrupted publication, which expires on its own and is swept by the next commit", async () => {
    await commit(1000, [2019]);
    // A publisher stages its chunks and dies before it commits (here: loses the compare-and-set).
    await cache.publish({
      expected: null,
      head: headFor({ 2019: "m5000y2019", 2020: "m5000y2020" }),
      stage: history(5000, [2019, 2020]),
    });
    const staged = `${prefix}:daily-price:v1:2020:m5000y2020`;
    expect(await redis.pttl(staged)).toBeGreaterThan(0);
    // Readers still see exactly the committed publication.
    const read = await cache.readDailyPrices(SERIES, {
      from: "2019-01-01",
      to: "2019-12-31",
    });
    expect(read?.rows.map((row) => row.close)).toEqual([3019, 3019.5]);

    await new Promise((resolve) => setTimeout(resolve, 1_700));
    expect(await redis.exists(staged)).toBe(0);

    // The next commit removes every registry entry its head does not name: memory stays bounded.
    await commit(6000, [2019]);
    expect(await redis.smembers(`${prefix}:chunks`)).toEqual([
      `${prefix}:daily-price:v1:2019:m6000y2019`,
    ]);
    expect((await redis.keys(`${prefix}:daily-price:*`)).sort()).toEqual([
      `${prefix}:daily-price:v1:2019:m6000y2019`,
    ]);
  });

  it("keeps exactly one publication's chunks after many republications", async () => {
    for (const mark of [1000, 2000, 3000, 4000]) {
      await commit(mark, [2018, 2019, 2020]);
    }
    expect((await redis.smembers(`${prefix}:chunks`)).sort()).toEqual(
      [2018, 2019, 2020].map(
        (year) => `${prefix}:daily-price:v1:${year}:m4000y${year}`,
      ),
    );
    expect(await redis.keys(`${prefix}:daily-price:*`)).toHaveLength(3);
  });

  it("discards one series' whole projection for an operator reset, and nothing of another series", async () => {
    await commit(1000, [2019, 2020]);
    const otherPrefix = `${namespace}:benchmark:OTHER`;
    await redis.set(`${otherPrefix}:head`, "kept");
    await redis.set(`${prefix}:daily-price:2018`, "[]");

    expect(await cache.discardProjection(SERIES)).toBe(2);

    // Only the generation fence stays: it is coordination, not projection, and the next
    // publication must still respect it.
    expect(await redis.keys(`${prefix}*`)).toEqual([`${prefix}:generation`]);
    expect(await cache.getHead(SERIES)).toBeNull();
    expect(await redis.get(`${otherPrefix}:head`)).toBe("kept");
    // Idempotent: discarding nothing is not an error.
    expect(await cache.discardProjection(SERIES)).toBe(0);
  });

  it("removes the legacy manifest-and-years layout on the first commit", async () => {
    await redis.set(`${prefix}:manifest`, JSON.stringify({ seriesId: SERIES }));
    await redis.set(`${prefix}:daily-price:1999`, "[]");
    await redis.set(`${prefix}:daily-price:2020`, "[]");

    await commit(1000, [2020]);

    expect(await redis.exists(`${prefix}:manifest`)).toBe(0);
    expect(await redis.exists(`${prefix}:daily-price:1999`)).toBe(0);
    expect(await redis.exists(`${prefix}:daily-price:2020`)).toBe(0);
  });

  it("commits a head only on the generation fence, and nothing at all without one", async () => {
    const onZero = headFor({ 2020: "m1000y2020" });
    const onOne = { ...onZero, basisGeneration: 1 };

    // A head on another generation than the fence is refused, and changes nothing.
    await expect(
      cache.publish({
        expected: null,
        head: onOne,
        stage: history(1000, [2020]),
      }),
    ).resolves.toBe("FENCED");
    expect(await redis.exists(`${prefix}:head`)).toBe(0);

    // Without a fence nothing commits, whatever its generation: a Redis that lost the fence must
    // have it re-established from PostgreSQL first.
    await redis.del(`${prefix}:generation`);
    await expect(
      cache.publish({
        expected: null,
        head: onZero,
        stage: history(1000, [2020]),
      }),
    ).resolves.toBe("FENCED");
    await expect(cache.getGenerationFence(SERIES)).resolves.toBeNull();

    await cache.fenceGeneration(SERIES, 0);
    await expect(
      cache.publish({
        expected: null,
        head: onZero,
        stage: history(1000, [2020]),
      }),
    ).resolves.toBe("COMMITTED");
  });

  it("raising the fence removes a head on any other generation, chunks included, and keeps one on its own", async () => {
    await commit(1000, [2019, 2020]);

    // Re-established on the generation the head is on: nothing changes.
    await cache.fenceGeneration(SERIES, 0);
    expect(await cache.getHead(SERIES)).not.toBeNull();

    // Raised past it: the head, the registry and every chunk go in the same step as the fence.
    await cache.fenceGeneration(SERIES, 1);
    expect((await redis.keys(`${prefix}*`)).sort()).toEqual([
      `${prefix}:generation`,
    ]);
    await expect(cache.getGenerationFence(SERIES)).resolves.toBe(1);

    // An unreadable head is removed too: it cannot show which generation it is on.
    await redis.set(`${prefix}:head`, "not json");
    await cache.fenceGeneration(SERIES, 1);
    expect(await redis.exists(`${prefix}:head`)).toBe(0);
  });

  it("removes old-layout years left behind without their manifest, on the first commit", async () => {
    // What an older invalidation leaves: the manifest deleted, the years still there, no TTL.
    await redis.set(`${prefix}:daily-price:2019`, "[]");

    await commit(1000, [2020]);

    expect(await redis.exists(`${prefix}:daily-price:2019`)).toBe(0);
  });

  it("reports and removes an unreadable chunk instead of serving it", async () => {
    await commit(1000, [2020]);
    const key = `${prefix}:daily-price:v1:2020:m1000y2020`;
    await redis.set(key, "{not json");

    await expect(
      cache.readDailyPrices(SERIES, { from: "2020-01-01", to: "2020-12-31" }),
    ).resolves.toBeNull();
    expect(unreadable.map((chunk) => chunk.key)).toEqual([key]);
    expect(await redis.exists(key)).toBe(0);
  });

  it("reads a rolling window newest year first, and only the years it needs", async () => {
    const years = [2018, 2019, 2020, 2021];
    await commit(1000, years);

    const read = await cache.readSessionsThrough(SERIES, "2021-03-01", 3);

    // 2021-01-02, then 2020's two: never 2021-06-01, which is after `through`.
    expect(read?.rows.map((row) => row.date)).toEqual([
      "2020-01-02",
      "2020-06-01",
      "2021-01-02",
    ]);
    expect(client.mgets).toHaveLength(1);
    expect(client.mgets[0]).toHaveLength(2);
  });

  it("is never evicted by the resident-stock LRU, which still evicts stocks exactly as before", async () => {
    await commit(1000, [2019, 2020]);
    const stockNamespace = `stock-data:test:${randomUUID().slice(0, 8)}`;
    const stocks = new RedisStockDataCache(
      new IoredisCacheClient(redis),
      1,
      stockNamespace,
    );
    const manifest = (securityId: string): StockManifest => ({
      securityId,
      status: "READY",
      productHistoryYears: 30,
      priceRetentionYears: priceRetentionYears(30),
      coverageStart: "2020-01-01",
      coverageEnd: "2020-12-31",
      priceDatasetVersion: PRICE_DATASET_VERSION,
      financialStatementVersion: FINANCIAL_STATEMENT_VERSION,
      derivedStateRevision: DERIVED_STATE_REVISION,
      dailyStateEncodingVersion: DAILY_STATE_ENCODING_VERSION,
    });
    try {
      for (const id of ["stock-a", "stock-b", "stock-c"]) {
        await stocks.writeDailyPriceYears(
          id,
          [
            {
              securityId: id,
              date: "2020-01-02",
              open: 1,
              high: 1,
              low: 1,
              close: 1,
              volume: 1,
            },
          ],
          [2020],
        );
        await stocks.setManifest(manifest(id));
      }
      // The bound is one resident stock: two were evicted whole, the newest stayed.
      await expect(stocks.hasResidentStock("stock-a")).resolves.toBe(false);
      await expect(stocks.hasResidentStock("stock-b")).resolves.toBe(false);
      await expect(stocks.hasResidentStock("stock-c")).resolves.toBe(true);
      expect(
        await redis.get(`${stockNamespace}:security:stock-a:prices:1D:2020`),
      ).toBeNull();

      // Every benchmark key is untouched.
      // The head, the registry, two chunks and the generation fence.
      expect((await redis.keys(`${prefix}*`)).length).toBe(5);
      const read = await cache.readDailyPrices(SERIES, {
        from: "2019-01-01",
        to: "2020-12-31",
      });
      expect(read?.rows).toHaveLength(4);
    } finally {
      await clear(`${stockNamespace}*`);
    }
  });
});
