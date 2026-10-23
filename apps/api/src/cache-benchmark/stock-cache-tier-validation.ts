import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getApiConfig, loadRootEnv } from "@intrinsic/config";
import type { LocalDate } from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import {
  loadProtectedTierSecurityIds,
  STOCK_DATA_CACHE_NAMESPACE,
  subtractYears,
} from "@intrinsic/stock-data";
import {
  createIndexUniverseRuntime,
  type IndexUniverseRuntime,
} from "../index-universe/index-universe-runtime.js";
import { repositoryRoot } from "../qa-matrix/matrix-paths";

/**
 * Validates the two stock-cache tiers on this environment's real PostgreSQL and Redis
 * (`docs/decisions/stock-cache-tiers-v1.md` §6). Never reaches the provider: every read is served
 * by the canonical loader from Redis, or rehydrated from PostgreSQL alone.
 *
 * ```bash
 * STOCK_LRU_MAX_SECURITIES=5 pnpm --filter @intrinsic/api bench:stock-cache-tiers -- lru --out f
 * STOCK_LRU_MAX_SECURITIES=4 pnpm --filter @intrinsic/api bench:stock-cache-tiers -- concurrency --processes 4 --operations 120
 * ```
 *
 * - `lru` reads the ordinary securities (every catalog security with stored prices that no built-in
 *   universe admits) and some protected ones in a fixed order, and after every read compares the
 *   LRU with a reference model of a count-bounded LRU: the same members in the same order, every
 *   evicted security gone whole, every read equal to PostgreSQL's rows, the protected tier's digest
 *   unchanged.
 * - `concurrency` runs that mix as random reads in several OS processes at once, each with its own
 *   connections, while this process samples the LRU's size; then checks the same invariants.
 *
 * It changes Redis residency (that is the point) and nothing in PostgreSQL. Aggregates only.
 */

type Phase =
  "lru" | "concurrency" | "digest" | "child" | "promotion" | "residency";

/**
 * Protected securities whose chunk bytes the digest covers. The default is the real S&P 500
 * universe's; the synthetic scale benchmark passes its own (`STOCK_CACHE_PROTECTED_SAMPLE`,
 * comma-separated symbols), since its canonical universe is `SYN0001…`.
 */
const PROTECTED_SAMPLE = process.env.STOCK_CACHE_PROTECTED_SAMPLE?.split(",")
  .map((symbol) => symbol.trim())
  .filter(Boolean) ?? ["AAPL", "MS", "MCO", "CVC", "JPM", "XOM"];

type Context = {
  runtime: IndexUniverseRuntime;
  ordinary: { id: string; symbol: string }[];
  protectedSample: { id: string; symbol: string }[];
  newest: LocalDate;
};

async function context(phase: string): Promise<Context> {
  const apiConfig = getApiConfig();
  const logger = createLogger({
    service: "api",
    level: phase === "child" ? "warn" : apiConfig.logLevel,
    environment: apiConfig.environment,
    base: { component: "stock-cache-tier-validation" },
  });
  const runtime = await createIndexUniverseRuntime({
    logger,
    runId: `tiers-${phase}-${randomUUID()}`,
    scopeSymbols: [],
    budget: 1,
    provider: false,
  });
  const eligible = new Set(await loadProtectedTierSecurityIds(runtime.prisma));
  const priced = await runtime.prisma.$queryRaw<
    { id: string; symbol: string }[]
  >`
    SELECT s.id, s.symbol FROM "Security" s
    WHERE EXISTS (SELECT 1 FROM "DailyPrice" p WHERE p."securityId" = s.id)
    ORDER BY s.symbol`;
  const ordinary = priced.filter((row) => !eligible.has(row.id));
  const protectedSample = priced.filter(
    (row) => eligible.has(row.id) && PROTECTED_SAMPLE.includes(row.symbol),
  );
  const [latest] = await runtime.prisma.$queryRaw<{ newest: Date }[]>`
    SELECT max(date) AS newest FROM "DailyPrice"
    WHERE "securityId" = ANY(${ordinary.map((row) => row.id)}::text[])`;
  return {
    runtime,
    ordinary,
    protectedSample,
    newest: (latest?.newest ?? new Date()).toISOString().slice(0, 10),
  };
}

const ns = STOCK_DATA_CACHE_NAMESPACE;

async function lruMembers(runtime: IndexUniverseRuntime): Promise<string[]> {
  return runtime.cache.lruStocks();
}

/** Every key of one security, its identity row included. */
async function keysOf(
  runtime: IndexUniverseRuntime,
  securityId: string,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await runtime.redis.scan(
      cursor,
      "MATCH",
      `${ns}:security:${securityId}:*`,
      "COUNT",
      1000,
    );
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

/**
 * What "the protected tier is untouched" is checked on: every designated id, its manifest and its
 * registered key names, plus the bytes of every chunk of a sample of securities.
 */
async function protectedDigest(
  runtime: IndexUniverseRuntime,
  sample: readonly string[],
) {
  const designated = (
    await runtime.redis.smembers(`${ns}:protected-stocks`)
  ).sort();
  const hash = createHash("sha256");
  let keys = 0;
  for (const id of designated) {
    const manifest = await runtime.redis.get(`${ns}:security:${id}:manifest`);
    const registered = (
      await runtime.redis.smembers(`${ns}:security:${id}:keys`)
    ).sort();
    keys += registered.length;
    hash.update(`${id}\n${manifest}\n${registered.join(",")}\n`);
  }
  const bytes = createHash("sha256");
  // Price and daily-state chunks only: a manifest records when it was published, so a rebuild
  // changes it while every chunk must come back byte for byte.
  const chunks = createHash("sha256");
  for (const id of sample) {
    for (const key of (
      await runtime.redis.smembers(`${ns}:security:${id}:keys`)
    ).sort()) {
      if ((await runtime.redis.type(key)) === "string") {
        const value = (await runtime.redis.getBuffer(key)) ?? Buffer.alloc(0);
        bytes.update(key);
        bytes.update(value);
        if (/:(prices:1D|daily-state:v\d+):\d{4}$/.test(key)) {
          chunks.update(key);
          chunks.update(value);
        }
      }
    }
  }
  return {
    designated: designated.length,
    registeredKeys: keys,
    manifestsAndRegistries: hash.digest("hex"),
    sampleChunkBytes: bytes.digest("hex"),
    sampleChunksOnly: chunks.digest("hex"),
  };
}

/** One canonical Stock Details read, checked against PostgreSQL's own rows. */
async function readChecked(
  context: Context,
  security: { id: string; symbol: string },
  years: number,
) {
  const range = {
    from: subtractYears(context.newest, years),
    to: context.newest,
  };
  const startedAt = Date.now();
  const served = await context.runtime.stockData.getDailyPrices(
    security.symbol,
    range,
  );
  const durationMs = Date.now() - startedAt;
  const stored = await context.runtime.store.getDailyPrices(security.id, range);
  const key = (rows: readonly { date: string; close: number }[]) =>
    rows.map((row) => `${row.date}:${row.close}`).join("|");
  return {
    durationMs,
    rows: served.length,
    equal: key(served) === key(stored),
  };
}

async function runLru(context: Context, out: string | null) {
  const { runtime } = context;
  const capacity = runtime.cache.lruCapacity;
  const ordinary = context.ordinary;
  if (ordinary.length < capacity + 2) {
    throw new Error(
      `Needs at least ${capacity + 2} ordinary securities with stored prices; the catalog has ${ordinary.length}`,
    );
  }
  const sampleIds = context.protectedSample.map((row) => row.id);
  const before = await protectedDigest(runtime, sampleIds);
  const auditBefore = await runtime.cache.auditTiers();

  // A fixed order: a first pass that fills and overflows the LRU, re-reads of members (recency),
  // re-admissions of evicted securities (rehydration from PostgreSQL), and protected reads between.
  const o = (index: number) =>
    ordinary[index % ordinary.length] as { id: string; symbol: string };
  const p = (index: number) =>
    context.protectedSample[index % context.protectedSample.length]!;
  const plan: {
    tier: "LRU" | "PROTECTED";
    security: { id: string; symbol: string };
  }[] = [];
  for (let index = 0; index < ordinary.length; index += 1) {
    plan.push({ tier: "LRU", security: o(index) });
    if (index % 3 === 2) plan.push({ tier: "PROTECTED", security: p(index) });
  }
  for (const index of [
    0,
    2,
    ordinary.length - 1,
    1,
    3,
    0,
    5,
    ordinary.length - 2,
    4,
    6,
  ]) {
    plan.push({ tier: "LRU", security: o(index) });
    plan.push({ tier: "PROTECTED", security: p(index) });
  }

  const model = await lruMembers(runtime);
  const steps = [];
  let mismatches = 0;
  for (const [index, step] of plan.entries()) {
    const wasResident = await runtime.cache.hasResidentStock(step.security.id);
    const read = await readChecked(context, step.security, 3);
    const victims: string[] = [];
    if (step.tier === "LRU") {
      const at = model.indexOf(step.security.id);
      if (at >= 0) model.splice(at, 1);
      model.push(step.security.id);
      while (model.length > capacity) victims.push(model.shift() as string);
    }
    const actual = await lruMembers(runtime);
    const orderMatches = JSON.stringify(actual) === JSON.stringify(model);
    const leftovers = [];
    for (const victim of victims) {
      const keys = await keysOf(runtime, victim);
      if (keys.length > 0) leftovers.push({ victim, keys: keys.length });
    }
    if (!orderMatches || leftovers.length > 0 || !read.equal) mismatches += 1;
    steps.push({
      step: index + 1,
      tier: step.tier,
      symbol: step.security.symbol,
      wasResident,
      ...read,
      victims: victims.map(
        (id) =>
          ordinary.find((row) => row.id === id)?.symbol ??
          `(other:${id.slice(0, 8)})`,
      ),
      lru: actual.map(
        (id) => ordinary.find((row) => row.id === id)?.symbol ?? id.slice(0, 8),
      ),
      orderMatches,
      leftovers,
    });
  }
  const after = await protectedDigest(runtime, sampleIds);
  const auditAfter = await runtime.cache.auditTiers(
    new Set(await loadProtectedTierSecurityIds(runtime.prisma)),
  );
  const report = {
    phase: "lru",
    capacity,
    ordinary: ordinary.map((row) => row.symbol),
    protectedSample: context.protectedSample.map((row) => row.symbol),
    lruBefore: auditBefore.lru,
    steps,
    mismatches,
    protectedUnchanged: JSON.stringify(before) === JSON.stringify(after),
    protectedBefore: before,
    protectedAfter: after,
    audit: {
      lru: auditAfter.lru,
      protected: {
        ...auditAfter.protected,
        notResident: auditAfter.protected.notResident.length,
      },
      orphans: auditAfter.orphans.length,
      dualResidency: auditAfter.dualResidency.length,
      violations: auditAfter.violations,
    },
    providerRequests: runtime.guard.ledger().sent,
  };
  write(out, report);
  return report;
}

async function runConcurrency(
  context: Context,
  input: { processes: number; operations: number; out: string | null },
) {
  const { runtime } = context;
  const capacity = runtime.cache.lruCapacity;
  const sampleIds = context.protectedSample.map((row) => row.id);
  const before = await protectedDigest(runtime, sampleIds);
  // A previous run's larger capacity is reached at the first access under this one; that access
  // happens here, before sampling starts, so the samples measure only the processes below.
  const initial = await runtime.redis.zcard(`${ns}:resident-stocks`);
  const first = (await lruMembers(runtime))[0];
  let forcedEviction: {
    lruBefore: number;
    lruAfter: number;
    durationMs: number;
    evictedKeysLeft: number;
  } | null = null;
  if (initial > capacity && first) {
    const membersBefore = await lruMembers(runtime);
    const startedAt = Date.now();
    await runtime.cache.touch(first);
    const durationMs = Date.now() - startedAt;
    const membersAfter = new Set(await lruMembers(runtime));
    let evictedKeysLeft = 0;
    for (const id of membersBefore.filter(
      (member) => !membersAfter.has(member),
    )) {
      evictedKeysLeft += (await keysOf(runtime, id)).length;
    }
    forcedEviction = {
      lruBefore: membersBefore.length,
      lruAfter: membersAfter.size,
      durationMs,
      evictedKeysLeft,
    };
  }
  let sampling = true;
  let maxObserved = 0;
  let samples = 0;
  const sampler = (async () => {
    while (sampling) {
      maxObserved = Math.max(
        maxObserved,
        await runtime.redis.zcard(`${ns}:resident-stocks`),
      );
      samples += 1;
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
  })();
  const tsx = join(repositoryRoot(), "apps/api/node_modules/.bin/tsx");
  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from(
      { length: input.processes },
      (_, seed) =>
        new Promise<ChildResult>((resolveChild, rejectChild) => {
          const child = spawn(
            tsx,
            [
              __filename,
              "child",
              "--seed",
              String(seed + 1),
              "--operations",
              String(input.operations),
            ],
            {
              cwd: repositoryRoot(),
              env: process.env,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on(
            "data",
            (chunk: Buffer) => (stdout += chunk.toString()),
          );
          child.stderr.on(
            "data",
            (chunk: Buffer) => (stderr += chunk.toString()),
          );
          child.on("exit", (code) => {
            const line = stdout
              .trim()
              .split("\n")
              .filter((entry) => entry.startsWith('{"child"'))
              .at(-1);
            if (code === 0 && line) {
              resolveChild(JSON.parse(line) as ChildResult);
            } else {
              rejectChild(
                new Error(
                  `child ${seed + 1} exited ${code}: ${stderr.slice(-2000)}`,
                ),
              );
            }
          });
        }),
    ),
  );
  const wallMs = Date.now() - startedAt;
  sampling = false;
  await sampler;
  const after = await protectedDigest(runtime, sampleIds);
  const audit = await runtime.cache.auditTiers(
    new Set(await loadProtectedTierSecurityIds(runtime.prisma)),
  );
  const members = new Set(await lruMembers(runtime));
  const residue = [];
  for (const security of context.ordinary) {
    if (!members.has(security.id)) {
      const keys = await keysOf(runtime, security.id);
      const persistent = [];
      for (const key of keys) {
        if ((await runtime.redis.pttl(key)) === -1) persistent.push(key);
      }
      if (persistent.length > 0)
        residue.push({ symbol: security.symbol, keys: persistent.length });
    }
  }
  const resident = [];
  for (const security of context.ordinary.filter((row) =>
    members.has(row.id),
  )) {
    resident.push({
      symbol: security.symbol,
      ...(await readChecked(context, security, 5)),
    });
  }
  const total = (pick: (result: ChildResult) => number) =>
    results.reduce((sum, result) => sum + pick(result), 0);
  const report = {
    phase: "concurrency",
    capacity,
    forcedEviction,
    processes: input.processes,
    operationsPerProcess: input.operations,
    wallMs,
    reads: total((result) => result.reads),
    lruReads: total((result) => result.lruReads),
    protectedReads: total((result) => result.protectedReads),
    coldReads: total((result) => result.coldReads),
    mismatches: total((result) => result.mismatches),
    errors: results.flatMap((result) => result.errors),
    readMs: {
      p50: percentile(
        results.flatMap((result) => result.durations),
        0.5,
      ),
      p95: percentile(
        results.flatMap((result) => result.durations),
        0.95,
      ),
      max: percentile(
        results.flatMap((result) => result.durations),
        1,
      ),
    },
    lruSize: { initial, maxObserved, samples, final: members.size },
    residue,
    resident,
    protectedUnchanged: JSON.stringify(before) === JSON.stringify(after),
    audit: {
      lru: audit.lru,
      protected: {
        ...audit.protected,
        notResident: audit.protected.notResident.length,
      },
      orphans: audit.orphans.length,
      dualResidency: audit.dualResidency.length,
      violations: audit.violations,
    },
    providerRequests:
      runtime.guard.ledger().sent + total((result) => result.providerRequests),
  };
  write(input.out, report);
  return report;
}

/**
 * Promotion (`stock-cache-tiers-v1.md` §3): designating an LRU member protected moves it out of the
 * LRU with its data exactly as it was — no rewrite, no rehydration, no TTL — and frees its slot.
 */
async function runPromotion(context: Context, out: string | null) {
  const { runtime } = context;
  const before = await lruMembers(runtime);
  const candidate = before.at(-1);
  if (!candidate) {
    throw new Error(
      "The LRU is empty: read some ordinary securities first (the lru phase)",
    );
  }
  const keysBefore = (await keysOf(runtime, candidate)).sort();
  const digest = async () => {
    const hash = createHash("sha256");
    for (const key of keysBefore) {
      hash.update(key);
      if ((await runtime.redis.type(key)) === "string") {
        hash.update((await runtime.redis.getBuffer(key)) ?? Buffer.alloc(0));
      }
    }
    return hash.digest("hex");
  };
  const bytesBefore = await digest();
  const designated = await runtime.cache.protectStocks([candidate]);
  const after = await lruMembers(runtime);
  const keysAfter = (await keysOf(runtime, candidate)).sort();
  const ttls = await Promise.all(
    keysAfter.map((key) => runtime.redis.pttl(key)),
  );
  const report = {
    phase: "promotion",
    capacity: runtime.cache.lruCapacity,
    designated,
    lruBefore: before.length,
    lruAfter: after.length,
    leftLru: !after.includes(candidate),
    isDesignated:
      (await runtime.redis.sismember(`${ns}:protected-stocks`, candidate)) ===
      1,
    keysUnchanged: JSON.stringify(keysBefore) === JSON.stringify(keysAfter),
    bytesUnchanged: bytesBefore === (await digest()),
    keysWithTtl: ttls.filter((ttl) => ttl >= 0).length,
    keys: keysAfter.length,
    // Demotion: reconciling the designation with the canonical universe hands the stock back to
    // the LRU as its newest member, under its capacity, with its data still intact.
    demotion: await (async () => {
      const reconciled = await runtime.cache.reconcileProtectedStocks([
        ...(await loadProtectedTierSecurityIds(runtime.prisma)),
      ]);
      const lru = await lruMembers(runtime);
      return {
        ...reconciled,
        rejoinedAsNewest: lru.at(-1) === candidate,
        lruSize: lru.length,
        withinCapacity: lru.length <= runtime.cache.lruCapacity,
        keysUnchanged:
          JSON.stringify(keysBefore) ===
          JSON.stringify((await keysOf(runtime, candidate)).sort()),
        bytesUnchanged: bytesBefore === (await digest()),
      };
    })(),
  };
  write(out, report);
  return report;
}

/**
 * Protected residency: every designated security is READY, has keys, and carries no TTL on any key;
 * and the protected digest survives whatever LRU churn ran before (compare with a previous digest).
 */
async function runResidency(context: Context, out: string | null) {
  const { runtime } = context;
  const designated = await runtime.redis.smembers(`${ns}:protected-stocks`);
  let keys = 0;
  let withTtl = 0;
  let missingManifest = 0;
  for (const id of designated) {
    const manifest = await runtime.redis.get(`${ns}:security:${id}:manifest`);
    if (!manifest) {
      missingManifest += 1;
    }
    const registered = await runtime.redis.smembers(
      `${ns}:security:${id}:keys`,
    );
    keys += registered.length;
    const pipeline = runtime.redis.pipeline();
    for (const key of registered) {
      pipeline.pttl(key);
    }
    for (const [, ttl] of (await pipeline.exec()) ?? []) {
      if (typeof ttl === "number" && ttl >= 0) {
        withTtl += 1;
      }
    }
  }
  const audit = await runtime.cache.auditTiers(
    new Set(await loadProtectedTierSecurityIds(runtime.prisma)),
  );
  const report = {
    phase: "residency",
    designated: designated.length,
    keys,
    protectedKeysWithTtl: withTtl,
    designatedWithoutManifest: missingManifest,
    digest: await protectedDigest(
      runtime,
      context.protectedSample.map((row) => row.id),
    ),
    audit: {
      lru: audit.lru,
      protected: {
        ...audit.protected,
        notResident: audit.protected.notResident.length,
      },
      orphans: audit.orphans.length,
      dualResidency: audit.dualResidency.length,
      violations: audit.violations,
    },
  };
  write(out, report);
  return report;
}

type ChildResult = {
  child: number;
  reads: number;
  lruReads: number;
  protectedReads: number;
  coldReads: number;
  mismatches: number;
  errors: string[];
  durations: number[];
  providerRequests: number;
};

async function runChild(context: Context, seed: number, operations: number) {
  let state = seed * 2_654_435_761;
  const next = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  const result: ChildResult = {
    child: seed,
    reads: 0,
    lruReads: 0,
    protectedReads: 0,
    coldReads: 0,
    mismatches: 0,
    errors: [],
    durations: [],
    providerRequests: 0,
  };
  for (let operation = 0; operation < operations; operation += 1) {
    const protectedRead = next() < 0.3;
    const pool = protectedRead ? context.protectedSample : context.ordinary;
    const security = pool[Math.floor(next() * pool.length)] as {
      id: string;
      symbol: string;
    };
    try {
      const cold = !(await context.runtime.cache.hasResidentStock(security.id));
      const read = await readChecked(
        context,
        security,
        1 + Math.floor(next() * 5),
      );
      result.reads += 1;
      if (protectedRead) result.protectedReads += 1;
      else result.lruReads += 1;
      if (cold) result.coldReads += 1;
      if (!read.equal) result.mismatches += 1;
      result.durations.push(read.durationMs);
    } catch (error) {
      result.errors.push(
        `${security.symbol}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  result.providerRequests = context.runtime.guard.ledger().sent;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function percentile(values: readonly number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(share * sorted.length))
  ] as number;
}

function write(out: string | null, report: unknown) {
  if (out) {
    const path = resolve(repositoryRoot(), out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  }
}

async function main() {
  loadRootEnv();
  const [phase, ...rest] = process.argv
    .slice(2)
    .filter((value) => value !== "--");
  if (
    phase !== "lru" &&
    phase !== "concurrency" &&
    phase !== "digest" &&
    phase !== "child" &&
    phase !== "promotion" &&
    phase !== "residency"
  ) {
    throw new Error(
      "Usage: stock-cache-tier-validation <lru|concurrency|digest|promotion|residency> [--out f] [--processes n] [--operations n]",
    );
  }
  const option = (name: string, fallback: string | null) => {
    const index = rest.indexOf(name);
    return index >= 0 ? (rest[index + 1] ?? fallback) : fallback;
  };
  const ctx = await context(phase as Phase);
  try {
    if (phase === "child") {
      await runChild(
        ctx,
        Number(option("--seed", "1")),
        Number(option("--operations", "100")),
      );
      return;
    }
    if (phase === "digest") {
      // Read-only: what a restart or a rebuild must reproduce.
      const audit = await ctx.runtime.cache.auditTiers(
        new Set(await loadProtectedTierSecurityIds(ctx.runtime.prisma)),
      );
      const report = {
        phase: "digest",
        protected: await protectedDigest(
          ctx.runtime,
          ctx.protectedSample.map((row) => row.id),
        ),
        lru: (await lruMembers(ctx.runtime)).map(
          (id) => ctx.ordinary.find((row) => row.id === id)?.symbol ?? id,
        ),
        audit: {
          manifests: audit.manifests,
          protected: {
            ...audit.protected,
            notResident: audit.protected.notResident.length,
          },
          lru: audit.lru,
          orphans: audit.orphans.length,
          dualResidency: audit.dualResidency.length,
          violations: audit.violations,
        },
      };
      write(option("--out", null), report);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    if (phase === "promotion" || phase === "residency") {
      const report =
        phase === "promotion"
          ? await runPromotion(ctx, option("--out", null))
          : await runResidency(ctx, option("--out", null));
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    const report =
      phase === "lru"
        ? await runLru(ctx, option("--out", null))
        : await runConcurrency(ctx, {
            processes: Number(option("--processes", "4")),
            operations: Number(option("--operations", "100")),
            out: option("--out", null),
          });
    const summary = report as Record<string, unknown>;
    process.stdout.write(
      `${JSON.stringify({ ...summary, steps: undefined, resident: undefined }, null, 2)}\n`,
    );
  } finally {
    await ctx.runtime.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
