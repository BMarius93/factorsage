import type { BillingSubscriptionStatus } from "@intrinsic/contracts";

/**
 * The Stripe boundary, as types.
 *
 * Everything in this file is FactorSage's own vocabulary. No Stripe SDK type crosses it, which is
 * what `docs/decisions/stripe-billing-v1.md` section 30 asks for and what makes the reconciler
 * testable: the deterministic suites implement {@link StripeGateway} with an in-memory fake and
 * exercise the real rules, while the sandbox smoke suite points the same interface at Stripe.
 *
 * The implementation lives in `stripe.gateway.ts`. It is the only file in the repository that
 * imports `stripe`.
 */

/** One Stripe subscription, reduced to the facts FactorSage reconciles from. */
export type StripeSubscriptionState = {
  readonly id: string;
  readonly customerId: string;
  /**
   * Stripe's raw status string, deliberately not yet mapped.
   *
   * Mapping happens in one place (`toMirroredStatus`) so a status Stripe adds later becomes
   * `UNKNOWN` rather than being silently treated as whatever branch it textually resembles.
   */
  readonly status: string;
  /**
   * The price the customer is being billed for **right now**.
   *
   * Never a price from `pending_update`. That distinction is the mechanism behind "a failed upgrade
   * does not grant the higher tier": Stripe holds the requested price on the object, but until the
   * proration invoice is paid it is not what this subscription charges.
   */
  readonly currentPriceId: string | null;
  /** The subscription item carrying that price; needed to update it. */
  readonly itemId: string | null;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly cancelAt: Date | null;
  readonly canceledAt: Date | null;
  readonly created: Date;
  /** The Subscription Schedule driving a scheduled change, when one exists. */
  readonly scheduleId: string | null;
  /** True while Stripe is holding an unpaid requested change. */
  readonly hasPendingUpdate: boolean;
};

/** The next phase of a subscription's schedule: what it becomes, and when. */
export type StripeScheduledPhase = {
  readonly priceId: string;
  readonly startsAt: Date | null;
};

/**
 * Everything about one Stripe Customer's billing that reconciliation needs, fetched together.
 *
 * One call rather than several, because reconciliation runs inside the user's advisory lock and
 * every extra round trip is time that lock is held.
 */
export type StripeCustomerBillingState = {
  readonly customerId: string;
  /** Every subscription, in any status, newest Stripe state. */
  readonly subscriptions: readonly StripeSubscriptionState[];
  /** Next scheduled phase per subscription id, when that subscription has a schedule. */
  readonly scheduledPhases: Readonly<Record<string, StripeScheduledPhase | null>>;
};

export type StripeCheckoutSession = {
  readonly id: string;
  readonly url: string;
};

export type StripePortalSession = {
  readonly url: string;
};

/** A verified Stripe webhook, reduced to what the handler dispatches on. */
export type StripeWebhookEnvelope = {
  readonly id: string;
  readonly type: string;
  readonly created: Date;
  readonly livemode: boolean;
  /** The Stripe Customer this event concerns, when the payload identifies one. */
  readonly customerId: string | null;
  /** The Stripe Subscription this event concerns, when the payload identifies one. */
  readonly subscriptionId: string | null;
  /**
   * FactorSage user id from server-controlled metadata on a Checkout Session.
   *
   * Present only on `checkout.session.completed`, and trusted only because *we* wrote it on a
   * session we created for an authenticated user. It is a resolution aid, never an authorization.
   */
  readonly metadataUserId: string | null;
};

/** One configured price, as Stripe currently holds it. Used only by the catalog verifier. */
export type StripePriceDescriptor = {
  readonly id: string;
  readonly active: boolean;
  readonly currency: string;
  readonly unitAmount: number | null;
  /** `month` / `year`, or null when the price is not recurring at all. */
  readonly recurringInterval: string | null;
  readonly recurringIntervalCount: number | null;
  /** `licensed` or `metered`. V1 sells licensed only. */
  readonly usageType: string | null;
  readonly productId: string | null;
  readonly productName: string | null;
  readonly productActive: boolean;
  readonly lookupKey: string | null;
};

export type CreateCustomerInput = {
  readonly userId: string;
  readonly email: string;
  /** Stable per user, so a retried creation can never produce a second canonical customer. */
  readonly idempotencyKey: string;
};

export type CreateCheckoutSessionInput = {
  readonly customerId: string;
  readonly userId: string;
  readonly priceId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly idempotencyKey: string;
};

export type CreatePortalSessionInput = {
  readonly customerId: string;
  readonly returnUrl: string;
  readonly idempotencyKey: string;
};

export type UpdateSubscriptionPriceInput = {
  readonly subscriptionId: string;
  readonly itemId: string;
  readonly priceId: string;
  readonly idempotencyKey: string;
};

export type ScheduleSubscriptionPriceChangeInput = {
  readonly subscriptionId: string;
  readonly priceId: string;
  /** End of the current paid period: when the scheduled phase takes over. */
  readonly effectiveAt: Date;
  readonly idempotencyKey: string;
};

export type ScheduledChangeResult = {
  readonly scheduleId: string;
  readonly effectiveAt: Date;
};

/**
 * Every Stripe operation FactorSage performs. Nothing else talks to Stripe.
 *
 * Each mutating method takes an idempotency key rather than generating one, because the stable
 * identity a retry must reuse is known by the caller — the user, the subscription, the change being
 * requested — and not by the adapter (decision document section 14).
 */
export interface StripeGateway {
  /** True when this gateway is pointed at a Stripe sandbox/test-mode key. */
  readonly testMode: boolean;

  loadCustomerBillingState(
    customerId: string,
  ): Promise<StripeCustomerBillingState>;

  /**
   * Whether this Stripe Customer still exists and is not deleted.
   *
   * The repair seam for a restored database or a customer removed in the Dashboard: a
   * `stripeCustomerId` that no longer resolves must not be silently reused for Checkout.
   */
  customerExists(customerId: string): Promise<boolean>;

  createCustomer(input: CreateCustomerInput): Promise<{ readonly id: string }>;

  createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<StripeCheckoutSession>;

  createPortalSession(
    input: CreatePortalSessionInput,
  ): Promise<StripePortalSession>;

  /**
   * Applies a price change now, letting Stripe prorate and bill it.
   *
   * The implementation must choose Stripe behaviour under which the subscription's *current* price
   * changes only once the proration invoice is paid, so an unpayable upgrade leaves the previous
   * tier in place (decision document section 8).
   */
  updateSubscriptionPriceImmediately(
    input: UpdateSubscriptionPriceInput,
  ): Promise<StripeSubscriptionState>;

  /** Schedules a price change for the end of the current paid period. */
  scheduleSubscriptionPriceChange(
    input: ScheduleSubscriptionPriceChangeInput,
  ): Promise<ScheduledChangeResult>;

  /**
   * Detaches a Subscription Schedule that has done its job, leaving an ordinary subscription.
   *
   * Not housekeeping — a correctness requirement. Stripe refuses to change *any* cancellation
   * behaviour on a subscription while a schedule manages it ("updating any cancelation behavior
   * directly is not allowed"), and Customer Portal's cancel button does exactly that. A schedule
   * whose final phase is open-ended never ends, so `end_behavior: release` never fires and the
   * schedule stays attached forever: without this call, every user who ever changed plan or cadence
   * would permanently lose the ability to cancel.
   *
   * Idempotent from the caller's point of view: releasing an already-released schedule is reported as
   * success.
   */
  releaseSubscriptionSchedule(scheduleId: string): Promise<void>;

  /** Verifies a Stripe signature over the exact raw request body and decodes the event. */
  constructWebhookEvent(
    rawBody: Buffer,
    signature: string,
  ): StripeWebhookEnvelope;

  /** Reads the configured prices as Stripe currently holds them. Verifier only. */
  describePrices(
    priceIds: readonly string[],
  ): Promise<readonly StripePriceDescriptor[]>;
}

/**
 * Stripe's subscription status, mapped into FactorSage's mirrored enum.
 *
 * The pinned SDK types `Subscription.status` as a union **plus an open string**, because Stripe may
 * add one. Anything unrecognized becomes `UNKNOWN`, which `resolveEffectivePlan` treats as
 * granting no paid plan — the fail-closed default the decision document (section 10) requires
 * instead of a permissive `else`.
 */
export function toMirroredStatus(status: string): BillingSubscriptionStatus {
  switch (status) {
    case "incomplete":
      return "INCOMPLETE";
    case "incomplete_expired":
      return "INCOMPLETE_EXPIRED";
    case "trialing":
      return "TRIALING";
    case "active":
      return "ACTIVE";
    case "past_due":
      return "PAST_DUE";
    case "canceled":
      return "CANCELED";
    case "unpaid":
      return "UNPAID";
    case "paused":
      return "PAUSED";
    default:
      return "UNKNOWN";
  }
}
