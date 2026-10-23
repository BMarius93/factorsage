import { SYNTHETIC_FMP_API_KEY } from "./synthetic-fmp";

/**
 * The isolated environment the scale benchmark runs in, and the guard that keeps it isolated
 * (`docs/production/benchmarks.md`, "Isolation").
 *
 * The benchmark writes thousands of synthetic securities, flushes Redis between measurements and
 * deletes its own fixtures, so it must never be pointed at a database or a Redis keyspace that holds
 * anything else. It therefore refuses to start unless:
 *
 * - `BENCH_DATABASE_URL` names a database whose name ends in `_bench`, distinct from `DATABASE_URL`
 *   and `TEST_DATABASE_URL`;
 * - `BENCH_REDIS_URL` names a numbered Redis database other than 0, distinct from `REDIS_URL`;
 * - the provider is the synthetic one on loopback (`BENCH_FMP_URL`, default port 4790) with the
 *   synthetic key — a real provider key is never passed to anything this benchmark starts.
 *
 * Every process it starts gets exactly {@link benchProcessEnvironment}: the developer's environment
 * with these replaced, so a stray `.env` value cannot reach the provider or the development data.
 */

export type BenchEnvironment = {
  readonly databaseUrl: string;
  readonly databaseName: string;
  readonly redisUrl: string;
  readonly redisDatabase: number;
  readonly fmpBaseUrl: string;
};

export function benchEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BenchEnvironment {
  const databaseUrl = env.BENCH_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "BENCH_DATABASE_URL is required: the scale benchmark runs only against its own database (…/intrinsic_value_bench)",
    );
  }
  const database = new URL(databaseUrl);
  const databaseName = database.pathname.replace(/^\//, "");
  if (!databaseName.endsWith("_bench")) {
    throw new Error(
      `BENCH_DATABASE_URL must name a database ending in _bench (got '${databaseName}')`,
    );
  }
  for (const other of ["DATABASE_URL", "TEST_DATABASE_URL"] as const) {
    const value = env[other]?.trim();
    if (value && sameDatabase(value, databaseUrl)) {
      throw new Error(`BENCH_DATABASE_URL must not be ${other}`);
    }
  }

  const redisUrl = env.BENCH_REDIS_URL?.trim();
  if (!redisUrl) {
    throw new Error(
      "BENCH_REDIS_URL is required: a numbered Redis database of its own, e.g. redis://localhost:6379/5",
    );
  }
  const redisDatabase = Number(new URL(redisUrl).pathname.replace(/^\//, "") || "0");
  if (!Number.isInteger(redisDatabase) || redisDatabase < 1) {
    throw new Error("BENCH_REDIS_URL must select a Redis database other than 0");
  }
  const developerRedis = env.REDIS_URL?.trim();
  if (developerRedis && normalizedRedis(developerRedis) === normalizedRedis(redisUrl)) {
    throw new Error("BENCH_REDIS_URL must not be REDIS_URL");
  }

  const fmpBaseUrl = env.BENCH_FMP_URL?.trim() || "http://127.0.0.1:4790/stable/";
  const fmp = new URL(fmpBaseUrl);
  if (fmp.hostname !== "127.0.0.1" && fmp.hostname !== "localhost") {
    throw new Error("BENCH_FMP_URL must be the loopback synthetic provider");
  }
  return {
    databaseUrl,
    databaseName,
    redisUrl,
    redisDatabase,
    fmpBaseUrl: fmpBaseUrl.endsWith("/") ? fmpBaseUrl : `${fmpBaseUrl}/`,
  };
}

/** Names whose values never reach a benchmark process: credentials and live-provider opt-ins. */
const NEVER_INHERITED = /^(FMP_API_KEY|RUN_LIVE_FMP_HYDRATION|STRIPE_|SANDBOX_STRIPE_|E2E_.*PASSWORD|QA_.*PASSWORD)/;

/**
 * The environment of every process the benchmark starts (and of its own Nest context): the
 * isolated database, Redis and synthetic provider, the benchmark's settings, and nothing secret.
 */
export function benchProcessEnvironment(
  bench: BenchEnvironment,
  overrides: Readonly<Record<string, string>> = {},
  parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && !NEVER_INHERITED.test(name)) {
      inherited[name] = value;
    }
  }
  return {
    ...inherited,
    NODE_ENV: "development",
    DATABASE_URL: bench.databaseUrl,
    REDIS_URL: bench.redisUrl,
    FMP_BASE_URL: bench.fmpBaseUrl,
    FMP_API_KEY: SYNTHETIC_FMP_API_KEY,
    // The deployment's sizing, as the production configuration sets it.
    STOCK_LRU_MAX_SECURITIES: "500",
    BACKTEST_GLOBAL_MAX_RUNNING: "4",
    ...overrides,
  };
}

function sameDatabase(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.host === b.host && a.pathname === b.pathname;
  } catch {
    return left === right;
  }
}

function normalizedRedis(value: string): string {
  const url = new URL(value);
  return `${url.hostname}:${url.port || "6379"}/${url.pathname.replace(/^\//, "") || "0"}`;
}
