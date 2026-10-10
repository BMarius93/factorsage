import type { StripeBillingConfig } from "@intrinsic/config";
import { createLogger } from "@intrinsic/observability";
import { describe, expect, it } from "vitest";
import {
  StripeFixtureError,
  assertStripeTestModeKey,
  redactStripeCredentials,
} from "./stripe-fixture-gateway";
import { StripeTestModeFixtureGateway } from "./stripe.gateway";

/**
 * The test-mode guard on the fixture gateway. Offline: constructing the gateway reaches no network,
 * and a refusal happens before an SDK client exists.
 */

const logger = createLogger({
  service: "api",
  level: "silent",
  environment: "test",
  base: { component: "stripe-fixtures-test" },
});

function config(
  overrides: Partial<StripeBillingConfig> = {},
): StripeBillingConfig {
  return {
    secretKey: "sk_test_offline_only",
    webhookSecret: "whsec_offline_only",
    priceIds: {
      STARTER_MONTHLY: "price_starter_monthly",
      STARTER_YEARLY: "price_starter_yearly",
      PRO_MONTHLY: "price_pro_monthly",
      PRO_YEARLY: "price_pro_yearly",
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

describe("assertStripeTestModeKey", () => {
  it("accepts only sk_test_ and rk_test_ keys that are also flagged test mode", () => {
    expect(() =>
      assertStripeTestModeKey({ secretKey: "sk_test_x", testMode: true }),
    ).not.toThrow();
    expect(() =>
      assertStripeTestModeKey({ secretKey: "rk_test_x", testMode: true }),
    ).not.toThrow();
  });

  it.each([
    ["sk_live_x", true],
    ["rk_live_x", true],
    ["sk_live_x", false],
    ["sk_test_x", false],
    ["pk_test_x", true],
    ["whsec_x", true],
    ["", true],
  ])("refuses %s (testMode %s)", (secretKey, testMode) => {
    expect(() => assertStripeTestModeKey({ secretKey, testMode })).toThrow(
      StripeFixtureError,
    );
  });
});

describe("StripeTestModeFixtureGateway", () => {
  it("can be constructed for a sandbox", () => {
    expect(
      () => new StripeTestModeFixtureGateway(config(), logger),
    ).not.toThrow();
  });

  it("cannot be constructed with a live key, whatever the configuration claims", () => {
    for (const secretKey of ["sk_live_never", "rk_live_never"]) {
      for (const testMode of [true, false]) {
        expect(
          () =>
            new StripeTestModeFixtureGateway(
              config({ secretKey, testMode }),
              logger,
            ),
        ).toThrow(/not a test-mode key/);
      }
    }
  });

  it("refuses a subscription on a price outside the configured catalog, before any request", async () => {
    const gateway = new StripeTestModeFixtureGateway(config(), logger);
    await expect(
      gateway.createSubscription({
        customerId: "cus_offline",
        priceId: "price_somebody_elses",
        paymentMethodId: "pm_offline",
        metadata: {},
        idempotencyKey: "offline",
      }),
    ).rejects.toThrow(
      /not one of the four configured FactorSage catalog prices/,
    );
  });
});

describe("redactStripeCredentials", () => {
  it("removes anything shaped like a Stripe credential from a message", () => {
    const message =
      "Invalid API Key provided: sk_test_51Abc****************xyz9, " +
      "rk_live_abc123, whsec_deadbeef and pk_test_public";
    const redacted = redactStripeCredentials(message);

    expect(redacted).not.toMatch(/51Abc|xyz9|abc123|deadbeef|public/);
    expect(redacted).toContain("sk_<redacted>");
    expect(redacted).toContain("rk_<redacted>");
    expect(redacted).toContain("whsec_<redacted>");
  });

  it("leaves Stripe object ids alone", () => {
    const message =
      "No such customer: cus_exampleCustomer (sub_exampleSub, clock_exampleClock)";
    expect(redactStripeCredentials(message)).toBe(message);
  });
});
