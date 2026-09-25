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

/**
 * Whether a URL host names this machine rather than a public service: `localhost` and its
 * subdomains, the whole 127/8 block, `::1`, an IPv4-mapped loopback, or the unspecified address.
 *
 * Takes `URL.hostname`, so it relies on the WHATWG parser having already normalized alternative
 * spellings (`127.1`, `0x7f.0.0.1`, `[0:0:0:0:0:0:0:1]`) to the canonical ones checked here.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::" ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)
  );
}

/**
 * The production form of a public URL: required, https, and not this machine.
 *
 * A production API builds verification links, reset links, the post-OAuth redirect and Stripe
 * return URLs from these values and accepts credentialed browser calls from them. A localhost
 * default there does not fail — it boots healthy and sends every customer to their own machine —
 * so production refuses to start instead. Messages name the variable, never its value.
 */
function assertProductionPublicUrl(name: string, url: URL): void {
  if (url.protocol !== "https:") {
    throw new Error(
      `Invalid application configuration: ${name} must be an https URL in production`,
    );
  }
  if (isLoopbackHost(url.hostname)) {
    throw new Error(
      `Invalid application configuration: ${name} must not point at localhost or a loopback ` +
        "address in production",
    );
  }
}

function corsOrigins(env: Environment): string[] {
  const production = runtimeEnvironment(env) === "production";
  const values = commaSeparated(
    optional(env, "CORS_ORIGINS"),
    production ? [] : ["http://localhost:3000"],
  );
  if (values.length === 0) {
    throw new Error(
      "Invalid application configuration: CORS_ORIGINS is required in production",
    );
  }

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

    if (production && isLoopbackHost(url.hostname)) {
      throw new Error(
        "Invalid application configuration: CORS_ORIGINS must not contain a localhost or " +
          "loopback origin in production",
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
 *
 * The localhost default is a development convenience only: in production the value is required,
 * must be https and must not be loopback.
 */
export function getWebBaseUrl(env: Environment = process.env): string {
  if (runtimeEnvironment(env) !== "production") {
    return absoluteUrl(env, "WEB_BASE_URL", "http://localhost:3000");
  }
  if (optional(env, "WEB_BASE_URL") === undefined) {
    throw new Error(
      "Invalid application configuration: WEB_BASE_URL is required in production",
    );
  }
  const value = absoluteUrl(env, "WEB_BASE_URL");
  assertProductionPublicUrl("WEB_BASE_URL", new URL(value));
  return value;
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
    // Deliberately much shorter than the verification TTL: a reset link is a live credential for
    // an account that already exists, while a verification link only activates a new one.
    passwordResetTtlSeconds: integer(
      env,
      ["AUTH_PASSWORD_RESET_TTL_SECONDS"],
      60 * 60,
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
 * Outside production, outbound email is optional infrastructure: with nothing configured this
 * returns `null` and the API reports the email boundary as unavailable instead of failing at
 * startup. In production it is required, because registration, email verification and password
 * recovery all depend on it and a public API without it would boot healthy and then be unable to
 * activate a single password account. When it is configured, `SMTP_HOST` and `SMTP_FROM` are
 * mandatory and credentials are all-or-nothing, so a local unauthenticated relay stays valid while
 * a half-configured production relay is rejected.
 *
 * Only the API calls this. The worker sends no email and never requires it.
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
    if (runtimeEnvironment(env) === "production") {
      throw new Error(
        "Invalid application configuration: SMTP_HOST and SMTP_FROM are required in " +
          "production; registration, email verification and password recovery send email",
      );
    }
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
 * Credentials for one persistent test persona, looked up by its environment prefix.
 *
 * The prefix is supplied by the caller rather than listed here, because the set of personas is
 * defined once in `@intrinsic/testing` — and `@intrinsic/testing` already depends on this package,
 * so the table cannot live in both directions. Required only while running a seed command or
 * Playwright; the application never reads it.
 *
 * The password bound is the product's own registration policy, so a persona can always sign in
 * through the real form.
 */
export function getTestPersonaCredentials(
  envPrefix: string,
  env: Environment = process.env,
) {
  const emailName = `${envPrefix}_EMAIL`;
  const passwordName = `${envPrefix}_PASSWORD`;
  const password = required(env, passwordName);

  if (password.length < 12) {
    throw new Error(
      `Invalid application configuration: ${passwordName} must be at least 12 characters`,
    );
  }

  return { email: required(env, emailName), password } as const;
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

/** The four logical price keys, spelled as the environment-variable suffixes they map to. */
const STRIPE_PRICE_ENV_NAMES = {
  STARTER_MONTHLY: "STRIPE_PRICE_STARTER_MONTHLY",
  STARTER_YEARLY: "STRIPE_PRICE_STARTER_YEARLY",
  PRO_MONTHLY: "STRIPE_PRICE_PRO_MONTHLY",
  PRO_YEARLY: "STRIPE_PRICE_PRO_YEARLY",
} as const;

export type StripePriceKeyName = keyof typeof STRIPE_PRICE_ENV_NAMES;

export type StripeBillingConfig = {
  readonly secretKey: string;
  readonly webhookSecret: string;
  /** Logical catalog key -> the Stripe Price ID configured for *this* environment. */
  readonly priceIds: Readonly<Record<StripePriceKeyName, string>>;
  /** True when the configured secret key is a test-mode/sandbox key. */
  readonly testMode: boolean;
  /** Where Stripe returns the browser after hosted Checkout. Server-configured, never client. */
  readonly checkoutSuccessUrl: string;
  readonly checkoutCancelUrl: string;
  readonly portalReturnUrl: string;
  /** Network timeout for one Stripe API call, in milliseconds. */
  readonly timeoutMs: number;
  /** SDK-level retries for Stripe calls Stripe itself marks safely retryable. */
  readonly maxNetworkRetries: number;
};

/**
 * Whether this looks like a Stripe **test-mode** secret. Sandbox keys are test keys.
 *
 * Both shapes Stripe issues are accepted: a standard secret key and a restricted key.
 */
function isStripeTestSecret(secretKey: string): boolean {
  return secretKey.startsWith("sk_test_") || secretKey.startsWith("rk_test_");
}

function isStripeLiveSecret(secretKey: string): boolean {
  return secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_");
}

/**
 * Server-only Stripe billing configuration, or `null` when this deployment has no billing.
 *
 * **Optional as a whole, all-or-nothing once touched.** With no `STRIPE_*` variable set this
 * returns `null`, the billing module registers no Stripe client, and every other suite and package
 * in the workspace keeps running with no Stripe secret anywhere — which is what stops a payment
 * integration from becoming a prerequisite for running the tests. Setting any one of them turns
 * billing on, after which every required value must be present and well-formed: a half-configured
 * biller fails at a customer's Checkout, which is the worst possible place to discover it.
 *
 * **Test and live modes are hard-separated by an assertion, not by discipline.** A live secret key
 * outside `NODE_ENV=production` is refused, and a test secret key *in* production is refused. That
 * is the concrete form of the decision document's rule (section 2) that production must never boot
 * with sandbox material and local development must never be able to charge a real card.
 *
 * Never expose the returned object, or any field of it, to browser code.
 */
export function getStripeBillingConfig(
  env: Environment = process.env,
): StripeBillingConfig | null {
  const priceEntries = Object.entries(STRIPE_PRICE_ENV_NAMES) as [
    StripePriceKeyName,
    string,
  ][];

  const touched = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    ...priceEntries.map(([, name]) => name),
  ].some((name) => optional(env, name) !== undefined);

  if (!touched) {
    return null;
  }

  const environment = runtimeEnvironment(env);
  const secretKey = required(env, "STRIPE_SECRET_KEY");
  const testMode = isStripeTestSecret(secretKey);

  if (!testMode && !isStripeLiveSecret(secretKey)) {
    throw new Error(
      "Invalid application configuration: STRIPE_SECRET_KEY must be a Stripe secret or " +
        "restricted key (sk_test_/rk_test_ for sandbox, sk_live_/rk_live_ for live)",
    );
  }
  if (!testMode && environment !== "production") {
    throw new Error(
      `Invalid application configuration: STRIPE_SECRET_KEY is a live-mode key and NODE_ENV is ` +
        `'${environment}'. Development and test environments must use a Stripe sandbox/test key so ` +
        "no implementation testing can move real money.",
    );
  }
  if (testMode && environment === "production") {
    throw new Error(
      "Invalid application configuration: STRIPE_SECRET_KEY is a sandbox/test-mode key and " +
        "NODE_ENV is 'production'. Production must be configured with live Stripe credentials and " +
        "live price IDs.",
    );
  }

  const webhookSecret = required(env, "STRIPE_WEBHOOK_SECRET");
  if (!webhookSecret.startsWith("whsec_")) {
    throw new Error(
      "Invalid application configuration: STRIPE_WEBHOOK_SECRET must be a Stripe webhook " +
        "signing secret (whsec_...)",
    );
  }

  const priceIds = {} as Record<StripePriceKeyName, string>;
  const seen = new Map<string, StripePriceKeyName>();
  for (const [key, name] of priceEntries) {
    const value = required(env, name);
    if (!value.startsWith("price_")) {
      throw new Error(
        `Invalid application configuration: ${name} must be a Stripe Price ID (price_...)`,
      );
    }
    const duplicate = seen.get(value);
    if (duplicate) {
      // Two logical keys pointing at one Stripe price would make plan and interval ambiguous in
      // exactly the direction that matters: a Pro price resolving to Starter, or a yearly price
      // billing monthly. It is always a copy-paste error and never a valid configuration.
      throw new Error(
        `Invalid application configuration: ${name} and ${STRIPE_PRICE_ENV_NAMES[duplicate]} are ` +
          "the same Stripe Price ID; each logical price must map to its own Stripe price",
      );
    }
    seen.set(value, key);
    priceIds[key] = value;
  }

  const webBaseUrl = getWebBaseUrl(env);

  return {
    secretKey,
    webhookSecret,
    priceIds,
    testMode,
    // Defaults land on the web app's own billing page, so a working local setup needs no URL
    // configuration at all — and an override is still an absolute URL validated like any other.
    checkoutSuccessUrl: absoluteUrl(
      env,
      "STRIPE_CHECKOUT_SUCCESS_URL",
      `${webBaseUrl}/billing?checkout=success`,
    ),
    checkoutCancelUrl: absoluteUrl(
      env,
      "STRIPE_CHECKOUT_CANCEL_URL",
      `${webBaseUrl}/billing?checkout=cancelled`,
    ),
    portalReturnUrl: absoluteUrl(
      env,
      "STRIPE_PORTAL_RETURN_URL",
      `${webBaseUrl}/billing`,
    ),
    timeoutMs: integer(env, ["STRIPE_TIMEOUT_MS"], 20_000),
    maxNetworkRetries: integer(env, ["STRIPE_MAX_NETWORK_RETRIES"], 2),
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

/**
 * Non-negative integer configuration. Distinct from `integer` above, which rejects zero because
 * every value it reads is a size, an interval or a count that must be positive. `0` is meaningful
 * here: it is how a deployment says "trust no proxy".
 */
function nonNegativeInteger(
  env: Environment,
  name: string,
  fallback: number,
): number {
  const raw = optional(env, name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `Invalid application configuration: ${name} must be a non-negative integer`,
    );
  }
  return value;
}

/**
 * HTTP rate limiting. Operational configuration, never a commercial entitlement
 * (`docs/decisions/entitlements-v1.md` section 10).
 *
 * **`RATE_LIMIT_TRUSTED_PROXY_HOPS` is a security control, not a convenience.** The limiter keys
 * unauthenticated traffic by client IP, and `X-Forwarded-For` is caller-supplied text that anyone
 * may prepend to. The default `0` therefore trusts nothing and uses the TCP peer address, which is
 * correct for this repository's own deployment: `docker-compose.yml` publishes the API port
 * directly and nothing terminates in front of it. A deployment that really does run the API behind
 * N trusted proxies sets this to N, and the derivation then skips exactly N entries from the right
 * of the header — the only part of it those proxies actually control. Setting it higher than the
 * real hop count hands every caller a free identity, so it is never inferred and never defaulted
 * to "on".
 *
 * `RATE_LIMIT_REDIS_TIMEOUT_MS` bounds one limiter round trip. A rate limiter that can hang is
 * worse than no rate limiter: it converts a Redis stall into an API-wide stall. It is deliberately
 * short — the limiter does one `EVAL` against a local-network Redis — and a breach is treated as
 * the policy's configured Redis-failure behaviour rather than as an error.
 *
 * `RATE_LIMIT_ENABLED=false` turns enforcement off for a deployment that fronts the API with its
 * own limiter. It stays `true` by default and is not a test convenience: the suites exercise the
 * real thing.
 */
export function getRateLimitConfig(env: Environment = process.env) {
  return {
    enabled: boolean(env, "RATE_LIMIT_ENABLED", true),
    /** Shares the application Redis instance; never a second provider. */
    redisUrl: required(env, "REDIS_URL"),
    redisTimeoutMs: integer(env, ["RATE_LIMIT_REDIS_TIMEOUT_MS"], 250),
    trustedProxyHops: nonNegativeInteger(
      env,
      "RATE_LIMIT_TRUSTED_PROXY_HOPS",
      0,
    ),
    /**
     * Multiplies every policy's allowance. `1` is the catalog as written; a deployment that has
     * measured its own traffic may widen or tighten every policy at once without editing code, and
     * without being able to silently disable one endpoint's protection.
     */
    allowanceMultiplier: integer(env, ["RATE_LIMIT_ALLOWANCE_MULTIPLIER"], 1),
    /** Redis key namespace for every rate-limit counter. Versioned like the other namespaces. */
    keyNamespace: optional(env, "RATE_LIMIT_KEY_NAMESPACE") ?? "rate-limit:v1",
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
  const baseUrl = fmpBaseUrl(env);
  return {
    apiKey: required(env, "FMP_API_KEY"),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...getFmpTrafficConfig(env),
  } as const;
}

/**
 * Where the FMP client sends requests, when something other than the provider's own endpoint.
 *
 * Unset — the only production shape — leaves the client on its built-in
 * `https://financialmodelingprep.com/stable/`, so nothing about production traffic changes. The
 * deterministic E2E stack sets it to a local fixture server (`ai/workflows/auth-testing.md` §7), so
 * no provider request can leave the machine however complete the seeded data turns out to be. It is
 * a base URL rather than an "offline" switch: the whole application path, gate and client included,
 * still runs.
 *
 * Production refuses anything but a public https URL, so an E2E value copied into a deployment
 * fails at startup instead of silently pointing market data at a machine that does not exist.
 * Always ends in `/`: the client resolves each endpoint relative to it, and a base without one would
 * lose its last path segment.
 */
function fmpBaseUrl(env: Environment): string | undefined {
  const raw = optional(env, "FMP_BASE_URL");
  if (raw === undefined) {
    return undefined;
  }
  const url = new URL(absoluteUrl(env, "FMP_BASE_URL"));
  if (runtimeEnvironment(env) === "production") {
    assertProductionPublicUrl("FMP_BASE_URL", url);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(
      "Invalid application configuration: FMP_BASE_URL must not carry a query or fragment",
    );
  }
  return url.toString().endsWith("/") ? url.toString() : `${url.toString()}/`;
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

/**
 * Alternative-data ingestion (insider activity, congressional trading, institutional 13F).
 *
 * Its own configuration rather than more fields on `getStockDataConfig`, because the cadences are
 * genuinely different: a Form 4 is public within two business days, a congressional disclosure within
 * forty-five days, and a 13F filing once a quarter. Refreshing all three as often as a price tail
 * would spend the shared provider budget on datasets that cannot have changed.
 *
 * `ALT_DATA_MAX_PAGES_PER_INGEST` is a loop bound, not a limit on history: at the providers' page caps
 * (1000 insider rows, 250 congressional rows) twelve pages reach twelve thousand Form 4 filings and
 * every congressional disclosure any symbol has. It exists so one mis-paginating endpoint cannot spend
 * the whole allowance.
 */
export function getAlternativeDataConfig(env: Environment = process.env) {
  return {
    freshnessMs: integer(
      env,
      ["ALT_DATA_FRESHNESS_MS"],
      // Twelve hours. A disclosure that lands during the session is visible on the next cycle, and the
      // availability rule already makes it unreadable until the following session anyway.
      12 * 60 * 60 * 1000,
    ),
    maxPagesPerIngest: integer(env, ["ALT_DATA_MAX_PAGES_PER_INGEST"], 12),
    /**
     * Report quarters of 13F history one ingest reads.
     *
     * Twenty is five years, which is enough for the longest supported lookback to sit inside coverage
     * for any period a user is likely to backtest. It costs one request per quarter per symbol and only
     * on a cold ingest.
     */
    institutionalQuarters: integer(env, ["ALT_DATA_13F_QUARTERS"], 20),
  } as const;
}

/** Server-only Stripe configuration. Never expose this object to browser code. */
export function getStripeConfig(env: Environment = process.env) {
  return {
    secretKey: required(env, "STRIPE_SECRET_KEY"),
    webhookSecret: required(env, "STRIPE_WEBHOOK_SECRET"),
  } as const;
}
