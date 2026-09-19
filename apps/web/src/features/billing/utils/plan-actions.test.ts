import {
  BILLING_CATALOG_ENTRIES,
  type BillingInterval,
  type BillingStatusResponse,
  type BillingSubscriptionView,
  type UserPlan,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import {
  currentPriceKeyOf,
  guestPlanCardState,
  planCardState,
} from "./plan-actions";

/**
 * What each plan card's button offers, per billing state.
 *
 * These are product rules from `docs/decisions/stripe-billing-v1.md`, not styling: a button that
 * says "Upgrade" must request an immediate change and a button that says "Downgrade" must request
 * a scheduled one, Free must never be a purchase, and a subscribed-but-unpaid price must never be
 * presented as the current plan.
 */

function status(
  overrides: Partial<BillingStatusResponse> = {},
): BillingStatusResponse {
  return {
    plan: "FREE",
    billingEnabled: true,
    subscription: null,
    canStartCheckout: true,
    canOpenPortal: false,
    canChangePlan: false,
    catalog: BILLING_CATALOG_ENTRIES,
    ...overrides,
  };
}

function subscribed(
  plan: Exclude<UserPlan, "FREE">,
  interval: BillingInterval,
  overrides: Partial<BillingSubscriptionView> = {},
): BillingStatusResponse {
  return status({
    plan,
    canStartCheckout: false,
    canOpenPortal: true,
    canChangePlan: true,
    subscription: {
      plan,
      interval,
      status: "ACTIVE",
      currentPeriodEnd: "2026-10-12T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      cancelAt: null,
      pendingChange: null,
      ...overrides,
    },
  });
}

function state(
  plan: UserPlan,
  interval: BillingInterval,
  billing: BillingStatusResponse,
) {
  return planCardState({ plan, interval, billing });
}

describe("plan card actions", () => {
  it("marks the persisted plan as current and disables its action", () => {
    const billing = status();
    expect(state("FREE", "MONTH", billing).current).toBe(true);
    expect(state("FREE", "MONTH", billing).action).toEqual({
      kind: "CURRENT",
      label: "Current plan",
    });
    expect(state("STARTER", "MONTH", billing).current).toBe(false);
  });

  it("sends a Free user to checkout with the price key for the selected cadence", () => {
    const billing = status();

    expect(state("STARTER", "MONTH", billing).action).toEqual({
      kind: "CHECKOUT",
      label: "Upgrade to Starter",
      priceKey: "STARTER_MONTHLY",
    });
    expect(state("STARTER", "YEAR", billing).action).toEqual({
      kind: "CHECKOUT",
      label: "Upgrade to Starter",
      priceKey: "STARTER_YEARLY",
    });
    expect(state("PRO", "YEAR", billing).action).toEqual({
      kind: "CHECKOUT",
      label: "Upgrade to Pro",
      priceKey: "PRO_YEARLY",
    });
  });

  it("never offers Free as a purchase", () => {
    for (const billing of [status(), subscribed("PRO", "MONTH")]) {
      const action = state("FREE", "MONTH", billing).action;
      expect(action.kind).not.toBe("CHECKOUT");
      expect(action.kind).not.toBe("CHANGE");
    }
  });

  it("routes a subscriber's move to Free through the Customer Portal, at period end", () => {
    const free = state("FREE", "MONTH", subscribed("PRO", "MONTH"));

    expect(free.action).toEqual({ kind: "PORTAL", label: "Cancel subscription" });
    expect(free.effectHint).toBe("Takes effect at your next renewal");
  });

  it("offers nothing on Free when the cancellation is already scheduled", () => {
    const billing = subscribed("STARTER", "MONTH", {
      cancelAtPeriodEnd: true,
      cancelAt: "2026-10-12T00:00:00.000Z",
    });
    const free = state("FREE", "MONTH", billing);

    expect(free.action).toEqual({ kind: "NONE" });
    expect(free.effectHint).toBe("Scheduled at the end of your current period");
  });

  it("offers no plan change while a cancellation is scheduled, because the API refuses one", () => {
    const billing = subscribed("PRO", "MONTH", {
      cancelAtPeriodEnd: true,
      cancelAt: "2026-10-12T00:00:00.000Z",
    });

    const starter = state("STARTER", "MONTH", billing);
    expect(starter.action).toEqual({ kind: "NONE" });
    expect(starter.effectHint).toBe(
      "Resume your subscription in Manage billing to change plan",
    );
    // The plan still held is still stated, without an action.
    expect(state("PRO", "MONTH", billing).action).toEqual({
      kind: "CURRENT",
      label: "Current plan",
    });
  });

  it("calls a tier increase an upgrade that happens now", () => {
    const pro = state("PRO", "MONTH", subscribed("STARTER", "MONTH"));

    expect(pro.action).toEqual({
      kind: "CHANGE",
      label: "Upgrade to Pro",
      priceKey: "PRO_MONTHLY",
      effect: "IMMEDIATE",
    });
    expect(pro.effectHint).toBe("Takes effect immediately");
  });

  it("calls a tier decrease a downgrade that happens at renewal", () => {
    const starter = state("STARTER", "MONTH", subscribed("PRO", "MONTH"));

    expect(starter.action).toEqual({
      kind: "CHANGE",
      label: "Downgrade to Starter",
      priceKey: "STARTER_MONTHLY",
      effect: "SCHEDULED",
    });
    expect(starter.effectHint).toBe("Takes effect at your next renewal");
  });

  it("lets tier direction beat cadence direction, exactly as the classifier does", () => {
    // Starter yearly -> Pro monthly shortens the cadence but buys more entitlement: immediate.
    expect(state("PRO", "MONTH", subscribed("STARTER", "YEAR")).action).toMatchObject({
      label: "Upgrade to Pro",
      effect: "IMMEDIATE",
    });
    // Pro monthly -> Starter yearly lengthens the cadence but buys less: scheduled.
    expect(state("STARTER", "YEAR", subscribed("PRO", "MONTH")).action).toMatchObject({
      label: "Downgrade to Starter",
      effect: "SCHEDULED",
    });
  });

  it("describes a same-tier cadence change as a switch, with the right timing", () => {
    const toYearly = state("STARTER", "YEAR", subscribed("STARTER", "MONTH"));
    expect(toYearly.action).toEqual({
      kind: "CHANGE",
      label: "Switch to yearly",
      priceKey: "STARTER_YEARLY",
      effect: "IMMEDIATE",
    });
    // The plan itself has not changed, so the card is still the current one.
    expect(toYearly.current).toBe(true);

    const toMonthly = state("PRO", "MONTH", subscribed("PRO", "YEAR"));
    expect(toMonthly.action).toEqual({
      kind: "CHANGE",
      label: "Switch to monthly",
      priceKey: "PRO_MONTHLY",
      effect: "SCHEDULED",
    });
  });

  it("does not re-offer a change Stripe has already scheduled", () => {
    const billing = subscribed("PRO", "YEAR", {
      pendingChange: {
        plan: "STARTER",
        interval: "YEAR",
        effectiveAt: "2027-09-14T00:00:00.000Z",
      },
    });

    const scheduled = state("STARTER", "YEAR", billing);
    expect(scheduled.action).toEqual({ kind: "NONE" });
    expect(scheduled.effectHint).toBe("Scheduled for your next renewal");

    // A *different* target is still offered — replacing a pending change is supported.
    expect(state("STARTER", "MONTH", billing).action).toMatchObject({
      kind: "CHANGE",
      priceKey: "STARTER_MONTHLY",
    });
    // And the plan the user still has is still marked current.
    expect(state("PRO", "YEAR", billing).action).toEqual({
      kind: "CURRENT",
      label: "Current plan",
    });
  });

  it("refuses to call an unpaid subscription the current plan", () => {
    // `incomplete` holds the paid slot while `User.plan` is still FREE. Claiming Starter here would
    // show a tier the entitlement guards would refuse.
    const billing = status({
      plan: "FREE",
      canStartCheckout: false,
      canChangePlan: true,
      canOpenPortal: true,
      subscription: {
        plan: "STARTER",
        interval: "MONTH",
        status: "INCOMPLETE",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        pendingChange: null,
      },
    });

    expect(state("FREE", "MONTH", billing).action).toEqual({
      kind: "CURRENT",
      label: "Current plan",
    });
    const starter = state("STARTER", "MONTH", billing);
    expect(starter.current).toBe(false);
    expect(starter.action).toEqual({ kind: "NONE" });
    expect(starter.effectHint).toBe("Waiting for payment confirmation");
  });

  it("keeps a plan granted without a subscription behind it purely informational", () => {
    // A seeded or administratively set plan. There is nothing to buy and nothing to change.
    const billing = status({ plan: "PRO" });

    expect(state("PRO", "MONTH", billing).action).toEqual({
      kind: "CURRENT",
      label: "Current plan",
    });
    expect(state("STARTER", "MONTH", billing).action).toMatchObject({
      kind: "CHECKOUT",
    });
  });

  it("offers no action at all when billing is not configured", () => {
    const billing = status({
      billingEnabled: false,
      canStartCheckout: false,
      canOpenPortal: false,
      canChangePlan: false,
    });

    expect(state("STARTER", "MONTH", billing).action).toEqual({ kind: "NONE" });
    expect(state("PRO", "YEAR", billing).action).toEqual({ kind: "NONE" });
    // The plan the user is on is still stated.
    expect(state("FREE", "MONTH", billing).action).toEqual({
      kind: "CURRENT",
      label: "Current plan",
    });
  });

  it("reads the live price key from the mirrored subscription", () => {
    expect(currentPriceKeyOf(status())).toBeNull();
    expect(currentPriceKeyOf(subscribed("PRO", "YEAR"))).toBe("PRO_YEARLY");
  });
});

describe("guest plan card state", () => {
  it("asks a Guest for an account on every card and never offers a purchase", () => {
    for (const plan of ["FREE", "STARTER", "PRO"] as const) {
      const card = guestPlanCardState(plan);
      expect(card.current).toBe(false);
      expect(card.action.kind).toBe("SIGN_IN");
      // No price key: nothing a Guest clicks can name a catalog price, let alone reach Checkout.
      expect(card.action).not.toHaveProperty("priceKey");
    }
  });

  it("labels each card by plan", () => {
    expect(guestPlanCardState("FREE").action).toEqual({
      kind: "SIGN_IN",
      label: "Start for free",
    });
    expect(guestPlanCardState("STARTER").action).toEqual({
      kind: "SIGN_IN",
      label: "Choose Starter",
    });
    expect(guestPlanCardState("PRO").action).toEqual({
      kind: "SIGN_IN",
      label: "Choose Pro",
    });
  });
});
