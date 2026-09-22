import { STOCK_DETAILS_MAX_HISTORY_YEARS } from "@intrinsic/contracts";
import {
  getApiConfig,
  getFmpConfig,
  getFmpTrafficConfig,
  getRedisConfig,
  getStockDataConfig,
  loadRootEnv,
} from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { EXECUTION_CALENDAR_REFERENCE_CODE } from "@intrinsic/domain";
import { FmpClient } from "@intrinsic/fmp";
import { createLogger } from "@intrinsic/observability";
import {
  CanonicalStockDataService,
  createStockDataRedisClient,
  IoredisCacheClient,
  PrismaStockDataStore,
  RedisFmpRequestGate,
  RedisStockDataCache,
  RedlockLoadCoordinator,
} from "@intrinsic/stock-data";
import { QA_MATRIX_SECURITIES } from "@intrinsic/testing";

/**
 * Re-verifies a stock's whole stored history against the provider, through the ordinary loader.
 *
 * The product's reads are lazy and narrow, and its datasets heal themselves: bumping
 * `PRICE_DATASET_VERSION` makes every earlier coverage interval invisible, and the next read that
 * needs a range fetches it again and replaces what was stored for those dates. That is the repair
 * mechanism — but "the next read" is a user opening a page, which is no way to say "we intend this
 * universe to be re-verified now, deliberately, and to see what changed".
 *
 * This is that way, and deliberately only that. It resolves symbols and calls
 * `getDailyDerivedState` over the range, so the hydration lock, the provider gate, coverage
 * subtraction, PostgreSQL persistence, the Redis projection and the derived-state rebuild are all
 * the canonical implementations; a resynced security is indistinguishable from one a page read
 * happened to materialize. It then reports what the data now says, because a repair nobody verified
 * is a claim rather than a result:
 *
 * - the stored bounds against what coverage claims, per dataset;
 * - the sessions the execution-calendar benchmark has that the security does not, inside its own
 *   covered range. A real halt or a late listing legitimately produces one, so this is a list to
 *   read rather than a failure — the audit's source-data section is what compares bars against the
 *   provider's own payloads.
 *
 * Usage:
 *
 * ```bash
 * pnpm data:resync --matrix --from 1992-01-01
 * pnpm data:resync --symbol MRNA --symbol ADBE --from 2020-01-01
 * pnpm data:resync --matrix --from 1992-01-01 --verify-only
 * ```
 */

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

type ResyncArguments = {
  readonly symbols: readonly string[];
  readonly from: string;
  readonly to: string;
  /** Report what the stored data says without asking the provider for anything. */
  readonly verifyOnly: boolean;
};

export function parseResyncArguments(
  argv: readonly string[],
  today: string,
  matrixSymbols: readonly string[],
): ResyncArguments {
  const symbols: string[] = [];
  let from: string | undefined;
  let to: string | undefined;
  let verifyOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--symbol":
        if (!value) {
          throw new Error("--symbol needs a ticker, e.g. --symbol MRNA");
        }
        symbols.push(value.toUpperCase());
        index += 1;
        break;
      case "--matrix":
        symbols.push(...matrixSymbols);
        break;
      case "--from":
        from = value;
        index += 1;
        break;
      case "--to":
        to = value;
        index += 1;
        break;
      case "--verify-only":
        verifyOnly = true;
        break;
      default:
        throw new Error(
          `Unknown argument '${String(flag)}'. Usage: (--matrix | --symbol SYMBOL ...) ` +
            "--from YYYY-MM-DD [--to YYYY-MM-DD] [--verify-only]",
        );
    }
  }

  if (symbols.length === 0) {
    throw new Error("Nothing to resync: pass --matrix or at least one --symbol");
  }
  if (!from || !LOCAL_DATE.test(from)) {
    throw new Error("--from is required and must be YYYY-MM-DD");
  }
  const resolvedTo = to ?? today;
  if (!LOCAL_DATE.test(resolvedTo)) {
    throw new Error("--to must be YYYY-MM-DD");
  }
  if (from > resolvedTo) {
    throw new Error(`--from ${from} is after --to ${resolvedTo}`);
  }
  return {
    symbols: [...new Set(symbols)],
    from,
    to: resolvedTo,
    verifyOnly,
  };
}

/**
 * Refuses to run against a database that must never reach a provider.
 *
 * The matrix database's whole premise is that it makes no provider request, and the test database
 * holds fictional fixtures that a real payload would overwrite. Both are named, so both can be
 * refused before a connection is opened.
 */
export function assertResyncTargetAllowed(databaseUrl: string): void {
  const name = databaseUrl.split("?")[0]!.split("/").pop() ?? "";
  if (/matrix|test/i.test(name)) {
    throw new Error(
      `Refusing to resync \`${name}\`. This asks a provider for real history; the matrix and test ` +
        "databases are copies and fixtures, and a provider payload in either of them is a defect.",
    );
  }
}

type DatasetFacts = {
  readonly dataset: string;
  readonly variant: string;
  readonly stateEarliest: string | null;
  readonly stateLatest: string | null;
  readonly coverageFrom: string | null;
  readonly coverageTo: string | null;
  readonly coverageRows: number;
};

const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

async function datasetFacts(
  prisma: PrismaClient,
  securityId: string,
): Promise<DatasetFacts[]> {
  const [states, coverage] = await Promise.all([
    prisma.stockDatasetState.findMany({ where: { securityId } }),
    prisma.stockDatasetCoverage.groupBy({
      by: ["dataset", "variant"],
      where: { securityId },
      _min: { fromDate: true },
      _max: { toDate: true },
      _count: { _all: true },
    }),
  ]);
  return states
    .map((state) => {
      const interval = coverage.find(
        (row) => row.dataset === state.dataset && row.variant === state.variant,
      );
      return {
        dataset: state.dataset,
        variant: state.variant,
        stateEarliest: iso(state.earliestDate),
        stateLatest: iso(state.latestDate),
        coverageFrom: iso(interval?._min.fromDate ?? null),
        coverageTo: iso(interval?._max.toDate ?? null),
        coverageRows: interval?._count._all ?? 0,
      };
    })
    .sort((left, right) => (left.dataset < right.dataset ? -1 : 1));
}

async function executionCalendar(
  prisma: PrismaClient,
  range: { from: string; to: string },
): Promise<string[]> {
  const benchmark = await prisma.benchmark.findFirst({
    where: { code: EXECUTION_CALENDAR_REFERENCE_CODE },
    include: { series: { orderBy: { version: "desc" }, take: 1 } },
  });
  const series = benchmark?.series[0];
  if (!series) {
    return [];
  }
  const bars = await prisma.benchmarkDailyPrice.findMany({
    where: {
      seriesId: series.id,
      date: {
        gte: new Date(`${range.from}T00:00:00.000Z`),
        lte: new Date(`${range.to}T00:00:00.000Z`),
      },
    },
    select: { date: true },
    orderBy: { date: "asc" },
  });
  return bars.map((bar) => bar.date.toISOString().slice(0, 10));
}

async function resync(): Promise<void> {
  loadRootEnv();
  const apiConfig = getApiConfig();
  const logger = createLogger({
    service: "api",
    level: apiConfig.logLevel,
    environment: apiConfig.environment,
    base: { component: "stock-resync" },
  });

  const { symbols, from, to, verifyOnly } = parseResyncArguments(
    process.argv.slice(2),
    new Date().toISOString().slice(0, 10),
    QA_MATRIX_SECURITIES.map((entry) => entry.symbol),
  );
  const databaseUrl = process.env.DATABASE_URL ?? "";
  assertResyncTargetAllowed(databaseUrl);

  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(getRedisConfig().url, (err) => {
    logger.warn({ event: "stock-data.redis.error", err });
  });
  const traffic = getFmpTrafficConfig();
  const stockData = getStockDataConfig();
  let providerRequests = 0;
  const service = new CanonicalStockDataService(
    new PrismaStockDataStore(prisma),
    new FmpClient(() => getFmpConfig(), fetch, {
      gate: new RedisFmpRequestGate(redis, {
        maxConcurrentRequests: traffic.maxConcurrentRequests,
        rateLimitPerWindow: traffic.rateLimitPerWindow,
        rateWindowMs: traffic.rateWindowMs,
        maxQueueDepth: traffic.maxQueueDepth,
        maxQueueWaitMs: traffic.maxQueueWaitMs,
        requestLeaseMs: traffic.timeoutMs * 2,
      }),
    }),
    new RedisStockDataCache(
      new IoredisCacheClient(redis),
      stockData.maxResidentStocks,
    ),
    new RedlockLoadCoordinator(redis, {
      lockDurationMs: stockData.loadLockDurationMs,
      lockWaitMs: stockData.loadLockWaitMs,
    }),
    {
      defaultHistoryDays: stockData.defaultHistoryDays,
      productHistoryYears: stockData.productHistoryYears,
      stockDetailsHistoryYears: STOCK_DETAILS_MAX_HISTORY_YEARS,
      recentPriceFreshnessMs: stockData.recentPriceFreshnessMs,
      fundamentalsFreshnessMs: stockData.fundamentalsFreshnessMs,
      recentTailCalendarDays: stockData.recentTailCalendarDays,
      onProviderRequest: (request) => {
        providerRequests += 1;
        logger.debug({ event: "stock.resync.provider.request", ...request });
      },
    },
  );

  let failures = 0;
  const gaps: { symbol: string; missing: string[] }[] = [];
  const disagreements: string[] = [];
  try {
    await prisma.$connect();
    const calendar = await executionCalendar(prisma, { from, to });
    console.log(
      `${verifyOnly ? "Verifying" : "Resyncing"} ${symbols.length} security(ies) ` +
        `${from} → ${to}; execution calendar has ${calendar.length} session(s) in that range.`,
    );

    for (const symbol of symbols) {
      const startedAt = Date.now();
      const before = providerRequests;
      try {
        const security = await service.getSecurity(symbol);
        if (!verifyOnly) {
          await service.getDailyDerivedState(symbol, { from, to });
        }
        const [prices, bounds, facts] = await Promise.all([
          prisma.dailyPrice.count({ where: { securityId: security.id } }),
          prisma.dailyPrice.aggregate({
            where: { securityId: security.id },
            _min: { date: true },
            _max: { date: true },
          }),
          datasetFacts(prisma, security.id),
        ]);
        const first = iso(bounds._min.date ?? null);
        const last = iso(bounds._max.date ?? null);
        const stored = new Set(
          (
            await prisma.dailyPrice.findMany({
              where: {
                securityId: security.id,
                date: {
                  gte: new Date(`${first ?? from}T00:00:00.000Z`),
                  lte: new Date(`${last ?? to}T00:00:00.000Z`),
                },
              },
              select: { date: true },
            })
          ).map((row) => row.date.toISOString().slice(0, 10)),
        );
        const missing = calendar.filter(
          (date) =>
            first !== null &&
            last !== null &&
            date >= first &&
            date <= last &&
            !stored.has(date),
        );
        if (missing.length > 0) {
          gaps.push({ symbol, missing });
        }
        console.log(
          `${symbol}: ${prices} bar(s) ${first ?? "-"} → ${last ?? "-"}; ` +
            `${providerRequests - before} provider request(s); ` +
            `${missing.length} calendar session(s) absent inside its own range; ` +
            `${Date.now() - startedAt}ms`,
        );
        for (const fact of facts) {
          // Only the datasets that record intervals can be checked against them. Fundamentals and
          // the price loader's `recent-tail` freshness marker keep state alone by design, so
          // demanding coverage of them would report a disagreement that does not exist.
          const comparable = fact.coverageRows > 0;
          const agrees =
            fact.stateEarliest === fact.coverageFrom &&
            fact.stateLatest === fact.coverageTo;
          if (comparable && !agrees) {
            disagreements.push(
              `${symbol} ${fact.dataset}/${fact.variant}: state ` +
                `${fact.stateEarliest ?? "-"} → ${fact.stateLatest ?? "-"} against coverage ` +
                `${fact.coverageFrom ?? "-"} → ${fact.coverageTo ?? "-"}`,
            );
          }
          console.log(
            `    ${fact.dataset}${fact.variant ? `/${fact.variant}` : ""}: ` +
              `state ${fact.stateEarliest ?? "-"} → ${fact.stateLatest ?? "-"}` +
              (comparable
                ? `, coverage ${fact.coverageFrom ?? "-"} → ${fact.coverageTo ?? "-"} ` +
                  `over ${fact.coverageRows} interval(s)${agrees ? "" : "  <-- state and coverage disagree"}`
                : " (no coverage intervals: this dataset records state only)"),
          );
        }
      } catch (error) {
        failures += 1;
        logger.error({ event: "stock.resync.failed", symbol, err: error });
        console.error(
          `${symbol}: failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    console.log("");
    console.log(`Provider requests: ${providerRequests}`);
    console.log(
      disagreements.length === 0
        ? "Coverage agrees with dataset state everywhere coverage is recorded."
        : `${disagreements.length} coverage disagreement(s):\n  ${disagreements.join("\n  ")}`,
    );
    if (gaps.length === 0) {
      console.log(
        "Every security holds a bar on every execution-calendar session inside its own range.",
      );
    } else {
      console.log(
        `${gaps.length} security(ies) miss at least one calendar session inside their range:`,
      );
      for (const gap of gaps) {
        console.log(
          `  ${gap.symbol}: ${gap.missing.length} — ${gap.missing.slice(0, 10).join(", ")}${gap.missing.length > 10 ? ", …" : ""}`,
        );
      }
    }
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1]?.includes("resync-canonical-stock-data")) {
  void resync();
}
