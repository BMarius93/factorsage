import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import type {
  BenchmarkDailyPrice,
  BenchmarkSeries,
  DateRange,
} from "@intrinsic/domain";
import type { FmpBenchmarkProviderPort } from "@intrinsic/fmp";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BENCHMARK_CHUNK_ENCODING_VERSION,
  decodeBenchmarkChunk,
} from "./benchmark-chunk.js";
import { RedisBenchmarkDataCache } from "./benchmark-cache.js";
import { PrismaBenchmarkDataStore } from "./benchmark-prisma-store.js";
import {
  BENCHMARK_PRICE_DATASET_VERSION,
  type BenchmarkDataCache,
  type BenchmarkDataStore,
} from "./benchmark-ports.js";
import {
  CanonicalBenchmarkDataService,
  type BenchmarkCacheObservation,
  type CanonicalBenchmarkDataServiceOptions,
} from "./benchmark-service.js";
import type { RedisCacheClient } from "./cache.js";
import {
  InMemoryLoadCoordinator,
  RedlockLoadCoordinator,
  type LoadCoordinator,
} from "./coordination.js";
import { addDays } from "./dates.js";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
} from "./redis-client.js";
import { PriceBasisConflictError } from "./price-basis.js";
import type { PriceBasisObservation } from "./service.js";

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "Benchmark residency tests require TEST_REDIS_URL or REDIS_URL and TEST_DATABASE_URL.",
  );
}
const describeResidency = redisUrl ? describe : describe.skip;

/** A Friday, after the close. */
const TODAY = "2026-10-09";
const NOW = new Date(`${TODAY}T21:00:00.000Z`);
const FIRST = "2016-01-04";

function weekdays(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(date);
    }
  }
  return dates;
}

const DATES = weekdays(FIRST, TODAY);

/**
 * A provider with the whole history from `FIRST`, answering exactly the window it is asked for.
 *
 * `rebaseAt` simulates a split the provider has since folded in: every close before that date is
 * divided by the ratio, as a split-adjusted series does. `publishedThrough` withholds the newest
 * sessions, as a provider that has not published the close yet does.
 */
class HistoryProvider implements FmpBenchmarkProviderPort {
  readonly requests: Required<DateRange>[] = [];
  rebaseAt: { date: string; ratio: number } | null = null;
  publishedThrough = TODAY;
  correction: { date: string; close: number } | null = null;
  dropped = new Set<string>();

  close(date: string): number {
    const index = DATES.indexOf(date);
    const base = 50 + index * 0.05 + (index % 7) * 0.3;
    if (this.correction?.date === date) {
      return this.correction.close;
    }
    return this.rebaseAt && date < this.rebaseAt.date
      ? Math.round((base / this.rebaseAt.ratio) * 1e6) / 1e6
      : Math.round(base * 1e6) / 1e6;
  }

  async getBenchmarkDailyPrices(
    _symbol: string,
    seriesId: string,
    range: DateRange,
  ): Promise<BenchmarkDailyPrice[]> {
    const requested = { from: range.from as string, to: range.to as string };
    this.requests.push(requested);
    return DATES.filter(
      (date) =>
        date >= requested.from &&
        date <= requested.to &&
        date <= this.publishedThrough &&
        !this.dropped.has(date),
    ).map((date) => {
      const close = this.close(date);
      return {
        seriesId,
        date,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1_000,
      };
    });
  }
}

/** Counts the year chunks reads ask Redis for. */
class CountingClient extends IoredisCacheClient {
  chunkReads = 0;
  override async mget(...keys: string[]) {
    this.chunkReads += keys.length;
    return super.mget(...keys);
  }
}

describeResidency("benchmark history residency, reads and refresh", () => {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const namespace = `benchmark:test:${suffix}`;
  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(
    redisUrl ?? "redis://localhost:6379",
  );
  const client = new CountingClient(redis);
  const store = new PrismaBenchmarkDataStore(prisma);
  const cache = new RedisBenchmarkDataCache(client as RedisCacheClient, {
    namespace,
  });
  const codes = [`RESETF${suffix}`, `RESOTHER${suffix}`];
  let series: BenchmarkSeries;
  let other: BenchmarkSeries;
  let cacheEvents: BenchmarkCacheObservation[] = [];
  let basisEvents: PriceBasisObservation[] = [];

  function serviceWith(
    provider: FmpBenchmarkProviderPort,
    now = NOW,
    overrides: {
      store?: BenchmarkDataStore;
      cache?: BenchmarkDataCache;
      coordinator?: LoadCoordinator;
      options?: Pick<
        CanonicalBenchmarkDataServiceOptions,
        "residentReadLockWaitMs"
      >;
    } = {},
  ) {
    return new CanonicalBenchmarkDataService(
      overrides.store ?? store,
      provider,
      overrides.cache ?? cache,
      overrides.coordinator ?? new InMemoryLoadCoordinator(),
      {
        now: () => now,
        onCacheEvent: (event) => cacheEvents.push(event),
        onPriceBasisEvent: (event) => basisEvents.push(event),
        ...overrides.options,
      },
    );
  }

  /** The hydration lock as production takes it: Redlock on this Redis, a hydration-sized wait. */
  function redlock(): LoadCoordinator {
    return new RedlockLoadCoordinator(redis, {
      lockDurationMs: 30_000,
      lockWaitMs: 30_000,
    });
  }

  async function clearRedis(): Promise<void> {
    const keys = await redis.keys(`${namespace}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  async function resetSeries(target: BenchmarkSeries): Promise<void> {
    await prisma.benchmarkDailyPrice.deleteMany({
      where: { seriesId: target.id },
    });
    await prisma.benchmarkDatasetCoverage.deleteMany({
      where: { seriesId: target.id },
    });
    await prisma.benchmarkDatasetState.deleteMany({
      where: { seriesId: target.id },
    });
    await prisma.benchmarkSeriesPriceBasis.deleteMany({
      where: { seriesId: target.id },
    });
    await prisma.benchmarkPriceBasisEvent.deleteMany({
      where: { seriesId: target.id },
    });
  }

  /**
   * `target` with every method call recorded in `calls`, and any method in `replace` swapped for
   * the given implementation (called with the original bound to `target`).
   */
  function watched<T extends object>(
    target: T,
    calls: string[],
    replace: Partial<
      Record<
        string,
        (original: (...args: never[]) => unknown, ...args: never[]) => unknown
      >
    > = {},
  ): T {
    return new Proxy(target, {
      get(object, property, receiver) {
        const value = Reflect.get(object, property, receiver) as unknown;
        if (typeof value !== "function") {
          return value;
        }
        const original = (value as (...args: never[]) => unknown).bind(object);
        const override = replace[String(property)];
        return (...args: never[]) => {
          calls.push(String(property));
          return override ? override(original, ...args) : original(...args);
        };
      },
    });
  }

  /** The bootstrap: every bar from before the fund's first session to today. */
  async function bootstrap(
    provider = new HistoryProvider(),
    target = series,
  ): Promise<HistoryProvider> {
    await serviceWith(provider).ensureBenchmarkHydrated(target, {
      from: "2015-06-01",
      to: TODAY,
    });
    return provider;
  }

  beforeAll(async () => {
    await redis.ping();
    const reconciled = await store.reconcileBenchmarkCatalog(
      codes.map((code, index) => ({
        code,
        name: code,
        sourceKind: "FMP_SYMBOL" as const,
        seriesType: "ETF_PROXY" as const,
        providerSymbol: `T${index}${suffix}`,
        currency: "USD",
        methodologyVersion: 1,
        isActive: true,
        isBacktestSelectable: false,
        displayOrder: 99,
      })),
    );
    series = reconciled[0]!.series;
    other = reconciled[1]!.series;
  });

  beforeEach(async () => {
    await clearRedis();
    await resetSeries(series);
    await resetSeries(other);
    cacheEvents = [];
    basisEvents = [];
    client.chunkReads = 0;
  });

  afterAll(async () => {
    await clearRedis();
    redis.disconnect();
    await prisma.benchmark.deleteMany({ where: { code: { in: codes } } });
    await prisma.$disconnect();
  });

  describe("residency", () => {
    it("publishes the whole durable history, back to before the first session, with no TTL", async () => {
      await bootstrap();

      const observed = await cache.getHead(series.id);
      expect(observed?.head.residentRanges).toEqual([
        { from: "2015-06-01", to: TODAY },
      ]);
      expect(observed?.head.firstDate).toBe(FIRST);
      expect(observed?.head.lastDate).toBe(TODAY);
      expect(observed?.head.bars).toBe(DATES.length);
      expect(Object.keys(observed?.head.chunks ?? {})).toHaveLength(11);
      for (const key of await redis.keys(
        `${namespace}:benchmark:${series.id}*`,
      )) {
        expect(await redis.pttl(key)).toBe(-1);
      }
      // The months before the fund existed are covered and empty, not missing.
      const prefix = await serviceWith(
        new HistoryProvider(),
      ).readBenchmarkHistory(series, { from: "2015-06-01", to: "2015-12-31" });
      expect(prefix).toMatchObject({ rows: [], missing: [], source: "REDIS" });
    });

    it("never narrows residency for a narrow read, and serves the full history from Redis", async () => {
      await bootstrap();
      const before = (await cache.getHead(series.id))?.head;

      const provider = new HistoryProvider();
      const recent = await serviceWith(provider).getBenchmarkDailyPrices(
        series,
        {
          from: "2026-09-01",
          to: TODAY,
        },
      );
      expect(recent.length).toBeGreaterThan(20);
      expect(provider.requests).toEqual([]);
      expect((await cache.getHead(series.id))?.head.residentRanges).toEqual(
        before?.residentRanges,
      );

      const full = await serviceWith(provider).readFullBenchmarkHistory(series);
      expect(full.source).toBe("REDIS");
      expect(full.rows.map((row) => row.date)).toEqual(DATES);
      expect(provider.requests).toEqual([]);
    });

    it("rebuilds after Redis loses everything, from PostgreSQL alone", async () => {
      await bootstrap();
      await clearRedis();

      const provider = new HistoryProvider();
      const history = await serviceWith(provider).readBenchmarkHistory(series, {
        from: "2020-01-01",
        to: "2020-12-31",
      });

      expect(provider.requests).toEqual([]);
      expect(history.source).toBe("REDIS");
      expect(history.rows).toHaveLength(
        weekdays("2020-01-01", "2020-12-31").length,
      );
      expect((await cache.getHead(series.id))?.head.bars).toBe(DATES.length);
    });

    it("publishes once when several readers find Redis empty at the same time", async () => {
      await bootstrap();
      await clearRedis();
      cacheEvents = [];

      const service = serviceWith(new HistoryProvider());
      const reads = await Promise.all(
        Array.from({ length: 5 }, () =>
          service.readBenchmarkHistory(series, {
            from: "2024-01-01",
            to: "2024-12-31",
          }),
        ),
      );

      expect(
        cacheEvents.filter((event) => event.outcome === "PUBLISHED"),
      ).toHaveLength(1);
      for (const read of reads) {
        expect(read.rows).toEqual(reads[0]!.rows);
      }
    });

    it("publishes once when separate processes find Redis empty, and answers every reader with the stored history", async () => {
      await bootstrap();
      await clearRedis();
      cacheEvents = [];
      const range = { from: "2024-01-01", to: "2024-12-31" } as const;
      const stored = await store.getDailyPrices(series.id, range);

      // Each reader has its own coordinator, as each process has: what they share is the lock in
      // Redis. Some are answered by the rebuild, some give up on the lock and read PostgreSQL —
      // which one happens to a reader must not be visible in what it is told.
      const reads = await Promise.all(
        Array.from({ length: 8 }, () =>
          serviceWith(new HistoryProvider(), NOW, {
            coordinator: redlock(),
          }).readBenchmarkHistory(series, range),
        ),
      );

      for (const read of reads) {
        expect(read.rows).toEqual(stored);
        expect(read).toMatchObject({ missing: [], basisGeneration: 0 });
      }
      expect(
        cacheEvents.filter((event) => event.outcome === "PUBLISHED"),
      ).toHaveLength(1);
      expect((await cache.getHead(series.id))?.head.bars).toBe(DATES.length);
      await expect(
        serviceWith(new HistoryProvider()).readBenchmarkHistory(series, range),
      ).resolves.toMatchObject({ source: "REDIS" });
    });

    it("repairs a head whose chunk Redis lost, from PostgreSQL and never the provider", async () => {
      await bootstrap();
      const [chunk] = await redis.keys(
        `${namespace}:benchmark:${series.id}:daily-price:v1:2020:*`,
      );
      await redis.del(chunk as string);

      const provider = new HistoryProvider();
      const service = serviceWith(provider);
      // The digests still match PostgreSQL; the missing chunk is what makes the head not resident.
      await expect(
        service.ensureBenchmarkResident(series),
      ).resolves.toMatchObject({
        status: "REPUBLISHED",
      });
      const history = await service.readBenchmarkHistory(series, {
        from: "2020-01-01",
        to: "2020-12-31",
      });
      expect(history.source).toBe("REDIS");
      expect(history.rows.length).toBeGreaterThan(250);
      expect(provider.requests).toEqual([]);
    });

    it("reports a projection it could not publish, never an empty history, and still reads", async () => {
      await bootstrap();
      await clearRedis();
      cacheEvents = [];
      const failing = watched(cache, [], {
        publish: async () => {
          throw new Error(
            "READONLY You can't write against a read only replica.",
          );
        },
      });
      const service = serviceWith(new HistoryProvider(), NOW, {
        cache: failing,
      });

      await expect(
        service.ensureBenchmarkResident(series),
      ).resolves.toMatchObject({
        status: "UNPUBLISHED",
        bars: DATES.length,
      });
      expect(cacheEvents.map((event) => event.outcome)).toContain("FAILED");
      const history = await service.readBenchmarkHistory(series, {
        from: "2026-10-01",
        to: TODAY,
      });
      expect(history).toMatchObject({ source: "POSTGRESQL", missing: [] });
      expect(history.rows.at(-1)?.date).toBe(TODAY);
    });

    it("verifies a resident head against PostgreSQL and republishes only what differs", async () => {
      await bootstrap();
      const service = serviceWith(new HistoryProvider());
      await expect(
        service.ensureBenchmarkResident(series),
      ).resolves.toMatchObject({
        status: "RESIDENT",
        bars: DATES.length,
      });

      // A write that landed in PostgreSQL without a publication (a crash between the two).
      await prisma.benchmarkDailyPrice.updateMany({
        where: {
          seriesId: series.id,
          date: new Date("2019-05-01T00:00:00.000Z"),
        },
        data: { close: 1 },
      });
      cacheEvents = [];
      await expect(
        service.ensureBenchmarkResident(series),
      ).resolves.toMatchObject({
        status: "REPUBLISHED",
      });
      expect(cacheEvents).toEqual([
        expect.objectContaining({ outcome: "PUBLISHED", stagedYears: 1 }),
      ]);
      const read = await service.readBenchmarkSession(series, "2019-05-01");
      expect(read?.close).toBe(1);
    });
  });

  describe("worker reads", () => {
    it("reads a bounded range by deserializing only its years", async () => {
      await bootstrap();
      client.chunkReads = 0;
      const history = await serviceWith(
        new HistoryProvider(),
      ).readBenchmarkHistory(series, { from: "2021-03-01", to: "2021-03-31" });
      expect(history.rows.every((row) => row.date.startsWith("2021-03"))).toBe(
        true,
      );
      expect(client.chunkReads).toBe(1);
    });

    it("answers from Redis alone after the last stored session, reporting the days nobody asked for", async () => {
      await bootstrap();
      // Monday 11:00 in New York, before anything refreshed: coverage still ends on Friday, and
      // Monday's session is still trading, so no read may reach past Sunday (the EOD cutoff).
      const monday = new Date("2026-10-12T15:00:00.000Z");
      const calls: string[] = [];
      const reader = serviceWith(new HistoryProvider(), monday, {
        store: watched(store, calls),
      });
      const weekend = [{ from: "2026-10-10", to: "2026-10-11" }];

      const full = await reader.readFullBenchmarkHistory(series);
      const window = await reader.readBenchmarkSessions(series, {
        through: "2026-10-12",
        sessions: 5,
      });
      const range = await reader.readBenchmarkHistory(series, {
        from: "2026-10-01",
        to: "2026-10-12",
      });

      // No PostgreSQL call at all: the head is a complete image, coverage included.
      expect(calls).toEqual([]);
      expect(full).toMatchObject({ source: "REDIS", missing: weekend });
      expect(full.rows).toHaveLength(DATES.length);
      expect(window).toMatchObject({ source: "REDIS", missing: weekend });
      expect(window.rows.map((row) => row.date)).toEqual(DATES.slice(-5));
      expect(range).toMatchObject({ source: "REDIS", missing: weekend });
    });

    it("reads nothing, and throws nothing, for an end before the history begins", async () => {
      await bootstrap();
      await expect(
        serviceWith(new HistoryProvider()).readFullBenchmarkHistory(
          series,
          "2014-01-01",
        ),
      ).resolves.toMatchObject({ rows: [], missing: [] });
      await clearRedis();
      const offline = watched(cache, [], {
        publish: async () => {
          throw new Error("unavailable");
        },
      });
      await expect(
        serviceWith(new HistoryProvider(), NOW, {
          cache: offline,
        }).readFullBenchmarkHistory(series, "2014-01-01"),
      ).resolves.toMatchObject({ rows: [], missing: [], source: "POSTGRESQL" });
    });

    it("falls back to PostgreSQL when the repair cannot take the hydration lock", async () => {
      await bootstrap();
      await clearRedis();
      cacheEvents = [];
      const busy: LoadCoordinator = {
        run: async () => {
          throw new Error(
            "The operation was unable to achieve a quorum during its retry window.",
          );
        },
      };

      const history = await serviceWith(new HistoryProvider(), NOW, {
        coordinator: busy,
      }).readBenchmarkHistory(series, { from: "2026-10-01", to: TODAY });

      // The read still has an answer; only the republication failed, and it is reported.
      expect(history).toMatchObject({ source: "POSTGRESQL", missing: [] });
      expect(history.rows.at(-1)?.date).toBe(TODAY);
      expect(cacheEvents.map((event) => event.outcome)).toContain("FAILED");
    });

    it("does not make a read wait out the hydration lock before it answers from PostgreSQL", async () => {
      await bootstrap();
      await clearRedis();
      cacheEvents = [];
      // The real coordinator. Another process holds this series' hydration lock for as long as
      // the read is outstanding: a slow provider read, a rebuild, or — the same thing to a
      // reader — a Redis that answers reads but grants no lock at all.
      const resource = `benchmark:hydrate:${series.id}`;
      let release = (): void => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held = (): void => {};
      const holding = new Promise<void>((resolve) => {
        held = resolve;
      });
      const holder = new RedlockLoadCoordinator(redis, {
        lockDurationMs: 30_000,
        lockWaitMs: 30_000,
      }).run(resource, async () => {
        held();
        await released;
      });
      await holding;
      try {
        const reader = serviceWith(new HistoryProvider(), NOW, {
          // The loader's own patience for this lock, shortened from the production two minutes
          // only so that a regression fails in seconds.
          coordinator: new RedlockLoadCoordinator(redis, {
            lockDurationMs: 30_000,
            lockWaitMs: 8_000,
          }),
        });
        const started = Date.now();
        const history = await reader.readBenchmarkHistory(series, {
          from: "2026-10-01",
          to: TODAY,
        });
        const elapsedMs = Date.now() - started;

        // PostgreSQL had the answer the whole time. A provider-free read must not hold a request
        // for as long as a hydration is willing to wait for the same lock.
        expect(history).toMatchObject({ source: "POSTGRESQL", missing: [] });
        expect(history.rows.at(-1)?.date).toBe(TODAY);
        expect(elapsedMs).toBeLessThan(3_000);
        expect(cacheEvents.map((event) => event.outcome)).toContain("FAILED");
      } finally {
        release();
        await holder;
      }
    }, 20_000);

    it("fails the read when Redis cannot be read at all, whatever PostgreSQL holds", async () => {
      await bootstrap();
      const calls: string[] = [];
      const refused = async (): Promise<never> => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
      };
      const unreachable = watched(cache, [], {
        getHead: refused,
        readDailyPrices: refused,
        readHistoryThrough: refused,
        readSessionsThrough: refused,
      });
      const lock: LoadCoordinator = {
        run: async (_resource, work) => {
          calls.push("lock");
          return work({ assertOwned: () => {} });
        },
      };
      const service = serviceWith(new HistoryProvider(), NOW, {
        cache: unreachable,
        coordinator: lock,
      });

      // An outage, not a miss (`AGENTS.md` invariant 16): nothing degrades to PostgreSQL-only, and
      // a read that cannot see Redis does not go on to take its lock.
      await expect(
        service.readBenchmarkHistory(series, { from: "2026-10-01", to: TODAY }),
      ).rejects.toThrow("ECONNREFUSED");
      await expect(service.readFullBenchmarkHistory(series)).rejects.toThrow(
        "ECONNREFUSED",
      );
      await expect(
        service.readBenchmarkSessions(series, { through: TODAY, sessions: 5 }),
      ).rejects.toThrow("ECONNREFUSED");
      expect(calls).toEqual([]);
    });

    it("answers from PostgreSQL when Redis is lost between the read and the repair", async () => {
      await bootstrap();
      await clearRedis();
      cacheEvents = [];
      // The read itself sees an empty Redis; the repair that follows cannot reach it at all.
      const failing = watched(cache, [], {
        getHead: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
        },
      });

      const history = await serviceWith(new HistoryProvider(), NOW, {
        cache: failing,
      }).readBenchmarkHistory(series, { from: "2026-10-01", to: TODAY });

      expect(history).toMatchObject({ source: "POSTGRESQL", missing: [] });
      expect(history.rows.at(-1)?.date).toBe(TODAY);
      expect(cacheEvents.map((event) => event.outcome)).toContain("FAILED");
    });

    it("reads a single session, and nothing for a day the market did not trade", async () => {
      await bootstrap();
      const service = serviceWith(new HistoryProvider());
      expect(
        (await service.readBenchmarkSession(series, "2022-02-15"))?.date,
      ).toBe("2022-02-15");
      await expect(
        service.readBenchmarkSession(series, "2022-02-19"),
      ).resolves.toBeNull();
    });

    it("reads a rolling window that ends on its own end date and never after it", async () => {
      await bootstrap();
      const service = serviceWith(new HistoryProvider());
      const window = await service.readBenchmarkSessions(series, {
        through: "2023-06-14",
        sessions: 200,
      });
      expect(window.rows).toHaveLength(200);
      expect(window.rows.at(-1)?.date).toBe("2023-06-14");
      expect(window.rows.every((row) => row.date <= "2023-06-14")).toBe(true);
      expect(window.rows).toEqual(
        await store.getDailyPricesThrough(series.id, "2023-06-14", 200),
      );
    });

    it("never returns a bar after today, whatever end a caller asks for", async () => {
      await bootstrap();
      const history = await serviceWith(
        new HistoryProvider(),
      ).readBenchmarkHistory(series, { from: "2026-10-01", to: "2027-12-31" });
      expect(history.rows.at(-1)?.date).toBe(TODAY);
    });

    it("reads several series in one call, each from its own projection", async () => {
      await bootstrap();
      await bootstrap(new HistoryProvider(), other);
      const histories = await serviceWith(
        new HistoryProvider(),
      ).readBenchmarkHistories([series, other], {
        from: "2025-01-01",
        to: "2025-01-31",
      });
      expect(histories.map((history) => history.seriesId)).toEqual([
        series.id,
        other.id,
      ]);
      expect(histories.every((history) => history.source === "REDIS")).toBe(
        true,
      );
    });

    it("reports what PostgreSQL was never asked for, and never asks the provider itself", async () => {
      const provider = new HistoryProvider();
      const history = await serviceWith(provider).readBenchmarkHistory(series, {
        from: "2024-01-01",
        to: "2024-01-31",
      });
      expect(provider.requests).toEqual([]);
      expect(history).toMatchObject({
        rows: [],
        missing: [{ from: "2024-01-01", to: "2024-01-31" }],
        source: "POSTGRESQL",
      });
    });
  });

  describe("scheduled refresh", () => {
    it("never bootstraps a series that was never loaded", async () => {
      const provider = new HistoryProvider();
      await expect(
        serviceWith(provider).refreshBenchmarkSeries(series, {
          expectedSession: TODAY,
        }),
      ).resolves.toMatchObject({
        status: "NOT_BOOTSTRAPPED",
        providerReads: 0,
      });
      expect(provider.requests).toEqual([]);
    });

    it("reads one bounded tail, never the history, and keeps the projection complete", async () => {
      const yesterday = new HistoryProvider();
      yesterday.publishedThrough = "2026-10-08";
      await serviceWith(
        yesterday,
        new Date("2026-10-08T21:00:00.000Z"),
      ).ensureBenchmarkHydrated(series, {
        from: "2015-06-01",
        to: "2026-10-08",
      });

      const provider = new HistoryProvider();
      const result = await serviceWith(provider).refreshBenchmarkSeries(
        series,
        {
          expectedSession: TODAY,
        },
      );

      // The tail, then the earliest bars, because the tail adds a session beside the stored
      // history (`historical-price-basis-v1.md` §7, rule 2).
      expect(result).toMatchObject({
        status: "REFRESHED",
        latestBar: TODAY,
        providerReads: 2,
      });
      expect(provider.requests).toHaveLength(2);
      const [tail, earliest] = provider.requests;
      const span = (request: { from: string; to: string }) =>
        (Date.parse(`${request.to}T00:00:00Z`) -
          Date.parse(`${request.from}T00:00:00Z`)) /
        86_400_000;
      expect(tail!.to).toBe(TODAY);
      expect(span(tail!)).toBeLessThanOrEqual(11);
      expect(earliest!.from).toBe(DATES.find((date) => date >= "2015-06-01"));
      expect(span(earliest!)).toBeLessThanOrEqual(30);
      expect((await cache.getHead(series.id))?.head.residentRanges).toEqual([
        { from: "2015-06-01", to: TODAY },
      ]);
      expect((await cache.getHead(series.id))?.head.bars).toBe(DATES.length);
    });

    it("waits for a delayed publication and stores the session once the provider has it", async () => {
      await bootstrap(
        Object.assign(new HistoryProvider(), {
          publishedThrough: "2026-10-08",
        }),
      );

      const late = new HistoryProvider();
      late.publishedThrough = "2026-10-08";
      await expect(
        serviceWith(late).refreshBenchmarkSeries(series, {
          expectedSession: TODAY,
        }),
      ).resolves.toMatchObject({
        status: "AWAITING_PUBLICATION",
        latestBar: "2026-10-08",
      });

      const published = new HistoryProvider();
      await expect(
        serviceWith(
          published,
          new Date(`${TODAY}T22:00:00.000Z`),
        ).refreshBenchmarkSeries(series, { expectedSession: TODAY }),
      ).resolves.toMatchObject({ status: "REFRESHED", latestBar: TODAY });
    });

    it("saves an ordinary correction of a recent bar without treating it as a re-base", async () => {
      await bootstrap();
      const corrected = new HistoryProvider();
      corrected.correction = { date: TODAY, close: 999 };

      const result = await serviceWith(
        corrected,
        new Date(`${TODAY}T23:00:00.000Z`),
      ).refreshBenchmarkSeries(series, { expectedSession: TODAY });

      // The tail and the earliest bars: the earliest are unchanged, so the corrected bar is saved
      // as a correction, with no whole-history read and no new generation.
      expect(result).toMatchObject({
        status: "REFRESHED",
        basisGeneration: 0,
        providerReads: 2,
      });
      expect(corrected.requests).toHaveLength(2);
      expect(
        (await serviceWith(corrected).readBenchmarkSession(series, TODAY))
          ?.close,
      ).toBe(999);
      expect(basisEvents).toEqual([]);
    });

    it("checks the earliest bars before saving a changed older session, and replaces nothing when they did not move", async () => {
      await bootstrap();
      // One old-looking session in the tail window corrected on its own: the earliest bar is
      // unchanged, so it is a correction and not a re-base.
      const provider = new HistoryProvider();
      const oldestInTail = DATES.filter(
        (date) => date >= addDays(TODAY, -10),
      )[0]!;
      provider.correction = { date: oldestInTail, close: 12.34 };

      const result = await serviceWith(provider).refreshBenchmarkSeries(
        series,
        {
          expectedSession: TODAY,
        },
      );

      expect(result).toMatchObject({
        status: "REFRESHED",
        basisGeneration: 0,
        providerReads: 2,
      });
      await expect(store.getPriceBasisGeneration(series.id)).resolves.toBe(0);
      expect(
        await prisma.benchmarkPriceBasisEvent.count({
          where: { seriesId: series.id },
        }),
      ).toBe(0);
    });
  });

  describe("split re-base", () => {
    const EX_DATE = "2026-10-06";

    it("measures the split, replaces the whole history in one generation and republishes every year", async () => {
      await bootstrap(
        Object.assign(new HistoryProvider(), {
          publishedThrough: "2026-10-05",
        }),
      );
      const before = (await cache.getHead(series.id))!.head;

      const provider = new HistoryProvider();
      provider.rebaseAt = { date: EX_DATE, ratio: 4 };
      const result = await serviceWith(provider).refreshBenchmarkSeries(
        series,
        {
          expectedSession: TODAY,
        },
      );

      expect(result).toMatchObject({
        status: "REBASED",
        basisGeneration: 1,
        latestBar: TODAY,
      });
      // The tail, the earliest bars, then the whole history once.
      expect(result.providerReads).toBe(3);
      const events = await prisma.benchmarkPriceBasisEvent.findMany({
        where: { seriesId: series.id },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "MEASURED", generation: 1 });
      expect(Number(events[0]!.priceRatio)).toBeCloseTo(4, 3);

      // PostgreSQL and every Redis year are on the new basis; no year kept an old chunk.
      const head = (await cache.getHead(series.id))!.head;
      expect(head.basisGeneration).toBe(1);
      for (const [year, digest] of Object.entries(head.chunks)) {
        expect(digest).not.toBe(before.chunks[year]);
        const payload = await redis.get(
          `${namespace}:benchmark:${series.id}:daily-price:v1:${year}:${digest}`,
        );
        const decoded = decodeBenchmarkChunk(payload as string, {
          seriesId: series.id,
          year: Number(year),
        });
        expect(decoded.ok).toBe(true);
        for (const row of decoded.ok ? decoded.rows : []) {
          expect(row.close).toBeCloseTo(provider.close(row.date), 6);
        }
      }
      const full = await serviceWith(provider).readFullBenchmarkHistory(series);
      expect(full).toMatchObject({ basisGeneration: 1, source: "REDIS" });
      expect(full.rows).toHaveLength(DATES.length);
      expect(basisEvents.map((event) => event.outcome)).toEqual(["REPLACED"]);
    });

    it("removes the old basis from Redis before PostgreSQL commits the new one", async () => {
      await bootstrap(
        Object.assign(new HistoryProvider(), {
          publishedThrough: "2026-10-05",
        }),
      );
      let keysAtCommit: string[] | undefined;
      const watching = watched(cache, [], {
        fenceGeneration: async (original, ...args) => {
          const result = await original(...args);
          keysAtCommit = await redis.keys(
            `${namespace}:benchmark:${series.id}*`,
          );
          return result;
        },
      });
      const provider = new HistoryProvider();
      provider.rebaseAt = { date: EX_DATE, ratio: 4 };

      const result = await serviceWith(provider, NOW, {
        cache: watching,
      }).refreshBenchmarkSeries(series, { expectedSession: TODAY });

      expect(result.status).toBe("REBASED");
      // At the commit, only the raised fence was left: the head, the registry and every chunk of
      // the old basis were gone, so a reader that held the old head could only fall back to
      // PostgreSQL, which moves atomically.
      expect(keysAtCommit).toEqual([
        `${namespace}:benchmark:${series.id}:generation`,
      ]);
    });

    it("catches a re-base the provider folds in long after the ex-date, once the move has stood", async () => {
      // The split took effect weeks ago. The provider showed the post-split prices at once and
      // left the older bars as they were, so the move stood more than four sessions and was saved.
      const exDate = "2026-09-14";
      const asTraded = new HistoryProvider();
      const raw = asTraded.close.bind(asTraded);
      asTraded.close = (date: string) =>
        date >= exDate ? raw(date) / 4 : raw(date);
      asTraded.publishedThrough = "2026-10-08";
      await bootstrap(asTraded);

      // Now it rewrites the older bars: one continuous, split-adjusted history.
      const adjusted = new HistoryProvider();
      adjusted.rebaseAt = { date: exDate, ratio: 4 };
      const rebased = adjusted.close.bind(adjusted);
      adjusted.close = (date: string) =>
        date >= exDate ? rebased(date) / 4 : rebased(date);
      const result = await serviceWith(
        adjusted,
        new Date(`${TODAY}T22:00:00.000Z`),
      ).refreshBenchmarkSeries(series, { expectedSession: TODAY });

      // The tail lies wholly after the ex-date and reads exactly as stored. The session it adds is
      // what sends the loader to the earliest bars, which changed.
      expect(result).toMatchObject({
        status: "REBASED",
        basisGeneration: 1,
        latestBar: TODAY,
      });
      const full = await serviceWith(adjusted).readFullBenchmarkHistory(series);
      expect(full.rows).toHaveLength(DATES.length);
      for (const row of full.rows) {
        expect(row.close).toBeCloseTo(adjusted.close(row.date), 6);
      }
    });

    it("refuses a replacement that would drop stored sessions, and saves nothing beside the old basis", async () => {
      await bootstrap(
        Object.assign(new HistoryProvider(), {
          publishedThrough: "2026-10-05",
        }),
      );
      const provider = new HistoryProvider();
      provider.rebaseAt = { date: EX_DATE, ratio: 4 };
      // More than 1 % of the stored sessions missing from the re-read.
      for (const date of DATES.slice(0, 200)) {
        provider.dropped.add(date);
      }

      const result = await serviceWith(provider).refreshBenchmarkSeries(
        series,
        {
          expectedSession: TODAY,
        },
      );

      expect(result.status).toBe("REBASE_REFUSED");
      await expect(store.getPriceBasisGeneration(series.id)).resolves.toBe(0);
      await expect(store.getLatestDailyPriceDate(series.id)).resolves.toBe(
        "2026-10-05",
      );
      expect(basisEvents.map((event) => event.outcome)).toEqual([
        "REPLACEMENT_REFUSED",
      ]);
    });

    it("holds an ex-date bar the provider published before rewriting the older ones", async () => {
      await bootstrap(
        Object.assign(new HistoryProvider(), {
          publishedThrough: "2026-10-05",
        }),
      );
      // Two sessions ago the provider began showing the new basis — a quarter of the price — while
      // every older bar is still on the old one. Two sessions standing is fewer than the four the
      // hold waits for, so those bars are held back rather than saved as a 75 % fall.
      const recentExDate = "2026-10-08";
      const provider = new HistoryProvider();
      const close = provider.close.bind(provider);
      provider.close = (date: string) =>
        date >= recentExDate ? close(date) / 4 : close(date);

      const result = await serviceWith(provider).refreshBenchmarkSeries(
        series,
        {
          expectedSession: TODAY,
        },
      );

      expect(result.status).toBe("AWAITING_PUBLICATION");
      await expect(store.getLatestDailyPriceDate(series.id)).resolves.toBe(
        "2026-10-07",
      );
      expect(basisEvents.map((event) => event.outcome)).toEqual(["HELD"]);
      // The freshness watermark did not advance, so the held sessions are asked for again.
      const tail = await store.getDatasetState(
        series.id,
        "DAILY_PRICE",
        "provider-eod-full:recent-tail",
      );
      expect(tail?.latestDate).toBe(TODAY);
      expect(Date.parse(tail?.lastSuccessfulSyncAt ?? "")).toBeLessThan(
        Date.parse(`${TODAY}T21:00:00.001Z`),
      );

      // Once the provider has rewritten the older bars too, the next refresh measures the split
      // and replaces the history whole.
      // Rewritten the way a split-adjusted series is: every bar before the ex-date divided by the
      // ratio, and the bars from it on at the post-split price they already showed — so the new
      // history is continuous across the ex-date, and nothing about it is held.
      const rewritten = new HistoryProvider();
      rewritten.rebaseAt = { date: recentExDate, ratio: 4 };
      const rebased = rewritten.close.bind(rewritten);
      rewritten.close = (date: string) =>
        date >= recentExDate ? rebased(date) / 4 : rebased(date);
      const next = await serviceWith(
        rewritten,
        new Date(`${TODAY}T22:00:00.000Z`),
      ).refreshBenchmarkSeries(series, { expectedSession: TODAY });
      expect(next).toMatchObject({
        status: "REBASED",
        basisGeneration: 1,
        latestBar: TODAY,
      });
      // The replacement compared the newest bars with the provider's new-basis bar before them,
      // so nothing was held a second time.
      expect(basisEvents.map((event) => event.outcome)).toEqual([
        "HELD",
        "REPLACED",
      ]);
    });
  });

  /**
   * A publication must never make an older price generation visible once a newer one has
   * committed (`docs/decisions/etf-market-data-v1.md` §3, "Generation fence").
   *
   * Every interleaving here is forced, not raced: each process is a separate service with its own
   * coordinator — which is exactly what two processes are once the first one's hydration lock has
   * expired — and the steps that matter wait on explicit gates.
   */
  describe("generation fence", () => {
    const EX_DATE = "2026-10-06";

    /** A promise and the function that settles it. */
    function gate(): { opened: Promise<void>; open: () => void } {
      let open = (): void => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { opened, open };
    }

    /** A coordinator whose lease can be lost from the outside, as an expired Redlock lease is. */
    function losableLease(): {
      coordinator: LoadCoordinator;
      lose: () => void;
    } {
      let lost = false;
      return {
        lose: () => {
          lost = true;
        },
        coordinator: {
          run: (_resource, work) =>
            work({
              assertOwned: () => {
                if (lost) {
                  throw new Error("The hydration lease expired");
                }
              },
            }),
        },
      };
    }

    function rebasedProvider(): HistoryProvider {
      const provider = new HistoryProvider();
      provider.rebaseAt = { date: EX_DATE, ratio: 4 };
      return provider;
    }

    async function headGeneration(): Promise<number | undefined> {
      return (await cache.getHead(series.id))?.head.basisGeneration;
    }

    async function expectNewBasisEverywhere(provider: HistoryProvider) {
      await expect(store.getPriceBasisGeneration(series.id)).resolves.toBe(1);
      const full = await serviceWith(provider).readFullBenchmarkHistory(series);
      expect(full).toMatchObject({ basisGeneration: 1, source: "REDIS" });
      for (const row of full.rows) {
        expect(row.close).toBeCloseTo(provider.close(row.date), 6);
      }
    }

    it("refuses a stale publisher that read the old generation, after a replacer that lost its lease committed the new one", async () => {
      // The race as reported: B read its snapshot before A's replacement committed and publishes
      // after it, while A — whose lease expired around its commit — never publishes at all.
      await bootstrap(
        Object.assign(new HistoryProvider(), {
          publishedThrough: "2026-10-05",
        }),
      );
      await cache.invalidateManifest(series.id);

      const snapshotTaken = gate();
      const publishAllowed = gate();
      const staleReader = watched(store, [], {
        readPublicationSnapshot: async (original, ...args) => {
          const snapshot = await original(...args);
          snapshotTaken.open();
          return snapshot;
        },
      });
      const stalePublisher = watched(cache, [], {
        publish: async (original, ...args) => {
          await publishAllowed.opened;
          return original(...args);
        },
      });
      const b = serviceWith(new HistoryProvider(), NOW, {
        store: staleReader,
        cache: stalePublisher,
      }).ensureBenchmarkResident(series);
      await snapshotTaken.opened;

      const a = losableLease();
      const replacer = watched(store, [], {
        replaceDailyPriceHistory: async (original, ...args) => {
          const replaced = await original(...args);
          a.lose();
          return replaced;
        },
      });
      const provider = rebasedProvider();
      await expect(
        serviceWith(provider, NOW, {
          store: replacer,
          coordinator: a.coordinator,
        }).refreshBenchmarkSeries(series, { expectedSession: TODAY }),
      ).rejects.toThrow(/lease expired/);
      await expect(store.getPriceBasisGeneration(series.id)).resolves.toBe(1);

      publishAllowed.open();
      await b;

      // Never the old generation: B's gen-0 head was refused, and B published gen 1 instead.
      expect(await headGeneration()).toBe(1);
      expect(cacheEvents.map((event) => event.outcome)).toContain("FENCED");
      await expectNewBasisEverywhere(provider);
    });

    it("serves the old generation until the replacement commits, and drops it with the fence just before", async () => {
      await bootstrap(
        Object.assign(new HistoryProvider(), {
          publishedThrough: "2026-10-05",
        }),
      );
      const aboutToRaise = gate();
      const raiseAllowed = gate();
      const afterRaise: {
        head?: number | undefined;
        fence?: number | null;
        committed?: number;
      } = {};
      const pausing = watched(cache, [], {
        fenceGeneration: async (original, ...args) => {
          aboutToRaise.open();
          await raiseAllowed.opened;
          const result = await original(...args);
          afterRaise.head = await headGeneration();
          afterRaise.fence = await cache.getGenerationFence(series.id);
          afterRaise.committed = await store.getPriceBasisGeneration(series.id);
          return result;
        },
      });
      const provider = rebasedProvider();
      const a = serviceWith(provider, NOW, {
        cache: pausing,
      }).refreshBenchmarkSeries(series, { expectedSession: TODAY });
      await aboutToRaise.opened;

      // Every bar is written, uncommitted. PostgreSQL still holds generation 0, and so does the
      // head, which is correct: nothing newer has committed. A publisher on generation 0 still
      // commits, because the fence has not moved.
      await expect(store.getPriceBasisGeneration(series.id)).resolves.toBe(0);
      expect(await headGeneration()).toBe(0);
      const current = await cache.getHead(series.id);
      await expect(
        cache.publish({
          expected: current,
          head: { ...current!.head, materializedAt: NOW.toISOString() },
          stage: new Map(),
        }),
      ).resolves.toBe("COMMITTED");

      raiseAllowed.open();
      await expect(a).resolves.toMatchObject({
        status: "REBASED",
        basisGeneration: 1,
      });
      // The raise removed the generation-0 head and moved the fence to 1 while generation 1 was
      // still uncommitted: the old generation was gone from Redis before the new one existed.
      expect(afterRaise).toEqual({ head: undefined, fence: 1, committed: 0 });
      expect(await headGeneration()).toBe(1);
      await expectNewBasisEverywhere(provider);
    });

    it("makes a publisher that meets a pending replacement wait for its commit, then publish the new generation", async () => {
      await bootstrap(
        Object.assign(new HistoryProvider(), {
          publishedThrough: "2026-10-05",
        }),
      );
      const raised = gate();
      const commitAllowed = gate();
      const waiting = gate();
      const pausing = watched(cache, [], {
        fenceGeneration: async (original, ...args) => {
          const result = await original(...args);
          raised.open();
          await commitAllowed.opened;
          return result;
        },
      });
      const provider = rebasedProvider();
      const a = serviceWith(provider, NOW, {
        cache: pausing,
      }).refreshBenchmarkSeries(series, { expectedSession: TODAY });
      await raised.opened;

      // B finds no head (A's fence removed it) and reads the old generation from PostgreSQL, which
      // A has not committed yet. It must not publish that: it waits on the series write lock.
      const lockWatcher = watched(store, [], {
        withPriceBasisLock: async (original, ...args) => {
          waiting.open();
          return original(...args);
        },
      });
      const b = serviceWith(new HistoryProvider(), NOW, {
        store: lockWatcher,
      }).ensureBenchmarkResident(series);
      await waiting.opened;
      expect(await headGeneration()).toBeUndefined();

      commitAllowed.open();
      await expect(a).resolves.toMatchObject({ status: "REBASED" });
      await expect(b).resolves.toMatchObject({ basisGeneration: 1 });
      expect(await headGeneration()).toBe(1);
      await expectNewBasisEverywhere(provider);
    });

    it("answers a reader in one generation while a replacement holds the lock, and lets it publish nothing", async () => {
      const before = Object.assign(new HistoryProvider(), {
        publishedThrough: "2026-10-05",
      });
      await bootstrap(before);
      const raised = gate();
      const commitAllowed = gate();
      const pausing = watched(cache, [], {
        fenceGeneration: async (original, ...args) => {
          const result = await original(...args);
          raised.open();
          await commitAllowed.opened;
          return result;
        },
      });
      const provider = rebasedProvider();
      // The replacement holds the real hydration lock for as long as it runs.
      const a = serviceWith(provider, NOW, {
        cache: pausing,
        coordinator: redlock(),
      }).refreshBenchmarkSeries(series, { expectedSession: TODAY });
      await raised.opened;
      try {
        // Its fence has removed the generation-0 head; generation 1 is written and uncommitted.
        expect(await headGeneration()).toBeUndefined();
        cacheEvents = [];

        const startedAt = Date.now();
        const during = await serviceWith(new HistoryProvider(), NOW, {
          coordinator: redlock(),
          options: { residentReadLockWaitMs: 200 },
        }).readFullBenchmarkHistory(series);

        // The reader could not have the lock, so it was told what PostgreSQL has committed: the
        // whole history on the old basis, and nothing of the new one beside it.
        expect(Date.now() - startedAt).toBeLessThan(3_000);
        expect(during).toMatchObject({
          source: "POSTGRESQL",
          basisGeneration: 0,
        });
        expect(during.rows.length).toBeGreaterThan(2_000);
        for (const row of during.rows) {
          expect(row.close).toBeCloseTo(before.close(row.date), 6);
        }
        // And it published nothing: no head of the old generation came back, and the fence the
        // replacement raised is where the replacement left it.
        expect(await headGeneration()).toBeUndefined();
        await expect(cache.getGenerationFence(series.id)).resolves.toBe(1);
        expect(cacheEvents.map((event) => event.outcome)).toEqual(["FAILED"]);
      } finally {
        commitAllowed.open();
      }

      await expect(a).resolves.toMatchObject({
        status: "REBASED",
        basisGeneration: 1,
      });
      await expectNewBasisEverywhere(provider);
    });

    it("recovers residency when a replacement aborts after raising its fence", async () => {
      await bootstrap(
        Object.assign(new HistoryProvider(), {
          publishedThrough: "2026-10-05",
        }),
      );
      // A raises the fence to generation 1, then crashes before committing: PostgreSQL rolls the
      // whole replacement back and stays at generation 0.
      const crashing = watched(cache, [], {
        fenceGeneration: async (original, ...args) => {
          await original(...args);
          throw new Error("process killed");
        },
      });
      await expect(
        serviceWith(rebasedProvider(), NOW, {
          cache: crashing,
        }).refreshBenchmarkSeries(series, { expectedSession: TODAY }),
      ).rejects.toThrow(/process killed/);
      await expect(store.getPriceBasisGeneration(series.id)).resolves.toBe(0);
      expect(await headGeneration()).toBeUndefined();

      // The next publisher finds a fence ahead of PostgreSQL, re-establishes it under the series
      // lock from what PostgreSQL committed, and publishes generation 0 again.
      const provider = new HistoryProvider();
      await expect(
        serviceWith(provider).ensureBenchmarkResident(series),
      ).resolves.toMatchObject({ status: "REPUBLISHED", basisGeneration: 0 });
      expect(await headGeneration()).toBe(0);
      expect(provider.requests).toEqual([]);
    });

    it("refuses an ordinary save read on the old generation, once a replacement has committed a new one", async () => {
      await bootstrap(
        Object.assign(new HistoryProvider(), {
          publishedThrough: "2026-10-05",
        }),
      );
      // A's tail read is answered on the old basis. Before A gets to save it, the provider rewrites
      // the history and another process — B, holding its own lease — replaces it as generation 1.
      const rewritten = rebasedProvider();
      const stalled = new HistoryProvider();
      const answer = stalled.getBenchmarkDailyPrices.bind(stalled);
      let rewrittenSince = false;
      stalled.getBenchmarkDailyPrices = async (symbol, seriesId, range) => {
        const rows = await answer(symbol, seriesId, range);
        if (!rewrittenSince) {
          rewrittenSince = true;
          await expect(
            serviceWith(rewritten).refreshBenchmarkSeries(series, {
              expectedSession: TODAY,
            }),
          ).resolves.toMatchObject({ status: "REBASED", basisGeneration: 1 });
          // From now on A's provider answers on the new basis too, so A's earliest-bars check
          // finds nothing changed: only the generation tells A that its tail is stale.
          stalled.rebaseAt = { date: EX_DATE, ratio: 4 };
        }
        return rows;
      };

      await expect(
        serviceWith(stalled).refreshBenchmarkSeries(series, {
          expectedSession: TODAY,
        }),
      ).rejects.toBeInstanceOf(PriceBasisConflictError);

      // A's old-basis tail never landed: PostgreSQL is wholly on generation 1's basis.
      await expect(store.getPriceBasisGeneration(series.id)).resolves.toBe(1);
      const stored = await store.getDailyPrices(series.id, {
        from: "2015-06-01",
        to: TODAY,
      });
      expect(stored).toHaveLength(DATES.length);
      for (const row of stored) {
        expect(row.close).toBeCloseTo(rewritten.close(row.date), 6);
      }
    });

    it("re-establishes the fence from PostgreSQL after Redis loses it, and never publishes without one", async () => {
      await bootstrap();
      await clearRedis();
      await expect(cache.getGenerationFence(series.id)).resolves.toBeNull();

      // Without a fence, nothing commits — not even a head on the right generation.
      const head = {
        seriesId: series.id,
        chunkEncodingVersion: BENCHMARK_CHUNK_ENCODING_VERSION,
        priceDatasetVersion: BENCHMARK_PRICE_DATASET_VERSION,
        basisGeneration: 0,
        residentRanges: [{ from: "2015-06-01", to: TODAY }],
        chunks: {},
        bars: 0,
        materializedAt: NOW.toISOString(),
      };
      await expect(
        cache.publish({ expected: null, head, stage: new Map() }),
      ).resolves.toBe("FENCED");

      const provider = new HistoryProvider();
      await expect(
        serviceWith(provider).ensureBenchmarkResident(series),
      ).resolves.toMatchObject({ status: "REPUBLISHED" });
      await expect(cache.getGenerationFence(series.id)).resolves.toBe(0);
      expect(await headGeneration()).toBe(0);
      expect(provider.requests).toEqual([]);
    });
  });
});
