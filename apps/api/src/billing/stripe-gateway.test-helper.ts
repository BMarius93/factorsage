import { createHmac } from "node:crypto";
import { BillingError } from "@intrinsic/contracts";
import type {
  CreateCheckoutSessionInput,
  CreateCustomerInput,
  CreatePortalSessionInput,
  ScheduleSubscriptionPriceChangeInput,
  ScheduledChangeResult,
  StripeCheckoutSession,
  StripeCustomerBillingState,
  StripeGateway,
  StripePortalSession,
  StripePriceDescriptor,
  StripeScheduledPhase,
  StripeSubscriptionState,
  StripeWebhookEnvelope,
  UpdateSubscriptionPriceInput,
} from "./stripe-gateway";

/**
 * An in-memory Stripe, standing in for the real one at the gateway boundary.
 *
 * `docs/decisions/stripe-billing-v1.md` section 26 asks for a fake *at the Stripe service boundary*
 * rather than an HTTP interceptor or an SDK monkey-patch, and this is it: the deterministic suites
 * get the real reconciler, the real transaction, the real advisory lock, the real Prisma writes and
 * the real HTTP layer, with only Stripe replaced. Nothing about the rules under test is simulated.
 *
 * It models the parts of Stripe's behaviour the rules actually depend on, and nothing else:
 *
 * - subscription lifecycle and status;
 * - the **current** item price versus a held `pending_update`, which is what makes a failed upgrade
 *   keep the previous tier;
 * - subscription schedules with a future phase, which is what a scheduled downgrade is;
 * - idempotency keys, recorded so a test can assert a retry did not create a second object;
 * - webhook signatures, computed with the real Stripe scheme so the signature check under test is
 *   the genuine one rather than a stub that always passes.
 *
 * What it deliberately does not model: money, invoices, taxes, proration arithmetic. FactorSage never
 * computes any of those, so a fake that did would be testing something the product does not do.
 */

/** Matches Stripe's own `t=<ts>,v1=<sig>` scheme over `<ts>.<body>`. */
export function signStripePayload(
  payload: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

export type FakeSubscription = {
  id: string;
  customerId: string;
  status: string;
  currentPriceId: string;
  itemId: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  cancelAt: Date | null;
  canceledAt: Date | null;
  created: Date;
  scheduleId: string | null;
  /** A requested-but-unpaid price. Never what the subscription currently charges. */
  pendingPriceId: string | null;
  /** The future phase of this subscription's schedule. */
  scheduledPhase: StripeScheduledPhase | null;
};

export type FakeStripeOptions = {
  readonly webhookSecret: string;
  readonly testMode?: boolean;
  /**
   * Makes the next immediate change unpayable: Stripe holds it as a pending update and leaves the
   * current price alone. The sandbox equivalent is a card that declines on the proration invoice.
   */
  failNextImmediateChange?: boolean;
};

export class FakeStripeGateway implements StripeGateway {
  readonly testMode: boolean;

  readonly customers = new Map<string, { id: string; userId: string; deleted: boolean }>();
  readonly subscriptions = new Map<string, FakeSubscription>();
  readonly prices = new Map<string, StripePriceDescriptor>();

  /** Every idempotency key this fake has seen, by operation. Assertable from a test. */
  readonly idempotencyKeys: { operation: string; key: string }[] = [];

  readonly checkoutSessions: (CreateCheckoutSessionInput & { id: string })[] = [];
  readonly portalSessions: CreatePortalSessionInput[] = [];

  /** Counts, so a test can prove a retry made no second call rather than inferring it. */
  readonly callCounts = new Map<string, number>();

  failNextImmediateChange: boolean;

  private sequence = 0;

  constructor(private readonly options: FakeStripeOptions) {
    this.testMode = options.testMode ?? true;
    this.failNextImmediateChange = options.failNextImmediateChange ?? false;
  }

  // -------------------------------------------------------------------------
  // Test-facing helpers
  // -------------------------------------------------------------------------

  /** A customer as `resolveCustomerId` would have created one. */
  seedCustomer(userId: string, customerId = `cus_${this.next()}`): string {
    this.customers.set(customerId, { id: customerId, userId, deleted: false });
    return customerId;
  }

  /** A subscription in whatever state a scenario needs. */
  seedSubscription(input: {
    customerId: string;
    priceId: string;
    status?: string;
    id?: string;
    currentPeriodEnd?: Date;
    cancelAtPeriodEnd?: boolean;
    created?: Date;
  }): FakeSubscription {
    const id = input.id ?? `sub_${this.next()}`;
    const now = new Date();
    const subscription: FakeSubscription = {
      id,
      customerId: input.customerId,
      status: input.status ?? "active",
      currentPriceId: input.priceId,
      itemId: `si_${this.next()}`,
      currentPeriodStart: now,
      currentPeriodEnd:
        input.currentPeriodEnd ?? new Date(now.getTime() + 30 * 86_400_000),
      cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
      cancelAt: null,
      canceledAt: null,
      created: input.created ?? now,
      scheduleId: null,
      pendingPriceId: null,
      scheduledPhase: null,
    };
    this.subscriptions.set(id, subscription);
    return subscription;
  }

  /** What Stripe does when a scheduled phase's start time arrives. */
  applyScheduledPhase(subscriptionId: string): void {
    const subscription = this.require(subscriptionId);
    const phase = subscription.scheduledPhase;
    if (!phase) {
      throw new Error(`${subscriptionId} has no scheduled phase to apply`);
    }
    subscription.currentPriceId = phase.priceId;
    subscription.currentPeriodStart = phase.startsAt ?? new Date();
    subscription.currentPeriodEnd = new Date(
      (phase.startsAt ?? new Date()).getTime() + 30 * 86_400_000,
    );
    subscription.scheduledPhase = null;
    // `end_behavior: release` detaches the schedule once its last phase begins.
    subscription.scheduleId = null;
  }

  /** What Stripe does when a held upgrade is finally paid. */
  applyPendingUpdate(subscriptionId: string): void {
    const subscription = this.require(subscriptionId);
    if (!subscription.pendingPriceId) {
      throw new Error(`${subscriptionId} has no pending update to apply`);
    }
    subscription.currentPriceId = subscription.pendingPriceId;
    subscription.pendingPriceId = null;
    subscription.status = "active";
  }

  setStatus(subscriptionId: string, status: string): void {
    this.require(subscriptionId).status = status;
  }

  /**
   * Cancellation at period end, as the Customer Portal would set it.
   *
   * Refuses while a schedule is attached, which is exactly what real Stripe does: "The subscription is
   * managed by the subscription schedule ..., and updating any cancelation behavior directly is not
   * allowed." Modelling the refusal is the point — it is what keeps the fake honest about the
   * constraint that `releaseSubscriptionSchedule` exists to satisfy.
   */
  scheduleCancellation(subscriptionId: string): void {
    const subscription = this.require(subscriptionId);
    if (subscription.scheduleId) {
      throw new BillingError(
        `The subscription is managed by the subscription schedule ${subscription.scheduleId}, and updating any cancelation behavior directly is not allowed.`,
        { code: "BILLING_SUBSCRIPTION_UPDATE_FAILED" },
      );
    }
    subscription.cancelAtPeriodEnd = true;
    subscription.cancelAt = subscription.currentPeriodEnd;
  }

  reverseCancellation(subscriptionId: string): void {
    const subscription = this.require(subscriptionId);
    subscription.cancelAtPeriodEnd = false;
    subscription.cancelAt = null;
  }

  /** What Stripe does when the period ends on a subscription set to cancel. */
  endSubscription(subscriptionId: string): void {
    const subscription = this.require(subscriptionId);
    subscription.status = "canceled";
    subscription.canceledAt = new Date();
    subscription.cancelAtPeriodEnd = false;
  }

  seedPrice(descriptor: StripePriceDescriptor): void {
    this.prices.set(descriptor.id, descriptor);
  }

  /** A signed webhook body, exactly as Stripe would deliver it. */
  signedWebhook(input: {
    id: string;
    type: string;
    created?: Date;
    livemode?: boolean;
    object: Record<string, unknown>;
  }): { body: string; signature: string } {
    const body = JSON.stringify({
      id: input.id,
      type: input.type,
      created: Math.floor((input.created ?? new Date()).getTime() / 1000),
      livemode: input.livemode ?? !this.testMode,
      data: { object: input.object },
    });
    return {
      body,
      signature: signStripePayload(body, this.options.webhookSecret),
    };
  }

  private require(subscriptionId: string): FakeSubscription {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      throw new Error(`Unknown fake subscription ${subscriptionId}`);
    }
    return subscription;
  }

  private next(): string {
    this.sequence += 1;
    return `${this.sequence}`;
  }

  private record(operation: string, key?: string): void {
    this.callCounts.set(operation, (this.callCounts.get(operation) ?? 0) + 1);
    if (key) {
      this.idempotencyKeys.push({ operation, key });
    }
  }

  // -------------------------------------------------------------------------
  // StripeGateway
  // -------------------------------------------------------------------------

  async loadCustomerBillingState(
    customerId: string,
  ): Promise<StripeCustomerBillingState> {
    this.record("loadCustomerBillingState");
    const subscriptions: StripeSubscriptionState[] = [];
    const scheduledPhases: Record<string, StripeScheduledPhase | null> = {};

    for (const subscription of this.subscriptions.values()) {
      if (subscription.customerId !== customerId) {
        continue;
      }
      subscriptions.push({
        id: subscription.id,
        customerId: subscription.customerId,
        status: subscription.status,
        currentPriceId: subscription.currentPriceId,
        itemId: subscription.itemId,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        cancelAt: subscription.cancelAt,
        canceledAt: subscription.canceledAt,
        created: subscription.created,
        scheduleId: subscription.scheduleId,
        hasPendingUpdate: subscription.pendingPriceId !== null,
      });
      scheduledPhases[subscription.id] = subscription.scheduledPhase;
    }

    return { customerId, subscriptions, scheduledPhases };
  }

  async customerExists(customerId: string): Promise<boolean> {
    this.record("customerExists");
    const customer = this.customers.get(customerId);
    return customer !== undefined && !customer.deleted;
  }

  /**
   * Creates a customer, honouring the idempotency key the way Stripe does.
   *
   * Replaying a key returns the *same* customer rather than a new one, which is what makes the
   * "simultaneous first Checkout" test meaningful: without it the fake would happily create two and
   * the test would prove only that the lock ran.
   */
  async createCustomer(
    input: CreateCustomerInput,
  ): Promise<{ readonly id: string }> {
    this.record("createCustomer", input.idempotencyKey);
    const replay = [...this.customers.values()].find(
      (customer) => customer.userId === input.userId && !customer.deleted,
    );
    if (
      replay &&
      this.idempotencyKeys.filter(
        (entry) =>
          entry.operation === "createCustomer" &&
          entry.key === input.idempotencyKey,
      ).length > 1
    ) {
      return { id: replay.id };
    }
    return { id: this.seedCustomer(input.userId) };
  }

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<StripeCheckoutSession> {
    this.record("createCheckoutSession", input.idempotencyKey);
    const id = `cs_${this.next()}`;
    this.checkoutSessions.push({ ...input, id });
    return { id, url: `https://checkout.stripe.test/${id}` };
  }

  async createPortalSession(
    input: CreatePortalSessionInput,
  ): Promise<StripePortalSession> {
    this.record("createPortalSession", input.idempotencyKey);
    this.portalSessions.push(input);
    return { url: `https://portal.stripe.test/${input.customerId}` };
  }

  /**
   * The `pending_if_incomplete` semantics the real gateway relies on.
   *
   * On success the item moves to the new price. On failure the item is **unchanged** and the request
   * is held as a pending update — which is precisely why a failed upgrade cannot grant Pro: the
   * reconciler reads the current price and finds Starter.
   */
  async updateSubscriptionPriceImmediately(
    input: UpdateSubscriptionPriceInput,
  ): Promise<StripeSubscriptionState> {
    this.record("updateSubscriptionPriceImmediately", input.idempotencyKey);
    const subscription = this.subscriptions.get(input.subscriptionId);
    if (!subscription) {
      throw new BillingError("No such subscription", {
        code: "BILLING_SUBSCRIPTION_CONFLICT",
      });
    }

    if (this.failNextImmediateChange) {
      this.failNextImmediateChange = false;
      subscription.pendingPriceId = input.priceId;
    } else {
      subscription.currentPriceId = input.priceId;
      subscription.pendingPriceId = null;
    }

    const state = await this.loadCustomerBillingState(subscription.customerId);
    const updated = state.subscriptions.find(
      (candidate) => candidate.id === subscription.id,
    );
    if (!updated) {
      throw new Error("Fake gateway lost its own subscription");
    }
    return updated;
  }

  async scheduleSubscriptionPriceChange(
    input: ScheduleSubscriptionPriceChangeInput,
  ): Promise<ScheduledChangeResult> {
    this.record("scheduleSubscriptionPriceChange", input.idempotencyKey);
    const subscription = this.subscriptions.get(input.subscriptionId);
    if (!subscription) {
      throw new BillingError("No such subscription", {
        code: "BILLING_SUBSCRIPTION_CONFLICT",
      });
    }
    subscription.scheduleId ??= `sub_sched_${this.next()}`;
    subscription.scheduledPhase = {
      priceId: input.priceId,
      startsAt: input.effectiveAt,
    };
    return { scheduleId: subscription.scheduleId, effectiveAt: input.effectiveAt };
  }

  /**
   * Detaches the schedule, as Stripe's release does.
   *
   * Also models the constraint that made release necessary: {@link scheduleCancellation} refuses while
   * a schedule is attached, exactly as Stripe refuses "updating any cancelation behavior directly".
   */
  async releaseSubscriptionSchedule(scheduleId: string): Promise<void> {
    this.record("releaseSubscriptionSchedule");
    for (const subscription of this.subscriptions.values()) {
      if (subscription.scheduleId === scheduleId) {
        subscription.scheduleId = null;
      }
    }
  }

  /**
   * Verifies the signature with Stripe's real scheme.
   *
   * Recomputing the HMAC rather than accepting anything means the signature test exercises the
   * genuine check: a tampered body, a wrong secret or a missing header all fail here exactly as they
   * would against Stripe.
   */
  constructWebhookEvent(
    rawBody: Buffer,
    signature: string,
  ): StripeWebhookEnvelope {
    const timestamp = /t=(\d+)/.exec(signature)?.[1];
    const provided = /v1=([a-f0-9]+)/.exec(signature)?.[1];
    if (!timestamp || !provided) {
      throw new BillingError("Invalid webhook signature", {
        code: "BILLING_WEBHOOK_INVALID_SIGNATURE",
      });
    }
    const expected = createHmac("sha256", this.options.webhookSecret)
      .update(`${timestamp}.${rawBody.toString("utf8")}`)
      .digest("hex");
    if (expected !== provided) {
      throw new BillingError("Invalid webhook signature", {
        code: "BILLING_WEBHOOK_INVALID_SIGNATURE",
      });
    }

    const parsed = JSON.parse(rawBody.toString("utf8")) as {
      id: string;
      type: string;
      created: number;
      livemode: boolean;
      data: { object: Record<string, unknown> };
    };
    const object = parsed.data.object;
    const metadata = object.metadata as Record<string, unknown> | undefined;

    return {
      id: parsed.id,
      type: parsed.type,
      created: new Date(parsed.created * 1000),
      livemode: parsed.livemode,
      customerId: typeof object.customer === "string" ? object.customer : null,
      subscriptionId: parsed.type.startsWith("customer.subscription.")
        ? (typeof object.id === "string" ? object.id : null)
        : (typeof object.subscription === "string" ? object.subscription : null),
      metadataUserId:
        parsed.type === "checkout.session.completed"
          ? ((typeof metadata?.factorsageUserId === "string"
              ? metadata.factorsageUserId
              : null) ??
            (typeof object.client_reference_id === "string"
              ? object.client_reference_id
              : null))
          : null,
    };
  }

  async describePrices(
    priceIds: readonly string[],
  ): Promise<readonly StripePriceDescriptor[]> {
    this.record("describePrices");
    return priceIds
      .map((priceId) => this.prices.get(priceId))
      .filter((price): price is StripePriceDescriptor => price !== undefined);
  }
}
