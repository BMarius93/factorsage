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
 * Loads the single repository-root .env file when it exists.
 *
 * Local development uses this file. Deployed environments normally do not
 * contain it; the platform injects the same variables into process.env.
 */
export function loadRootEnv(
  startDirectory = process.cwd(),
): string | undefined {
  let directory = resolve(startDirectory);

  while (true) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) {
      const envFile = join(directory, ".env");
      if (existsSync(envFile)) {
        loadEnvFile(envFile);
        return envFile;
      }
      return undefined;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
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
    cookieName: optional(env, "AUTH_COOKIE_NAME") ?? "intrinsic_auth",
    cookieSecure: environment === "production",
    cookieSameSite: "lax" as const,
  } as const;
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
    historyYears: integer(env, ["STOCK_HISTORY_YEARS"], 30),
    recentPriceFreshnessMs: integer(
      env,
      ["STOCK_RECENT_PRICE_FRESHNESS_MS"],
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
