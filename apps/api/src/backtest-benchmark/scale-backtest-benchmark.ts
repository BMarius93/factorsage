import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  validateStrategyDefinition,
  VALUATION_RATIO_IDS,
  type AuthUser,
  type UserPlan,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import { getBacktestWorkerConfig, loadRootEnv } from "@intrinsic/config";
import type { Prisma, PrismaClient } from "@intrinsic/database";
import { createLogger } from "@intrinsic/observability";
import { createStockDataRedisClient, subtractYears } from "@intrinsic/stock-data";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AuthModule } from "../auth/auth.module";
import { reconcileBenchmarkCatalog } from "../benchmarks/benchmark-catalog.service";
import { BacktestsModule } from "../backtests/backtests.module";
import { BacktestsService } from "../backtests/backtests.service";
import { parseCreateBacktestRunRequest } from "../backtests/backtest-requests";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { createIndexUniverseRuntime } from "../index-universe/index-universe-runtime.js";
import { repositoryRoot } from "../qa-matrix/matrix-paths";
import {
  benchEnvironment,
  benchProcessEnvironment,
  type BenchEnvironment,
} from "./bench-environment";
import {
  BENCHMARK_STRATEGIES,
  type BenchmarkStrategyKey,
} from "./benchmark-strategies";
import { syntheticProfile, syntheticSymbol } from "./synthetic-fmp";

/**
 * Backtests at plan-limit sizes over a synthetic thirty-year universe, in an isolated environment
 * (`docs/production/benchmarks.md`).
 *
 * ```bash
 * # once: an isolated database and Redis database, and the synthetic provider
 * export BENCH_DATABASE_URL=postgresql://…/intrinsic_value_bench BENCH_REDIS_URL=redis://localhost:6379/5
 * pnpm --filter @intrinsic/api bench:synthetic-fmp -- --universe 4000 &
 * pnpm --filter @intrinsic/api bench:scale-backtests -- setup --securities 4000 --protected 735
 * pnpm --filter @intrinsic/api bench:scale-backtests -- hydrate --from 1 --to 1735
 * # a scenario: A…H, cold|warm|miss, protected|mixed|ordinary, shared|disjoint
 * pnpm --filter @intrinsic/api bench:scale-backtests -- run --scenario H --cache cold --mix mixed
 * pnpm --filter @intrinsic/api bench:scale-backtests -- audit
 * ```
 *
 * **What is real and what is synthetic.** Every run is submitted through `BacktestsService.submitRun`
 * (validation, entitlements, the deployment-wide queue bound, the immutable snapshot) as the fixture
 * user of the scenario's plan, and executed by real backtest worker processes — the worker build's
 * `worker-process.js` — under the production sizing (`STOCK_LRU_MAX_SECURITIES=500`,
 * `BACKTEST_GLOBAL_MAX_RUNNING=4`). PostgreSQL, Redis, the canonical loader, the request gate and the
 * FMP client are the product's. Only the provider is synthetic (`synthetic-fmp.ts`): its data are
 * deterministic and its timings are not FMP's, so a `miss` here measures the product's own miss path
 * — gate, client, normalization, persistence, derived state, cache population — against a provider
 * that answers in `--latency-ms`, never FMP's real latency or quota.
 *
 * **The universe.** `SYN0001…SYN{protected}` are a canonical built-in universe (resolved
 * `IndexConstituent` rows, exactly what the S&P 500 point-in-time universe is), so they route to the
 * protected tier from PostgreSQL as the real universe does; every other synthetic security is an
 * ordinary LRU security. `--mix` decides a List's share of protected members (protected 100%, mixed
 * 60%, ordinary 0%), `--overlap` whether the ordinary members of concurrent runs are the same
 * (`shared`) or distinct (`disjoint`, the LRU's worst case).
 *
 * **Cache states.** `cold`: the isolated Redis database is flushed, PostgreSQL holds everything (a
 * PostgreSQL → Redis rebuild, never a provider miss). `warm`: nothing is flushed — run it after a
 * cold run of the same scenario. `miss`: the ordinary members are securities nothing has hydrated
 * yet, so each one is downloaded from the (synthetic) provider, normalized, persisted and projected.
 *
 * Reports: one JSON line per invocation in `--report` (default
 * `docs/production/benchmark-results/scale-backtests.jsonl`); worker logs under
 * `artifacts/scale-benchmark/` (git-ignored). Aggregates only.
 */

const EMAIL_DOMAIN = "factorsage.invalid";
const NAME_PREFIX = "SCALE-BENCH-";
const DAY_MS = 86_400_000;

const PERSONAS = {
  free: "FREE",
  starter: "STARTER",
  "pro-a": "PRO",
  "pro-b": "PRO",
  "proplus-a": "PRO_PLUS",
  "proplus-b": "PRO_PLUS",
} as const satisfies Record<string, UserPlan>;
type Persona = keyof typeof PERSONAS;

type ScenarioKey = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I";

/** The task's scenarios: who submits, and how many symbols each run holds. */
const SCENARIOS: Record<ScenarioKey, readonly { persona: Persona; size: number }[]> = {
  A: [{ persona: "free", size: 10 }],
  B: [{ persona: "starter", size: 50 }],
  C: [{ persona: "pro-a", size: 250 }],
  D: [{ persona: "pro-a", size: 500 }],
  E: [{ persona: "pro-a", size: 750 }],
  F: [{ persona: "proplus-a", size: 1_000 }],
  G: [
    { persona: "proplus-a", size: 1_000 },
    { persona: "proplus-a", size: 1_000 },
  ],
  H: [
    { persona: "pro-a", size: 750 },
    { persona: "pro-b", size: 750 },
    { persona: "proplus-a", size: 1_000 },
    { persona: "proplus-b", size: 1_000 },
  ],
  // The sizing case: four 1,000-security runs at once — two Pro+ owners, both of their slots.
  I: [
    { persona: "proplus-a", size: 1_000 },
    { persona: "proplus-a", size: 1_000 },
    { persona: "proplus-b", size: 1_000 },
    { persona: "proplus-b", size: 1_000 },
  ],
};

type Mix = "protected" | "mixed" | "ordinary";
const PROTECTED_SHARE: Record<Mix, number> = {
  protected: 1,
  mixed: 0.6,
  ordinary: 0,
};

type Cache = "cold" | "warm" | "miss";

type Arguments = {
  command: "setup" | "hydrate" | "run" | "audit" | "cleanup";
  securities: number;
  protectedCount: number;
  etfs: boolean;
  from: number;
  to: number;
  concurrency: number;
  scenario: ScenarioKey;
  cache: Cache;
  mix: Mix;
  overlap: "shared" | "disjoint";
  strategy: BenchmarkStrategyKey;
  workers: number;
  years: number;
  label: string;
  report: string;
  timeoutMinutes: number;
  workerEnv: Record<string, string>;
  /** The first index of the ordinary pool's fresh securities (`miss` takes them from here up). */
  freshFrom: number;
  /** How many hydrated ordinary securities follow the protected universe. */
  ordinaryPool: number;
  /**
   * Fault injection for the recovery tests (`docs/production/benchmarks.md`, "Failure tests"), at
   * `chaosAtS` seconds after submission: `kill-worker` SIGKILLs the worker holding a claim and starts
   * a replacement `chaosRestartDelayS` later (as the supervisor would); `redis-restart` runs
   * `BENCH_REDIS_RESTART_COMMAND` (stops and restarts the Redis server); `redis-flush` empties the
   * benchmark's Redis database (a Redis that lost everything).
   */
  chaos: "kill-worker" | "redis-restart" | "redis-flush" | null;
  chaosAtS: number;
  chaosRestartDelayS: number;
};

function parseArguments(argv: readonly string[]): Arguments {
  const [command, ...rest] = argv.filter((value) => value !== "--");
  if (
    command !== "setup" &&
    command !== "hydrate" &&
    command !== "run" &&
    command !== "audit" &&
    command !== "cleanup"
  ) {
    throw new Error(
      "Usage: scale-backtest-benchmark <setup|hydrate|run|audit|cleanup> [options]",
    );
  }
  const parsed: Arguments = {
    command,
    securities: 4_000,
    protectedCount: 735,
    etfs: true,
    from: 1,
    to: 1_735,
    concurrency: 6,
    scenario: "A",
    cache: "warm",
    mix: "mixed",
    overlap: "shared",
    strategy: "simple",
    workers: 4,
    years: 30,
    label: "",
    report: "docs/production/benchmark-results/scale-backtests.jsonl",
    timeoutMinutes: 240,
    workerEnv: {},
    freshFrom: 1_736,
    ordinaryPool: 1_000,
    chaos: null,
    chaosAtS: 60,
    chaosRestartDelayS: 5,
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
    const oneOf = <T extends string>(allowed: readonly T[]): T => {
      const raw = value();
      if (!(allowed as readonly string[]).includes(raw)) {
        throw new Error(`${flag} must be one of ${allowed.join(", ")}`);
      }
      return raw as T;
    };
    switch (flag) {
      case "--securities":
        parsed.securities = positive(flag, value());
        break;
      case "--protected":
        parsed.protectedCount = positive(flag, value());
        break;
      case "--no-etfs":
        parsed.etfs = false;
        break;
      case "--from":
        parsed.from = positive(flag, value());
        break;
      case "--to":
        parsed.to = positive(flag, value());
        break;
      case "--concurrency":
        parsed.concurrency = positive(flag, value());
        break;
      case "--scenario":
        parsed.scenario = oneOf(["A", "B", "C", "D", "E", "F", "G", "H", "I"] as const);
        break;
      case "--cache":
        parsed.cache = oneOf(["cold", "warm", "miss"] as const);
        break;
      case "--mix":
        parsed.mix = oneOf(["protected", "mixed", "ordinary"] as const);
        break;
      case "--overlap":
        parsed.overlap = oneOf(["shared", "disjoint"] as const);
        break;
      case "--strategy":
        parsed.strategy = oneOf(
          Object.keys(BENCHMARK_STRATEGIES) as BenchmarkStrategyKey[],
        );
        break;
      case "--workers":
        parsed.workers = positive(flag, value());
        break;
      case "--years":
        parsed.years = positive(flag, value());
        break;
      case "--label":
        parsed.label = value();
        break;
      case "--report":
        parsed.report = value();
        break;
      case "--timeout-minutes":
        parsed.timeoutMinutes = positive(flag, value());
        break;
      case "--fresh-from":
        parsed.freshFrom = positive(flag, value());
        break;
      case "--ordinary-pool":
        parsed.ordinaryPool = positive(flag, value());
        break;
      case "--chaos": {
        const kind = value();
        if (kind !== "kill-worker" && kind !== "redis-restart" && kind !== "redis-flush") {
          throw new Error("--chaos is kill-worker, redis-restart or redis-flush");
        }
        parsed.chaos = kind;
        break;
      }
      case "--chaos-at-s":
        parsed.chaosAtS = positive(flag, value());
        break;
      case "--chaos-restart-delay-s":
        parsed.chaosRestartDelayS = positive(flag, value());
        break;
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

@Module({
  imports: [ConfigurationModule, DatabaseModule, AuthModule, BacktestsModule],
})
class ScaleBenchmarkSubmissionModule {}

function personaEmail(persona: Persona): string {
  return `scale-bench-${persona}@${EMAIL_DOMAIN}`;
}

async function ensurePersonas(prisma: PrismaClient): Promise<Map<Persona, AuthUser>> {
  const users = new Map<Persona, AuthUser>();
  for (const [persona, plan] of Object.entries(PERSONAS) as [Persona, UserPlan][]) {
    // No password and no OAuth account: a fixture submits through the service and never signs in.
    const user = await prisma.user.upsert({
      where: { email: personaEmail(persona) },
      create: { email: personaEmail(persona), role: "USER", plan, emailVerifiedAt: new Date() },
      update: { role: "USER", plan },
      select: { id: true, email: true, role: true, plan: true },
    });
    users.set(persona, user);
  }
  return users;
}

async function ensureStrategies(prisma: PrismaClient, userId: string): Promise<void> {
  for (const entry of Object.values(BENCHMARK_STRATEGIES)) {
    const definition = normalizeStrategyDefinition(entry.definition);
    const issues = validateStrategyDefinition(definition);
    if (issues.length > 0) {
      throw new Error(
        `Benchmark strategy ${entry.slug} is invalid: ${JSON.stringify(issues)}`,
      );
    }
    const hash = createHash("sha256")
      .update(strategyDefinitionFingerprint(definition))
      .digest("hex");
    const name = `${NAME_PREFIX}${entry.slug}`;
    const existing = await prisma.strategy.findFirst({
      where: { userId, name },
      include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } },
    });
    if (!existing) {
      await prisma.strategy.create({
        data: {
          userId,
          name,
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

async function setup(prisma: PrismaClient, bench: BenchEnvironment, args: Arguments) {
  const startedAt = Date.now();
  const rows = [];
  for (let index = 1; index <= args.securities; index += 1) {
    const profile = syntheticProfile(syntheticSymbol(index));
    rows.push({
      providerSymbol: profile.symbol,
      symbol: profile.symbol,
      name: profile.companyName,
      exchangeCode: profile.exchange,
      exchangeName: profile.exchangeFullName,
      currency: profile.currency,
      cik: profile.cik,
      country: profile.country,
      sector: profile.sector,
      industry: profile.industry,
      ipoDate: new Date(`${profile.ipoDate}T00:00:00.000Z`),
      type: "STOCK" as const,
      isAdr: false,
      isActivelyTrading: true,
    });
  }
  for (let offset = 0; offset < rows.length; offset += 1_000) {
    await prisma.security.createMany({
      data: rows.slice(offset, offset + 1_000),
      skipDuplicates: true,
    });
  }
  // The protected universe, exactly as PostgreSQL states a built-in one: resolved constituents.
  const universe = await prisma.security.findMany({
    where: {
      providerSymbol: {
        in: Array.from({ length: args.protectedCount }, (_, index) =>
          syntheticSymbol(index + 1),
        ),
      },
    },
    select: { id: true, symbol: true, name: true },
  });
  await prisma.indexConstituent.createMany({
    data: universe.map((security) => ({
      indexKey: "SP500" as const,
      constituentKey: `SYNTHETIC:${security.symbol}`,
      origin: "CURRENT",
      ticker: security.symbol,
      name: security.name,
      tickerHistory: [] as Prisma.InputJsonValue,
      securityId: security.id,
      resolution: "RESOLVED" as const,
      resolvedAt: new Date(),
      syncId: "synthetic-scale-benchmark",
    })),
    skipDuplicates: true,
  });

  await reconcileBenchmarkCatalog(prisma);
  // The execution calendar (and the sector and market ETFs) from the synthetic provider, through the
  // product's own prewarm command.
  const prewarm = await runTsx(
    "src/benchmarks/prewarm-benchmark-data.ts",
    args.etfs
      ? ["--group", "market-overview", "--from", "1985-01-01"]
      : ["--code", "SP500", "--from", "1985-01-01"],
    benchProcessEnvironment(bench, { LOG_LEVEL: "warn" }),
  );

  const users = await ensurePersonas(prisma);
  for (const user of users.values()) {
    await ensureStrategies(prisma, user.id);
  }
  return {
    command: "setup",
    database: bench.databaseName,
    redisDatabase: bench.redisDatabase,
    securities: args.securities,
    protectedUniverse: universe.length,
    prewarmExitCode: prewarm.code,
    prewarmTail: prewarm.output.split("\n").slice(-25).join("\n"),
    personas: Object.fromEntries(
      [...users.entries()].map(([persona, user]) => [persona, user.plan]),
    ),
    durationMs: Date.now() - startedAt,
  };
}

function runTsx(
  script: string,
  argv: readonly string[],
  env: Record<string, string>,
): Promise<{ code: number | null; output: string }> {
  const tsx = join(repositoryRoot(), "apps/api/node_modules/.bin/tsx");
  return new Promise((resolveRun) => {
    const child = spawn(tsx, [script, ...argv], {
      cwd: join(repositoryRoot(), "apps/api"),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("exit", (code) => resolveRun({ code, output }));
  });
}

/**
 * Bulk hydration of a range of synthetic securities through the canonical loader — the same core
 * history and valuation-input reads the universe ingestion makes — from the synthetic provider.
 */
async function hydrate(args: Arguments) {
  const symbols = Array.from(
    { length: args.to - args.from + 1 },
    (_, index) => syntheticSymbol(args.from + index),
  );
  const logger = createLogger({
    service: "api",
    level: "warn",
    environment: "development",
    base: { component: "scale-benchmark-hydrate" },
  });
  const runtime = await createIndexUniverseRuntime({
    logger,
    runId: `scale-hydrate-${Date.now()}`,
    scopeSymbols: symbols,
    budget: symbols.length * 40 + 1_000,
    provider: true,
  });
  const counters = await syntheticCounters();
  const startedAt = Date.now();
  const durations: number[] = [];
  const failures: { symbol: string; error: string }[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const range = {
    from: subtractYears(today, runtime.productHistoryYears),
    to: today,
  };
  let next = 0;
  let done = 0;
  const lanes = Array.from({ length: args.concurrency }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const symbol = symbols[index];
      if (symbol === undefined) {
        return;
      }
      const at = Date.now();
      try {
        await runtime.stockData.getDailyDerivedState(symbol, range);
        // One ratio read refreshes the split list, the only stored valuation input (as ingestion).
        await runtime.stockData.getDailyValuationRatio(symbol, VALUATION_RATIO_IDS[0] as ValuationRatioId, {
          from: range.to,
          to: range.to,
        });
        durations.push(Date.now() - at);
      } catch (error) {
        failures.push({
          symbol,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      done += 1;
      if (done % 100 === 0) {
        process.stderr.write(
          `${JSON.stringify({ event: "scale-benchmark.hydrate.progress", done, of: symbols.length, elapsedMs: Date.now() - startedAt })}\n`,
        );
      }
    }
  });
  await Promise.all(lanes);
  const after = await syntheticCounters();
  await runtime.close();
  return {
    command: "hydrate",
    securities: symbols.length,
    concurrency: args.concurrency,
    wallMs: Date.now() - startedAt,
    perSecurityMs: summary(durations),
    failures: failures.length,
    failureSample: failures.slice(0, 5),
    providerRequests: counterDelta(counters, after),
  };
}

type SyntheticCounters = {
  requests: number;
  failuresInjected: number;
  unexpected: number;
  bytes: number;
  byEndpoint: Record<string, number>;
} | null;

async function syntheticCounters(): Promise<SyntheticCounters> {
  const base = new URL(process.env.FMP_BASE_URL ?? "http://127.0.0.1:4790/stable/");
  try {
    const response = await fetch(new URL("/__synthetic/counters", base));
    return (await response.json()) as SyntheticCounters;
  } catch {
    return null;
  }
}

function counterDelta(before: SyntheticCounters, after: SyntheticCounters) {
  if (!before || !after) {
    return null;
  }
  const byEndpoint: Record<string, number> = {};
  for (const [endpoint, count] of Object.entries(after.byEndpoint)) {
    const delta = count - (before.byEndpoint[endpoint] ?? 0);
    if (delta > 0) {
      byEndpoint[endpoint] = delta;
    }
  }
  return {
    requests: after.requests - before.requests,
    failuresInjected: after.failuresInjected - before.failuresInjected,
    unexpected: after.unexpected - before.unexpected,
    bytes: after.bytes - before.bytes,
    byEndpoint,
  };
}

type Submission = {
  persona: Persona;
  size: number;
  memberSymbols: string[];
  protectedMembers: number;
  ordinaryMembers: number;
};

/**
 * Which securities each run holds, deterministically: the protected part from the universe's
 * start, the ordinary part from the ordinary pool — the same members for every run (`shared`), or
 * consecutive, distinct ranges (`disjoint`). A `miss` takes its ordinary part from securities
 * nothing has hydrated yet, from `--fresh-from` up.
 */
async function submissionsFor(
  prisma: PrismaClient,
  args: Arguments,
): Promise<Submission[]> {
  const entries = SCENARIOS[args.scenario];
  let freshPool: string[] = [];
  if (args.cache === "miss") {
    const wanted = entries.reduce(
      (sum, entry) =>
        sum + entry.size - Math.min(args.protectedCount, Math.round(entry.size * PROTECTED_SHARE[args.mix])),
      0,
    );
    const candidates = await prisma.$queryRaw<{ symbol: string }[]>`
      SELECT s.symbol FROM "Security" s
      WHERE s."providerSymbol" LIKE 'SYN%'
        AND s."providerSymbol" >= ${syntheticSymbol(args.freshFrom)}
        AND NOT EXISTS (SELECT 1 FROM "StockDatasetState" d WHERE d."securityId" = s.id)
      ORDER BY s."providerSymbol"
      LIMIT ${wanted}`;
    freshPool = candidates.map((row) => row.symbol);
  }
  let ordinaryOffset = 0;
  let freshOffset = 0;
  return entries.map((entry) => {
    const protectedMembers = Math.min(
      args.protectedCount,
      Math.round(entry.size * PROTECTED_SHARE[args.mix]),
    );
    const ordinaryMembers = entry.size - protectedMembers;
    const symbols: string[] = [];
    for (let index = 1; index <= protectedMembers; index += 1) {
      symbols.push(syntheticSymbol(index));
    }
    if (args.cache === "miss") {
      const start = args.overlap === "shared" ? 0 : freshOffset;
      const slice = freshPool.slice(start, start + ordinaryMembers);
      if (slice.length < ordinaryMembers) {
        throw new Error(
          `A miss needs ${ordinaryMembers} never-hydrated securities from ${syntheticSymbol(args.freshFrom)}; ` +
            `${slice.length} remain. Run setup with more --securities.`,
        );
      }
      symbols.push(...slice);
      if (args.overlap === "disjoint") {
        freshOffset += ordinaryMembers;
      }
    } else {
      // The hydrated ordinary pool is `--ordinary-pool` securities after the protected universe.
      // Disjoint runs take consecutive ranges and wrap around the pool, so concurrent runs touch as
      // many distinct ordinary securities as the pool holds — the LRU's worst case at this size.
      const offset = args.overlap === "shared" ? 0 : ordinaryOffset;
      for (let member = 0; member < ordinaryMembers; member += 1) {
        symbols.push(
          syntheticSymbol(args.protectedCount + 1 + ((offset + member) % args.ordinaryPool)),
        );
      }
      if (args.overlap === "disjoint") {
        ordinaryOffset += ordinaryMembers;
      }
    }
    return {
      persona: entry.persona,
      size: entry.size,
      memberSymbols: symbols,
      protectedMembers,
      ordinaryMembers,
    };
  });
}

async function ensureList(
  prisma: PrismaClient,
  userId: string,
  name: string,
  symbols: readonly string[],
): Promise<string> {
  const securities = await prisma.security.findMany({
    where: { providerSymbol: { in: [...symbols] } },
    select: { id: true, providerSymbol: true },
  });
  if (securities.length !== symbols.length) {
    throw new Error(
      `List ${name}: ${symbols.length - securities.length} synthetic securities are not in the catalog; run setup with more --securities`,
    );
  }
  const order = new Map(symbols.map((symbol, index) => [symbol, index]));
  securities.sort(
    (left, right) =>
      (order.get(left.providerSymbol) ?? 0) - (order.get(right.providerSymbol) ?? 0),
  );
  const existing = await prisma.stockList.findFirst({
    where: { userId, name },
    select: { id: true },
  });
  if (existing) {
    await prisma.stockList.delete({ where: { id: existing.id } });
  }
  const list = await prisma.stockList.create({
    data: { userId, name, description: "Scale benchmark fixture list." },
    select: { id: true },
  });
  for (let offset = 0; offset < securities.length; offset += 1_000) {
    await prisma.stockListItem.createMany({
      data: securities.slice(offset, offset + 1_000).map((security) => ({
        stockListId: list.id,
        securityId: security.id,
      })),
    });
  }
  return list.id;
}

type Sample = {
  at: number;
  cpuBusyShare: number;
  workerRssBytes: number;
  workerRssMaxBytes: number;
  postgresCpuMs: number;
  redisUsedBytes: number;
  lruSize: number;
  protectedDesignated: number;
  pgConnections: number;
  pgActive: number;
  executing: number;
  queued: number;
};

function readProcStat(): { busy: number; total: number } {
  const line = readFileSync("/proc/stat", "utf8").split("\n")[0] as string;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (values[3] ?? 0) + (values[4] ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  return { busy: total - idle, total };
}

/** Resident memory and CPU time (ms) of one process; zero once it has exited. */
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

/** CPU time of every PostgreSQL server process on this machine, in ms. */
function postgresCpuMs(): number {
  let total = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const comm = readFileSync(`/proc/${entry}/comm`, "utf8").trim();
      if (comm === "postgres") {
        total += processStats(Number(entry)).cpuMs;
      }
    } catch {
      // The process exited between the listing and the read.
    }
  }
  return total;
}

function redisField(info: string, name: string): number {
  return Number(new RegExp(`^${name}:(.*)$`, "m").exec(info)?.[1]?.trim() ?? 0);
}

async function redisCounters(redis: ReturnType<typeof createStockDataRedisClient>) {
  const info = await redis.info();
  return {
    usedMemory: redisField(info, "used_memory"),
    usedMemoryPeak: redisField(info, "used_memory_peak"),
    hits: redisField(info, "keyspace_hits"),
    misses: redisField(info, "keyspace_misses"),
    commands: redisField(info, "total_commands_processed"),
    netOutputBytes: redisField(info, "total_net_output_bytes"),
    netInputBytes: redisField(info, "total_net_input_bytes"),
    cpuSeconds: redisField(info, "used_cpu_sys") + redisField(info, "used_cpu_user"),
    evictedKeys: redisField(info, "evicted_keys"),
    expiredKeys: redisField(info, "expired_keys"),
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
      tup_inserted: bigint;
      temp_bytes: bigint;
      deadlocks: bigint;
    }[]
  >`SELECT xact_commit, blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted, temp_bytes,
           deadlocks
      FROM pg_stat_database WHERE datname = current_database()`;
  const [size] = await prisma.$queryRaw<{ bytes: bigint }[]>`
    SELECT pg_database_size(current_database()) AS bytes`;
  return {
    transactions: Number(row?.xact_commit ?? 0),
    blocksRead: Number(row?.blks_read ?? 0),
    blocksHit: Number(row?.blks_hit ?? 0),
    tuplesReturned: Number(row?.tup_returned ?? 0),
    tuplesFetched: Number(row?.tup_fetched ?? 0),
    tuplesInserted: Number(row?.tup_inserted ?? 0),
    tempBytes: Number(row?.temp_bytes ?? 0),
    deadlocks: Number(row?.deadlocks ?? 0),
    databaseBytes: Number(size?.bytes ?? 0),
  };
}

function startWorkers(
  count: number,
  logDirectory: string,
  env: Record<string, string>,
  firstIndex = 0,
): ChildProcess[] {
  const entry = join(repositoryRoot(), "apps/worker/dist/backtest/worker-process.js");
  if (!existsSync(entry)) {
    throw new Error(`${entry} is missing: run \`pnpm --filter @intrinsic/worker build\` first`);
  }
  mkdirSync(logDirectory, { recursive: true });
  const probe = join(repositoryRoot(), "apps/api/src/backtest-benchmark/event-loop-probe.cjs");
  const children: ChildProcess[] = [];
  for (let index = firstIndex; index < firstIndex + count; index += 1) {
    const child = spawn(process.execPath, ["--require", probe, entry], {
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
          const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolveStop();
          });
          child.kill("SIGTERM");
        }),
    ),
  );
}

type RunLog = {
  runId: string;
  claimedAt?: number;
  executionCalendarMs?: number;
  preparationMs?: number;
  preparedSecurities?: number;
  skippedSecurities?: number;
  benchmarkLoadedAt?: number;
  benchmarkMs?: number;
  windowLoadMs: number;
  windows: number;
  /** Frames a window read from PostgreSQL (`BACKTEST_NON_RESIDENT_FRAME_READ=STORE`). */
  storeReads: number;
  /** Per window: `[year, durationMs, storeReads]`. */
  windowLog: [number, number, number][];
  simulationMs?: number;
  finalizingMs?: number;
  completedMs?: number;
  completedAt?: number;
  lruEvictions: number;
  lruAdmissionsEvicting: number;
  providerRequests: number;
  failures: string[];
};

type LoopSample = { pid: number; p99Ms: number; maxMs: number; at: number };

/** Per-run events from the workers' structured logs, and every worker's event-loop samples. */
function readWorkerLogs(logDirectory: string, count: number) {
  const byRun = new Map<string, RunLog>();
  const loop: LoopSample[] = [];
  const unattributed = { lruEvictions: 0, errors: 0 };
  for (let index = 0; index < count; index += 1) {
    const path = join(logDirectory, `worker-${index}.log`);
    if (!existsSync(path)) {
      continue;
    }
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
      if (record.event === "bench.event-loop") {
        loop.push({
          pid: Number(record.pid),
          p99Ms: Number(record.p99Ms),
          maxMs: Number(record.maxMs),
          at: Date.parse(String(record.at)),
        });
        continue;
      }
      const runId = typeof record.runId === "string" ? record.runId : null;
      if (!runId) {
        if (record.event === "stock-data.cache.lru-evicted") {
          unattributed.lruEvictions += Number(record.evicted ?? 0);
        }
        if (record.level === "error" || record.level === "fatal") {
          unattributed.errors += 1;
        }
        continue;
      }
      const run =
        byRun.get(runId) ??
        ({
          runId,
          windowLoadMs: 0,
          windows: 0,
          storeReads: 0,
          windowLog: [],
          lruEvictions: 0,
          lruAdmissionsEvicting: 0,
          providerRequests: 0,
          failures: [],
        } satisfies RunLog);
      byRun.set(runId, run);
      const at = Date.parse(String(record.timestamp ?? ""));
      switch (record.event) {
        case "backtest.claimed":
          run.claimedAt = at;
          break;
        case "backtest.execution-calendar.loaded":
          run.executionCalendarMs = Number(record.durationMs);
          break;
        case "backtest.frames.loaded":
          run.preparationMs = Number(record.durationMs);
          run.preparedSecurities = Number(record.securityCount);
          run.skippedSecurities = Number(record.skippedCount);
          break;
        case "backtest.benchmark.loaded":
          run.benchmarkMs = Number(record.durationMs);
          run.benchmarkLoadedAt = at;
          break;
        case "backtest.window.loaded":
          run.windowLoadMs += Number(record.durationMs);
          run.windows += 1;
          run.storeReads += Number(record.storeReads ?? 0);
          run.windowLog.push([
            Number(record.year),
            Number(record.durationMs),
            Number(record.storeReads ?? 0),
          ]);
          break;
        case "backtest.simulation.completed":
          run.simulationMs = Number(record.durationMs);
          break;
        case "backtest.finalized":
          run.finalizingMs = Number(record.durationMs);
          break;
        case "backtest.completed":
          run.completedMs = Number(record.durationMs);
          run.completedAt = at;
          break;
        case "stock-data.cache.lru-evicted":
          run.lruEvictions += Number(record.evicted ?? 0);
          run.lruAdmissionsEvicting += 1;
          break;
        case "stock-data.provider.request":
          run.providerRequests += 1;
          break;
        default:
          if (record.level === "error" || record.level === "fatal") {
            run.failures.push(String(record.event));
          }
      }
    }
  }
  return { byRun, loop, unattributed };
}

/** A digest of everything a run produced: identical inputs must give identical digests. */
async function resultDigest(prisma: PrismaClient, runId: string): Promise<string | null> {
  const summaryRow = await prisma.backtestRunSummary.findUnique({ where: { runId } });
  if (!summaryRow) {
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
  const values: Partial<typeof summaryRow> = { ...summaryRow };
  delete values.runId;
  return createHash("sha256").update(JSON.stringify({ values, trades })).digest("hex");
}

function percentile(values: readonly number[], share: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] as number;
}

function summary(values: readonly number[]) {
  return {
    samples: values.length,
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length === 0 ? 0 : Math.max(...values),
    mean:
      values.length === 0
        ? 0
        : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
  };
}

/** The earliest start a `years`-deep run may have, one day inside the product's boundary. */
function startFor(endDate: string, years: number): string {
  const [year, month, day] = endDate.split("-").map(Number) as [number, number, number];
  const candidate = new Date(Date.UTC(year - years, month - 1, day));
  return new Date(candidate.getTime() + DAY_MS).toISOString().slice(0, 10);
}

async function run(
  prisma: PrismaClient,
  backtests: BacktestsService,
  redis: ReturnType<typeof createStockDataRedisClient>,
  bench: BenchEnvironment,
  args: Arguments,
) {
  const users = await ensurePersonas(prisma);
  const submissions = await submissionsFor(prisma, args);
  const strategyName = `${NAME_PREFIX}${BENCHMARK_STRATEGIES[args.strategy].slug}`;

  const [calendarEnd] = await prisma.$queryRaw<{ end: Date | null }[]>`
    SELECT max(c."toDate") AS end
    FROM "BenchmarkDatasetCoverage" c
    JOIN "BenchmarkSeries" s ON s."id" = c."seriesId"
    JOIN "Benchmark" b ON b."id" = s."benchmarkId"
    WHERE b."code" = 'SP500'`;
  if (!calendarEnd?.end) {
    throw new Error("The SP500 execution calendar is not stored: run `setup` first");
  }
  const endDate = calendarEnd.end.toISOString().slice(0, 10);
  const startDate = startFor(endDate, args.years);

  const bodies: {
    user: AuthUser;
    submission: Submission;
    body: Record<string, unknown> & { stockListId: string };
  }[] = [];
  for (const [index, submission] of submissions.entries()) {
    const user = users.get(submission.persona) as AuthUser;
    const strategy = await prisma.strategy.findFirst({
      where: { userId: user.id, name: strategyName },
      select: { id: true },
    });
    if (!strategy) {
      throw new Error("Run `setup` first: the benchmark strategies are not seeded");
    }
    const listName = `${NAME_PREFIX}${args.scenario}-${args.mix}-${args.overlap}-${args.cache}-${index}`;
    const listId = await ensureList(prisma, user.id, listName, submission.memberSymbols);
    bodies.push({
      user,
      submission,
      body: {
        strategyId: strategy.id,
        stockListId: listId,
        startDate,
        endDate,
        ...BENCHMARK_STRATEGIES[args.strategy].capital,
      },
    });
  }

  if (args.cache === "cold") {
    // The isolated Redis database only (asserted by benchEnvironment): PostgreSQL keeps everything.
    await redis.flushdb();
  }

  const stamp = new Date().toISOString().replaceAll(":", "-");
  const label = args.label || `${args.scenario}-${args.cache}-${args.mix}-${args.overlap}-${args.strategy}`;
  const logDirectory = resolve(repositoryRoot(), "artifacts/scale-benchmark/logs", `${stamp}-${label}`);
  const workerEnv = benchProcessEnvironment(bench, {
    LOG_LEVEL: "debug",
    // The benchmark day's dataset held still: stored tails are never re-read, and statements and
    // alternative data are not refreshed mid-run.
    EOD_TAIL_REFRESH: "frozen",
    STOCK_FUNDAMENTALS_FRESHNESS_MS: String(30 * DAY_MS),
    ALT_DATA_FRESHNESS_MS: String(30 * DAY_MS),
    BACKTEST_JOB_POLL_INTERVAL_MS: "250",
    ...args.workerEnv,
  });
  const workers = startWorkers(args.workers, logDirectory, workerEnv);
  const chaosEvents: Record<string, unknown>[] = [];
  let chaosTimer: NodeJS.Timeout | null = null;
  const samples: Sample[] = [];
  let sampler: NodeJS.Timeout | null = null;
  const runIds: string[] = [];
  try {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
    const redisBefore = await redisCounters(redis);
    const pgBefore = await pgCounters(prisma);
    const providerBefore = await syntheticCounters();
    const workerCpuBefore = workers.reduce((sum, child) => sum + processStats(child.pid ?? 0).cpuMs, 0);
    const postgresCpuBefore = postgresCpuMs();
    const lruBefore = await redis.zcard("stock-data:v2:resident-stocks");
    const protectedBefore = await redis.scard("stock-data:v2:protected-stocks");
    let previousStat = readProcStat();
    const startedAt = Date.now();
    sampler = setInterval(() => {
      void (async () => {
        const stat = readProcStat();
        const busy = stat.busy - previousStat.busy;
        const total = stat.total - previousStat.total;
        previousStat = stat;
        const stats = workers.map((child) => processStats(child.pid ?? 0));
        const [connections] = await prisma.$queryRaw<{ total: bigint; active: bigint }[]>`
          SELECT count(*) AS total, count(*) FILTER (WHERE state = 'active') AS active
          FROM pg_stat_activity WHERE datname = current_database()`;
        const [jobs] = await prisma.$queryRaw<{ executing: bigint; queued: bigint }[]>`
          SELECT count(*) FILTER (WHERE status = 'CLAIMED') AS executing,
                 count(*) FILTER (WHERE status = 'QUEUED') AS queued
          FROM "BacktestJob"`;
        samples.push({
          at: Date.now() - startedAt,
          cpuBusyShare: total > 0 ? busy / total : 0,
          workerRssBytes: stats.reduce((sum, entry) => sum + entry.rss, 0),
          workerRssMaxBytes: Math.max(0, ...stats.map((entry) => entry.rss)),
          postgresCpuMs: postgresCpuMs(),
          redisUsedBytes: (await redisCounters(redis)).usedMemory,
          lruSize: await redis.zcard("stock-data:v2:resident-stocks"),
          protectedDesignated: await redis.scard("stock-data:v2:protected-stocks"),
          pgConnections: Number(connections?.total ?? 0),
          pgActive: Number(connections?.active ?? 0),
          executing: Number(jobs?.executing ?? 0),
          queued: Number(jobs?.queued ?? 0),
        });
      })().catch(() => {});
    }, 1_000);

    const submissionLatencies: number[] = [];
    const submissionErrors: string[] = [];
    const submitted = await Promise.all(
      bodies.map(async (entry) => {
        const at = Date.now();
        try {
          const created = await backtests.submitRun(
            entry.user,
            parseCreateBacktestRunRequest(entry.body),
          );
          submissionLatencies.push(Date.now() - at);
          return created.id;
        } catch (error) {
          submissionErrors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
          return null;
        }
      }),
    );
    const submissionOfRun = new Map<string, Submission>();
    submitted.forEach((id, index) => {
      if (id !== null) {
        runIds.push(id);
        submissionOfRun.set(id, (bodies[index] as (typeof bodies)[number]).submission);
      }
    });
    if (runIds.length === 0) {
      throw new Error(`Every submission was refused: ${submissionErrors.join("; ")}`);
    }

    if (args.chaos) {
      chaosTimer = setTimeout(() => {
        void injectFault(args, {
          prisma,
          redis,
          runIds,
          workers,
          logDirectory,
          workerEnv,
          startedAt,
          events: chaosEvents,
        }).catch((error: unknown) =>
          chaosEvents.push({ event: "chaos-failed", error: error instanceof Error ? error.message : String(error) }),
        );
      }, args.chaosAtS * 1_000);
    }

    const deadline = startedAt + args.timeoutMinutes * 60_000;
    // A run still executing at the deadline is cancelled (stale recovery closes it once its worker
    // is gone, so no later invocation executes it) and the report records what it had done.
    let timedOut: string[] = [];
    for (;;) {
      const unfinished = await prisma.backtestRun.findMany({
        where: { id: { in: runIds }, status: { notIn: ["COMPLETED", "FAILED", "CANCELLED"] } },
        select: { id: true, userId: true },
      });
      if (unfinished.length === 0) {
        break;
      }
      if (Date.now() > deadline) {
        timedOut = unfinished.map((run) => run.id);
        for (const run of unfinished) {
          await backtests.cancelRun(run.userId, run.id).catch(() => undefined);
        }
        process.stderr.write(
          `${JSON.stringify({ event: "scale-benchmark.timed-out", unfinished: timedOut.length, of: runIds.length })}\n`,
        );
        break;
      }
      if (workers.every((child) => child.exitCode !== null)) {
        throw new Error("Every worker exited before the runs finished");
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
    const wallMs = Date.now() - startedAt;
    clearInterval(sampler);
    sampler = null;
    // One last sample after the event-loop probe's next line.
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_500));
    const redisAfter = await redisCounters(redis);
    const pgAfter = await pgCounters(prisma);
    const providerAfter = await syntheticCounters();
    const workerCpuMs =
      workers.reduce((sum, child) => sum + processStats(child.pid ?? 0).cpuMs, 0) - workerCpuBefore;
    const postgresCpu = postgresCpuMs() - postgresCpuBefore;

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
    const logs = readWorkerLogs(logDirectory, workers.length);
    const perRun = await Promise.all(
      rows.map(async (row) => {
        const timing = logs.byRun.get(row.id);
        const claimedAt = row.job?.claimedAt ?? row.startedAt;
        const submission = submissionOfRun.get(row.id);
        // `completedAt` is stamped as the result write starts; the run is visible complete only once
        // that write commits, which the worker logs as `backtest.completed`.
        const finishedAt = timing?.completedAt ?? row.completedAt?.getTime() ?? null;
        return {
          runId: row.id,
          status: row.status,
          failureCode: row.failureCode,
          attempts: row.job?.attempts ?? null,
          securityCount: row.securityCount,
          queueWaitMs: claimedAt ? claimedAt.getTime() - row.queuedAt.getTime() : null,
          executionMs: finishedAt && claimedAt ? finishedAt - claimedAt.getTime() : null,
          endToEndMs: finishedAt ? finishedAt - row.queuedAt.getTime() : null,
          executionCalendarMs: timing?.executionCalendarMs ?? null,
          preparationMs: timing?.preparationMs ?? null,
          preparedSecurities: timing?.preparedSecurities ?? null,
          skippedSecurities: timing?.skippedSecurities ?? null,
          benchmarkMs: timing?.benchmarkMs ?? null,
          frameReadMs: timing?.windowLoadMs ?? null,
          windows: timing?.windows ?? null,
          storeReads: timing?.storeReads ?? 0,
          windowLog: timing?.windowLog ?? [],
          timedOut: timedOut.includes(row.id),
          simulationMs: timing?.simulationMs ?? null,
          computeMs:
            timing?.simulationMs !== undefined
              ? timing.simulationMs - timing.windowLoadMs
              : null,
          persistenceMs: timing?.finalizingMs ?? null,
          lruEvictions: timing?.lruEvictions ?? 0,
          providerRequestsAnnounced: timing?.providerRequests ?? 0,
          errorEvents: timing?.failures ?? [],
          trades: row.summary?.totalTrades ?? null,
          tradingDays: row.summary?.tradingDays ?? null,
          digest: await resultDigest(prisma, row.id),
          listHash: submission
            ? createHash("sha256").update(submission.memberSymbols.join(",")).digest("hex").slice(0, 16)
            : null,
        };
      }),
    );

    const peak = (pick: (sample: Sample) => number) =>
      samples.length === 0 ? 0 : Math.max(...samples.map(pick));
    const mean = (pick: (sample: Sample) => number) =>
      samples.length === 0 ? 0 : samples.reduce((sum, sample) => sum + pick(sample), 0) / samples.length;
    const hits = redisAfter.hits - redisBefore.hits;
    const misses = redisAfter.misses - redisBefore.misses;
    const loopDuring = logs.loop.filter((sample) => sample.at >= startedAt - 1_000);
    const listDigests = new Map<string, Set<string | null>>();
    for (const entry of perRun) {
      const key = `${entry.listHash}`;
      listDigests.set(key, (listDigests.get(key) ?? new Set()).add(entry.digest));
    }

    const report = {
      label,
      recordedAt: new Date().toISOString(),
      provider: "synthetic",
      providerLatencyMs: Number(process.env.BENCH_FMP_LATENCY_MS ?? "0") || null,
      scenario: args.scenario,
      cache: args.cache,
      mix: args.mix,
      overlap: args.overlap,
      strategy: args.strategy,
      workers: args.workers,
      timeoutMinutes: args.timeoutMinutes,
      timedOutRuns: timedOut.length,
      chaos: args.chaos ? { kind: args.chaos, atS: args.chaosAtS, events: chaosEvents } : null,
      submissions: submissions.map((submission) => ({
        persona: submission.persona,
        plan: PERSONAS[submission.persona],
        size: submission.size,
        protectedMembers: submission.protectedMembers,
        ordinaryMembers: submission.ordinaryMembers,
      })),
      distinctOrdinarySecurities: new Set(
        submissions.flatMap((submission) => submission.memberSymbols.slice(submission.protectedMembers)),
      ).size,
      period: { from: startDate, to: endDate, years: args.years },
      machine: {
        cpus: cpus().length,
        cpuModel: cpus()[0]?.model ?? "unknown",
        totalMemoryBytes: totalmem(),
        node: process.version,
      },
      configuration: {
        STOCK_LRU_MAX_SECURITIES: workerEnv.STOCK_LRU_MAX_SECURITIES,
        BACKTEST_GLOBAL_MAX_RUNNING: workerEnv.BACKTEST_GLOBAL_MAX_RUNNING,
        BACKTEST_FRAME_LOAD_CONCURRENCY: workerEnv.BACKTEST_FRAME_LOAD_CONCURRENCY ?? "4 (default)",
        BACKTEST_NON_RESIDENT_FRAME_READ:
          getBacktestWorkerConfig(workerEnv).nonResidentFrameRead +
          (args.workerEnv.BACKTEST_NON_RESIDENT_FRAME_READ ? "" : " (default)"),
        workerEnv: Object.fromEntries(
          Object.entries(args.workerEnv).map(([key, value]) => [
            key,
            /URL|KEY|SECRET|TOKEN|PASSWORD/i.test(key) ? "<redacted>" : value,
          ]),
        ),
      },
      submitted: runIds.length,
      submissionErrors,
      submissionMs: summary(submissionLatencies),
      wallMs,
      throughputRunsPerHour: Math.round((runIds.length / wallMs) * 3_600_000 * 100) / 100,
      completed: perRun.filter((entry) => entry.status === "COMPLETED").length,
      failed: perRun.filter((entry) => entry.status === "FAILED").length,
      retries: perRun.reduce((sum, entry) => sum + Math.max(0, (entry.attempts ?? 1) - 1), 0),
      identicalResultsPerList: [...listDigests.values()].every(
        (digests) => digests.size === 1 && !digests.has(null),
      ),
      phasesMs: {
        queueWait: summary(perRun.map((entry) => entry.queueWaitMs ?? 0)),
        execution: summary(perRun.map((entry) => entry.executionMs ?? 0)),
        endToEnd: summary(perRun.map((entry) => entry.endToEndMs ?? 0)),
        preparation: summary(perRun.map((entry) => entry.preparationMs ?? 0)),
        frameReads: summary(perRun.map((entry) => entry.frameReadMs ?? 0)),
        compute: summary(perRun.map((entry) => entry.computeMs ?? 0)),
        persistence: summary(perRun.map((entry) => entry.persistenceMs ?? 0)),
      },
      admission: {
        maxExecutingObserved: peak((sample) => sample.executing),
        maxQueuedObserved: peak((sample) => sample.queued),
      },
      cpu: {
        meanBusyShare: Math.round(mean((sample) => sample.cpuBusyShare) * 1000) / 1000,
        peakBusyShare: Math.round(peak((sample) => sample.cpuBusyShare) * 1000) / 1000,
        workerCpuMs,
        workerCpuMsPerRun: Math.round(workerCpuMs / runIds.length),
        postgresCpuMs: postgresCpu,
        redisCpuSeconds: Math.round((redisAfter.cpuSeconds - redisBefore.cpuSeconds) * 100) / 100,
      },
      memory: {
        workerRssPeakBytes: peak((sample) => sample.workerRssBytes),
        workerRssPerProcessPeakBytes: peak((sample) => sample.workerRssMaxBytes),
        redisUsedPeakBytes: peak((sample) => sample.redisUsedBytes),
        redisUsedAfterBytes: redisAfter.usedMemory,
      },
      eventLoop: {
        samples: loopDuring.length,
        p99MsMax: loopDuring.length === 0 ? null : Math.max(...loopDuring.map((sample) => sample.p99Ms)),
        p99MsMedian: percentile(loopDuring.map((sample) => sample.p99Ms), 0.5),
        maxMs: loopDuring.length === 0 ? null : Math.max(...loopDuring.map((sample) => sample.maxMs)),
      },
      cacheTiers: {
        lruBefore,
        lruAfter: await redis.zcard("stock-data:v2:resident-stocks"),
        lruMaxObserved: peak((sample) => sample.lruSize),
        protectedBefore,
        protectedAfter: await redis.scard("stock-data:v2:protected-stocks"),
        lruEvictions:
          perRun.reduce((sum, entry) => sum + entry.lruEvictions, 0) + logs.unattributed.lruEvictions,
        redisHitRate: hits + misses > 0 ? Math.round((hits / (hits + misses)) * 10_000) / 10_000 : null,
        redisCommands: redisAfter.commands - redisBefore.commands,
        redisBytesSent: redisAfter.netOutputBytes - redisBefore.netOutputBytes,
        redisBytesReceived: redisAfter.netInputBytes - redisBefore.netInputBytes,
        redisEvictedKeys: redisAfter.evictedKeys - redisBefore.evictedKeys,
      },
      postgres: {
        transactions: pgAfter.transactions - pgBefore.transactions,
        blocksRead: pgAfter.blocksRead - pgBefore.blocksRead,
        blocksHit: pgAfter.blocksHit - pgBefore.blocksHit,
        tuplesReturned: pgAfter.tuplesReturned - pgBefore.tuplesReturned,
        tuplesInserted: pgAfter.tuplesInserted - pgBefore.tuplesInserted,
        tempBytes: pgAfter.tempBytes - pgBefore.tempBytes,
        deadlocks: pgAfter.deadlocks - pgBefore.deadlocks,
        databaseBytesAfter: pgAfter.databaseBytes,
        databaseGrowthBytes: pgAfter.databaseBytes - pgBefore.databaseBytes,
        peakConnections: peak((sample) => sample.pgConnections),
        peakActiveConnections: peak((sample) => sample.pgActive),
      },
      providerRequests: counterDelta(providerBefore, providerAfter),
      unattributedErrorEvents: logs.unattributed.errors,
      perRun,
      logs: logDirectory,
    };
    const reportPath = resolve(repositoryRoot(), args.report);
    mkdirSync(dirname(reportPath), { recursive: true });
    appendFileSync(reportPath, `${JSON.stringify(report)}\n`);
    const headline: Partial<typeof report> = { ...report };
    delete headline.perRun;
    return headline;
  } finally {
    if (sampler) {
      clearInterval(sampler);
    }
    if (chaosTimer) {
      clearTimeout(chaosTimer);
    }
    await stopWorkers(workers);
  }
}

/** One injected fault (`--chaos`), recorded with when it happened relative to submission. */
async function injectFault(
  args: Arguments,
  input: {
    prisma: PrismaClient;
    redis: ReturnType<typeof createStockDataRedisClient>;
    runIds: readonly string[];
    workers: ChildProcess[];
    logDirectory: string;
    workerEnv: Record<string, string>;
    startedAt: number;
    events: Record<string, unknown>[];
  },
): Promise<void> {
  const at = () => Date.now() - input.startedAt;
  if (args.chaos === "kill-worker") {
    const claimed = await input.prisma.backtestJob.findMany({
      where: { runId: { in: [...input.runIds] }, status: "CLAIMED" },
      select: { runId: true, claimedBy: true, attempts: true },
    });
    // The worker id is `<host>-<pid>-<hex>`.
    const target = claimed.find((job) => job.claimedBy);
    const pid = target?.claimedBy ? Number(target.claimedBy.split("-").at(-2)) : Number.NaN;
    const victim = input.workers.find((child) => child.pid === pid);
    if (!victim) {
      input.events.push({ event: "kill-worker-skipped", at: at(), reason: "no worker holds a claim" });
      return;
    }
    victim.kill("SIGKILL");
    input.events.push({ event: "worker-killed", at: at(), pid, runId: target?.runId, attempts: target?.attempts });
    await new Promise((resolveWait) => setTimeout(resolveWait, args.chaosRestartDelayS * 1_000));
    const [replacement] = startWorkers(1, input.logDirectory, input.workerEnv, input.workers.length);
    if (replacement) {
      input.workers.push(replacement);
      input.events.push({ event: "worker-restarted", at: at(), pid: replacement.pid });
    }
    return;
  }
  if (args.chaos === "redis-flush") {
    await input.redis.flushdb();
    input.events.push({ event: "redis-flushed", at: at() });
    return;
  }
  const command = process.env.BENCH_REDIS_RESTART_COMMAND?.trim();
  if (!command) {
    throw new Error("--chaos redis-restart needs BENCH_REDIS_RESTART_COMMAND (stops and restarts Redis)");
  }
  const stoppedAt = Date.now();
  input.events.push({ event: "redis-restart-begun", at: at() });
  const result = spawnSync("sh", ["-c", command], { stdio: "ignore", timeout: 300_000 });
  for (;;) {
    try {
      if ((await input.redis.ping()) === "PONG") {
        break;
      }
    } catch {
      // Still down or loading.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  input.events.push({ event: "redis-restarted", at: at(), exit: result.status, downMs: Date.now() - stoppedAt });
}

async function audit(redis: ReturnType<typeof createStockDataRedisClient>, prisma: PrismaClient) {
  const lru = await redis.zrange("stock-data:v2:resident-stocks", "0", "-1");
  const designated = await redis.smembers("stock-data:v2:protected-stocks");
  const universe = new Set(
    (
      await prisma.indexConstituent.findMany({
        where: { resolution: { in: ["RESOLVED", "RESOLVED_PARTIAL"] }, securityId: { not: null } },
        select: { securityId: true },
      })
    ).map((row) => row.securityId as string),
  );
  const designatedSet = new Set(designated);
  // Every security with any key, from the manifests and identity rows.
  const withKeys = new Set<string>();
  let cursor = "0";
  let keys = 0;
  let protectedKeysWithTtl = 0;
  const ttlChecks: string[] = [];
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", "stock-data:v2:security:*", "COUNT", 5_000);
    cursor = next;
    keys += batch.length;
    for (const key of batch) {
      const id = /^stock-data:v2:security:([^:]+):/.exec(key)?.[1];
      if (id) {
        withKeys.add(id);
        if (designatedSet.has(id) && ttlChecks.length < 200_000) {
          ttlChecks.push(key);
        }
      }
    }
  } while (cursor !== "0");
  for (let offset = 0; offset < ttlChecks.length; offset += 1_000) {
    const pipeline = redis.pipeline();
    for (const key of ttlChecks.slice(offset, offset + 1_000)) {
      pipeline.pttl(key);
    }
    for (const [, ttl] of (await pipeline.exec()) ?? []) {
      if (typeof ttl === "number" && ttl >= 0) {
        protectedKeysWithTtl += 1;
      }
    }
  }
  const lruSet = new Set(lru);
  const both = lru.filter((id) => designatedSet.has(id));
  const orphans = [...withKeys].filter((id) => !lruSet.has(id) && !designatedSet.has(id));
  const universeInLru = lru.filter((id) => universe.has(id));
  const info = await redis.info("memory");
  return {
    command: "audit",
    lruSize: lru.length,
    designated: designated.length,
    universe: universe.size,
    securitiesWithKeys: withKeys.size,
    keys,
    inBothTiers: both.length,
    universeInLru: universeInLru.length,
    designatedNotInUniverse: designated.filter((id) => !universe.has(id)).length,
    orphans: orphans.length,
    orphanSample: orphans.slice(0, 5),
    protectedKeysWithTtl,
    redisUsedMemoryBytes: redisField(info, "used_memory"),
  };
}

async function cleanup(prisma: PrismaClient) {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: `@${EMAIL_DOMAIN}`, startsWith: "scale-bench-" } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);
  const runs = await prisma.backtestRun.deleteMany({ where: { userId: { in: ids } } });
  return { command: "cleanup", runsDeleted: runs.count };
}

async function main(): Promise<void> {
  loadRootEnv();
  const args = parseArguments(process.argv.slice(2));
  const bench = benchEnvironment();
  // This process is a benchmark process too: its own Prisma clients and Nest context must see only
  // the isolated database, Redis and provider, before any of them is constructed.
  const own = benchProcessEnvironment(bench);
  for (const name of Object.keys(process.env)) {
    if (!(name in own)) {
      delete process.env[name];
    }
  }
  Object.assign(process.env, own);

  if (args.command === "hydrate") {
    process.stdout.write(`${JSON.stringify(await hydrate(args), null, 2)}\n`);
    return;
  }
  const context = await NestFactory.createApplicationContext(ScaleBenchmarkSubmissionModule, {
    logger: false,
  });
  const prisma = context.get(PrismaService, { strict: false }) as unknown as PrismaClient;
  const backtests = context.get(BacktestsService, { strict: false });
  const redis = createStockDataRedisClient(bench.redisUrl);
  try {
    let result: unknown;
    switch (args.command) {
      case "setup":
        result = await setup(prisma, bench, args);
        break;
      case "run":
        result = await run(prisma, backtests, redis, bench, args);
        break;
      case "audit":
        result = await audit(redis, prisma);
        break;
      case "cleanup":
        result = await cleanup(prisma);
        break;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (args.command === "audit") {
      const path = resolve(repositoryRoot(), "artifacts/scale-benchmark/audits.jsonl");
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...(result as object) })}\n`);
    }
  } finally {
    redis.disconnect();
    await context.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
