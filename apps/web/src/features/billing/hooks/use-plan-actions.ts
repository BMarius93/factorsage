"use client";

import type { UserPlan } from "@intrinsic/contracts";
import { useState } from "react";
import {
  changeBillingPlan,
  openBillingPortal,
  startCheckout,
} from "../api/billing-api";
import { billingFailureMessage } from "../utils/format";
import type { PlanCardAction } from "../utils/plan-actions";

export type UsePlanActions = {
  /** The card whose own request is in flight. */
  readonly pendingPlan: UserPlan | null;
  readonly portalPending: boolean;
  /** Any request in flight, so a second click cannot start a second one. */
  readonly busy: boolean;
  /** The last failure, already in the user's words. */
  readonly failure: string | null;
  readonly act: (plan: UserPlan, action: PlanCardAction) => Promise<void>;
  readonly openPortal: () => Promise<void>;
};

/**
 * What a plan card's button does for a signed-in user — the one implementation of it.
 *
 * `/billing` and the public `/pricing` page (PRICING-001) both call this, so there is exactly one
 * place that decides to start Checkout, request a plan change or open the Customer Portal. The
 * decision itself was made from server state by `planCardState`; this only makes the call that
 * decision names. The API re-decides every one of them.
 *
 * A `SIGN_IN` action is a Guest's and is never handled here: a Guest never reaches this hook's
 * requests, which is what keeps Checkout out of reach of an unauthenticated click.
 */
export function usePlanActions(options: {
  readonly onChanged: () => void;
}): UsePlanActions {
  const { onChanged } = options;
  const [pendingPlan, setPendingPlan] = useState<UserPlan | null>(null);
  const [portalPending, setPortalPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const busy = pendingPlan !== null || portalPending;

  /** Customer Portal, from either entry point: the header action or the Free card's cancel. */
  async function openPortal() {
    if (busy) {
      return;
    }
    setPortalPending(true);
    setFailure(null);
    try {
      const { portalUrl } = await openBillingPortal();
      window.location.assign(portalUrl);
    } catch (error: unknown) {
      setFailure(
        billingFailureMessage(
          error,
          "Billing management is unavailable right now. Please try again.",
        ),
      );
      setPortalPending(false);
    }
  }

  async function act(plan: UserPlan, action: PlanCardAction) {
    if (
      busy ||
      action.kind === "NONE" ||
      action.kind === "CURRENT" ||
      action.kind === "SIGN_IN"
    ) {
      return;
    }
    if (action.kind === "PORTAL") {
      await openPortal();
      return;
    }

    setPendingPlan(plan);
    setFailure(null);
    try {
      // One decision, made from server state: a user without a live subscription buys, and one with
      // a live subscription changes. The API re-decides both; this only picks which call to make.
      if (action.kind === "CHANGE") {
        await changeBillingPlan(action.priceKey);
        onChanged();
      } else {
        const { checkoutUrl } = await startCheckout(action.priceKey);
        // Stripe-hosted Checkout. Nothing is granted by arriving there or by coming back.
        window.location.assign(checkoutUrl);
        return;
      }
    } catch (error: unknown) {
      setFailure(
        billingFailureMessage(
          error,
          "That change could not be completed. Please try again.",
        ),
      );
    } finally {
      setPendingPlan(null);
    }
  }

  return { pendingPlan, portalPending, busy, failure, act, openPortal };
}
