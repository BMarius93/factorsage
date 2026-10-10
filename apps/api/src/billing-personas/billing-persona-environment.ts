import type { StripeBillingConfig } from "@intrinsic/config";
import {
  BILLING_PERSONA_PASSWORD_ENV,
  BILLING_PERSONA_PASSWORD_MIN_LENGTH,
  TEST_DATABASE_ACTIVE_ENV,
} from "@intrinsic/testing";
import { assertStripeTestModeKey } from "../billing/stripe-fixture-gateway";
import {
  redactDatabaseUrl,
  resolveQaPersonaEnvironment,
} from "../qa/qa-persona-environment";

/**
 * Where the billing QA persona tooling may act, and nowhere else.
 *
 * These commands create real objects in Stripe and link them to accounts in a database, so both
 * ends are refused mechanically before a Stripe client or a database client exists:
 *
 * - **Stripe** must be configured, and with a **test-mode** key. Not "not a live key": a key of
 *   any other shape is refused as well.
 * - **`NODE_ENV=production`** is refused outright.
 * - **The database** must be one of two local ones, chosen explicitly:
 *   - `dev` — the database `pnpm dev:api` serves, for manual QA against a Stripe-connected stack.
 *     Resolved by the same guard `pnpm qa:seed` uses, so the same hosts are allowed and the same
 *     override applies;
 *   - `test` — `TEST_DATABASE_URL`, the database the hermetic Playwright stack and the opt-in
 *     Stripe validation suite run on.
 *
 * Nothing in this file opens a connection.
 */

export const BILLING_PERSONA_DATABASE_TARGETS = ["dev", "test"] as const;

export type BillingPersonaDatabaseTarget =
  (typeof BILLING_PERSONA_DATABASE_TARGETS)[number];

export function isBillingPersonaDatabaseTarget(
  value: unknown,
): value is BillingPersonaDatabaseTarget {
  return value === "dev" || value === "test";
}

export class BillingPersonaEnvironmentError extends Error {
  override readonly name = "BillingPersonaEnvironmentError";
}

export type BillingPersonaDatabase = {
  readonly target: BillingPersonaDatabaseTarget;
  readonly databaseUrl: string;
  /** Its own name, printed so the operator sees where they are acting. */
  readonly databaseName: string;
  readonly host: string;
  /** Which variable supplied {@link databaseUrl}. */
  readonly source: string;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** `test` as a whole segment of the name: `intrinsic_value_test`, not `contest`. */
const TEST_DATABASE_NAME = /(^|[_-])test($|[_-])/i;

export const PRODUCTION_BILLING_PERSONA_MESSAGE =
  "Refusing to run the billing QA persona tooling: NODE_ENV is production. These commands " +
  "create Stripe test-mode fixtures and link them to accounts; neither may ever happen against " +
  "a production deployment.";

function assertNotProduction(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV?.trim() === "production") {
    throw new BillingPersonaEnvironmentError(
      PRODUCTION_BILLING_PERSONA_MESSAGE,
    );
  }
}

/** Resolves the one database a run may touch, refusing every target that is not plainly local. */
export function resolveBillingPersonaDatabase(
  target: BillingPersonaDatabaseTarget,
  env: NodeJS.ProcessEnv = process.env,
): BillingPersonaDatabase {
  assertNotProduction(env);

  if (target === "dev") {
    // The existing QA persona guard, unchanged: one definition of "a local QA database".
    const resolved = resolveQaPersonaEnvironment(env);
    return {
      target,
      databaseUrl: resolved.databaseUrl,
      databaseName: resolved.databaseName,
      host: resolved.host,
      source: resolved.source,
    };
  }

  const raw = env.TEST_DATABASE_URL?.trim();
  if (!raw) {
    throw new BillingPersonaEnvironmentError(
      "The `test` database target needs TEST_DATABASE_URL. DATABASE_URL is never a fallback.",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BillingPersonaEnvironmentError(
      "TEST_DATABASE_URL is not a valid URL.",
    );
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new BillingPersonaEnvironmentError(
      "TEST_DATABASE_URL must be a postgresql:// URL.",
    );
  }

  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!databaseName) {
    throw new BillingPersonaEnvironmentError(
      "TEST_DATABASE_URL names no database.",
    );
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new BillingPersonaEnvironmentError(
      `Refusing to use \`${redactDatabaseUrl(raw)}\` as the test database: \`${url.hostname}\` ` +
        "is not this machine.",
    );
  }
  if (!TEST_DATABASE_NAME.test(databaseName)) {
    throw new BillingPersonaEnvironmentError(
      `Refusing to use \`${databaseName}\` as the test database: its name has no \`test\` ` +
        "segment, as `intrinsic_value_test` does.",
    );
  }
  // A suite that called `useTestDatabase()` has already swapped DATABASE_URL for the test URL —
  // after checking the two were different — and says so with this marker. Only an equality nobody
  // vouched for means the `.env` names the development database as the test one.
  const alreadySwapped = env[TEST_DATABASE_ACTIVE_ENV]?.trim() === "true";
  if (env.DATABASE_URL?.trim() === raw && !alreadySwapped) {
    throw new BillingPersonaEnvironmentError(
      "TEST_DATABASE_URL names the development database. Create a dedicated test database " +
        "with `pnpm db:test:prepare`, or use the `dev` target.",
    );
  }

  return {
    target,
    databaseUrl: raw,
    databaseName,
    host: url.hostname,
    source: "TEST_DATABASE_URL",
  };
}

/**
 * The Stripe configuration the tooling may use: present, and test mode.
 *
 * `getStripeBillingConfig` already refuses a live key outside production; this refuses production
 * as well, and re-derives "test mode" from the key itself rather than trusting a flag.
 */
export function assertBillingPersonaStripeConfig(
  config: StripeBillingConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): StripeBillingConfig {
  assertNotProduction(env);
  if (!config) {
    throw new BillingPersonaEnvironmentError(
      "Stripe billing is not configured in this environment. The billing QA personas need a " +
        "Stripe sandbox: set STRIPE_SECRET_KEY (a test-mode key), STRIPE_WEBHOOK_SECRET and the " +
        "four STRIPE_PRICE_* variables, or run the command through scripts/cloud/with-stripe.sh " +
        "in a Claude cloud session. See docs/development/billing-qa-personas.md.",
    );
  }
  assertStripeTestModeKey(config);
  return config;
}

/**
 * The shared sign-in password, or `null` when none is configured.
 *
 * Optional: without it the accounts and their billing state are still created, they simply cannot
 * sign in with a password. Only the variable's name ever appears in a message.
 */
export function resolveBillingPersonaPassword(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const password = env[BILLING_PERSONA_PASSWORD_ENV]?.trim();
  if (!password) {
    return null;
  }
  if (password.length < BILLING_PERSONA_PASSWORD_MIN_LENGTH) {
    throw new BillingPersonaEnvironmentError(
      `${BILLING_PERSONA_PASSWORD_ENV} must be at least ` +
        `${BILLING_PERSONA_PASSWORD_MIN_LENGTH} characters.`,
    );
  }
  return password;
}
