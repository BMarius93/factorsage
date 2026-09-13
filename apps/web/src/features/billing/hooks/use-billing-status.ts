"use client";

import type { BillingStatusResponse } from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBillingStatus, refreshBillingStatus } from "../api/billing-api";

export type BillingStatusState =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly billing: BillingStatusResponse };

export type UseBillingStatus = {
  readonly state: BillingStatusState;
  /** Re-reads persisted status. Used after this page itself changed something. */
  readonly reload: () => void;
  /** True while the post-Checkout settle is still waiting for authoritative state. */
  readonly settling: boolean;
};

/**
 * How long to keep asking after returning from Stripe, and how often.
 *
 * Bounded on purpose. Returning from Checkout means Stripe took a payment, not that FactorSage has
 * heard about it: the webhook usually lands within a second or two, and this closes the gap without
 * ever becoming the thing that grants the plan. When the window expires the page simply shows the
 * state it has — the webhook is still the authority and will converge — rather than polling forever
 * or claiming a plan the server has not granted.
 */
const SETTLE_ATTEMPTS = 6;
const SETTLE_INTERVAL_MS = 1_500;

/**
 * The billing status this page renders, and the bounded settle after a hosted Stripe round trip.
 *
 * `awaitSettlement` is what `?checkout=success` triggers. It calls `POST /billing/refresh`, which
 * reconciles from Stripe through exactly the same path a webhook uses — so a user whose card failed
 * gets the honest answer here, not an optimistic one. Nothing in this hook reads the URL to decide a
 * plan; the URL only decides whether to *ask again*.
 */
export function useBillingStatus(
  options: { readonly awaitSettlement?: boolean } = {},
): UseBillingStatus {
  const [state, setState] = useState<BillingStatusState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [settling, setSettling] = useState(options.awaitSettlement === true);
  const latestRequestRef = useRef(0);

  const reload = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    const controller = new AbortController();

    fetchBillingStatus({ signal: controller.signal })
      .then((billing) => {
        if (requestId === latestRequestRef.current) {
          setState({ status: "ready", billing });
        }
      })
      .catch(() => {
        if (requestId === latestRequestRef.current && !controller.signal.aborted) {
          setState({ status: "error" });
        }
      });

    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    if (!options.awaitSettlement) {
      return;
    }

    let cancelled = false;
    let remaining = SETTLE_ATTEMPTS;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      if (cancelled) {
        return;
      }
      remaining -= 1;
      try {
        const billing = await refreshBillingStatus();
        if (cancelled) {
          return;
        }
        setState({ status: "ready", billing });
        // A paid subscription that Stripe now reports is the only thing that ends the wait early.
        if (billing.subscription !== null && billing.plan !== "FREE") {
          setSettling(false);
          return;
        }
      } catch {
        // A failed refresh is not a failed purchase. Keep the state that is already rendered and
        // let the remaining attempts, or the webhook, resolve it.
      }

      if (remaining <= 0) {
        setSettling(false);
        return;
      }
      timer = setTimeout(() => void poll(), SETTLE_INTERVAL_MS);
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [options.awaitSettlement]);

  return { state, reload, settling };
}
