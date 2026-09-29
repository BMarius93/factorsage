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
  monitorWindowObservations,
  priceRetentionYears,
  requiredDailySeries,
  subtractYears,
  type ProviderRequestEvent,
} from "@intrinsic/stock-data";
import {
  FUNDAMENTAL_METRIC_CATALOG,
  normalizeStrategyDefinition,
} from "@intrinsic/contracts";
import {
  Evaluability,
  INITIAL_MONITOR_LEVEL_LIFECYCLE,
  collectOperands,
  evaluateMarketCondition,
  fundamentalMetricOperand,
  monitorStrategyLevels,
  observeMonitorLevel,
  readOperand,
  stepMonitorLevel,
} from "@intrinsic/strategy";
import {
  FUNDAMENTAL_AUDIT_ANCHOR_BOUNDARIES,
  FUNDAMENTAL_AUDIT_ANCHOR_FIRST_SESSION,
  FUNDAMENTAL_AUDIT_ANCHOR_LAST_SESSION,
  FUNDAMENTAL_AUDIT_ANCHOR_SYNCS,
  FUNDAMENTAL_AUDIT_METRICS,
  fundamentalAuditAnchorExpected,
  fundamentalAuditAnchorSessions,
  useIsolatedRateLimits,
  useTestDatabase,
  type FundamentalAuditMetricId,
} from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../../app.module";
import {
  oracleFundamentalOutcomes,
  type OracleRational,
} from "../oracle/fundamentals";
import {
  STOCK_DATA_CACHE,
  STOCK_DATA_COORDINATOR,
  STOCK_DATA_PROVIDER,
} from "../../stocks/stock-data.tokens";

loadRootEnv();
useTestDatabase();
useIsolatedRateLimits();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
const describeInfrastructure = redisUrl ? describe : describe.skip;

/**
 * The single-source-of-truth audit: one statement history, one literal table, every layer.
 *
 * `FUNDAMENTAL_AUDIT_ANCHOR_SYNCS` is delivered to the real `PrismaStockDataStore` sync by sync, so
 * the loader dates every revision itself. The first Stock Details request then runs the canonical
 * derived rebuild inside the real application. From there every layer that carries a Fundamental
 * Metric is read and held to `FUNDAMENTAL_AUDIT_ANCHOR_EXPECTED` — hand-derived, and reproduced by
 * the independent oracle — on **every** trading session and for **all fifteen** metrics:
 *
 * | Layer | Read through | Absence is |
 * | --- | --- | --- |
 * | PostgreSQL | `DailyDerivedState` columns as `numeric::text`, named from the ADR's table | `NULL` |
 * | Redis | the yearly `daily-state` chunks, parsed | the key omitted |
 * | Strategy / Backtest | `getDailyEvaluationFrame`, the frame a backtest window projects | `NaN` |
 * | Predicate | `evaluateMarketCondition` on that frame | `NOT_EVALUABLE` |
 * | Monitor | `readMonitorEvaluationFrame`, a provisional session after each boundary | `NaN` |
 * | Stock Details API | `GET /stocks/:symbol/fundamentals/daily` over HTTP | `value` omitted |
 *
 * The chart's preparation of the same rows is held to the same table in the web app's
 * `fundamental-series.audit.test.ts`. The provider is a counter that is never asked anything.
 */
describeInfrastructure(
  "Fundamental Metrics: one persisted truth across every layer",
  () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
    const symbol = `FA${suffix}`;
    const namespace = `stock-data:v2:test:fundamental-audit:${suffix}`;
    const sessions = fundamentalAuditAnchorSessions();
    const range = {
      from: FUNDAMENTAL_AUDIT_ANCHOR_FIRST_SESSION,
      to: FUNDAMENTAL_AUDIT_ANCHOR_LAST_SESSION,
    };

    class CountingProvider implements FmpStockProviderPort {
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
        statementType: FinancialStatementType,
        cadence: FinancialStatementCadence,
      ) {
        this.calls.push(`statements:${statementType}:${cadence}`);
        return [];
      }
    }

    const provider = new CountingProvider();
    const requests: ProviderRequestEvent[] = [];
    let prisma: PrismaClient;
    let redis: ReturnType<typeof createStockDataRedisClient>;
    let store: PrismaStockDataStore;
    let cache: RedisStockDataCache;
    let service: CanonicalStockDataService;
    let app: INestApplication;
    let security: Security;
    /** Every metric's API history, as the first cold request returned it. */
    const apiHistory = new Map<
      FundamentalAuditMetricId,
      { date: string; value?: number }[]
    >();

    const expectedNumber = (
      metricId: FundamentalAuditMetricId,
      session: string,
    ) => {
      const text = fundamentalAuditAnchorExpected(metricId, session);
      return text === null ? undefined : Number(text);
    };

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

    async function fetchApi(metricId: string) {
      const response = await request(app.getHttpServer())
        .get(`/stocks/${symbol}/fundamentals/daily`)
        .query({ from: range.from, to: range.to, metric: metricId });
      return response;
    }

    beforeAll(async () => {
      process.env.NODE_ENV = "test";
      process.env.AUTH_JWT_SECRET =
        "test-only-jwt-secret-that-is-at-least-32-characters";
      prisma = new PrismaClient();
      redis = createStockDataRedisClient(redisUrl ?? "redis://localhost:6379");
      store = new PrismaStockDataStore(prisma);
      cache = new RedisStockDataCache(
        new IoredisCacheClient(redis),
        10,
        namespace,
      );

      const row = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Fundamental Audit Anchor Corp",
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
            volume: 1_000 + (index % 5) * 10,
          };
        }),
        // Coverage through today, so the loader has nothing to ask a provider for.
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

      const coordinator = new RedlockLoadCoordinator(redis, {
        lockDurationMs: 30_000,
        lockWaitMs: 30_000,
      });
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(STOCK_DATA_PROVIDER)
        .useValue(provider)
        .overrideProvider(STOCK_DATA_CACHE)
        .useValue(cache)
        .overrideProvider(STOCK_DATA_COORDINATOR)
        .useValue(coordinator)
        .compile();
      app = moduleRef.createNestApplication();
      await app.listen(0, "127.0.0.1");
      // The same store, cache and provider behind a service the test can ask for frames directly.
      service = new CanonicalStockDataService(
        store,
        provider,
        cache,
        coordinator,
        {
          productHistoryYears: 30,
          onProviderRequest: (event) => requests.push(event),
        },
      );

      // The first, cold request of every metric: the rebuild happens inside the application.
      for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
        const response = await fetchApi(metric.id);
        expect(
          response.status,
          `${metric.id}: ${JSON.stringify(response.body)}`,
        ).toBe(200);
        apiHistory.set(metric.id, response.body);
      }
    }, 180_000);

    afterAll(async () => {
      await app?.close();
      if (cache && security) {
        await cache.evict(security.id);
      }
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

    async function persistedText(): Promise<
      Map<string, Record<string, string | null>>
    > {
      const columns = FUNDAMENTAL_AUDIT_METRICS.map(
        (metric) => `"${metric.field}"::text as "${metric.field}"`,
      );
      const rows = await prisma.$queryRawUnsafe<
        ({ date: string } & Record<string, string | null>)[]
      >(
        `select date::text as date, ${columns.join(", ")} from "DailyDerivedState" where "securityId" = $1 order by date`,
        security.id,
      );
      return new Map(rows.map((row) => [row.date, row]));
    }

    it("dated the anchor's revisions the way the loader rules say", async () => {
      const revisions = await store.getFinancialStatementRevisions({
        securityId: security.id,
      });
      const dated = (type: string, fiscalDate: string, filingDate: string) =>
        revisions.find(
          (revision) =>
            revision.statementType === type &&
            revision.fiscalDate === fiscalDate &&
            revision.filingDate === filingDate &&
            revision.period !== "FY",
        )?.availableFromDate;
      // A real filing is public the day after it; a weekend or holiday date is kept as it is.
      expect(dated("INCOME", "2022-12-31", "2023-02-10")).toBe("2023-02-11");
      expect(dated("BALANCE_SHEET", "2023-06-30", "2023-07-03")).toBe(
        "2023-07-04",
      );
      // A later filing of a known quarter is public from its own filing.
      expect(dated("INCOME", "2024-06-30", "2024-08-19")).toBe("2024-08-20");
      expect(dated("INCOME", "2024-06-30", "2024-09-13")).toBe("2024-09-14");
      expect(dated("BALANCE_SHEET", "2024-09-30", "2024-12-13")).toBe(
        "2024-12-14",
      );
      // A moved period end with the original filing date: from its observation, never 2024-08-02.
      expect(dated("BALANCE_SHEET", "2024-06-29", "2024-08-01")).toBe(
        "2024-10-15",
      );
      // A filing on 2025-01-01 is public on 2025-01-02, the year's first session.
      expect(dated("INCOME", "2024-12-31", "2025-01-01")).toBe("2025-01-02");
      // The period-end placeholder: 2025-06-30 + 45 days = Thursday 2025-08-14, public the day after.
      expect(dated("INCOME", "2025-06-30", "2025-06-30")).toBe("2025-08-15");
    });

    it("the independent oracle reproduces every stretch of the table from the loader-dated revisions", async () => {
      // Half away from zero at eight decimals, exactly as PostgreSQL rounds a numeric.
      const atStorageScale = (value: OracleRational): string => {
        const negative = value.numerator < 0n;
        const magnitude = negative ? -value.numerator : value.numerator;
        const scaled =
          (magnitude * 10n ** 8n * 2n + value.denominator) /
          (2n * value.denominator);
        const digits = scaled.toString().padStart(9, "0");
        const text = `${digits.slice(0, -8)}.${digits.slice(-8)}`;
        return negative && scaled !== 0n ? `-${text}` : text;
      };
      const revisions = await store.getFinancialStatementRevisions({
        securityId: security.id,
      });
      let compared = 0;
      for (const session of sessions) {
        const outcomes = oracleFundamentalOutcomes(revisions, session);
        for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
          const outcome = outcomes[metric.id];
          expect(
            outcome.status === "VALUE" ? atStorageScale(outcome.exact) : null,
            `${session} ${metric.id}`,
          ).toBe(fundamentalAuditAnchorExpected(metric.id, session));
          compared += 1;
        }
      }
      expect(compared).toBe(sessions.length * 15);
    });

    it("was materialized by one canonical rebuild, with no provider request at all", () => {
      expect(provider.calls).toEqual([]);
      expect(requests).toEqual([]);
    });

    it("PostgreSQL holds exactly the anchor's text on every session, NULL where unavailable, no other day", async () => {
      const persisted = await persistedText();
      expect([...persisted.keys()]).toEqual(sessions);
      let compared = 0;
      for (const session of sessions) {
        for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
          expect(
            persisted.get(session)![metric.field],
            `${session} ${metric.id}`,
          ).toBe(fundamentalAuditAnchorExpected(metric.id, session));
          compared += 1;
        }
      }
      expect(compared).toBe(sessions.length * 15);
    });

    it("Redis holds the same numbers, and omits an unavailable metric rather than writing null or zero", async () => {
      const cached = await cache.readDailyDerivedState(security.id, range);
      expect(cached?.map((row) => row.date)).toEqual(sessions);
      for (const row of cached ?? []) {
        const record = row as unknown as Record<string, unknown>;
        for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
          const expected = expectedNumber(metric.id, row.date);
          if (expected === undefined) {
            expect(metric.field in record, `${row.date} ${metric.id}`).toBe(
              false,
            );
          } else {
            expect(
              Object.is(record[metric.field], expected),
              `${row.date} ${metric.id}: ${String(record[metric.field])}`,
            ).toBe(true);
          }
        }
      }
      // No Fundamental-specific key family exists: the metrics ride in the ordinary yearly chunks.
      const keys = await namespaceKeys();
      expect(
        keys.some((key) => /fundamental/i.test(key.slice(namespace.length))),
      ).toBe(false);
      const chunkKeys = keys.filter((key) => key.includes(":daily-state:"));
      for (const year of ["2023", "2024", "2025"]) {
        const key = chunkKeys.find((candidate) =>
          candidate.endsWith(`:daily-state:${year}`),
        );
        expect(key, year).toBeDefined();
        const chunk = JSON.parse((await redis.get(key!)) ?? "[]") as Record<
          string,
          unknown
        >[];
        expect(chunk.map((row) => row.date)).toEqual(
          sessions.filter((session) => session.startsWith(year)),
        );
        // Absence is an omitted key, never a JSON null.
        for (const row of chunk) {
          for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
            expect(
              row[metric.field] === null,
              `${String(row.date)} ${metric.id}`,
            ).toBe(false);
          }
        }
      }
      // Years the load window reaches without price history hold empty chunks, never rows.
      for (const key of chunkKeys.filter(
        (candidate) => !/:daily-state:202[345]$/.test(candidate),
      )) {
        expect(JSON.parse((await redis.get(key)) ?? "[]"), key).toEqual([]);
      }
    });

    it("the Stock Details API serves exactly the persisted value per session, value omitted when unavailable", () => {
      for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
        const rows = apiHistory.get(metric.id)!;
        expect(
          rows.map((row) => row.date),
          metric.id,
        ).toEqual(sessions);
        for (const row of rows) {
          const expected = expectedNumber(metric.id, row.date);
          if (expected === undefined) {
            expect(row, `${row.date} ${metric.id}`).toEqual({ date: row.date });
          } else {
            expect(
              Object.is(row.value, expected),
              `${row.date} ${metric.id}: ${row.value}`,
            ).toBe(true);
            expect(Object.keys(row)).toEqual(["date", "value"]);
          }
        }
      }
    });

    it("refuses a storage field, a label or a lower-cased identity as the public metric", async () => {
      for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
        const label = FUNDAMENTAL_METRIC_CATALOG.find(
          (entry) => entry.id === metric.id,
        )!.label;
        for (const alias of [
          metric.field,
          label,
          metric.id.toLowerCase(),
          metric.id.replaceAll("_", " "),
        ]) {
          const response = await fetchApi(alias);
          expect(response.status, `${alias}`).toBe(400);
        }
      }
    });

    it("the Strategy evaluation frame reads the same number on every session, NaN where unavailable", async () => {
      const operands = [
        "price",
        ...FUNDAMENTAL_AUDIT_METRICS.map((metric) =>
          fundamentalMetricOperand(metric.id as never),
        ),
      ];
      const frame = await service.getDailyEvaluationFrame(
        security,
        range,
        operands,
      );
      expect(frame.dates).toEqual(sessions);
      for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
        const key = fundamentalMetricOperand(metric.id as never);
        frame.dates.forEach((session, index) => {
          const expected = expectedNumber(metric.id, session);
          const actual = readOperand(frame, key, index);
          if (expected === undefined) {
            expect(actual, `${session} ${metric.id}`).toBeNaN();
          } else {
            expect(
              Object.is(actual, expected),
              `${session} ${metric.id}: ${actual}`,
            ).toBe(true);
          }
        });
      }
    });

    it("decides the headline Conditions on the persisted value: strict, and NOT_EVALUABLE never a zero", async () => {
      const rules = [
        {
          metricId: "ROIC_TTM",
          operator: "IS_ABOVE",
          value: { kind: "PERCENT", value: 15 },
        },
        {
          metricId: "REVENUE_GROWTH_TTM_YOY",
          operator: "IS_ABOVE",
          value: { kind: "PERCENT", value: 0 },
        },
        {
          metricId: "DEBT_TO_EQUITY",
          operator: "IS_BELOW",
          value: { kind: "MULTIPLE", value: 1 },
        },
        {
          metricId: "NET_DEBT_TO_EBITDA_TTM",
          operator: "IS_BELOW",
          value: { kind: "MULTIPLE", value: 0 },
        },
      ] as const;
      const operands = [
        "price",
        ...rules.map((rule) => fundamentalMetricOperand(rule.metricId)),
      ];
      const frame = await service.getDailyEvaluationFrame(
        security,
        range,
        operands,
      );
      for (const rule of rules) {
        const condition = {
          id: "rule",
          metric: { kind: "FUNDAMENTAL" as const, metricId: rule.metricId },
          operator: rule.operator,
          value: rule.value,
        };
        frame.dates.forEach((session, index) => {
          const reading = expectedNumber(rule.metricId, session);
          const expected =
            reading === undefined
              ? Evaluability.NOT_EVALUABLE
              : (
                    rule.operator === "IS_ABOVE"
                      ? reading > rule.value.value
                      : reading < rule.value.value
                  )
                ? Evaluability.TRUE
                : Evaluability.FALSE;
          expect(
            evaluateMarketCondition(condition, frame, index),
            `${session} ${rule.metricId}`,
          ).toBe(expected);
        });
      }
      // The equality cases the table contains decide FALSE: Revenue Growth exactly 0 is not above 0,
      // and Net Debt / EBITDA exactly 0 is not below 0.
      const zeroGrowth = frame.dates.indexOf("2023-01-03");
      expect(
        readOperand(
          frame,
          fundamentalMetricOperand("REVENUE_GROWTH_TTM_YOY"),
          zeroGrowth,
        ),
      ).toBe(0);
      const zeroLeverage = frame.dates.indexOf("2024-10-15");
      expect(
        readOperand(
          frame,
          fundamentalMetricOperand("NET_DEBT_TO_EBITDA_TTM"),
          zeroLeverage,
        ),
      ).toBe(0);
    });

    it("a Monitor reads the newest closed session's value on the provisional session, and the closed row's own", async () => {
      const operands = [
        "price",
        ...FUNDAMENTAL_AUDIT_METRICS.map((metric) =>
          fundamentalMetricOperand(metric.id as never),
        ),
      ];
      const observations = monitorWindowObservations(
        requiredDailySeries(operands),
      );
      for (const closed of FUNDAMENTAL_AUDIT_ANCHOR_BOUNDARIES) {
        const position = sessions.indexOf(closed);
        const next = sessions[position + 1];
        if (next === undefined) {
          continue;
        }
        await service.prepareMonitorEvaluationData(
          security,
          observations,
          closed,
          operands,
        );
        const provisional = await service.readMonitorEvaluationFrame({
          security,
          operands,
          observations,
          asOf: closed,
          observation: { price: 123.45 },
          observationDate: next,
        });
        const repriced = await service.readMonitorEvaluationFrame({
          security,
          operands,
          observations,
          asOf: closed,
          observation: { price: 123.45 },
          observationDate: closed,
        });
        expect(provisional?.observationDate).toBe(next);
        for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
          const key = fundamentalMetricOperand(metric.id as never);
          const closedValue = expectedNumber(metric.id, closed);
          const onProvisional = readOperand(
            provisional!.frame,
            key,
            provisional!.observationIndex,
          );
          const onClosedRow = readOperand(
            provisional!.frame,
            key,
            provisional!.observationIndex - 1,
          );
          const onRepriced = readOperand(
            repriced!.frame,
            key,
            repriced!.observationIndex,
          );
          for (const [label, actual] of [
            ["provisional", onProvisional],
            ["closed row", onClosedRow],
            ["repriced", onRepriced],
          ] as const) {
            if (closedValue === undefined) {
              expect(actual, `${closed} ${metric.id} ${label}`).toBeNaN();
            } else {
              expect(
                Object.is(actual, closedValue),
                `${closed} ${metric.id} ${label}: ${actual}`,
              ).toBe(true);
            }
          }
        }
      }
      expect(provider.calls).toEqual([]);
    });

    it("a Monitor opens after the close that first holds, holds through unavailability, resolves on a decidable false", async () => {
      const definition = normalizeStrategyDefinition({
        schemaVersion: 2,
        buyLevels: [
          {
            id: "buy",
            percentage: 100,
            signal: {
              conditions: [
                {
                  id: "roic",
                  metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
                  operator: "IS_ABOVE",
                  value: { kind: "PERCENT", value: 15 },
                },
              ],
            },
          },
        ],
        sellLevels: [],
      });
      const [level] = monitorStrategyLevels(definition);
      const operands = collectOperands(definition);
      const observations = monitorWindowObservations(
        requiredDailySeries(operands),
      );
      const backtest = await service.getDailyEvaluationFrame(
        security,
        range,
        operands,
      );
      const condition = definition.buyLevels[0]!.signal.conditions[0]!;
      let lifecycle = INITIAL_MONITOR_LEVEL_LIFECYCLE;
      const opened: string[] = [];
      const resolved: string[] = [];
      const heldUnavailable: string[] = [];
      const first = sessions.indexOf("2024-07-29");
      const last = sessions.indexOf("2025-08-20");
      for (let index = first; index <= last; index += 1) {
        const closed = sessions[index - 1]!;
        const provisional = sessions[index]!;
        await service.prepareMonitorEvaluationData(
          security,
          observations,
          closed,
          operands,
        );
        const projected = await service.readMonitorEvaluationFrame({
          security,
          operands,
          observations,
          asOf: closed,
          observation: { price: 100 },
          observationDate: provisional,
        });
        const rules = observeMonitorLevel(
          level!,
          projected!.frame,
          projected!.observationIndex,
        );
        // The Monitor's provisional session decides exactly what the backtest decided on the close
        // before it: the same stored value through the same predicate (the documented one-session
        // framing of a statement event).
        expect(rules[0]!.conditions, provisional).toBe(
          evaluateMarketCondition(
            condition,
            backtest,
            backtest.dates.indexOf(closed),
          ),
        );
        const result = stepMonitorLevel(lifecycle, {
          date: provisional,
          eligible: true,
          rules,
        });
        if (result.opened) {
          opened.push(provisional);
        }
        if (result.closed) {
          resolved.push(provisional);
        }
        if (
          rules[0]!.conditions === Evaluability.NOT_EVALUABLE &&
          result.next.state === "ACTIVE"
        ) {
          heldUnavailable.push(provisional);
        }
        lifecycle = result.next;
      }
      // ROIC is 18 from the 2024-08-02 close, so the first provisional session to see it is 08-05.
      expect(opened).toEqual(["2024-08-05"]);
      // Unavailable on the 2024-08-20 … 09-13 closes: the occurrence stays open, never resolved by a
      // reading that cannot be decided.
      expect(heldUnavailable[0]).toBe("2024-08-21");
      expect(heldUnavailable.at(-1)).toBe("2024-09-16");
      // 12 from the 2025-08-15 close: resolved on the next provisional session.
      expect(resolved).toEqual(["2025-08-18"]);
      expect(provider.calls).toEqual([]);
    }, 180_000);

    it("survives a Redis flush: the same history is reconstructed from PostgreSQL alone, PostgreSQL untouched", async () => {
      const before = await persistedText();
      const keys = await namespaceKeys();
      expect(keys.length).toBeGreaterThan(0);
      await redis.del(...keys);
      expect(await namespaceKeys()).toEqual([]);
      for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
        const response = await fetchApi(metric.id);
        expect(response.status).toBe(200);
        expect(response.body, metric.id).toEqual(apiHistory.get(metric.id));
      }
      const after = await persistedText();
      expect(after).toEqual(before);
      expect(provider.calls).toEqual([]);
      const cached = await cache.readDailyDerivedState(security.id, range);
      expect(cached?.length).toBe(sessions.length);
    });

    it("an eviction takes the Fundamentals with the rest of the security, and the next read rebuilds nothing", async () => {
      const before = await persistedText();
      const ownKeys = async () =>
        (await namespaceKeys()).filter((key) =>
          key.includes(`:security:${security.id}:`),
        );
      expect(
        (await ownKeys()).some((key) => key.includes(":daily-state:")),
      ).toBe(true);
      await cache.evict(security.id);
      // No orphan: every registered key of the security is gone, the yearly chunks included.
      expect(await ownKeys()).toEqual([]);
      expect(await cache.hasResidentStock(security.id)).toBe(false);
      const rebuilds = vi.spyOn(
        CanonicalStockDataService.prototype as unknown as {
          rebuildDailyDerivedState: () => Promise<unknown>;
        },
        "rebuildDailyDerivedState",
      );
      try {
        for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
          const response = await fetchApi(metric.id);
          expect(response.status).toBe(200);
          expect(response.body, metric.id).toEqual(apiHistory.get(metric.id));
        }
        expect(rebuilds).not.toHaveBeenCalled();
      } finally {
        rebuilds.mockRestore();
      }
      expect(await persistedText()).toEqual(before);
      expect(provider.calls).toEqual([]);
    });

    it("the least recently used security is evicted whole when another is published, Fundamentals included", async () => {
      // A cache holding one resident security: publishing a second evicts the first entirely.
      const lruNamespace = `${namespace}:lru`;
      const lru = new RedisStockDataCache(
        new IoredisCacheClient(redis),
        1,
        lruNamespace,
      );
      const lruService = new CanonicalStockDataService(
        store,
        provider,
        lru,
        new RedlockLoadCoordinator(redis, {
          lockDurationMs: 30_000,
          lockWaitMs: 30_000,
        }),
        { productHistoryYears: 30 },
      );
      const lruKeys = async (securityId: string) =>
        (await namespaceKeys()).filter((key) =>
          key.startsWith(`${lruNamespace}:security:${securityId}:`),
        );
      expect(
        await lruService.getDailyFundamentalMetric(symbol, "ROIC_TTM", range),
      ).toEqual(apiHistory.get("ROIC_TTM"));
      expect(
        (await lruKeys(security.id)).some((key) =>
          key.includes(":daily-state:"),
        ),
      ).toBe(true);

      const otherSymbol = `FL${suffix}`;
      const other = await prisma.security.create({
        data: {
          providerSymbol: otherSymbol,
          symbol: otherSymbol,
          name: "Fundamental Audit Neighbour Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      try {
        const today = new Date().toISOString().slice(0, 10);
        const syncedAt = new Date().toISOString();
        await store.saveDailyPriceSync({
          securityId: other.id,
          prices: sessions.slice(-40).map((date) => ({
            securityId: other.id,
            date,
            open: 20,
            high: 20,
            low: 20,
            close: 20,
            volume: 100,
          })),
          successfulCoverage: [
            { from: subtractYears(today, priceRetentionYears(30)), to: today },
          ],
          syncedAt,
          tailDate: today,
          freshThrough: today,
        });
        for (const operation of fundamentalsDatasetOperations(30)) {
          await store.upsertDatasetState({
            securityId: other.id,
            dataset: operation.dataset,
            variant: operation.variant,
            syncedAt,
          });
        }
        await store.upsertDatasetState({
          securityId: other.id,
          dataset: "SECURITY_PROFILE",
          variant: "",
          syncedAt,
        });
        await lruService.getDailyDerivedState(otherSymbol, range);
        expect(await lru.hasResidentStock(other.id)).toBe(true);
        expect(await lru.hasResidentStock(security.id)).toBe(false);
        expect(await lruKeys(security.id)).toEqual([]);
        // Read again, the evicted security is reconstructed from PostgreSQL, value for value.
        expect(
          await lruService.getDailyFundamentalMetric(symbol, "ROIC_TTM", range),
        ).toEqual(apiHistory.get("ROIC_TTM"));
        expect(provider.calls).toEqual([]);
      } finally {
        await prisma.security.deleteMany({ where: { id: other.id } });
      }
    });
  },
);
