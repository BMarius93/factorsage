import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import {
  LEGAL_ACCEPTANCE_BUNDLE,
  legalDocument,
  type UserPlan,
} from "@intrinsic/contracts";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import * as argon2 from "argon2";
import {
  benchEnvironment,
  benchProcessEnvironment,
} from "../backtest-benchmark/bench-environment";
import { syntheticSymbol } from "../backtest-benchmark/synthetic-fmp";
import { repositoryRoot } from "../qa-matrix/matrix-paths";

/**
 * Interactive load against a running API while backtests execute (`docs/production/benchmarks.md`,
 * "Interactive load").
 *
 * ```bash
 * # once, against the isolated benchmark database (BENCH_DATABASE_URL / BENCH_REDIS_URL as for
 * # bench:scale-backtests); LOAD_TEST_PASSWORD is any throwaway value, never written to disk
 * LOAD_TEST_PASSWORD=… pnpm --filter @intrinsic/api load:interactive -- setup --users 100
 * # against an API started on the benchmark environment (see the runbook for the exact command)
 * LOAD_TEST_PASSWORD=… pnpm --filter @intrinsic/api load:interactive -- run \
 *   --base-url http://127.0.0.1:3101 --users 50 --duration-s 180 --label "50u during H"
 * ```
 *
 * `setup` creates `load-user-NNN@factorsage.invalid` accounts across the four plans with the
 * current legal acceptance, one 25-stock List, one Strategy, three Monitors and one completed
 * backtest each (a copy of a completed benchmark run's stored result, so result, chart and trade-log
 * pages read real rows). `run` signs each virtual user in through the real login route, then loops
 * weighted journeys — dashboard, market overview, stock details, strategy builder, lists, backtest
 * history, a run page with live-progress polling, results and trades, monitors, billing — with think
 * time between them, and reports latency percentiles per route, errors, throughput and the API
 * process's CPU, memory and event-loop delay. The load generator is its own OS process.
 */

const EMAIL_DOMAIN = "factorsage.invalid";
const PLAN_MIX: readonly UserPlan[] = [
  "FREE",
  "FREE",
  "FREE",
  "FREE",
  "STARTER",
  "STARTER",
  "STARTER",
  "PRO",
  "PRO",
  "PRO_PLUS",
];

type Arguments = {
  command: "setup" | "run";
  users: number;
  baseUrl: string;
  durationS: number;
  thinkMs: number;
  rampS: number;
  label: string;
  report: string;
  apiPid: number | null;
  /** The API's stderr log, whose `bench.event-loop` lines (`event-loop-probe.cjs`) are summarized. */
  apiLog: string | null;
  /** Count executing and queued backtests in the benchmark database while the load runs. */
  sampleJobs: boolean;
  /** Share of Stock Details views of the canonical (protected-tier) universe; the rest are long-tail. */
  popularShare: number;
  /** `setup`: the size of the completed benchmark run each user's history copies. */
  templateSize: number;
  /** `run`: the first load account this process signs in as, so two processes can split the accounts. */
  firstUser: number;
};

function parseArguments(argv: readonly string[]): Arguments {
  const [command, ...rest] = argv.filter((value) => value !== "--");
  if (command !== "setup" && command !== "run") {
    throw new Error("Usage: interactive-load <setup|run> [options]");
  }
  const parsed: Arguments = {
    command,
    users: 20,
    baseUrl: "http://127.0.0.1:3101",
    durationS: 120,
    thinkMs: 2_000,
    rampS: 20,
    label: "",
    report: "docs/production/benchmark-results/interactive-load.jsonl",
    apiPid: null,
    apiLog: null,
    sampleJobs: false,
    popularShare: 0.8,
    templateSize: 250,
    firstUser: 1,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] as string;
    const value = rest[index + 1];
    if (value === undefined) {
      throw new Error(`${flag} needs a value`);
    }
    index += 1;
    switch (flag) {
      case "--users":
        parsed.users = Number(value);
        break;
      case "--first-user":
        parsed.firstUser = Number(value);
        break;
      case "--base-url":
        parsed.baseUrl = value.replace(/\/$/, "");
        break;
      case "--duration-s":
        parsed.durationS = Number(value);
        break;
      case "--think-ms":
        parsed.thinkMs = Number(value);
        break;
      case "--ramp-s":
        parsed.rampS = Number(value);
        break;
      case "--label":
        parsed.label = value;
        break;
      case "--report":
        parsed.report = value;
        break;
      case "--api-pid":
        parsed.apiPid = Number(value);
        break;
      case "--api-log":
        parsed.apiLog = value;
        break;
      case "--sample-jobs":
        parsed.sampleJobs = value === "true";
        break;
      case "--popular-share":
        parsed.popularShare = Number(value);
        break;
      case "--template-size":
        parsed.templateSize = Number(value);
        break;
      default:
        throw new Error(`Unknown argument ${flag}`);
    }
  }
  return parsed;
}

function password(): string {
  const value = process.env.LOAD_TEST_PASSWORD?.trim();
  if (!value || value.length < 12) {
    throw new Error(
      "LOAD_TEST_PASSWORD (12+ characters, throwaway) is required",
    );
  }
  return value;
}

function email(index: number): string {
  return `load-user-${String(index).padStart(3, "0")}@${EMAIL_DOMAIN}`;
}

/** Copies every column of `table`'s rows for `fromRunId` to `toRunId`, generating fresh ids. */
async function cloneRunRows(
  prisma: PrismaClient,
  table: string,
  fromRunId: string,
  toRunId: string,
): Promise<void> {
  const columns = (
    await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table}
      ORDER BY ordinal_position`
  ).map((row) => row.column_name);
  if (columns.length === 0) {
    return;
  }
  const quoted = columns.map((column) => `"${column}"`).join(", ");
  const projected = columns
    .map((column) =>
      column === "runId"
        ? `'${toRunId}'::text`
        : column === "id"
          ? "gen_random_uuid()::text"
          : `"${column}"`,
    )
    .join(", ");
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${table}" (${quoted}) SELECT ${projected} FROM "${table}" WHERE "runId" = $1`,
    fromRunId,
  );
}

async function setup(args: Arguments): Promise<unknown> {
  const prisma = new PrismaClient();
  try {
    // A Pro-sized result (250 securities, 30 years by default): realistic pages without copying the
    // hundreds of thousands of trade rows a 1,000-security run holds into every account.
    const template = await prisma.backtestRun.findFirst({
      where: {
        status: "COMPLETED",
        summary: { isNot: null },
        securityCount: args.templateSize,
        user: { email: { startsWith: "scale-bench-" } },
      },
      orderBy: { completedAt: "desc" },
      select: { id: true },
    });
    if (!template) {
      throw new Error(
        "No completed benchmark run to copy: run bench:scale-backtests first",
      );
    }
    const strategyTemplate = await prisma.strategyVersion.findFirst({
      where: { strategy: { name: { startsWith: "SCALE-BENCH-simple" } } },
      select: { definition: true, definitionHash: true },
    });
    if (!strategyTemplate) {
      throw new Error(
        "No benchmark strategy to copy: run bench:scale-backtests setup first",
      );
    }
    const passwordHash = await argon2.hash(password(), {
      type: argon2.argon2id,
    });
    const securities = await prisma.security.findMany({
      where: {
        providerSymbol: {
          in: Array.from({ length: 200 }, (_, index) =>
            syntheticSymbol(index + 1),
          ),
        },
      },
      select: { id: true },
      orderBy: { providerSymbol: "asc" },
    });
    const columnsTables = [
      "BacktestRunSummary",
      "BacktestDailyEquity",
      "BacktestRunMilestone",
      "BacktestTrade",
      "BacktestPosition",
    ];
    let created = 0;
    for (let index = 1; index <= args.users; index += 1) {
      const plan = PLAN_MIX[(index - 1) % PLAN_MIX.length] as UserPlan;
      const user = await prisma.user.upsert({
        where: { email: email(index) },
        create: {
          email: email(index),
          passwordHash,
          emailVerifiedAt: new Date(),
          plan,
        },
        update: { passwordHash, plan },
        select: { id: true },
      });
      await prisma.legalRecord.createMany({
        data: LEGAL_ACCEPTANCE_BUNDLE.map(({ kind, record }) => ({
          userId: user.id,
          documentKind: kind,
          documentVersion: legalDocument(kind).version,
          documentHash: legalDocument(kind).contentHash,
          record,
          surface: "EXISTING_ACCOUNT" as const,
        })),
        skipDuplicates: true,
      });
      if ((await prisma.stockList.count({ where: { userId: user.id } })) > 0) {
        continue;
      }
      // A list within every plan's limit (10 on Free).
      const size = plan === "FREE" ? 10 : 25;
      const members = securities.slice(
        (index * 7) % 150,
        ((index * 7) % 150) + size,
      );
      const list = await prisma.stockList.create({
        data: {
          userId: user.id,
          name: `Load list ${index}`,
          items: {
            create: members.map((security) => ({ securityId: security.id })),
          },
        },
        select: { id: true },
      });
      const strategy = await prisma.strategy.create({
        data: {
          userId: user.id,
          name: `Load strategy ${index}`,
          versions: {
            create: {
              versionNumber: 1,
              definition: strategyTemplate.definition as object,
              definitionHash: strategyTemplate.definitionHash,
            },
          },
        },
        select: { id: true },
      });
      for (let monitor = 0; monitor < 3; monitor += 1) {
        await prisma.monitor.create({
          data: {
            userId: user.id,
            name: `Load monitor ${index}-${monitor}`,
            strategyId: strategy.id,
            stockListId: list.id,
            // Only Free's single allowance is switched on there; the worker does not run here.
            enabled: plan !== "FREE" || monitor === 0,
          },
        });
      }
      // One completed run: the template's stored result under this user, so every result read is
      // real rows. Its list and strategy links are cleared, as they would be had the originals been
      // deleted; the run page reads the immutable snapshot.
      const runId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO "BacktestRun" (
          "id", "userId", "runNumber", "strategyId", "strategyVersionId", "stockListId", "benchmarkId",
          "benchmarkSeriesId", "executionCalendarSeriesId", "status", "startDate", "endDate",
          "initialCapital", "monthlyContribution", "maximumPositions", "strategyName", "stockListName",
          "benchmarkName", "securityCount", "snapshot", "snapshotHash", "queuedAt", "startedAt",
          "completedAt", "createdAt", "updatedAt")
        SELECT ${runId}, ${user.id}, 1, NULL, NULL, NULL, "benchmarkId", "benchmarkSeriesId",
          "executionCalendarSeriesId", "status", "startDate", "endDate", "initialCapital",
          "monthlyContribution", "maximumPositions", "strategyName", "stockListName", "benchmarkName",
          "securityCount", "snapshot", "snapshotHash", "queuedAt", "startedAt", "completedAt", now(), now()
        FROM "BacktestRun" WHERE "id" = ${template.id}`;
      for (const table of columnsTables) {
        await cloneRunRows(prisma, table, template.id, runId);
      }
      await prisma.$executeRaw`
        INSERT INTO "BacktestRunNumberCounter" ("userId", "lastRunNumber")
        VALUES (${user.id}, 1) ON CONFLICT ("userId") DO NOTHING`;
      created += 1;
    }
    return {
      command: "setup",
      users: args.users,
      created,
      template: template.id,
    };
  } finally {
    await prisma.$disconnect();
  }
}

type Sample = { route: string; status: number; ms: number; at: number };

class Session {
  private cookie = "";
  constructor(
    private readonly baseUrl: string,
    private readonly samples: Sample[],
  ) {}

  async request(
    route: string,
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const startedAt = performance.now();
    let status = 0;
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(this.cookie ? { cookie: this.cookie } : {}),
          ...(init.headers ?? {}),
        },
      });
      status = response.status;
      const setCookie = response.headers.getSetCookie?.() ?? [];
      if (setCookie.length > 0) {
        this.cookie = setCookie.map((value) => value.split(";")[0]).join("; ");
      }
      const text = await response.text();
      return text && response.headers.get("content-type")?.includes("json")
        ? JSON.parse(text)
        : text;
    } catch {
      status = -1;
      return null;
    } finally {
      this.samples.push({
        route,
        status,
        ms: performance.now() - startedAt,
        at: Date.now(),
      });
    }
  }
}

type Context = {
  runId: string | null;
  listId: string | null;
  strategyId: string | null;
  monitorId: string | null;
};

/**
 * The benchmark universe (`bench:scale-backtests setup`): `SYN0001…SYN0735` are the canonical
 * universe (protected tier), `SYN0736…SYN1735` the hydrated long tail (LRU tier).
 */
const PROTECTED_UNIVERSE = 735;
const LONG_TAIL = 1_000;
let popularShare = 0.8;

const JOURNEYS: readonly {
  name: string;
  weight: number;
  steps: (
    session: Session,
    context: Context,
    pick: () => number,
  ) => Promise<void>;
}[] = [
  {
    name: "dashboard",
    weight: 20,
    steps: async (session) => {
      await session.request("GET /dashboard", "/dashboard");
      await session.request("GET /market-overview", "/market-overview");
      await session.request("GET /dashboard/activity", "/dashboard/activity");
    },
  },
  {
    name: "stock-details",
    weight: 20,
    steps: async (session, _context, pick) => {
      // Most views are of well-known names (the canonical universe, always resident); the rest are
      // the long tail, read through the LRU — a cold one is rebuilt from PostgreSQL on the read.
      const popular = pick() < popularShare;
      const symbol = popular
        ? syntheticSymbol(1 + Math.floor(pick() * PROTECTED_UNIVERSE))
        : syntheticSymbol(
            PROTECTED_UNIVERSE + 1 + Math.floor(pick() * LONG_TAIL),
          );
      const tier = popular ? "[protected]" : "[long tail]";
      await session.request(
        "GET /stocks/search",
        `/stocks/search?q=${symbol.slice(0, 5)}`,
      );
      await session.request(`GET /stocks/:symbol ${tier}`, `/stocks/${symbol}`);
      await session.request(
        `GET /stocks/:symbol/summary ${tier}`,
        `/stocks/${symbol}/summary`,
      );
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 365 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      await session.request(
        `GET /stocks/:symbol/prices ${tier}`,
        `/stocks/${symbol}/prices?from=${from}&to=${to}`,
      );
      await session.request(
        `GET /stocks/:symbol/technicals/daily ${tier}`,
        `/stocks/${symbol}/technicals/daily?from=${from}&to=${to}&series=SMA_50D,SMA_200D,RSI_14D`,
      );
    },
  },
  {
    name: "strategy-builder",
    weight: 10,
    steps: async (session, context) => {
      await session.request("GET /strategies", "/strategies");
      if (context.strategyId) {
        await session.request(
          "GET /strategies/:id",
          `/strategies/${context.strategyId}`,
        );
      }
      await session.request("GET /benchmarks", "/benchmarks");
    },
  },
  {
    name: "lists",
    weight: 10,
    steps: async (session, context) => {
      await session.request("GET /lists", "/lists");
      if (context.listId) {
        await session.request("GET /lists/:id", `/lists/${context.listId}`);
        // An edit, as a person renaming or annotating a List: a write beside every read.
        await session.request("PATCH /lists/:id", `/lists/${context.listId}`, {
          method: "PATCH",
          body: JSON.stringify({
            description: `Edited ${new Date().toISOString()}`,
          }),
        });
      }
    },
  },
  {
    name: "backtest-history",
    weight: 10,
    steps: async (session) => {
      await session.request("GET /backtests", "/backtests?page=1&pageSize=25");
      await session.request(
        "GET /backtests?status=ACTIVE",
        "/backtests?status=ACTIVE",
      );
    },
  },
  {
    name: "run-page-polling",
    weight: 10,
    steps: async (session, context) => {
      if (!context.runId) {
        return;
      }
      await session.request(
        "GET /backtests/:id",
        `/backtests/${context.runId}`,
      );
      // The running page polls progress every two seconds; ten polls.
      for (let poll = 0; poll < 10; poll += 1) {
        await session.request(
          "GET /backtests/:id/progress",
          `/backtests/${context.runId}/progress`,
        );
        await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      }
    },
  },
  {
    name: "results",
    weight: 10,
    steps: async (session, context) => {
      if (!context.runId) {
        return;
      }
      await session.request(
        "GET /backtests/:id",
        `/backtests/${context.runId}`,
      );
      await session.request(
        "GET /backtests/:id/trades",
        `/backtests/${context.runId}/trades?page=1&pageSize=50`,
      );
      await session.request(
        "GET /backtests/:id/strategy",
        `/backtests/${context.runId}/strategy`,
      );
    },
  },
  {
    name: "monitors",
    weight: 7,
    steps: async (session, context) => {
      await session.request("GET /monitors", "/monitors");
      if (context.monitorId) {
        // The Monitor page: its current conditions, its signal table and its activity feed.
        await session.request(
          "GET /monitors/:id",
          `/monitors/${context.monitorId}`,
        );
        await session.request(
          "GET /monitors/:id/signals",
          `/monitors/${context.monitorId}/signals`,
        );
        await session.request(
          "GET /monitors/:id/activity",
          `/monitors/${context.monitorId}/activity`,
        );
      }
    },
  },
  {
    name: "billing",
    weight: 3,
    steps: async (session) => {
      await session.request("GET /billing/status", "/billing/status");
      await session.request("GET /entitlements", "/entitlements");
    },
  },
];

function percentile(values: readonly number[], share: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(
    sorted[
      Math.min(sorted.length - 1, Math.floor(share * sorted.length))
    ] as number,
  );
}

function processStats(pid: number): { rss: number; cpuMs: number } {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      rss,
      cpuMs: ((Number(fields[11] ?? 0) + Number(fields[12] ?? 0)) * 1000) / 100,
    };
  } catch {
    return { rss: 0, cpuMs: 0 };
  }
}

/** `bench.event-loop` lines of the API's probe inside a window. */
function eventLoopIn(path: string | null, from: number, to: number) {
  if (!path) {
    return null;
  }
  const samples: { p99Ms: number; maxMs: number; p50Ms: number }[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"bench.event-loop"')) {
      continue;
    }
    try {
      const record = JSON.parse(line) as {
        at: string;
        p99Ms: number;
        maxMs: number;
        p50Ms: number;
      };
      const at = Date.parse(record.at);
      if (at >= from && at <= to) {
        samples.push(record);
      }
    } catch {
      // A partial line written while this read: skipped.
    }
  }
  return {
    samples: samples.length,
    p50MsMedian: percentile(
      samples.map((sample) => sample.p50Ms),
      0.5,
    ),
    p99MsMedian: percentile(
      samples.map((sample) => sample.p99Ms),
      0.5,
    ),
    p99MsMax: Math.round(Math.max(0, ...samples.map((sample) => sample.p99Ms))),
    maxMs: Math.round(Math.max(0, ...samples.map((sample) => sample.maxMs))),
  };
}

async function run(args: Arguments): Promise<unknown> {
  const secret = password();
  popularShare = args.popularShare;
  // Backtest activity while the load runs, from the benchmark database (read-only counts).
  const jobs: { at: number; executing: number; queued: number }[] = [];
  const jobsPrisma = args.sampleJobs
    ? new PrismaClient({
        datasources: { db: { url: benchEnvironment().databaseUrl } },
      })
    : null;
  const jobSampler = jobsPrisma
    ? setInterval(() => {
        void jobsPrisma.$queryRaw<{ executing: bigint; queued: bigint }[]>`
          SELECT count(*) FILTER (WHERE status = 'CLAIMED') AS executing,
                 count(*) FILTER (WHERE status = 'QUEUED') AS queued
          FROM "BacktestJob"`
          .then(([row]) =>
            jobs.push({
              at: Date.now(),
              executing: Number(row?.executing ?? 0),
              queued: Number(row?.queued ?? 0),
            }),
          )
          .catch(() => undefined);
      }, 2_000)
    : null;
  const samples: Sample[] = [];
  const loginFailures: string[] = [];
  const startedAt = Date.now();
  const deadline = startedAt + (args.rampS + args.durationS) * 1_000;
  const apiBefore = args.apiPid ? processStats(args.apiPid) : null;
  const rss: number[] = [];
  const sampler = args.apiPid
    ? setInterval(
        () => rss.push(processStats(args.apiPid as number).rss),
        1_000,
      )
    : null;
  let measuredFrom = 0;

  const totalWeight = JOURNEYS.reduce(
    (sum, journey) => sum + journey.weight,
    0,
  );
  await Promise.all(
    Array.from({ length: args.users }, async (_, index) => {
      let state = (index + 1) * 2_654_435_761;
      const pick = () => {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        return state / 2 ** 32;
      };
      // Staggered over the ramp, as people arrive.
      await new Promise((resolveWait) =>
        setTimeout(
          resolveWait,
          (args.rampS * 1_000 * index) / Math.max(1, args.users),
        ),
      );
      const session = new Session(args.baseUrl, samples);
      const login = (await session.request("POST /auth/login", "/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: email(args.firstUser + index),
          password: secret,
        }),
      })) as { user?: unknown } | null;
      if (
        !login ||
        typeof login !== "object" ||
        !("user" in login || "id" in (login as object))
      ) {
        loginFailures.push(email(args.firstUser + index));
      }
      const lists = (await session.request("GET /lists", "/lists")) as
        { id: string }[] | null;
      const strategies = (await session.request(
        "GET /strategies",
        "/strategies",
      )) as { id: string }[] | null;
      const runs = (await session.request("GET /backtests", "/backtests")) as
        { id: string }[] | null;
      const monitors = (await session.request("GET /monitors", "/monitors")) as
        { id: string }[] | null;
      const context: Context = {
        listId: Array.isArray(lists)
          ? (lists.find((list) => list.id)?.id ?? null)
          : null,
        strategyId: Array.isArray(strategies)
          ? (strategies[strategies.length - 1]?.id ?? null)
          : null,
        runId: Array.isArray(runs) ? (runs[0]?.id ?? null) : null,
        monitorId: Array.isArray(monitors)
          ? (monitors[monitors.length - 1]?.id ?? null)
          : null,
      };
      while (Date.now() < deadline) {
        let roll = pick() * totalWeight;
        const journey =
          JOURNEYS.find((candidate) => (roll -= candidate.weight) < 0) ??
          JOURNEYS[0];
        await journey?.steps(session, context, pick);
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, args.thinkMs * (0.5 + pick())),
        );
      }
    }),
  );
  if (sampler) {
    clearInterval(sampler);
  }
  if (jobSampler) {
    clearInterval(jobSampler);
  }
  await jobsPrisma?.$disconnect();
  const finishedAt = Date.now();
  measuredFrom = startedAt + args.rampS * 1_000;
  const wallS = (finishedAt - startedAt) / 1_000;
  const apiAfter = args.apiPid ? processStats(args.apiPid) : null;
  // Percentiles cover the steady state only: the ramp, its sign-ins included, is excluded.
  const measured = samples.filter((sample) => sample.at >= measuredFrom);
  const measuredS = Math.max(1, (finishedAt - measuredFrom) / 1_000);
  const jobsMeasured = jobs.filter((sample) => sample.at >= measuredFrom);

  const byRoute = new Map<string, Sample[]>();
  for (const sample of measured) {
    byRoute.set(sample.route, [...(byRoute.get(sample.route) ?? []), sample]);
  }
  const routes = [...byRoute.entries()]
    .map(([route, entries]) => {
      const ok = entries.filter(
        (entry) => entry.status >= 200 && entry.status < 400,
      );
      return {
        route,
        requests: entries.length,
        errors: entries.length - ok.length,
        statuses: Object.fromEntries(
          [...new Set(entries.map((entry) => entry.status))].map((status) => [
            status,
            entries.filter((entry) => entry.status === status).length,
          ]),
        ),
        p50: percentile(
          ok.map((entry) => entry.ms),
          0.5,
        ),
        p95: percentile(
          ok.map((entry) => entry.ms),
          0.95,
        ),
        p99: percentile(
          ok.map((entry) => entry.ms),
          0.99,
        ),
        max: Math.round(Math.max(0, ...ok.map((entry) => entry.ms))),
      };
    })
    .sort((left, right) => right.requests - left.requests);
  const all = measured.filter(
    (sample) => sample.status >= 200 && sample.status < 400,
  );
  const report = {
    label: args.label,
    recordedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    users: args.users,
    firstUser: args.firstUser,
    durationS: args.durationS,
    rampS: args.rampS,
    thinkMs: args.thinkMs,
    machine: {
      cpus: cpus().length,
      totalMemoryBytes: totalmem(),
      node: process.version,
    },
    requests: measured.length,
    requestsIncludingRamp: samples.length,
    throughputPerS: Math.round((measured.length / measuredS) * 10) / 10,
    errors: measured.length - all.length,
    errorRate:
      measured.length === 0
        ? 0
        : Math.round(
            ((measured.length - all.length) / measured.length) * 10_000,
          ) / 10_000,
    loginFailures: loginFailures.length,
    latencyMs: {
      p50: percentile(
        all.map((entry) => entry.ms),
        0.5,
      ),
      p95: percentile(
        all.map((entry) => entry.ms),
        0.95,
      ),
      p99: percentile(
        all.map((entry) => entry.ms),
        0.99,
      ),
      max: Math.round(Math.max(0, ...all.map((entry) => entry.ms))),
    },
    api:
      apiBefore && apiAfter
        ? {
            cpuMs: apiAfter.cpuMs - apiBefore.cpuMs,
            cpuShareOfOneCore:
              Math.round(
                ((apiAfter.cpuMs - apiBefore.cpuMs) / (wallS * 1_000)) * 1_000,
              ) / 1_000,
            rssPeakBytes: Math.max(0, ...rss),
          }
        : null,
    apiEventLoop: eventLoopIn(args.apiLog, measuredFrom, finishedAt),
    backtests: jobsPrisma
      ? {
          samples: jobsMeasured.length,
          executingMin: Math.min(
            ...jobsMeasured.map((sample) => sample.executing),
          ),
          executingMax: Math.max(
            0,
            ...jobsMeasured.map((sample) => sample.executing),
          ),
          executingMean:
            Math.round(
              (jobsMeasured.reduce((sum, sample) => sum + sample.executing, 0) /
                Math.max(1, jobsMeasured.length)) *
                100,
            ) / 100,
          shareAtFour:
            Math.round(
              (jobsMeasured.filter((sample) => sample.executing >= 4).length /
                Math.max(1, jobsMeasured.length)) *
                100,
            ) / 100,
          queuedMax: Math.max(
            0,
            ...jobsMeasured.map((sample) => sample.queued),
          ),
        }
      : null,
    measuredFrom: new Date(measuredFrom).toISOString(),
    routes,
  };
  const path = resolve(repositoryRoot(), args.report);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(report)}\n`);
  const headline: Partial<typeof report> = { ...report };
  delete headline.routes;
  return {
    ...headline,
    slowestRoutes: routes.sort((a, b) => b.p95 - a.p95).slice(0, 8),
  };
}

async function main(): Promise<void> {
  loadRootEnv();
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "setup") {
    // Fixtures only ever go into the isolated benchmark database.
    const bench = benchEnvironment();
    Object.assign(process.env, benchProcessEnvironment(bench));
    process.stdout.write(`${JSON.stringify(await setup(args), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(await run(args), null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
