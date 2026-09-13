import type { StripeBillingConfig } from "@intrinsic/config";
import {
  BILLING_CATALOG_ENTRIES,
  BillingError,
  billingPriceKeyFor,
  classifyBillingTransition,
  occupiesPaidSlot,
  type AuthUser,
  type BillingChangeResponse,
  type BillingPendingChange,
  type BillingPriceKey,
  type BillingStatusResponse,
  type BillingSubscriptionView,
  type UserPlan,
} from "@intrinsic/contracts";
import { lockUserEntitlementScope } from "@intrinsic/database";
import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { BillingCatalog } from "./billing-catalog";
import { BillingReconciliationService } from "./billing-reconciliation.service";
import {
  BILLING_CATALOG_TOKEN,
  BILLING_LOGGER,
  STRIPE_BILLING_CONFIG,
  STRIPE_GATEWAY,
} from "./billing.tokens";
import type { StripeGateway } from "./stripe-gateway";

/**
 * Everything a user can *ask* billing to do, and nothing that decides a plan.
 *
 * The division of labour is deliberate: this service validates, authorizes, resolves logical price
 * keys to configured Stripe prices and asks Stripe to change something.
 * `BillingReconciliationService` is the only thing that decides what `User.plan` becomes, and every
 * method here that changes Stripe state finishes by calling it rather than inferring the outcome
 * itself. A plan granted from the return value of a subscription update would be a plan granted
 * before payment.
 *
 * ## Idempotency keys
 *
 * Every server-initiated Stripe write carries one, derived from stable identity rather than
 * regenerated per retry (decision document section 14):
 *
 * | Operation | Key | Why that identity |
 * | --- | --- | --- |
 * | Customer creation | `factorsage:customer:<userId>` | Stable **forever**. Two simultaneous first-Checkout requests cannot create two canonical customers, and neither can a retry days later. |
 * | Checkout session | `factorsage:checkout:<userId>:<priceKey>:<requestId>` | Stable for one user action and all its internal retries; a genuinely new attempt is a new request and gets a new key, because a user who abandoned Checkout must be able to start again. |
 * | Immediate change | `factorsage:sub-update:<subscriptionId>:<fromPriceId>:<toPriceId>` | The *change* is the identity. A retry of the same transition reuses the key and cannot bill a second proration; a different transition is a different key. |
 * | Scheduled change | `factorsage:sub-schedule:<subscriptionId>:<toPriceId>:<effectiveAt>` | Guards the *creation* of the Subscription Schedule only. The phases update carries no key, because it creates nothing and a replayed key with corrected parameters is refused by Stripe for 24 hours — `StripeApiGateway.scheduleSubscriptionPriceChange` explains why. |
 * | Portal session | `factorsage:portal:<customerId>:<requestId>` | Per user action. |
 */
@Injectable()
export class BillingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BILLING_LOGGER) private readonly logger: StructuredLogger,
    @Inject(BillingReconciliationService)
    private readonly reconciliation: BillingReconciliationService,
    @Optional()
    @Inject(STRIPE_GATEWAY)
    private readonly stripe: StripeGateway | null,
    @Optional()
    @Inject(BILLING_CATALOG_TOKEN)
    private readonly catalog: BillingCatalog | null,
    @Optional()
    @Inject(STRIPE_BILLING_CONFIG)
    private readonly config: StripeBillingConfig | null,
  ) {}

  get configured(): boolean {
    return (
      this.stripe !== null && this.catalog !== null && this.config !== null
    );
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /**
   * The user's billing state as the UI may see it.
   *
   * `plan` is the **persisted** column, not a plan recomputed from Stripe for this response.
   * Recomputing it would let the page show a tier the entitlement guards would refuse, which is the
   * optimistic display the decision document (section 19) forbids.
   */
  async readStatus(user: AuthUser): Promise<BillingStatusResponse> {
    const subscription = await this.prisma.billingSubscription.findUnique({
      where: { userId: user.id },
    });
    const account = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { plan: true, stripeCustomerId: true },
    });

    const plan: UserPlan = account?.plan ?? user.plan;
    const holdsSlot = subscription
      ? occupiesPaidSlot(subscription.status)
      : false;

    return {
      plan,
      billingEnabled: this.configured,
      subscription: subscription ? toSubscriptionView(subscription) : null,
      canStartCheckout: this.configured && !holdsSlot,
      canOpenPortal: this.configured && account?.stripeCustomerId !== null,
      canChangePlan:
        this.configured && holdsSlot && subscription?.plan !== null,
      catalog: BILLING_CATALOG_ENTRIES,
    };
  }

  // -------------------------------------------------------------------------
  // Checkout
  // -------------------------------------------------------------------------

  /**
   * Starts a hosted Checkout for a user who has no paid subscription.
   *
   * The already-subscribed check runs **inside the user's advisory lock**, together with the
   * customer resolution, so two simultaneous requests cannot both pass it. Without that, the window
   * between "no subscription found" and "session created" is exactly wide enough for a double-click
   * to buy two subscriptions.
   */
  async createCheckoutSession(input: {
    readonly user: AuthUser;
    readonly priceKey: BillingPriceKey;
    /** Per-user-action identity for the Stripe idempotency key. */
    readonly requestId: string;
  }): Promise<{ readonly checkoutUrl: string }> {
    const { stripe, catalog, config } = this.requireConfigured();
    const price = catalog.resolveKey(input.priceKey);

    const customerId = await this.prisma.$transaction(async (tx) => {
      await lockUserEntitlementScope(tx, input.user.id);

      const existing = await tx.billingSubscription.findUnique({
        where: { userId: input.user.id },
        select: { status: true },
      });
      if (existing && occupiesPaidSlot(existing.status)) {
        throw new BillingError(
          "You already have a subscription. Manage it from billing settings instead.",
          {
            code: "BILLING_ALREADY_SUBSCRIBED",
            priceKey: input.priceKey,
            plan: input.user.plan,
          },
        );
      }

      return this.resolveCustomerId(tx, input.user, stripe);
    });

    const session = await stripe.createCheckoutSession({
      customerId,
      userId: input.user.id,
      priceId: price.priceId,
      successUrl: config.checkoutSuccessUrl,
      cancelUrl: config.checkoutCancelUrl,
      idempotencyKey: `factorsage:checkout:${input.user.id}:${input.priceKey}:${input.requestId}`,
    });

    this.logger.info({
      event: "billing.checkout.created",
      actorUserId: input.user.id,
      priceKey: input.priceKey,
      plan: price.plan,
      billingInterval: price.interval,
      checkoutSessionId: session.id,
    });

    return { checkoutUrl: session.url };
  }

  // -------------------------------------------------------------------------
  // Customer Portal
  // -------------------------------------------------------------------------

  /**
   * A short-lived Customer Portal session for **this** user's own Stripe customer.
   *
   * The customer id is read from the authenticated user's row and never from the request, so there
   * is no shape of input that opens someone else's portal. The return URL is server configuration
   * for the same reason.
   */
  async createPortalSession(input: {
    readonly user: AuthUser;
    readonly requestId: string;
  }): Promise<{ readonly portalUrl: string }> {
    const { stripe, config } = this.requireConfigured();

    const account = await this.prisma.user.findUnique({
      where: { id: input.user.id },
      select: { stripeCustomerId: true },
    });

    if (!account?.stripeCustomerId) {
      throw new BillingError(
        "There is nothing to manage yet. Choose a plan to get started.",
        { code: "BILLING_NO_SUBSCRIPTION", plan: input.user.plan },
      );
    }

    const session = await stripe.createPortalSession({
      customerId: account.stripeCustomerId,
      returnUrl: config.portalReturnUrl,
      idempotencyKey: `factorsage:portal:${account.stripeCustomerId}:${input.requestId}`,
    });

    this.logger.info({
      event: "billing.portal.created",
      actorUserId: input.user.id,
    });

    return { portalUrl: session.url };
  }

  // -------------------------------------------------------------------------
  // Plan change
  // -------------------------------------------------------------------------

  /**
   * Moves an existing paid subscription onto another catalog price.
   *
   * This endpoint exists because the Customer Portal cannot express FactorSage's transition matrix.
   * Portal price switching applies **one** proration policy to every switch in a configuration, so
   * it can be "always immediate" or "always at period end" — while sections 7 to 9 require immediate
   * for a tier upgrade *and* for monthly→yearly, and period-end for a tier downgrade *and* for
   * yearly→monthly. No single Portal setting produces both, and the decision document is explicit
   * that the product rule does not bend to fit the surface. Portal keeps payment methods, invoices
   * and cancellation, where its behaviour *is* what we want.
   *
   * The entitlement consequence of the change is never inferred here. Stripe is asked, and then
   * reconciliation reads back canonical state and decides — which is why a failed upgrade payment
   * leaves the response reporting the previous plan.
   */
  async changePlan(input: {
    readonly user: AuthUser;
    readonly priceKey: BillingPriceKey;
    readonly requestId: string;
  }): Promise<BillingChangeResponse> {
    const { stripe, catalog } = this.requireConfigured();
    const target = catalog.resolveKey(input.priceKey);

    const subscription = await this.prisma.billingSubscription.findUnique({
      where: { userId: input.user.id },
    });

    if (!subscription || !occupiesPaidSlot(subscription.status)) {
      throw new BillingError(
        "You do not have an active subscription to change. Choose a plan to get started.",
        {
          code: "BILLING_NO_SUBSCRIPTION",
          priceKey: input.priceKey,
          plan: input.user.plan,
        },
      );
    }

    const current = catalog.resolvePriceId(subscription.stripePriceId);
    if (!current) {
      // The subscription is on a price this deployment does not recognize. Classifying a transition
      // from it would be a guess, and a guess here changes what somebody is charged.
      this.logger.error({
        event: "billing.change.unknown-current-price",
        actorUserId: input.user.id,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
      });
      throw new BillingError(
        "Your subscription needs attention from support before it can be changed.",
        {
          code: "BILLING_SUBSCRIPTION_CONFLICT",
          priceKey: input.priceKey,
          plan: input.user.plan,
        },
      );
    }

    const currentKey = billingPriceKeyFor(current.plan, current.interval);
    const transition = classifyBillingTransition(currentKey, input.priceKey);

    if (transition.effect === "UNCHANGED") {
      throw new BillingError("You are already on that plan.", {
        code: "BILLING_CHANGE_NOT_ALLOWED",
        priceKey: input.priceKey,
        plan: input.user.plan,
      });
    }

    // A subscription already scheduled to end is not a subscription to move onto another price:
    // the user has asked to stop paying, and layering a plan change over that produces a state
    // neither they nor the schedule can express. Reversing the cancellation in Portal comes first.
    if (subscription.cancelAtPeriodEnd) {
      throw new BillingError(
        "Your subscription is scheduled to cancel. Resume it from billing management before changing plan.",
        {
          code: "BILLING_CHANGE_NOT_ALLOWED",
          priceKey: input.priceKey,
          plan: input.user.plan,
        },
      );
    }

    this.logger.info({
      event: "billing.change.requested",
      actorUserId: input.user.id,
      from: currentKey,
      to: input.priceKey,
      kind: transition.kind,
      effect: transition.effect,
    });

    // Both branches act on **live** Stripe state, not on the mirror.
    //
    // The mirror is a projection and can legitimately be a few seconds behind — a renewal that has
    // just rolled the period, a webhook still in flight. Either branch would then be wrong in a way
    // that costs money: an immediate change needs the current item id, and a scheduled change needs
    // the current period end, and scheduling a phase at a boundary that has already passed is
    // rejected by Stripe (or, worse, would apply a downgrade early and give away a paid period).
    const live = await this.loadLiveSubscription(
      input.user.id,
      subscription.stripeSubscriptionId,
      input.priceKey,
    );

    let scheduledFor: Date | null = null;

    if (transition.effect === "IMMEDIATE") {
      if (!live.itemId) {
        throw new BillingError("Your subscription could not be loaded.", {
          code: "BILLING_SUBSCRIPTION_CONFLICT",
          priceKey: input.priceKey,
        });
      }

      await stripe.updateSubscriptionPriceImmediately({
        subscriptionId: live.id,
        itemId: live.itemId,
        priceId: target.priceId,
        idempotencyKey: `factorsage:sub-update:${live.id}:${current.priceId}:${target.priceId}`,
      });
    } else {
      const effectiveAt = live.currentPeriodEnd;
      if (!effectiveAt) {
        // Without a period end there is no boundary to schedule at. Refusing is correct: applying
        // it now would turn a downgrade into an immediate one and give away the paid period.
        this.logger.error({
          event: "billing.change.no-period-end",
          actorUserId: input.user.id,
          stripeSubscriptionId: live.id,
        });
        throw new BillingError(
          "Your billing period could not be determined. Please try again shortly.",
          {
            code: "BILLING_SUBSCRIPTION_CONFLICT",
            priceKey: input.priceKey,
          },
        );
      }

      const scheduled = await stripe.scheduleSubscriptionPriceChange({
        subscriptionId: live.id,
        priceId: target.priceId,
        effectiveAt,
        idempotencyKey: `factorsage:sub-schedule:${live.id}:${target.priceId}:${Math.floor(effectiveAt.getTime() / 1000)}`,
      });
      scheduledFor = scheduled.effectiveAt;
    }

    // Stripe has moved. Read canonical state back and let the one plan decision run.
    const result = await this.reconciliation.reconcileUser({
      userId: input.user.id,
      trigger: "PLAN_CHANGE",
    });

    this.logger.info({
      event: "billing.change.completed",
      actorUserId: input.user.id,
      from: currentKey,
      to: input.priceKey,
      kind: transition.kind,
      effect: transition.effect,
      plan: result.plan,
      planChanged: result.planChanged,
    });

    return {
      effect: transition.effect,
      kind: transition.kind,
      effectiveAt: scheduledFor?.toISOString() ?? null,
      plan: result.plan,
    };
  }

  // -------------------------------------------------------------------------
  // Customer lifecycle
  // -------------------------------------------------------------------------

  /**
   * The user's canonical Stripe Customer, created on first need.
   *
   * Must be called inside a transaction that already holds the user's advisory lock: the read of
   * `stripeCustomerId` and the write of a newly created one have to be one atomic step, or two
   * simultaneous first-Checkout requests each create a customer and one id is lost — leaving an
   * orphaned Stripe customer that could later collect its own subscription.
   *
   * The Stripe call additionally uses an idempotency key that is stable for the life of the user, so
   * even a retry that somehow escaped the lock returns the *same* customer rather than a second one.
   *
   * A persisted id that Stripe no longer has — a deleted customer, a restored database pointed at a
   * different Stripe account — is replaced rather than reused, because reusing it fails at Checkout
   * where the user is watching.
   */
  private async resolveCustomerId(
    tx: Parameters<Parameters<PrismaService["$transaction"]>[0]>[0],
    user: AuthUser,
    stripe: StripeGateway,
  ): Promise<string> {
    const account = await tx.user.findUnique({
      where: { id: user.id },
      select: { stripeCustomerId: true, email: true },
    });
    if (!account) {
      throw new BillingError("No such account", {
        code: "BILLING_CUSTOMER_CONFLICT",
      });
    }

    if (account.stripeCustomerId) {
      if (await stripe.customerExists(account.stripeCustomerId)) {
        return account.stripeCustomerId;
      }
      this.logger.warn({
        event: "billing.customer.missing-at-stripe",
        actorUserId: user.id,
      });
    }

    const created = await stripe.createCustomer({
      userId: user.id,
      email: account.email,
      idempotencyKey: `factorsage:customer:${user.id}`,
    });

    await tx.user.update({
      where: { id: user.id },
      data: { stripeCustomerId: created.id },
    });

    this.logger.info({
      event: "billing.customer.created",
      actorUserId: user.id,
    });

    return created.id;
  }

  /**
   * The caller's canonical subscription as Stripe currently holds it.
   *
   * Reads through the customer, not by subscription id directly, so a mirrored subscription that
   * belongs to a *different* customer — the shape a restore or a manual edit can leave — is not
   * found and cannot be modified on this user's behalf.
   */
  private async loadLiveSubscription(
    userId: string,
    stripeSubscriptionId: string,
    priceKey: BillingPriceKey,
  ) {
    const { stripe } = this.requireConfigured();
    const state = await stripe.loadCustomerBillingState(
      await this.requireCustomerId(userId),
    );
    const live = state.subscriptions.find(
      (candidate) => candidate.id === stripeSubscriptionId,
    );
    if (!live) {
      this.logger.error({
        event: "billing.change.subscription-not-at-stripe",
        actorUserId: userId,
        stripeSubscriptionId,
      });
      throw new BillingError("Your subscription could not be loaded.", {
        code: "BILLING_SUBSCRIPTION_CONFLICT",
        priceKey,
      });
    }
    return live;
  }

  private async requireCustomerId(userId: string): Promise<string> {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { stripeCustomerId: true },
    });
    if (!account?.stripeCustomerId) {
      throw new BillingError("There is nothing to manage yet.", {
        code: "BILLING_NO_SUBSCRIPTION",
      });
    }
    return account.stripeCustomerId;
  }

  private requireConfigured(): {
    stripe: StripeGateway;
    catalog: BillingCatalog;
    config: StripeBillingConfig;
  } {
    if (!this.stripe || !this.catalog || !this.config) {
      throw new BillingError(
        "Billing is not available in this environment.",
        { code: "BILLING_NOT_CONFIGURED" },
      );
    }
    return {
      stripe: this.stripe,
      catalog: this.catalog,
      config: this.config,
    };
  }
}

/** The mirror row, projected onto the UI-safe view. No Stripe ids cross this boundary. */
function toSubscriptionView(row: {
  plan: UserPlan | null;
  billingInterval: "MONTH" | "YEAR" | null;
  status: BillingSubscriptionView["status"];
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: Date | null;
  pendingPlan: UserPlan | null;
  pendingInterval: "MONTH" | "YEAR" | null;
  pendingEffectiveAt: Date | null;
}): BillingSubscriptionView {
  const pendingChange: BillingPendingChange | null =
    row.pendingPlan && row.pendingPlan !== "FREE" && row.pendingInterval
      ? {
          plan: row.pendingPlan,
          interval: row.pendingInterval,
          effectiveAt: row.pendingEffectiveAt?.toISOString() ?? null,
        }
      : null;

  return {
    plan: row.plan && row.plan !== "FREE" ? row.plan : null,
    interval: row.billingInterval,
    status: row.status,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    cancelAt: row.cancelAt?.toISOString() ?? null,
    pendingChange,
  };
}
