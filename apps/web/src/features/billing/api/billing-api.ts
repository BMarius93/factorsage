import type {
  BillingChangeResponse,
  BillingCheckoutResponse,
  BillingPortalResponse,
  BillingPriceKey,
  BillingStatusResponse,
} from "@intrinsic/contracts";
import { apiGet, apiPost } from "../../../lib/api/client";

/**
 * The browser's billing calls.
 *
 * Every request sends at most a logical catalog key. There is deliberately no function here that
 * takes a Stripe price, customer or subscription id, and none that sets a plan: the API refuses all
 * of those, and not offering them keeps a future caller from discovering that the hard way.
 */

export function fetchBillingStatus(options: { signal?: AbortSignal } = {}) {
  return apiGet<BillingStatusResponse>("/billing/status", options);
}

/**
 * Re-reads authoritative Stripe state, then returns billing status.
 *
 * Called once on returning from a hosted Stripe page. It is not what grants the plan — the webhook
 * is — it only removes the wait when the redirect beats the webhook.
 */
export async function refreshBillingStatus(): Promise<BillingStatusResponse> {
  return (await apiPost<BillingStatusResponse>(
    "/billing/refresh",
    {},
  )) as BillingStatusResponse;
}

export async function startCheckout(
  priceKey: BillingPriceKey,
): Promise<BillingCheckoutResponse> {
  return (await apiPost<BillingCheckoutResponse>("/billing/checkout", {
    priceKey,
  })) as BillingCheckoutResponse;
}

export async function openBillingPortal(): Promise<BillingPortalResponse> {
  return (await apiPost<BillingPortalResponse>(
    "/billing/portal",
    {},
  )) as BillingPortalResponse;
}

export async function changeBillingPlan(
  priceKey: BillingPriceKey,
): Promise<BillingChangeResponse> {
  return (await apiPost<BillingChangeResponse>("/billing/change", {
    priceKey,
  })) as BillingChangeResponse;
}
