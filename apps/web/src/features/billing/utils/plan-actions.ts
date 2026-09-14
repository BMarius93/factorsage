import {
  billingPriceKeyFor,
  classifyBillingTransition,
  isPaidPlan,
  occupiesPaidSlot,
  type BillingInterval,
  type BillingPriceKey,
  type BillingStatusResponse,
  type BillingTransitionEffect,
  type UserPlan,
} from "@intrinsic/contracts";
import { PLAN_LABEL } from "./format";

/**
 * What one plan card's button does, decided in one place.
 *
 * The labels are derived from `classifyBillingTransition` — the *same* pure function the API
 * classifies the request with — so a button cannot promise something the server will refuse or
 * schedule something it would apply immediately. That coupling is the point: "Upgrade to Pro" and
 * "Downgrade to Starter" are not adjectives, they are the transition Stripe will be asked for.
 *
 * Two rules this file exists to keep honest:
 *
 * 1. **Free is never a purchase.** There is no Stripe price for it, and the only supported route
 *    back to it is cancelling at period end in the Customer Portal
 *    (`docs/decisions/stripe-billing-v1.md` section 7). The Free card therefore offers the Portal,
 *    never a checkout.
 * 2. **A subscribed price is not a granted plan.** An `incomplete` subscription holds the paid slot
 *    while `User.plan` is still `FREE`; marking its card "Current plan" would claim an entitlement
 *    the guards would refuse, which is exactly the optimistic display section 19 forbids. That case
 *    gets a waiting note and no action.
 */

export type PlanCardAction =
  /** The user is on this plan. Rendered as a disabled button, never as a live control. */
  | { readonly kind: "CURRENT"; readonly label: string }
  /** No subscription yet: hosted Checkout for this logical price. */
  | { readonly kind: "CHECKOUT"; readonly label: string; readonly priceKey: BillingPriceKey }
  /** A live subscription moving between two of the four prices. */
  | {
      readonly kind: "CHANGE";
      readonly label: string;
      readonly priceKey: BillingPriceKey;
      readonly effect: BillingTransitionEffect;
    }
  /** Customer Portal, which owns cancellation and therefore the route to Free. */
  | { readonly kind: "PORTAL"; readonly label: string }
  /** Nothing this user can do from this card right now. */
  | { readonly kind: "NONE" };

export type PlanCardState = {
  /** True when this card is the user's persisted plan — the column every guard reads. */
  readonly current: boolean;
  readonly action: PlanCardAction;
  /** One quiet line under the button saying *when*, never how much. */
  readonly effectHint: string | null;
};

const IMMEDIATE_HINT = "Takes effect immediately";
const RENEWAL_HINT = "Takes effect at your next renewal";

/** The logical price the user is billed for right now, or `null` when nothing is live. */
export function currentPriceKeyOf(
  billing: BillingStatusResponse,
): BillingPriceKey | null {
  const subscription = billing.subscription;
  if (!subscription?.plan || !subscription.interval) {
    return null;
  }
  return billingPriceKeyFor(subscription.plan, subscription.interval);
}

export function planCardState(input: {
  readonly plan: UserPlan;
  readonly interval: BillingInterval;
  readonly billing: BillingStatusResponse;
}): PlanCardState {
  const { plan, interval, billing } = input;
  const current = billing.plan === plan;
  const currentPriceKey = currentPriceKeyOf(billing);

  if (!isPaidPlan(plan)) {
    return freeCardState({ current, billing });
  }

  const priceKey = billingPriceKeyFor(plan, interval);

  if (currentPriceKey === priceKey) {
    return current
      ? { current, action: { kind: "CURRENT", label: "Current plan" }, effectHint: null }
      : // Subscribed to this price but not entitled to it yet: an unpaid first payment. Say so
        // rather than claiming the plan.
        {
          current,
          action: { kind: "NONE" },
          effectHint: "Waiting for payment confirmation",
        };
  }

  if (
    billing.subscription?.cancelAtPeriodEnd &&
    occupiesPaidSlot(billing.subscription.status)
  ) {
    // `POST /billing/change` refuses this outright — a subscription already asked to stop is not one
    // to move onto another price — so offering the button would guarantee an error. The remedy is
    // the one the API names: resume in Portal first.
    return {
      current,
      action: { kind: "NONE" },
      effectHint: current
        ? null
        : "Resume your subscription to change plan",
    };
  }

  const pending = billing.subscription?.pendingChange;
  if (pending && pending.plan === plan && pending.interval === interval) {
    // Stripe already holds this exact change for the period boundary. Offering it again would ask
    // for something that is already agreed, and reads as though the first request had not landed.
    return {
      current,
      action: { kind: "NONE" },
      effectHint: "Scheduled for your next renewal",
    };
  }

  if (billing.canChangePlan && currentPriceKey !== null) {
    const transition = classifyBillingTransition(currentPriceKey, priceKey);
    return {
      current,
      action: {
        kind: "CHANGE",
        label: changeLabel(transition.kind, plan),
        priceKey,
        effect: transition.effect,
      },
      effectHint:
        transition.effect === "IMMEDIATE" ? IMMEDIATE_HINT : RENEWAL_HINT,
    };
  }

  if (current) {
    // The plan is granted with no subscription behind it — an administratively set or seeded
    // account. There is nothing to buy and nothing to change.
    return {
      current,
      action: { kind: "CURRENT", label: "Current plan" },
      effectHint: null,
    };
  }

  if (billing.canStartCheckout) {
    return {
      current,
      action: {
        kind: "CHECKOUT",
        label: `Upgrade to ${PLAN_LABEL[plan]}`,
        priceKey,
      },
      effectHint: null,
    };
  }

  return { current, action: { kind: "NONE" }, effectHint: null };
}

function freeCardState(input: {
  readonly current: boolean;
  readonly billing: BillingStatusResponse;
}): PlanCardState {
  const { current, billing } = input;

  if (current) {
    return {
      current,
      action: { kind: "CURRENT", label: "Current plan" },
      effectHint: null,
    };
  }

  if (
    billing.subscription?.cancelAtPeriodEnd &&
    occupiesPaidSlot(billing.subscription.status)
  ) {
    // Already on its way here. Offering "cancel" again would be a second request for something
    // Stripe has already scheduled.
    return {
      current,
      action: { kind: "NONE" },
      effectHint: "Scheduled at the end of your current period",
    };
  }

  if (billing.canOpenPortal && billing.subscription !== null) {
    return {
      current,
      action: { kind: "PORTAL", label: "Cancel subscription" },
      effectHint: RENEWAL_HINT,
    };
  }

  return { current, action: { kind: "NONE" }, effectHint: null };
}

function changeLabel(
  kind: ReturnType<typeof classifyBillingTransition>["kind"],
  plan: UserPlan,
): string {
  switch (kind) {
    case "TIER_UPGRADE":
      return `Upgrade to ${PLAN_LABEL[plan]}`;
    case "TIER_DOWNGRADE":
      return `Downgrade to ${PLAN_LABEL[plan]}`;
    case "CADENCE_LENGTHENED":
      return "Switch to yearly";
    case "CADENCE_SHORTENED":
      return "Switch to monthly";
    case "SAME_PRICE":
      // Handled before classification; kept explicit so a future kind is a compile error.
      return "Current plan";
  }
}
