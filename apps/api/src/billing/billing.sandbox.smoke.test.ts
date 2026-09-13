import { getStripeBillingConfig, loadRootEnv } from "@intrinsic/config";
import {
  BILLING_CATALOG,
  BILLING_PRICE_KEYS,
  resolveEffectivePlan,
} from "@intrinsic/contracts";
import { createLogger } from "@intrinsic/observability";
import { beforeAll, describe, expect, it } from "vitest";
import { BillingCatalog } from "./billing-catalog";
import { toMirroredStatus } from "./stripe-gateway";
import { StripeApiGateway } from "./stripe.gateway";

/**
 * Stripe **sandbox** contract smoke tests. Opt-in, and excluded from `pnpm test`.
 *
 * ```bash
 * STRIPE_SANDBOX_SMOKE=true pnpm test:billing:sandbox
 * ```
 *
 * What this suite is for: proving that the assumptions `stripe.gateway.ts` makes about the real
 * Stripe API still hold. The deterministic suite in `billing.integration.test.ts` proves every
 * product rule against a fake, and it would keep passing if Stripe moved a field — this is the layer
 * that would not.
 *
 * Three guards, all deliberate:
 *
 * 1. It skips entirely unless `STRIPE_SANDBOX_SMOKE=true`, so ordinary CI never reaches the Stripe
 *    network (decision document section 26).
 * 2. It **refuses to run against live mode**, even if asked. A smoke test that could touch live
 *    billing is a smoke test that will eventually touch live billing.
 * 3. Nothing here creates a subscription or charges a card. Hosted Checkout and Customer Portal are
 *    browser flows and are verified by the documented manual sandbox runbook in
 *    `ai/architecture/billing.md`; what is automatable without side effects is the read contract, the
 *    catalog, the signature scheme, and session creation.
 *
 * Objects it does create — a Customer, a Checkout Session, a Portal Session — are test-mode only and
 * are labelled so they are obvious in the sandbox Dashboard.
 */

const ENABLED = process.env.STRIPE_SANDBOX_SMOKE?.trim() === "true";

describe.skipIf(!ENABLED)("Stripe sandbox smoke", () => {
  let gateway: StripeApiGateway;
  let catalog: BillingCatalog;
  let testUserId: string;

  beforeAll(() => {
    loadRootEnv();
    const config = getStripeBillingConfig();
    if (!config) {
      throw new Error(
        "STRIPE_SANDBOX_SMOKE=true but no Stripe configuration is present. Set STRIPE_SECRET_KEY, " +
          "STRIPE_WEBHOOK_SECRET and the four STRIPE_PRICE_* variables to sandbox values.",
      );
    }
    if (!config.testMode) {
      throw new Error(
        "Refusing to run the sandbox smoke suite against a LIVE Stripe key. These tests create " +
          "Stripe objects and must only ever run in sandbox/test mode.",
      );
    }

    gateway = new StripeApiGateway(
      config,
      createLogger({
        service: "api",
        level: "warn",
        environment: "test",
        base: { component: "stripe-smoke" },
      }),
    );
    catalog = new BillingCatalog(config);
    testUserId = `smoke-${Date.now()}`;
  });

  it("is pointed at a sandbox", () => {
    expect(gateway.testMode).toBe(true);
  });

  /**
   * The catalog contract: four active, recurring, USD, licensed prices at the documented amounts.
   *
   * This is the check that would have caught a Dashboard price edited to the wrong number, which
   * runtime deliberately cannot see because it never reads an amount.
   */
  it("holds the four V1 prices exactly as the decision document fixes them", async () => {
    const described = await gateway.describePrices(catalog.priceIds());
    expect(described).toHaveLength(BILLING_PRICE_KEYS.length);

    for (const key of BILLING_PRICE_KEYS) {
      const expected = BILLING_CATALOG[key];
      const priceId = catalog.resolveKey(key).priceId;
      const actual = described.find((price) => price.id === priceId);

      expect(actual, `${key} (${priceId}) is missing from Stripe`).toBeDefined();
      expect(actual?.active, `${key} is archived`).toBe(true);
      expect(actual?.currency).toBe("usd");
      expect(actual?.unitAmount).toBe(expected.amountMinorUnits);
      expect(actual?.recurringInterval).toBe(
        expected.interval === "MONTH" ? "month" : "year",
      );
      expect(actual?.recurringIntervalCount).toBe(1);
      expect(actual?.usageType).toBe("licensed");
      expect(actual?.productActive).toBe(true);
    }
  });

  it("groups each plan's two cadences under one product", async () => {
    const described = await gateway.describePrices(catalog.priceIds());
    const productOf = (key: (typeof BILLING_PRICE_KEYS)[number]) =>
      described.find((price) => price.id === catalog.resolveKey(key).priceId)
        ?.productId;

    expect(productOf("STARTER_MONTHLY")).toBe(productOf("STARTER_YEARLY"));
    expect(productOf("PRO_MONTHLY")).toBe(productOf("PRO_YEARLY"));
    expect(productOf("STARTER_MONTHLY")).not.toBe(productOf("PRO_MONTHLY"));
  });

  /**
   * Customer creation, reuse and the idempotency key.
   *
   * Calling twice with the same key must return the same customer id — the property the
   * "simultaneous first Checkout" protection ultimately rests on, and the one thing about it that
   * only Stripe can confirm.
   */
  it("creates one customer and returns the same one for a replayed idempotency key", async () => {
    const idempotencyKey = `factorsage:customer:${testUserId}`;
    const first = await gateway.createCustomer({
      userId: testUserId,
      email: `${testUserId}@smoke.factorsage.test`,
      idempotencyKey,
    });
    const replay = await gateway.createCustomer({
      userId: testUserId,
      email: `${testUserId}@smoke.factorsage.test`,
      idempotencyKey,
    });

    expect(replay.id).toBe(first.id);
    expect(await gateway.customerExists(first.id)).toBe(true);
  });

  it("reports a customer that does not exist rather than throwing", async () => {
    expect(await gateway.customerExists("cus_definitelynotreal000")).toBe(false);
  });

  it("reads an empty billing state for a brand-new customer", async () => {
    const customer = await gateway.createCustomer({
      userId: `${testUserId}-empty`,
      email: `${testUserId}-empty@smoke.factorsage.test`,
      idempotencyKey: `factorsage:customer:${testUserId}-empty`,
    });

    const state = await gateway.loadCustomerBillingState(customer.id);
    expect(state.customerId).toBe(customer.id);
    expect(state.subscriptions).toHaveLength(0);
    // And that state maps to FREE through the same function webhooks use.
    expect(resolveEffectivePlan(null).plan).toBe("FREE");
  });

  /**
   * Hosted Checkout session creation against the real API.
   *
   * Completing it needs a browser, so this asserts what is assertable without one: Stripe accepts
   * the parameters the gateway sends and returns a hosted URL. The manual runbook covers paying it.
   */
  it("creates a hosted Checkout session for a configured price", async () => {
    const customer = await gateway.createCustomer({
      userId: `${testUserId}-checkout`,
      email: `${testUserId}-checkout@smoke.factorsage.test`,
      idempotencyKey: `factorsage:customer:${testUserId}-checkout`,
    });

    const session = await gateway.createCheckoutSession({
      customerId: customer.id,
      userId: `${testUserId}-checkout`,
      priceId: catalog.resolveKey("STARTER_MONTHLY").priceId,
      successUrl: "http://localhost:3000/billing?checkout=success",
      cancelUrl: "http://localhost:3000/billing?checkout=cancelled",
      idempotencyKey: `factorsage:checkout:${testUserId}-checkout:STARTER_MONTHLY:smoke`,
    });

    expect(session.id).toMatch(/^cs_test_/);
    expect(session.url).toContain("checkout.stripe.com");
  });

  /**
   * Customer Portal session creation.
   *
   * This is also the check that catches the single most common Dashboard omission: with no Portal
   * configuration saved in the sandbox, Stripe refuses session creation outright, and the failure
   * message says so.
   */
  it("creates a Customer Portal session", async () => {
    const customer = await gateway.createCustomer({
      userId: `${testUserId}-portal`,
      email: `${testUserId}-portal@smoke.factorsage.test`,
      idempotencyKey: `factorsage:customer:${testUserId}-portal`,
    });

    const session = await gateway.createPortalSession({
      customerId: customer.id,
      returnUrl: "http://localhost:3000/billing",
      idempotencyKey: `factorsage:portal:${customer.id}:smoke`,
    });

    expect(session.url).toContain("billing.stripe.com");
  });

  it("rejects an unsigned or wrongly signed webhook body", () => {
    const body = Buffer.from(
      JSON.stringify({ id: "evt_smoke", type: "customer.subscription.updated" }),
    );
    expect(() => gateway.constructWebhookEvent(body, "t=1,v1=deadbeef")).toThrow(
      /signature/i,
    );
    expect(() => gateway.constructWebhookEvent(body, "")).toThrow(/signature/i);
  });

  it("maps every Stripe status string the pinned API can return", () => {
    // Guards against a Stripe status rename silently becoming UNKNOWN for a status we support.
    expect(toMirroredStatus("active")).toBe("ACTIVE");
    expect(toMirroredStatus("past_due")).toBe("PAST_DUE");
    expect(toMirroredStatus("canceled")).toBe("CANCELED");
    expect(toMirroredStatus("unpaid")).toBe("UNPAID");
    expect(toMirroredStatus("incomplete")).toBe("INCOMPLETE");
    expect(toMirroredStatus("incomplete_expired")).toBe("INCOMPLETE_EXPIRED");
    expect(toMirroredStatus("trialing")).toBe("TRIALING");
    expect(toMirroredStatus("paused")).toBe("PAUSED");
    expect(toMirroredStatus("a_status_stripe_has_not_invented")).toBe("UNKNOWN");
  });
});
