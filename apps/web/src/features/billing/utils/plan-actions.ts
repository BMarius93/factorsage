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
  /**
   * A Guest on the public pricing page: an account comes first, so the button asks for one in
   * place. It carries no price key on purpose — nothing a Guest clicks can reach Checkout.
   */
  | { readonly kind: "SIGN_IN"; readonly label: string }
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

/**
 * The logical price the user is billed for right now, or `null` when nothing is live.
 *
 * An **ended** subscription — canceled, unpaid, expired before its first payment — still carries
 * its last price in the mirror, but nobody is billed for it any more (UI-037). Treating that price
 * as current is what once showed a lapsed Pro customer "Waiting for payment confirmation" on the
 * plan they had left, with no way to buy it again. `occupiesPaidSlot` is the contract's one answer
 * to "is this subscription still live".
 */
export function currentPriceKeyOf(
  billing: BillingStatusResponse,
): BillingPriceKey | null {
  const subscription = billing.subscription;
  if (
    !subscription?.plan ||
    !subscription.interval ||
    !occupiesPaidSlot(subscription.status)
  ) {
    return null;
  }
  return billingPriceKeyFor(subscription.plan, subscription.interval);
}

/** The paid plan of a subscription that has ended, if any: the one a returning buyer left. */
function endedPlanOf(billing: BillingStatusResponse): UserPlan | null {
  const subscription = billing.subscription;
  return subscription?.plan && !occupiesPaidSlot(subscription.status)
    ? subscription.plan
    : null;
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
      // Resuming is a Customer Portal action, so the hint names where it lives (UI-038).
      effectHint: current
        ? null
        : "Resume your subscription in Manage billing to change plan",
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
        // A returning customer buys back the plan they left; everything else is an upgrade from
        // Free. Both are an ordinary Checkout for this price.
        label:
          endedPlanOf(billing) === plan
            ? `Resubscribe to ${PLAN_LABEL[plan]}`
            : `Upgrade to ${PLAN_LABEL[plan]}`,
        priceKey,
      },
      effectHint: null,
    };
  }

  return { current, action: { kind: "NONE" }, effectHint: null };
}

/**
 * What each card offers a Guest on `/pricing` (PRICING-001).
 *
 * A Guest has no billing state to classify — `GET /billing/status` is authenticated — so every card
 * offers the one thing that is true for all of them: an account first. The hint says so without
 * promising anything about Checkout, which the signed-in page decides from server state.
 */
export function guestPlanCardState(plan: UserPlan): PlanCardState {
  if (!isPaidPlan(plan)) {
    return {
      current: false,
      action: { kind: "SIGN_IN", label: "Start for free" },
      effectHint: "No payment details needed",
    };
  }
  return {
    current: false,
    action: { kind: "SIGN_IN", label: `Choose ${PLAN_LABEL[plan]}` },
    effectHint: "Requires a FactorSage account",
  };
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
