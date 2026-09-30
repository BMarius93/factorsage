import { createHash } from "node:crypto";
import type { PrismaClient } from "@intrinsic/database";
import type { Security } from "@intrinsic/domain";
import {
  CanonicalStockDataService,
  IoredisCacheClient,
  PrismaStockDataStore,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  createStockDataRedisClient,
  dailyStateChunkKey,
  decodeDailyStateChunk,
  materializeDailyFundamentals,
  subtractYears,
} from "@intrinsic/stock-data";
import { collectOperands } from "@intrinsic/strategy";
import { QA_MATRIX_FUNDAMENTAL_STRATEGIES } from "@intrinsic/testing";
import type { BacktestArchive } from "../backtests/archive-reader";
import {
  FrameProvenance,
  type FundamentalReference,
} from "../backtests/frame-provenance";
import { ComparisonLedger } from "../comparison";
import { prismaFloatBoundAtScale } from "../oracle/decimal";
import { ORACLE_FUNDAMENTAL_METRICS } from "../oracle/fundamentals";
import { FUNDAMENTALS_RETENTION_YEARS } from "./run-fundamentals-audit";

/** What the full-scale checks saw (audit section 36). */
export type FundamentalScaleReport = {
  ledger: ComparisonLedger;
  securities: number;
  chunks: number;
  yearBoundaries: number;
  slowestMaterializeMs: number;
  slowestHydrationMs: number;
};

/**
 * The Fundamentals dimension's frames, projected by the production projector over the audited
 * database, traced back to the persisted rows by the frame-provenance audit.
 *
 * A backtest worker reads one frame per calendar-year window with exactly the operands its strategy
 * names; this reads the same windows through the same `CanonicalStockDataService` methods, for every
 * audited security and for the union of the Fundamental operands `F01` … `F10` name (all fifteen),
 * then audits each fixture's definition against them — so every `fundamental:*` column a Fundamentals
 * run could consume is compared, exactly, with the stored value on its own session, and a metric a
 * fixture names but a frame lacks would fail. The provider refuses every request: the data must
 * already be durable, and nothing here may fetch.
 *
 * The same hydrations carry the full-scale checks (audit section 36), per security and over its
 * whole retained history:
 *
 * - every year of the derived coverage has its published `daily-state` chunk, readable by the
 *   canonical decoder and holding exactly the stored rows of that year, each Fundamental
 *   `Object.is` the stored decimal and omitted where it is `NULL` — year boundaries included;
 * - the production materializer, run again here on the rebuild's own inputs (the retained revisions
 *   and the stored sessions), reproduces the stored text of every Fundamental on every covered
 *   session: the persisted state is a deterministic function of the statements;
 * - an eviction followed by a second hydration publishes byte-identical chunks.
 */
export async function auditFundamentalFrames(input: {
  prisma: PrismaClient;
  redisUrl: string;
  securities: readonly { securityId: string; symbol: string }[];
  references: ReadonlyMap<string, FundamentalReference>;
  /** The audited database's data clock: the newest covered day. */
  asOf: string;
  horizonStart: string;
  log: (line: string) => void;
}): Promise<{
  provenance: FrameProvenance;
  frames: number;
  providerCalls: string[];
  scale: FundamentalScaleReport;
}> {
  const providerCalls: string[] = [];
  const refuse = (call: string): never => {
    providerCalls.push(call);
    throw new Error(
      `the fundamental frame audit may not reach the provider (${call})`,
    );
  };
  const provider = {
    getProfile: async (symbol: string) => refuse(`profile ${symbol}`),
    getDailyPrices: async (symbol: string) => refuse(`prices ${symbol}`),
    getFinancialStatements: async (symbol: string, _id: string, type: string) =>
      refuse(`statements ${symbol} ${type}`),
  } as never;
  const redis = createStockDataRedisClient(input.redisUrl);
  const namespace = `stock-data:v2:audit-fundamental-frames:${Date.now()}`;
  const tenYears = 10 * 365 * 24 * 60 * 60 * 1_000;
  const store = new PrismaStockDataStore(input.prisma);
  const cache = new RedisStockDataCache(
    new IoredisCacheClient(redis),
    50,
    namespace,
  );
  const service = new CanonicalStockDataService(
    store,
    provider,
    cache,
    new RedlockLoadCoordinator(redis, {
      lockDurationMs: 120_000,
      lockWaitMs: 120_000,
    }),
    {
      productHistoryYears: 30,
      now: () => new Date(`${input.asOf}T12:00:00.000Z`),
      recentPriceFreshnessMs: tenYears,
      fundamentalsFreshnessMs: tenYears,
    },
  );
  const operands = [
    ...new Set(
      QA_MATRIX_FUNDAMENTAL_STRATEGIES.flatMap((fixture) =>
        collectOperands(fixture.definition).filter(
          (key) => key === "price" || key.startsWith("fundamental:"),
        ),
      ),
    ),
  ].sort();
  // Frame provenance walks frames whose security has a technical reference; the Fundamental columns
  // need only the session axis, which the stored rows supply.
  const axes = new Map(
    [...input.references].map(([securityId, reference]) => [
      securityId,
      {
        dates: [...reference.dates],
        values: new Map(),
        weekStart: reference.dates.map(() => null),
      },
    ]),
  );
  const provenance = new FrameProvenance(axes, new Map(), input.references);
  const scale: FundamentalScaleReport = {
    ledger: new ComparisonLedger(),
    securities: 0,
    chunks: 0,
    yearBoundaries: 0,
    slowestMaterializeMs: 0,
    slowestHydrationMs: 0,
  };
  const chunkKey = (securityId: string, year: number) =>
    dailyStateChunkKey(namespace, securityId, year);
  let frames = 0;

  function digest(payload: string | null): string | null {
    return payload === null
      ? null
      : createHash("sha256").update(payload).digest("hex");
  }

  /** The published chunks and a fresh materialization, both against the stored rows. */
  async function auditPublishedScale(
    security: Security,
    reference: FundamentalReference,
  ): Promise<{ years: number[]; digests: (string | null)[] } | null> {
    const manifest = await cache.getManifest(security.id);
    const from = manifest?.coverageStart;
    const to = manifest?.coverageEnd;
    if (!from || !to) {
      scale.ledger.check(
        "fundamental-scale:manifest",
        security.symbol,
        "a READY coverage",
        "none",
        "exact-text",
      );
      return null;
    }
    scale.securities += 1;
    const years: number[] = [];
    for (
      let year = Number(from.slice(0, 4));
      year <= Number(to.slice(0, 4));
      year += 1
    ) {
      years.push(year);
    }
    const payloads = await redis.mget(
      ...years.map((year) => chunkKey(security.id, year)),
    );
    const cached = new Map<string, Record<string, unknown>>();
    years.forEach((year, index) => {
      const payload = payloads[index] ?? null;
      // Read through the one canonical decoder, exactly as the cache reads it: a chunk it cannot
      // decode is a failure here, never a chunk this audit parses its own way.
      const decoded =
        payload === null
          ? null
          : decodeDailyStateChunk(payload, { securityId: security.id, year });
      scale.ledger.check(
        "fundamental-scale:chunk",
        `${security.symbol}/${year}`,
        "published",
        decoded === null
          ? "missing"
          : decoded.ok
            ? "published"
            : `unreadable: ${decoded.reason}`,
        "exact-text",
      );
      scale.chunks += decoded?.ok ? 1 : 0;
      for (const row of decoded?.ok ? decoded.rows : []) {
        cached.set(row.date, row as unknown as Record<string, unknown>);
      }
    });
    const covered = reference.dates.flatMap((date, index) =>
      date >= from && date <= to ? [{ date, index }] : [],
    );
    scale.ledger.check(
      "fundamental-scale:rows",
      security.symbol,
      covered.length,
      [...cached.keys()].filter((date) => date >= from && date <= to).length,
      "exact-number",
    );
    for (let index = 1; index < covered.length; index += 1) {
      if (
        covered[index]!.date.slice(0, 4) !==
        covered[index - 1]!.date.slice(0, 4)
      ) {
        scale.yearBoundaries += 1;
      }
    }

    // The production materializer again, on the rebuild's own inputs: the statement retention the
    // rebuild reads (thirty-seven years, clamped to the listing) and the stored sessions.
    const materializeStarted = Date.now();
    const horizon = subtractYears(input.asOf, FUNDAMENTALS_RETENTION_YEARS);
    const statements = await store.getFinancialStatementRevisions({
      securityId: security.id,
      from:
        security.ipoDate && security.ipoDate > horizon
          ? security.ipoDate
          : horizon,
      to: input.asOf,
    });
    const fresh = new Map(
      materializeDailyFundamentals({
        securityId: security.id,
        tradingDates: [...reference.dates],
        statements,
      }).map((row) => [
        row.date,
        row as unknown as Record<string, number | undefined>,
      ]),
    );
    scale.slowestMaterializeMs = Math.max(
      scale.slowestMaterializeMs,
      Date.now() - materializeStarted,
    );

    for (const { date, index } of covered) {
      const row = cached.get(date);
      const again = fresh.get(date);
      for (const metric of ORACLE_FUNDAMENTAL_METRICS) {
        const stored = reference.stored[metric.column]?.[index] ?? null;
        const path = `${security.symbol}/${date}/${metric.id}`;
        // Absence in a chunk is an omitted key; a JSON null or a missing row is a failure.
        const inChunk =
          row === undefined
            ? "row missing"
            : !(metric.column in row)
              ? null
              : row[metric.column] === null
                ? "JSON null"
                : row[metric.column];
        scale.ledger.check(
          "fundamental-scale:redis",
          path,
          stored,
          inChunk,
          "exact-number",
        );
        const value = again?.[metric.column];
        // The stored decimal of the fresh value, bound exactly as the write path binds it.
        const materialized =
          value === undefined
            ? null
            : Number(prismaFloatBoundAtScale(value, 8));
        scale.ledger.check(
          "fundamental-scale:recompute",
          path,
          stored,
          materialized,
          "exact-number",
        );
      }
    }
    return {
      years,
      digests: payloads.map((payload) => digest(payload ?? null)),
    };
  }

  try {
    const catalog = await service.findSecuritiesByIds(
      input.securities.map((security) => security.securityId),
    );
    for (const security of catalog as Security[]) {
      // The product horizon at this data clock: nothing older may be projected for a backtest.
      const productStart = `${Number(input.asOf.slice(0, 4)) - 30}${input.asOf.slice(4)}`;
      const period = {
        from:
          input.horizonStart > productStart ? input.horizonStart : productStart,
        to: input.asOf,
      };
      const hydrationStarted = Date.now();
      await service.prepareDailyEvaluationData(security, period, operands);
      scale.slowestHydrationMs = Math.max(
        scale.slowestHydrationMs,
        Date.now() - hydrationStarted,
      );
      const reference = input.references.get(security.id);
      const published = reference
        ? await auditPublishedScale(security, reference)
        : null;
      const archiveFrames: BacktestArchive["frames"] = [];
      for (
        let year = Number(period.from.slice(0, 4));
        year <= Number(period.to.slice(0, 4));
        year += 1
      ) {
        const window = {
          from:
            year === Number(period.from.slice(0, 4))
              ? period.from
              : `${year}-01-01`,
          to:
            year === Number(period.to.slice(0, 4))
              ? period.to
              : `${year}-12-31`,
        };
        const frame = await service.readDailyEvaluationFrame(
          security,
          window,
          operands,
        );
        archiveFrames.push({
          securityId: security.id,
          symbol: security.symbol,
          year: String(year),
          contextRowCount: frame.periodStartIndex,
          dates: [...frame.dates],
          closes: [...frame.closes].map((close) =>
            Number.isFinite(close) ? close : null,
          ),
          // An archive writes NaN as null, which is what the audit compares against NULL.
          operands: Object.fromEntries(
            [...frame.columns].map(([key, column]) => [
              key,
              [...column].map((value) =>
                Number.isFinite(value) ? value : null,
              ),
            ]),
          ),
          window: { requestedFrom: window.from, requestedTo: window.to },
        });
        frames += 1;
      }
      for (const fixture of QA_MATRIX_FUNDAMENTAL_STRATEGIES) {
        provenance.audit({
          path: `${fixture.id}/${security.symbol}`,
          snapshot: {
            period: { startDate: period.from, endDate: period.to },
            strategy: { definition: fixture.definition, name: fixture.name },
          },
          frames: archiveFrames,
        } as unknown as BacktestArchive);
      }
      if (published) {
        // Evicted and hydrated again from nothing: the same bytes.
        await cache.evict(security.id);
        await service.prepareDailyEvaluationData(security, period, operands);
        const again = await redis.mget(
          ...published.years.map((year) => chunkKey(security.id, year)),
        );
        published.years.forEach((year, index) => {
          scale.ledger.check(
            "fundamental-scale:republish",
            `${security.symbol}/${year}`,
            published.digests[index],
            digest(again[index] ?? null),
            "exact-text",
          );
        });
      }
      input.log(
        `  fundamental frames ${security.symbol}: ${archiveFrames.length} windows`,
      );
    }
  } finally {
    redis.disconnect();
  }
  // The projections this read published are disposable and belong to no product namespace.
  const cleanup = createStockDataRedisClient(input.redisUrl);
  try {
    let cursor = "0";
    do {
      const [next, keys] = await cleanup.scan(
        cursor,
        "MATCH",
        `${namespace}:*`,
        "COUNT",
        1_000,
      );
      cursor = next;
      if (keys.length > 0) {
        await cleanup.del(...keys);
      }
    } while (cursor !== "0");
  } finally {
    cleanup.disconnect();
  }
  return { provenance, frames, providerCalls, scale };
}
