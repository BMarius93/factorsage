import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type {
  DateRange,
  FinancialStatementCadence,
  FinancialStatementDraft,
  FinancialStatementType,
  Security,
} from "@intrinsic/domain";
import type { FmpStockProviderPort } from "@intrinsic/fmp";
import {
  CanonicalStockDataService,
  IoredisCacheClient,
  PrismaStockDataStore,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  createStockDataRedisClient,
  fundamentalsDatasetOperations,
  priceRetentionYears,
  subtractYears,
  type RedisCacheClient,
} from "@intrinsic/stock-data";
import {
  FUNDAMENTAL_AUDIT_ANCHOR_FIRST_SESSION,
  FUNDAMENTAL_AUDIT_ANCHOR_LAST_SESSION,
  FUNDAMENTAL_AUDIT_ANCHOR_SYNCS,
  FUNDAMENTAL_AUDIT_METRICS,
  fundamentalAuditAnchorSessions,
  useIsolatedRateLimits,
  useTestDatabase,
} from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { AppModule } from "../../app.module";
import {
  STOCK_DATA_CACHE,
  STOCK_DATA_COORDINATOR,
  STOCK_DATA_PROVIDER,
  STOCK_DATA_STORE,
} from "../../stocks/stock-data.tokens";

loadRootEnv();
useTestDatabase();
useIsolatedRateLimits();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
const describeInfrastructure = redisUrl ? describe : describe.skip;

/**
 * What an ordinary Fundamental read costs once derived coverage exists (audit section 31), counted
 * at the three places a cost could hide.
 *
 * - **SQL**: every statement the store's own `PrismaClient` sends, from Prisma's query events,
 *   classified by the table it names. The application's store is replaced by that one store, so the
 *   HTTP path's queries are all seen; nothing else in the request reaches market data.
 * - **Redis**: every command the stock-data cache issues, through a counting `RedisCacheClient`.
 * - **Rebuild**: calls of the service's derived rebuild — the only place statements are read for a
 *   calculation and the only caller of the Fundamental materializer.
 *
 * The first request is the intentional hydration and is counted separately; it is not an ordinary
 * read.
 */
describeInfrastructure(
  "ordinary Fundamental reads once derived coverage exists, counted",
  () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
    const symbol = `FC${suffix}`;
    const namespace = `stock-data:v2:test:fundamental-counters:${suffix}`;
    const sessions = fundamentalAuditAnchorSessions();
    const full = {
      from: FUNDAMENTAL_AUDIT_ANCHOR_FIRST_SESSION,
      to: FUNDAMENTAL_AUDIT_ANCHOR_LAST_SESSION,
    };
    const month = {
      from: "2025-12-01",
      to: FUNDAMENTAL_AUDIT_ANCHOR_LAST_SESSION,
    };

    class NoProvider implements FmpStockProviderPort {
      readonly calls: string[] = [];
      async getProfile(requested: string) {
        this.calls.push(`profile:${requested}`);
        return null;
      }
      async getDailyPrices(
        _symbol: string,
        _securityId: string,
        requested: DateRange,
      ) {
        this.calls.push(`prices:${requested.from}:${requested.to}`);
        return [];
      }
      async getFinancialStatements(
        _symbol: string,
        _securityId: string,
        type: FinancialStatementType,
        cadence: FinancialStatementCadence,
      ) {
        this.calls.push(`statements:${type}:${cadence}`);
        return [];
      }
    }

    /** Every cache command, with the keys it named. */
    class CountingCacheClient implements RedisCacheClient {
      readonly commands: { command: string; keys: string[] }[] = [];
      constructor(private readonly inner: IoredisCacheClient) {}
      private record(command: string, keys: string[]) {
        this.commands.push({ command, keys });
      }
      get(key: string) {
        this.record("get", [key]);
        return this.inner.get(key);
      }
      mget(...keys: string[]) {
        this.record("mget", keys);
        return this.inner.mget(...keys);
      }
      set(key: string, value: string) {
        this.record("set", [key]);
        return this.inner.set(key, value);
      }
      sadd(key: string, ...members: string[]) {
        this.record("sadd", [key]);
        return this.inner.sadd(key, ...members);
      }
      smembers(key: string) {
        this.record("smembers", [key]);
        return this.inner.smembers(key);
      }
      incr(key: string) {
        this.record("incr", [key]);
        return this.inner.incr(key);
      }
      zadd(key: string, score: number, member: string) {
        this.record("zadd", [key]);
        return this.inner.zadd(key, score, member);
      }
      zcard(key: string) {
        this.record("zcard", [key]);
        return this.inner.zcard(key);
      }
      zrange(key: string, start: number, stop: number) {
        this.record("zrange", [key]);
        return this.inner.zrange(key, start, stop);
      }
      zscore(key: string, member: string) {
        this.record("zscore", [key]);
        return this.inner.zscore(key, member);
      }
      zrem(key: string, ...members: string[]) {
        this.record("zrem", [key]);
        return this.inner.zrem(key, ...members);
      }
      del(...keys: string[]) {
        this.record("del", keys);
        return this.inner.del(...keys);
      }
      eval(script: string, numberOfKeys: number, ...args: string[]) {
        this.record("eval", args.slice(0, numberOfKeys));
        return this.inner.eval(script, numberOfKeys, ...args);
      }
    }

    const provider = new NoProvider();
    const sql: string[] = [];
    let prisma: PrismaClient;
    let redis: ReturnType<typeof createStockDataRedisClient>;
    let client: CountingCacheClient;
    let store: PrismaStockDataStore;
    let app: INestApplication;
    let security: Security;
    let rebuilds: MockInstance<() => Promise<unknown>>;
    let revisionReads: MockInstance<
      PrismaStockDataStore["getFinancialStatementRevisions"]
    >;
    let hydration: Counted;

    type Counted = {
      sql: number;
      statementSql: number;
      derivedSelects: number;
      derivedWrites: number;
      rebuilds: number;
      /**
       * The derived rebuild's one read of every revision of every family — the calculation's input.
       * Hydration also reads each family separately to publish the statement cache; those carry a
       * statement type and are counted in `statementSql` only.
       */
      calculationReads: number;
      cacheCommands: number;
      derivedChunkReads: number;
      statementChunkReads: number;
    };

    /** Runs `work` and returns what it cost. */
    async function counted(work: () => Promise<unknown>): Promise<Counted> {
      sql.length = 0;
      client.commands.length = 0;
      rebuilds.mockClear();
      revisionReads.mockClear();
      await work();
      // Prisma emits a query event after the statement returns; one tick lets the last one land.
      await new Promise((resolve) => setImmediate(resolve));
      const statementSql = sql.filter((query) =>
        /"FinancialStatement"/.test(query),
      );
      const derived = sql.filter((query) => /"DailyDerivedState"/.test(query));
      return {
        sql: sql.length,
        statementSql: statementSql.length,
        derivedSelects: derived.filter((query) => /^\s*SELECT/i.test(query))
          .length,
        derivedWrites: derived.filter((query) =>
          /^\s*(INSERT|UPDATE|DELETE)/i.test(query),
        ).length,
        rebuilds: rebuilds.mock.calls.length,
        calculationReads: revisionReads.mock.calls.filter(
          ([input]) =>
            (input as { statementType?: string }).statementType === undefined,
        ).length,
        cacheCommands: client.commands.length,
        derivedChunkReads: client.commands.filter(
          (command) =>
            (command.command === "get" || command.command === "mget") &&
            command.keys.some((key) => key.includes(":daily-state:")),
        ).length,
        statementChunkReads: client.commands.filter(
          (command) =>
            (command.command === "get" || command.command === "mget") &&
            command.keys.some((key) => key.includes(":financials:")),
        ).length,
      };
    }

    async function fetchApi(metricId: string, range: Required<DateRange>) {
      const response = await request(app.getHttpServer())
        .get(`/stocks/${symbol}/fundamentals/daily`)
        .query({ from: range.from, to: range.to, metric: metricId });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body as { date: string; value?: number }[];
    }

    async function namespaceKeys(): Promise<string[]> {
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [next, batch] = await redis.scan(
          cursor,
          "MATCH",
          `${namespace}:*`,
          "COUNT",
          500,
        );
        cursor = next;
        keys.push(...batch);
      } while (cursor !== "0");
      return keys;
    }

    beforeAll(async () => {
      process.env.NODE_ENV = "test";
      process.env.AUTH_JWT_SECRET =
        "test-only-jwt-secret-that-is-at-least-32-characters";
      const logging = new PrismaClient({
        log: [{ emit: "event", level: "query" }],
      });
      logging.$on("query", (event) => sql.push(event.query));
      prisma = logging;
      redis = createStockDataRedisClient(redisUrl ?? "redis://localhost:6379");
      client = new CountingCacheClient(new IoredisCacheClient(redis));
      store = new PrismaStockDataStore(prisma);
      revisionReads = vi.spyOn(store, "getFinancialStatementRevisions");
      const cache = new RedisStockDataCache(client, 10, namespace);
      rebuilds = vi.spyOn(
        CanonicalStockDataService.prototype as unknown as {
          rebuildDailyDerivedState: () => Promise<unknown>;
        },
        "rebuildDailyDerivedState",
      );

      const row = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Fundamental Counter Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      const today = new Date().toISOString().slice(0, 10);
      const syncedAt = new Date().toISOString();
      await store.saveDailyPriceSync({
        securityId: row.id,
        prices: sessions.map((date, index) => {
          const close = 50 + (index % 23) * 0.37 + index * 0.01;
          return {
            securityId: row.id,
            date,
            open: close,
            high: close,
            low: close,
            close,
            volume: 1_000,
          };
        }),
        successfulCoverage: [
          { from: subtractYears(today, priceRetentionYears(30)), to: today },
        ],
        syncedAt,
        tailDate: today,
        freshThrough: today,
      });
      for (const sync of FUNDAMENTAL_AUDIT_ANCHOR_SYNCS) {
        await store.saveFinancialStatements({
          securityId: row.id,
          statements: sync.statements.map(
            (draft) =>
              ({ ...draft, securityId: row.id }) as FinancialStatementDraft,
          ),
          syncedAt: sync.observedAt,
        });
      }
      for (const operation of fundamentalsDatasetOperations(30)) {
        await store.upsertDatasetState({
          securityId: row.id,
          dataset: operation.dataset,
          variant: operation.variant,
          syncedAt,
        });
      }
      await store.upsertDatasetState({
        securityId: row.id,
        dataset: "SECURITY_PROFILE",
        variant: "",
        syncedAt,
      });
      [security] = (await store.findSecuritiesByIds([row.id])) as [Security];

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(STOCK_DATA_STORE)
        .useValue(store)
        .overrideProvider(STOCK_DATA_PROVIDER)
        .useValue(provider)
        .overrideProvider(STOCK_DATA_CACHE)
        .useValue(cache)
        .overrideProvider(STOCK_DATA_COORDINATOR)
        .useValue(
          new RedlockLoadCoordinator(redis, {
            lockDurationMs: 30_000,
            lockWaitMs: 30_000,
          }),
        )
        .compile();
      app = moduleRef.createNestApplication();
      await app.listen(0, "127.0.0.1");

      // The intentional first hydration: statements read once, derived state built once.
      hydration = await counted(() => fetchApi("ROIC_TTM", full));
    }, 180_000);

    afterAll(async () => {
      rebuilds?.mockRestore();
      await app?.close();
      if (redis) {
        const leftovers = await namespaceKeys();
        if (leftovers.length > 0) {
          await redis.del(...leftovers);
        }
        redis.disconnect();
      }
      if (prisma && security) {
        await prisma.security.deleteMany({ where: { id: security.id } });
      }
      await prisma?.$disconnect();
    });

    it("the first request is the one intentional build: one calculation read, one rebuild, no provider", () => {
      expect(hydration.rebuilds).toBe(1);
      expect(hydration.calculationReads).toBe(1);
      expect(hydration.statementSql).toBeGreaterThan(0);
      expect(hydration.derivedWrites).toBeGreaterThan(0);
      expect(provider.calls).toEqual([]);
    });

    it("a warm Stock Details request reads one cached history: no statement, no calculation, no rebuild, no SQL per day", async () => {
      const perMetric: Counted[] = [];
      for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
        perMetric.push(await counted(() => fetchApi(metric.id, full)));
      }
      const shortRange = await counted(() => fetchApi("ROIC_TTM", month));
      for (const [index, cost] of perMetric.entries()) {
        const label = FUNDAMENTAL_AUDIT_METRICS[index]!.id;
        expect(cost.sql, label).toBe(0);
        expect(cost.statementSql, label).toBe(0);
        expect(cost.calculationReads, label).toBe(0);
        expect(cost.statementChunkReads, label).toBe(0);
        expect(cost.rebuilds, label).toBe(0);
        expect(cost.derivedWrites, label).toBe(0);
        expect(cost.derivedSelects, label).toBe(0);
        // One multi-key read of the yearly chunks carries the whole history.
        expect(cost.derivedChunkReads, label).toBe(1);
        // Every metric costs the same: the cost follows the request, not the metric or the data.
        expect(cost, label).toEqual(perMetric[0]);
      }
      // 752 sessions cost what 22 sessions cost: nothing is read per day.
      expect(shortRange.sql).toBe(perMetric[0]!.sql);
      expect(shortRange.cacheCommands).toBe(perMetric[0]!.cacheCommands);
      expect(provider.calls).toEqual([]);
    });

    it("after a Redis flush the history is repaired from PostgreSQL: nothing is calculated or rebuilt, nothing is read per day", async () => {
      const warm = await fetchApi("DEBT_TO_EQUITY", full);
      await redis.del(...(await namespaceKeys()));
      const flushedFull = await counted(async () =>
        expect(await fetchApi("DEBT_TO_EQUITY", full)).toEqual(warm),
      );
      await redis.del(...(await namespaceKeys()));
      const flushedMonth = await counted(() =>
        fetchApi("DEBT_TO_EQUITY", month),
      );
      for (const [label, cost] of [
        ["full", flushedFull],
        ["month", flushedMonth],
      ] as const) {
        expect(cost.rebuilds, label).toBe(0);
        expect(cost.calculationReads, label).toBe(0);
        expect(cost.derivedWrites, label).toBe(0);
        // The durable history, read once to republish the yearly chunks.
        expect(cost.derivedSelects, label).toBe(1);
      }
      // Re-publishing the resident security reads its statements for the statement cache, as every
      // hydration does: one read per statement family and cadence the cache holds, whatever the
      // range or the number of its days.
      expect(flushedFull.statementSql).toBe(
        fundamentalsDatasetOperations(30).length,
      );
      expect(flushedMonth.statementSql).toBe(flushedFull.statementSql);
      expect(flushedMonth.derivedSelects).toBe(flushedFull.derivedSelects);
      expect(provider.calls).toEqual([]);
    });
  },
);
