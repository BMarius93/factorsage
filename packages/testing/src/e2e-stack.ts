import { join } from "node:path";

/**
 * The deterministic E2E stack's process boundary, defined once.
 *
 * `pnpm dev:api:e2e`, `pnpm dev:worker:e2e` and `pnpm dev:web:e2e` launch the real applications with
 * exactly this environment laid over the developer's `.env`, `pnpm dev:fmp:e2e` serves the fixture
 * provider it points at, and the Playwright global setup/teardown read the same constants to prove
 * the stack is the hermetic one before a run and that nothing escaped it afterwards. A value that
 * lived in two of those places would be two definitions of "hermetic" that could drift apart.
 *
 * Deliberately free of workspace imports: the launcher runs before any package is built, and the
 * Playwright harness imports it through a dependency-free subpath exactly like `./personas`.
 *
 * `ai/workflows/auth-testing.md` §7 is the runbook this implements.
 */

/** Loopback port of the fixture FMP server. Overridable for a machine where it is taken. */
export const E2E_FAKE_FMP_DEFAULT_PORT = 3011;

/**
 * The key the E2E API and worker send to the fixture server.
 *
 * Not a credential and not secret: it exists so a developer's real `FMP_API_KEY` is never present
 * in an E2E process at all, and so the fixture server can tell that a request came from a process
 * launched through this boundary rather than from something still holding a real key.
 */
export const E2E_FAKE_FMP_API_KEY = "e2e-fixture-provider";

/**
 * How long seeded market data stays fresh on the E2E stack: thirty days.
 *
 * The seeds stamp their freshness watermarks with the seed's own time, and production treats a tail
 * older than six hours as stale and re-reads it from the provider. On the E2E stack that re-read
 * would be answered by the fixture server — correctly, and harmlessly, but it is still provider
 * traffic the suite did not ask for. A thirty-day window removes the wall clock from the working
 * day, the next morning and a paused branch alike, without touching the product default.
 */
export const E2E_DATA_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;

/** The roles one E2E stack is made of. */
export type E2eStackRole = "api" | "worker" | "web";

/**
 * What the stack's API does with email.
 *
 * - `standard` — the whole `SMTP_*` group is blanked, so the API runs its unconfigured sender and
 *   nothing is ever delivered. Every ordinary run (`pnpm test:e2e`) is this.
 * - `mail` — the API delivers to the local Mailpit and nowhere else (`pnpm dev:api:e2e:mail`), for
 *   the email lifecycle suite alone (`pnpm test:e2e:mail`). Only the API has a mail mode: nothing
 *   else in the stack sends email.
 *
 * The egress guard records the mode each process was launched in, and the Playwright global setup
 * refuses a run whose API is in the other mode, so the ordinary suite can never quietly start
 * delivering mail and the mail suite can never wait on an API that will send none.
 */
export type E2eStackMode = "standard" | "mail";

/**
 * The local Mailpit the mail mode delivers to, as `scripts/cloud/lib.sh` starts it: SMTP and the
 * HTTP API on loopback. `E2E_MAILPIT_SMTP_URL` / `E2E_MAILPIT_URL` override them for a machine where
 * the ports are taken; both are refused unless they name a loopback host, so neither can point at
 * a real provider.
 */
export const E2E_MAILPIT_DEFAULT_SMTP_URL = "smtp://127.0.0.1:1025";
export const E2E_MAILPIT_DEFAULT_API_URL = "http://127.0.0.1:8025";

/** The sender the mail-mode API writes. `.test` is reserved (RFC 2606) and receives nothing. */
export const E2E_MAIL_FROM = "no-reply@factorsage.test";

/** The loopback spellings a Mailpit endpoint may use. Deliberately narrower than the guard's. */
const MAILPIT_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * A refusal at the E2E mail boundary: a Mailpit endpoint that is not loopback, a message that is not
 * the one expected, or a link that is not the local web app's. It never carries a token.
 */
export class E2eMailBoundaryError extends Error {
  override readonly name = "E2eMailBoundaryError";
}

/**
 * Parses one Mailpit endpoint and refuses anything that is not plainly the local Mailpit: another
 * scheme, a non-loopback host, embedded credentials (Mailpit takes none, so a credential here could
 * only belong to a real provider), a path, a query or a missing port.
 */
function mailpitEndpoint(
  variable: string,
  raw: string,
  protocol: "smtp:" | "http:",
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new E2eMailBoundaryError(`${variable} is not a valid URL.`);
  }
  if (url.protocol !== protocol) {
    throw new E2eMailBoundaryError(
      `${variable} must be a ${protocol}// URL: the local Mailpit speaks plain ${protocol.slice(0, -1).toUpperCase()} on loopback.`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new E2eMailBoundaryError(
      `${variable} carries credentials. The local Mailpit takes none, so a credential here could ` +
        "only be a real provider's, and the E2E stack never holds one.",
    );
  }
  if (!MAILPIT_HOSTS.has(url.hostname)) {
    throw new E2eMailBoundaryError(
      `${variable} points at \`${url.hostname}\`, which is not loopback. The E2E mail mode delivers ` +
        "to the local Mailpit only (127.0.0.1, localhost or [::1]).",
    );
  }
  if (url.port === "") {
    throw new E2eMailBoundaryError(`${variable} must name its port.`);
  }
  if (
    !["", "/"].includes(url.pathname) ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new E2eMailBoundaryError(
      `${variable} must be an origin only, with no path or query.`,
    );
  }
  return url;
}

function assertNotProductionMail(env: Environment): void {
  if (env.NODE_ENV?.trim() === "production") {
    throw new E2eMailBoundaryError(
      "Refusing the E2E mail mode: NODE_ENV is production. Mailpit is a local test sink.",
    );
  }
}

/** Where the mail-mode API sends SMTP: the local Mailpit, never anything else. */
export function e2eMailpitSmtpEndpoint(env: Environment = process.env): {
  readonly host: string;
  readonly port: number;
} {
  assertNotProductionMail(env);
  const url = mailpitEndpoint(
    "E2E_MAILPIT_SMTP_URL",
    env.E2E_MAILPIT_SMTP_URL?.trim() || E2E_MAILPIT_DEFAULT_SMTP_URL,
    "smtp:",
  );
  // A bracketed IPv6 literal is a URL spelling; the socket wants the bare address.
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: Number(url.port),
  };
}

/** The local Mailpit's HTTP API origin, e.g. `http://127.0.0.1:8025`, never anything else. */
export function e2eMailpitApiUrl(env: Environment = process.env): string {
  assertNotProductionMail(env);
  return mailpitEndpoint(
    "E2E_MAILPIT_URL",
    env.E2E_MAILPIT_URL?.trim() || E2E_MAILPIT_DEFAULT_API_URL,
    "http:",
  ).origin;
}

/** The fixture server's base URL, in the exact shape `FMP_BASE_URL` requires. */
export function e2eFakeFmpBaseUrl(port = e2eFakeFmpPort()): string {
  return `http://127.0.0.1:${port}/stable/`;
}

/** The fixture server's control endpoints (health and request journal). Never an FMP path. */
export function e2eFakeFmpControlUrl(port = e2eFakeFmpPort()): string {
  return `http://127.0.0.1:${port}/__e2e/`;
}

export function e2eFakeFmpPort(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.E2E_FAKE_FMP_PORT?.trim();
  if (!raw) {
    return E2E_FAKE_FMP_DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("E2E_FAKE_FMP_PORT must be a TCP port number");
  }
  return port;
}

/**
 * Where the egress guard records what it armed and what it blocked, one JSON object per line.
 *
 * Inside the repository (git-ignored) rather than a temp directory so every process of one checkout
 * — three launchers and the Playwright runner — agrees on it without coordination.
 */
export function e2eEgressLogPath(repositoryRoot: string): string {
  return join(repositoryRoot, ".e2e-stack", "egress.jsonl");
}

/** The preloaded guard every E2E application process runs under. Plain CommonJS on purpose. */
export function e2eEgressGuardPath(repositoryRoot: string): string {
  return join(repositoryRoot, "packages", "testing", "egress-guard.cjs");
}

/**
 * Every provider credential and endpoint an E2E process could use, replaced.
 *
 * Empty groups switch the optional integrations off the way `.env.example` does (both are
 * all-or-nothing, so every member is blanked). Stripe keeps a *configured* shape so the billing
 * specs still exercise their pages, but with inert test-mode placeholders: no real key is ever in
 * the process, and the egress guard stops the SDK should anything reach for the network.
 */
const PROVIDER_OVERRIDES = {
  SMTP_HOST: "",
  SMTP_PORT: "",
  SMTP_SECURE: "",
  SMTP_USER: "",
  SMTP_PASSWORD: "",
  SMTP_FROM: "",
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  GOOGLE_CALLBACK_URL: "",
  STRIPE_SECRET_KEY: "sk_test_e2e_offline_placeholder",
  STRIPE_WEBHOOK_SECRET: "whsec_e2e_offline_placeholder",
  STRIPE_PRICE_STARTER_MONTHLY: "price_e2e_starter_monthly",
  STRIPE_PRICE_STARTER_YEARLY: "price_e2e_starter_yearly",
  STRIPE_PRICE_PRO_MONTHLY: "price_e2e_pro_monthly",
  STRIPE_PRICE_PRO_YEARLY: "price_e2e_pro_yearly",
} as const;

/**
 * The mail mode's replacement for the blanked `SMTP_*` group: the local Mailpit, unencrypted (it
 * offers no TLS on loopback), and **no credentials** — `SMTP_USER`/`SMTP_PASSWORD` stay blank, so a
 * developer's real relay credentials in `.env` are never in the process.
 */
function mailpitSmtpOverrides(env: Environment): Record<string, string> {
  const { host, port } = e2eMailpitSmtpEndpoint(env);
  return {
    SMTP_HOST: host,
    SMTP_PORT: String(port),
    SMTP_SECURE: "false",
    SMTP_USER: "",
    SMTP_PASSWORD: "",
    SMTP_FROM: E2E_MAIL_FROM,
  };
}

export type E2eStackEnvironmentInput = {
  readonly role: E2eStackRole;
  readonly repositoryRoot: string;
  /** Required for the API and the worker; the web app never opens a database. */
  readonly testDatabaseUrl?: string;
  readonly fakeFmpPort?: number;
  /** Whatever `NODE_OPTIONS` the launcher inherited; the guard is prepended, never replaces it. */
  readonly inheritedNodeOptions?: string;
  /** `standard` unless stated. `mail` exists for the API only. */
  readonly mode?: E2eStackMode;
  /**
   * The launcher's own environment, read only by the mail mode: `E2E_MAILPIT_SMTP_URL` and
   * `NODE_ENV`, both checked before anything is built.
   */
  readonly launcherEnvironment?: Environment;
};

/**
 * The environment laid over `.env` for one role. A shell value beats `.env` (`loadRootEnv` does
 * not override an existing variable, including an empty one), which is what makes a blank here
 * actually switch an integration off.
 */
export function e2eStackEnvironment(
  input: E2eStackEnvironmentInput,
): Record<string, string> {
  const mode = input.mode ?? "standard";
  if (mode === "mail" && input.role !== "api") {
    throw new E2eMailBoundaryError(
      `Only the API has a mail mode; the ${input.role} sends no email.`,
    );
  }
  const guard = e2eEgressGuardPath(input.repositoryRoot);
  const nodeOptions = [`--require=${guard}`, input.inheritedNodeOptions?.trim()]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  const shared = {
    E2E_STACK_ROLE: input.role,
    // Recorded by the egress guard with every process it arms, so the Playwright global setup can
    // tell which mode the API on :3001 was really launched in.
    E2E_STACK_MODE: mode,
    E2E_EGRESS_LOG: e2eEgressLogPath(input.repositoryRoot),
    NODE_OPTIONS: nodeOptions,
    // pnpm and Next both phone home by default; on this stack that would be a blocked connection
    // the teardown then reports as an escape attempt.
    npm_config_update_notifier: "false",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  if (input.role === "web") {
    return shared;
  }

  const testDatabaseUrl = input.testDatabaseUrl?.trim();
  if (!testDatabaseUrl) {
    throw new Error(
      "The E2E stack requires TEST_DATABASE_URL: it runs against the dedicated test database only.",
    );
  }
  const freshness = String(E2E_DATA_FRESHNESS_MS);
  return {
    ...shared,
    ...PROVIDER_OVERRIDES,
    ...(mode === "mail"
      ? mailpitSmtpOverrides(input.launcherEnvironment ?? {})
      : {}),
    DATABASE_URL: testDatabaseUrl,
    FMP_BASE_URL: e2eFakeFmpBaseUrl(input.fakeFmpPort),
    FMP_API_KEY: E2E_FAKE_FMP_API_KEY,
    STOCK_RECENT_PRICE_FRESHNESS_MS: freshness,
    STOCK_FUNDAMENTALS_FRESHNESS_MS: freshness,
    ALT_DATA_FRESHNESS_MS: freshness,
    ...(input.role === "api"
      ? {
          // Playwright signs in far more often than a person does, from one loopback address.
          // Enforcement stays on; see "Rate limiting and the E2E stack" in auth-testing.md.
          RATE_LIMIT_KEY_NAMESPACE: "rate-limit:e2e",
          RATE_LIMIT_ALLOWANCE_MULTIPLIER: "100",
        }
      : {}),
  };
}

/** One line of the egress log. */
export type E2eEgressRecord =
  | {
      readonly kind: "armed";
      readonly at: string;
      readonly pid: number;
      readonly role: string;
      readonly command: string;
      /** Absent in records written before modes existed, which were all `standard`. */
      readonly mode?: string;
    }
  | {
      readonly kind: "blocked";
      readonly at: string;
      readonly pid: number;
      readonly role: string;
      readonly command: string;
      readonly host: string;
      readonly port: string;
    };

/**
 * Destinations a framework — not the product — tries on its own, which the guard still blocks and
 * the teardown still reports, but does not count as an escape attempt.
 *
 * Only one: `next dev` asks the npm registry whether a newer Next.js exists, to colour its dev
 * indicator. It ignores the failure, the request never leaves the machine, and nothing the product
 * does depends on it. Anything else blocked — any provider, any other host, any other role — fails
 * the run.
 */
export const E2E_TOLERATED_BLOCKED_DESTINATIONS: readonly {
  readonly role: E2eStackRole;
  readonly host: string;
  readonly reason: string;
}[] = [
  {
    role: "web",
    host: "registry.npmjs.org",
    reason:
      "next dev's version-staleness check (blocked; Next ignores the failure)",
  },
];

export function isToleratedBlockedDestination(record: {
  readonly role: string;
  readonly host: string;
}): boolean {
  return E2E_TOLERATED_BLOCKED_DESTINATIONS.some(
    (entry) => entry.role === record.role && entry.host === record.host,
  );
}

/** The mode an armed process was launched in. Records from before modes existed are `standard`. */
export function e2eArmedMode(record: { readonly mode?: string }): string {
  return record.mode ?? "standard";
}

/** Parses the egress log, ignoring a torn last line from a process killed mid-write. */
export function parseE2eEgressLog(text: string): E2eEgressRecord[] {
  const records: E2eEgressRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    try {
      const value = JSON.parse(line) as E2eEgressRecord;
      if (value.kind === "armed" || value.kind === "blocked") {
        records.push(value);
      }
    } catch {
      // A partial line is not evidence of anything; the complete ones around it still are.
    }
  }
  return records;
}
