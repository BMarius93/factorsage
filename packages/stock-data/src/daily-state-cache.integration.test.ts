import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import {
  FUNDAMENTAL_METRIC_FIELDS,
  type DailyDerivedState,
  type DailyPrice,
  type DateRange,
  type FinancialStatementCadence,
  type FinancialStatementType,
  type Security,
} from "@intrinsic/domain";
import type { FmpStockProviderPort } from "@intrinsic/fmp";
import {
  fundamentalMetricOperand,
  marginOfSafetyOperand,
  PRICE_OPERAND,
  readOperand,
  relativeVolumeOperand,
  seriesOperand,
  type EvaluationFrame,
} from "@intrinsic/strategy";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  dailyStateChunkKey,
  RedisStockDataCache,
  type StockDataCacheObserver,
  type StockManifest,
} from "./cache.js";
import { RedlockLoadCoordinator } from "./coordination.js";
import {
  DAILY_STATE_CHUNK_FIELDS,
  DAILY_STATE_ENCODING_VERSION,
  decodeDailyStateChunk,
} from "./daily-state-chunk.js";
import { addDays, subtractYears } from "./dates.js";
import { projectEvaluationFrame } from "./evaluation-frame.js";
import { weekdays } from "./fundamental-metrics.test-helper.js";
import {
  monitorWindowObservations,
  requiredDailySeries,
} from "./monitor-frame.js";
import { PrismaStockDataStore } from "./prisma-store.js";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
} from "./redis-client.js";
import {
  CanonicalStockDataService,
  fundamentalsDatasetOperations,
  priceRetentionYears,
  type ProviderRequestEvent,
} from "./service.js";
import { startOfIsoWeek } from "./weekly.js";

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "The columnar daily-state cache suite requires TEST_REDIS_URL or REDIS_URL in CI: it is the " +
      "proof that the Redis encoding and PostgreSQL agree on every stored field.",
  );
}
const describeInfrastructure = redisUrl ? describe : describe.skip;

const NOW = new Date("2026-08-24T12:00:00.000Z");
const TODAY = "2026-08-24";
const SYNCED_AT = NOW.toISOString();
const PRODUCT_YEARS = 30;
const FIRST_SESSION = "2019-12-02";
/** Market holidays, including both New Year's Days and a Christmas Eve half-day closure. */
const HOLIDAYS = [
  "2019-12-25",
  "2020-01-01",
  "2020-07-03",
  "2020-12-25",
  "2021-01-01",
  "2021-07-05",
  "2021-12-24",
  "2022-07-04",
  "2022-12-26",
  "2023-01-02",
  "2023-07-04",
  "2023-12-25",
  "2024-01-01",
  "2024-07-04",
  "2024-12-25",
  "2025-01-01",
  "2025-07-04",
  "2025-12-25",
  "2026-01-01",
  "2026-07-03",
];
/** Sessions per designed statement event, so events and gaps straddle every year boundary. */
const EVENT_SESSIONS = 61;

const round8 = (value: number) => Number(value.toFixed(8));

/**
 * One designed derived row per session, written straight to PostgreSQL: every family of the
 * daily derived state, each with its own warm-up gap, carried-forward stretches, exact zeros,
 * negatives, invalidation gaps that cross year boundaries, a currency-conflict stretch with no
 * intrinsic state at all, and model provenance that moves without its value. The values are
 * fixtures, not engine output — this suite is about the cache agreeing with the store, so it needs
 * every shape a stored row can have, not the methodology that produces them.
 */
function designedRows(securityId: string, dates: readonly string[]) {
  const dailyPeriods = [20, 50, 100, 200, 20, 50, 200];
  const dailyFields = [
    "sma20d",
    "sma50d",
    "sma100d",
    "sma200d",
    "ema20d",
    "ema50d",
    "ema200d",
  ] as const;
  const weeklyFields = [
    "sma20w",
    "sma50w",
    "sma100w",
    "sma200w",
    "ema20w",
    "ema50w",
    "ema200w",
  ] as const;
  const weekOrdinal = (weekStart: string) =>
    Math.round(Date.parse(`${weekStart}T00:00:00.000Z`) / (7 * 86_400_000));
  const firstWeek = weekOrdinal(startOfIsoWeek(dates[0] as string));

  return dates.map((date, index): DailyDerivedState => {
    const row: DailyDerivedState = { securityId, date };
    const writable = row as Record<string, unknown>;
    dailyFields.forEach((field, k) => {
      if (index >= (dailyPeriods[k] as number) - 1) {
        writable[field] = round8(
          100 + k * 10 + index * 0.01234567 + ((index * 7919) % 1000) / 1e5,
        );
      }
    });
    if (index >= 5) {
      const weekStart = startOfIsoWeek(addDays(date, -7));
      row.weeklySourceWeekStart = weekStart;
      const weeks = weekOrdinal(weekStart) - firstWeek;
      weeklyFields.forEach((field, k) => {
        if (weeks >= (dailyPeriods[k] as number) / 4) {
          writable[field] = round8(300 + k * 10 + weeks * 0.37);
        }
      });
    }
    if (index >= 7) row.rsi7d = (index * 13) % 101;
    if (index >= 14) {
      row.rsi14d =
        index % 90 < 30 ? 50 : round8(((index * 17) % 100) + 0.12345678);
    }
    if (index >= 21) row.rsi21d = round8(((index * 29) % 10_000) / 100);
    if (index >= 10) row.rvol10 = ((index * 7) % 5) * 0.5;
    if (index >= 20 && !(index % 200 >= 100 && index % 200 < 110)) {
      row.rvol20 = round8(0.5 + (index % 37) * 0.0271828);
    }
    if (index >= 50) row.rvol50 = round8(1 + (index % 11) * 0.0314159);

    const event = Math.floor(index / EVENT_SESSIONS);
    const eventDate = dates[event * EVENT_SESSIONS] as string;
    if (event > 0) {
      FUNDAMENTAL_METRIC_FIELDS.forEach((field, m) => {
        if ((event + m) % 9 === 4) {
          return;
        }
        writable[field] =
          (event * (m + 1)) % 13 === 6
            ? 0
            : round8(
                ((event + m) % 3 === 0 ? -1 : 1) *
                  (m * 1.1 + event * 0.77 + 0.123),
              );
      });
    }
    if (event > 0 && event % 11 !== 5) {
      const dcf = round8(150 + event * 1.5);
      const residualIncome = round8(140 + event * 1.25);
      // Graham's value moves every second event, its provenance every event.
      const graham = round8(120 + Math.floor(event / 2));
      const ddm = event % 4 === 2 ? undefined : round8(90 + event * 0.5);
      row.intrinsicValues = {
        DCF_FCFF: dcf,
        RESIDUAL_INCOME: residualIncome,
        ...(ddm === undefined ? {} : { DDM: ddm }),
        GRAHAM: graham,
      };
      row.intrinsicValueBlends = {
        BALANCED: round8(dcf * 0.5 + residualIncome * 0.3 + graham * 0.2),
        CONSERVATIVE: round8(dcf * 0.3 + residualIncome * 0.3 + graham * 0.4),
        ...(ddm === undefined
          ? {}
          : {
              DIVIDEND: round8(ddm * 0.5 + dcf * 0.25 + residualIncome * 0.25),
            }),
      };
      row.dcfFcffSourceAsOf = `${eventDate}T21:00:00.000Z`;
      row.residualIncomeSourceAsOf = `${addDays(eventDate, -1)}T21:00:00.000Z`;
      if (ddm !== undefined) {
        row.ddmSourceAsOf = `${eventDate}T20:30:00.000Z`;
      }
      row.grahamSourceAsOf = `${eventDate}T00:00:00.000Z`;
      row.intrinsicCurrency = "USD";
    }
    return row;
  });
}

/** Records every provider call. Nothing in this suite may make one. */
class RefusingProvider implements FmpStockProviderPort {
  readonly calls: string[] = [];
  async getProfile(symbol: string) {
    this.calls.push(`profile:${symbol}`);
    return null;
  }
  async getDailyPrices(_symbol: string, _securityId: string, range: DateRange) {
    this.calls.push(`prices:${range.from}:${range.to}`);
    return [];
  }
  async getFinancialStatements(
    _symbol: string,
    _securityId: string,
    statementType: FinancialStatementType,
    cadence: FinancialStatementCadence,
  ) {
    this.calls.push(`statements:${statementType}:${cadence}`);
    return [];
  }
}

type Hooks = {
  /** Called before each chunk write; throwing fails that write. */
  beforeChunkWrite?: (key: string) => void;
  /** Rewrites an MGET reply of daily-state chunks; throwing fails the read. */
  onChunkRead?: (
    keys: string[],
    payloads: (string | null)[],
  ) => (string | null)[];
};

/** The real Redis client, with seams for the failures a disposable cache must survive. */
class InstrumentedCacheClient extends IoredisCacheClient {
  readonly chunkWrites: string[] = [];
  constructor(
    redis: ConstructorParameters<typeof IoredisCacheClient>[0],
    private readonly hooks: Hooks = {},
  ) {
    super(redis);
  }

  override async mget(...keys: string[]) {
    const payloads = await super.mget(...keys);
    return keys.some((key) => key.includes(":daily-state:")) &&
      this.hooks.onChunkRead
      ? this.hooks.onChunkRead(keys, payloads)
      : payloads;
  }

  override async eval(script: string, numberOfKeys: number, ...args: string[]) {
    const key = args[0] ?? "";
    if (script.includes("set-registered") && key.includes(":daily-state:")) {
      this.hooks.beforeChunkWrite?.(key);
      this.chunkWrites.push(key);
    }
    return super.eval(script, numberOfKeys, ...args);
  }
}

describeInfrastructure("columnar daily-state chunks against PostgreSQL", () => {
  const suffix = randomUUID();
  const namespace = `stock-data:v2:test:columnar:${suffix}`;
  const symbol = `C${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(
    redisUrl ?? "redis://localhost:6379",
  );
  const clients: ReturnType<typeof createStockDataRedisClient>[] = [redis];
  const store = new PrismaStockDataStore(prisma);
  const provider = new RefusingProvider();
  const requests: ProviderRequestEvent[] = [];
  const unreadable: Parameters<
    NonNullable<StockDataCacheObserver["onUnreadableChunk"]>
  >[0][] = [];
  const range = { from: FIRST_SESSION, to: TODAY };
  let security: Security;
  let prices: DailyPrice[];
  let persisted: DailyDerivedState[];
  let years: number[];
  /** The chunks the first publication wrote, year by year: the bytes every republish must match. */
  let published: Map<number, string>;

  function cacheOver(
    client = new IoredisCacheClient(redis),
    options: { namespace?: string; maxResidentStocks?: number } = {},
  ) {
    return new RedisStockDataCache(
      client,
      options.maxResidentStocks ?? 10,
      options.namespace ?? namespace,
      undefined,
      { onUnreadableChunk: (chunk) => unreadable.push(chunk) },
    );
  }

  function serviceOver(
    cache: RedisStockDataCache = cacheOver(),
    lockClient = redis,
  ) {
    return new CanonicalStockDataService(
      store,
      provider,
      cache,
      new RedlockLoadCoordinator(lockClient, {
        lockDurationMs: 30_000,
        lockWaitMs: 30_000,
      }),
      {
        productHistoryYears: PRODUCT_YEARS,
        now: () => NOW,
        onProviderRequest: (event) => requests.push(event),
      },
    );
  }

  async function namespaceKeys(pattern = `${namespace}:*`): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        1_000,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");
    return keys.sort();
  }

  async function flushNamespace(pattern = `${namespace}:*`) {
    const keys = await namespaceKeys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  async function chunkBytes(
    ns = namespace,
  ): Promise<Map<number, string | null>> {
    const payloads = await redis.mget(
      ...years.map((year) => dailyStateChunkKey(ns, security.id, year)),
    );
    return new Map(years.map((year, index) => [year, payloads[index] ?? null]));
  }

  /** Row count and a digest of every stored derived row: what "PostgreSQL unchanged" means. */
  async function persistedFingerprint() {
    const [row] = await prisma.$queryRawUnsafe<
      { rows: number; digest: string }[]
    >(
      `SELECT count(*)::int AS rows, md5(string_agg(t::text, '|' ORDER BY t."date")) AS digest
         FROM "DailyDerivedState" t WHERE t."securityId" = $1`,
      security.id,
    );
    return row;
  }

  function rebuildSpy() {
    return vi.spyOn(
      CanonicalStockDataService.prototype as unknown as {
        rebuildDailyDerivedState: () => Promise<unknown>;
      },
      "rebuildDailyDerivedState",
    );
  }

  /** Every read below must be answered from durable state: no provider, no recalculation. */
  function expectNoProviderAndNoRebuild(rebuilds: unknown, writes: unknown) {
    expect(provider.calls).toEqual([]);
    expect(requests).toEqual([]);
    expect(rebuilds).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  }

  beforeAll(async () => {
    const created = await prisma.security.create({
      data: {
        providerSymbol: symbol,
        symbol,
        name: "Columnar Daily State Corp",
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    const retentionStart = subtractYears(
      TODAY,
      priceRetentionYears(PRODUCT_YEARS),
    );
    prices = weekdays(FIRST_SESSION, TODAY, HOLIDAYS).map((date, index) => ({
      securityId: created.id,
      date,
      open: 100,
      high: 110,
      low: 90,
      close: round8(100 + (index % 17) * 0.5 + index * 0.02),
      volume: 1_000 + (index % 7) * 100,
    }));
    await store.saveDailyPriceSync({
      securityId: created.id,
      prices,
      successfulCoverage: [{ from: retentionStart, to: TODAY }],
      syncedAt: SYNCED_AT,
      tailDate: TODAY,
      freshThrough: TODAY,
    });
    // Verified under the current loader, so no first verification re-reads the history.
    await store.createPriceBasis({
      securityId: created.id,
      verifiedAt: SYNCED_AT,
    });
    for (const operation of fundamentalsDatasetOperations(PRODUCT_YEARS)) {
      await store.upsertDatasetState({
        securityId: created.id,
        dataset: operation.dataset,
        variant: operation.variant,
        syncedAt: SYNCED_AT,
      });
    }
    await store.upsertDatasetState({
      securityId: created.id,
      dataset: "SECURITY_PROFILE",
      variant: "",
      syncedAt: SYNCED_AT,
    });
    await store.saveDailyDerivedState({
      securityId: created.id,
      rows: designedRows(
        created.id,
        prices.map((price) => price.date),
      ),
      weeklyPrices: [],
      successfulCoverage: { from: retentionStart, to: TODAY },
      syncedAt: SYNCED_AT,
    });
    persisted = await store.getDailyDerivedState(created.id, range);

    // The first publication: a cold read through the real service.
    const service = serviceOver();
    expect(await service.getDailyDerivedState(symbol, range)).toStrictEqual(
      persisted,
    );
    security = (await service.findSecuritiesByIds([created.id]))[0] as Security;
    const manifest = (await cacheOver().getManifest(
      created.id,
    )) as StockManifest;
    years = [];
    for (
      let year = Number((manifest.coverageStart as string).slice(0, 4));
      year <= Number((manifest.coverageEnd as string).slice(0, 4));
      year += 1
    ) {
      years.push(year);
    }
    published = new Map(
      [...(await chunkBytes())].map(([year, payload]) => [
        year,
        payload as string,
      ]),
    );
    expect(provider.calls).toEqual([]);
    expect(requests).toEqual([]);
  }, 60_000);

  afterAll(async () => {
    await flushNamespace();
    await flushNamespace(`${namespace}-*`);
    if (security) {
      await prisma.security.deleteMany({ where: { id: security.id } });
    }
    for (const client of clients) {
      client.disconnect();
    }
    await prisma.$disconnect();
  });

  it("stores every field family, present and absent, in the designed history", () => {
    // The parity below is only as strong as the shapes it covers.
    expect(persisted.length).toBeGreaterThan(1_700);
    for (const path of DAILY_STATE_CHUNK_FIELDS) {
      const [field, key] = path.split(".") as [string, string | undefined];
      const present = persisted.filter((row) => {
        const holder = (row as Record<string, unknown>)[field];
        return key === undefined
          ? holder !== undefined
          : (holder as Record<string, unknown> | undefined)?.[key] !==
              undefined;
      }).length;
      expect(present, `${path} present`).toBeGreaterThan(0);
      expect(present, `${path} absent`).toBeLessThan(persisted.length);
    }
    expect(persisted.some((row) => row.roicTtm === 0)).toBe(true);
    expect(persisted.some((row) => (row.netDebtToEbitdaTtm ?? 0) < 0)).toBe(
      true,
    );
    expect(persisted.some((row) => row.rvol10 === 0)).toBe(true);
    expect(persisted.some((row) => row.rsi7d === 0)).toBe(true);
    expect(persisted.some((row) => row.rsi7d === 100)).toBe(true);
    // 2024-02-29 is a Thursday session; 2020-02-29 fell on a Saturday.
    expect(persisted.map((row) => row.date)).toContain("2024-02-29");
  });

  it("publishes one versioned chunk per year that decodes to exactly the PostgreSQL rows, byte for byte", async () => {
    const registered = await redis.smembers(
      `${namespace}:security:${security.id}:keys`,
    );
    const chunkKeys = registered.filter((key) => key.includes(":daily-state:"));
    expect(chunkKeys.sort()).toEqual(
      years
        .map((year) => dailyStateChunkKey(namespace, security.id, year))
        .sort(),
    );
    expect(
      chunkKeys.every((key) =>
        key.includes(`:daily-state:v${DAILY_STATE_ENCODING_VERSION}:`),
      ),
    ).toBe(true);

    for (const year of years) {
      const payload = published.get(year) as string;
      expect(payload, String(year)).not.toContain("null");
      const decoded = decodeDailyStateChunk(payload, {
        securityId: security.id,
        year,
      });
      expect(decoded.ok, String(year)).toBe(true);
      const stored = persisted.filter((row) => row.date.startsWith(`${year}-`));
      const rows = decoded.ok ? decoded.rows : [];
      expect(rows, String(year)).toStrictEqual(stored);
      expect(JSON.stringify(rows), String(year)).toBe(JSON.stringify(stored));
    }
    const cached = await cacheOver().readDailyDerivedState(security.id, range);
    expect(cached).toStrictEqual(persisted);
    expect(JSON.stringify(cached)).toBe(JSON.stringify(persisted));
  });

  it("serves every year boundary, leap day and partial window exactly as PostgreSQL does", async () => {
    const service = serviceOver();
    const windows = [
      ...years
        .filter((year) => year >= 2020)
        .map((year) => ({ from: `${year - 1}-12-20`, to: `${year}-01-12` })),
      { from: "2023-01-01", to: "2025-12-31" },
      { from: "2020-02-28", to: "2020-03-02" },
      { from: "2024-02-29", to: "2024-02-29" },
      { from: "2021-12-31", to: "2021-12-31" },
      { from: "2022-01-03", to: "2022-01-03" },
      { from: "2025-12-27", to: "2025-12-28" },
    ];
    for (const window of windows) {
      const expected = await store.getDailyDerivedState(security.id, window);
      const served = await service.getDailyDerivedState(symbol, window);
      expect(served, `${window.from}..${window.to}`).toStrictEqual(expected);
      expect(new Set(served.map((row) => row.date)).size).toBe(served.length);
    }
    expect(provider.calls).toEqual([]);
  });

  it("costs latency only after a flush: the same rows and bytes, rebuilt from PostgreSQL alone", async () => {
    const before = await persistedFingerprint();
    await flushNamespace();
    expect(await namespaceKeys()).toEqual([]);
    const rebuilds = rebuildSpy();
    const writes = vi.spyOn(store, "saveDailyDerivedState");
    try {
      const served = await serviceOver().getDailyDerivedState(symbol, range);
      expect(JSON.stringify(served)).toBe(JSON.stringify(persisted));
      expectNoProviderAndNoRebuild(rebuilds, writes);
    } finally {
      rebuilds.mockRestore();
      writes.mockRestore();
    }
    expect(await chunkBytes()).toEqual(published);
    expect(await persistedFingerprint()).toEqual(before);
  });

  it("removes every chunk on an explicit eviction, and republishes the same bytes on the next read", async () => {
    const cache = cacheOver();
    await cache.evict(security.id);
    expect(
      await namespaceKeys(`${namespace}:security:${security.id}:*`),
    ).toEqual([]);
    expect(await cache.hasResidentStock(security.id)).toBe(false);
    await expect(
      cache.readDailyDerivedState(security.id, range),
    ).resolves.toBeNull();

    const rebuilds = rebuildSpy();
    const writes = vi.spyOn(store, "saveDailyDerivedState");
    try {
      const served = await serviceOver(cache).getDailyDerivedState(
        symbol,
        range,
      );
      expect(served).toStrictEqual(persisted);
      expectNoProviderAndNoRebuild(rebuilds, writes);
    } finally {
      rebuilds.mockRestore();
      writes.mockRestore();
    }
    expect(await chunkBytes()).toEqual(published);
  });

  it("evicts the least recently used security whole, then reconstructs it identically", async () => {
    const lruNamespace = `${namespace}-lru`;
    const lru = cacheOver(new IoredisCacheClient(redis), {
      namespace: lruNamespace,
      maxResidentStocks: 1,
    });
    const service = serviceOver(lru);
    expect(await service.getDailyDerivedState(symbol, range)).toStrictEqual(
      persisted,
    );
    const ownKeys = () =>
      namespaceKeys(`${lruNamespace}:security:${security.id}:*`);
    expect(
      (await ownKeys()).filter((key) => key.includes(":daily-state:")),
    ).toHaveLength(years.length);

    // Publishing a second resident evicts the first: every registered key goes, no orphan stays.
    await lru.touch(security.id);
    const other = "columnar-other-resident";
    await lru.writeDailyDerivedStateYears(
      other,
      [{ securityId: other, date: "2026-08-24", sma20d: 1 }],
      [2026],
    );
    await lru.setManifest({
      securityId: other,
      status: "READY",
      productHistoryYears: PRODUCT_YEARS,
      priceRetentionYears: priceRetentionYears(PRODUCT_YEARS),
      coverageStart: "2026-01-01",
      coverageEnd: TODAY,
      priceDatasetVersion: 1,
      financialStatementVersion: 1,
      derivedStateRevision: 7,
      dailyStateEncodingVersion: DAILY_STATE_ENCODING_VERSION,
    });
    expect(await lru.hasResidentStock(other)).toBe(true);
    expect(await lru.hasResidentStock(security.id)).toBe(false);
    expect(await ownKeys()).toEqual([]);

    const rebuilds = rebuildSpy();
    const writes = vi.spyOn(store, "saveDailyDerivedState");
    try {
      expect(await service.getDailyDerivedState(symbol, range)).toStrictEqual(
        persisted,
      );
      expectNoProviderAndNoRebuild(rebuilds, writes);
    } finally {
      rebuilds.mockRestore();
      writes.mockRestore();
    }
    expect(await chunkBytes(lruNamespace)).toEqual(published);
    expect(await lru.hasResidentStock(other)).toBe(false);
  });

  describe("a partly lost or damaged cache", () => {
    const damaged = 2022;
    const key = () => dailyStateChunkKey(namespace, security.id, damaged);

    async function expectRepaired() {
      const rebuilds = rebuildSpy();
      const writes = vi.spyOn(store, "saveDailyDerivedState");
      try {
        const served = await serviceOver().getDailyDerivedState(symbol, range);
        expect(JSON.stringify(served)).toBe(JSON.stringify(persisted));
        expectNoProviderAndNoRebuild(rebuilds, writes);
      } finally {
        rebuilds.mockRestore();
        writes.mockRestore();
      }
      expect(await chunkBytes()).toEqual(published);
    }

    it("rebuilds a missing year rather than serving a shorter history", async () => {
      await redis.del(key());
      await expect(
        cacheOver().readDailyDerivedState(security.id, range),
      ).resolves.toBeNull();
      await expectRepaired();
    });

    it.each([
      [
        "corrupt bytes",
        () => `${published.get(damaged)?.slice(0, 200)}`,
        "not JSON",
      ],
      [
        "a version-1 row array",
        () =>
          JSON.stringify(
            persisted.filter((row) => row.date.startsWith(`${damaged}-`)),
          ),
        "version-1 chunk is an array",
      ],
      [
        "a date axis one session short of its columns",
        () => {
          const chunk = JSON.parse(published.get(damaged) as string) as {
            dates: string[];
          };
          chunk.dates = chunk.dates.slice(1);
          return JSON.stringify(chunk);
        },
        "more cells than the",
      ],
    ])(
      "reports %s as unreadable and rebuilds that year from PostgreSQL",
      async (_name, damage, reason) => {
        unreadable.length = 0;
        await redis.set(key(), damage());
        await expect(
          cacheOver().readDailyDerivedState(security.id, range),
        ).resolves.toBeNull();
        expect(unreadable).toEqual([
          expect.objectContaining({
            securityId: security.id,
            year: damaged,
            key: key(),
          }),
        ]);
        expect(unreadable[0]?.reason).toContain(reason);
        await expectRepaired();
      },
    );
  });

  it("rebuilds an older deployment's version-1 cache from PostgreSQL before reading it", async () => {
    // Exactly what the row-oriented cache left: `daily-state:<year>` row arrays, registered, under
    // a READY manifest that is current in every respect it knew about.
    const registry = `${namespace}:security:${security.id}:keys`;
    const legacyKeys: string[] = [];
    for (const year of years) {
      const legacyKey = `${namespace}:security:${security.id}:daily-state:${year}`;
      const current = dailyStateChunkKey(namespace, security.id, year);
      await redis.set(
        legacyKey,
        JSON.stringify(
          persisted.filter((row) => row.date.startsWith(`${year}-`)),
        ),
      );
      await redis.del(current);
      await redis.srem(registry, current);
      await redis.sadd(registry, legacyKey);
      legacyKeys.push(legacyKey);
    }
    const manifestKey = `${namespace}:security:${security.id}:manifest`;
    const legacyManifest = JSON.parse(
      (await redis.get(manifestKey)) as string,
    ) as Record<string, unknown>;
    delete legacyManifest.dailyStateEncodingVersion;
    await redis.set(manifestKey, JSON.stringify(legacyManifest));

    const rebuilds = rebuildSpy();
    const writes = vi.spyOn(store, "saveDailyDerivedState");
    try {
      const served = await serviceOver().getDailyDerivedState(symbol, range);
      expect(JSON.stringify(served)).toBe(JSON.stringify(persisted));
      expectNoProviderAndNoRebuild(rebuilds, writes);
    } finally {
      rebuilds.mockRestore();
      writes.mockRestore();
    }
    // The old chunks were deleted through the registry, not orphaned; the new ones are the same
    // bytes a cold publication writes.
    expect(await redis.exists(...legacyKeys)).toBe(0);
    expect(
      (await namespaceKeys()).filter((candidate) =>
        /:daily-state:\d{4}$/.test(candidate),
      ),
    ).toEqual([]);
    expect(await chunkBytes()).toEqual(published);
    const manifest = JSON.parse(
      (await redis.get(manifestKey)) as string,
    ) as StockManifest;
    expect(manifest.dailyStateEncodingVersion).toBe(
      DAILY_STATE_ENCODING_VERSION,
    );
    expect(manifest.status).toBe("READY");
  });

  it("recovers a backtest window read (no hydration check) that lands on a version-1 cache", async () => {
    const window = { from: "2022-01-01", to: "2022-12-31" };
    const operands = [PRICE_OPERAND, fundamentalMetricOperand("ROIC_TTM")];
    const manifestKey = `${namespace}:security:${security.id}:manifest`;
    const manifest = JSON.parse(
      (await redis.get(manifestKey)) as string,
    ) as Record<string, unknown>;
    delete manifest.dailyStateEncodingVersion;
    await redis.set(manifestKey, JSON.stringify(manifest));

    const frame = await serviceOver().readDailyEvaluationFrame(
      security,
      window,
      operands,
    );
    expectSameFrame(frame, await storedFrame(window, operands), "2022");
    expect(provider.calls).toEqual([]);
    expect(await chunkBytes()).toEqual(published);
  });

  it("publishes one generation for concurrent cold readers, who all read the same rows", async () => {
    await flushNamespace();
    const readers = [0, 1, 2].map(() => {
      const client = createStockDataRedisClient(
        redisUrl ?? "redis://localhost:6379",
      );
      clients.push(client);
      const instrumented = new InstrumentedCacheClient(client);
      return {
        instrumented,
        service: serviceOver(cacheOver(instrumented), client),
      };
    });
    const results = await Promise.all(
      readers.map(({ service }) => service.getDailyDerivedState(symbol, range)),
    );
    for (const result of results) {
      expect(JSON.stringify(result)).toBe(JSON.stringify(persisted));
    }
    // Each year was published exactly once, by whichever reader won the hydration lock.
    const writes = readers.flatMap(
      ({ instrumented }) => instrumented.chunkWrites,
    );
    expect(writes.sort()).toEqual(
      years
        .map((year) => dailyStateChunkKey(namespace, security.id, year))
        .sort(),
    );
    expect(await chunkBytes()).toEqual(published);
    expect(provider.calls).toEqual([]);
  });

  it("never serves a partial history when publication fails part-way, and the next read completes it", async () => {
    await flushNamespace();
    let written = 0;
    const failing = serviceOver(
      cacheOver(
        new InstrumentedCacheClient(redis, {
          beforeChunkWrite: () => {
            written += 1;
            if (written === 3) {
              throw new Error(
                "injected: connection lost between encode and SET",
              );
            }
          },
        }),
      ),
    );
    await expect(failing.getDailyDerivedState(symbol, range)).rejects.toThrow(
      "injected: connection lost",
    );
    // Two years reached Redis under a HYDRATING manifest; nothing reads them as a history.
    const manifest = await cacheOver().getManifest(security.id);
    expect(manifest?.status).toBe("HYDRATING");
    await expect(
      cacheOver().readDailyDerivedState(security.id, range),
    ).resolves.toBeNull();

    const rebuilds = rebuildSpy();
    const writes = vi.spyOn(store, "saveDailyDerivedState");
    try {
      const served = await serviceOver().getDailyDerivedState(symbol, range);
      expect(JSON.stringify(served)).toBe(JSON.stringify(persisted));
      expectNoProviderAndNoRebuild(rebuilds, writes);
    } finally {
      rebuilds.mockRestore();
      writes.mockRestore();
    }
    expect(await chunkBytes()).toEqual(published);
  });

  it("propagates a failed chunk read instead of answering with part of the history", async () => {
    const timeout = serviceOver(
      cacheOver(
        new InstrumentedCacheClient(redis, {
          onChunkRead: () => {
            throw new Error("injected: Redis command timed out");
          },
        }),
      ),
    );
    await expect(timeout.getDailyDerivedState(symbol, range)).rejects.toThrow(
      "injected: Redis command timed out",
    );
    // The cache itself was never touched: the next ordinary read is served from it.
    expect(
      await serviceOver().getDailyDerivedState(symbol, range),
    ).toStrictEqual(persisted);
  });

  it("answers from PostgreSQL, never from damaged bytes, when every chunk read comes back corrupt", async () => {
    unreadable.length = 0;
    const corrupting = serviceOver(
      cacheOver(
        new InstrumentedCacheClient(redis, {
          onChunkRead: (_keys, payloads) =>
            payloads.map((payload) => payload?.replace(/[0-9]/, "x") ?? null),
        }),
      ),
    );
    const rebuilds = rebuildSpy();
    const writes = vi.spyOn(store, "saveDailyDerivedState");
    try {
      const served = await corrupting.getDailyDerivedState(symbol, range);
      expect(JSON.stringify(served)).toBe(JSON.stringify(persisted));
      expectNoProviderAndNoRebuild(rebuilds, writes);
    } finally {
      rebuilds.mockRestore();
      writes.mockRestore();
    }
    expect(unreadable.length).toBeGreaterThan(0);
    expect(await chunkBytes()).toEqual(published);
  });

  it("serves correct rows without its key registry, and the next hydration registers every chunk again", async () => {
    const cache = cacheOver();
    const registry = `${namespace}:security:${security.id}:keys`;
    await redis.del(registry);
    expect(await cache.readDailyDerivedState(security.id, range)).toStrictEqual(
      persisted,
    );

    await cache.invalidateManifest(await cache.getManifest(security.id));
    expect(
      await serviceOver(cache).getDailyDerivedState(symbol, range),
    ).toStrictEqual(persisted);
    const registered = await redis.smembers(registry);
    for (const year of years) {
      expect(registered).toContain(
        dailyStateChunkKey(namespace, security.id, year),
      );
    }
    await cache.evict(security.id);
    expect(
      await namespaceKeys(`${namespace}:security:${security.id}:*`),
    ).toEqual([]);
    expect(
      await serviceOver(cache).getDailyDerivedState(symbol, range),
    ).toStrictEqual(persisted);
    expect(provider.calls).toEqual([]);
  });

  const FRAME_OPERANDS = [
    PRICE_OPERAND,
    seriesOperand("SMA_50D"),
    seriesOperand("RSI_14D"),
    seriesOperand("SMA_20W"),
    seriesOperand("DCF_FCFF"),
    seriesOperand("DDM"),
    seriesOperand("BALANCED"),
    relativeVolumeOperand(20),
    fundamentalMetricOperand("ROIC_TTM"),
    fundamentalMetricOperand("DEBT_TO_EQUITY"),
    fundamentalMetricOperand("NET_DEBT_TO_EBITDA_TTM"),
    marginOfSafetyOperand("BALANCED"),
    marginOfSafetyOperand("DDM"),
  ];

  /** The frame the projector builds from PostgreSQL's own rows for the same window. */
  async function storedFrame(
    window: Required<DateRange>,
    operands: readonly string[],
  ): Promise<EvaluationFrame> {
    const context = { from: addDays(window.from, -10), to: window.to };
    return projectEvaluationFrame({
      security,
      prices: await store.getDailyPrices(security.id, context),
      derived: await store.getDailyDerivedState(security.id, context),
      operands,
      periodStart: window.from,
    }).frame;
  }

  function expectSameFrame(
    actual: EvaluationFrame,
    expected: EvaluationFrame,
    label: string,
  ) {
    expect(actual.dates, label).toEqual(expected.dates);
    expect(actual.periodStartIndex, label).toBe(expected.periodStartIndex);
    expect([...actual.columns.keys()].sort(), label).toEqual(
      [...expected.columns.keys()].sort(),
    );
    for (const [key, column] of expected.columns) {
      const mine = actual.columns.get(key) as Float64Array;
      for (let index = 0; index < column.length; index += 1) {
        expect(
          Object.is(mine[index], column[index]),
          `${label} ${key} ${expected.dates[index]}: ${mine[index]} vs ${column[index]}`,
        ).toBe(true);
      }
    }
  }

  it("gives a backtest, window by window, exactly the frame PostgreSQL's rows project", async () => {
    const service = serviceOver();
    for (const year of years.filter((each) => each >= 2020)) {
      const window = {
        from: `${year}-01-01`,
        to: year === 2026 ? TODAY : `${year}-12-31`,
      };
      expectSameFrame(
        await service.readDailyEvaluationFrame(
          security,
          window,
          FRAME_OPERANDS,
        ),
        await storedFrame(window, FRAME_OPERANDS),
        String(year),
      );
    }
    expect(provider.calls).toEqual([]);
  });

  it("gives the Monitor, on the same observation, the stored value the backtest frame reads", async () => {
    const service = serviceOver();
    // Sessions across event starts, an invalidation gap, a currency-conflict stretch and a year end.
    const observed = [
      prices[EVENT_SESSIONS * 5]!.date,
      prices[EVENT_SESSIONS * 5 + 1]!.date,
      prices[EVENT_SESSIONS * 16 + 3]!.date,
      "2023-12-29",
      "2024-01-02",
      prices.at(-1)!.date,
    ];
    // Families a Monitor carries from the newest closed derived row; its daily columns are
    // recomputed from prices by the Monitor itself and never read a stored value.
    const carried = [
      seriesOperand("SMA_20W"),
      seriesOperand("DCF_FCFF"),
      seriesOperand("DDM"),
      seriesOperand("BALANCED"),
      fundamentalMetricOperand("ROIC_TTM"),
      fundamentalMetricOperand("DEBT_TO_EQUITY"),
      fundamentalMetricOperand("NET_DEBT_TO_EBITDA_TTM"),
      marginOfSafetyOperand("DDM"),
    ];
    const operands = [PRICE_OPERAND, ...carried];
    const observations = monitorWindowObservations(
      requiredDailySeries(operands),
      0,
    );
    for (const date of observed) {
      const close = prices.find((price) => price.date === date)!.close;
      const monitor = await service.readMonitorEvaluationFrame({
        security,
        operands,
        observations,
        asOf: date,
        observation: { price: close },
        observationDate: date,
      });
      expect(monitor, date).not.toBeNull();
      const backtest = await service.readDailyEvaluationFrame(
        security,
        { from: date, to: date },
        operands,
      );
      const index = backtest.dates.indexOf(date);
      for (const key of carried) {
        const inMonitor = readOperand(
          monitor!.frame,
          key,
          monitor!.observationIndex,
        );
        const inBacktest = readOperand(backtest, key, index);
        expect(
          Object.is(inMonitor, inBacktest),
          `${date} ${key}: ${inMonitor} vs ${inBacktest}`,
        ).toBe(true);
      }
    }
    expect(provider.calls).toEqual([]);
  });
});
