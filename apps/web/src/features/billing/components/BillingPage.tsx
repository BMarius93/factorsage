"use client";

import {
  classifyBillingTransition,
  billingPriceKeyFor,
  type BillingCatalogEntry,
  type BillingPriceKey,
  type BillingStatusResponse,
} from "@intrinsic/contracts";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import forms from "../../../components/ui/forms.module.css";
import {
  changeBillingPlan,
  openBillingPortal,
  startCheckout,
} from "../api/billing-api";
import { useBillingStatus } from "../hooks/use-billing-status";
import {
  INTERVAL_LABEL,
  PLAN_LABEL,
  billingFailureMessage,
  formatBillingDate,
  priceLabel,
  statusNotice,
} from "../utils/format";
import styles from "./BillingPage.module.css";

/**
 * Plan and billing.
 *
 * Intentionally small — `docs/decisions/stripe-billing-v1.md` section 19 asks for a usable path and
 * explicitly not a UI programme. Two flows exist: a Free user picks a plan and a cadence and goes to
 * Stripe-hosted Checkout, and a paying user opens the Customer Portal or moves between the four
 * prices.
 *
 * **Everything shown comes from the server's own billing state.** The plan badge is `User.plan`, the
 * column every entitlement check reads, so this page can never show a tier the guards would refuse.
 * Returning from Stripe with `?checkout=success` does not grant anything: it only starts a bounded
 * settle that asks the API to reconcile from Stripe. A user who abandons Checkout and edits the URL
 * to `?checkout=success` sees exactly what they had.
 *
 * No amount is calculated here. Prices come from the shared catalog; proration, credits and invoice
 * totals belong to Stripe's hosted surfaces, and a second opinion about somebody's money rendered in
 * a React component is a support ticket waiting to happen.
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
          <Header />
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
          <Header />
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

function Header() {
  return (
    <header className={styles.header}>
      <div>
        <h1 className={styles.title}>Plan and billing</h1>
        <p className={styles.lead}>
          Your FactorSage plan, what it renews as, and how to change it.
        </p>
      </div>
    </header>
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
  const [pendingKey, setPendingKey] = useState<BillingPriceKey | null>(null);
  const [portalPending, setPortalPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const subscription = billing.subscription;
  const notice = subscription ? statusNotice(subscription.status) : null;
  const currentKey =
    subscription?.plan && subscription.interval
      ? billingPriceKeyFor(subscription.plan, subscription.interval)
      : null;

  async function choose(entry: BillingCatalogEntry) {
    if (pendingKey) {
      return;
    }
    setPendingKey(entry.key);
    setFailure(null);
    try {
      // One decision, made from server state: a user without a live subscription buys, and one with
      // a live subscription changes. The API re-decides both; this only picks which call to make.
      if (billing.canChangePlan && currentKey) {
        await changeBillingPlan(entry.key);
        onChanged();
      } else {
        const { checkoutUrl } = await startCheckout(entry.key);
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
      setPendingKey(null);
    }
  }

  async function manage() {
    if (portalPending) {
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

  return (
    <div className={styles.page}>
      <Header />

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

      <section className={styles.current} data-testid="billing-current">
        <div className={styles.currentHead}>
          <span className={styles.currentLabel}>Current plan</span>
          <span className={styles.planBadge} data-testid="billing-plan">
            {PLAN_LABEL[billing.plan]}
          </span>
        </div>

        <dl className={styles.facts}>
          {subscription?.interval ? (
            <div className={styles.fact}>
              <dt>Billing</dt>
              <dd data-testid="billing-interval">
                {INTERVAL_LABEL[subscription.interval]}
              </dd>
            </div>
          ) : null}

          {subscription?.currentPeriodEnd ? (
            <div className={styles.fact}>
              <dt>{subscription.cancelAtPeriodEnd ? "Access until" : "Renews"}</dt>
              <dd data-testid="billing-period-end">
                {formatBillingDate(subscription.currentPeriodEnd)}
              </dd>
            </div>
          ) : null}
        </dl>

        {subscription?.cancelAtPeriodEnd ? (
          <p className={styles.scheduled} data-testid="billing-cancel-scheduled">
            Cancels on{" "}
            {formatBillingDate(
              subscription.cancelAt ?? subscription.currentPeriodEnd,
            ) ?? "the end of this billing period"}
            . You keep {PLAN_LABEL[billing.plan]} until then.
          </p>
        ) : null}

        {subscription?.pendingChange ? (
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

        {billing.canOpenPortal ? (
          <button
            type="button"
            className={forms.secondaryButton}
            data-testid="manage-billing"
            disabled={portalPending}
            onClick={() => void manage()}
          >
            {portalPending ? "Opening…" : "Manage billing"}
          </button>
        ) : null}
      </section>

      {/*
        The catalog renders whether or not a biller is reachable.
        What it costs to be on Starter or Pro is information, not a transaction, and hiding the whole
        pricing table because Stripe is unconfigured or down would be a worse page than showing it
        without buttons. Only the *actions* are gated — which is also what lets the Playwright suite
        assert this surface without any Stripe secret.
      */}
      <section className={styles.plans} aria-labelledby="billing-plans-heading">
        <h2 id="billing-plans-heading" className={styles.sectionTitle}>
          {billing.canChangePlan ? "Change plan" : "Choose a plan"}
        </h2>

        <ul className={styles.grid} data-testid="billing-catalog">
          {billing.catalog.map((entry) => (
            <PlanOption
              key={entry.key}
              entry={entry}
              current={entry.key === currentKey}
              // A Free user buys; a subscriber changes. Either way the server decides again.
              actionable={billing.canStartCheckout || billing.canChangePlan}
              currentKey={currentKey}
              pending={pendingKey === entry.key}
              disabled={pendingKey !== null}
              onChoose={() => void choose(entry)}
            />
          ))}
        </ul>

        {billing.billingEnabled ? null : (
          <p className={styles.lead} data-testid="billing-unavailable">
            Subscriptions are not available in this environment, so no plan can be
            purchased or changed here.
          </p>
        )}
      </section>

      {failure ? (
        <p className={styles.error} role="alert" data-testid="billing-action-error">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

type PlanOptionProps = {
  readonly entry: BillingCatalogEntry;
  readonly current: boolean;
  readonly actionable: boolean;
  readonly currentKey: BillingPriceKey | null;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onChoose: () => void;
};

function PlanOption({
  entry,
  current,
  actionable,
  currentKey,
  pending,
  disabled,
  onChoose,
}: PlanOptionProps) {
  /**
   * What pressing this does, in words, before it happens.
   *
   * Derived from the shared classifier — the same pure function the server classifies with — so the
   * label and the behaviour cannot disagree. It says *when*, never *how much*: whether money moves
   * now or at renewal is Stripe's to state, on Stripe's own page.
   */
  const transition = currentKey
    ? classifyBillingTransition(currentKey, entry.key)
    : null;
  const effectHint =
    transition === null
      ? null
      : transition.effect === "IMMEDIATE"
        ? "Takes effect immediately"
        : "Takes effect at your next renewal";

  return (
    <li
      className={styles.plan}
      data-current={current}
      data-testid={`plan-option-${entry.key}`}
    >
      <div className={styles.planHead}>
        <span className={styles.planName}>{PLAN_LABEL[entry.plan]}</span>
        <span className={styles.planCadence}>
          {INTERVAL_LABEL[entry.interval]}
        </span>
      </div>
      <p className={styles.planPrice}>{priceLabel(entry)}</p>

      {current ? (
        <p className={styles.planCurrent} data-testid="plan-current">
          Your current plan
        </p>
      ) : effectHint ? (
        <p className={styles.planHint}>{effectHint}</p>
      ) : null}

      {!current && actionable ? (
        <button
          type="button"
          className={forms.primaryButton}
          data-testid={`choose-${entry.key}`}
          disabled={disabled}
          onClick={onChoose}
        >
          {pending
            ? "Working…"
            : currentKey
              ? `Switch to ${PLAN_LABEL[entry.plan]} ${INTERVAL_LABEL[entry.interval].toLowerCase()}`
              : `Choose ${PLAN_LABEL[entry.plan]}`}
        </button>
      ) : null}
    </li>
  );
}
