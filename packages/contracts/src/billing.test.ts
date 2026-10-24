import { describe, expect, it } from "vitest";
import {
  BILLING_CATALOG,
  BILLING_CATALOG_ENTRIES,
  BILLING_PRICE_KEYS,
  BILLING_SUBSCRIPTION_STATUSES,
  billingPlanRank,
  billingPriceKeyFor,
  classifyBillingTransition,
  findBillingPriceKey,
  isBillingInterval,
  isBillingPriceKey,
  isPaidPlan,
  occupiesPaidSlot,
  OFFERED_BILLING_INTERVALS,
  resolveEffectivePlan,
  type BillingPriceKey,
  type BillingSubscriptionStatus,
  type BillingTransitionEffect,
  type BillingTransitionKind,
  type PaidPlan,
} from "./billing.js";

/**
 * The billing rules of `docs/decisions/stripe-billing-v1.md`, number by number and case by case.
 *
 * Every expectation here is a **literal**. Nothing is derived from the implementation's own
 * catalog or its own classifier, because a test that imports the matrix it is checking agrees with
 * a wrong implementation just as readily as with a right one — the decision document (section 26)
 * asks for exactly this.
 */

describe("billing catalog", () => {
  it("is exactly the six prices: every paid plan monthly and yearly", () => {
    expect([...BILLING_PRICE_KEYS]).toEqual([
      "STARTER_MONTHLY",
      "STARTER_YEARLY",
      "PRO_MONTHLY",
      "PRO_YEARLY",
      "PRO_PLUS_MONTHLY",
      "PRO_PLUS_YEARLY",
    ]);
  });

  it("maps each key to the plan, interval and amount the owner fixed", () => {
    expect(BILLING_CATALOG.STARTER_MONTHLY.plan).toBe("STARTER");
    expect(BILLING_CATALOG.STARTER_MONTHLY.interval).toBe("MONTH");
    expect(BILLING_CATALOG.STARTER_MONTHLY.amountMinorUnits).toBe(1_900);

    expect(BILLING_CATALOG.STARTER_YEARLY.plan).toBe("STARTER");
    expect(BILLING_CATALOG.STARTER_YEARLY.interval).toBe("YEAR");
    expect(BILLING_CATALOG.STARTER_YEARLY.amountMinorUnits).toBe(16_900);

    expect(BILLING_CATALOG.PRO_MONTHLY.plan).toBe("PRO");
    expect(BILLING_CATALOG.PRO_MONTHLY.interval).toBe("MONTH");
    expect(BILLING_CATALOG.PRO_MONTHLY.amountMinorUnits).toBe(4_900);

    expect(BILLING_CATALOG.PRO_YEARLY.plan).toBe("PRO");
    expect(BILLING_CATALOG.PRO_YEARLY.interval).toBe("YEAR");
    expect(BILLING_CATALOG.PRO_YEARLY.amountMinorUnits).toBe(43_900);

    expect(BILLING_CATALOG.PRO_PLUS_MONTHLY.plan).toBe("PRO_PLUS");
    expect(BILLING_CATALOG.PRO_PLUS_MONTHLY.interval).toBe("MONTH");
    expect(BILLING_CATALOG.PRO_PLUS_MONTHLY.amountMinorUnits).toBe(19_900);

    expect(BILLING_CATALOG.PRO_PLUS_YEARLY.plan).toBe("PRO_PLUS");
    expect(BILLING_CATALOG.PRO_PLUS_YEARLY.interval).toBe("YEAR");
    expect(BILLING_CATALOG.PRO_PLUS_YEARLY.amountMinorUnits).toBe(179_000);
  });

  it("never sells a year at a retired V1 annual amount", () => {
    // $99 and $299 were the V1 Starter and Pro years ($9 and $29 the months). Their subscribers keep
    // them through STRIPE_LEGACY_PRICES; selling them again would undercut the owner's prices.
    const amounts = BILLING_CATALOG_ENTRIES.map((entry) => entry.amountMinorUnits);
    for (const retired of [900, 9_900, 2_900, 29_900]) {
      expect(amounts).not.toContain(retired);
    }
  });

  it("prices everything in USD", () => {
    for (const entry of BILLING_CATALOG_ENTRIES) {
      expect(entry.currency).toBe("usd");
    }
  });

  it("has no FREE price and no out-of-scope product", () => {
    const keys = BILLING_PRICE_KEYS as readonly string[];
    for (const forbidden of [
      "FREE",
      "FREE_MONTHLY",
      "FREE_YEARLY",
      "CREDIT_TOPUP",
      "CREDITS",
      "TRIAL",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(BILLING_CATALOG_ENTRIES).toHaveLength(6);
  });

  it("inverts to the one key for every plan and interval", () => {
    expect(billingPriceKeyFor("STARTER", "MONTH")).toBe("STARTER_MONTHLY");
    expect(billingPriceKeyFor("STARTER", "YEAR")).toBe("STARTER_YEARLY");
    expect(billingPriceKeyFor("PRO", "MONTH")).toBe("PRO_MONTHLY");
    expect(billingPriceKeyFor("PRO", "YEAR")).toBe("PRO_YEARLY");
    expect(billingPriceKeyFor("PRO_PLUS", "MONTH")).toBe("PRO_PLUS_MONTHLY");
    expect(billingPriceKeyFor("PRO_PLUS", "YEAR")).toBe("PRO_PLUS_YEARLY");
    expect(findBillingPriceKey("PRO_PLUS", "YEAR")).toBe("PRO_PLUS_YEARLY");
  });

  it("offers both cadences, because every paid plan is sold in each", () => {
    expect([...OFFERED_BILLING_INTERVALS]).toEqual(["MONTH", "YEAR"]);
  });

  it("rejects anything that is not a catalog key", () => {
    expect(isBillingPriceKey("STARTER_MONTHLY")).toBe(true);
    expect(isBillingPriceKey("STARTER_YEARLY")).toBe(true);
    expect(isBillingPriceKey("PRO_PLUS_YEARLY")).toBe(true);
    expect(isBillingPriceKey("price_1234567890")).toBe(false);
    expect(isBillingPriceKey("PRO")).toBe(false);
    expect(isBillingPriceKey("starter_monthly")).toBe(false);
    expect(isBillingPriceKey("PRO_PLUS_ANNUAL")).toBe(false);
    expect(isBillingPriceKey(undefined)).toBe(false);
    expect(isBillingPriceKey(null)).toBe(false);
    expect(isBillingPriceKey({ priceKey: "PRO_MONTHLY" })).toBe(false);
  });

  it("narrows paid plans and intervals", () => {
    expect(isPaidPlan("STARTER")).toBe(true);
    expect(isPaidPlan("PRO")).toBe(true);
    expect(isPaidPlan("PRO_PLUS")).toBe(true);
    expect(isPaidPlan("FREE")).toBe(false);
    expect(isPaidPlan("ADMIN")).toBe(false);
    expect(isPaidPlan("PRO+")).toBe(false);
    expect(isBillingInterval("MONTH")).toBe(true);
    expect(isBillingInterval("YEAR")).toBe(true);
    expect(isBillingInterval("month")).toBe(false);
    expect(isBillingInterval("WEEK")).toBe(false);
  });
});

describe("billing plan rank", () => {
  it("orders FREE < STARTER < PRO < PRO_PLUS", () => {
    expect(billingPlanRank("FREE")).toBe(0);
    expect(billingPlanRank("STARTER")).toBe(1);
    expect(billingPlanRank("PRO")).toBe(2);
    expect(billingPlanRank("PRO_PLUS")).toBe(3);
    expect(billingPlanRank("FREE")).toBeLessThan(billingPlanRank("STARTER"));
    expect(billingPlanRank("STARTER")).toBeLessThan(billingPlanRank("PRO"));
    expect(billingPlanRank("PRO")).toBeLessThan(billingPlanRank("PRO_PLUS"));
  });
});

describe("transition classification", () => {
  /**
   * Every ordered pair of the six prices, written out: 36 cases, no generation. Sections 7–9 of the
   * decision document: a higher tier is immediate and a lower one waits for the period end whatever
   * the cadences, and within one plan monthly → yearly is immediate while yearly → monthly waits
   * for the end of the paid year.
   */
  const CASES: readonly {
    from: BillingPriceKey;
    to: BillingPriceKey;
    kind: BillingTransitionKind;
    effect: BillingTransitionEffect;
  }[] = [
    // From Starter monthly: a year of Starter is an immediate cadence change; every higher tier, in either cadence, an immediate upgrade.
    { from: "STARTER_MONTHLY", to: "STARTER_MONTHLY", kind: "SAME_PRICE", effect: "UNCHANGED" },
    { from: "STARTER_MONTHLY", to: "STARTER_YEARLY", kind: "CADENCE_LENGTHENED", effect: "IMMEDIATE" },
    { from: "STARTER_MONTHLY", to: "PRO_MONTHLY", kind: "TIER_UPGRADE", effect: "IMMEDIATE" },
    { from: "STARTER_MONTHLY", to: "PRO_YEARLY", kind: "TIER_UPGRADE", effect: "IMMEDIATE" },
    { from: "STARTER_MONTHLY", to: "PRO_PLUS_MONTHLY", kind: "TIER_UPGRADE", effect: "IMMEDIATE" },
    { from: "STARTER_MONTHLY", to: "PRO_PLUS_YEARLY", kind: "TIER_UPGRADE", effect: "IMMEDIATE" },
    // From Starter yearly: back to monthly waits for the end of the paid year; an upgrade is immediate even onto a monthly price — tier beats interval.
    { from: "STARTER_YEARLY", to: "STARTER_MONTHLY", kind: "CADENCE_SHORTENED", effect: "SCHEDULED" },
    { from: "STARTER_YEARLY", to: "STARTER_YEARLY", kind: "SAME_PRICE", effect: "UNCHANGED" },
    { from: "STARTER_YEARLY", to: "PRO_MONTHLY", kind: "TIER_UPGRADE", effect: "IMMEDIATE" },
    { from: "STARTER_YEARLY", to: "PRO_YEARLY", kind: "TIER_UPGRADE", effect: "IMMEDIATE" },
    { from: "STARTER_YEARLY", to: "PRO_PLUS_MONTHLY", kind: "TIER_UPGRADE", effect: "IMMEDIATE" },
    { from: "STARTER_YEARLY", to: "PRO_PLUS_YEARLY", kind: "TIER_UPGRADE", effect: "IMMEDIATE" },
    // From Pro monthly: Starter in either cadence waits for the period end, even onto a yearly price — tier beats interval.
    { from: "PRO_MONTHLY", to: "STARTER_MONTHLY", kind: "TIER_DOWNGRADE", effect: "SCHEDULED" },
    { from: "PRO_MONTHLY", to: "STARTER_YEARLY", kind: "TIER_DOWNGRADE", effect: "SCHEDULED" },
    { from: "PRO_MONTHLY", to: "PRO_MONTHLY", kind: "SAME_PRICE", effect: "UNCHANGED" },
    { from: "PRO_MONTHLY", to: "PRO_YEARLY", kind: "CADENCE_LENGTHENED", effect: "IMMEDIATE" },
    { from: "PRO_MONTHLY", to: "PRO_PLUS_MONTHLY", kind: "TIER_UPGRADE", effect: "IMMEDIATE" },
    { from: "PRO_MONTHLY", to: "PRO_PLUS_YEARLY", kind: "TIER_UPGRADE", effect: "IMMEDIATE" },
    // From Pro yearly.
    { from: "PRO_YEARLY", to: "STARTER_MONTHLY", kind: "TIER_DOWNGRADE", effect: "SCHEDULED" },
    { from: "PRO_YEARLY", to: "STARTER_YEARLY", kind: "TIER_DOWNGRADE", effect: "SCHEDULED" },
    { from: "PRO_YEARLY", to: "PRO_MONTHLY", kind: "CADENCE_SHORTENED", effect: "SCHEDULED" },
    { from: "PRO_YEARLY", to: "PRO_YEARLY", kind: "SAME_PRICE", effect: "UNCHANGED" },
    { from: "PRO_YEARLY", to: "PRO_PLUS_MONTHLY", kind: "TIER_UPGRADE", effect: "IMMEDIATE" },
    { from: "PRO_YEARLY", to: "PRO_PLUS_YEARLY", kind: "TIER_UPGRADE", effect: "IMMEDIATE" },
    // From Pro+ monthly: every lower tier waits; a year of Pro+ is immediate.
    { from: "PRO_PLUS_MONTHLY", to: "STARTER_MONTHLY", kind: "TIER_DOWNGRADE", effect: "SCHEDULED" },
    { from: "PRO_PLUS_MONTHLY", to: "STARTER_YEARLY", kind: "TIER_DOWNGRADE", effect: "SCHEDULED" },
    { from: "PRO_PLUS_MONTHLY", to: "PRO_MONTHLY", kind: "TIER_DOWNGRADE", effect: "SCHEDULED" },
    { from: "PRO_PLUS_MONTHLY", to: "PRO_YEARLY", kind: "TIER_DOWNGRADE", effect: "SCHEDULED" },
    { from: "PRO_PLUS_MONTHLY", to: "PRO_PLUS_MONTHLY", kind: "SAME_PRICE", effect: "UNCHANGED" },
    { from: "PRO_PLUS_MONTHLY", to: "PRO_PLUS_YEARLY", kind: "CADENCE_LENGTHENED", effect: "IMMEDIATE" },
    // From Pro+ yearly: back to monthly waits for the end of the paid year.
    { from: "PRO_PLUS_YEARLY", to: "STARTER_MONTHLY", kind: "TIER_DOWNGRADE", effect: "SCHEDULED" },
    { from: "PRO_PLUS_YEARLY", to: "STARTER_YEARLY", kind: "TIER_DOWNGRADE", effect: "SCHEDULED" },
    { from: "PRO_PLUS_YEARLY", to: "PRO_MONTHLY", kind: "TIER_DOWNGRADE", effect: "SCHEDULED" },
    { from: "PRO_PLUS_YEARLY", to: "PRO_YEARLY", kind: "TIER_DOWNGRADE", effect: "SCHEDULED" },
    { from: "PRO_PLUS_YEARLY", to: "PRO_PLUS_MONTHLY", kind: "CADENCE_SHORTENED", effect: "SCHEDULED" },
    { from: "PRO_PLUS_YEARLY", to: "PRO_PLUS_YEARLY", kind: "SAME_PRICE", effect: "UNCHANGED" },
  ];

  it("covers every ordered pair of the six prices", () => {
    expect(CASES).toHaveLength(BILLING_PRICE_KEYS.length ** 2);
    expect(new Set(CASES.map((testCase) => `${testCase.from}>${testCase.to}`)).size).toBe(36);
  });

  for (const testCase of CASES) {
    it(`${testCase.from} -> ${testCase.to} is ${testCase.kind}/${testCase.effect}`, () => {
      const transition = classifyBillingTransition(testCase.from, testCase.to);
      expect(transition.kind).toBe(testCase.kind);
      expect(transition.effect).toBe(testCase.effect);
      expect(transition.from).toBe(testCase.from);
      expect(transition.to).toBe(testCase.to);
    });
  }
});

describe("effective plan", () => {
  function snapshot(
    status: BillingSubscriptionStatus,
    plan: PaidPlan | null = "PRO",
  ) {
    return { status, plan, interval: plan === null ? null : ("MONTH" as const) };
  }

  it("is FREE with no subscription", () => {
    const decision = resolveEffectivePlan(null);
    expect(decision.plan).toBe("FREE");
    expect(decision.reason).toBe("NO_SUBSCRIPTION");
    expect(decision.anomalous).toBe(false);
  });

  it("grants the subscribed plan while active", () => {
    expect(resolveEffectivePlan(snapshot("ACTIVE", "STARTER"))).toEqual({
      plan: "STARTER",
      reason: "SUBSCRIPTION_ACTIVE",
      anomalous: false,
    });
    expect(resolveEffectivePlan(snapshot("ACTIVE", "PRO"))).toEqual({
      plan: "PRO",
      reason: "SUBSCRIPTION_ACTIVE",
      anomalous: false,
    });
  });

  it("keeps the earned plan while Stripe recovers a failed renewal", () => {
    expect(resolveEffectivePlan(snapshot("PAST_DUE", "PRO"))).toEqual({
      plan: "PRO",
      reason: "SUBSCRIPTION_IN_RECOVERY",
      anomalous: false,
    });
  });

  it("never grants a plan for an incomplete first payment", () => {
    expect(resolveEffectivePlan(snapshot("INCOMPLETE", "PRO"))).toEqual({
      plan: "FREE",
      reason: "SUBSCRIPTION_INCOMPLETE",
      anomalous: false,
    });
  });

  it("is FREE in every terminal state", () => {
    for (const status of ["INCOMPLETE_EXPIRED", "CANCELED", "UNPAID"] as const) {
      expect(resolveEffectivePlan(snapshot(status, "PRO"))).toEqual({
        plan: "FREE",
        reason: "SUBSCRIPTION_TERMINATED",
        anomalous: false,
      });
    }
  });

  it("is FREE and loud for statuses V1 does not sell", () => {
    for (const status of ["TRIALING", "PAUSED", "UNKNOWN"] as const) {
      expect(resolveEffectivePlan(snapshot(status, "PRO"))).toEqual({
        plan: "FREE",
        reason: "SUBSCRIPTION_UNSUPPORTED_STATUS",
        anomalous: true,
      });
    }
  });

  it("fails closed on a price outside the catalog, whatever the status", () => {
    for (const status of BILLING_SUBSCRIPTION_STATUSES) {
      const decision = resolveEffectivePlan(snapshot(status, null));
      expect(decision.plan).toBe("FREE");
      expect(decision.reason).toBe("PRICE_NOT_IN_CATALOG");
      expect(decision.anomalous).toBe(true);
    }
  });

  it("handles every mirrored status explicitly", () => {
    // No permissive default: every status resolves to a plan and a named reason.
    for (const status of BILLING_SUBSCRIPTION_STATUSES) {
      const decision = resolveEffectivePlan(snapshot(status, "STARTER"));
      expect(["FREE", "STARTER"]).toContain(decision.plan);
      expect(decision.reason).toBeTruthy();
    }
  });

  it("never grants PRO from a STARTER subscription", () => {
    for (const status of BILLING_SUBSCRIPTION_STATUSES) {
      expect(resolveEffectivePlan(snapshot(status, "STARTER")).plan).not.toBe(
        "PRO",
      );
    }
  });
});

describe("paid slot occupancy", () => {
  it("holds the slot while a subscription is live or still settling", () => {
    for (const status of [
      "ACTIVE",
      "PAST_DUE",
      "TRIALING",
      "PAUSED",
      "INCOMPLETE",
      "UNKNOWN",
    ] as const) {
      expect(occupiesPaidSlot(status)).toBe(true);
    }
  });

  it("releases the slot once the subscription is terminal", () => {
    for (const status of ["INCOMPLETE_EXPIRED", "CANCELED", "UNPAID"] as const) {
      expect(occupiesPaidSlot(status)).toBe(false);
    }
  });

  it("holds the slot for an incomplete subscription that grants nothing", () => {
    // The two questions are different, and this is the pair that shows it: an outstanding Checkout
    // attempt gives no entitlement, but starting a second one is how a user ends up paying twice.
    expect(resolveEffectivePlan({ status: "INCOMPLETE", plan: "PRO", interval: "MONTH" }).plan).toBe("FREE");
    expect(occupiesPaidSlot("INCOMPLETE")).toBe(true);
  });
});
