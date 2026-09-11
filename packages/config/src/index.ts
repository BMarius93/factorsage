import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";

export type RuntimeEnvironment = "development" | "test" | "production";
export type LogLevel =
  "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

type Environment = NodeJS.ProcessEnv;

function optional(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function required(env: Environment, name: string): string {
  const value = optional(env, name);
  if (!value) {
    throw new Error(`Invalid application configuration: ${name} is required`);
  }
  return value;
}

function integer(env: Environment, names: string[], fallback: number): number {
  const raw = names.map((name) => optional(env, name)).find(Boolean);
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Invalid application configuration: ${names.join("/")} must be a positive integer`,
    );
  }
  return value;
}

/**
 * Upper bound on forked backtest workers. Beyond this the processes contend for the same
 * PostgreSQL, Redis and FMP budgets instead of adding throughput, so an obvious typo
 * (`BACKTEST_WORKER_PROCESSES=200`) is rejected at startup rather than at exhaustion.
 */
const MAX_BACKTEST_WORKER_PROCESSES = 32;

function runtimeEnvironment(env: Environment): RuntimeEnvironment {
  const value = optional(env, "NODE_ENV") ?? "development";
  if (value === "development" || value === "test" || value === "production") {
    return value;
  }
  throw new Error(
    "Invalid application configuration: NODE_ENV must be development, test, or production",
  );
}

function logLevel(env: Environment): LogLevel {
  const value = optional(env, "LOG_LEVEL") ?? "info";
  const allowed: LogLevel[] = [
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "silent",
  ];
  if (allowed.includes(value as LogLevel)) {
    return value as LogLevel;
  }
  throw new Error(
    `Invalid application configuration: unsupported LOG_LEVEL '${value}'`,
  );
}

function commaSeparated(
  value: string | undefined,
  fallback: string[],
): string[] {
  if (!value) {
    return fallback;
  }
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : fallback;
}

function boolean(env: Environment, name: string, fallback: boolean): boolean {
  const raw = optional(env, name);
  if (raw === undefined) {
    return fallback;
  }

  const normalized = raw.toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new Error(
    `Invalid application configuration: ${name} must be true or false`,
  );
}

/** Parses an absolute http(s) URL and returns it without a trailing slash. */
function absoluteUrl(
  env: Environment,
  name: string,
  fallback?: string,
): string {
  const raw = optional(env, name) ?? fallback;
  if (raw === undefined) {
    throw new Error(`Invalid application configuration: ${name} is required`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `Invalid application configuration: ${name} must be an absolute URL`,
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Invalid application configuration: ${name} must be an http or https URL`,
    );
  }

  return url.toString().replace(/\/$/, "");
}

function corsOrigins(env: Environment): string[] {
  const values = commaSeparated(optional(env, "CORS_ORIGINS"), [
    "http://localhost:3000",
  ]);

  return values.map((value) => {
    if (value === "*") {
      throw new Error(
        "Invalid application configuration: CORS_ORIGINS cannot contain '*' when credentials are enabled",
      );
    }

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(
        `Invalid application configuration: CORS_ORIGINS contains invalid origin '${value}'`,
      );
    }

    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        `Invalid application configuration: CORS_ORIGINS contains invalid origin '${value}'`,
      );
    }

    return url.origin;
  });
}

/**
 * The repository root — the directory holding `pnpm-workspace.yaml` — or null outside a checkout.
 *
 * Package scripts run with the cwd set to the package, so anything that must land in one shared
 * place per checkout (the root `.env`, a developer artifact directory) resolves against this rather
 * than against `process.cwd()`.
 */
export function findWorkspaceRoot(
  startDirectory = process.cwd(),
): string | null {
  let directory = resolve(startDirectory);

  while (true) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) {
      return directory;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

/**
 * Loads the single repository-root .env file when it exists.
 *
 * Local development uses this file. Deployed environments normally do not
 * contain it; the platform injects the same variables into process.env.
 */
export function loadRootEnv(
  startDirectory = process.cwd(),
): string | undefined {
  const root = findWorkspaceRoot(startDirectory);
  if (root === null) {
    return undefined;
  }
  const envFile = join(root, ".env");
  if (!existsSync(envFile)) {
    return undefined;
  }
  loadEnvFile(envFile);
  return envFile;
}

export function getAppConfig(env: Environment = process.env) {
  return {
    environment: runtimeEnvironment(env),
    logLevel: logLevel(env),
  } as const;
}

export function getApiConfig(env: Environment = process.env) {
  return {
    ...getAppConfig(env),
    port: integer(env, ["PORT", "API_PORT"], 3001),
    corsOrigins: corsOrigins(env),
  } as const;
}

/**
 * Absolute base URL of the web application.
 *
 * The API builds user-facing links (email-verification links, post-OAuth redirects) against
 * this value rather than trusting a request `Host` header.
 */
export function getWebBaseUrl(env: Environment = process.env): string {
  return absoluteUrl(env, "WEB_BASE_URL", "http://localhost:3000");
}

export function getAuthConfig(env: Environment = process.env) {
  const environment = runtimeEnvironment(env);
  const jwtSecret = required(env, "AUTH_JWT_SECRET");

  if (jwtSecret.length < 32) {
    throw new Error(
      "Invalid application configuration: AUTH_JWT_SECRET must be at least 32 characters",
    );
  }

  return {
    jwtSecret,
    tokenTtlSeconds: integer(env, ["AUTH_TOKEN_TTL_SECONDS"], 8 * 60 * 60),
    emailVerificationTtlSeconds: integer(
      env,
      ["AUTH_EMAIL_VERIFICATION_TTL_SECONDS"],
      24 * 60 * 60,
    ),
    cookieName: optional(env, "AUTH_COOKIE_NAME") ?? "intrinsic_auth",
    cookieSecure: environment === "production",
    cookieSameSite: "lax" as const,
    webBaseUrl: getWebBaseUrl(env),
  } as const;
}

export type GoogleOAuthConfig = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUrl: string;
};

/**
 * Server-only Google identity configuration. Never expose this object to browser code.
 *
 * Google sign-in is optional, so a completely unset configuration returns `null` and the API
 * simply does not offer the provider. A partially configured provider is always a mistake and
 * is rejected rather than silently disabled, because it would fail only at the callback.
 */
export function getGoogleOAuthConfig(
  env: Environment = process.env,
): GoogleOAuthConfig | null {
  const clientId = optional(env, "GOOGLE_CLIENT_ID");
  const clientSecret = optional(env, "GOOGLE_CLIENT_SECRET");
  const callbackUrl = optional(env, "GOOGLE_CALLBACK_URL");

  const provided = [clientId, clientSecret, callbackUrl].filter(Boolean).length;
  if (provided === 0) {
    return null;
  }
  if (provided < 3) {
    throw new Error(
      "Invalid application configuration: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and " +
        "GOOGLE_CALLBACK_URL must be set together",
    );
  }

  return {
    clientId: clientId as string,
    clientSecret: clientSecret as string,
    callbackUrl: absoluteUrl(env, "GOOGLE_CALLBACK_URL"),
  } as const;
}

export type SmtpConfig = {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly from: string;
  /** Null for unauthenticated local/test SMTP such as Mailpit. */
  readonly auth: { readonly user: string; readonly password: string } | null;
};

/**
 * Server-only SMTP configuration. Never expose this object to browser code.
 *
 * Outbound email is optional infrastructure: with nothing configured this returns `null` and the
 * API reports the email boundary as unavailable instead of failing at startup. When it is
 * configured, `SMTP_HOST` and `SMTP_FROM` are mandatory and credentials are all-or-nothing, so a
 * local unauthenticated relay stays valid while a half-configured production relay is rejected.
 */
export function getSmtpConfig(
  env: Environment = process.env,
): SmtpConfig | null {
  const host = optional(env, "SMTP_HOST");
  const from = optional(env, "SMTP_FROM");
  const user = optional(env, "SMTP_USER");
  const password = optional(env, "SMTP_PASSWORD");
  const portRaw = optional(env, "SMTP_PORT");
  const secureRaw = optional(env, "SMTP_SECURE");

  const anyProvided = [host, from, user, password, portRaw, secureRaw].some(
    Boolean,
  );
  if (!anyProvided) {
    return null;
  }

  if (!host || !from) {
    throw new Error(
      "Invalid application configuration: SMTP_HOST and SMTP_FROM are required when any " +
        "SMTP_* variable is set",
    );
  }

  if (Boolean(user) !== Boolean(password)) {
    throw new Error(
      "Invalid application configuration: SMTP_USER and SMTP_PASSWORD must be set together",
    );
  }

  const port = integer(env, ["SMTP_PORT"], 587);
  if (port > 65_535) {
    throw new Error(
      "Invalid application configuration: SMTP_PORT must be a valid port number",
    );
  }

  return {
    host,
    port,
    // Implicit TLS is the norm on 465 and STARTTLS elsewhere; SMTP_SECURE overrides explicitly.
    secure: boolean(env, "SMTP_SECURE", port === 465),
    from,
    auth: user && password ? { user, password } : null,
  } as const;
}

/**
 * Credentials for the two persistent QA personas used by Playwright and live smoke testing.
 *
 * Required only while running the QA seed command; the application never reads it.
 */
export function getQaPersonaConfig(env: Environment = process.env) {
  function persona(role: "USER" | "ADMIN") {
    const emailName = `QA_${role}_EMAIL`;
    const passwordName = `QA_${role}_PASSWORD`;
    const password = required(env, passwordName);

    if (password.length < 12) {
      throw new Error(
        `Invalid application configuration: ${passwordName} must be at least 12 characters`,
      );
    }

    return { email: required(env, emailName), password, role } as const;
  }

  return { user: persona("USER"), admin: persona("ADMIN") } as const;
}

export function getAdminBootstrapConfig(env: Environment = process.env) {
  const password = required(env, "ADMIN_PASSWORD");

  if (password.length < 12) {
    throw new Error(
      "Invalid application configuration: ADMIN_PASSWORD must be at least 12 characters",
    );
  }

  return {
    email: required(env, "ADMIN_EMAIL"),
    password,
  } as const;
}

export function getWorkerConfig(env: Environment = process.env) {
  return {
    ...getAppConfig(env),
  } as const;
}

/**
 * Durable backtest execution settings, read once per worker process.
 *
 * `processes` is how many OS processes claim jobs; each executes at most one backtest at a time
 * and one simulation is never split across them, so raising it buys throughput across independent
 * runs, never speed on a single run. The default is deliberately small because a laptop normally
 * runs PostgreSQL, Redis, the API and the web app beside it.
 *
 * The lease/heartbeat pair is what makes a crashed worker self-healing: a claim is held only as
 * long as it is renewed, and an expired lease is reclaimable. Keep the heartbeat interval well
 * under the lease so a slow database round trip does not cost a worker its job.
 */
export function getBacktestWorkerConfig(env: Environment = process.env) {
  const processes = integer(env, ["BACKTEST_WORKER_PROCESSES"], 2);
  if (processes > MAX_BACKTEST_WORKER_PROCESSES) {
    throw new Error(
      "Invalid application configuration: BACKTEST_WORKER_PROCESSES must be between 1 and " +
        `${MAX_BACKTEST_WORKER_PROCESSES}`,
    );
  }

  return {
    processes,
    pollIntervalMs: integer(env, ["BACKTEST_JOB_POLL_INTERVAL_MS"], 1_000),
    leaseMs: integer(env, ["BACKTEST_JOB_LEASE_MS"], 60_000),
    heartbeatIntervalMs: integer(
      env,
      ["BACKTEST_JOB_HEARTBEAT_INTERVAL_MS"],
      15_000,
    ),
    maxAttempts: integer(env, ["BACKTEST_JOB_MAX_ATTEMPTS"], 3),
    retryBackoffMs: integer(env, ["BACKTEST_JOB_RETRY_BACKOFF_MS"], 15_000),
    checkpointEveryDays: integer(env, ["BACKTEST_CHECKPOINT_EVERY_DAYS"], 5),
    checkpointMinIntervalMs: integer(
      env,
      ["BACKTEST_CHECKPOINT_MIN_INTERVAL_MS"],
      1_000,
    ),
    frameConcurrency: integer(env, ["BACKTEST_FRAME_LOAD_CONCURRENCY"], 4),
  } as const;
}

/**
 * Upper bound on forked monitor workers.
 *
 * A Monitor cycle is claimed as a singleton, so extra processes buy availability — another one
 * picks the cycle up when a worker dies — never throughput. More than a handful is a typo.
 */
const MAX_MONITOR_WORKER_PROCESSES = 8;

/**
 * The Monitor evaluation worker.
 *
 * Cadence is an application decision and deliberately not user-configurable
 * (`ai/product/monitors.md`), so it lives here beside the other infrastructure knobs.
 *
 * `MONITOR_SCAN_INTERVAL_MS` is the gap between the end of one cycle and the earliest start of the
 * next, not a fixed period: a cycle that takes longer than the interval simply delays the next one
 * instead of overlapping with it.
 *
 * `MONITOR_QUOTE_MAX_AGE_MS` is how stale a provider quote may be and still be used as the
 * provisional current observation. Beyond it the symbol is `NOT_EVALUABLE` for that cycle: a stale
 * quote presented as the current observation would be a fabricated bar, and leaving the durable
 * latch untouched is what keeps an outage from resolving and re-emitting live matches. The default
 * spans a long weekend plus a public holiday, so an ordinary market closure still evaluates against
 * the last real quote rather than silently stopping every night.
 */
export function getMonitorWorkerConfig(env: Environment = process.env) {
  const processes = Number(optional(env, "MONITOR_WORKER_PROCESSES") ?? "1");
  if (
    !Number.isInteger(processes) ||
    processes < 0 ||
    processes > MAX_MONITOR_WORKER_PROCESSES
  ) {
    throw new Error(
      "Invalid application configuration: MONITOR_WORKER_PROCESSES must be between 0 and " +
        `${MAX_MONITOR_WORKER_PROCESSES}`,
    );
  }

  return {
    /** `0` disables Monitor scanning in this process entirely. */
    processes,
    scanIntervalMs: integer(env, ["MONITOR_SCAN_INTERVAL_MS"], 5 * 60_000),
    pollIntervalMs: integer(env, ["MONITOR_SCAN_POLL_INTERVAL_MS"], 5_000),
    leaseMs: integer(env, ["MONITOR_SCAN_LEASE_MS"], 120_000),
    heartbeatIntervalMs: integer(
      env,
      ["MONITOR_SCAN_HEARTBEAT_INTERVAL_MS"],
      30_000,
    ),
    retryBackoffMs: integer(env, ["MONITOR_SCAN_RETRY_BACKOFF_MS"], 60_000),
    symbolConcurrency: integer(env, ["MONITOR_SYMBOL_CONCURRENCY"], 4),
    quoteMaxAgeMs: integer(env, ["MONITOR_QUOTE_MAX_AGE_MS"], 4 * 24 * 60 * 60_000),
  } as const;
}

/**
 * Forensic debug archives — a **developer** capture, off unless explicitly asked for.
 *
 * `full` makes a worker write one self-contained archive per backtest attempt: the immutable
 * snapshot, the execution calendar, the benchmark input, the evaluation frames the simulation
 * actually consumed and the result it produced. It is raw replay evidence for an independent
 * reviewer, never a product feature, and it never changes what a run computes.
 *
 * Two things keep it out of a deployment. It is off by default, so an unconfigured process writes
 * nothing; and asking for it under `NODE_ENV=production` is a **startup error** rather than a
 * silently honoured request, because these archives contain a user's whole run and are written to
 * a local disk nothing rotates.
 */
export type BacktestDebugArchiveMode = "off" | "full";

const BACKTEST_DEBUG_ARCHIVE_MODES: BacktestDebugArchiveMode[] = ["off", "full"];

export const DEFAULT_BACKTEST_DEBUG_ARCHIVE_DIR = ".debug/backtests";

export function getBacktestDebugArchiveConfig(
  env: Environment = process.env,
  startDirectory = process.cwd(),
) {
  const environment = runtimeEnvironment(env);
  const raw = optional(env, "BACKTEST_DEBUG_ARCHIVE") ?? "off";
  if (!BACKTEST_DEBUG_ARCHIVE_MODES.includes(raw as BacktestDebugArchiveMode)) {
    throw new Error(
      `Invalid application configuration: BACKTEST_DEBUG_ARCHIVE must be ${BACKTEST_DEBUG_ARCHIVE_MODES.join(
        " or ",
      )}`,
    );
  }
  const mode = raw as BacktestDebugArchiveMode;

  if (mode !== "off" && environment === "production") {
    throw new Error(
      "Invalid application configuration: BACKTEST_DEBUG_ARCHIVE must be off in production",
    );
  }

  // Resolved against the repository root, not the cwd: `pnpm dev:worker` runs inside
  // `apps/worker`, and a relative default would otherwise scatter one archive directory per
  // package instead of filling the single ignored one at the root.
  const configured =
    optional(env, "BACKTEST_DEBUG_ARCHIVE_DIR") ??
    DEFAULT_BACKTEST_DEBUG_ARCHIVE_DIR;
  const base = findWorkspaceRoot(startDirectory) ?? resolve(startDirectory);

  return {
    mode,
    enabled: mode !== "off",
    directory: resolve(base, configured),
  } as const;
}

export function getDatabaseConfig(env: Environment = process.env) {
  return {
    url: required(env, "DATABASE_URL"),
  } as const;
}

export function getRedisConfig(env: Environment = process.env) {
  return {
    url: required(env, "REDIS_URL"),
  } as const;
}

export function getFmpTrafficConfig(env: Environment = process.env) {
  return {
    timeoutMs: integer(env, ["FMP_TIMEOUT_MS"], 15_000),
    maxRetries: integer(env, ["FMP_MAX_RETRIES"], 3),
    retryBaseDelayMs: integer(env, ["FMP_RETRY_BASE_DELAY_MS"], 500),
    retryMaxDelayMs: integer(env, ["FMP_RETRY_MAX_DELAY_MS"], 30_000),
    maxRetryWaitMs: integer(env, ["FMP_MAX_RETRY_WAIT_MS"], 30_000),
    maxConcurrentRequests: integer(env, ["FMP_MAX_CONCURRENT_REQUESTS"], 4),
    rateLimitPerWindow: integer(env, ["FMP_RATE_LIMIT_PER_WINDOW"], 20),
    rateWindowMs: integer(env, ["FMP_RATE_WINDOW_MS"], 1_000),
    maxQueueDepth: integer(env, ["FMP_MAX_QUEUE_DEPTH"], 100),
    maxQueueWaitMs: integer(env, ["FMP_MAX_QUEUE_WAIT_MS"], 30_000),
  } as const;
}

export function getFmpConfig(env: Environment = process.env) {
  return {
    apiKey: required(env, "FMP_API_KEY"),
    ...getFmpTrafficConfig(env),
  } as const;
}

export function getStockDataConfig(env: Environment = process.env) {
  return {
    maxResidentStocks: integer(
      env,
      ["STOCK_CACHE_MAX_RESIDENT_STOCKS", "STOCK_CACHE_MAX_RESIDENT_SYMBOLS"],
      100,
    ),
    defaultHistoryDays: integer(env, ["STOCK_DETAILS_HISTORY_DAYS"], 365),
    /**
     * The product horizon: the oldest day a user may select, chart, query or backtest.
     *
     * Not the retention horizon. `@intrinsic/stock-data` derives how many years of raw prices to
     * retain from this value plus the derived-series warm-up, so the extra internal years follow
     * the product horizon automatically and are never configured — or exposed — separately.
     */
    productHistoryYears: integer(env, ["STOCK_HISTORY_YEARS"], 30),
    recentPriceFreshnessMs: integer(
      env,
      ["STOCK_RECENT_PRICE_FRESHNESS_MS"],
      6 * 60 * 60 * 1000,
    ),
    fundamentalsFreshnessMs: integer(
      env,
      ["STOCK_FUNDAMENTALS_FRESHNESS_MS"],
      6 * 60 * 60 * 1000,
    ),
    recentTailCalendarDays: integer(
      env,
      ["STOCK_RECENT_TAIL_CALENDAR_DAYS"],
      10,
    ),
    loadLockDurationMs: integer(env, ["STOCK_DATA_LOAD_LOCK_MS"], 30_000),
    loadLockWaitMs: integer(env, ["STOCK_DATA_LOCK_WAIT_MS"], 120_000),
  } as const;
}

/** Server-only Stripe configuration. Never expose this object to browser code. */
export function getStripeConfig(env: Environment = process.env) {
  return {
    secretKey: required(env, "STRIPE_SECRET_KEY"),
    webhookSecret: required(env, "STRIPE_WEBHOOK_SECRET"),
  } as const;
}

/**
 * The only configuration intended to cross the browser boundary.
 * Add public values deliberately; never spread process.env into this object.
 */
export function getWebPublicConfig(env: Environment = process.env) {
  return {
    apiBaseUrl:
      optional(env, "NEXT_PUBLIC_API_BASE_URL") ?? "http://localhost:3001",
    stripePublishableKey: optional(env, "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"),
  } as const;
}
