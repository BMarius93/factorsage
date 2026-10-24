import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  type AuthUser,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { getRedisConfig, loadRootEnv } from "@intrinsic/config";
import type { Prisma, PrismaClient } from "@intrinsic/database";
import {
  maintainedUniverseForList,
  SP500_HISTORICAL_PIT_UNIVERSE,
} from "@intrinsic/domain";
import { createStockDataRedisClient } from "@intrinsic/stock-data";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AuthModule } from "../auth/auth.module";
import { BacktestsModule } from "../backtests/backtests.module";
import { BacktestsService } from "../backtests/backtests.service";
import { parseCreateBacktestRunRequest } from "../backtests/backtest-requests";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { repositoryRoot } from "../qa-matrix/matrix-paths";
import { BENCHMARK_STRATEGIES } from "./benchmark-strategies";

/**
 * Thirty-year backtests over the S&P 500 point-in-time universe, at increasing concurrency
 * (`docs/decisions/sp500-historical-pit-v1.md`, benchmark section).
 *
 * ```bash
 * pnpm --filter @intrinsic/api bench:pit-backtests -- setup
 * pnpm --filter @intrinsic/api bench:pit-backtests -- run --strategy simple --concurrency 4 --label warm
 * pnpm --filter @intrinsic/api bench:pit-backtests -- run --list mixed --strategy simple
 * pnpm --filter @intrinsic/api bench:pit-backtests -- cleanup
 * ```
 *
 * `--list mixed` runs over a user List of the operator's instead of the universe: the
 * {@link MIXED_LIST_SYMBOLS} the catalog holds, protected-tier securities beside ordinary ones, so one
 * run reads both stock-cache tiers (`docs/decisions/stock-cache-tiers-v1.md`).
 *
 * **The real path, in an isolated configuration.** Runs are submitted through the product's own
 * `BacktestsService.submitRun` (the QA matrix's pattern: real validation, entitlements, immutable
 * snapshot, one durable job), and executed by real backtest worker processes — `worker-process.js`
 * from the worker's build, the same module the supervisor forks — started here, `--concurrency` of
 * them, with nothing else: no monitor, market-data or stock-EOD child. Nothing in the product's
 * configuration changes; the benchmark's own settings are environment overrides of the processes it
 * starts:
 *
 * - no provider key, so a run that needed the provider would fail visibly rather than measure it;
 * - `EOD_TAIL_REFRESH=frozen` (the QA matrix's setting) and fundamentals and alternative-data
 *   freshness widened to 30 days, so the dataset of the benchmark day is held still and nothing is
 *   refreshed mid-benchmark;
 * - the period ends on the newest date the execution calendar's series is stored for.
 *
 * The owner is an **ADMIN** fixture user, exactly as the QA matrix's is: `ADMIN_ENTITLEMENTS` is the
 * decision document's own mechanism for operator capacity, so a concurrency no plan sells needs no
 * change to any plan. `--owner pro` submits as a PRO fixture user instead — the proof that the
 * extended Pro entitlement admits the universe — and is then bounded by Pro's two concurrent runs.
 *
 * For each level it records wall time, per-run queue wait, preparation, frame reads and simulation,
 * throughput, worker CPU and resident memory, system memory, Redis memory, hit rate, commands and
 * bytes sent, PostgreSQL transactions and block reads, failures, and a digest of every run's result:
 * identical inputs must give identical results at every concurrency. Aggregates only; never a value
 * a provider supplied.
 */

const OWNER_EMAIL = "pit-benchmark-operator@factorsage.invalid";
const PRO_EMAIL = "pit-benchmark-pro@factorsage.invalid";
const STRATEGY_PREFIX = "PIT-BENCH-";
const MIXED_LIST_NAME = `${STRATEGY_PREFIX}mixed-tiers`;

/**
 * The mixed List: S&P 500 point-in-time securities (current and former, the three recovered
 * identities among them) and stocks no built-in universe holds. Symbols the catalog lacks are left
 * out, so the List is whatever this database can actually run.
 */
const MIXED_LIST_SYMBOLS = {
  universe: [
    "AAPL",
    "MSFT",
    "JPM",
    "XOM",
    "KO",
    "PG",
    "JNJ",
    "WMT",
    "INTC",
    "IBM",
    "GE",
    "MS",
    "MCO",
    "CVC",
  ],
  ordinary: ["SHOP", "SNOW", "ROKU", "ZM", "NET", "RBLX", "TM", "ASML", "MDB"],
} as const;
const DAY_MS = 86_400_000;

type StrategyKey = "simple" | "complex" | "monthly";

const STRATEGIES: Record<
  StrategyKey,
  {
    readonly name: string;
    readonly description: string;
    readonly definition: StrategyDefinition;
    readonly capital: (typeof BENCHMARK_STRATEGIES)[StrategyKey]["capital"];
  }
> = Object.fromEntries(
  (["simple", "complex", "monthly"] as const).map((key) => {
    const { slug, ...entry } = BENCHMARK_STRATEGIES[key];
    return [key, { ...entry, name: `${STRATEGY_PREFIX}${slug}` }];
  }),
) as Record<StrategyKey, never>;
@Module({
  imports: [ConfigurationModule, DatabaseModule, AuthModule, BacktestsModule],
})
class BenchmarkSubmissionModule {}

type Arguments = {
  command: "setup" | "run" | "cleanup";
  strategy: StrategyKey;
  concurrency: number;
  runs: number | null;
  owner: "operator" | "pro";
  label: string;
  report: string;
  timeoutMinutes: number;
  startDate: string | null;
  workerEnv: Record<string, string>;
  /** Caps each worker's PostgreSQL pool, so many workers stay inside `max_connections`. */
  pgConnections: number | null;
  /** `universe` (the S&P 500's), `mixed`, or any published catalog universe's key. */
  list: string;
};

function parseArguments(argv: readonly string[]): Arguments {
  const [command, ...rest] = argv.filter((value) => value !== "--");
  if (command !== "setup" && command !== "run" && command !== "cleanup") {
    throw new Error(
      "Usage: pit-backtest-benchmark <setup|run|cleanup> [options]",
    );
  }
  const parsed: Arguments = {
    command,
    strategy: "simple",
    concurrency: 1,
    runs: null,
    owner: "operator",
    label: "warm",
    report: "artifacts/sp500-historical-pit/backtest-benchmark.jsonl",
    timeoutMinutes: 240,
    startDate: null,
    workerEnv: {},
    pgConnections: null,
    list: "universe",
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] as string;
    const value = () => {
      const next = rest[index + 1];
      if (next === undefined) {
        throw new Error(`${flag} needs a value`);
      }
      index += 1;
      return next;
    };
    switch (flag) {
      case "--strategy": {
        const key = value();
        if (!(key in STRATEGIES)) {
          throw new Error(
            `--strategy must be one of ${Object.keys(STRATEGIES).join(", ")}`,
          );
        }
        parsed.strategy = key as StrategyKey;
        break;
      }
      case "--concurrency":
        parsed.concurrency = positive(flag, value());
        break;
      case "--runs":
        parsed.runs = positive(flag, value());
        break;
      case "--owner": {
        const owner = value();
        if (owner !== "operator" && owner !== "pro") {
          throw new Error("--owner must be operator or pro");
        }
        parsed.owner = owner;
        break;
      }
      case "--label":
        parsed.label = value();
        break;
      case "--report":
        parsed.report = value();
        break;
      case "--timeout-minutes":
        parsed.timeoutMinutes = positive(flag, value());
        break;
      case "--start-date":
        parsed.startDate = value();
        break;
      case "--pg-connections":
        parsed.pgConnections = positive(flag, value());
        break;
      case "--list": {
        const list = value();
        if (
          list !== "universe" &&
          list !== "mixed" &&
          maintainedUniverseForList(list) === null
        ) {
          throw new Error(
            "--list must be universe, mixed or a catalog universe's key",
          );
        }
        parsed.list = list;
        break;
      }
      case "--worker-env": {
        const [key, ...parts] = value().split("=");
        if (!key || parts.length === 0) {
          throw new Error("--worker-env takes KEY=VALUE");
        }
        parsed.workerEnv[key] = parts.join("=");
        break;
      }
      default:
        throw new Error(`Unknown argument ${flag}`);
    }
  }
  return parsed;
}

function positive(flag: string, raw: string): number {
  const number = Number(raw);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return number;
}

async function ensureUser(
  prisma: PrismaClient,
  email: string,
  role: "ADMIN" | "USER",
): Promise<AuthUser> {
  // No password and no OAuth account: the fixture can submit through the service, never sign in.
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, role, plan: "PRO", emailVerifiedAt: new Date() },
    update: { role, plan: "PRO" },
    select: { id: true, email: true, role: true, plan: true },
  });
  return { id: user.id, email: user.email, role: user.role, plan: user.plan };
}

async function ensureStrategies(
  prisma: PrismaClient,
  userId: string,
): Promise<void> {
  for (const entry of Object.values(STRATEGIES)) {
    const definition = normalizeStrategyDefinition(entry.definition);
    const hash = createHash("sha256")
      .update(strategyDefinitionFingerprint(definition))
      .digest("hex");
    const existing = await prisma.strategy.findFirst({
      where: { userId, name: entry.name },
      include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } },
    });
    if (!existing) {
      await prisma.strategy.create({
        data: {
          userId,
          name: entry.name,
          description: entry.description,
          versions: {
            create: {
              versionNumber: 1,
              definition: definition as unknown as Prisma.InputJsonValue,
              definitionHash: hash,
            },
          },
        },
      });
    } else if (existing.versions[0]?.definitionHash !== hash) {
      await prisma.strategyVersion.create({
        data: {
          strategyId: existing.id,
          versionNumber: (existing.versions[0]?.versionNumber ?? 0) + 1,
          definition: definition as unknown as Prisma.InputJsonValue,
          definitionHash: hash,
        },
      });
    }
  }
}

/** The operator's mixed List, created or brought to exactly the catalog's {@link MIXED_LIST_SYMBOLS}. */
async function ensureMixedList(
  prisma: PrismaClient,
  userId: string,
): Promise<{ id: string; _count: { items: number } }> {
  const symbols = [
    ...MIXED_LIST_SYMBOLS.universe,
    ...MIXED_LIST_SYMBOLS.ordinary,
  ];
  const securities = await prisma.security.findMany({
    where: { symbol: { in: symbols } },
    select: { id: true },
  });
  const existing = await prisma.stockList.findFirst({
    where: { userId, name: MIXED_LIST_NAME },
    select: { id: true },
  });
  const list =
    existing ??
    (await prisma.stockList.create({
      data: {
        userId,
        name: MIXED_LIST_NAME,
        description: "Protected-tier and ordinary LRU securities in one List.",
      },
      select: { id: true },
    }));
  await prisma.stockListItem.deleteMany({
    where: {
      stockListId: list.id,
      securityId: { notIn: securities.map((row) => row.id) },
    },
  });
  await prisma.stockListItem.createMany({
    data: securities.map((row) => ({
      stockListId: list.id,
      securityId: row.id,
    })),
    skipDuplicates: true,
  });
  return {
    id: list.id,
    _count: {
      items: await prisma.stockListItem.count({
        where: { stockListId: list.id },
      }),
    },
  };
}

type Sample = {
  at: number;
  cpuBusyShare: number;
  workerRssBytes: number;
  workerRssMaxBytes: number;
  workerCpuMs: number;
  systemAvailableBytes: number;
  redisUsedBytes: number;
  pgActive: number;
};

function readProcStat(): { busy: number; total: number } {
  const line = readFileSync("/proc/stat", "utf8").split("\n")[0] as string;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (values[3] ?? 0) + (values[4] ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  return { busy: total - idle, total };
}

/** Resident memory and CPU time (ms) of one process, from `/proc`; zero once it has exited. */
function processStats(pid: number): { rss: number; cpuMs: number } {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[11] ?? 0) + Number(fields[12] ?? 0);
    return { rss, cpuMs: (ticks * 1000) / 100 };
  } catch {
    return { rss: 0, cpuMs: 0 };
  }
}

function availableMemory(): number {
  const info = readFileSync("/proc/meminfo", "utf8");
  return (
    Number(/MemAvailable:\s+(\d+)/.exec(info)?.[1] ?? 0) * 1024 || freemem()
  );
}

function redisField(info: string, name: string): number {
  return Number(new RegExp(`^${name}:(.*)$`, "m").exec(info)?.[1]?.trim() ?? 0);
}

async function redisCounters(
  redis: ReturnType<typeof createStockDataRedisClient>,
) {
  const info = await redis.info();
  return {
    usedMemory: redisField(info, "used_memory"),
    hits: redisField(info, "keyspace_hits"),
    misses: redisField(info, "keyspace_misses"),
    commands: redisField(info, "total_commands_processed"),
    netOutputBytes: redisField(info, "total_net_output_bytes"),
    netInputBytes: redisField(info, "total_net_input_bytes"),
    cpuSeconds:
      redisField(info, "used_cpu_sys") + redisField(info, "used_cpu_user"),
  };
}

async function pgCounters(prisma: PrismaClient) {
  const [row] = await prisma.$queryRaw<
    {
      xact_commit: bigint;
      blks_read: bigint;
      blks_hit: bigint;
      tup_returned: bigint;
      tup_fetched: bigint;
    }[]
  >`SELECT xact_commit, blks_read, blks_hit, tup_returned, tup_fetched
      FROM pg_stat_database WHERE datname = current_database()`;
  return {
    transactions: Number(row?.xact_commit ?? 0),
    blocksRead: Number(row?.blks_read ?? 0),
    blocksHit: Number(row?.blks_hit ?? 0),
    tuplesReturned: Number(row?.tup_returned ?? 0),
    tuplesFetched: Number(row?.tup_fetched ?? 0),
  };
}

function startWorkers(
  count: number,
  logDirectory: string,
  overrides: Record<string, string>,
): ChildProcess[] {
  const entry = join(
    repositoryRoot(),
    "apps/worker/dist/backtest/worker-process.js",
  );
  if (!existsSync(entry)) {
    throw new Error(
      `${entry} is missing: run \`pnpm --filter @intrinsic/worker build\` first`,
    );
  }
  mkdirSync(logDirectory, { recursive: true });
  const children: ChildProcess[] = [];
  for (let index = 0; index < count; index += 1) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LOG_LEVEL: "debug",
      // The isolated configuration: no provider, and the benchmark day's dataset held still — stored
      // tails are never re-read (`EOD_TAIL_REFRESH=frozen`, the QA matrix's setting), nor are
      // statements or alternative data refreshed during the benchmark.
      FMP_API_KEY: "",
      EOD_TAIL_REFRESH: "frozen",
      STOCK_FUNDAMENTALS_FRESHNESS_MS: String(30 * DAY_MS),
      ALT_DATA_FRESHNESS_MS: String(30 * DAY_MS),
      BACKTEST_JOB_POLL_INTERVAL_MS: "250",
      ...overrides,
    };
    const child = spawn(process.execPath, [entry], {
      cwd: repositoryRoot(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = createWriteStream(join(logDirectory, `worker-${index}.log`));
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    children.push(child);
  }
  return children;
}

async function stopWorkers(children: readonly ChildProcess[]): Promise<void> {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolveStop) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolveStop();
            return;
          }
          const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolveStop();
          });
          child.kill("SIGTERM");
        }),
    ),
  );
}

type WorkerTimings = {
  runId: string;
  framesLoadedMs?: number;
  securityCount?: number;
  skippedCount?: number;
  windowLoadMs: number;
  windows: number;
  completedMs?: number;
  providerErrors: number;
};

/** Per-run phase timings from the workers' structured logs; each worker runs one job at a time. */
function workerTimings(
  logDirectory: string,
  count: number,
): Map<string, WorkerTimings> {
  const byRun = new Map<string, WorkerTimings>();
  for (let index = 0; index < count; index += 1) {
    const path = join(logDirectory, `worker-${index}.log`);
    if (!existsSync(path)) {
      continue;
    }
    let current: WorkerTimings | null = null;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.startsWith("{")) {
        continue;
      }
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const runId = typeof record.runId === "string" ? record.runId : null;
      if (runId && (!current || current.runId !== runId)) {
        current = byRun.get(runId) ?? {
          runId,
          windowLoadMs: 0,
          windows: 0,
          providerErrors: 0,
        };
        byRun.set(runId, current);
      }
      if (!current) {
        continue;
      }
      switch (record.event) {
        case "backtest.frames.loaded":
          current.framesLoadedMs = Number(record.durationMs);
          current.securityCount = Number(record.securityCount);
          current.skippedCount = Number(record.skippedCount);
          break;
        case "backtest.window.loaded":
          current.windowLoadMs += Number(record.durationMs);
          current.windows += 1;
          break;
        case "backtest.completed":
          current.completedMs = Number(record.durationMs);
          break;
        default:
          if (String(record.event ?? "").includes("provider")) {
            current.providerErrors += 1;
          }
      }
    }
  }
  return byRun;
}

/** A digest of everything a run produced: identical inputs must give identical digests. */
async function resultDigest(
  prisma: PrismaClient,
  runId: string,
): Promise<string | null> {
  const summary = await prisma.backtestRunSummary.findUnique({
    where: { runId },
  });
  if (!summary) {
    return null;
  }
  const trades = await prisma.backtestTrade.findMany({
    where: { runId },
    orderBy: { sequence: "asc" },
    select: {
      sequence: true,
      date: true,
      securityId: true,
      action: true,
      source: true,
      levelId: true,
      exitRuleId: true,
      shares: true,
      price: true,
      amount: true,
      fees: true,
      cashAfter: true,
    },
  });
  const values: Partial<typeof summary> = { ...summary };
  delete values.runId;
  return createHash("sha256")
    .update(JSON.stringify({ values, trades }))
    .digest("hex");
}

function percentile(values: readonly number[], share: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(share * sorted.length))
  ] as number;
}

async function main(): Promise<void> {
  loadRootEnv();
  const args = parseArguments(process.argv.slice(2));
  const context = await NestFactory.createApplicationContext(
    BenchmarkSubmissionModule,
    {
      logger: false,
    },
  );
  const prisma = context.get(PrismaService, {
    strict: false,
  }) as unknown as PrismaClient;
  const backtests = context.get(BacktestsService, { strict: false });
  const redis = createStockDataRedisClient(getRedisConfig().url);
  try {
    const operator = await ensureUser(prisma, OWNER_EMAIL, "ADMIN");
    const pro = await ensureUser(prisma, PRO_EMAIL, "USER");
    if (args.command === "setup") {
      await ensureStrategies(prisma, operator.id);
      await ensureStrategies(prisma, pro.id);
      process.stdout.write(
        `${JSON.stringify({ operator: operator.id, pro: pro.id })}\n`,
      );
      return;
    }
    if (args.command === "cleanup") {
      // Only the fixtures' own rows: runs, strategies and the two users this command created.
      const users = [operator.id, pro.id];
      const runs = await prisma.backtestRun.deleteMany({
        where: { userId: { in: users } },
      });
      const strategies = await prisma.strategy.deleteMany({
        where: { userId: { in: users }, name: { startsWith: STRATEGY_PREFIX } },
      });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      process.stdout.write(
        `${JSON.stringify({ runs: runs.count, strategies: strategies.count })}\n`,
      );
      return;
    }

    const owner = args.owner === "pro" ? pro : operator;
    const strategy = await prisma.strategy.findFirst({
      where: { userId: owner.id, name: STRATEGIES[args.strategy].name },
      select: { id: true },
    });
    if (!strategy) {
      throw new Error(
        "Run `setup` first: the benchmark strategies are not seeded",
      );
    }
    const list =
      args.list === "mixed"
        ? await ensureMixedList(prisma, owner.id)
        : await prisma.stockList.findFirst({
            where: {
              systemKey:
                args.list === "universe"
                  ? SP500_HISTORICAL_PIT_UNIVERSE.listSystemKey
                  : args.list,
            },
            select: { id: true, _count: { select: { items: true } } },
          });
    if (!list) {
      throw new Error(
        args.list === "universe"
          ? "The S&P 500 point-in-time List is not projected: run `index-universe project`"
          : `${args.list} is not published: run \`data:historical-universes publish ${args.list}\``,
      );
    }

    const runs = args.runs ?? args.concurrency;
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const logDirectory = resolve(
      repositoryRoot(),
      "artifacts/sp500-historical-pit/benchmark-logs",
      `${stamp}-${args.strategy}-c${args.concurrency}`,
    );
    const capital = STRATEGIES[args.strategy].capital;
    const today = new Date().toISOString().slice(0, 10);
    // The run ends on the newest date its execution calendar's series is stored for: a later date
    // (a weekend, a session not published yet) would send the worker to the provider, which this
    // isolated configuration does not have.
    const [calendarEnd] = await prisma.$queryRaw<{ end: Date | null }[]>`
      SELECT max(c."toDate") AS end
      FROM "BenchmarkDatasetCoverage" c
      JOIN "BenchmarkSeries" s ON s."id" = c."seriesId"
      JOIN "Benchmark" b ON b."id" = s."benchmarkId"
      WHERE b."code" = 'SP500'`;
    const endDate = calendarEnd?.end
      ? calendarEnd.end.toISOString().slice(0, 10)
      : today;
    const body = {
      strategyId: strategy.id,
      stockListId: list.id,
      startDate: args.startDate ?? earliestStart(endDate),
      endDate,
      ...capital,
    };

    const overrides = { ...args.workerEnv };
    if (args.pgConnections !== null && process.env.DATABASE_URL) {
      const url = new URL(process.env.DATABASE_URL);
      url.searchParams.set("connection_limit", String(args.pgConnections));
      overrides.DATABASE_URL = url.toString();
    }
    const workers = startWorkers(args.concurrency, logDirectory, overrides);
    const samples: Sample[] = [];
    let sampler: NodeJS.Timeout | null = null;
    const runIds: string[] = [];
    try {
      // Let every worker reach its claim loop before the clock starts.
      await new Promise((resolveWait) => setTimeout(resolveWait, 4_000));
      const redisBefore = await redisCounters(redis);
      const pgBefore = await pgCounters(prisma);
      const workerCpuBefore = workers.reduce(
        (sum, child) => sum + processStats(child.pid ?? 0).cpuMs,
        0,
      );
      let previousStat = readProcStat();
      const startedAt = Date.now();
      sampler = setInterval(() => {
        void (async () => {
          const stat = readProcStat();
          const busy = stat.busy - previousStat.busy;
          const total = stat.total - previousStat.total;
          previousStat = stat;
          const stats = workers.map((child) => processStats(child.pid ?? 0));
          const [active] = await prisma.$queryRaw<{ count: bigint }[]>`
            SELECT count(*) AS count FROM pg_stat_activity
            WHERE datname = current_database() AND state = 'active'`;
          samples.push({
            at: Date.now() - startedAt,
            cpuBusyShare: total > 0 ? busy / total : 0,
            workerRssBytes: stats.reduce((sum, entry) => sum + entry.rss, 0),
            workerRssMaxBytes: Math.max(0, ...stats.map((entry) => entry.rss)),
            workerCpuMs: stats.reduce((sum, entry) => sum + entry.cpuMs, 0),
            systemAvailableBytes: availableMemory(),
            redisUsedBytes: (await redisCounters(redis)).usedMemory,
            pgActive: Number(active?.count ?? 0),
          });
        })().catch(() => {});
      }, 1_000);

      const submitted = await Promise.all(
        Array.from({ length: runs }, () =>
          backtests.submitRun(owner, parseCreateBacktestRunRequest(body)),
        ),
      );
      runIds.push(...submitted.map((run) => run.id));

      const deadline = startedAt + args.timeoutMinutes * 60_000;
      for (;;) {
        const pending = await prisma.backtestRun.count({
          where: {
            id: { in: runIds },
            status: { notIn: ["COMPLETED", "FAILED"] },
          },
        });
        if (pending === 0) {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out with ${pending} of ${runs} runs unfinished`,
          );
        }
        if (workers.every((child) => child.exitCode !== null)) {
          throw new Error("Every worker exited before the runs finished");
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
      }
      const wallMs = Date.now() - startedAt;
      if (sampler) {
        clearInterval(sampler);
        sampler = null;
      }
      const redisAfter = await redisCounters(redis);
      const pgAfter = await pgCounters(prisma);
      const workerCpuMs =
        workers.reduce(
          (sum, child) => sum + processStats(child.pid ?? 0).cpuMs,
          0,
        ) - workerCpuBefore;

      const rows = await prisma.backtestRun.findMany({
        where: { id: { in: runIds } },
        select: {
          id: true,
          status: true,
          failureCode: true,
          queuedAt: true,
          startedAt: true,
          completedAt: true,
          securityCount: true,
          job: { select: { claimedAt: true, attempts: true } },
          summary: { select: { totalTrades: true, tradingDays: true } },
        },
      });
      const timings = workerTimings(logDirectory, workers.length);
      const perRun = await Promise.all(
        rows.map(async (row) => {
          const timing = timings.get(row.id);
          const claimedAt = row.job?.claimedAt ?? row.startedAt;
          return {
            runId: row.id,
            status: row.status,
            failureCode: row.failureCode,
            attempts: row.job?.attempts ?? null,
            securityCount: row.securityCount,
            queueWaitMs: claimedAt
              ? claimedAt.getTime() - row.queuedAt.getTime()
              : null,
            durationMs:
              row.completedAt && row.startedAt
                ? row.completedAt.getTime() - row.startedAt.getTime()
                : null,
            preparationMs: timing?.framesLoadedMs ?? null,
            preparedSecurities: timing?.securityCount ?? null,
            skippedSecurities: timing?.skippedCount ?? null,
            frameReadMs: timing?.windowLoadMs ?? null,
            windows: timing?.windows ?? null,
            providerEvents: timing?.providerErrors ?? 0,
            trades: row.summary?.totalTrades ?? null,
            tradingDays: row.summary?.tradingDays ?? null,
            digest: await resultDigest(prisma, row.id),
          };
        }),
      );
      const durations = perRun
        .map((run) => run.durationMs)
        .filter((value): value is number => value !== null);
      const digests = new Set(perRun.map((run) => run.digest));
      const peak = (pick: (sample: Sample) => number) =>
        samples.length === 0 ? 0 : Math.max(...samples.map(pick));
      const mean = (pick: (sample: Sample) => number) =>
        samples.length === 0
          ? 0
          : samples.reduce((sum, sample) => sum + pick(sample), 0) /
            samples.length;
      const hits = redisAfter.hits - redisBefore.hits;
      const misses = redisAfter.misses - redisBefore.misses;
      const entry = {
        label: args.label,
        strategy: args.strategy,
        list: args.list,
        owner: args.owner,
        concurrency: args.concurrency,
        runs,
        listItems: list._count.items,
        period: { from: body.startDate, to: body.endDate },
        machine: {
          cpus: cpus().length,
          cpuModel: cpus()[0]?.model ?? "unknown",
          totalMemoryBytes: totalmem(),
          node: process.version,
        },
        // Names and safe values only: a URL, key or secret is never written to a report.
        workerEnv: Object.fromEntries(
          Object.entries(args.workerEnv).map(([key, value]) => [
            key,
            /URL|KEY|SECRET|TOKEN|PASSWORD/i.test(key) ? "<redacted>" : value,
          ]),
        ),
        pgConnectionsPerWorker: args.pgConnections,
        wallMs,
        throughputRunsPerHour:
          Math.round((runs / wallMs) * 3_600_000 * 100) / 100,
        perRunMs: {
          mean: durations.length
            ? Math.round(
                durations.reduce((a, b) => a + b, 0) / durations.length,
              )
            : null,
          p50: percentile(durations, 0.5),
          p95: percentile(durations, 0.95),
          max: Math.max(0, ...durations),
        },
        completed: perRun.filter((run) => run.status === "COMPLETED").length,
        failed: perRun.filter((run) => run.status === "FAILED").length,
        identicalResults: digests.size === 1 && !digests.has(null),
        cpu: {
          meanBusyShare:
            Math.round(mean((sample) => sample.cpuBusyShare) * 1000) / 1000,
          peakBusyShare:
            Math.round(peak((sample) => sample.cpuBusyShare) * 1000) / 1000,
          workerCpuMs,
          workerCpuMsPerRun: Math.round(workerCpuMs / runs),
        },
        memory: {
          workerRssPeakBytes: peak((sample) => sample.workerRssBytes),
          workerRssPerProcessPeakBytes: peak(
            (sample) => sample.workerRssMaxBytes,
          ),
          systemAvailableMinBytes:
            samples.length === 0
              ? null
              : Math.min(
                  ...samples.map((sample) => sample.systemAvailableBytes),
                ),
          redisUsedPeakBytes: peak((sample) => sample.redisUsedBytes),
        },
        redis: {
          hitRate:
            hits + misses > 0
              ? Math.round((hits / (hits + misses)) * 10_000) / 10_000
              : null,
          hits,
          misses,
          commands: redisAfter.commands - redisBefore.commands,
          bytesSent: redisAfter.netOutputBytes - redisBefore.netOutputBytes,
          bytesReceived: redisAfter.netInputBytes - redisBefore.netInputBytes,
          serverCpuSeconds:
            Math.round((redisAfter.cpuSeconds - redisBefore.cpuSeconds) * 100) /
            100,
        },
        postgres: {
          transactions: pgAfter.transactions - pgBefore.transactions,
          blocksRead: pgAfter.blocksRead - pgBefore.blocksRead,
          blocksHit: pgAfter.blocksHit - pgBefore.blocksHit,
          tuplesReturned: pgAfter.tuplesReturned - pgBefore.tuplesReturned,
          tuplesFetched: pgAfter.tuplesFetched - pgBefore.tuplesFetched,
          peakActiveConnections: peak((sample) => sample.pgActive),
        },
        perRun,
        logs: logDirectory,
      };
      const reportPath = resolve(repositoryRoot(), args.report);
      mkdirSync(dirname(reportPath), { recursive: true });
      appendFileSync(reportPath, `${JSON.stringify(entry)}\n`);
      const headline: Partial<typeof entry> = { ...entry };
      delete headline.perRun;
      process.stdout.write(`${JSON.stringify(headline, null, 2)}\n`);
    } finally {
      if (sampler) {
        clearInterval(sampler);
      }
      await stopWorkers(workers);
    }
  } finally {
    redis.disconnect();
    await context.close();
  }
}

/** The earliest start the product accepts: thirty years before today. */
function earliestStart(today: string): string {
  const [year, month, day] = today.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const candidate = new Date(Date.UTC(year - 30, month - 1, day));
  // One day later than the boundary, so the newest finalized session moving cannot refuse it.
  return new Date(candidate.getTime() + DAY_MS).toISOString().slice(0, 10);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
