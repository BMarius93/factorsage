"use client";

import {
  occupiesPaidSlot,
  type BillingInterval,
  type BillingStatusResponse,
  type UserPlan,
} from "@intrinsic/contracts";
import { useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import { FactGrid, type Fact } from "../../../components/ui/FactGrid";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import forms from "../../../components/ui/forms.module.css";
import { useBillingStatus } from "../hooks/use-billing-status";
import { usePlanActions } from "../hooks/use-plan-actions";
import {
  INTERVAL_LABEL,
  PLAN_LABEL,
  formatBillingDate,
  statusNotice,
} from "../utils/format";
import { currentPriceKeyOf, planCardState } from "../utils/plan-actions";
import { BillingUnavailableNote, PlanCatalog } from "./PlanCatalog";
import styles from "./BillingPage.module.css";

/**
 * Billing and plan.
 *
 * An authenticated product page composed from the same vocabulary as Lists, Strategies, Monitors
 * and Backtests — `PageContainer`, `PageHeader`, `SectionCard`, `FactGrid`, `StatusBadge` — with
 * three plan cards and one cadence toggle as the only feature-owned composition. There are three
 * plans, so there are three cards: monthly and yearly are a property of a plan, not two products,
 * and rendering four cards made the page a price list rather than a comparison.
 *
 * **Everything shown comes from the server's own billing state.** The plan badge is `User.plan`,
 * the column every entitlement check reads, so this page can never show a tier the guards would
 * refuse. Returning from Stripe with `?checkout=success` does not grant anything: it only starts a
 * bounded settle that asks the API to reconcile from Stripe. A user who abandons Checkout and edits
 * the URL to `?checkout=success` sees exactly what they had.
 *
 * No amount is calculated here. Prices and capacities come from the shared catalog and the
 * entitlement matrix; proration, credits and invoice totals belong to Stripe's hosted surfaces, and
 * a second opinion about somebody's money rendered in a React component is a support ticket waiting
 * to happen.
 */
export function BillingPage() {
  const params = useSearchParams();
  const checkoutOutcome = params?.get("checkout") ?? null;
  const { state, reload, settling } = useBillingStatus({
    awaitSettlement: checkoutOutcome === "success",
  });

  if (state.status === "loading") {
    return (
      <PageContainer>
        <div className={styles.page}>
          <BillingHeader />
          <p className={styles.lead} role="status" data-testid="billing-loading">
            Loading your plan…
          </p>
        </div>
      </PageContainer>
    );
  }

  if (state.status === "error") {
    return (
      <PageContainer>
        <div className={styles.page}>
          <BillingHeader />
          <p className={styles.error} role="alert" data-testid="billing-error">
            Your billing details could not be loaded.{" "}
            <button type="button" className={styles.linkButton} onClick={reload}>
              Try again
            </button>
          </p>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <BillingContent
        billing={state.billing}
        checkoutOutcome={checkoutOutcome}
        settling={settling}
        onChanged={reload}
      />
    </PageContainer>
  );
}

type BillingHeaderProps = {
  readonly plan?: UserPlan;
  readonly actions?: ReactNode;
};

/**
 * One header for every state of the page, including loading and error, so the title does not
 * appear, disappear and reappear while the status request is in flight.
 */
function BillingHeader({ plan, actions }: BillingHeaderProps = {}) {
  return (
    <PageHeader
      title="Billing & Plan"
      lead="Choose the plan that fits your research needs."
      badges={
        plan ? (
          <StatusBadge tone="active" testId="billing-plan">
            {PLAN_LABEL[plan]}
          </StatusBadge>
        ) : undefined
      }
      actions={actions}
    />
  );
}

type BillingContentProps = {
  readonly billing: BillingStatusResponse;
  readonly checkoutOutcome: string | null;
  readonly settling: boolean;
  readonly onChanged: () => void;
};

function BillingContent({
  billing,
  checkoutOutcome,
  settling,
  onChanged,
}: BillingContentProps) {
  const subscription = billing.subscription;
  /**
   * The cadence the comparison is shown in.
   *
   * Seeded from what the user is already billed for, so a yearly subscriber does not land on a page
   * quoting monthly prices for the plan they are on. A Free user starts on monthly, the cheaper
   * commitment to evaluate.
   */
  const [interval, setInterval] = useState<BillingInterval>(
    subscription?.interval ?? "MONTH",
  );
  const { pendingPlan, portalPending, busy, failure, act, openPortal } =
    usePlanActions({ onChanged });
  const notice = subscription ? statusNotice(subscription.status) : null;
  const currentPriceKey = currentPriceKeyOf(billing);

  return (
    <div className={styles.page}>
      <BillingHeader
        plan={billing.plan}
        actions={
          billing.canOpenPortal ? (
            <button
              type="button"
              className={forms.secondaryButton}
              data-testid="manage-billing"
              disabled={busy}
              onClick={() => void openPortal()}
            >
              {portalPending ? "Opening…" : "Manage billing"}
            </button>
          ) : undefined
        }
      />

      {checkoutOutcome === "success" ? (
        <p
          className={styles.notice}
          data-tone="info"
          role="status"
          data-testid="checkout-success-notice"
        >
          {settling
            ? "Payment received — we are confirming your subscription with Stripe. This page updates itself."
            : "Payment received. Your plan below reflects your confirmed subscription."}
        </p>
      ) : null}

      {checkoutOutcome === "cancelled" ? (
        <p
          className={styles.notice}
          data-tone="info"
          role="status"
          data-testid="checkout-cancelled-notice"
        >
          Checkout was cancelled. Nothing was charged and your plan has not changed.
        </p>
      ) : null}

      {/*
        The plans render whether or not a biller is reachable.
        What it costs to be on Starter or Pro is information, not a transaction, and hiding the whole
        comparison because Stripe is unconfigured or down would be a worse page than showing it
        without buttons. Only the *actions* are gated — which is also what lets the Playwright suite
        assert this surface without any Stripe secret.
      */}
      <PlanCatalog
        interval={interval}
        onIntervalChange={setInterval}
        cardState={(plan) => planCardState({ plan, interval, billing })}
        pendingPlan={pendingPlan}
        busy={busy}
        onAct={(plan, action) => void act(plan, action)}
      >
        {billing.billingEnabled ? null : <BillingUnavailableNote />}
      </PlanCatalog>

      {failure ? (
        <p className={styles.error} role="alert" data-testid="billing-action-error">
          {failure}
        </p>
      ) : null}

      {subscription ? (
        <SubscriptionSection
          billing={billing}
          currentPriceKey={currentPriceKey}
          notice={notice}
        />
      ) : null}
    </div>
  );
}

function SubscriptionSection({
  billing,
  currentPriceKey,
  notice,
}: {
  readonly billing: BillingStatusResponse;
  readonly currentPriceKey: ReturnType<typeof currentPriceKeyOf>;
  readonly notice: ReturnType<typeof statusNotice>;
}) {
  const subscription = billing.subscription;
  if (!subscription) {
    return null;
  }

  /**
   * Whether anything about this subscription is still ahead.
   *
   * A terminated subscription keeps its `cancelAt` and its mirrored pending phase — Stripe does not
   * erase them — so rendering "Cancels on …" or "Changing to Starter on …" for one would promise a
   * future to somebody whose subscription has already ended. `occupiesPaidSlot` is the repository's
   * existing answer to "is this subscription still live", so it is reused rather than re-derived.
   */
  const live = occupiesPaidSlot(subscription.status);

  const facts: Fact[] = [];
  if (live) {
    // Only a live subscription has a cadence and a next date. A terminated one keeps both fields in
    // the mirror, and printing them would tell somebody whose subscription has ended that it renews.
    if (subscription.interval) {
      facts.push({
        label: "Billing",
        value: INTERVAL_LABEL[subscription.interval],
        testId: "billing-interval",
      });
    }
    if (subscription.currentPeriodEnd) {
      facts.push({
        label: subscription.cancelAtPeriodEnd ? "Access until" : "Renews",
        value: formatBillingDate(subscription.currentPeriodEnd) ?? "—",
        testId: "billing-period-end",
      });
    }
  }

  return (
    <SectionCard
      id="billing-subscription"
      title="Your subscription"
      caption={
        live
          ? "What Stripe is billing you for right now, and anything already scheduled."
          : "Your most recent subscription."
      }
      testId="billing-subscription"
    >
      {facts.length > 0 ? <FactGrid facts={facts} /> : null}

      <div className={styles.subscriptionNotes}>
        {live && subscription.cancelAtPeriodEnd ? (
          <p className={styles.scheduled} data-testid="billing-cancel-scheduled">
            Cancels on{" "}
            {formatBillingDate(
              subscription.cancelAt ?? subscription.currentPeriodEnd,
            ) ?? "the end of this billing period"}
            . You keep {PLAN_LABEL[billing.plan]} until then.
          </p>
        ) : null}

        {live && subscription.pendingChange ? (
          <p className={styles.scheduled} data-testid="billing-pending-change">
            Changing to {PLAN_LABEL[subscription.pendingChange.plan]}{" "}
            {INTERVAL_LABEL[subscription.pendingChange.interval].toLowerCase()} on{" "}
            {formatBillingDate(subscription.pendingChange.effectiveAt) ??
              "your next renewal"}
            . Until then you keep {PLAN_LABEL[billing.plan]}.
          </p>
        ) : null}

        {notice ? (
          <p
            className={styles.notice}
            data-tone={notice.tone}
            role={notice.tone === "warning" ? "alert" : "status"}
            data-testid="billing-status-notice"
          >
            {notice.message}
          </p>
        ) : null}

        {currentPriceKey === null && subscription.plan === null ? (
          <p className={styles.scheduled} data-testid="billing-price-unrecognised">
            Your subscription is on a price this environment does not recognise. Contact support —
            your access is unaffected while we look at it.
          </p>
        ) : null}
      </div>
    </SectionCard>
  );
}
