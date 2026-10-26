import Link from "next/link";
import { VisuallyHidden } from "../../../components/ui/Collection";
import { EmptyState } from "../../../components/ui/EmptyState";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import forms from "../../../components/ui/forms.module.css";
import { PLAN_LABEL } from "../utils/format";
import { premiumPlans } from "../utils/plan-presentation";
import styles from "./PremiumContent.module.css";

/**
 * Premium built-in content, as every surface that shows it says it
 * (`docs/decisions/entitlements-v2.md` §6).
 *
 * A premium built-in List or Strategy carries `premium: true`; on a plan that does not include
 * premium content it also carries `locked: true`, and the API refuses its members or rules, a copy
 * of it and a backtest over it. Everything here is presentation of that answer. The plans named are
 * read from the entitlement matrix (`premiumPlans()`), never written down, so the copy follows the
 * matrix the day it moves.
 */

/** Where a locked item points: the public plan comparison, which a Guest can read too. */
export const PREMIUM_PLANS_HREF = "/pricing";

/** `Pro and Pro+`: the plans that include premium content, cheapest first. */
export function premiumPlansLabel(): string {
  return new Intl.ListFormat("en", {
    style: "long",
    type: "conjunction",
  }).format(premiumPlans().map((plan) => PLAN_LABEL[plan]));
}

/** `the Pro and Pro+ plans`, or `the Pro plan` while only one plan includes premium content. */
export function premiumPlansPhrase(): string {
  return `the ${premiumPlansLabel()} ${premiumPlans().length === 1 ? "plan" : "plans"}`;
}

/** A padlock, drawn beside the label it qualifies; the label says the same thing in words. */
function LockIcon() {
  return (
    <svg
      className={styles.lock}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

/**
 * "Premium" beside a premium built-in's name. Locked, it gains a padlock and the `blocked` tone —
 * an entitlement is holding the content back, which is that tone's one meaning — and is read as
 * "Premium, locked" by assistive technology.
 */
export function PremiumBadge({
  locked = false,
  size = "default",
  testId = "premium-badge",
  label = "Premium",
}: {
  readonly locked?: boolean;
  readonly size?: "default" | "small";
  readonly testId?: string;
  /** The badge's word: `Premium`, or the plan that unlocks it (`Pro`) where that reads better. */
  readonly label?: string;
}) {
  const plans = premiumPlansLabel();
  return (
    <StatusBadge
      tone={locked ? "blocked" : "neutral"}
      variant="outline"
      size={size}
      testId={testId}
      dataAttributes={{ "data-locked": locked ? "true" : undefined }}
      {...(locked && plans !== "" ? { title: `Included in ${plans}` } : {})}
    >
      {locked ? <LockIcon /> : null}
      {label}
      {locked ? <VisuallyHidden>, locked</VisuallyHidden> : null}
    </StatusBadge>
  );
}

/**
 * Under a locked item: which plans include it, and the way to them. Text beside the item rather
 * than a tooltip, so it reads on a phone (UI-021).
 */
export function PremiumUpgradeHint({
  testId = "premium-upgrade-hint",
}: {
  readonly testId?: string;
}) {
  const plans = premiumPlansLabel();
  if (plans === "") {
    return null;
  }
  return (
    <span className={styles.hint} data-testid={testId}>
      Included in {plans}.{" "}
      <Link
        className={styles.link}
        href={PREMIUM_PLANS_HREF}
        data-testid="premium-see-plans"
      >
        See plans
      </Link>
    </span>
  );
}

/**
 * The page of a locked premium List or Strategy.
 *
 * The API refuses the object itself (`403 ENTITLEMENT_PREMIUM_CONTENT`), so there is nothing of it
 * to render — not even its name, which only the collection carries. This says what kind of thing it
 * is, which plans include it and where to go, instead of a "could not be loaded" error that a retry
 * would never fix.
 */
export function PremiumLockedState({
  thing,
  back,
  testId,
}: {
  readonly thing: "list" | "strategy";
  readonly back: { readonly href: string; readonly label: string };
  readonly testId?: string;
}) {
  const plans = premiumPlansLabel();
  const withheld = thing === "list" ? "Its members are" : "Its rules are";
  return (
    <EmptyState
      as="h1"
      {...(testId ? { testId } : {})}
      title={`This ${thing} is premium content`}
      body={
        <p>
          {plans === ""
            ? `${withheld} not included in your plan.`
            : `${withheld} included in ${plans}, where it can also be backtested and duplicated.`}
        </p>
      }
      actions={
        <>
          <Link
            className={forms.primaryButton}
            href={PREMIUM_PLANS_HREF}
            data-testid="premium-see-plans"
          >
            See plans
          </Link>
          <Link className={forms.secondaryButton} href={back.href}>
            Back to {back.label}
          </Link>
        </>
      }
    />
  );
}
