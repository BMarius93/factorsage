import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The lines the billing QA persona tooling must not cross, read from the source.
 *
 * Behavioural suites prove what the tooling does; this proves what it *cannot* do, which a passing
 * run never shows. Each rule here is one the brief for the tooling states outright:
 *
 * - a billing persona's mirror and plan come from `BillingReconciliationService` and from nothing
 *   else, so the tooling may not write `BillingSubscription` or `User.plan`, nor call the plan
 *   write seam itself;
 * - `stripe.gateway.ts` stays the only file that imports the Stripe SDK (`AGENTS.md` invariant 18);
 * - nothing can modify or delete the shared four-price catalog, and the only thing the fixture
 *   gateway can delete is a Test Clock;
 * - the entitlement personas stay independent of Stripe.
 */

const REPOSITORY_ROOT = resolve(__dirname, "../../../..");
const API_SRC = resolve(__dirname, "..");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function sourceFilesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) {
      continue;
    }
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFilesUnder(path));
    } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

/** Comments describe the rules in the very words the rules forbid, so they are not code. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const isTest = (path: string) => /\.test\.ts$|\.test-helper\.ts$/.test(path);

/** The tooling itself: its modules and the three commands. Tests excluded. */
const TOOLING_FILES = [
  ...sourceFilesUnder(resolve(API_SRC, "billing-personas")).filter(
    (path) => !isTest(path),
  ),
  resolve(API_SRC, "qa-billing-personas-seed.ts"),
  resolve(API_SRC, "qa-billing-personas-status.ts"),
  resolve(API_SRC, "qa-billing-personas-cleanup.ts"),
];

describe("billing persona tooling boundaries", () => {
  it("covers the files it thinks it covers", () => {
    const names = TOOLING_FILES.map((path) => relative(API_SRC, path)).sort();
    expect(names).toEqual([
      "billing-personas/billing-persona-cli.ts",
      "billing-personas/billing-persona-environment.ts",
      "billing-personas/billing-persona-fixtures.ts",
      "billing-personas/billing-persona-tooling.ts",
      "qa-billing-personas-cleanup.ts",
      "qa-billing-personas-seed.ts",
      "qa-billing-personas-status.ts",
    ]);
  });

  it.each(TOOLING_FILES.map((path) => [relative(API_SRC, path), path]))(
    "%s never writes the billing mirror or a plan",
    (_name, path) => {
      const code = withoutComments(read(path));

      // The mirror has exactly one writer, and it is not here. Reading it is fine.
      expect(code).not.toMatch(
        /billingSubscription\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/,
      );
      // Nor the plan: not through the write seam, and not as a column in any write.
      expect(code).not.toMatch(/changeUserPlan/);
      expect(code).not.toMatch(/\bdata\s*:\s*\{[^}]*\bplan\b/);
      expect(code).not.toMatch(/\$executeRaw|\$queryRaw/);
      // And it decides no plan: the product's one plan decision is not consulted here either.
      expect(code).not.toMatch(/resolveEffectivePlan/);
      // No Stripe SDK: everything goes through the two FactorSage-typed gateways.
      expect(code).not.toMatch(/from\s+["']stripe["']/);
    },
  );

  it("reaches a plan only by calling the application's reconciliation", () => {
    const tooling = withoutComments(
      read(resolve(API_SRC, "billing-personas/billing-persona-tooling.ts")),
    );
    expect(tooling).toMatch(/reconciliation\.reconcileUser\(/);
    // The only user columns it ever writes are identity: verification, role, password, the link.
    const writes = [...tooling.matchAll(/\bdata\s*:\s*\{([^}]*)\}/g)].map(
      (match) => (match[1] ?? "").replace(/\s+/g, " ").trim(),
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write).toMatch(
        /^(role: UserRole\.USER|email: persona\.email|stripeCustomerId: (customerId|null))/,
      );
    }
  });

  it("keeps the Stripe SDK in one file", () => {
    const importers = ["apps", "packages", "scripts"]
      .flatMap((directory) =>
        sourceFilesUnder(resolve(REPOSITORY_ROOT, directory)),
      )
      .filter((path) =>
        /(from\s+["']stripe["'])|(require\(\s*["']stripe["']\s*\))/.test(
          read(path),
        ),
      )
      // This file names the import in order to forbid it.
      .filter((path) => path !== __filename)
      .map((path) => relative(REPOSITORY_ROOT, path));

    expect(importers).toEqual(["apps/api/src/billing/stripe.gateway.ts"]);
  });

  it("gives nothing a way to change the shared catalog or delete anything but a Test Clock", () => {
    const adapter = withoutComments(
      read(resolve(API_SRC, "billing/stripe.gateway.ts")),
    );

    // Prices are read, by the catalog verifier. Nothing creates, updates or archives one.
    expect(adapter).not.toMatch(/\.prices\s*\.\s*(create|update|del)\b/);
    // Products are only ever reached through a price's expansion.
    expect(adapter).not.toMatch(/\.products\s*\./);
    // One delete in the whole adapter, and it is a Test Clock.
    expect(adapter.match(/\.del\(/g)).toHaveLength(1);
    expect(adapter).toMatch(/testHelpers\.testClocks\.del\(/);
    // No direct way to end somebody's subscription or remove somebody's customer.
    expect(adapter).not.toMatch(/subscriptions\s*\.\s*cancel\b/);
    expect(adapter).not.toMatch(/customers\s*\.\s*del\b/);
  });

  it("keeps the fixture interface free of catalog operations", () => {
    const fixtureInterface = withoutComments(
      read(resolve(API_SRC, "billing/stripe-fixture-gateway.ts")),
    );
    expect(fixtureInterface).not.toMatch(/product|describePrices|createPrice/i);
    const methods = [...fixtureInterface.matchAll(/^ {2}(\w+)\(/gm)].map(
      (match) => match[1],
    );
    // The whole surface, written out: adding an operation means changing this list on purpose.
    // `deleteTestClock` is the only one that removes anything.
    expect(methods).toEqual([
      "listTestClocks",
      "retrieveTestClock",
      "createTestClock",
      "advanceTestClock",
      "deleteTestClock",
      "listTestClockCustomers",
      "retrieveCustomer",
      "createTestClockCustomer",
      "attachTestPaymentMethod",
      "listSubscriptions",
      "createSubscription",
      "setSubscriptionPaymentMethod",
      "scheduleCancellationAtPeriodEnd",
    ]);
  });

  it("leaves the entitlement personas with no dependency on Stripe or on billing personas", () => {
    const entitlementPersonaFiles = [
      "packages/testing/src/personas.ts",
      "packages/testing/src/persona-credentials.ts",
      "apps/api/src/auth/seed-qa-users.ts",
      "apps/api/src/seed-qa-users.ts",
      "apps/api/src/seed-entitlement-fixtures.ts",
      "apps/api/src/qa-personas-seed.ts",
      "apps/api/src/qa-personas-reset.ts",
      "apps/api/src/qa/qa-persona-cli.ts",
      "apps/web/e2e/setup/auth.setup.ts",
      "apps/web/playwright.config.ts",
    ];
    for (const file of entitlementPersonaFiles) {
      const code = withoutComments(read(resolve(REPOSITORY_ROOT, file)));
      expect(code, file).not.toMatch(
        /billing-persona|BILLING_PERSONA|billingPersona/,
      );
      expect(code, file).not.toMatch(/StripeGateway|stripe\.gateway|STRIPE_/);
    }
  });
});
