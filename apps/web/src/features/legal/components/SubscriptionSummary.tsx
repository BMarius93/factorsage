"use client";

import Link from "next/link";
import { Notice } from "../../../components/ui/Notice";
import { SectionCard } from "../../../components/ui/SectionCard";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import {
  formatBillingDate,
  INTERVAL_LABEL,
  PLAN_LABEL,
} from "../../billing/utils/format";
import { useBillingStatus } from "../../billing/hooks/use-billing-status";
import styles from "./SubscriptionSummary.module.css";

/**
 * The contract a withdrawal request is about.
 *
 * A withdrawal function has to identify the contract being withdrawn from. This reads the
 * account's real subscription — plan, interval, status, renewal or end date — from
 * `GET /billing/status`, the same endpoint the Billing page uses, so this page cannot show one
 * thing while Billing shows another.
 *
 * ## Two boundaries it is careful about
 *
 * **It reads; it never acts.** No amount is computed here, no refund is estimated, and no plan is
 * written. Every figure comes from the API's mirror of the payment provider's own state, and the
 * only action offered is a link to Billing, where cancelling a renewal already lives in the
 * hosted customer portal.
 *
 * **Cancelling a renewal is not withdrawing.** The two are on the same page because people
 * confuse them, and the copy exists to separate them: the link below stops the next charge, the
 * form beneath submits a statutory request. Neither does the other's job, and that sentence is
 * shown whether or not the account currently holds a paid subscription.
 *
 * Split in two so the billing request is never issued for a Guest: this page is public, and a
 * `401` from a read nobody needed would be a failure on a policy page.
 */
export function SubscriptionSummary() {
  const { state: session } = useAuthSession();

  if (session.status !== "authenticated") {
    // A Guest has no contract to identify. The request form below already explains that
    // submitting is done from a signed-in account, and offers the support fallback.
    return null;
  }
  return <AuthenticatedSubscriptionSummary />;
}

function AuthenticatedSubscriptionSummary() {
  const { state } = useBillingStatus();

  return (
    <SectionCard
      title="Your subscription"
      caption="What a withdrawal request would be about, read from your live billing state."
      testId="withdrawal-subscription"
    >
      {state.status === "loading" ? (
        <p className={styles.muted}>Reading your billing state…</p>
      ) : state.status === "error" ? (
        <Notice tone="warning" title="Your billing state could not be read">
          <p>
            You can still submit a request below — describe the subscription in
            your own words and it will be matched to your account.
          </p>
        </Notice>
      ) : state.billing.subscription === null ? (
        <Notice tone="info" title="No paid subscription on this account">
          <p>
            You are on the {PLAN_LABEL[state.billing.plan]} plan, with no paid
            contract to withdraw from. If something is wrong with the service,
            use the fault report below or{" "}
            <Link className={styles.link} href="/contact">
              contact support
            </Link>
            .
          </p>
        </Notice>
      ) : (
        <>
          <dl className={styles.facts}>
            <div>
              <dt>Plan</dt>
              <dd>
                {state.billing.subscription.plan
                  ? PLAN_LABEL[state.billing.subscription.plan]
                  : PLAN_LABEL[state.billing.plan]}
              </dd>
            </div>
            <div>
              <dt>Billed</dt>
              <dd>
                {state.billing.subscription.interval
                  ? INTERVAL_LABEL[state.billing.subscription.interval]
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>
                {state.billing.subscription.cancelAtPeriodEnd
                  ? "Access until"
                  : "Renews"}
              </dt>
              <dd>
                {formatBillingDate(
                  state.billing.subscription.currentPeriodEnd,
                ) ?? "—"}
              </dd>
            </div>
          </dl>

          <p className={styles.note}>
            {state.billing.subscription.cancelAtPeriodEnd
              ? "Your renewal is already cancelled: nothing further will be charged, and access continues until the date above."
              : "This subscription renews automatically on the date above until you cancel the renewal."}
          </p>
        </>
      )}

      {/* Shown in every state, because the distinction is what the page is for and it does not
          depend on what the account currently holds. */}
      <p className={styles.note}>
        <strong>Cancelling a renewal is not a withdrawal.</strong> It stops the
        next charge and normally leaves your access in place until the end of
        the period you have already paid for. It is not a refund request and
        does not by itself return any money.{" "}
        <Link className={styles.link} href="/billing">
          Manage or cancel your subscription
        </Link>
        .
      </p>
    </SectionCard>
  );
}
