"use client";

import type { BillingInterval, UserPlan } from "@intrinsic/contracts";
import forms from "../../../components/ui/forms.module.css";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { PLAN_LABEL } from "../utils/format";
import type { PlanCardAction, PlanCardState } from "../utils/plan-actions";
import {
  RECOMMENDED_PLAN,
  planFeatures,
  planPricing,
} from "../utils/plan-presentation";
import styles from "./BillingPage.module.css";

type PlanCardProps = {
  readonly plan: UserPlan;
  readonly interval: BillingInterval;
  readonly state: PlanCardState;
  /** True while this card's own request is in flight. */
  readonly pending: boolean;
  /** True while any card's request is in flight, so a second click cannot start a second one. */
  readonly busy: boolean;
  readonly onAct: (action: PlanCardAction) => void;
};

function CheckIcon() {
  return (
    <svg
      className={styles.check}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      // The mark means "included", which the surrounding list already says. Announcing it on every
      // row would make a five-item list read as ten.
      aria-hidden="true"
    >
      <path d="M3 8.5l3.2 3.2L13 5" />
    </svg>
  );
}

/**
 * One purchasable plan, including Free.
 *
 * Free is a card rather than an account state on purpose: it is a plan a user can be on and can
 * return to, and leaving it out of the comparison makes the cheapest paid tier look like the entry
 * point when it is not.
 *
 * Nothing here decides anything. The price and the feature rows are derived from the shared catalog
 * and the entitlement matrix (`plan-presentation.ts`), and what the button does comes from
 * `plan-actions.ts`, which classifies with the same pure function the API does.
 */
export function PlanCard({
  plan,
  interval,
  state,
  pending,
  busy,
  onAct,
}: PlanCardProps) {
  const pricing = planPricing(plan, interval);
  const features = planFeatures(plan);
  const { action } = state;
  const recommended = plan === RECOMMENDED_PLAN && !state.current;

  return (
    <li
      className={styles.plan}
      data-current={state.current ? "true" : undefined}
      data-testid={`plan-card-${plan}`}
    >
      <div className={styles.planHead}>
        <h2 className={styles.planName}>{PLAN_LABEL[plan]}</h2>
        {state.current ? (
          <StatusBadge tone="active" testId="plan-current-badge">
            Current plan
          </StatusBadge>
        ) : null}
        {recommended ? (
          <StatusBadge tone="neutral" variant="outline" testId="plan-recommended-badge">
            Recommended
          </StatusBadge>
        ) : null}
      </div>

      <p className={styles.price} data-testid={`plan-price-${plan}`}>
        <span className={styles.priceAmount}>{pricing.amount}</span>
        <span className={styles.pricePeriod}>{pricing.period}</span>
      </p>
      {pricing.note ? (
        <p className={styles.priceNote} data-testid={`plan-price-note-${plan}`}>
          {pricing.note}
        </p>
      ) : null}

      <ul className={styles.features} data-testid={`plan-features-${plan}`}>
        {features.map((feature) => (
          <li key={feature.id} className={styles.feature}>
            <CheckIcon />
            <span>{feature.label}</span>
          </li>
        ))}
      </ul>

      <div className={styles.cta}>
        <PlanCardButton
          plan={plan}
          action={action}
          pending={pending}
          busy={busy}
          onAct={onAct}
        />
        {/* Always rendered, empty or not: the hint is what would otherwise make one card's button
            sit a line higher than its neighbours'. Reserving the line keeps the three CTAs on one
            baseline whatever each card has to say. */}
        <p className={styles.ctaHint} data-testid={`plan-hint-${plan}`}>
          {state.effectHint}
        </p>
      </div>
    </li>
  );
}

function PlanCardButton({
  plan,
  action,
  pending,
  busy,
  onAct,
}: {
  readonly plan: UserPlan;
  readonly action: PlanCardAction;
  readonly pending: boolean;
  readonly busy: boolean;
  readonly onAct: (action: PlanCardAction) => void;
}) {
  if (action.kind === "NONE") {
    return null;
  }

  if (action.kind === "CURRENT") {
    // Genuinely `disabled`, not a click that quietly does nothing: assistive technology should
    // report it as unavailable, and it must not take focus as though it could be pressed.
    return (
      <button
        type="button"
        className={`${forms.secondaryButton} ${styles.ctaButton}`}
        disabled
        data-testid={`plan-action-${plan}`}
        data-action="CURRENT"
      >
        {action.label}
      </button>
    );
  }

  const priceKey =
    action.kind === "CHECKOUT" || action.kind === "CHANGE" ? action.priceKey : null;

  return (
    <button
      type="button"
      // One solid action per page, on the recommended card. A pricing table where every card is
      // filled blue has no hierarchy left to spend.
      className={`${
        plan === RECOMMENDED_PLAN ? forms.primaryButton : forms.secondaryButton
      } ${styles.ctaButton}`}
      disabled={busy}
      onClick={() => onAct(action)}
      data-testid={`plan-action-${plan}`}
      data-action={action.kind}
      // The price this button will actually send, on the button itself. A test that reads this is
      // asserting where the bug would live — a card showing "Yearly" while posting the monthly
      // key — rather than the rendered amount beside it.
      {...(priceKey ? { "data-price-key": priceKey } : {})}
    >
      {pending ? "Working…" : action.label}
    </button>
  );
}
