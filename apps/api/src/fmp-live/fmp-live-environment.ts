import {
  LIVE_FMP_API_KEY_ENV,
  LIVE_FMP_HYDRATION_OPT_IN_ENV,
  LIVE_FMP_HYDRATION_OPT_IN_VALUE,
  isPlaceholderFmpKey,
  liveFmpHydrationEnabled,
} from "@intrinsic/testing";
import { redactDatabaseUrl } from "../qa/qa-persona-environment";

/**
 * Who may start a live run, where it may write, and what the process that performs it receives.
 *
 * Three separate questions, answered here and nowhere else, and none of them by opening anything:
 *
 * 1. **Authorization.** `RUN_LIVE_FMP_HYDRATION=1`, set for this invocation, is the only thing
 *    that authorizes a run. A credential being present authorizes nothing — the key is not even
 *    looked for until the opt-in and the command line have both been accepted.
 * 2. **Target.** Real provider data goes into the local development database and the local Redis,
 *    and nowhere else: not production, not another machine, and not the test or matrix databases,
 *    whose contents are deterministic fixtures a real payload would silently corrupt.
 * 3. **Environment.** The process that talks to the provider is a child started with an
 *    allowlisted environment (`liveFmpChildEnvironment`). It is the only process in which the
 *    credential exists under the name the application reads.
 */

type Environment = Readonly<Record<string, string | undefined>>;

/** A refusal at the live-run boundary. Its message never carries a credential. */
export class LiveFmpEnvironmentError extends Error {
  override readonly name = "LiveFmpEnvironmentError";
}

/** Carries the run's identity from the launcher to the child, and names its budget counter. */
export const LIVE_FMP_RUN_ID_ENV = "LIVE_FMP_RUN_ID";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Databases a provider payload must never reach, by name: the test database and the QA matrix
 * copy. The same rule, for the same reason, as `assertResyncTargetAllowed`.
 */
const FIXTURE_DATABASE_NAME = /matrix|test/i;

/** Variables that name a fixture database outright, whatever it is called. */
const FIXTURE_DATABASE_VARIABLES = [
  "TEST_DATABASE_URL",
  "QA_MATRIX_DATABASE_URL",
] as const;

function assertNotProduction(env: Environment): void {
  if (env.NODE_ENV?.trim() === "production") {
    throw new LiveFmpEnvironmentError(
      "Refusing a live FMP run: NODE_ENV is production. This command writes provider data " +
        "through a development-only path and may never run against a production deployment.",
    );
  }
}

/** Refuses unless this invocation opted in. Checked before a credential is read. */
export function assertLiveFmpOptIn(env: Environment = process.env): void {
  if (!liveFmpHydrationEnabled(env as NodeJS.ProcessEnv)) {
    throw new LiveFmpEnvironmentError(
      `A live FMP run needs ${LIVE_FMP_HYDRATION_OPT_IN_ENV}=${LIVE_FMP_HYDRATION_OPT_IN_VALUE} ` +
        "set for this command. Nothing else authorizes one: a configured key does not, and " +
        "neither does RUN_LIVE_FMP_TESTS.",
    );
  }
}

function parseUrl(variable: string, raw: string | undefined): URL {
  const value = raw?.trim();
  if (!value) {
    throw new LiveFmpEnvironmentError(`A live FMP run needs ${variable}.`);
  }
  try {
    return new URL(value);
  } catch {
    throw new LiveFmpEnvironmentError(`${variable} is not a valid URL.`);
  }
}

export type LiveFmpTarget = {
  readonly databaseUrl: string;
  /** Printed so the operator sees where the data is going. */
  readonly databaseName: string;
  readonly databaseHost: string;
  readonly redisUrl: string;
  readonly redisHost: string;
};

/**
 * The one database and the one Redis a live run may write to, or a refusal.
 *
 * Both must be on this machine, with no override: a remote target is refused rather than
 * confirmed, because a development tool has no business deciding that a remote database is
 * disposable. A production database tunnelled to a loopback port is the one thing a host check
 * cannot see; `NODE_ENV` and the operator are what stand in front of that.
 */
export function resolveLiveFmpTarget(
  env: Environment = process.env,
): LiveFmpTarget {
  assertNotProduction(env);

  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  const database = parseUrl("DATABASE_URL", databaseUrl);
  if (
    database.protocol !== "postgresql:" &&
    database.protocol !== "postgres:"
  ) {
    throw new LiveFmpEnvironmentError(
      "DATABASE_URL must be a postgresql:// URL.",
    );
  }
  const databaseName = decodeURIComponent(database.pathname.replace(/^\//, ""));
  if (!databaseName) {
    throw new LiveFmpEnvironmentError("DATABASE_URL names no database.");
  }
  if (!LOOPBACK_HOSTS.has(database.hostname)) {
    throw new LiveFmpEnvironmentError(
      `Refusing a live FMP run against \`${redactDatabaseUrl(databaseUrl)}\`: ` +
        `\`${database.hostname}\` is not this machine. Provider data is written to a local ` +
        "development database only.",
    );
  }
  if (FIXTURE_DATABASE_NAME.test(databaseName)) {
    throw new LiveFmpEnvironmentError(
      `Refusing a live FMP run against \`${databaseName}\`. The test and matrix databases hold ` +
        "deterministic fixtures, and a real provider payload in either of them is a defect. " +
        "Point DATABASE_URL at the development database.",
    );
  }
  for (const variable of FIXTURE_DATABASE_VARIABLES) {
    if (env[variable]?.trim() === databaseUrl) {
      throw new LiveFmpEnvironmentError(
        `Refusing a live FMP run: DATABASE_URL names the same database as ${variable}.`,
      );
    }
  }

  const redisUrl = env.REDIS_URL?.trim() ?? "";
  const redis = parseUrl("REDIS_URL", redisUrl);
  if (redis.protocol !== "redis:" && redis.protocol !== "rediss:") {
    throw new LiveFmpEnvironmentError("REDIS_URL must be a redis:// URL.");
  }
  if (!LOOPBACK_HOSTS.has(redis.hostname)) {
    throw new LiveFmpEnvironmentError(
      `Refusing a live FMP run: REDIS_URL points at \`${redis.hostname}\`, which is not this ` +
        "machine.",
    );
  }

  return {
    databaseUrl,
    databaseName,
    databaseHost: database.hostname,
    redisUrl,
    redisHost: redis.hostname,
  };
}

/**
 * The live credential, from `LIVE_FMP_API_KEY` and from nowhere else.
 *
 * It asserts the opt-in itself, so no caller can obtain the key for a run nobody authorized.
 * `FMP_API_KEY` is deliberately not a fallback: a developer's ordinary key being present is not a
 * decision to spend it on this, and falling back would turn the absence of a deliberately
 * provisioned credential into a quiet success.
 */
export function resolveLiveFmpKey(env: Environment = process.env): string {
  assertLiveFmpOptIn(env);
  const key = env[LIVE_FMP_API_KEY_ENV]?.trim();
  if (isPlaceholderFmpKey(key)) {
    throw new LiveFmpEnvironmentError(
      `${LIVE_FMP_API_KEY_ENV} is not set to a real key. A live FMP run uses that variable ` +
        "only; FMP_API_KEY is never a substitute. Without it there is nothing to run: use " +
        "--plan to see what a run would ask.",
    );
  }
  return key as string;
}

/**
 * What the child inherits from the launcher: how to run a process, and the configuration the
 * loaders it composes actually read. An allowlist, so a variable added to a developer's `.env` or
 * to a cloud environment tomorrow is withheld without anybody remembering to list it.
 */
export const LIVE_FMP_CHILD_INHERITED_VARIABLES: readonly string[] = [
  // Running a process at all.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
  // The application's own mode and verbosity.
  "NODE_ENV",
  "LOG_LEVEL",
  // The two local stores the run writes to (`resolveLiveFmpTarget` has already vetted them).
  "DATABASE_URL",
  "REDIS_URL",
  // `getFmpTrafficConfig`: the shared gate's sizing and the client's retry policy.
  "FMP_TIMEOUT_MS",
  "FMP_MAX_RETRIES",
  "FMP_RETRY_BASE_DELAY_MS",
  "FMP_RETRY_MAX_DELAY_MS",
  "FMP_MAX_RETRY_WAIT_MS",
  "FMP_MAX_CONCURRENT_REQUESTS",
  "FMP_RATE_LIMIT_PER_WINDOW",
  "FMP_RATE_WINDOW_MS",
  "FMP_MAX_QUEUE_DEPTH",
  "FMP_MAX_QUEUE_WAIT_MS",
  // `getStockDataConfig`: horizons, freshness and the hydration lock.
  "STOCK_CACHE_MAX_RESIDENT_STOCKS",
  "STOCK_CACHE_MAX_RESIDENT_SYMBOLS",
  "STOCK_DETAILS_HISTORY_DAYS",
  "STOCK_HISTORY_YEARS",
  "STOCK_RECENT_PRICE_FRESHNESS_MS",
  "STOCK_FUNDAMENTALS_FRESHNESS_MS",
  "STOCK_RECENT_TAIL_CALENDAR_DAYS",
  "STOCK_DATA_LOAD_LOCK_MS",
  "STOCK_DATA_LOCK_WAIT_MS",
  // `getAlternativeDataConfig`.
  "ALT_DATA_FRESHNESS_MS",
  "ALT_DATA_MAX_PAGES_PER_INGEST",
];

export type LiveFmpChildEnvironmentInput = {
  /** The launcher's own environment, after it loaded the root `.env`. */
  readonly parentEnvironment: Environment;
  /** The live credential, or `null` for a plan, which never reaches the provider. */
  readonly key: string | null;
  readonly runId: string;
};

/**
 * The **whole** environment of the process that performs a live run.
 *
 * Built from the allowlist, never by copying the launcher's environment and removing things. On
 * top of it:
 *
 * - `FMP_API_KEY` is the live credential — the mapping from `LIVE_FMP_API_KEY` happens here, into
 *   this one child, and the cloud-only name itself is not passed on;
 * - the opt-in is restated, so the child re-checks it rather than trusting that it was launched
 *   correctly;
 * - `FMP_BASE_URL` is never present, so "live" cannot quietly mean a fixture server.
 *
 * A plan gets neither the key nor the opt-in: it cannot reach the provider even by mistake.
 */
export function liveFmpChildEnvironment(
  input: LiveFmpChildEnvironmentInput,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of LIVE_FMP_CHILD_INHERITED_VARIABLES) {
    const value = input.parentEnvironment[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  environment[LIVE_FMP_RUN_ID_ENV] = input.runId;
  if (input.key !== null) {
    environment.FMP_API_KEY = input.key;
    environment[LIVE_FMP_HYDRATION_OPT_IN_ENV] =
      LIVE_FMP_HYDRATION_OPT_IN_VALUE;
  }
  return environment;
}

/**
 * What the child itself requires of the environment it was started in.
 *
 * The launcher has already checked all of it. It is checked again because the child is a file
 * somebody can run directly, and the guards must hold for whoever starts it:
 *
 * - a real run needs the opt-in and a real key; a plan must have neither a key nor the cloud-only
 *   variable in its environment;
 * - `FMP_BASE_URL` must be unset;
 * - the target is resolved again from this process's own environment.
 */
export function assertLiveFmpChildEnvironment(
  env: Environment,
  mode: { readonly plan: boolean },
): { readonly target: LiveFmpTarget; readonly runId: string } {
  const target = resolveLiveFmpTarget(env);
  if (env.FMP_BASE_URL?.trim()) {
    throw new LiveFmpEnvironmentError(
      "Refusing a live FMP run: FMP_BASE_URL is set. A live run talks to the provider's own " +
        "endpoint and to nothing else.",
    );
  }
  if (env[LIVE_FMP_API_KEY_ENV]?.trim()) {
    throw new LiveFmpEnvironmentError(
      `${LIVE_FMP_API_KEY_ENV} reached the process that performs the run. Start it through ` +
        "`pnpm fmp:live`, which maps the credential for this process and withholds the rest.",
    );
  }
  if (mode.plan) {
    if (env.FMP_API_KEY?.trim()) {
      throw new LiveFmpEnvironmentError(
        "A plan sends nothing and must not hold a provider credential; FMP_API_KEY is set.",
      );
    }
  } else {
    assertLiveFmpOptIn(env);
    if (isPlaceholderFmpKey(env.FMP_API_KEY)) {
      throw new LiveFmpEnvironmentError(
        "The live run was started without a real provider credential.",
      );
    }
  }
  const runId = env[LIVE_FMP_RUN_ID_ENV]?.trim();
  if (!runId) {
    throw new LiveFmpEnvironmentError(
      `${LIVE_FMP_RUN_ID_ENV} is missing: start the run through \`pnpm fmp:live\`.`,
    );
  }
  return { target, runId };
}
