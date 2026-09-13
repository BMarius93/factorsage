import {
  BILLING_CATALOG,
  type BillingCatalogEntry,
  type BillingInterval,
  type BillingPriceKey,
  type BillingSubscriptionStatus,
  type UserPlan,
} from "@intrinsic/contracts";
import { ApiError } from "../../../lib/api/client";

/**
 * Presentation for the billing surface.
 *
 * Everything here is formatting. No amount is computed, no proration is estimated and no renewal
 * date is derived: the price comes from the shared catalog and the dates come from the API, which
 * mirrors them from Stripe. `docs/decisions/stripe-billing-v1.md` section 19 is explicit that
 * financial previews belong to Stripe's own hosted surfaces, and arithmetic here would be a second
 * opinion about somebody's money.
 */

export const PLAN_LABEL: Readonly<Record<UserPlan, string>> = {
  FREE: "Free",
  STARTER: "Starter",
  PRO: "Pro",
};

export const INTERVAL_LABEL: Readonly<Record<BillingInterval, string>> = {
  MONTH: "Monthly",
  YEAR: "Yearly",
};

/** `$9 / month`, straight from the catalog the server also resolves prices through. */
export function priceLabel(entry: BillingCatalogEntry): string {
  const amount = entry.amountMinorUnits / 100;
  const formatted = Number.isInteger(amount)
    ? `$${amount}`
    : `$${amount.toFixed(2)}`;
  return `${formatted} / ${entry.interval === "MONTH" ? "month" : "year"}`;
}

export function planOf(priceKey: BillingPriceKey): UserPlan {
  return BILLING_CATALOG[priceKey].plan;
}

export function intervalOf(priceKey: BillingPriceKey): BillingInterval {
  return BILLING_CATALOG[priceKey].interval;
}

export function formatBillingDate(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * What a mirrored Stripe status means to the person looking at it.
 *
 * Only states a user can act on, or needs reassurance about, get their own words. Everything else
 * says the same neutral thing, because a user has no use for Stripe's vocabulary and inventing
 * urgent-sounding copy for an internal state is worse than saying nothing.
 */
export function statusNotice(
  status: BillingSubscriptionStatus,
): { readonly tone: "info" | "warning"; readonly message: string } | null {
  switch (status) {
    case "PAST_DUE":
      return {
        tone: "warning",
        message:
          "Your last payment did not go through. Your plan stays active while we retry — update your payment method in billing management to keep it.",
      };
    case "UNPAID":
      return {
        tone: "warning",
        message:
          "Your subscription could not be paid and has ended. You are on the Free plan; subscribe again whenever you are ready.",
      };
    case "INCOMPLETE":
      return {
        tone: "info",
        message:
          "Your payment is still being confirmed. Your plan will update automatically once it completes.",
      };
    case "CANCELED":
    case "INCOMPLETE_EXPIRED":
      return {
        tone: "info",
        message: "Your subscription has ended. You are on the Free plan.",
      };
    case "TRIALING":
    case "PAUSED":
    case "UNKNOWN":
      return {
        tone: "warning",
        message:
          "Your subscription is in a state we need to look at. Please contact support — your access is unaffected while we do.",
      };
    case "ACTIVE":
      return null;
  }
}

/**
 * A billing failure in the user's words.
 *
 * Prefers the API's own message, which is already safe and already written in product vocabulary.
 * The fallback exists for a network failure, where there is no response to read.
 */
export function billingFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.message) {
    return error.message;
  }
  return fallback;
}
