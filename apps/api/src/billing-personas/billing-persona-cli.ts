import { getStripeBillingConfig, loadRootEnv } from "@intrinsic/config";
import {
  BILLING_PERSONA_LIST,
  BILLING_PERSONA_SLUGS,
  billingPersonaByHandle,
  type BillingPersona,
} from "@intrinsic/testing";
import { PasswordService } from "../auth/password.service";
import {
  describeStripeMode,
  openBillingCliContext,
  type BillingCliContext,
} from "../billing/billing-cli-context";
import { BillingReconciliationService } from "../billing/billing-reconciliation.service";
import { verifyStripeCatalog } from "../billing/catalog-verification";
import { StripeTestModeFixtureGateway } from "../billing/stripe.gateway";
import { redactDatabaseUrl } from "../qa/qa-persona-environment";
import {
  assertBillingPersonaStripeConfig,
  isBillingPersonaDatabaseTarget,
  resolveBillingPersonaDatabase,
  type BillingPersonaDatabase,
  type BillingPersonaDatabaseTarget,
} from "./billing-persona-environment";
import {
  DEFAULT_BILLING_PERSONA_TIMING,
  describeCancellation,
  type BillingPersonaLocalState,
  type BillingPersonaTooling,
} from "./billing-persona-tooling";
import type { StripeFixtureSubscription } from "../billing/stripe-fixture-gateway";

/**
 * The parts `pnpm qa:billing:seed`, `qa:billing:status` and `qa:billing:cleanup` share: argument
 * parsing, the guarded bootstrap, and how a persona is printed.
 */

export type BillingPersonaCliOptions = {
  readonly database: BillingPersonaDatabaseTarget;
  /** The personas named with `--persona`, or all of them. */
  readonly personas: readonly BillingPersona[];
  /** Every other flag the command declared, and whether it was passed. */
  readonly flags: ReadonlySet<string>;
};

/**
 * Parses the shared options plus the boolean flags one command declares.
 *
 * Unknown arguments are an error rather than ignored: a mistyped `--dry-run` must never become a
 * real cleanup. `--persona` is accepted unless the command says it selects none, in which case it
 * is unknown like anything else.
 */
export function parseBillingPersonaArgs(
  argv: readonly string[],
  allowedFlags: readonly string[],
  selection: { readonly personas: boolean } = { personas: true },
): BillingPersonaCliOptions {
  let database: BillingPersonaDatabaseTarget = "dev";
  const personas: BillingPersona[] = [];
  const flags = new Set<string>();

  const valueOf = (index: number, name: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} needs a value`);
    }
    return value;
  };
  const useDatabase = (value: string): void => {
    if (!isBillingPersonaDatabaseTarget(value)) {
      throw new Error(`--database must be dev or test; received '${value}'`);
    }
    database = value;
  };
  const usePersona = (value: string): void => {
    const persona = billingPersonaByHandle(value);
    if (!persona) {
      throw new Error(
        `Unknown billing persona '${value}'. Use one of: ${BILLING_PERSONA_SLUGS.join(", ")}`,
      );
    }
    if (!personas.includes(persona)) {
      personas.push(persona);
    }
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || arg === "--") {
      // pnpm forwards the `--` separator itself; both `pnpm x -- --flag` and `pnpm x --flag` work.
      continue;
    }
    if (arg === "--database") {
      useDatabase(valueOf(index, arg));
      index += 1;
    } else if (arg.startsWith("--database=")) {
      useDatabase(arg.slice("--database=".length));
    } else if (selection.personas && arg === "--persona") {
      usePersona(valueOf(index, arg));
      index += 1;
    } else if (selection.personas && arg.startsWith("--persona=")) {
      usePersona(arg.slice("--persona=".length));
    } else if (allowedFlags.includes(arg)) {
      flags.add(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    database,
    personas: personas.length > 0 ? personas : BILLING_PERSONA_LIST,
    flags,
  };
}

export type BillingPersonaCli = {
  readonly database: BillingPersonaDatabase;
  readonly context: BillingCliContext;
  readonly tooling: BillingPersonaTooling;
  readonly close: () => Promise<void>;
};

/**
 * Opens the tooling against one guarded database and the configured Stripe sandbox.
 *
 * Every refusal happens before a database or Stripe client exists: production, a database that is
 * not plainly local, a missing Stripe configuration, and any Stripe key that is not a test key.
 * The gateway, catalog and reconciliation service are then the same ones the running API builds.
 */
export async function openBillingPersonaCli(input: {
  readonly command: string;
  readonly target: BillingPersonaDatabaseTarget;
}): Promise<BillingPersonaCli> {
  loadRootEnv();
  const database = resolveBillingPersonaDatabase(input.target);
  const config = assertBillingPersonaStripeConfig(getStripeBillingConfig());

  // `PrismaService` reads DATABASE_URL when it is constructed, so the guarded target is put there
  // first; from here on this process has exactly one database.
  process.env.DATABASE_URL = database.databaseUrl;
  const context = await openBillingCliContext();

  console.log(
    `${input.command}: ${database.databaseName} on ${database.host} ` +
      `(${database.source} = ${redactDatabaseUrl(database.databaseUrl)})`,
  );
  console.log(`Stripe environment: ${describeStripeMode(config)}`);

  const passwords = new PasswordService();
  const tooling: BillingPersonaTooling = {
    prisma: context.prisma,
    fixtures: new StripeTestModeFixtureGateway(
      config,
      context.logger.child({ component: "stripe-fixtures" }),
    ),
    catalog: context.catalog,
    reconciliation: new BillingReconciliationService(
      context.prisma,
      context.logger,
      context.stripe,
      context.catalog,
    ),
    hashPassword: (password) => passwords.hash(password),
    report: (line) => console.log(line),
    timing: DEFAULT_BILLING_PERSONA_TIMING,
    createdBy: input.command,
  };

  return { database, context, tooling, close: context.close };
}

/**
 * Refuses to go further unless the four configured prices are the V1 catalog.
 *
 * The same check as `pnpm billing:verify-catalog`, run in-process so that no way of invoking the
 * seed skips it: a fixture built on a mis-mapped price would be a persona on the wrong plan.
 */
export async function requireVerifiedCatalog(
  context: BillingCliContext,
): Promise<boolean> {
  const { findings } = await verifyStripeCatalog(context);
  if (findings.length === 0) {
    console.log(
      "Catalog verified: the four configured prices match the V1 catalog.",
    );
    return true;
  }
  console.error(
    `The configured Stripe catalog has ${findings.length} problem(s); no fixture was created:`,
  );
  for (const finding of findings) {
    console.error(`  ${finding.key}: ${finding.problem}`);
  }
  console.error("Run `pnpm billing:verify-catalog` and fix the catalog first.");
  return false;
}

export function describeStripeSubscription(
  subscription: StripeFixtureSubscription,
  persona: BillingPersona,
): string {
  return (
    `subscription ${subscription.id} ${subscription.status} on ${persona.priceKey}` +
    `, period ends ${subscription.currentPeriodEnd?.toISOString() ?? "unknown"}` +
    `, cancellation ${describeCancellation(subscription)}`
  );
}

export function describeLocalState(local: BillingPersonaLocalState): string {
  const mirror = local.mirror;
  if (mirror === null) {
    return `plan ${local.plan}, no BillingSubscription mirror`;
  }
  return (
    `plan ${local.plan}, mirror ${mirror.status} ` +
    `${mirror.plan ?? "UNKNOWN_PRICE"}/${mirror.billingInterval ?? "?"} ` +
    `(${mirror.planReason})` +
    `, cancelAtPeriodEnd ${mirror.cancelAtPeriodEnd}` +
    (mirror.cancelAt ? `, cancelAt ${mirror.cancelAt.toISOString()}` : "") +
    `, synced ${mirror.syncedAt.toISOString()}`
  );
}

export function failCommand(prefix: string): (error: unknown) => void {
  return (error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`${prefix}: ${message}`);
    process.exitCode = 1;
  };
}
