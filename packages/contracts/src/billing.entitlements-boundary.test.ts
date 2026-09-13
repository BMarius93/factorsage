import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BILLING_CATALOG_ENTRIES,
  resolveEffectivePlan,
  type BillingSubscriptionSnapshot,
} from "./billing.js";
import { PLAN_ENTITLEMENTS, resolveEntitlements, USER_PLANS } from "./entitlements.js";

/**
 * Billing and entitlements are separate mechanisms, and this suite is what keeps them that way.
 *
 * `docs/decisions/stripe-billing-v1.md` opens with the boundary: Stripe owns billing state and
 * money movement, FactorSage owns product entitlements. The failure mode it forbids is subtle and
 * one-directional — nobody would put a Stripe SDK import in the entitlement resolver, but it is
 * genuinely tempting to answer "how many lists does Pro allow" inside the code that reads a Stripe
 * subscription, and the moment that happens the product matrix has two homes.
 *
 * Three properties are asserted:
 *
 * 1. The billing module carries no entitlement value and no entitlement vocabulary.
 * 2. The entitlement module has no dependency on billing — so entitlements keep working with no
 *    Stripe configured at all, which is how Entitlements V1 shipped before this feature existed.
 * 3. Billing produces nothing but a `UserPlan`. Its entire output surface onto product behaviour
 *    is that one column.
 */

const CONTRACTS_SRC = __dirname;

function source(file: string): string {
  return readFileSync(join(CONTRACTS_SRC, file), "utf8");
}

/**
 * The same file with comments removed.
 *
 * The vocabulary checks below are about *code*, not prose. `billing.ts` deliberately names the
 * entitlement resolver in its header comment — documenting where the boundary is, is the opposite
 * of crossing it — so scanning the raw text would forbid the very explanation that makes the rule
 * legible.
 */
function executableSource(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Words that mean "what a plan may do" rather than "what a plan costs". */
const ENTITLEMENT_VOCABULARY = [
  "maxSymbols",
  "maxActive",
  "maxSavedLists",
  "maxConcurrent",
  "historyYears",
  "canCreateCustom",
  "canEnableMonitor",
  "canRunLiveBacktest",
  "resolveEntitlements",
  "PLAN_ENTITLEMENTS",
  "EntitlementLimit",
];

describe("billing carries no entitlement values", () => {
  const billing = source("billing.ts");

  it("does not import the entitlement matrix beyond the plan type itself", () => {
    // One import is legitimate and necessary: `UserPlan`, the column billing writes. Anything else
    // from `entitlements.js` would mean a limit or capability leaked into billing code.
    const imports = [...billing.matchAll(/import\s+type\s*\{([^}]*)\}\s*from\s*"\.\/entitlements\.js"/g)];
    expect(imports).toHaveLength(1);
    const imported = (imports[0]?.[1] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    expect(imported).toEqual(["UserPlan"]);
  });

  it("mentions no capability or limit vocabulary", () => {
    const code = executableSource("billing.ts");
    for (const term of ENTITLEMENT_VOCABULARY) {
      expect(
        code.includes(term),
        `billing.ts code mentions the entitlement concept \`${term}\``,
      ).toBe(false);
    }
  });

  it("carries no numeric product capacity", () => {
    // Money is the only number billing is allowed to know. Every numeric literal in a catalog
    // entry is an amount in cents, and nothing else in the module holds a product bound.
    const amounts = BILLING_CATALOG_ENTRIES.map((entry) => entry.amountMinorUnits);
    expect(amounts).toEqual([900, 9_900, 2_900, 29_900]);

    for (const entry of BILLING_CATALOG_ENTRIES) {
      const keys = Object.keys(entry).sort();
      expect(keys).toEqual([
        "amountMinorUnits",
        "currency",
        "interval",
        "key",
        "lookupKey",
        "plan",
      ]);
    }
  });

  it("has no Stripe SDK dependency in the shared module", () => {
    // `@intrinsic/contracts` is what the browser imports. A Stripe type here would drag the SDK
    // into the web bundle and couple the entitlement resolver's own package to a biller.
    expect(billing).not.toMatch(/from\s*"stripe"/);
    expect(billing).not.toMatch(/@stripe\//);
    expect(billing.toLowerCase()).not.toContain("stripe.subscription");
  });
});

describe("entitlements have no dependency on billing", () => {
  it("imports nothing from the billing module", () => {
    const code = executableSource("entitlements.ts");
    expect(code).not.toContain('"./billing.js"');
    expect(code).not.toContain("BILLING_");
    expect(code).not.toContain("BillingSubscription");
  });

  it("resolves every plan's entitlements with no billing state at hand", () => {
    // The whole point: a plan column is sufficient. No subscription, customer, invoice or Stripe
    // call participates in an authorization answer.
    for (const plan of USER_PLANS) {
      const resolved = resolveEntitlements({
        kind: "AUTHENTICATED",
        userId: "user-1",
        plan,
        role: "USER",
      });
      expect(resolved).toEqual(PLAN_ENTITLEMENTS[plan]);
    }
  });
});

describe("billing's only output onto product behaviour is a plan", () => {
  it("resolves to a UserPlan and nothing else", () => {
    const snapshots: BillingSubscriptionSnapshot[] = [
      { status: "ACTIVE", plan: "PRO", interval: "MONTH" },
      { status: "PAST_DUE", plan: "STARTER", interval: "YEAR" },
      { status: "CANCELED", plan: "PRO", interval: "MONTH" },
      { status: "INCOMPLETE", plan: "STARTER", interval: "MONTH" },
    ];

    for (const snapshot of snapshots) {
      const decision = resolveEffectivePlan(snapshot);
      expect(Object.keys(decision).sort()).toEqual([
        "anomalous",
        "plan",
        "reason",
      ]);
      expect(USER_PLANS as readonly string[]).toContain(decision.plan);
    }
  });

  it("can never resolve to a role", () => {
    // Stripe must never add or remove ADMIN (decision document section 29). There is no role in
    // the decision's shape at all, which is the structural version of that rule.
    for (const status of ["ACTIVE", "PAST_DUE", "CANCELED"] as const) {
      const decision = resolveEffectivePlan({
        status,
        plan: "PRO",
        interval: "MONTH",
      });
      expect(decision).not.toHaveProperty("role");
      expect(decision.plan).not.toBe("ADMIN");
    }
  });
});
