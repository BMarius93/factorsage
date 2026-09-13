import type { StripeBillingConfig } from "@intrinsic/config";
import { BillingError } from "@intrinsic/contracts";
import type { StructuredLogger } from "@intrinsic/observability";
import Stripe from "stripe";
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
 * The only file in the repository that imports the Stripe SDK.
 *
 * It translates in both directions and does nothing else: no plan decision, no entitlement, no
 * database access, no policy. Every rule about *when* a plan changes lives in
 * `@intrinsic/contracts` and in `billing-reconciliation.service.ts`; this class only makes Stripe's
 * answers legible to them.
 *
 * ## Pinned API version
 *
 * `stripe@22.6.2` pins API version **`2026-08-26.dahlia`**, and the SDK is constructed without an
 * `apiVersion` override so the types and the wire format cannot disagree. Two behaviours of that
 * version materially shape the code below and are the reason it is stated here rather than
 * discovered later:
 *
 * 1. **`current_period_start` / `current_period_end` are no longer on the Subscription.** They live
 *    on each subscription *item*. A V1 subscription has exactly one item, so
 *    {@link toSubscriptionState} reads the period from it. Code written against an older version
 *    would silently read `undefined` and mirror a null renewal date.
 * 2. **`billing_mode` defaults to `flexible`** for subscriptions created under this version, which
 *    is Stripe's current recommended mode for new integrations. It is therefore not passed
 *    explicitly: passing it would pin today's default into the code and make a future default
 *    change invisible.
 *
 * ## Failure translation
 *
 * Stripe errors are logged with their type and code and then re-thrown as `BillingError` with a
 * safe message. A raw Stripe error object must never reach a client: it can carry request ids,
 * customer ids and, for card errors, payment detail.
 */
export class StripeApiGateway implements StripeGateway {
  readonly testMode: boolean;

  private readonly stripe: Stripe;

  constructor(
    private readonly config: StripeBillingConfig,
    private readonly logger: StructuredLogger,
  ) {
    this.testMode = config.testMode;
    this.stripe = new Stripe(config.secretKey, {
      // No `apiVersion`: the SDK's own pinned version is the one its types describe.
      timeout: config.timeoutMs,
      maxNetworkRetries: config.maxNetworkRetries,
      appInfo: { name: "FactorSage", version: "1.0.0" },
    });
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async loadCustomerBillingState(
    customerId: string,
  ): Promise<StripeCustomerBillingState> {
    const subscriptions = await this.call("subscriptions.list", () =>
      this.stripe.subscriptions.list({
        customer: customerId,
        // Every status, including terminal ones: a canceled subscription is exactly what proves the
        // user should be FREE, so filtering to active states would make cancellation invisible.
        status: "all",
        limit: 100,
        expand: ["data.schedule"],
      }),
    );

    const states: StripeSubscriptionState[] = [];
    const scheduledPhases: Record<string, StripeScheduledPhase | null> = {};

    for (const subscription of subscriptions.data) {
      states.push(toSubscriptionState(subscription));
      scheduledPhases[subscription.id] = nextScheduledPhase(subscription);
    }

    return { customerId, subscriptions: states, scheduledPhases };
  }

  async customerExists(customerId: string): Promise<boolean> {
    try {
      const customer = await this.stripe.customers.retrieve(customerId);
      // A deleted customer still retrieves, with `deleted: true`. Reusing one for Checkout fails
      // at Stripe, so it has to be treated as absent here.
      return !(customer as Stripe.DeletedCustomer).deleted;
    } catch (error: unknown) {
      if (isResourceMissing(error)) {
        return false;
      }
      throw this.translate("customers.retrieve", error);
    }
  }

  async describePrices(
    priceIds: readonly string[],
  ): Promise<readonly StripePriceDescriptor[]> {
    const described: StripePriceDescriptor[] = [];

    for (const priceId of priceIds) {
      const price = await this.call("prices.retrieve", () =>
        this.stripe.prices.retrieve(priceId, { expand: ["product"] }),
      );
      const product =
        typeof price.product === "string" ? null : (price.product as Stripe.Product);

      described.push({
        id: price.id,
        active: price.active,
        currency: price.currency,
        unitAmount: price.unit_amount ?? null,
        recurringInterval: price.recurring?.interval ?? null,
        recurringIntervalCount: price.recurring?.interval_count ?? null,
        usageType: price.recurring?.usage_type ?? null,
        productId: product?.id ?? (typeof price.product === "string" ? price.product : null),
        productName: product?.name ?? null,
        // A product retrieved as a string was not expanded; treat that as "unknown, not inactive".
        productActive: product ? product.active : true,
        lookupKey: price.lookup_key ?? null,
      });
    }

    return described;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async createCustomer(
    input: CreateCustomerInput,
  ): Promise<{ readonly id: string }> {
    const customer = await this.call("customers.create", () =>
      this.stripe.customers.create(
        {
          email: input.email,
          // Metadata is for support and reconciliation, never for authorization: the authoritative
          // link is `User.stripeCustomerId`, which only this server writes.
          metadata: { factorsageUserId: input.userId },
        },
        { idempotencyKey: input.idempotencyKey },
      ),
    );
    return { id: customer.id };
  }

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<StripeCheckoutSession> {
    const session = await this.call("checkout.sessions.create", () =>
      this.stripe.checkout.sessions.create(
        {
          mode: "subscription",
          customer: input.customerId,
          line_items: [{ price: input.priceId, quantity: 1 }],
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          // Both carry the same server-controlled identity, on the session and on the subscription
          // it creates, so either object alone resolves back to a FactorSage user.
          client_reference_id: input.userId,
          metadata: { factorsageUserId: input.userId },
          subscription_data: {
            metadata: { factorsageUserId: input.userId },
          },
        },
        { idempotencyKey: input.idempotencyKey },
      ),
    );

    if (!session.url) {
      this.logger.error({
        event: "billing.stripe.checkout.no-url",
        sessionId: session.id,
      });
      throw new BillingError("Could not start checkout. Please try again.", {
        code: "BILLING_CHECKOUT_FAILED",
      });
    }

    return { id: session.id, url: session.url };
  }

  async createPortalSession(
    input: CreatePortalSessionInput,
  ): Promise<StripePortalSession> {
    const session = await this.call("billingPortal.sessions.create", () =>
      this.stripe.billingPortal.sessions.create(
        { customer: input.customerId, return_url: input.returnUrl },
        { idempotencyKey: input.idempotencyKey },
      ),
    );
    return { url: session.url };
  }

  /**
   * Immediate price change, billed by Stripe now.
   *
   * `proration_behavior: "always_invoice"` makes Stripe compute the unused-time credit and the new
   * charge and invoice it immediately — FactorSage never does that arithmetic (decision document
   * section 8).
   *
   * `payment_behavior: "pending_if_incomplete"` is the load-bearing choice. If the proration
   * invoice cannot be paid, Stripe stores the request as a `pending_update` and **leaves the
   * subscription's items on the old price**. Reconciliation reads the current item price, so the
   * user keeps the tier they have already paid for, and the higher tier appears only once Stripe
   * reports the new price as current — exactly "the user must not receive Pro merely because a
   * subscription-update request was attempted". With `always_invoice` alone the item would flip
   * immediately and an unpaid invoice would be the only thing standing between a failed card and a
   * free upgrade.
   */
  async updateSubscriptionPriceImmediately(
    input: UpdateSubscriptionPriceInput,
  ): Promise<StripeSubscriptionState> {
    const subscription = await this.call("subscriptions.update", () =>
      this.stripe.subscriptions.update(
        input.subscriptionId,
        {
          items: [{ id: input.itemId, price: input.priceId, quantity: 1 }],
          proration_behavior: "always_invoice",
          payment_behavior: "pending_if_incomplete",
        },
        { idempotencyKey: input.idempotencyKey },
      ),
    );
    return toSubscriptionState(subscription);
  }

  /**
   * Scheduled price change at the end of the current paid period.
   *
   * A Subscription Schedule is the mechanism Stripe provides for this, and the one its own Customer
   * Portal uses for scheduled downgrades. The current phase is pinned to end at `effectiveAt` and a
   * second phase carries the new price; `proration_behavior: "none"` on the boundary because
   * nothing is prorated — the user simply stops paying the old price when it expires. The unused
   * higher-tier period is deliberately not refunded (decision document section 7).
   *
   * **Only the schedule *creation* carries an idempotency key, and that is deliberate.**
   *
   * A key protects against a retry duplicating a side effect, and the two calls here differ in
   * whether they have one. `subscriptionSchedules.create` brings a new Stripe object into existence,
   * so a retry could leave two schedules behind: it gets a key. The phases `update` creates nothing
   * and charges nothing — it declares what the schedule's phases *are*, so running it twice is
   * already idempotent in the only sense that matters.
   *
   * Keying the update as well actively broke it. Stripe refuses a key replayed with different
   * parameters, so the moment a first attempt failed and was retried with corrected parameters — a
   * fixed bug, a recomputed boundary — every affected user was locked out of that transition for the
   * 24 hours Stripe remembers the key, with a `400` that looks nothing like its cause. Sandbox
   * testing hit exactly that. A key that turns a recoverable failure into a day-long one is worse
   * than no key on a call that cannot double-charge.
   */
  async scheduleSubscriptionPriceChange(
    input: ScheduleSubscriptionPriceChangeInput,
  ): Promise<ScheduledChangeResult> {
    const subscription = await this.call("subscriptions.retrieve", () =>
      this.stripe.subscriptions.retrieve(input.subscriptionId),
    );

    const existingScheduleId =
      typeof subscription.schedule === "string"
        ? subscription.schedule
        : (subscription.schedule?.id ?? null);

    const scheduleId =
      existingScheduleId ??
      (
        await this.call("subscriptionSchedules.create", () =>
          this.stripe.subscriptionSchedules.create(
            { from_subscription: input.subscriptionId },
            { idempotencyKey: `${input.idempotencyKey}:schedule` },
          ),
        )
      ).id;

    const schedule = await this.call("subscriptionSchedules.retrieve", () =>
      this.stripe.subscriptionSchedules.retrieve(scheduleId),
    );

    const currentPhase = selectCurrentPhase(schedule.phases);
    if (!currentPhase) {
      this.logger.error({
        event: "billing.stripe.schedule.no-phase",
        scheduleId,
      });
      throw new BillingError(
        "Could not schedule the plan change. Please try again.",
        { code: "BILLING_SUBSCRIPTION_UPDATE_FAILED" },
      );
    }

    const effectiveAtSeconds = Math.floor(input.effectiveAt.getTime() / 1000);

    const updated = await this.call("subscriptionSchedules.update", () =>
      this.stripe.subscriptionSchedules.update(
        scheduleId,
        {
          // `release` rather than `cancel`: when the final phase ends the schedule detaches and
          // leaves an ordinary subscription behind, which is what keeps the Customer Portal and
          // every later change working normally.
          end_behavior: "release",
          phases: [
            {
              start_date: currentPhase.start_date,
              end_date: effectiveAtSeconds,
              items: currentPhase.items.map((item) => ({
                price:
                  typeof item.price === "string" ? item.price : item.price.id,
                quantity: item.quantity ?? 1,
              })),
              proration_behavior: "none",
            },
            {
              items: [{ price: input.priceId, quantity: 1 }],
              proration_behavior: "none",
            },
          ],
        },
        // No idempotency key — see the note above.
      ),
    );

    const scheduledPhase = updated.phases.at(-1);
    return {
      scheduleId,
      effectiveAt: scheduledPhase?.start_date
        ? new Date(scheduledPhase.start_date * 1000)
        : input.effectiveAt,
    };
  }

  /**
   * Releases a schedule, leaving the subscription it managed behind, unchanged and independent.
   *
   * An already-released or completed schedule is not an error here: the desired end state is "no
   * schedule attached", and it is already true. Anything else is logged and rethrown as a translated
   * failure, because a schedule that will not release keeps cancellation broken.
   */
  async releaseSubscriptionSchedule(scheduleId: string): Promise<void> {
    try {
      await this.stripe.subscriptionSchedules.release(scheduleId);
      this.logger.info({
        event: "billing.stripe.schedule.released",
        scheduleId,
      });
    } catch (error: unknown) {
      const stripeError =
        error instanceof Stripe.errors.StripeError ? error : null;
      const message = stripeError?.message ?? "";
      if (
        isResourceMissing(error) ||
        /already been released|cannot be released|not active|status.*(released|canceled|completed)/i.test(
          message,
        )
      ) {
        this.logger.debug({
          event: "billing.stripe.schedule.release-not-needed",
          scheduleId,
        });
        return;
      }
      throw this.translate("subscriptionSchedules.release", error);
    }
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /**
   * Verifies the Stripe signature over the **raw** body and decodes the event.
   *
   * The raw bytes matter: the signature covers the exact payload Stripe sent, so a body that has
   * been parsed and re-serialized — different key order, different number formatting — verifies
   * against nothing. `main.ts` enables Nest's `rawBody` for this route.
   */
  constructWebhookEvent(
    rawBody: Buffer,
    signature: string,
  ): StripeWebhookEnvelope {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.config.webhookSecret,
      );
    } catch (error: unknown) {
      // Deliberately low-detail: a caller who cannot produce a valid signature learns only that.
      this.logger.warn({
        event: "billing.webhook.signature.invalid",
        err: error,
      });
      throw new BillingError("Invalid webhook signature", {
        code: "BILLING_WEBHOOK_INVALID_SIGNATURE",
      });
    }

    return {
      id: event.id,
      type: event.type,
      created: new Date(event.created * 1000),
      livemode: event.livemode,
      ...identifyEventSubject(event),
    };
  }

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  private async call<T>(operation: string, run: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await run();
      this.logger.debug({
        event: "billing.stripe.call.completed",
        operation,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error: unknown) {
      throw this.translate(operation, error, Date.now() - startedAt);
    }
  }

  /**
   * Logs the original Stripe failure, then returns a safe `BillingError`.
   *
   * The original object is logged *before* translation so its type, code and stack survive in logs
   * while nothing sensitive crosses the wire. A `BillingError` raised deeper in this class — the
   * checkout-without-URL case — passes through unchanged rather than being re-wrapped.
   */
  private translate(
    operation: string,
    error: unknown,
    durationMs?: number,
  ): unknown {
    if (error instanceof BillingError) {
      return error;
    }

    const stripeError = error instanceof Stripe.errors.StripeError ? error : null;
    this.logger.error({
      event: "billing.stripe.call.failed",
      operation,
      ...(durationMs === undefined ? {} : { durationMs }),
      stripeErrorType: stripeError?.type ?? null,
      stripeErrorCode: stripeError?.code ?? null,
      stripeStatusCode: stripeError?.statusCode ?? null,
      err: error,
    });

    if (stripeError?.type === "StripeCardError") {
      return new BillingError(
        "Your payment method was declined. Update it and try again.",
        { code: "BILLING_PAYMENT_REQUIRED" },
      );
    }

    return new BillingError(
      "Billing is temporarily unavailable. Please try again.",
      { code: "BILLING_STRIPE_UNAVAILABLE" },
    );
  }
}

// ---------------------------------------------------------------------------
// Translation helpers
// ---------------------------------------------------------------------------

function isResourceMissing(error: unknown): boolean {
  return (
    error instanceof Stripe.errors.StripeError &&
    error.code === "resource_missing"
  );
}

function secondsToDate(value: number | null | undefined): Date | null {
  return typeof value === "number" ? new Date(value * 1000) : null;
}

/**
 * A Stripe subscription, reduced.
 *
 * The period comes from the **item**, not the subscription: API version `2026-08-26.dahlia` moved
 * `current_period_start` / `current_period_end` onto subscription items. V1 subscriptions carry
 * exactly one item — quantity 1, one licensed price — so the first item is the subscription's
 * period, and `itemId` is what an update targets.
 */
export function toSubscriptionState(
  subscription: Stripe.Subscription,
): StripeSubscriptionState {
  const item = subscription.items.data[0] ?? null;
  const price = item?.price ?? null;

  return {
    id: subscription.id,
    customerId:
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id,
    status: subscription.status,
    currentPriceId: price?.id ?? null,
    itemId: item?.id ?? null,
    currentPeriodStart: secondsToDate(item?.current_period_start),
    currentPeriodEnd: secondsToDate(item?.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    cancelAt: secondsToDate(subscription.cancel_at),
    canceledAt: secondsToDate(subscription.canceled_at),
    created: new Date(subscription.created * 1000),
    scheduleId:
      typeof subscription.schedule === "string"
        ? subscription.schedule
        : (subscription.schedule?.id ?? null),
    hasPendingUpdate: subscription.pending_update !== null,
  };
}

/**
 * The first scheduled phase that starts in the future, if any.
 *
 * Requires `schedule` to have been expanded. Phases already begun are not pending changes — the
 * newest one that has started *is* the current state — so only a phase whose `start_date` is still
 * ahead is mirrored as pending.
 */
export function nextScheduledPhase(
  subscription: Stripe.Subscription,
  now: Date = new Date(),
): StripeScheduledPhase | null {
  const schedule =
    typeof subscription.schedule === "string" ? null : subscription.schedule;
  if (!schedule) {
    return null;
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  for (const phase of schedule.phases) {
    if (phase.start_date <= nowSeconds) {
      continue;
    }
    const item = phase.items[0];
    if (!item) {
      continue;
    }
    const priceId = typeof item.price === "string" ? item.price : item.price?.id;
    if (!priceId) {
      continue;
    }
    return { priceId, startsAt: new Date(phase.start_date * 1000) };
  }

  return null;
}

/** The minimum of a schedule phase this module reasons about. */
export type SchedulePhaseWindow = {
  readonly start_date: number;
  readonly end_date?: number | null;
};

/**
 * The phase a schedule is **currently in** — not its last phase.
 *
 * This distinction is load-bearing and was a real bug. A schedule created fresh from a subscription
 * has exactly one phase, so "the last phase" and "the current phase" are the same object and the
 * wrong one works. The moment a change is already scheduled, the schedule has two phases and the
 * last one is the *future* one: pinning that as the current phase produces `start_date == end_date`,
 * which Stripe rejects with "Each phase must be at minimum 1 second long". A user who schedules a
 * cadence change and then changes their mind hits it every time.
 *
 * So the current phase is the one containing `now`. Selecting it also gives the replacement the right
 * semantics: everything after it is dropped, so re-scheduling *replaces* the pending change rather
 * than stacking another phase behind it.
 */
export function selectCurrentPhase<T extends SchedulePhaseWindow>(
  phases: readonly T[],
  now: Date = new Date(),
): T | undefined {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  return (
    phases.find(
      (phase) =>
        phase.start_date <= nowSeconds &&
        (phase.end_date === null ||
          phase.end_date === undefined ||
          phase.end_date > nowSeconds),
    ) ??
    // No phase contains `now`: a schedule not yet started, or one whose phases all ended. The
    // earliest phase is the only defensible choice, and Stripe will reject a nonsensical window
    // rather than silently mis-billing.
    phases[0]
  );
}

/**
 * Which Stripe customer, subscription and FactorSage user an event concerns.
 *
 * Only the event types FactorSage processes are unpacked. Anything else yields nulls and is
 * recorded as ignored rather than guessed at — and `metadataUserId` is read only from a Checkout
 * Session, whose metadata this server wrote.
 */
function identifyEventSubject(event: Stripe.Event): {
  customerId: string | null;
  subscriptionId: string | null;
  metadataUserId: string | null;
} {
  const object = event.data.object as unknown as Record<string, unknown>;

  const customerId = readId(object.customer);
  const metadata = object.metadata as Record<string, unknown> | null | undefined;
  const metadataUserId =
    event.type === "checkout.session.completed" &&
    typeof metadata?.factorsageUserId === "string"
      ? metadata.factorsageUserId
      : ((event.type === "checkout.session.completed" &&
          typeof object.client_reference_id === "string" &&
          object.client_reference_id) ||
        null);

  // A subscription event's own id is the subscription; an invoice, checkout session or schedule
  // points at one.
  const subscriptionId = event.type.startsWith("customer.subscription.")
    ? readId(object.id)
    : readId(object.subscription);

  return { customerId, subscriptionId, metadataUserId };
}

function readId(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}
