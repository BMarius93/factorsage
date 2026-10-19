import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getApiConfig, loadRootEnv } from "@intrinsic/config";
import {
  isMarketIndexKey,
  pointInTimeIndexUniverse,
  type LocalDate,
  type MarketIndexKey,
} from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import {
  membershipWithinHorizon,
  priceRetentionYears,
  projectIndexList,
  resolutionCandidates,
  STOCK_DATA_CACHE_NAMESPACE,
  subtractYears,
} from "@intrinsic/stock-data";
import { reconcileBenchmarkCatalog } from "./benchmarks/benchmark-catalog.service";
import { repositoryRoot } from "./qa-matrix/matrix-paths";
import { catalogAdmitter } from "./index-universe/index-universe-admission.js";
import {
  runIndexUniverseIngestion,
  universeSecurities,
} from "./index-universe/index-universe-ingest.js";
import { writeIndexUniverseList } from "./index-universe/index-universe-list.js";
import { buildIndexUniverseReport } from "./index-universe/index-universe-report.js";
import { runProtectedResidency } from "./index-universe/index-universe-residency.js";
import { createIndexUniverseRuntime } from "./index-universe/index-universe-runtime.js";

/**
 * The point-in-time index universe's operator command (`docs/decisions/sp500-historical-pit-v1.md`).
 *
 * ```bash
 * pnpm data:index-universe -- sync              # read the provider's membership, reconstruct it
 * pnpm data:index-universe -- resolve           # link constituents to catalog securities
 * pnpm data:index-universe -- project           # write the built-in List (no provider)
 * pnpm data:index-universe -- ingest            # load every universe security's full history
 * pnpm data:index-universe -- report --out f    # measure what PostgreSQL holds (no provider)
 * pnpm data:index-universe -- protect           # make it resident in Redis's protected tier (no provider)
 * pnpm data:index-universe -- benchmarks        # load the execution calendar its backtests run on
 * ```
 *
 * Every step is idempotent and resumable: run them again and each does only what is missing. In a
 * Claude cloud session the provider is reached only through `scripts/cloud/fmp-index-universe.sh`.
 */

const COMMANDS = [
  "sync",
  "resolve",
  "project",
  "ingest",
  "report",
  "protect",
  "benchmarks",
] as const;
type Command = (typeof COMMANDS)[number];

/** The benchmark a universe backtest runs on: its execution calendar and default comparison. */
const UNIVERSE_BENCHMARK_CODE = "SP500";

type Arguments = {
  command: Command;
  indexKey: MarketIndexKey;
  asOf: LocalDate;
  budget: number | null;
  force: boolean;
  concurrency: number;
  refresh: boolean;
  retryFailed: boolean;
  maxAttempts: number;
  symbols: string[] | null;
  shard: { index: number; count: number } | null;
  limit: number | null;
  altDataMaxPages: number | null;
  out: string | null;
  memoryBudgetMb: number | null;
  dryRun: boolean;
};

const DEFAULT_BUDGETS: Record<Command, number> = {
  sync: 20,
  resolve: 20_000,
  project: 1,
  ingest: 120_000,
  report: 1,
  protect: 1,
  benchmarks: 200,
};

export function parseIndexUniverseArguments(
  argv: readonly string[],
  today: LocalDate,
): Arguments {
  const [command, ...rest] = argv.filter((value) => value !== "--");
  if (!command || !(COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`Usage: index-universe <${COMMANDS.join("|")}> [options]`);
  }
  const parsed: Arguments = {
    command: command as Command,
    indexKey: "SP500",
    asOf: today,
    budget: null,
    force: false,
    concurrency: 2,
    refresh: false,
    retryFailed: false,
    maxAttempts: 3,
    symbols: null,
    shard: null,
    limit: null,
    altDataMaxPages: null,
    out: null,
    memoryBudgetMb: null,
    dryRun: false,
  };
  const seen = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] as string;
    if (seen.has(flag)) {
      throw new Error(`${flag} was given twice`);
    }
    seen.add(flag);
    const value = (): string => {
      const next = rest[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${flag} needs a value`);
      }
      index += 1;
      return next;
    };
    const positive = (raw: string): number => {
      const number = Number(raw);
      if (!Number.isInteger(number) || number <= 0) {
        throw new Error(`${flag} must be a positive integer`);
      }
      return number;
    };
    switch (flag) {
      case "--index": {
        const key = value().toUpperCase();
        if (!isMarketIndexKey(key)) {
          throw new Error(`Unknown index ${key}`);
        }
        parsed.indexKey = key;
        break;
      }
      case "--as-of": {
        const date = value();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          throw new Error("--as-of must be YYYY-MM-DD");
        }
        parsed.asOf = date;
        break;
      }
      case "--budget":
        parsed.budget = positive(value());
        break;
      case "--force":
        parsed.force = true;
        break;
      case "--concurrency":
        parsed.concurrency = Math.min(16, positive(value()));
        break;
      case "--refresh":
        parsed.refresh = true;
        break;
      case "--retry-failed":
        parsed.retryFailed = true;
        break;
      case "--max-attempts":
        parsed.maxAttempts = positive(value());
        break;
      case "--symbols":
        parsed.symbols = value()
          .split(",")
          .map((symbol) => symbol.trim().toUpperCase())
          .filter(Boolean);
        break;
      case "--shard": {
        const match = /^(\d+)\/(\d+)$/.exec(value());
        const shardIndex = Number(match?.[1]);
        const count = Number(match?.[2]);
        if (!match || count < 1 || shardIndex >= count) {
          throw new Error("--shard must be i/n with 0 <= i < n");
        }
        parsed.shard = { index: shardIndex, count };
        break;
      }
      case "--limit":
        parsed.limit = positive(value());
        break;
      case "--alt-data-max-pages":
        parsed.altDataMaxPages = positive(value());
        break;
      case "--out":
        parsed.out = value();
        break;
      case "--memory-budget-mb":
        parsed.memoryBudgetMb = positive(value());
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument ${flag}`);
    }
  }
  return parsed;
}

/** Refuses a database this command must never write: a test or matrix database, a remote host. */
function assertTargetAllowed(databaseUrl: string): void {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a URL");
  }
  const name = url.pathname.replace(/^\//, "");
  if (/test|matrix/i.test(name)) {
    throw new Error(
      `Refusing to load provider data into ${name}: test and matrix databases hold fixtures only`,
    );
  }
}

async function main(): Promise<number> {
  loadRootEnv();
  const apiConfig = getApiConfig();
  const logger = createLogger({
    service: "api",
    level: apiConfig.logLevel,
    environment: apiConfig.environment,
    base: { component: "index-universe" },
  });
  const args = parseIndexUniverseArguments(
    process.argv.slice(2),
    new Date().toISOString().slice(0, 10),
  );
  assertTargetAllowed(process.env.DATABASE_URL ?? "");
  const universe = pointInTimeIndexUniverse(args.indexKey);
  const horizon = { floor: universe.membershipFloor, asOf: args.asOf };
  const usesProvider =
    args.command === "sync" ||
    args.command === "resolve" ||
    args.command === "ingest" ||
    args.command === "benchmarks";

  // The guard's scope comes from PostgreSQL before the client exists: nothing can widen it later.
  const scopeRuntime = await createIndexUniverseRuntime({
    logger,
    runId: `iu-scope-${randomUUID()}`,
    scopeSymbols: [],
    budget: 1,
    provider: false,
  });
  let scopeSymbols: string[] = [];
  try {
    if (args.command === "resolve") {
      const constituents = await scopeRuntime.membershipStore.loadConstituents(
        args.indexKey,
      );
      const renames = await scopeRuntime.membershipStore.loadSymbolChanges();
      const symbols = new Set<string>();
      for (const constituent of constituents) {
        const windows = membershipWithinHorizon(constituent.periods, horizon);
        if (windows.length === 0) {
          continue;
        }
        for (const symbol of resolutionCandidates(
          constituent,
          windows.at(-1)?.to as LocalDate,
          renames,
        )) {
          symbols.add(symbol);
        }
      }
      scopeSymbols = [...symbols];
    } else if (args.command === "ingest") {
      scopeSymbols = (
        await universeSecurities(scopeRuntime.prisma, args.indexKey)
      ).map((entry) => entry.providerSymbol);
    } else if (args.command === "benchmarks") {
      // The catalog is reconciled through the API's own idempotent path, then the guard admits the
      // one provider symbol the universe benchmark's current series names.
      await reconcileBenchmarkCatalog(scopeRuntime.prisma);
      const benchmark = await scopeRuntime.benchmarks.getBenchmark(
        UNIVERSE_BENCHMARK_CODE,
      );
      scopeSymbols = benchmark.series.providerSymbol
        ? [benchmark.series.providerSymbol]
        : [];
    }
  } finally {
    await scopeRuntime.close();
  }

  const runId = `iu-${args.command}-${randomUUID()}`;
  const runtime = await createIndexUniverseRuntime({
    logger,
    runId,
    scopeSymbols,
    budget: args.budget ?? DEFAULT_BUDGETS[args.command],
    provider: usesProvider,
    ...(args.altDataMaxPages === null
      ? {}
      : { alternativeDataMaxPages: args.altDataMaxPages }),
  });
  let stopRequested = false;
  const stop = () => {
    stopRequested = true;
    logger.warn({ event: "index-universe.stop-requested" });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const startedAt = Date.now();
  logger.info({
    event: "index-universe.started",
    command: args.command,
    indexKey: args.indexKey,
    horizon,
    scope: runtime.guard.scopeSize,
  });
  try {
    switch (args.command) {
      case "sync": {
        const result = await runtime.membership.synchronize({
          indexKey: args.indexKey,
          floor: universe.membershipFloor,
          asOf: args.asOf,
        });
        print({
          syncId: result.syncId,
          constituents: result.constituents,
          replaced: result.replaced,
          anomalies: countBy(result.anomalies.map((anomaly) => anomaly.kind)),
          quality: {
            minimum: result.quality.minimum,
            maximum: result.quality.maximum,
            deficits: result.quality.deficits,
            surpluses: result.quality.surpluses,
            daysWithinBand: result.quality.daysWithinBand,
            daysInHorizon: result.quality.daysInHorizon,
            checkpoints: result.quality.checkpoints,
            endUnknownPeriods: result.quality.endUnknownPeriods.length,
          },
        });
        break;
      }
      case "resolve": {
        const result = await runtime.membership.resolve({
          indexKey: args.indexKey,
          floor: universe.membershipFloor,
          asOf: args.asOf,
          admit: catalogAdmitter({
            store: runtime.store,
            cache: runtime.cache,
          }),
          force: args.force,
        });
        const latest = await runtime.membershipStore.latestCompletedSync(
          args.indexKey,
        );
        if (latest) {
          await runtime.membershipStore.amendSyncSummary(
            latest.id,
            "resolution",
            {
              ...result,
              at: new Date().toISOString(),
            },
          );
        }
        print(result);
        break;
      }
      case "project": {
        const constituents = await runtime.membershipStore.loadConstituents(
          args.indexKey,
        );
        const members = projectIndexList(
          constituents,
          universe.membershipFloor,
        );
        const written = await writeIndexUniverseList({
          prisma: runtime.prisma,
          universe,
          members,
        });
        const latest = await runtime.membershipStore.latestCompletedSync(
          args.indexKey,
        );
        if (latest) {
          await runtime.membershipStore.amendSyncSummary(
            latest.id,
            "projection",
            {
              ...written,
              at: new Date().toISOString(),
            },
          );
        }
        print(written);
        break;
      }
      case "ingest": {
        const productFrom = subtractYears(
          args.asOf,
          runtime.productHistoryYears,
        );
        const summary = await runIndexUniverseIngestion({
          prisma: runtime.prisma,
          indexKey: args.indexKey,
          stockData: runtime.stockData,
          alternativeData: runtime.alternativeData,
          range: { from: productFrom, to: args.asOf },
          selection: {
            refresh: args.refresh,
            retryFailed: args.retryFailed,
            maxAttempts: args.maxAttempts,
            symbols: args.symbols,
            shard: args.shard,
            limit: args.limit,
          },
          concurrency: args.concurrency,
          logger,
          providerRequests: runtime.providerRequests,
          shouldStop: () => stopRequested || runtime.guard.closed,
        });
        print({ ...summary, guard: runtime.guard.ledger() });
        break;
      }
      case "protect": {
        const summary = await runProtectedResidency({
          prisma: runtime.prisma,
          redis: runtime.redis,
          store: runtime.store,
          cache: runtime.cache,
          stockData: runtime.stockData,
          namespace: STOCK_DATA_CACHE_NAMESPACE,
          indexKey: args.indexKey,
          concurrency: args.concurrency,
          memoryBudgetBytes:
            args.memoryBudgetMb === null
              ? null
              : args.memoryBudgetMb * 1024 * 1024,
          dryRun: args.dryRun,
          logger,
          providerRequests: runtime.providerRequests,
          shouldStop: () => stopRequested,
        });
        if (args.out) {
          const path = resolve(repositoryRoot(), args.out);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
        }
        print(summary);
        break;
      }
      case "benchmarks": {
        // From the raw-price retention start, so a run over the whole horizon finds its calendar.
        const range = {
          from: subtractYears(
            args.asOf,
            priceRetentionYears(runtime.productHistoryYears),
          ),
          to: args.asOf,
        };
        const benchmark = await runtime.benchmarks.getBenchmark(
          UNIVERSE_BENCHMARK_CODE,
        );
        await runtime.benchmarks.ensureBenchmarkHydrated(
          benchmark.series,
          range,
        );
        const missing = await runtime.benchmarks.missingBenchmarkCoverage(
          benchmark.series,
          range,
        );
        print({
          code: UNIVERSE_BENCHMARK_CODE,
          seriesId: benchmark.series.id,
          seriesVersion: benchmark.series.version,
          range,
          missingRanges: missing,
          guard: runtime.guard.ledger(),
        });
        break;
      }
      case "report": {
        const report = await buildIndexUniverseReport({
          prisma: runtime.prisma,
          indexKey: args.indexKey,
          universe,
          asOf: args.asOf,
        });
        if (args.out) {
          const path = resolve(repositoryRoot(), args.out);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
        }
        print({
          membership: {
            constituentsTotal: report.membership.constituentsTotal,
            constituentsInHorizon: report.membership.constituentsInHorizon,
            byResolution: report.membership.byResolution,
            uniqueTradeableSecurities:
              report.membership.uniqueTradeableSecurities,
            endUnknownPeriods: report.membership.endUnknownPeriods.length,
            unresolved: report.membership.unresolved.length,
          },
          list: report.list,
          data: {
            ...report.data,
            largestInteriorGaps: report.data.largestInteriorGaps.slice(0, 10),
          },
          ingestion: {
            byStatus: report.ingestion.byStatus,
            failures: report.ingestion.failures.length,
          },
        });
        break;
      }
    }
    logger.info({
      event: "index-universe.completed",
      command: args.command,
      durationMs: Date.now() - startedAt,
      guard: runtime.guard.ledger(),
    });
    return runtime.guard.closed ? 3 : 0;
  } catch (error) {
    logger.error({
      event: "index-universe.failed",
      command: args.command,
      durationMs: Date.now() - startedAt,
      err: error,
      guard: runtime.guard.ledger(),
    });
    return 1;
  } finally {
    await runtime.close();
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

if (process.argv[1] && process.argv[1].includes("index-universe")) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(2);
    },
  );
}
