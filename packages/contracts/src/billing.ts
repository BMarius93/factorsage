import type { UserPlan } from "./entitlements.js";

/**
 * Stripe Billing V1 — the pure half.
 *
 * `docs/decisions/stripe-billing-v1.md` is the product decision this file carries; it is not
 * restated or reinterpreted here. Everything below is pure: no I/O, no clock, no Stripe SDK type
 * and no `process.env`. That is what lets the API, the reconciliation CLI and the browser share
 * one answer to "which plan does this billing state mean" instead of three.
 *
 * **The direction is one-way.**
 *
 * ```text
 * Stripe billing state -> persisted User.plan -> resolveEntitlements() -> guards
 * ```
 *
 * Nothing here imports an entitlement limit and nothing in `entitlements.ts` imports anything from
 * this file. Billing decides *which* plan a user is on; the entitlement matrix decides what that
 * plan may do. `billing.entitlements-boundary.test.ts` is what keeps the two from growing into
 * each other.
 *
 * **Money lives here, product capacity does not.** A catalog entry carries an amount because an
 * amount is billing — it is what the catalog verifier compares against Stripe. It carries no list
 * size, no backtest depth and no monitor count, because those are entitlements.
 */

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/**
 * The four logical purchase targets. This list *is* the allowlist: a client names one of these,
 * never a Stripe Price ID, and the server resolves it to the configured price for its environment.
 *
 * `FREE` is deliberately absent — there is no Stripe Price for it, and moving to Free is a
 * cancellation, never a price switch (decision document section 7).
 */
export const BILLING_PRICE_KEYS = [
  "STARTER_MONTHLY",
  "STARTER_YEARLY",
  "PRO_MONTHLY",
  "PRO_YEARLY",
] as const;

export type BillingPriceKey = (typeof BILLING_PRICE_KEYS)[number];

export function isBillingPriceKey(value: unknown): value is BillingPriceKey {
  return (
    typeof value === "string" &&
    (BILLING_PRICE_KEYS as readonly string[]).includes(value)
  );
}

/** A plan that can be bought. `FREE` is the absence of a paid subscription, never a purchase. */
export type PaidPlan = Exclude<UserPlan, "FREE">;

export const PAID_PLANS: readonly PaidPlan[] = ["STARTER", "PRO"];

export function isPaidPlan(value: unknown): value is PaidPlan {
  return value === "STARTER" || value === "PRO";
}

/** Billing cadence. Uppercase because it is persisted as a PostgreSQL enum, not a Stripe string. */
export const BILLING_INTERVALS = ["MONTH", "YEAR"] as const;

export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === "MONTH" || value === "YEAR";
}

export type BillingCatalogEntry = {
  readonly key: BillingPriceKey;
  readonly plan: PaidPlan;
  readonly interval: BillingInterval;
  /** Price in the currency's minor unit — cents. Billing data, never an entitlement. */
  readonly amountMinorUnits: number;
  readonly currency: "usd";
  /**
   * Operational convenience only. A Stripe `lookup_key` makes the Dashboard and the verifier
   * legible, but runtime authorization always resolves through the configured Price ID allowlist,
   * never through a value Stripe holds (decision document section 1).
   */
  readonly lookupKey: string;
};

/**
 * The V1 catalog, exactly as the decision document fixes it: $9 / $99 / $29 / $299.
 *
 * These amounts are what `pnpm billing:verify-catalog` asserts against the configured Stripe
 * prices, so a Dashboard price edited to the wrong number fails loudly instead of quietly selling
 * Pro for nine dollars.
 */
export const BILLING_CATALOG: Readonly<
  Record<BillingPriceKey, BillingCatalogEntry>
> = {
  STARTER_MONTHLY: {
    key: "STARTER_MONTHLY",
    plan: "STARTER",
    interval: "MONTH",
    amountMinorUnits: 900,
    currency: "usd",
    lookupKey: "factorsage_starter_monthly",
  },
  STARTER_YEARLY: {
    key: "STARTER_YEARLY",
    plan: "STARTER",
    interval: "YEAR",
    amountMinorUnits: 9_900,
    currency: "usd",
    lookupKey: "factorsage_starter_yearly",
  },
  PRO_MONTHLY: {
    key: "PRO_MONTHLY",
    plan: "PRO",
    interval: "MONTH",
    amountMinorUnits: 2_900,
    currency: "usd",
    lookupKey: "factorsage_pro_monthly",
  },
  PRO_YEARLY: {
    key: "PRO_YEARLY",
    plan: "PRO",
    interval: "YEAR",
    amountMinorUnits: 29_900,
    currency: "usd",
    lookupKey: "factorsage_pro_yearly",
  },
};

export const BILLING_CATALOG_ENTRIES: readonly BillingCatalogEntry[] =
  BILLING_PRICE_KEYS.map((key) => BILLING_CATALOG[key]);

export function billingCatalogEntry(key: BillingPriceKey): BillingCatalogEntry {
  return BILLING_CATALOG[key];
}

/** The one logical key for a (plan, interval) pair. The inverse of the catalog. */
export function billingPriceKeyFor(
  plan: PaidPlan,
  interval: BillingInterval,
): BillingPriceKey {
  const entry = BILLING_CATALOG_ENTRIES.find(
    (candidate) => candidate.plan === plan && candidate.interval === interval,
  );
  if (!entry) {
    // Unreachable while the catalog covers both plans in both intervals; the throw is what makes
    // adding a third plan a compile-and-test failure rather than a silent `undefined`.
    throw new Error(`No billing price key for ${plan}/${interval}`);
  }
  return entry.key;
}

// ---------------------------------------------------------------------------
// Transition classification
// ---------------------------------------------------------------------------

/**
 * Plan rank **for billing transitions only** (decision document section 7: `FREE < STARTER < PRO`).
 *
 * This is not an entitlement comparison and must never be used as one. Feature code asks the
 * entitlement resolver for a named capability; this ordering exists so billing can answer one
 * question — is the target more or less entitlement than the current plan — which is what decides
 * immediate versus scheduled.
 */
const BILLING_PLAN_RANK: Readonly<Record<UserPlan, number>> = {
  FREE: 0,
  STARTER: 1,
  PRO: 2,
};

export function billingPlanRank(plan: UserPlan): number {
  return BILLING_PLAN_RANK[plan];
}

/** When a requested change takes effect. */
export const BILLING_TRANSITION_EFFECTS = [
  /** Applied now. Stripe prorates and bills; the entitlement follows only once it is paid. */
  "IMMEDIATE",
  /** Applied by Stripe at the end of the current paid period. */
  "SCHEDULED",
  /** The target is already the current price. Nothing to do. */
  "UNCHANGED",
] as const;

export type BillingTransitionEffect =
  (typeof BILLING_TRANSITION_EFFECTS)[number];

export const BILLING_TRANSITION_KINDS = [
  "TIER_UPGRADE",
  "TIER_DOWNGRADE",
  /** Same tier, monthly to yearly. */
  "CADENCE_LENGTHENED",
  /** Same tier, yearly to monthly. */
  "CADENCE_SHORTENED",
  "SAME_PRICE",
] as const;

export type BillingTransitionKind = (typeof BILLING_TRANSITION_KINDS)[number];

export type BillingTransition = {
  readonly from: BillingPriceKey;
  readonly to: BillingPriceKey;
  readonly kind: BillingTransitionKind;
  readonly effect: BillingTransitionEffect;
};

/**
 * What a requested price change is, and when it happens.
 *
 * **Tier direction beats interval direction**, which is the rule that is easy to get wrong. A
 * Starter *yearly* customer moving to Pro *monthly* is shortening their cadence, but they are
 * buying more entitlement, so it is an immediate upgrade. A Pro *monthly* customer moving to
 * Starter *yearly* is lengthening their cadence, but they are buying less entitlement, so it is
 * scheduled for period end. Classifying by monthly/yearly first produces the opposite answer for
 * both, which is why the tier comparison is unconditionally first here.
 */
export function classifyBillingTransition(
  from: BillingPriceKey,
  to: BillingPriceKey,
): BillingTransition {
  const current = BILLING_CATALOG[from];
  const target = BILLING_CATALOG[to];

  if (from === to) {
    return { from, to, kind: "SAME_PRICE", effect: "UNCHANGED" };
  }

  const currentRank = billingPlanRank(current.plan);
  const targetRank = billingPlanRank(target.plan);

  if (targetRank > currentRank) {
    return { from, to, kind: "TIER_UPGRADE", effect: "IMMEDIATE" };
  }
  if (targetRank < currentRank) {
    return { from, to, kind: "TIER_DOWNGRADE", effect: "SCHEDULED" };
  }

  // Same tier, so only the cadence moved.
  return target.interval === "YEAR"
    ? { from, to, kind: "CADENCE_LENGTHENED", effect: "IMMEDIATE" }
    : { from, to, kind: "CADENCE_SHORTENED", effect: "SCHEDULED" };
}

// ---------------------------------------------------------------------------
// Mirrored subscription status
// ---------------------------------------------------------------------------

/**
 * Stripe subscription statuses, mirrored into our own vocabulary.
 *
 * Uppercase and local on purpose: this is persisted as a PostgreSQL enum and read by the browser,
 * neither of which may depend on a Stripe SDK type. `UNKNOWN` exists because the pinned SDK types
 * the status as a union *plus an open string* — Stripe may introduce one — and the decision
 * document (section 10) requires every status to be handled explicitly with no permissive default.
 */
export const BILLING_SUBSCRIPTION_STATUSES = [
  "INCOMPLETE",
  "INCOMPLETE_EXPIRED",
  "TRIALING",
  "ACTIVE",
  "PAST_DUE",
  "CANCELED",
  "UNPAID",
  "PAUSED",
  /** A status this version of FactorSage does not know. Never grants a paid plan. */
  "UNKNOWN",
] as const;

export type BillingSubscriptionStatus =
  (typeof BILLING_SUBSCRIPTION_STATUSES)[number];

/**
 * The billing facts an effective-plan decision is allowed to depend on.
 *
 * `plan` and `interval` are `null` when the subscription's **current** price is not one of the
 * four configured prices — an archived legacy price, a Dashboard experiment, another environment's
 * price. That is a fail-closed state, not an error to swallow.
 */
export type BillingSubscriptionSnapshot = {
  readonly status: BillingSubscriptionStatus;
  readonly plan: PaidPlan | null;
  readonly interval: BillingInterval | null;
};

export const BILLING_PLAN_REASONS = [
  /** No canonical subscription at all. */
  "NO_SUBSCRIPTION",
  "SUBSCRIPTION_ACTIVE",
  /** `past_due`: Stripe is still recovering the renewal, so the earned plan is kept. */
  "SUBSCRIPTION_IN_RECOVERY",
  /** The first payment has not completed. Never grants the plan. */
  "SUBSCRIPTION_INCOMPLETE",
  /** Canceled, expired or terminally unpaid. */
  "SUBSCRIPTION_TERMINATED",
  /** A status V1 does not support — a trial, a pause, something new. Conservative: FREE. */
  "SUBSCRIPTION_UNSUPPORTED_STATUS",
  /** The current price is not in the configured catalog. Conservative: FREE. */
  "PRICE_NOT_IN_CATALOG",
] as const;

export type BillingPlanReason = (typeof BILLING_PLAN_REASONS)[number];

export type EffectivePlanDecision = {
  readonly plan: UserPlan;
  readonly reason: BillingPlanReason;
  /**
   * True when the decision is one an operator should look at: an unsupported status or a price
   * outside the catalog. The plan is still resolved conservatively; this is what makes the
   * condition observable rather than silent (decision document sections 10 and 15).
   */
  readonly anomalous: boolean;
};

/**
 * The one function that turns billing state into a FactorSage plan.
 *
 * Webhooks, the reconciliation CLI and the tests all reach the plan through here — there is no
 * second implementation of these rules, which is what makes "repair" and "normal sync" provably
 * identical (decision document section 16).
 *
 * Three readings worth stating, because they are the ones the document is explicit about and they
 * look surprising in isolation:
 *
 * - `past_due` **keeps** the plan. A renewal whose card failed is in Stripe's retry window, and
 *   destroying access for a temporary decline is worse than carrying a few days of risk.
 * - `incomplete` **never** grants it. A Checkout Session that was created, or even submitted, is
 *   not a payment.
 * - `trialing` and `paused` **do not** grant it. V1 sells neither, so seeing one means somebody
 *   edited the subscription in the Dashboard into a state this product has no rules for, and
 *   section 10 requires that to be conservative and loud rather than quietly generous.
 *
 * The caller derives `plan` from the subscription's **current** item price, never from a
 * `pending_update`. That is what makes a failed upgrade keep the previous tier: the requested
 * price exists on the Stripe object, but it is not what the customer is being billed for yet.
 */
export function resolveEffectivePlan(
  snapshot: BillingSubscriptionSnapshot | null,
): EffectivePlanDecision {
  if (snapshot === null) {
    return { plan: "FREE", reason: "NO_SUBSCRIPTION", anomalous: false };
  }

  if (snapshot.plan === null) {
    return { plan: "FREE", reason: "PRICE_NOT_IN_CATALOG", anomalous: true };
  }

  switch (snapshot.status) {
    case "ACTIVE":
      return {
        plan: snapshot.plan,
        reason: "SUBSCRIPTION_ACTIVE",
        anomalous: false,
      };
    case "PAST_DUE":
      return {
        plan: snapshot.plan,
        reason: "SUBSCRIPTION_IN_RECOVERY",
        anomalous: false,
      };
    case "INCOMPLETE":
      return {
        plan: "FREE",
        reason: "SUBSCRIPTION_INCOMPLETE",
        anomalous: false,
      };
    case "INCOMPLETE_EXPIRED":
    case "CANCELED":
    case "UNPAID":
      return {
        plan: "FREE",
        reason: "SUBSCRIPTION_TERMINATED",
        anomalous: false,
      };
    case "TRIALING":
    case "PAUSED":
    case "UNKNOWN":
      return {
        plan: "FREE",
        reason: "SUBSCRIPTION_UNSUPPORTED_STATUS",
        anomalous: true,
      };
  }
}

/**
 * Whether a subscription still occupies the user's one paid slot.
 *
 * The one-subscription invariant (decision document section 15) is about *canonical* subscriptions,
 * not about whether the plan is currently granted: an `incomplete` Checkout attempt does not grant
 * Pro, but starting a second Checkout while it is outstanding would be how a user ends up with two
 * subscriptions. Terminal states release the slot.
 */
export function occupiesPaidSlot(status: BillingSubscriptionStatus): boolean {
  switch (status) {
    case "ACTIVE":
    case "PAST_DUE":
    case "TRIALING":
    case "PAUSED":
    case "INCOMPLETE":
    case "UNKNOWN":
      return true;
    case "INCOMPLETE_EXPIRED":
    case "CANCELED":
    case "UNPAID":
      return false;
  }
}

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

/** A scheduled future price change, mirrored from Stripe for the UI. */
export type BillingPendingChange = {
  readonly plan: PaidPlan;
  readonly interval: BillingInterval;
  /** ISO 8601. Null when Stripe has not fixed the effective instant yet. */
  readonly effectiveAt: string | null;
};

/**
 * The billing half of a user's account, as the browser may see it.
 *
 * Deliberately carries no Stripe Customer ID, Subscription ID, secret, invoice or payload: a UI
 * needs to render the plan, the cadence, the renewal date and what is scheduled, and every
 * operation that acts on those is bound server-side to the authenticated user (decision document
 * sections 17 and 21).
 */
export type BillingSubscriptionView = {
  readonly plan: PaidPlan | null;
  readonly interval: BillingInterval | null;
  readonly status: BillingSubscriptionStatus;
  /** ISO 8601 instant the current paid period ends, when Stripe reports one. */
  readonly currentPeriodEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
  /** ISO 8601 instant the subscription will actually end, when a cancellation is scheduled. */
  readonly cancelAt: string | null;
  readonly pendingChange: BillingPendingChange | null;
};

export type BillingStatusResponse = {
  /**
   * The user's persisted commercial plan — the same column every entitlement check reads. It is
   * *not* recomputed from Stripe for this response: showing something the guards would refuse is
   * exactly the optimistic display the decision document (section 19) forbids.
   */
  readonly plan: UserPlan;
  /** False when this deployment has no Stripe configuration; the UI then offers no purchase path. */
  readonly billingEnabled: boolean;
  readonly subscription: BillingSubscriptionView | null;
  /** What the UI may offer right now. Advisory — every route re-decides server-side. */
  readonly canStartCheckout: boolean;
  readonly canOpenPortal: boolean;
  readonly canChangePlan: boolean;
  /** The four purchase targets, so the pricing UI has one source for names and amounts. */
  readonly catalog: readonly BillingCatalogEntry[];
};

export type BillingCheckoutRequest = {
  /** A logical catalog key. An arbitrary Stripe Price ID is not accepted and never has been. */
  readonly priceKey: BillingPriceKey;
};

export type BillingCheckoutResponse = {
  /** Stripe-hosted Checkout. The browser redirects here; returning from it grants nothing. */
  readonly checkoutUrl: string;
};

export type BillingPortalResponse = {
  readonly portalUrl: string;
};

export type BillingChangeRequest = {
  readonly priceKey: BillingPriceKey;
};

export type BillingChangeResponse = {
  readonly effect: BillingTransitionEffect;
  readonly kind: BillingTransitionKind;
  /** Set when the change was scheduled rather than applied. ISO 8601. */
  readonly effectiveAt: string | null;
  /**
   * The plan **as persisted right now**. For an immediate upgrade this is the new tier only if
   * Stripe has already taken payment; a pending upgrade reports the previous tier, which is the
   * honest answer and the one the guards will enforce.
   */
  readonly plan: UserPlan;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Machine-readable billing failures.
 *
 * Separate from `EntitlementReasonCode` on purpose (decision document section 20): "your card was
 * declined" and "your plan does not include this" are different problems with different remedies,
 * and collapsing them produces a UI that tells a paying customer to upgrade.
 */
export const BILLING_ERROR_CODES = [
  /** No authenticated session. Guests have no billing identity. */
  "BILLING_AUTH_REQUIRED",
  /** This deployment has no Stripe configuration. */
  "BILLING_NOT_CONFIGURED",
  /** The requested target is not one of the four catalog keys. */
  "BILLING_INVALID_PRICE_KEY",
  /** A configured Price ID is missing, duplicated or otherwise unusable. */
  "BILLING_CATALOG_MISCONFIGURED",
  /** Checkout was asked for by a user who already holds a canonical paid subscription. */
  "BILLING_ALREADY_SUBSCRIBED",
  /** A plan change or portal session was asked for by a user with no paid subscription. */
  "BILLING_NO_SUBSCRIPTION",
  /** More than one canonical customer, or a customer that does not resolve. */
  "BILLING_CUSTOMER_CONFLICT",
  /** More than one live subscription for one user — the invariant violation in section 15. */
  "BILLING_SUBSCRIPTION_CONFLICT",
  /** The requested transition is not one V1 supports from the current state. */
  "BILLING_CHANGE_NOT_ALLOWED",
  /** Stripe accepted the change but requires payment before it becomes effective. */
  "BILLING_PAYMENT_REQUIRED",
  "BILLING_CHECKOUT_FAILED",
  "BILLING_PORTAL_UNAVAILABLE",
  "BILLING_SUBSCRIPTION_UPDATE_FAILED",
  /** Stripe could not be reached, or answered with an error we cannot attribute. */
  "BILLING_STRIPE_UNAVAILABLE",
  /** The webhook signature did not verify against the configured secret. */
  "BILLING_WEBHOOK_INVALID_SIGNATURE",
  /** A webhook resolved to state V1 has no rules for. Observable; never grants access. */
  "BILLING_WEBHOOK_UNSUPPORTED_STATE",
] as const;

export type BillingReasonCode = (typeof BILLING_ERROR_CODES)[number];

export type BillingErrorDetail = {
  readonly code: BillingReasonCode;
  /** The catalog key the caller asked for, when the failure is about one. */
  readonly priceKey?: BillingPriceKey;
  /** What the user's plan is right now, so a UI can render the refusal in context. */
  readonly plan?: UserPlan;
};

/**
 * A billing refusal.
 *
 * Carries a safe message and a stable code — never a Stripe error object, a raw payload, a
 * customer id or a subscription id. The original Stripe failure is logged server-side before
 * translation, so the detail is recoverable from logs without ever crossing the wire.
 */
export class BillingError extends Error {
  readonly detail: BillingErrorDetail;

  constructor(message: string, detail: BillingErrorDetail) {
    super(message);
    this.name = "BillingError";
    this.detail = detail;
  }

  get code(): BillingReasonCode {
    return this.detail.code;
  }
}

export function isBillingError(value: unknown): value is BillingError {
  return value instanceof BillingError;
}
