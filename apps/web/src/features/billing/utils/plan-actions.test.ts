import {
  BILLING_CATALOG_ENTRIES,
  OFFERED_BILLING_INTERVALS,
  USER_PLANS,
  type BillingInterval,
  type BillingStatusResponse,
  type BillingSubscriptionView,
  type PaidPlan,
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
 * says "Upgrade" must request an immediate change and one that switches a subscriber to a lower
 * tier must request a scheduled one, Free must never be a purchase, and a subscribed-but-unpaid
 * price must never be presented as the current plan.
 *
 * The catalog sells monthly prices only (`OFFERED_BILLING_INTERVALS`), so every card is shown
 * monthly. A subscription can still be *billed* on a retired yearly price; that case has its own
 * block below.
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
  plan: PaidPlan,
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
    expect(state("PRO_PLUS", "MONTH", billing).current).toBe(false);
  });

  it("sends a Free user to checkout with each plan's monthly price key", () => {
    const billing = status();

    expect(state("STARTER", "MONTH", billing).action).toEqual({
      kind: "CHECKOUT",
      label: "Upgrade to Starter",
      priceKey: "STARTER_MONTHLY",
    });
    expect(state("PRO", "MONTH", billing).action).toEqual({
      kind: "CHECKOUT",
      label: "Upgrade to Pro",
      priceKey: "PRO_MONTHLY",
    });
    expect(state("PRO_PLUS", "MONTH", billing).action).toEqual({
      kind: "CHECKOUT",
      label: "Upgrade to Pro+",
      priceKey: "PRO_PLUS_MONTHLY",
    });
  });

  it("never offers Free as a purchase", () => {
    for (const billing of [
      status(),
      subscribed("PRO", "MONTH"),
      subscribed("PRO_PLUS", "MONTH"),
    ]) {
      const action = state("FREE", "MONTH", billing).action;
      expect(action.kind).not.toBe("CHECKOUT");
      expect(action.kind).not.toBe("CHANGE");
    }
  });

  it("routes a subscriber's move to Free through the Customer Portal, at period end", () => {
    for (const plan of ["STARTER", "PRO", "PRO_PLUS"] as const) {
      const free = state("FREE", "MONTH", subscribed(plan, "MONTH"));

      expect(free.action, plan).toEqual({ kind: "PORTAL", label: "Cancel subscription" });
      expect(free.effectHint, plan).toBe("Takes effect at your next renewal");
    }
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

    for (const plan of ["STARTER", "PRO_PLUS"] as const) {
      const card = state(plan, "MONTH", billing);
      expect(card.action, plan).toEqual({ kind: "NONE" });
      expect(card.effectHint, plan).toBe(
        "Resume your subscription in Manage billing to change plan",
      );
    }
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

    const proPlus = state("PRO_PLUS", "MONTH", subscribed("PRO", "MONTH"));
    expect(proPlus.action).toEqual({
      kind: "CHANGE",
      label: "Upgrade to Pro+",
      priceKey: "PRO_PLUS_MONTHLY",
      effect: "IMMEDIATE",
    });
    expect(proPlus.effectHint).toBe("Takes effect immediately");
  });

  it("calls a tier decrease a switch that happens at renewal", () => {
    const starter = state("STARTER", "MONTH", subscribed("PRO", "MONTH"));
    expect(starter.action).toEqual({
      kind: "CHANGE",
      label: "Switch to Starter",
      priceKey: "STARTER_MONTHLY",
      effect: "SCHEDULED",
    });
    expect(starter.effectHint).toBe("Takes effect at your next renewal");

    const pro = state("PRO", "MONTH", subscribed("PRO_PLUS", "MONTH"));
    expect(pro.action).toEqual({
      kind: "CHANGE",
      label: "Switch to Pro",
      priceKey: "PRO_MONTHLY",
      effect: "SCHEDULED",
    });
    expect(pro.effectHint).toBe("Takes effect at your next renewal");
  });

  it("does not re-offer a change Stripe has already scheduled", () => {
    const billing = subscribed("PRO_PLUS", "MONTH", {
      pendingChange: {
        plan: "STARTER",
        interval: "MONTH",
        effectiveAt: "2026-10-12T00:00:00.000Z",
      },
    });

    const scheduled = state("STARTER", "MONTH", billing);
    expect(scheduled.action).toEqual({ kind: "NONE" });
    expect(scheduled.effectHint).toBe("Scheduled for your next renewal");

    // A *different* target is still offered — replacing a pending change is supported.
    expect(state("PRO", "MONTH", billing).action).toMatchObject({
      kind: "CHANGE",
      priceKey: "PRO_MONTHLY",
      effect: "SCHEDULED",
    });
    // And the plan the user still has is still marked current.
    expect(state("PRO_PLUS", "MONTH", billing).action).toEqual({
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
    // Checkout is still the only way such an account buys anything, but Starter is below Pro:
    // it is a switch, never an "upgrade" (the comped-Pro case from the 2026-09-18 audit).
    expect(state("STARTER", "MONTH", billing).action).toEqual({
      kind: "CHECKOUT",
      label: "Switch to Starter",
      priceKey: "STARTER_MONTHLY",
    });
    // Pro+ is above it, and is an upgrade.
    expect(state("PRO_PLUS", "MONTH", billing).action).toEqual({
      kind: "CHECKOUT",
      label: "Upgrade to Pro+",
      priceKey: "PRO_PLUS_MONTHLY",
    });
    // And there is no subscription for Free to cancel.
    expect(state("FREE", "MONTH", billing).action).toEqual({ kind: "NONE" });
  });

  it("offers no action at all when billing is not configured", () => {
    const billing = status({
      billingEnabled: false,
      canStartCheckout: false,
      canOpenPortal: false,
      canChangePlan: false,
    });

    for (const plan of ["STARTER", "PRO", "PRO_PLUS"] as const) {
      expect(state(plan, "MONTH", billing).action, plan).toEqual({ kind: "NONE" });
    }
    // The plan the user is on is still stated.
    expect(state("FREE", "MONTH", billing).action).toEqual({
      kind: "CURRENT",
      label: "Current plan",
    });
  });

  it("reads the live price key from the mirrored subscription", () => {
    expect(currentPriceKeyOf(status())).toBeNull();
    expect(currentPriceKeyOf(subscribed("PRO", "MONTH"))).toBe("PRO_MONTHLY");
    expect(currentPriceKeyOf(subscribed("PRO_PLUS", "MONTH"))).toBe("PRO_PLUS_MONTHLY");
    // A retired cadence has no catalog price, so there is no key for any card to claim.
    expect(currentPriceKeyOf(subscribed("PRO", "YEAR"))).toBeNull();
  });
});

/**
 * A subscriber still billed on a yearly price the catalog no longer sells.
 *
 * Their plan is theirs — `User.plan` says so, and that is what marks a card current — and the cards
 * are shown at today's monthly prices. What no card may do is offer a change *from* the retired
 * price: there is no catalog key to classify the move with, and the API refuses a change from a
 * price it does not recognise. Cancelling stays possible, because the subscription is live.
 */
describe("a legacy yearly subscription", () => {
  const billing = subscribed("PRO", "YEAR");

  it("renders every monthly card without throwing", () => {
    for (const plan of USER_PLANS) {
      for (const interval of OFFERED_BILLING_INTERVALS) {
        expect(() => state(plan, interval, billing), plan).not.toThrow();
      }
    }
  });

  it("keeps the plan marked current through billing.plan", () => {
    const pro = state("PRO", "MONTH", billing);
    expect(pro.current).toBe(true);
    expect(pro.action).toEqual({ kind: "CURRENT", label: "Current plan" });
  });

  it("offers no change it could not classify, and still lets the subscription be cancelled", () => {
    for (const plan of ["STARTER", "PRO_PLUS"] as const) {
      const card = state(plan, "MONTH", billing);
      expect(card.current, plan).toBe(false);
      expect(card.action, plan).toEqual({ kind: "NONE" });
    }
    expect(state("FREE", "MONTH", billing).action).toEqual({
      kind: "PORTAL",
      label: "Cancel subscription",
    });
  });
});

describe("guest plan card state", () => {
  it("asks a Guest for an account on every card and never offers a purchase", () => {
    for (const plan of USER_PLANS) {
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
    expect(guestPlanCardState("PRO_PLUS").action).toEqual({
      kind: "SIGN_IN",
      label: "Choose Pro+",
    });
  });
});

/**
 * The CTA matrix, card by card, for each tier a user can be on (BILLING-CTA).
 *
 * The verb is decided by the card's tier against the user's: the same tier is the current plan, a
 * higher paid tier is an upgrade, a lower paid tier is a switch, and Free from a paid subscription
 * is the cancellation. A Pro subscriber's Starter card once read "Upgrade to Starter"; this table
 * is what keeps that from coming back, for every tier including Pro+.
 */
describe("plan card CTA matrix", () => {
  const PLANS = USER_PLANS;
  const RENEWAL = "Takes effect at your next renewal";
  const IMMEDIATE = "Takes effect immediately";

  type Expected = {
    readonly label: string | null;
    readonly hint: string | null;
  };

  /** Card → CTA, for a user on `current` with a live subscription (or none, on Free). */
  const MATRIX: Record<UserPlan, Record<UserPlan, Expected>> = {
    FREE: {
      FREE: { label: "Current plan", hint: null },
      STARTER: { label: "Upgrade to Starter", hint: null },
      PRO: { label: "Upgrade to Pro", hint: null },
      PRO_PLUS: { label: "Upgrade to Pro+", hint: null },
    },
    STARTER: {
      FREE: { label: "Cancel subscription", hint: RENEWAL },
      STARTER: { label: "Current plan", hint: null },
      PRO: { label: "Upgrade to Pro", hint: IMMEDIATE },
      PRO_PLUS: { label: "Upgrade to Pro+", hint: IMMEDIATE },
    },
    PRO: {
      FREE: { label: "Cancel subscription", hint: RENEWAL },
      STARTER: { label: "Switch to Starter", hint: RENEWAL },
      PRO: { label: "Current plan", hint: null },
      PRO_PLUS: { label: "Upgrade to Pro+", hint: IMMEDIATE },
    },
    PRO_PLUS: {
      FREE: { label: "Cancel subscription", hint: RENEWAL },
      STARTER: { label: "Switch to Starter", hint: RENEWAL },
      PRO: { label: "Switch to Pro", hint: RENEWAL },
      PRO_PLUS: { label: "Current plan", hint: null },
    },
  };

  const labelOf = (card: ReturnType<typeof state>) =>
    card.action.kind === "NONE" ? null : card.action.label;

  /** Every billing state a user on `current` can be in with a live, sold price (or none). */
  function billingsFor(current: UserPlan) {
    return current === "FREE"
      ? [{ billed: "MONTH" as const, billing: status() }]
      : OFFERED_BILLING_INTERVALS.map((billed) => ({
          billed,
          billing: subscribed(current, billed),
        }));
  }

  for (const current of PLANS) {
    for (const { billed, billing } of billingsFor(current)) {
      for (const shown of OFFERED_BILLING_INTERVALS) {
        it(`${current} user billed ${billed}, ${shown} shown`, () => {
          for (const card of PLANS) {
            const result = state(card, shown, billing);
            const expected = MATRIX[current][card];
            expect(labelOf(result), card).toBe(expected.label);
            expect(result.effectHint, card).toBe(expected.hint);
            expect(result.current, card).toBe(card === current);
            if (expected.label === "Current plan") {
              // Rendered as a disabled button, never a live control.
              expect(result.action.kind, card).toBe("CURRENT");
            }
          }
        });
      }
    }
  }

  it("uses the same verbs for a plan granted without a subscription, minus the cancellation", () => {
    // Seeded and administratively set plans: Checkout is how they buy, and there is no
    // subscription for the Free card to cancel.
    const labels = (plan: UserPlan) =>
      PLANS.map((card) => labelOf(state(card, "MONTH", status({ plan }))));

    expect(labels("STARTER")).toEqual([
      null,
      "Current plan",
      "Upgrade to Pro",
      "Upgrade to Pro+",
    ]);
    expect(labels("PRO")).toEqual([
      null,
      "Switch to Starter",
      "Current plan",
      "Upgrade to Pro+",
    ]);
    expect(labels("PRO_PLUS")).toEqual([
      null,
      "Switch to Starter",
      "Switch to Pro",
      "Current plan",
    ]);
  });

  it("offers no cancellation for a subscription that has already ended", () => {
    // A granted Pro whose old subscription was cancelled: the Portal has nothing left to end.
    const billing = status({
      plan: "PRO",
      canOpenPortal: true,
      subscription: {
        plan: "PRO",
        interval: "MONTH",
        status: "CANCELED",
        currentPeriodEnd: "2026-10-14T00:00:00.000Z",
        cancelAtPeriodEnd: false,
        cancelAt: null,
        pendingChange: null,
      },
    });
    expect(PLANS.map((card) => labelOf(state(card, "MONTH", billing)))).toEqual(
      [null, "Switch to Starter", "Current plan", "Upgrade to Pro+"],
    );
  });

  it("never says Upgrade for a lower tier, or Switch to a plan for a higher one", () => {
    const billings = [
      status(),
      status({ plan: "STARTER" }),
      status({ plan: "PRO" }),
      status({ plan: "PRO_PLUS" }),
      ...OFFERED_BILLING_INTERVALS.flatMap((interval) => [
        subscribed("STARTER", interval),
        subscribed("PRO", interval),
        subscribed("PRO_PLUS", interval),
      ]),
    ];
    for (const billing of billings) {
      for (const card of ["STARTER", "PRO", "PRO_PLUS"] as const) {
        for (const shown of OFFERED_BILLING_INTERVALS) {
          const label = labelOf(state(card, shown, billing));
          const direction = Math.sign(
            PLANS.indexOf(card) - PLANS.indexOf(billing.plan),
          );
          if (direction < 0) {
            expect(label, `${billing.plan} → ${card}`).not.toMatch(/^Upgrade/);
          }
          if (direction > 0) {
            expect(label, `${billing.plan} → ${card}`).toMatch(/^Upgrade/);
          }
        }
      }
    }
  });
});
