import type {
  BillingInterval,
  BillingPlanReason,
  BillingPriceKey,
  BillingSubscriptionStatus,
  PaidPlan,
  UserPlan,
} from "@intrinsic/contracts";

/**
 * The FactorSage **billing** QA personas.
 *
 * A different thing from the entitlement personas in `./personas.ts`, and kept in a different
 * registry on purpose. An entitlement persona is a fixed point on a plan: its `User.plan` is seeded
 * directly, it has no Stripe object at all, and it must keep working with no Stripe configured
 * (`docs/decisions/stripe-billing-v1.md` section 29). A billing persona is a fixed point in a
 * **subscription lifecycle**: its state exists in real Stripe test mode, and the only thing that
 * turns that state into a `BillingSubscription` mirror and a `User.plan` is the application's own
 * `BillingReconciliationService`. Nothing here, and nothing that reads this, writes a paid plan.
 *
 * Each persona declares two things and keeps them apart:
 *
 * - {@link BillingPersona.lifecycle} — how its Stripe state is **built** (a real subscription on a
 *   Stripe Test Clock, then whatever that lifecycle needs: a scheduled cancellation, a renewal
 *   against a card that fails, the period end arriving);
 * - {@link BillingPersona.expected} — what FactorSage must **resolve** from it, written as literals
 *   taken from the decision document's status policy, never computed from `resolveEffectivePlan`.
 *   A registry that derived its expectations from the implementation would agree with every bug in
 *   it.
 *
 * Deliberately free of workspace imports at runtime (the imports above are types): the Playwright
 * harness reads this through a dependency-free subpath, exactly like `./personas`.
 *
 * `docs/development/billing-qa-personas.md` is the runbook.
 */

export const BILLING_PERSONA_NAMES = [
  "BILLING_STARTER_ACTIVE",
  "BILLING_PRO_ACTIVE",
  "BILLING_PRO_CANCELING",
  "BILLING_STARTER_PAST_DUE",
  "BILLING_CANCELED",
] as const;

export type BillingPersonaName = (typeof BILLING_PERSONA_NAMES)[number];

/**
 * How a persona's Stripe state is reached. Every lifecycle starts from a real, paid subscription.
 *
 * - `ACTIVE` — nothing more.
 * - `CANCELING` — a cancellation scheduled for the end of the paid period, which has not arrived.
 * - `PAST_DUE` — the payment method is replaced by one that fails on charge and the Test Clock is
 *   advanced over the renewal, so Stripe itself puts the subscription into `past_due`.
 * - `CANCELED` — a cancellation scheduled for the end of the paid period, and the Test Clock
 *   advanced past it, so Stripe itself ends the subscription.
 */
export const BILLING_PERSONA_LIFECYCLES = [
  "ACTIVE",
  "CANCELING",
  "PAST_DUE",
  "CANCELED",
] as const;

export type BillingPersonaLifecycle =
  (typeof BILLING_PERSONA_LIFECYCLES)[number];

/** What Stripe must hold, and what FactorSage must make of it. All literals. */
export type BillingPersonaExpectation = {
  /** Stripe's own subscription status string. */
  readonly stripeStatus: "active" | "past_due" | "canceled";
  /**
   * Whether Stripe holds a cancellation that has **not happened yet**.
   *
   * Asserted through `hasScheduledCancellation`, never through one raw field: Stripe has two
   * representations of it and the pinned API version returns the newer one
   * (`ai/architecture/billing.md`, "Cancellation"). Not asserted for a subscription that has
   * already ended, whose leftover `cancel_at` describes the past.
   */
  readonly cancellationScheduled: boolean;
  /** `BillingSubscription.status` after reconciliation. */
  readonly mirrorStatus: BillingSubscriptionStatus;
  /** `BillingSubscription.planReason`: why reconciliation resolved the plan it did. */
  readonly planReason: BillingPlanReason;
  /** `User.plan` after reconciliation — the only input the entitlement resolver reads. */
  readonly userPlan: UserPlan;
  /** Whether the subscription still holds the user's one paid slot, so Checkout is refused. */
  readonly holdsPaidSlot: boolean;
};

export type BillingPersona = {
  readonly name: BillingPersonaName;
  /** Lower-case handle for the command line: `pnpm qa:billing:seed -- --persona pro-active`. */
  readonly slug: string;
  /**
   * The account's address. Stated here rather than read from the environment, because it is also
   * the identity the Stripe fixtures are tagged with: it must mean the same account to the seeder,
   * the cleanup and the browser suite. `.test` is reserved (RFC 2606) and can never be a mailbox.
   */
  readonly email: string;
  /** The one configured catalog price the persona subscribes to. */
  readonly priceKey: BillingPriceKey;
  /** The plan and cadence that price means. Checked against `BILLING_CATALOG` by a test. */
  readonly subscribedPlan: PaidPlan;
  readonly interval: BillingInterval;
  readonly lifecycle: BillingPersonaLifecycle;
  readonly expected: BillingPersonaExpectation;
  /** Where Playwright keeps this persona's signed-in storage state. Git-ignored. */
  readonly storageState: string;
  /** What this persona exists for. Read by the docs and by anyone choosing one. */
  readonly purpose: string;
};

/** Every billing persona's address is `qa-billing-<slug>@factorsage.test`. */
export const BILLING_PERSONA_EMAIL_DOMAIN = "factorsage.test";

function billingPersonaEmail(slug: string): string {
  return `qa-billing-${slug}@${BILLING_PERSONA_EMAIL_DOMAIN}`;
}

function billingPersonaStorageState(slug: string): string {
  return `playwright/.auth/billing-${slug}.json`;
}

export const BILLING_PERSONAS: Readonly<
  Record<BillingPersonaName, BillingPersona>
> = {
  BILLING_STARTER_ACTIVE: {
    name: "BILLING_STARTER_ACTIVE",
    slug: "starter-active",
    email: billingPersonaEmail("starter-active"),
    priceKey: "STARTER_YEARLY",
    subscribedPlan: "STARTER",
    interval: "YEAR",
    lifecycle: "ACTIVE",
    expected: {
      stripeStatus: "active",
      cancellationScheduled: false,
      mirrorStatus: "ACTIVE",
      planReason: "SUBSCRIPTION_ACTIVE",
      userPlan: "STARTER",
      holdsPaidSlot: true,
    },
    storageState: billingPersonaStorageState("starter-active"),
    purpose:
      "The baseline: a paid Starter subscription with nothing scheduled. It is the control for " +
      "BILLING_STARTER_PAST_DUE — same plan, different Stripe status, same entitlements — and it " +
      "bills the yearly Starter price, so the five personas between them cover all four " +
      "configured catalog prices.",
  },
  BILLING_PRO_ACTIVE: {
    name: "BILLING_PRO_ACTIVE",
    slug: "pro-active",
    email: billingPersonaEmail("pro-active"),
    priceKey: "PRO_MONTHLY",
    subscribedPlan: "PRO",
    interval: "MONTH",
    lifecycle: "ACTIVE",
    expected: {
      stripeStatus: "active",
      cancellationScheduled: false,
      mirrorStatus: "ACTIVE",
      planReason: "SUBSCRIPTION_ACTIVE",
      userPlan: "PRO",
      holdsPaidSlot: true,
    },
    storageState: billingPersonaStorageState("pro-active"),
    purpose:
      "A paying Pro customer. Unlike PRO_USER, whose plan is seeded, this account is PRO because " +
      "Stripe says so and reconciliation agreed.",
  },
  BILLING_PRO_CANCELING: {
    name: "BILLING_PRO_CANCELING",
    slug: "pro-canceling",
    email: billingPersonaEmail("pro-canceling"),
    priceKey: "PRO_YEARLY",
    subscribedPlan: "PRO",
    interval: "YEAR",
    lifecycle: "CANCELING",
    expected: {
      stripeStatus: "active",
      cancellationScheduled: true,
      mirrorStatus: "ACTIVE",
      planReason: "SUBSCRIPTION_ACTIVE",
      userPlan: "PRO",
      holdsPaidSlot: true,
    },
    storageState: billingPersonaStorageState("pro-canceling"),
    purpose:
      "A Pro customer who has asked to stop paying and whose paid period has not ended. The plan " +
      "must not move, the billing page must say when access ends, and a plan change must be " +
      "refused until the cancellation is reversed.",
  },
  BILLING_STARTER_PAST_DUE: {
    name: "BILLING_STARTER_PAST_DUE",
    slug: "starter-past-due",
    email: billingPersonaEmail("starter-past-due"),
    priceKey: "STARTER_MONTHLY",
    subscribedPlan: "STARTER",
    interval: "MONTH",
    lifecycle: "PAST_DUE",
    expected: {
      stripeStatus: "past_due",
      cancellationScheduled: false,
      mirrorStatus: "PAST_DUE",
      planReason: "SUBSCRIPTION_IN_RECOVERY",
      // Kept on purpose: FactorSage grants the earned plan during Stripe's retry window
      // (decision document section 10, "Renewal payment failure").
      userPlan: "STARTER",
      holdsPaidSlot: true,
    },
    storageState: billingPersonaStorageState("starter-past-due"),
    purpose:
      "A Starter customer whose renewal payment failed and whom Stripe is still retrying. Access " +
      "is deliberately kept; the page must warn rather than downgrade.",
  },
  BILLING_CANCELED: {
    name: "BILLING_CANCELED",
    slug: "canceled",
    email: billingPersonaEmail("canceled"),
    priceKey: "PRO_MONTHLY",
    subscribedPlan: "PRO",
    interval: "MONTH",
    lifecycle: "CANCELED",
    expected: {
      stripeStatus: "canceled",
      // The cancellation is no longer scheduled: it happened.
      cancellationScheduled: false,
      mirrorStatus: "CANCELED",
      planReason: "SUBSCRIPTION_TERMINATED",
      userPlan: "FREE",
      holdsPaidSlot: false,
    },
    storageState: billingPersonaStorageState("canceled"),
    purpose:
      "A former Pro customer whose subscription ran to the end of its paid period and ended. " +
      "FREE, with the ended subscription still mirrored so the page can say why — and free to " +
      "subscribe again.",
  },
};

export const BILLING_PERSONA_LIST: readonly BillingPersona[] =
  BILLING_PERSONA_NAMES.map((name) => BILLING_PERSONAS[name]);

export function billingPersona(name: BillingPersonaName): BillingPersona {
  return BILLING_PERSONAS[name];
}

export function isBillingPersonaName(
  value: unknown,
): value is BillingPersonaName {
  return (
    typeof value === "string" &&
    (BILLING_PERSONA_NAMES as readonly string[]).includes(value)
  );
}

/** Resolves a command-line handle (`pro-active`, …) or a full name to a persona, or `undefined`. */
export function billingPersonaByHandle(
  handle: string,
): BillingPersona | undefined {
  const wanted = handle.trim();
  return BILLING_PERSONA_LIST.find(
    (persona) =>
      persona.slug === wanted.toLowerCase() ||
      persona.name === wanted.toUpperCase(),
  );
}

/** Every handle the billing persona commands accept, for usage messages. */
export const BILLING_PERSONA_SLUGS: readonly string[] =
  BILLING_PERSONA_LIST.map((persona) => persona.slug);

/**
 * The one optional secret: a password every billing persona can sign in with.
 *
 * Optional because the billing state does not depend on it — seeding, inspection and cleanup run
 * without it. It exists so a person, or the browser suite, can open the product as one of these
 * accounts. One variable for all of them, because the accounts hold nothing but test-mode billing
 * state and a persona is told apart by its address.
 */
export const BILLING_PERSONA_PASSWORD_ENV = "QA_BILLING_PASSWORD";

/** The product's own registration policy, so a persona can always use the real sign-in form. */
export const BILLING_PERSONA_PASSWORD_MIN_LENGTH = 12;
