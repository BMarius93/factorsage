import type { StripeBillingConfig } from "@intrinsic/config";
import { describe, expect, it } from "vitest";
import {
  BillingPersonaEnvironmentError,
  PRODUCTION_BILLING_PERSONA_MESSAGE,
  assertBillingPersonaStripeConfig,
  resolveBillingPersonaDatabase,
  resolveBillingPersonaPassword,
} from "./billing-persona-environment";
import { parseBillingPersonaArgs } from "./billing-persona-cli";

/**
 * The refusals are the feature: these commands create objects in Stripe and link them to accounts,
 * so every way of pointing them somewhere they must not act is asserted on its own.
 */

const DEV = "postgresql://user:secret@localhost:5432/intrinsic_value";
const TEST = "postgresql://user:secret@localhost:5432/intrinsic_value_test";

function config(
  overrides: Partial<StripeBillingConfig> = {},
): StripeBillingConfig {
  return {
    secretKey: "sk_test_offline",
    webhookSecret: "whsec_offline",
    priceIds: {
      STARTER_MONTHLY: "price_1",
      STARTER_YEARLY: "price_2",
      PRO_MONTHLY: "price_3",
      PRO_YEARLY: "price_4",
    },
    testMode: true,
    checkoutSuccessUrl: "http://localhost:3000/billing?checkout=success",
    checkoutCancelUrl: "http://localhost:3000/billing?checkout=cancelled",
    portalReturnUrl: "http://localhost:3000/billing",
    timeoutMs: 1_000,
    maxNetworkRetries: 0,
    ...overrides,
  };
}

describe("assertBillingPersonaStripeConfig", () => {
  it("accepts a standard and a restricted test-mode key", () => {
    expect(assertBillingPersonaStripeConfig(config(), {}).testMode).toBe(true);
    expect(() =>
      assertBillingPersonaStripeConfig(
        config({ secretKey: "rk_test_offline" }),
        {},
      ),
    ).not.toThrow();
  });

  it("refuses when Stripe is not configured at all", () => {
    expect(() => assertBillingPersonaStripeConfig(null, {})).toThrow(
      /Stripe billing is not configured/,
    );
  });

  it.each([
    ["a live secret key", "sk_live_abc"],
    ["a live restricted key", "rk_live_abc"],
    ["a publishable key", "pk_test_abc"],
    ["a key of no known shape", "not-a-stripe-key"],
    ["an empty key", ""],
  ])(
    "refuses %s, even when it is flagged as test mode",
    (_label, secretKey) => {
      expect(() =>
        assertBillingPersonaStripeConfig(
          config({ secretKey, testMode: true }),
          {},
        ),
      ).toThrow(/not a test-mode key/);
    },
  );

  it("refuses a test-looking key the configuration did not judge to be test mode", () => {
    expect(() =>
      assertBillingPersonaStripeConfig(config({ testMode: false }), {}),
    ).toThrow(/not a test-mode key/);
  });

  it("refuses production before looking at the key", () => {
    expect(() =>
      assertBillingPersonaStripeConfig(config(), { NODE_ENV: "production" }),
    ).toThrow(PRODUCTION_BILLING_PERSONA_MESSAGE);
  });

  it("never puts the key in a refusal", () => {
    const secretKey = "sk_live_do_not_print_me";
    try {
      assertBillingPersonaStripeConfig(config({ secretKey }), {});
      throw new Error("expected a refusal");
    } catch (error: unknown) {
      expect(String(error)).not.toContain(secretKey);
      expect(String(error)).not.toContain("do_not_print_me");
    }
  });
});

describe("resolveBillingPersonaDatabase", () => {
  it("resolves the development database through the QA persona guard", () => {
    const database = resolveBillingPersonaDatabase("dev", {
      DATABASE_URL: DEV,
    });
    expect(database).toMatchObject({
      target: "dev",
      databaseName: "intrinsic_value",
      host: "localhost",
      source: "DATABASE_URL",
    });
  });

  it("resolves the test database from TEST_DATABASE_URL only", () => {
    const database = resolveBillingPersonaDatabase("test", {
      DATABASE_URL: DEV,
      TEST_DATABASE_URL: TEST,
    });
    expect(database).toMatchObject({
      target: "test",
      databaseName: "intrinsic_value_test",
      source: "TEST_DATABASE_URL",
    });
    expect(() =>
      resolveBillingPersonaDatabase("test", { DATABASE_URL: DEV }),
    ).toThrow(/needs TEST_DATABASE_URL/);
  });

  it("refuses production for either target", () => {
    for (const target of ["dev", "test"] as const) {
      expect(() =>
        resolveBillingPersonaDatabase(target, {
          NODE_ENV: "production",
          DATABASE_URL: DEV,
          TEST_DATABASE_URL: TEST,
        }),
      ).toThrow(BillingPersonaEnvironmentError);
    }
  });

  it("refuses a database that is not on this machine", () => {
    expect(() =>
      resolveBillingPersonaDatabase("dev", {
        DATABASE_URL:
          "postgresql://user:secret@db.example.com:5432/intrinsic_value",
      }),
    ).toThrow(/not this machine/);
    expect(() =>
      resolveBillingPersonaDatabase("test", {
        TEST_DATABASE_URL:
          "postgresql://user:secret@db.example.com:5432/intrinsic_value_test",
      }),
    ).toThrow(/not this machine/);
  });

  it("refuses a test target that does not name a test database", () => {
    expect(() =>
      resolveBillingPersonaDatabase("test", { TEST_DATABASE_URL: DEV }),
    ).toThrow(/no `test` segment/);
    expect(() =>
      resolveBillingPersonaDatabase("test", {
        TEST_DATABASE_URL: "postgresql://user:secret@localhost:5432/contest",
      }),
    ).toThrow(/no `test` segment/);
  });

  it("refuses a test target that is the development database", () => {
    expect(() =>
      resolveBillingPersonaDatabase("test", {
        DATABASE_URL: TEST,
        TEST_DATABASE_URL: TEST,
      }),
    ).toThrow(/names the development database/);
  });

  it("accepts that equality only from a suite that swapped the URLs itself", () => {
    // What `useTestDatabase()` leaves behind: DATABASE_URL replaced by the test URL, and a marker.
    const database = resolveBillingPersonaDatabase("test", {
      DATABASE_URL: TEST,
      TEST_DATABASE_URL: TEST,
      INTRINSIC_TEST_DATABASE_ACTIVE: "true",
    });
    expect(database.databaseName).toBe("intrinsic_value_test");
    // The marker lifts that one check and no other.
    expect(() =>
      resolveBillingPersonaDatabase("test", {
        DATABASE_URL: DEV,
        TEST_DATABASE_URL: DEV,
        INTRINSIC_TEST_DATABASE_ACTIVE: "true",
      }),
    ).toThrow(/no `test` segment/);
  });

  it("refuses a malformed test URL without echoing a password", () => {
    expect(() =>
      resolveBillingPersonaDatabase("test", { TEST_DATABASE_URL: "not a url" }),
    ).toThrow(/not a valid URL/);
    expect(() =>
      resolveBillingPersonaDatabase("test", {
        TEST_DATABASE_URL: "mysql://user:secret@localhost:3306/app_test",
      }),
    ).toThrow(/postgresql:\/\//);
    try {
      resolveBillingPersonaDatabase("test", {
        TEST_DATABASE_URL:
          "postgresql://user:hunter2hunter2@db.example.com/app_test",
      });
      throw new Error("expected a refusal");
    } catch (error: unknown) {
      expect(String(error)).not.toContain("hunter2hunter2");
    }
  });
});

describe("resolveBillingPersonaPassword", () => {
  it("is optional", () => {
    expect(resolveBillingPersonaPassword({})).toBeNull();
    expect(
      resolveBillingPersonaPassword({ QA_BILLING_PASSWORD: "  " }),
    ).toBeNull();
  });

  it("holds a configured password to the product's own length policy", () => {
    expect(
      resolveBillingPersonaPassword({ QA_BILLING_PASSWORD: "twelve-chars" }),
    ).toBe("twelve-chars");
    expect(() =>
      resolveBillingPersonaPassword({ QA_BILLING_PASSWORD: "too-short" }),
    ).toThrow(/QA_BILLING_PASSWORD must be at least 12 characters/);
  });

  it("names the variable, never its value", () => {
    try {
      resolveBillingPersonaPassword({ QA_BILLING_PASSWORD: "shortpw" });
      throw new Error("expected a refusal");
    } catch (error: unknown) {
      expect(String(error)).not.toContain("shortpw");
    }
  });
});

describe("parseBillingPersonaArgs", () => {
  it("defaults to the development database and every persona", () => {
    const options = parseBillingPersonaArgs([], []);
    expect(options.database).toBe("dev");
    expect(options.personas).toHaveLength(5);
  });

  it("accepts pnpm's forwarded separator and both option spellings", () => {
    const options = parseBillingPersonaArgs(
      [
        "--",
        "--database",
        "test",
        "--persona=pro-active",
        "--persona",
        "CANCELED",
      ],
      [],
    );
    expect(options.database).toBe("test");
    expect(options.personas.map((persona) => persona.name)).toEqual([
      "BILLING_PRO_ACTIVE",
      "BILLING_CANCELED",
    ]);
  });

  it("refuses an unknown database, persona or flag instead of ignoring it", () => {
    expect(() => parseBillingPersonaArgs(["--database", "prod"], [])).toThrow(
      /--database must be dev or test/,
    );
    expect(() => parseBillingPersonaArgs(["--persona", "pro"], [])).toThrow(
      /Unknown billing persona 'pro'/,
    );
    // A mistyped --dry-run must never become a real cleanup.
    expect(() => parseBillingPersonaArgs(["--dryrun"], ["--dry-run"])).toThrow(
      /Unknown argument: --dryrun/,
    );
    expect(() => parseBillingPersonaArgs(["--database"], [])).toThrow(
      /needs a value/,
    );
  });

  it("does not let a cleanup be scoped by a persona name", () => {
    expect(() =>
      parseBillingPersonaArgs(["--persona", "canceled"], ["--yes"], {
        personas: false,
      }),
    ).toThrow(/Unknown argument: --persona/);
  });

  it("reports only the flags a command declared", () => {
    const options = parseBillingPersonaArgs(
      ["--dry-run", "--all-tagged"],
      ["--dry-run", "--yes", "--all-tagged"],
    );
    expect([...options.flags].sort()).toEqual(["--all-tagged", "--dry-run"]);
  });
});
