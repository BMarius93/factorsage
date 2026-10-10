import {
  BILLING_CATALOG,
  BILLING_PRICE_KEYS,
  occupiesPaidSlot,
  resolveEffectivePlan,
} from "@intrinsic/contracts";
import {
  BILLING_PERSONAS,
  BILLING_PERSONA_LIST,
  BILLING_PERSONA_NAMES,
  TEST_PERSONA_LIST,
  TEST_PERSONA_NAMES,
  billingPersonaByHandle,
} from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import { toMirroredStatus } from "../billing/stripe-gateway";

/**
 * The billing persona registry, held to the decision document.
 *
 * The expectations below are written out as literals on purpose, the way
 * `packages/contracts/src/billing.test.ts` writes the status policy out: a table derived from the
 * registry would pass whatever the registry said. The second half then checks the registry's own
 * literals against `resolveEffectivePlan`, so a persona cannot declare an outcome the product's one
 * plan decision does not produce.
 */
describe("billing QA persona registry", () => {
  it("declares exactly the five lifecycle personas", () => {
    expect([...BILLING_PERSONA_NAMES]).toEqual([
      "BILLING_STARTER_ACTIVE",
      "BILLING_PRO_ACTIVE",
      "BILLING_PRO_CANCELING",
      "BILLING_STARTER_PAST_DUE",
      "BILLING_CANCELED",
    ]);
    expect(BILLING_PERSONA_LIST.map((persona) => persona.name)).toEqual([
      ...BILLING_PERSONA_NAMES,
    ]);
  });

  it("states what each one is in Stripe and what FactorSage must make of it", () => {
    const declared = BILLING_PERSONA_LIST.map((persona) => ({
      name: persona.name,
      priceKey: persona.priceKey,
      lifecycle: persona.lifecycle,
      stripeStatus: persona.expected.stripeStatus,
      cancellationScheduled: persona.expected.cancellationScheduled,
      mirrorStatus: persona.expected.mirrorStatus,
      planReason: persona.expected.planReason,
      userPlan: persona.expected.userPlan,
    }));

    expect(declared).toEqual([
      {
        name: "BILLING_STARTER_ACTIVE",
        priceKey: "STARTER_YEARLY",
        lifecycle: "ACTIVE",
        stripeStatus: "active",
        cancellationScheduled: false,
        mirrorStatus: "ACTIVE",
        planReason: "SUBSCRIPTION_ACTIVE",
        userPlan: "STARTER",
      },
      {
        name: "BILLING_PRO_ACTIVE",
        priceKey: "PRO_MONTHLY",
        lifecycle: "ACTIVE",
        stripeStatus: "active",
        cancellationScheduled: false,
        mirrorStatus: "ACTIVE",
        planReason: "SUBSCRIPTION_ACTIVE",
        userPlan: "PRO",
      },
      {
        // Scheduled cancellation: the plan does not move until the period ends (section 10).
        name: "BILLING_PRO_CANCELING",
        priceKey: "PRO_YEARLY",
        lifecycle: "CANCELING",
        stripeStatus: "active",
        cancellationScheduled: true,
        mirrorStatus: "ACTIVE",
        planReason: "SUBSCRIPTION_ACTIVE",
        userPlan: "PRO",
      },
      {
        // past_due keeps the earned plan during Stripe's retry window (section 10).
        name: "BILLING_STARTER_PAST_DUE",
        priceKey: "STARTER_MONTHLY",
        lifecycle: "PAST_DUE",
        stripeStatus: "past_due",
        cancellationScheduled: false,
        mirrorStatus: "PAST_DUE",
        planReason: "SUBSCRIPTION_IN_RECOVERY",
        userPlan: "STARTER",
      },
      {
        // Actually canceled: FREE, whatever was subscribed (section 10).
        name: "BILLING_CANCELED",
        priceKey: "PRO_MONTHLY",
        lifecycle: "CANCELED",
        stripeStatus: "canceled",
        cancellationScheduled: false,
        mirrorStatus: "CANCELED",
        planReason: "SUBSCRIPTION_TERMINATED",
        userPlan: "FREE",
      },
    ]);
  });

  it("subscribes every persona to a catalog price, and between them to all four", () => {
    for (const persona of BILLING_PERSONA_LIST) {
      const entry = BILLING_CATALOG[persona.priceKey];
      expect(entry, persona.name).toBeDefined();
      // The plan and cadence a persona states are the catalog's, not a second opinion.
      expect(persona.subscribedPlan, persona.name).toBe(entry.plan);
      expect(persona.interval, persona.name).toBe(entry.interval);
    }
    expect(
      new Set(BILLING_PERSONA_LIST.map((persona) => persona.priceKey)),
    ).toEqual(new Set(BILLING_PRICE_KEYS));
  });

  it("declares only outcomes the product's one plan decision produces", () => {
    for (const persona of BILLING_PERSONA_LIST) {
      const { expected } = persona;
      // Stripe's status string maps to the declared mirrored status through the product's mapper.
      expect(toMirroredStatus(expected.stripeStatus), persona.name).toBe(
        expected.mirrorStatus,
      );

      const decision = resolveEffectivePlan({
        status: expected.mirrorStatus,
        plan: persona.subscribedPlan,
        interval: persona.interval,
      });
      expect(decision.plan, persona.name).toBe(expected.userPlan);
      expect(decision.reason, persona.name).toBe(expected.planReason);
      // None of these is a state an operator needs to look at.
      expect(decision.anomalous, persona.name).toBe(false);
      expect(occupiesPaidSlot(expected.mirrorStatus), persona.name).toBe(
        expected.holdsPaidSlot,
      );
    }
  });

  it("never declares a scheduled cancellation for a subscription that has ended", () => {
    for (const persona of BILLING_PERSONA_LIST) {
      if (!persona.expected.holdsPaidSlot) {
        expect(persona.expected.cancellationScheduled, persona.name).toBe(
          false,
        );
      }
    }
  });

  it("gives every persona its own reserved address, handle and storage state", () => {
    const unique = (values: readonly string[]) => new Set(values).size;
    const count = BILLING_PERSONA_LIST.length;

    expect(unique(BILLING_PERSONA_LIST.map((persona) => persona.email))).toBe(
      count,
    );
    expect(unique(BILLING_PERSONA_LIST.map((persona) => persona.slug))).toBe(
      count,
    );
    expect(
      unique(BILLING_PERSONA_LIST.map((persona) => persona.storageState)),
    ).toBe(count);

    for (const persona of BILLING_PERSONA_LIST) {
      // `.test` is reserved (RFC 2606): the address can never be somebody's mailbox.
      expect(persona.email).toMatch(/^qa-billing-[a-z-]+@factorsage\.test$/);
      expect(persona.email).toBe(persona.email.toLowerCase());
      expect(billingPersonaByHandle(persona.slug)).toBe(persona);
      expect(billingPersonaByHandle(persona.name)).toBe(persona);
    }
    expect(billingPersonaByHandle("pro")).toBeUndefined();
  });

  it("stays a separate set from the entitlement personas", () => {
    // The entitlement personas are untouched: still five, still seeded plans, still no Stripe.
    expect([...TEST_PERSONA_NAMES]).toEqual([
      "FREE_USER",
      "STARTER_USER",
      "PRO_USER",
      "ADMIN_USER",
      "DOWNGRADED_USER",
    ]);

    const entitlementNames = new Set<string>(TEST_PERSONA_NAMES);
    const entitlementStorage = new Set(
      TEST_PERSONA_LIST.map((persona) => persona.storageState),
    );
    const entitlementSlugs = new Set(
      TEST_PERSONA_LIST.map((persona) => persona.slug),
    );
    for (const persona of BILLING_PERSONA_LIST) {
      expect(persona.name.startsWith("BILLING_")).toBe(true);
      expect(entitlementNames.has(persona.name)).toBe(false);
      expect(entitlementStorage.has(persona.storageState)).toBe(false);
      expect(entitlementSlugs.has(persona.slug)).toBe(false);
    }
    expect(Object.keys(BILLING_PERSONAS)).toHaveLength(
      BILLING_PERSONA_NAMES.length,
    );
  });
});
