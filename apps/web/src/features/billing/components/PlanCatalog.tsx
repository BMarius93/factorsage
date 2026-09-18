"use client";

import type { BillingInterval, UserPlan } from "@intrinsic/contracts";
import type { ReactNode } from "react";
import type { PlanCardAction, PlanCardState } from "../utils/plan-actions";
import { PLAN_CARD_ORDER } from "../utils/plan-presentation";
import { BillingIntervalToggle } from "./BillingIntervalToggle";
import { PlanCard } from "./PlanCard";
import styles from "./BillingPage.module.css";

type PlanCatalogProps = {
  readonly interval: BillingInterval;
  readonly onIntervalChange: (interval: BillingInterval) => void;
  /** What one card's button does for this viewer, already decided. */
  readonly cardState: (plan: UserPlan) => PlanCardState;
  readonly pendingPlan: UserPlan | null;
  readonly busy: boolean;
  readonly onAct: (plan: UserPlan, action: PlanCardAction) => void;
  /** Notes that belong to the comparison, rendered under the cards. */
  readonly children?: ReactNode;
};

/**
 * The plan comparison: the caption, the cadence toggle and the three plan cards.
 *
 * Rendered by both the authenticated `/billing` page and the public `/pricing` page (PRICING-001),
 * so the two cannot show different prices, capacities or plan order: there is one component, and
 * it reads `plan-presentation.ts` through `PlanCard` and nothing else. What differs between the two
 * pages is only what each card's button does for the viewer, which each page decides and passes in
 * as `cardState`.
 */
export function PlanCatalog({
  interval,
  onIntervalChange,
  cardState,
  pendingPlan,
  busy,
  onAct,
  children,
}: PlanCatalogProps) {
  return (
    <section className={styles.plans} aria-label="Plans">
      <div className={styles.plansHead}>
        <p className={styles.plansCaption}>
          Every plan includes every indicator, valuation model and strategy
          feature. Plans differ by capacity.
        </p>
        <BillingIntervalToggle value={interval} onChange={onIntervalChange} />
      </div>

      <ul className={styles.grid} data-testid="billing-catalog">
        {PLAN_CARD_ORDER.map((plan) => (
          <PlanCard
            key={plan}
            plan={plan}
            interval={interval}
            state={cardState(plan)}
            pending={pendingPlan === plan}
            busy={busy}
            onAct={(action) => onAct(plan, action)}
          />
        ))}
      </ul>

      {children}
    </section>
  );
}

/**
 * Said under the cards when the environment has no biller configured, on `/billing` and on
 * `/pricing` alike: the prices are still true, but nothing can be bought here.
 */
export function BillingUnavailableNote() {
  return (
    <p className={styles.lead} data-testid="billing-unavailable">
      Subscriptions are not available in this environment, so no plan can be
      purchased or changed here.
    </p>
  );
}
