import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { loadRootEnv } from "@intrinsic/config";
import {
  STRATEGY_ETF_SOURCES,
  type StrategyEtfSourceCode,
} from "@intrinsic/contracts";
import { PrismaClient } from "@intrinsic/database";
import type {
  BenchmarkDailyPrice,
  BenchmarkSeries,
  DateRange,
  LocalDate,
} from "@intrinsic/domain";
import type { FmpBenchmarkProviderPort } from "@intrinsic/fmp";
import { createLogger } from "@intrinsic/observability";
import {
  addDays,
  BENCHMARK_TECHNICAL_FIELDS,
  buildBenchmarkTechnicalContext,
  CanonicalBenchmarkDataService,
  createStockDataRedisClient,
  InMemoryLoadCoordinator,
  IoredisCacheClient,
  MARKET_OVERVIEW_HISTORY_FLOOR,
  PrismaBenchmarkDataStore,
  RedisBenchmarkDataCache,
  withEtfOperandColumns,
  type BenchmarkTechnicalSnapshot,
  type LoadCoordinator,
} from "@intrinsic/stock-data";
import {
  createEvaluationFrame,
  etfOperand,
  type OperandKey,
} from "@intrinsic/strategy";
import { useTestDatabase } from "@intrinsic/testing";
import {
  loadEtfTechnicalSnapshots,
  type EtfContextLoader,
} from "./etf-context.js";

/**
 * Developer-only benchmark of the ETF technical context a Strategy's ETF conditions read
 * (`ai/architecture/strategy-etf-conditions.md` §9).
 *
 * It drives the **production path** — `loadEtfTechnicalSnapshots` over
 * `CanonicalBenchmarkDataService` on a real PostgreSQL and a real Redis, then
 * `withEtfOperandColumns` onto evaluation frames — and replaces exactly one boundary, the provider,
 * with a synthetic history used only to bootstrap. Nothing measured is a test double.
 *
 * What it answers, with numbers rather than estimates:
 *
 * - how long one ETF's full-history context takes to read and compute — from a warm Redis, after a
 *   Redis loss, and from PostgreSQL alone;
 * - how much memory one context holds;
 * - what joining ETF columns onto every security's frames costs, for an ordinary strategy and for
 *   the worst case of every fund and every metric;
 * - that what is read grows with the distinct ETFs, never with the securities or rules.
 *
 * It writes only to the dedicated test database (`useTestDatabase`) and to a namespaced Redis key
 * space, and removes both afterwards. It never touches the development database and never calls
 * FMP.
 *
 * ```bash
 * pnpm --filter @intrinsic/worker bench:etf-context
 * pnpm --filter @intrinsic/worker bench:etf-context -- --etfs=20 --securities=500 --runs=5 --out=bench.json
 * ```
 *
 * Do not treat local values as universal: the published figures name the machine they came from.
 */

loadRootEnv();
useTestDatabase();

type Args = {
  etfs: number;
  securities: number;
  years: number;
  runs: number;
  out: string | undefined;
};

function parseArgs(argv: readonly string[]): Args {
  const value = (name: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
  const integer = (name: string, fallback: number): number => {
    const parsed = Number(value(name) ?? fallback);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`--${name} must be a positive integer`);
    }
    return parsed;
  };
  const etfs = integer("etfs", STRATEGY_ETF_SOURCES.length);
  if (etfs > STRATEGY_ETF_SOURCES.length) {
    throw new Error(
      `--etfs cannot exceed the ${STRATEGY_ETF_SOURCES.length} funds the product offers`,
    );
  }
  return {
    etfs,
    securities: integer("securities", 500),
    years: integer("years", 30),
    runs: integer("runs", 5),
    out: value("out"),
  };
}

/** The first session of the oldest fund in the universe: SPY's. */
const FIRST: LocalDate = "1993-01-29";

function weekdays(from: string, to: string): LocalDate[] {
  const dates: LocalDate[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(date);
    }
  }
  return dates;
}

/** A synthetic full-length history. Used by the bootstrap alone. */
class SyntheticProvider implements FmpBenchmarkProviderPort {
  requests = 0;
  private readonly index: Map<string, number>;

  constructor(
    private readonly dates: readonly LocalDate[],
    private readonly scale: number,
  ) {
    this.index = new Map(dates.map((date, position) => [date, position]));
  }

  async getBenchmarkDailyPrices(
    _symbol: string,
    seriesId: string,
    range: DateRange,
  ): Promise<BenchmarkDailyPrice[]> {
    this.requests += 1;
    return this.dates
      .filter((date) => date >= (range.from as string) && date <= (range.to as string))
      .map((date) => {
        const position = this.index.get(date) ?? 0;
        const close =
          Math.round(
            this.scale *
              (40 + position * 0.02 + 6 * Math.sin(position / 11) + (position % 5) * 0.2) *
              1e6,
          ) / 1e6;
        return {
          seriesId,
          date,
          open: close,
          high: close,
          low: close,
          close,
          volume: 2_000_000 + (position % 17) * 40_000,
        };
      });
  }
}

class RefusingProvider implements FmpBenchmarkProviderPort {
  requests = 0;
  async getBenchmarkDailyPrices(): Promise<BenchmarkDailyPrice[]> {
    this.requests += 1;
    throw new Error("The ETF evaluation path must never ask the provider");
  }
}

class CountingClient extends IoredisCacheClient {
  chunkReads = 0;
  override async mget(...keys: string[]) {
    this.chunkReads += keys.length;
    return super.mget(...keys);
  }
}

function summary(samples: readonly number[]): {
  min: number;
  median: number;
  max: number;
} {
  const sorted = [...samples].sort((left, right) => left - right);
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    min: round(sorted[0] ?? 0),
    median: round(sorted[Math.floor(sorted.length / 2)] ?? 0),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

function elapsed(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

/** Heap plus typed-array backing stores, after a collection when the runtime exposes one. */
function retainedBytes(): number | null {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (!collect) {
    return null;
  }
  collect();
  collect();
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

/** The 21 operand keys one ETF offers a Condition: its Price and its twenty technical series. */
function everyOperandOf(code: StrategyEtfSourceCode): OperandKey[] {
  return [
    etfOperand(code, "price"),
    ...[
      "SMA_20D",
      "SMA_50D",
      "SMA_100D",
      "SMA_200D",
      "EMA_20D",
      "EMA_50D",
      "EMA_200D",
      "SMA_20W",
      "SMA_50W",
      "SMA_100W",
      "SMA_200W",
      "EMA_20W",
      "EMA_50W",
      "EMA_200W",
      "RSI_7D",
      "RSI_14D",
      "RSI_21D",
    ].map((id) => etfOperand(code, `series:${id}` as OperandKey)),
    ...[10, 20, 50].map((period) =>
      etfOperand(code, `relative-volume:${period}` as OperandKey),
    ),
  ];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const redisUrl =
    process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    throw new Error("The benchmark needs TEST_REDIS_URL or REDIS_URL");
  }
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const namespace = `benchmark:bench:etfctx:${suffix}`;
  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(redisUrl);
  const client = new CountingClient(redis);
  const store = new PrismaBenchmarkDataStore(prisma);
  const cache = new RedisBenchmarkDataCache(client, { namespace });
  const logger = createLogger({ service: "worker", level: "silent" });
  const publicationDelayMs = 30 * 60 * 1000;

  // A fixed clock one day after the newest session, so every stored bar is finalized and the
  // bootstrap's own read is what proves it.
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date(`${today}T23:30:00.000Z`);
  const dates = weekdays(FIRST, addDays(today, -1));
  const funds = STRATEGY_ETF_SOURCES.slice(0, args.etfs);
  const catalogCodes = funds.map((fund) => `BENCH${fund.code}${suffix}`);
  const refusing = new RefusingProvider();

  const service = (
    provider: FmpBenchmarkProviderPort,
    coordinator: LoadCoordinator = new InMemoryLoadCoordinator(),
  ) =>
    new CanonicalBenchmarkDataService(store, provider, cache, coordinator, {
      now: () => now,
    });

  const calls = { count: 0 };
  const loaderOver = (
    benchmarks: CanonicalBenchmarkDataService,
  ): EtfContextLoader => ({
    getSeries: (seriesId) => {
      calls.count += 1;
      return benchmarks.getSeries(seriesId);
    },
    readFullBenchmarkHistory: (series, through) => {
      calls.count += 1;
      return benchmarks.readFullBenchmarkHistory(series, through);
    },
    benchmarkRefreshState: (series) => {
      calls.count += 1;
      return benchmarks.benchmarkRefreshState(series);
    },
    missingBenchmarkCoverage: (series, period) => {
      calls.count += 1;
      return benchmarks.missingBenchmarkCoverage(series, period);
    },
  });

  const clearRedis = async (): Promise<void> => {
    const keys = await redis.keys(`${namespace}*`);
    for (let offset = 0; offset < keys.length; offset += 500) {
      await redis.del(...keys.slice(offset, offset + 500));
    }
  };

  const seriesByCode = new Map<StrategyEtfSourceCode, BenchmarkSeries>();
  try {
    await redis.ping();
    const reconciled = await store.reconcileBenchmarkCatalog(
      catalogCodes.map((code, index) => ({
        code,
        name: code,
        sourceKind: "FMP_SYMBOL" as const,
        seriesType: "ETF_PROXY" as const,
        providerSymbol: `B${index}${suffix}`,
        currency: "USD",
        methodologyVersion: 1,
        isActive: true,
        isBacktestSelectable: false,
        displayOrder: 99,
      })),
    );
    funds.forEach((fund, index) => {
      const row = reconciled.find((entry) => entry.code === catalogCodes[index]);
      if (!row) {
        throw new Error(`No series was registered for ${fund.code}`);
      }
      seriesByCode.set(fund.code, row.series);
    });

    // --- Bootstrap (not a measured product path: the bootstrap command owns it) ---------------
    const bootstrapStarted = process.hrtime.bigint();
    for (const [index, fund] of funds.entries()) {
      await service(new SyntheticProvider(dates, 1 + index * 0.25)).ensureBenchmarkHydrated(
        seriesByCode.get(fund.code)!,
        { from: MARKET_OVERVIEW_HISTORY_FLOOR, to: today },
      );
    }
    const bootstrapMs = elapsed(bootstrapStarted);

    const request = funds.map((fund) => ({
      code: fund.code,
      seriesId: seriesByCode.get(fund.code)!.id,
    }));
    const load = (coordinator?: LoadCoordinator) =>
      loadEtfTechnicalSnapshots({
        series: request,
        loader: loaderOver(service(refusing, coordinator)),
        now,
        publicationDelayMs,
        logger,
      });

    // --- 1. Reading and computing every context ----------------------------------------------
    const warmTotals: number[] = [];
    let chunkReadsPerLoad = 0;
    let callsPerLoad = 0;
    let snapshots: ReadonlyMap<StrategyEtfSourceCode, BenchmarkTechnicalSnapshot> =
      new Map();
    await load(); // prime connections and JIT; not recorded
    for (let run = 0; run < args.runs; run += 1) {
      client.chunkReads = 0;
      calls.count = 0;
      const started = process.hrtime.bigint();
      const loaded = await load();
      warmTotals.push(elapsed(started));
      chunkReadsPerLoad = client.chunkReads;
      callsPerLoad = calls.count;
      snapshots = loaded.snapshots;
      const notReady = loaded.diagnostics.filter((row) => row.status !== "READY");
      if (notReady.length > 0) {
        throw new Error(
          `Contexts were not READY: ${notReady.map((row) => `${row.ticker} ${row.status}`).join(", ")}`,
        );
      }
    }

    const coldTotals: number[] = [];
    for (let run = 0; run < Math.min(args.runs, 3); run += 1) {
      await clearRedis();
      const started = process.hrtime.bigint();
      await load();
      coldTotals.push(elapsed(started));
    }

    const postgresTotals: number[] = [];
    const busy: LoadCoordinator = {
      run: async () => {
        throw new Error("The hydration lock is held elsewhere");
      },
    };
    for (let run = 0; run < Math.min(args.runs, 3); run += 1) {
      await clearRedis();
      const started = process.hrtime.bigint();
      await load(busy);
      postgresTotals.push(elapsed(started));
    }
    // Leave the projection resident again for the remaining measurements.
    await load();

    // --- 2. The computation alone, on inputs already read ------------------------------------
    const first = request[0]!;
    const benchmarks = service(refusing);
    const series = await benchmarks.getSeries(first.seriesId);
    const history = await benchmarks.readFullBenchmarkHistory(series);
    const refreshState = await benchmarks.benchmarkRefreshState(series);
    const computeSamples: number[] = [];
    for (let run = 0; run < Math.max(args.runs, 10); run += 1) {
      const started = process.hrtime.bigint();
      buildBenchmarkTechnicalContext({
        seriesId: series.id,
        history,
        refreshState,
        missingFromFloor: [],
        now,
        publicationDelayMs,
      });
      computeSamples.push(elapsed(started));
    }

    // --- 3. Memory one context holds ---------------------------------------------------------
    const sample = snapshots.get(first.code)!;
    const columnBytes =
      sample.closes.byteLength +
      [...sample.columns.values()].reduce(
        (total, column) => total + column.byteLength,
        0,
      );
    let measuredBytesPerContext: number | null = null;
    const before = retainedBytes();
    if (before !== null) {
      const held: BenchmarkTechnicalSnapshot[] = [];
      for (let copy = 0; copy < 10; copy += 1) {
        const context = buildBenchmarkTechnicalContext({
          seriesId: series.id,
          history,
          refreshState,
          missingFromFloor: [],
          now,
          publicationDelayMs,
        });
        if (context.status === "READY") {
          held.push(context.snapshot);
        }
      }
      const after = retainedBytes();
      measuredBytesPerContext =
        after === null ? null : Math.round((after - before) / held.length);
      // Referenced after the measurement so the contexts are still alive while it is taken.
      if (held.length !== 10) {
        throw new Error("The memory sample did not hold ten contexts");
      }
    }

    // --- 4. Joining ETF columns onto every security's frames ---------------------------------
    const sessions = dates.slice(-252);
    const frameOf = (security: number) =>
      createEvaluationFrame({
        securityId: `security-${security}`,
        symbol: `S${security}`,
        name: `Security ${security}`,
        dates: sessions,
        closes: new Float64Array(sessions.length).fill(100),
        columns: new Map(),
        periodStartIndex: 0,
      });
    const joinProfile = (operands: readonly OperandKey[], windows: number) => {
      const started = process.hrtime.bigint();
      let columns = 0;
      for (let security = 0; security < args.securities; security += 1) {
        const frame = frameOf(security);
        for (let window = 0; window < windows; window += 1) {
          columns += withEtfOperandColumns(frame, operands, snapshots).columns.size;
        }
      }
      const totalMs = elapsed(started);
      const frames = args.securities * windows;
      return {
        etfColumnsPerFrame: operands.length,
        frames,
        columnsJoined: columns,
        totalMs: Math.round(totalMs * 100) / 100,
        microsecondsPerFrame: Math.round((totalMs / frames) * 1000 * 100) / 100,
        bytesPerFrame: operands.length * sessions.length * 8,
      };
    };
    // An ordinary strategy: four funds, three rules each (the decision's own example is four
    // sources), over every security and every year window of the longest run.
    const ordinaryOperands = funds
      .slice(0, Math.min(4, funds.length))
      .flatMap((fund) => everyOperandOf(fund.code).slice(0, 3));
    // The worst case the product allows a definition to name: every fund, every metric.
    const worstOperands = funds.flatMap((fund) => everyOperandOf(fund.code));
    client.chunkReads = 0;
    calls.count = 0;
    const ordinary = joinProfile(ordinaryOperands, args.years);
    const worstOneWindow = joinProfile(worstOperands, 1);
    const readsDuringJoin = { redisChunks: client.chunkReads, loaderCalls: calls.count };

    const perEtf = (totals: readonly number[]) =>
      summary(totals.map((total) => total / funds.length));
    const report = {
      environment: {
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        cpu: cpus()[0]?.model ?? "unknown",
        cores: cpus().length,
        memoryGb: Math.round(totalmem() / 1024 ** 3),
        date: today,
      },
      inputs: {
        etfs: funds.length,
        barsPerEtf: dates.length,
        firstSession: dates[0],
        latestSession: dates[dates.length - 1],
        yearChunksPerEtf: new Set(dates.map((date) => date.slice(0, 4))).size,
        securities: args.securities,
        yearWindows: args.years,
        runs: args.runs,
      },
      bootstrapMs: Math.round(bootstrapMs),
      contextLoad: {
        description:
          "loadEtfTechnicalSnapshots for every fund: four reads and one computation per ETF",
        warmRedisTotalMs: summary(warmTotals),
        warmRedisPerEtfMs: perEtf(warmTotals),
        afterRedisLossTotalMs: summary(coldTotals),
        afterRedisLossPerEtfMs: perEtf(coldTotals),
        postgresOnlyTotalMs: summary(postgresTotals),
        postgresOnlyPerEtfMs: perEtf(postgresTotals),
        loaderCallsPerLoad: callsPerLoad,
        redisChunkReadsPerLoad: chunkReadsPerLoad,
      },
      computeOnly: {
        description:
          "buildBenchmarkTechnicalContext on one ETF's full history already in memory",
        ms: summary(computeSamples),
      },
      memory: {
        fields: BENCHMARK_TECHNICAL_FIELDS.length + 1,
        typedArrayBytesPerContext: columnBytes,
        measuredRetainedBytesPerContext: measuredBytesPerContext,
        typedArrayBytesAllEtfs: columnBytes * funds.length,
      },
      columnJoin: {
        description:
          "withEtfOperandColumns onto one 252-session frame per security and year window",
        ordinaryStrategy: ordinary,
        everyFundEveryMetricOneWindow: worstOneWindow,
        readsDuringJoin,
      },
      providerRequestsOnEvaluationPath: refusing.requests,
    };
    const text = JSON.stringify(report, null, 2);
    console.log(text);
    if (args.out) {
      writeFileSync(args.out, `${text}\n`);
    }
  } finally {
    await clearRedis();
    redis.disconnect();
    await prisma.benchmark.deleteMany({ where: { code: { in: catalogCodes } } });
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
