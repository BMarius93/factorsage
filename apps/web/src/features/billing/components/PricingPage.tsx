"use client";

import {
  BILLING_CATALOG_ENTRIES,
  type BillingInterval,
  type UserPlan,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import forms from "../../../components/ui/forms.module.css";
import { useSignInPrompt } from "../../auth/hooks/use-sign-in-prompt";
import { SIGN_IN_TO_CHOOSE_PLAN } from "../../auth/utils/sign-in-prompts";
import { useBillingStatus } from "../hooks/use-billing-status";
import { usePlanActions } from "../hooks/use-plan-actions";
import { CURRENCY_LABEL } from "../utils/format";
import {
  guestPlanCardState,
  planCardState,
  type PlanCardState,
} from "../utils/plan-actions";
import { BillingUnavailableNote, PlanCatalog } from "./PlanCatalog";
import billingStyles from "./BillingPage.module.css";
import styles from "./PricingPage.module.css";

/** A card whose action is not known yet: it states the price and offers nothing. */
const UNDECIDED_CARD: PlanCardState = {
  current: false,
  action: { kind: "NONE" },
  effectHint: null,
};

/**
 * The public price list (PRICING-001, DEC-001).
 *
 * The comparison is the same `PlanCatalog` the authenticated `/billing` page renders, so the two
 * pages show one set of prices, capacities and plan order — `plan-presentation.ts` reading
 * `BILLING_CATALOG` and `PLAN_ENTITLEMENTS` — and cannot drift apart. Only the buttons differ by
 * viewer:
 *
 * - A **Guest** is asked for an account in place through the shared `SignInPrompt`, whose links
 *   carry `/pricing` as `?next=`. No billing endpoint is called for a Guest, and no Guest click can
 *   name a price, let alone start Checkout.
 * - A **signed-in** viewer gets exactly what `/billing` offers: the card state is `planCardState`
 *   over the server's billing status, and the click goes through the same `usePlanActions` handler.
 *   There is one Checkout implementation, not two.
 *
 * Prices render in every state — they are published information — but an action appears only once
 * the page knows what is true for this viewer.
 */
export function PricingPage() {
  const gate = useSignInPrompt();
  /**
   * The cadence the viewer picked, or `null` until they pick one. Held here rather than in the
   * catalog so it survives the session resolving from "unknown" to "signed in".
   */
  const [chosenInterval, setChosenInterval] = useState<BillingInterval | null>(
    null,
  );

  return (
    <PageContainer>
      <div className={styles.page} data-testid="pricing-page">
        <PageHeader
          title="Pricing"
          lead="Start free, and move up when your research needs more capacity."
          actions={
            gate.signedIn ? (
              <Link
                className={forms.secondaryButton}
                href="/billing"
                data-testid="pricing-billing-link"
              >
                Plan and billing
              </Link>
            ) : undefined
          }
        />

        {gate.signedIn ? (
          <SignedInPlans
            chosenInterval={chosenInterval}
            onIntervalChange={setChosenInterval}
          />
        ) : (
          <PlanCatalog
            interval={chosenInterval ?? "MONTH"}
            onIntervalChange={setChosenInterval}
            cardState={guestPlanCardState}
            pendingPlan={null}
            // Disabled until the session has resolved: a prompt shown to somebody who turns out to
            // be signed in is as wrong as a purchase offered to somebody who is not.
            busy={!gate.resolved}
            onAct={(_plan, action) => {
              if (action.kind === "SIGN_IN" && gate.resolved) {
                gate.attempt(SIGN_IN_TO_CHOOSE_PLAN, () => {});
              }
            }}
          />
        )}

        <BillingFacts />
      </div>
      {gate.prompt}
    </PageContainer>
  );
}

function SignedInPlans({
  chosenInterval,
  onIntervalChange,
}: {
  readonly chosenInterval: BillingInterval | null;
  readonly onIntervalChange: (interval: BillingInterval) => void;
}) {
  const { state, reload } = useBillingStatus();
  const billing = state.status === "ready" ? state.billing : null;
  // Until the viewer picks one, show what they are already billed for, as `/billing` does.
  const interval: BillingInterval =
    chosenInterval ?? billing?.subscription?.interval ?? "MONTH";
  const { pendingPlan, busy, failure, act } = usePlanActions({
    onChanged: reload,
  });

  return (
    <>
      <PlanCatalog
        interval={interval}
        onIntervalChange={onIntervalChange}
        cardState={(plan: UserPlan) =>
          billing ? planCardState({ plan, interval, billing }) : UNDECIDED_CARD
        }
        pendingPlan={pendingPlan}
        busy={busy}
        onAct={(plan, action) => void act(plan, action)}
      >
        {state.status === "loading" ? (
          <p
            className={billingStyles.lead}
            role="status"
            data-testid="pricing-plan-loading"
          >
            Checking your plan…
          </p>
        ) : null}

        {state.status === "error" ? (
          <p
            className={billingStyles.error}
            role="alert"
            data-testid="pricing-plan-error"
          >
            Your plan could not be loaded, so no plan can be chosen right now.{" "}
            <button
              type="button"
              className={billingStyles.linkButton}
              onClick={reload}
            >
              Try again
            </button>
          </p>
        ) : null}

        {billing && !billing.billingEnabled ? <BillingUnavailableNote /> : null}
      </PlanCatalog>

      {failure ? (
        <p
          className={billingStyles.error}
          role="alert"
          data-testid="billing-action-error"
        >
          {failure}
        </p>
      ) : null}
    </>
  );
}

/** Every currency the catalog is priced in, in words. There is one today. */
const CATALOG_CURRENCIES = [
  ...new Set(
    BILLING_CATALOG_ENTRIES.map((entry) => CURRENCY_LABEL[entry.currency]),
  ),
].join(" and ");

/**
 * The billing rules a visitor needs before choosing, restated in plain words.
 *
 * Nothing here is a new promise: each line is a rule `docs/decisions/stripe-billing-v1.md` (hosted
 * Checkout, the transition classification, cancellation at period end) or
 * `docs/decisions/entitlements-v1.md` section 9 (a downgrade is never destructive) already fixes.
 * No amount and no capacity appears here — those belong to the cards.
 */
function BillingFacts() {
  return (
    <SectionCard
      id="pricing-billing-facts"
      title="How billing works"
      testId="pricing-billing-facts"
    >
      <ul className={styles.facts}>
        <li>
          Prices are in {CATALOG_CURRENCIES}. Payment is taken on Stripe&apos;s
          hosted checkout, so FactorSage never sees your card details.
        </li>
        <li>
          Upgrades take effect immediately. Downgrades, a switch to monthly
          billing and cancellation take effect at the end of the period you have
          already paid for.
        </li>
        <li>
          Moving to a smaller plan never deletes anything you have saved: your
          lists, strategies, backtests and monitors stay readable.
        </li>
      </ul>
    </SectionCard>
  );
}
