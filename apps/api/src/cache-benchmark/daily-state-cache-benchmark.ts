import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import {
  FUNDAMENTAL_METRIC_IDS,
  type DailyDerivedState,
  type Security,
} from "@intrinsic/domain";
import type { FmpStockProviderPort } from "@intrinsic/fmp";
import {
  CanonicalStockDataService,
  DAILY_STATE_CHUNK_FIELDS,
  DAILY_STATE_ENCODING_VERSION,
  DERIVED_STATE_REVISION,
  IoredisCacheClient,
  PrismaStockDataStore,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  createStockDataRedisClient,
  dailyStateChunkKey,
  decodeDailyStateChunk,
  encodeDailyStateChunk,
  priceRetentionYears,
  subtractYears,
  yearsInRange,
} from "@intrinsic/stock-data";
import {
  PRICE_OPERAND,
  fundamentalMetricOperand,
  marginOfSafetyOperand,
  relativeVolumeOperand,
  seriesOperand,
  type OperandKey,
} from "@intrinsic/strategy";
import { useMatrixDatabase } from "../qa-matrix/matrix-environment";
import { repositoryRoot } from "../qa-matrix/matrix-paths";

/**
 * `pnpm bench:daily-state-cache [--symbols=WMT,AAPL] [--out=<file>]`
 *
 * Measures what the Redis `daily-state` chunks cost, in bytes, in Redis memory and in CPU, on the
 * frozen QA-matrix copy — the same real histories the Fundamental Metrics audit sized the cache on —
 * and on synthetic worst cases. Re-run it whenever a series family is added: it is how the
 * storage decision's per-security and resident-set budgets are re-checked.
 *
 * Every security is hydrated over its full retained history through the production service into a
 * throwaway namespace of the matrix Redis index, with a provider that refuses every request, and the
 * namespace is removed afterwards. For each security it records:
 *
 * - every registered key's payload (`STRLEN`) and Redis memory (`MEMORY USAGE … SAMPLES 0`), by
 *   family, as published by the current (columnar) encoding;
 * - the same history in the retired row-oriented encoding — each year's PostgreSQL rows as one
 *   `JSON.stringify` array, which is byte for byte what that encoding published — written beside it
 *   under its old key name, measured and deleted;
 * - PostgreSQL parity: each published chunk, decoded, against the stored rows, byte for byte.
 *
 * Then encode/decode CPU for both encodings, the warm read paths (a thirty-year Stock Details
 * Fundamental, thirty-one calendar-year backtest frame windows), the Redis commands those reads
 * issue, synthetic worst cases, the resident capacity against the storage decision's 2 GB budget,
 * and a simulation of four more daily-changing numeric columns (the size of the valuation-ratio
 * family, benchmark-only: no product field exists).
 *
 * The numbers are **machine-specific**. The report records the machine, runtime and Redis version;
 * treat timings as ratios between the two encodings on one machine, not as production values. Run
 * with `NODE_OPTIONS=--expose-gc` to include retained-heap figures.
 */

const BUDGET_BYTES = 2_000_000_000;
const RESIDENT_LIMIT = 100;
const REPEATS = 7;
/** A UUID-length id, so a synthetic row pays for the security id exactly as a real one does. */
const SYNTHETIC_SECURITY_ID = "00000000-0000-4000-8000-000000000000";
/** Benchmark-only stand-ins for the valuation-ratio family: four daily-changing numbers. */
const VALUATION_FIELDS = ["peRatio", "psRatio", "pfcfRatio", "evToEbitda"];

type Stat = { medianMs: number; maxMs: number; minMs: number };
type Footprint = { keys: number; payload: number; memory: number };

/** One real security, hydrated over its full retention, in both encodings. */
type SecurityMeasurement = {
  symbol: string;
  rows: number;
  chunks: number;
  keys: number;
  hydrationMs: number;
  /** Published chunks whose decoded rows differ from PostgreSQL's in any byte. */
  parityMismatches: number;
  families: Record<string, Footprint>;
  dailyState: { legacy: Footprint; columnar: Footprint };
  /** Redis memory of every registered key, with the daily state in each encoding. */
  memory: { before: number; after: number };
  valuation: { legacyIncrement: number; columnarIncrement: number };
};

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)
  ] as number;
}

async function timed<T>(
  repeats: number,
  run: () => Promise<T> | T,
): Promise<{ stat: Stat; result: T }> {
  const samples: number[] = [];
  let result: T | undefined;
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const started = performance.now();
    result = await run();
    samples.push(performance.now() - started);
  }
  return {
    stat: {
      medianMs: round(median(samples)),
      maxMs: round(Math.max(...samples)),
      minMs: round(Math.min(...samples)),
    },
    result: result as T,
  };
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

/**
 * Garbage collections and their pause time while `run` executes: a proxy for allocation pressure.
 * GC entries reach an observer asynchronously, so it stays attached briefly after `run` returns.
 */
async function gcDuring(run: () => Promise<void> | void) {
  const entries: { duration: number }[] = [];
  const observer = new PerformanceObserver((list) => {
    entries.push(...list.getEntries());
  });
  observer.observe({ entryTypes: ["gc"] });
  await run();
  await new Promise((resolve) => setTimeout(resolve, 100));
  observer.disconnect();
  return {
    collections: entries.length,
    gcMs: round(entries.reduce((sum, entry) => sum + entry.duration, 0)),
  };
}

/** Heap retained by what `produce` returns, per call; `null` without `--expose-gc`. */
function retainedBytes(produce: () => unknown, calls = 5): number | null {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (!collect) {
    return null;
  }
  collect();
  const before = process.memoryUsage().heapUsed;
  const kept: unknown[] = [];
  for (let call = 0; call < calls; call += 1) {
    kept.push(produce());
  }
  collect();
  const after = process.memoryUsage().heapUsed;
  return kept.length > 0 ? Math.round((after - before) / calls) : null;
}

/** A small, fast, seeded generator, so synthetic histories are identical on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function weekdays(from: string, to: string): string[] {
  const dates: string[] = [];
  for (
    let cursor = new Date(`${from}T00:00:00.000Z`);
    cursor <= new Date(`${to}T00:00:00.000Z`);
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    if (cursor.getUTCDay() % 6 !== 0) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
  }
  return dates;
}

/**
 * Every field present on every weekday of the full retention, at stored precision (eight decimals)
 * and realistic magnitudes.
 *
 * - `realistic`: each family changes at its own real cadence, pushed to the worst case — the daily
 *   families every session, the weekly ones every week, and every statement-derived value and
 *   provenance instant every 21 sessions (twelve statement events a year; the matrix's real maximum
 *   is eight).
 * - `ceiling`: every field changes on every session. Impossible for the carried-forward families,
 *   whose materializers only change them on a week or a statement event, but it is the upper bound
 *   of the encoding itself: no run is ever longer than one session.
 */
function syntheticRows(
  dates: readonly string[],
  variant: "realistic" | "ceiling",
): DailyDerivedState[] {
  const random = seeded(variant === "realistic" ? 20_260_930 : 20_260_931);
  const decimal = (low: number, high: number) =>
    Number((low + random() * (high - low)).toFixed(8));
  const carried = new Map<string, unknown>();
  /** A value held for `every` sessions: the carry-forward the materializers apply. */
  const step = <T>(
    key: string,
    index: number,
    every: number,
    next: () => T,
  ): T => {
    const bucket = `${key}:${variant === "ceiling" ? index : Math.floor(index / every)}`;
    if (!carried.has(bucket)) {
      carried.set(bucket, next());
    }
    return carried.get(bucket) as T;
  };
  return dates.map((date, index) => {
    const weekly = <T>(key: string, next: () => T) => step(key, index, 5, next);
    const statement = <T>(key: string, next: () => T) =>
      step(key, index, 21, next);
    const instant = () =>
      `${date}T${String(Math.floor(random() * 24)).padStart(2, "0")}:00:00.000Z`;
    return {
      securityId: SYNTHETIC_SECURITY_ID,
      date,
      sma20d: decimal(100, 999),
      sma50d: decimal(100, 999),
      sma100d: decimal(100, 999),
      sma200d: decimal(100, 999),
      ema20d: decimal(100, 999),
      ema50d: decimal(100, 999),
      ema200d: decimal(100, 999),
      weeklySourceWeekStart: weekly("week", () => date),
      sma20w: weekly("sma20w", () => decimal(100, 999)),
      sma50w: weekly("sma50w", () => decimal(100, 999)),
      sma100w: weekly("sma100w", () => decimal(100, 999)),
      sma200w: weekly("sma200w", () => decimal(100, 999)),
      ema20w: weekly("ema20w", () => decimal(100, 999)),
      ema50w: weekly("ema50w", () => decimal(100, 999)),
      ema200w: weekly("ema200w", () => decimal(100, 999)),
      rsi7d: decimal(10, 99),
      rsi14d: decimal(10, 99),
      rsi21d: decimal(10, 99),
      rvol10: decimal(0.1, 9),
      rvol20: decimal(0.1, 9),
      rvol50: decimal(0.1, 9),
      ...Object.fromEntries(
        FUNDAMENTAL_METRIC_IDS.map((id, position) => [
          [
            "revenueGrowthTtmYoy",
            "epsGrowthTtmYoy",
            "fcfGrowthTtmYoy",
            "grossMarginTtm",
            "operatingMarginTtm",
            "netMarginTtm",
            "fcfMarginTtm",
            "roicTtm",
            "roeTtm",
            "roaTtm",
            "debtToEquity",
            "currentRatio",
            "netDebtToEbitdaTtm",
            "interestCoverageTtm",
            "assetTurnoverTtm",
          ][position] as string,
          statement(id, () =>
            position < 10 ? decimal(10, 99) : decimal(0.1, 9),
          ),
        ]),
      ),
      intrinsicValues: {
        DCF_FCFF: statement("dcf", () => decimal(100, 999)),
        RESIDUAL_INCOME: statement("ri", () => decimal(100, 999)),
        DDM: statement("ddm", () => decimal(100, 999)),
        GRAHAM: statement("graham", () => decimal(100, 999)),
      },
      intrinsicValueBlends: {
        BALANCED: statement("balanced", () => decimal(100, 999)),
        CONSERVATIVE: statement("conservative", () => decimal(100, 999)),
        DIVIDEND: statement("dividend", () => decimal(100, 999)),
      },
      dcfFcffSourceAsOf: statement("dcfAsOf", instant),
      residualIncomeSourceAsOf: statement("riAsOf", instant),
      ddmSourceAsOf: statement("ddmAsOf", instant),
      grahamSourceAsOf: statement("grahamAsOf", instant),
      intrinsicCurrency: "USD",
    } as DailyDerivedState;
  });
}

function byYear(
  rows: readonly DailyDerivedState[],
): Map<number, DailyDerivedState[]> {
  const years = new Map<number, DailyDerivedState[]>();
  for (const row of rows) {
    const year = Number(row.date.slice(0, 4));
    const bucket = years.get(year);
    if (bucket) {
      bucket.push(row);
    } else {
      years.set(year, [row]);
    }
  }
  return years;
}

/** Four more daily-changing columns in the row-oriented encoding: what a row would grow by. */
function withValuation(
  rows: readonly DailyDerivedState[],
  seed: number,
): object[] {
  const random = seeded(seed);
  return rows.map((row) => ({
    ...row,
    ...Object.fromEntries(
      VALUATION_FIELDS.map((field) => [
        field,
        Number((5 + random() * 60).toFixed(8)),
      ]),
    ),
  }));
}

/** The same four columns appended to a version-2 chunk, as the encoder would lay them out. */
function columnarWithValuation(
  payload: string,
  sessions: number,
  seed: number,
): string {
  const random = seeded(seed);
  const names = VALUATION_FIELDS.map((field) => JSON.stringify(field)).join(
    ",",
  );
  const columns = VALUATION_FIELDS.map(() =>
    JSON.stringify(
      Array.from({ length: sessions }, () =>
        Number((5 + random() * 60).toFixed(8)),
      ),
    ),
  ).join(",");
  const lastField = JSON.stringify(DAILY_STATE_CHUNK_FIELDS.at(-1));
  return payload
    .replace(`${lastField}],"dates"`, `${lastField},${names}],"dates"`)
    .replace(/\]\}$/, `,${columns}]}`);
}

/** The retired encoding's read path, exactly: every chunk parsed, filtered, then sorted. */
function legacyRead(
  payloads: readonly string[],
  range: { from: string; to: string },
): DailyDerivedState[] {
  return payloads
    .flatMap((payload) => JSON.parse(payload) as DailyDerivedState[])
    .filter((row) => row.date >= range.from && row.date <= range.to)
    .sort((left, right) => left.date.localeCompare(right.date));
}

function columnarRead(
  securityId: string,
  payloads: readonly { year: number; payload: string }[],
  range: { from: string; to: string },
): DailyDerivedState[] {
  const rows: DailyDerivedState[] = [];
  for (const { year, payload } of payloads) {
    const decoded = decodeDailyStateChunk(payload, { securityId, year }, range);
    if (!decoded.ok) {
      throw new Error(`${securityId} ${year}: ${decoded.reason}`);
    }
    rows.push(...decoded.rows);
  }
  return rows;
}

/** Records every cache command by name (and Lua script by its tag), for the command profile. */
class CountingCacheClient extends IoredisCacheClient {
  readonly commands = new Map<string, number>();
  private count(name: string) {
    this.commands.set(name, (this.commands.get(name) ?? 0) + 1);
  }
  reset() {
    this.commands.clear();
  }
  override get(key: string) {
    this.count("GET");
    return super.get(key);
  }
  override mget(...keys: string[]) {
    this.count("MGET");
    return super.mget(...keys);
  }
  override set(key: string, value: string) {
    this.count("SET");
    return super.set(key, value);
  }
  override smembers(key: string) {
    this.count("SMEMBERS");
    return super.smembers(key);
  }
  override zscore(key: string, member: string) {
    this.count("ZSCORE");
    return super.zscore(key, member);
  }
  override eval(script: string, numberOfKeys: number, ...args: string[]) {
    this.count(`EVAL ${/--\s*([a-z-]+)/.exec(script)?.[1] ?? "?"}`);
    return super.eval(script, numberOfKeys, ...args);
  }
}

async function main(): Promise<void> {
  loadRootEnv();
  const environment = useMatrixDatabase();
  const root = repositoryRoot();
  const out =
    flag("out") ??
    join(root, "artifacts", "daily-state-cache-benchmark", "report.json");
  const onlySymbols = flag("symbols")
    ?.split(",")
    .map((symbol) => symbol.trim().toUpperCase());
  const timingSymbol = (flag("timing-symbol") ?? "WMT").toUpperCase();
  const detailsSymbol = (flag("stock-details-symbol") ?? "AAPL").toUpperCase();

  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(environment.redisUrl);
  const namespace = `stock-data:v2:bench-daily-state:${Date.now()}`;
  const providerCalls: string[] = [];
  const refuse = (call: string): never => {
    providerCalls.push(call);
    throw new Error(`the benchmark may not reach the provider (${call})`);
  };
  const provider: FmpStockProviderPort = {
    getProfile: async (symbol) => refuse(`profile ${symbol}`),
    getDailyPrices: async (symbol) => refuse(`prices ${symbol}`),
    getFinancialStatements: async (symbol, _id, type) =>
      refuse(`statements ${symbol} ${type}`),
  };
  const store = new PrismaStockDataStore(prisma);
  const counting = new CountingCacheClient(redis);
  const cache = new RedisStockDataCache(counting, 1_000, namespace);
  const tenYears = 10 * 365 * 24 * 60 * 60 * 1_000;

  // The frozen copy must come out of the benchmark exactly as it went in: every read here is meant to
  // be answered from durable coverage, so a gap that made the loader rebuild and write would be a
  // measurement of something else. Checked before and after, over every derived row.
  const fingerprint = async () =>
    (
      await prisma.$queryRawUnsafe<{ rows: number; digest: string }[]>(
        `select count(*)::int as rows, sum(hashtextextended(t::text, 0))::text as digest
           from "DailyDerivedState" t`,
      )
    )[0];

  try {
    const fingerprintBefore = await fingerprint();
    // The data clock of the frozen copy: its newest derived coverage, exactly as the audit reads it.
    const clock = await prisma.$queryRawUnsafe<{ asOf: string }[]>(
      `select max("toDate")::text as "asOf" from "StockDatasetCoverage" where dataset = 'DAILY_DERIVED_STATE'`,
    );
    const asOf = clock[0]?.asOf;
    if (!asOf) {
      throw new Error(
        "the matrix database holds no derived coverage to benchmark",
      );
    }
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
        now: () => new Date(`${asOf}T12:00:00.000Z`),
        recentPriceFreshnessMs: tenYears,
        fundamentalsFreshnessMs: tenYears,
      },
    );
    const period = {
      from: `${Number(asOf.slice(0, 4)) - 30}${asOf.slice(4)}`,
      to: asOf,
    };
    const listed = await prisma.$queryRawUnsafe<
      { id: string; symbol: string }[]
    >(
      `select s.id, s.symbol from "Security" s
        where exists (select 1 from "DailyDerivedState" d where d."securityId" = s.id)
        order by s.symbol`,
    );
    const catalog = (
      await service.findSecuritiesByIds(listed.map((row) => row.id))
    ).filter(
      (security) => !onlySymbols || onlySymbols.includes(security.symbol),
    );

    /** Every registered key of one security, by family: payload bytes and Redis memory. */
    async function footprint(
      securityId: string,
    ): Promise<Record<string, Footprint>> {
      const registry = `${namespace}:security:${securityId}:keys`;
      const keys = await redis.smembers(registry);
      const pipeline = redis.pipeline();
      for (const key of keys) {
        pipeline.strlen(key);
        pipeline.call("MEMORY", "USAGE", key, "SAMPLES", "0");
      }
      pipeline.call("MEMORY", "USAGE", registry, "SAMPLES", "0");
      const replies = (await pipeline.exec()) ?? [];
      const families: Record<string, Footprint> = {};
      keys.forEach((key, index) => {
        const rest = key.startsWith(`${namespace}:symbol:`)
          ? "security"
          : (key
              .slice(`${namespace}:security:${securityId}:`.length)
              .split(":")[0] as string);
        const family = (families[rest] ??= { keys: 0, payload: 0, memory: 0 });
        family.keys += 1;
        family.payload += Number(replies[index * 2]?.[1]);
        family.memory += Number(replies[index * 2 + 1]?.[1]);
      });
      families.registry = {
        keys: 1,
        payload: 0,
        memory: Number(replies.at(-1)?.[1]),
      };
      return families;
    }

    /** Redis memory of payloads written under the given keys, then removed again. */
    async function memoryOf(
      entries: readonly [string, string][],
    ): Promise<Footprint> {
      const pipeline = redis.pipeline();
      for (const [key, payload] of entries) {
        pipeline.set(key, payload);
        pipeline.call("MEMORY", "USAGE", key, "SAMPLES", "0");
      }
      const replies = (await pipeline.exec()) ?? [];
      if (entries.length > 0) {
        await redis.del(...entries.map(([key]) => key));
      }
      return {
        keys: entries.length,
        payload: entries.reduce(
          (sum, [, payload]) => sum + Buffer.byteLength(payload),
          0,
        ),
        memory: entries.reduce(
          (sum, _entry, index) => sum + Number(replies[index * 2 + 1]?.[1]),
          0,
        ),
      };
    }

    const securities: SecurityMeasurement[] = [];
    for (const security of catalog as Security[]) {
      const started = performance.now();
      await service.prepareDailyEvaluationData(security, period, []);
      const hydrationMs = round(performance.now() - started, 1);
      const manifest = await cache.getManifest(security.id);
      const coverage = {
        from: manifest?.coverageStart as string,
        to: manifest?.coverageEnd as string,
      };
      const years = yearsInRange(coverage);
      const families = await footprint(security.id);
      const stored = byYear(
        await store.getDailyDerivedState(security.id, coverage),
      );

      const chunks = await redis.mget(
        ...years.map((year) =>
          dailyStateChunkKey(namespace, security.id, year),
        ),
      );
      let rows = 0;
      let mismatches = 0;
      years.forEach((year, index) => {
        const expected = stored.get(year) ?? [];
        const decoded = decodeDailyStateChunk(chunks[index] ?? "", {
          securityId: security.id,
          year,
        });
        rows += expected.length;
        if (
          !decoded.ok ||
          JSON.stringify(decoded.rows) !== JSON.stringify(expected)
        ) {
          mismatches += 1;
        }
      });
      // The retired encoding, under its own key name: each year's rows as one JSON array.
      const legacy = await memoryOf(
        years.map((year) => [
          `${namespace}:security:${security.id}:daily-state:${year}`,
          JSON.stringify(stored.get(year) ?? []),
        ]),
      );
      const valuationLegacy = await memoryOf(
        years.map((year) => [
          `${namespace}:security:${security.id}:daily-state:${year}`,
          JSON.stringify(withValuation(stored.get(year) ?? [], year)),
        ]),
      );
      const valuationColumnar = await memoryOf(
        years.map((year, index) => [
          `${namespace}:valuation:${security.id}:${year}`,
          columnarWithValuation(
            chunks[index] ?? "",
            stored.get(year)?.length ?? 0,
            year,
          ),
        ]),
      );
      const columnar = families["daily-state"] as Footprint;
      const after = Object.values(families).reduce(
        (sum, family) => sum + family.memory,
        0,
      );
      securities.push({
        symbol: security.symbol,
        rows,
        chunks: years.length,
        keys: Object.values(families).reduce(
          (sum, family) => sum + family.keys,
          0,
        ),
        hydrationMs,
        parityMismatches: mismatches,
        families,
        dailyState: { legacy, columnar },
        memory: { before: after - columnar.memory + legacy.memory, after },
        valuation: {
          legacyIncrement: valuationLegacy.memory - legacy.memory,
          columnarIncrement: valuationColumnar.memory - columnar.memory,
        },
      });
      console.log(
        `${security.symbol.padEnd(6)} ${years.length} chunks ${String(rows).padStart(5)} rows  ` +
          `daily-state ${(legacy.memory / 1_048_576).toFixed(2)} → ${(columnar.memory / 1_048_576).toFixed(2)} MiB  ` +
          `security ${((after - columnar.memory + legacy.memory) / 1_048_576).toFixed(2)} → ${(after / 1_048_576).toFixed(2)} MiB  ` +
          `parity ${mismatches === 0 ? "exact" : `${mismatches} MISMATCHED CHUNKS`}`,
      );
    }

    const summarize = (values: readonly number[]) => ({
      mean: Math.round(
        values.reduce((sum, value) => sum + value, 0) / values.length,
      ),
      median: Math.round(median(values)),
      p95: percentile(values, 0.95),
      max: Math.max(...values),
      min: Math.min(...values),
    });
    const largestBy = (pick: (entry: SecurityMeasurement) => number) =>
      securities.reduce((best, entry) =>
        pick(entry) > pick(best) ? entry : best,
      );

    // ---- CPU: both encodings on the same rows of one long history. -----------------------------
    const timingSecurity = (catalog as Security[]).find(
      (entry) => entry.symbol === timingSymbol,
    );
    const timing: Record<string, unknown> = {};
    if (timingSecurity) {
      const manifest = await cache.getManifest(timingSecurity.id);
      const coverage = {
        from: manifest?.coverageStart as string,
        to: manifest?.coverageEnd as string,
      };
      const stored = byYear(
        await store.getDailyDerivedState(timingSecurity.id, coverage),
      );
      const years = [...stored.keys()];
      const legacyPayloads = years.map((year) =>
        JSON.stringify(stored.get(year)),
      );
      const columnarPayloads = years.map((year) => ({
        year,
        payload: encodeDailyStateChunk(
          timingSecurity.id,
          year,
          stored.get(year) ?? [],
        ),
      }));
      const fullYear = years.at(-2) as number;
      const oneYear = { from: `${fullYear}-01-01`, to: `${fullYear}-12-31` };
      const yearRows = stored.get(fullYear) ?? [];
      const legacyYear = JSON.stringify(yearRows);
      const columnarYear = encodeDailyStateChunk(
        timingSecurity.id,
        fullYear,
        yearRows,
      );

      const encodeLegacy = await timed(REPEATS * 5, () =>
        JSON.stringify(yearRows),
      );
      const encodeColumnar = await timed(REPEATS * 5, () =>
        encodeDailyStateChunk(timingSecurity.id, fullYear, yearRows),
      );
      const decodeLegacy = await timed(REPEATS * 5, () =>
        legacyRead([legacyYear], oneYear),
      );
      const decodeColumnar = await timed(REPEATS * 5, () =>
        columnarRead(
          timingSecurity.id,
          [{ year: fullYear, payload: columnarYear }],
          oneYear,
        ),
      );
      const fullLegacy = await timed(REPEATS, () =>
        legacyRead(legacyPayloads, coverage),
      );
      const fullColumnar = await timed(REPEATS, () =>
        columnarRead(timingSecurity.id, columnarPayloads, coverage),
      );
      const encodeAllLegacy = await timed(REPEATS, () =>
        years.map((year) => JSON.stringify(stored.get(year))),
      );
      const encodeAllColumnar = await timed(REPEATS, () =>
        years.map((year) =>
          encodeDailyStateChunk(
            timingSecurity.id,
            year,
            stored.get(year) ?? [],
          ),
        ),
      );
      // The warm read through Redis, the same for both encodings: one MGET of the chunks and the
      // decode. The whole cache read (manifest GET and LRU touch included) is reported beside it.
      const legacyKeys = years.map(
        (year) =>
          `${namespace}:security:${timingSecurity.id}:daily-state:${year}`,
      );
      await redis.mset(
        ...legacyKeys.flatMap((key, index) => [
          key,
          legacyPayloads[index] as string,
        ]),
      );
      const warmLegacy = await timed(REPEATS, async () =>
        legacyRead((await redis.mget(...legacyKeys)) as string[], coverage),
      );
      await redis.del(...legacyKeys);
      const columnarKeys = years.map((year) =>
        dailyStateChunkKey(namespace, timingSecurity.id, year),
      );
      const warmColumnar = await timed(REPEATS, async () => {
        const payloads = await redis.mget(...columnarKeys);
        return columnarRead(
          timingSecurity.id,
          years.map((year, index) => ({
            year,
            payload: payloads[index] as string,
          })),
          coverage,
        );
      });
      const warmCacheRead = await timed(REPEATS, () =>
        cache.readDailyDerivedState(timingSecurity.id, coverage),
      );
      if (
        JSON.stringify(warmColumnar.result) !==
          JSON.stringify(fullLegacy.result) ||
        JSON.stringify(warmCacheRead.result) !==
          JSON.stringify(fullLegacy.result)
      ) {
        throw new Error(
          "the two encodings disagree about the timing security's history",
        );
      }
      timing.security = timingSecurity.symbol;
      timing.rowsPerYear = yearRows.length;
      timing.years = years.length;
      timing.encodeYear = {
        legacy: encodeLegacy.stat,
        columnar: encodeColumnar.stat,
      };
      timing.decodeYear = {
        legacy: decodeLegacy.stat,
        columnar: decodeColumnar.stat,
      };
      timing.encodeFullHistory = {
        legacy: encodeAllLegacy.stat,
        columnar: encodeAllColumnar.stat,
      };
      timing.decodeFullHistory = {
        legacy: fullLegacy.stat,
        columnar: fullColumnar.stat,
      };
      timing.warmFullHistoryRead = {
        legacy: warmLegacy.stat,
        columnar: warmColumnar.stat,
      };
      timing.warmFullHistoryCacheRead = warmCacheRead.stat;
      timing.payloadBytes = {
        legacyYear: Buffer.byteLength(legacyYear),
        columnarYear: Buffer.byteLength(columnarYear),
        legacyFullHistory: legacyPayloads.reduce(
          (sum, payload) => sum + Buffer.byteLength(payload),
          0,
        ),
        columnarFullHistory: columnarPayloads.reduce(
          (sum, entry) => sum + Buffer.byteLength(entry.payload),
          0,
        ),
      };
      const keptRows = { legacy: 0, columnar: 0 };
      timing.allocation = {
        // Thirty full-history reads each way: once dropping every result at once (pure decode
        // garbage), once holding each read's rows until the next replaces them, as a caller that
        // uses its rows does.
        gcDuringThirtyFullHistoryDecodesDiscarded: {
          legacy: await gcDuring(() => {
            for (let repeat = 0; repeat < 30; repeat += 1)
              legacyRead(legacyPayloads, coverage);
          }),
          columnar: await gcDuring(() => {
            for (let repeat = 0; repeat < 30; repeat += 1) {
              columnarRead(timingSecurity.id, columnarPayloads, coverage);
            }
          }),
        },
        gcDuringThirtyFullHistoryDecodesKept: {
          legacy: await gcDuring(() => {
            let kept: DailyDerivedState[] = [];
            for (let repeat = 0; repeat < 30; repeat += 1) {
              kept = legacyRead(legacyPayloads, coverage);
            }
            keptRows.legacy = kept.length;
          }),
          columnar: await gcDuring(() => {
            let kept: DailyDerivedState[] = [];
            for (let repeat = 0; repeat < 30; repeat += 1) {
              kept = columnarRead(
                timingSecurity.id,
                columnarPayloads,
                coverage,
              );
            }
            keptRows.columnar = kept.length;
          }),
          rowsHeldByEachRead: keptRows,
        },
        retainedBytesPerFullHistoryRead: {
          legacy: retainedBytes(() => legacyRead(legacyPayloads, coverage)),
          columnar: retainedBytes(() =>
            columnarRead(timingSecurity.id, columnarPayloads, coverage),
          ),
          parsedColumnarChunksOnly: retainedBytes(() =>
            columnarPayloads.map(
              (entry) => JSON.parse(entry.payload) as unknown,
            ),
          ),
        },
      };
      console.log(
        `timing on ${timingSecurity.symbol}: ${JSON.stringify(timing.decodeFullHistory)}`,
      );
    }

    // ---- Warm product reads: Stock Details and backtest windows, with their command profile. ----
    const reads: Record<string, unknown> = {};
    const detailsSecurity = (catalog as Security[]).find(
      (entry) => entry.symbol === detailsSymbol,
    );
    if (detailsSecurity) {
      counting.reset();
      const details = await timed(REPEATS, () =>
        service.getDailyFundamentalMetric(
          detailsSecurity.symbol,
          "ROIC_TTM",
          period,
        ),
      );
      const detailsCommands = Object.fromEntries(
        [...counting.commands].map(([name, count]) => [name, count / REPEATS]),
      );
      reads.stockDetailsFundamental = {
        symbol: detailsSecurity.symbol,
        metric: "ROIC_TTM",
        sessions: details.result.length,
        withValue: details.result.filter((point) => point.value !== undefined)
          .length,
        responseBytes: Buffer.byteLength(JSON.stringify(details.result)),
        ...details.stat,
        commandsPerRead: detailsCommands,
      };
      const operandSets: Record<string, OperandKey[]> = {
        "0 Fundamentals": [
          PRICE_OPERAND,
          seriesOperand("SMA_50D"),
          seriesOperand("EMA_200D"),
        ],
        "1 Fundamental": [PRICE_OPERAND, fundamentalMetricOperand("ROIC_TTM")],
        "5 Fundamentals": [
          PRICE_OPERAND,
          ...FUNDAMENTAL_METRIC_IDS.slice(0, 5).map((id) =>
            fundamentalMetricOperand(id),
          ),
        ],
        "15 Fundamentals": [
          PRICE_OPERAND,
          ...FUNDAMENTAL_METRIC_IDS.map((id) => fundamentalMetricOperand(id)),
        ],
        mixed: [
          PRICE_OPERAND,
          seriesOperand("SMA_50D"),
          seriesOperand("RSI_14D"),
          relativeVolumeOperand(20),
          marginOfSafetyOperand("BALANCED"),
          seriesOperand("DCF_FCFF"),
          fundamentalMetricOperand("ROIC_TTM"),
          fundamentalMetricOperand("DEBT_TO_EQUITY"),
        ],
      };
      const windows = yearsInRange(period).map((year) => ({
        from:
          year === Number(period.from.slice(0, 4))
            ? period.from
            : `${year}-01-01`,
        to:
          year === Number(period.to.slice(0, 4)) ? period.to : `${year}-12-31`,
      }));
      const frames: Record<string, unknown> = {};
      for (const [name, operands] of Object.entries(operandSets)) {
        counting.reset();
        let frameRows = 0;
        const run = await timed(3, async () => {
          frameRows = 0;
          for (const window of windows) {
            const frame = await service.readDailyEvaluationFrame(
              detailsSecurity,
              window,
              operands,
            );
            frameRows += frame.dates.length;
          }
        });
        frames[name] = {
          windows: windows.length,
          frameRows,
          ...run.stat,
          commandsPerRun: Object.fromEntries(
            [...counting.commands].map(([command, count]) => [
              command,
              count / 3,
            ]),
          ),
        };
      }
      reads.backtestFrames = { symbol: detailsSecurity.symbol, ...frames };

      // A cold republish from PostgreSQL: the commands one full hydration issues.
      await cache.evict(detailsSecurity.id);
      counting.reset();
      const cold = await timed(1, () =>
        service.prepareDailyEvaluationData(detailsSecurity, period, []),
      );
      reads.coldRepublish = {
        symbol: detailsSecurity.symbol,
        ...cold.stat,
        commands: Object.fromEntries(counting.commands),
      };
      console.log(`reads: ${JSON.stringify(reads.stockDetailsFundamental)}`);
    }

    // ---- Synthetic worst cases over the full retention. -----------------------------------------
    // Every weekday of the retention a resident security carries: the product horizon plus its
    // warm-up years, back from the data clock.
    const syntheticDates = weekdays(
      subtractYears(asOf, priceRetentionYears(30)),
      asOf,
    );
    const synthetic: Record<string, unknown> = { rows: syntheticDates.length };
    for (const variant of ["realistic", "ceiling"] as const) {
      const rows = byYear(syntheticRows(syntheticDates, variant));
      const years = [...rows.keys()];
      const legacyEntries = years.map((year): [string, string] => [
        `${namespace}:security:${SYNTHETIC_SECURITY_ID}:daily-state:${year}`,
        JSON.stringify(rows.get(year)),
      ]);
      const columnarEntries = years.map((year): [string, string] => [
        dailyStateChunkKey(namespace, SYNTHETIC_SECURITY_ID, year),
        encodeDailyStateChunk(
          SYNTHETIC_SECURITY_ID,
          year,
          rows.get(year) ?? [],
        ),
      ]);
      for (const [index, year] of years.entries()) {
        const decoded = decodeDailyStateChunk(
          columnarEntries[index]?.[1] as string,
          {
            securityId: SYNTHETIC_SECURITY_ID,
            year,
          },
        );
        if (
          !decoded.ok ||
          JSON.stringify(decoded.rows) !== legacyEntries[index]?.[1]
        ) {
          throw new Error(`synthetic ${variant} ${year} does not round-trip`);
        }
      }
      const coverage = { from: syntheticDates[0] as string, to: asOf };
      synthetic[variant] = {
        legacy: await memoryOf(legacyEntries),
        columnar: await memoryOf(columnarEntries),
        valuation: {
          legacy: await memoryOf(
            years.map((year) => [
              `${namespace}:synthetic-valuation:legacy:${year}`,
              JSON.stringify(withValuation(rows.get(year) ?? [], year)),
            ]),
          ),
          columnar: await memoryOf(
            columnarEntries.map(([, payload], index) => [
              `${namespace}:synthetic-valuation:columnar:${years[index]}`,
              columnarWithValuation(
                payload,
                rows.get(years[index] as number)?.length ?? 0,
                years[index] as number,
              ),
            ]),
          ),
        },
        decodeFullHistory: {
          legacy: (
            await timed(REPEATS, () =>
              legacyRead(
                legacyEntries.map(([, payload]) => payload),
                coverage,
              ),
            )
          ).stat,
          columnar: (
            await timed(REPEATS, () =>
              columnarRead(
                SYNTHETIC_SECURITY_ID,
                columnarEntries.map(([, payload], index) => ({
                  year: years[index] as number,
                  payload,
                })),
                coverage,
              ),
            )
          ).stat,
        },
        encodeFullHistory: {
          legacy: (
            await timed(REPEATS, () =>
              years.map((year) => JSON.stringify(rows.get(year))),
            )
          ).stat,
          columnar: (
            await timed(REPEATS, () =>
              years.map((year) =>
                encodeDailyStateChunk(
                  SYNTHETIC_SECURITY_ID,
                  year,
                  rows.get(year) ?? [],
                ),
              ),
            )
          ).stat,
        },
      };
    }

    // ---- Capacity. ----------------------------------------------------------------------------
    const largestFamily = (family: string) =>
      Math.max(
        ...securities.map((entry) => entry.families[family]?.memory ?? 0),
      );
    const otherFamilies =
      largestFamily("prices") +
      largestFamily("financials") +
      largestFamily("registry") +
      largestFamily("manifest") +
      largestFamily("security");
    const worstCase = (dailyState: number) => ({
      perSecurity: dailyState + otherFamilies,
      at100: (dailyState + otherFamilies) * RESIDENT_LIMIT,
      residentsWithinBudget: Math.floor(
        BUDGET_BYTES / (dailyState + otherFamilies),
      ),
    });
    const realistic = synthetic.realistic as {
      legacy: Footprint;
      columnar: Footprint;
    };
    const ceiling = synthetic.ceiling as {
      legacy: Footprint;
      columnar: Footprint;
    };
    const before = securities.map((entry) => entry.memory.before);
    const after = securities.map((entry) => entry.memory.after);
    const fingerprintAfter = await fingerprint();
    if (
      JSON.stringify(fingerprintAfter) !== JSON.stringify(fingerprintBefore)
    ) {
      throw new Error(
        `the benchmark changed the derived rows of the frozen copy: ${JSON.stringify(fingerprintBefore)} → ${JSON.stringify(fingerprintAfter)}`,
      );
    }
    const report = {
      generatedAt: new Date().toISOString(),
      machineSpecific:
        "Timings and Redis memory were measured on the machine below. Byte counts and ratios " +
        "reproduce anywhere; absolute timings do not.",
      environment: {
        gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
          .toString()
          .trim(),
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        cpu: cpus()[0]?.model,
        cpuCount: cpus().length,
        memoryBytes: totalmem(),
        redis: (await redis.info("server")).match(/redis_version:(\S+)/)?.[1],
        allocator: (await redis.info("memory")).match(
          /mem_allocator:(\S+)/,
        )?.[1],
        database: environment.databaseName,
        asOf,
      },
      encodingVersion: DAILY_STATE_ENCODING_VERSION,
      derivedStateRevision: DERIVED_STATE_REVISION,
      providerCalls,
      postgresDerivedRows: {
        before: fingerprintBefore,
        after: fingerprintAfter,
      },
      securities,
      realWorld: {
        securities: securities.length,
        rows: securities.reduce((sum, entry) => sum + entry.rows, 0),
        parityMismatches: securities.reduce(
          (sum, entry) => sum + entry.parityMismatches,
          0,
        ),
        memoryPerSecurity: {
          before: summarize(before),
          after: summarize(after),
        },
        dailyStatePayloadTotal: {
          before: securities.reduce(
            (sum, entry) => sum + entry.dailyState.legacy.payload,
            0,
          ),
          after: securities.reduce(
            (sum, entry) => sum + entry.dailyState.columnar.payload,
            0,
          ),
        },
        dailyStateMemoryTotal: {
          before: securities.reduce(
            (sum, entry) => sum + entry.dailyState.legacy.memory,
            0,
          ),
          after: securities.reduce(
            (sum, entry) => sum + entry.dailyState.columnar.memory,
            0,
          ),
        },
        largest: {
          before: largestBy((entry) => entry.memory.before).symbol,
          after: largestBy((entry) => entry.memory.after).symbol,
        },
        keysPerSecurity: summarize(securities.map((entry) => entry.keys)),
        at100: {
          before: median(before) * RESIDENT_LIMIT,
          after: median(after) * RESIDENT_LIMIT,
        },
        at100Max: {
          before: Math.max(...before) * RESIDENT_LIMIT,
          after: Math.max(...after) * RESIDENT_LIMIT,
        },
      },
      synthetic,
      capacity: {
        budgetBytes: BUDGET_BYTES,
        residentLimit: RESIDENT_LIMIT,
        otherFamiliesAtTheirLargest: otherFamilies,
        before: worstCase(realistic.legacy.memory),
        afterRealisticWorstCase: worstCase(realistic.columnar.memory),
        afterCeiling: worstCase(ceiling.columnar.memory),
        realMaximumBefore: Math.max(...before),
        realMaximumAfter: Math.max(...after),
      },
      valuationSimulation: {
        columns: VALUATION_FIELDS,
        note: "Benchmark-only: four daily-changing numeric columns appended to real and synthetic chunks.",
        realIncrementPerSecurity: {
          legacy: summarize(
            securities.map((entry) => entry.valuation.legacyIncrement),
          ),
          columnar: summarize(
            securities.map((entry) => entry.valuation.columnarIncrement),
          ),
        },
      },
      timing,
      reads,
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nwrote ${out}`);
    console.log(
      `real per-security memory (median): ${(median(before) / 1_048_576).toFixed(2)} → ${(median(after) / 1_048_576).toFixed(2)} MiB; ` +
        `max ${(Math.max(...before) / 1_048_576).toFixed(2)} → ${(Math.max(...after) / 1_048_576).toFixed(2)} MiB; ` +
        `provider calls ${providerCalls.length}; parity mismatches ${report.realWorld.parityMismatches}`,
    );
  } finally {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${namespace}:*`,
        "COUNT",
        1_000,
      );
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
    redis.disconnect();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
