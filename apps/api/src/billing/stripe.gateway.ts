import type { StripeBillingConfig } from "@intrinsic/config";
import { BillingError } from "@intrinsic/contracts";
import type { StructuredLogger } from "@intrinsic/observability";
import Stripe from "stripe";
import {
  StripeFixtureError,
  assertStripeTestModeKey,
  redactStripeCredentials,
  type StripeFixtureClock,
  type StripeFixtureCustomer,
  type StripeFixtureGateway,
  type StripeFixturePaymentBehavior,
  type StripeFixtureSubscription,
} from "./stripe-fixture-gateway";
import { hasScheduledCancellation } from "./stripe-gateway";
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
    cancelAtPeriodEnd: hasScheduledCancellation({
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      cancelAt: secondsToDate(subscription.cancel_at),
    }),
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

// ---------------------------------------------------------------------------
// Test-mode fixtures
// ---------------------------------------------------------------------------

/**
 * Stripe's own named test payment methods, by the behaviour a fixture needs from one.
 *
 * Tokens, not cards: `pm_card_visa` attaches and pays; `pm_card_chargeCustomerFail` attaches and
 * then fails every charge, which is how a renewal reaches `past_due` without anything being
 * fabricated. No card number, expiry or CVC exists in this repository.
 */
const FIXTURE_PAYMENT_METHOD_TOKENS: Readonly<
  Record<StripeFixturePaymentBehavior, string>
> = {
  SUCCEEDS: "pm_card_visa",
  FAILS_ON_CHARGE: "pm_card_chargeCustomerFail",
};

/**
 * The Stripe half of the billing QA persona tooling. **Test mode only.**
 *
 * It lives in this file because this is the one place the Stripe SDK is imported, and it is a
 * separate class — with its own SDK client — because nothing the running product does may be able
 * to reach it: `StripeApiGateway` cannot create a subscription outside Checkout, and this cannot be
 * constructed with a live key. `stripe-fixture-gateway.ts` states what the interface deliberately
 * leaves out; the short version is that the only thing it can delete is a Test Clock, and it has no
 * product or price operation at all.
 *
 * Two guards hold regardless of the caller:
 *
 * 1. the constructor refuses any key that is not `sk_test_`/`rk_test_`;
 * 2. every object Stripe returns is checked for `livemode: false` before it is handed back, so even
 *    a key this code misjudged could not have its objects acted on.
 *
 * Failures are raised as `StripeFixtureError` carrying Stripe's own message, because the reader is
 * an operator running a test-mode command and "billing is temporarily unavailable" would tell them
 * nothing. Anything shaped like a credential is redacted from that message first.
 */
export class StripeTestModeFixtureGateway implements StripeFixtureGateway {
  private readonly stripe: Stripe;

  /** The four configured catalog prices. A subscription on anything else is refused. */
  private readonly catalogPriceIds: ReadonlySet<string>;

  constructor(
    config: StripeBillingConfig,
    private readonly logger: StructuredLogger,
  ) {
    assertStripeTestModeKey(config);
    this.catalogPriceIds = new Set(Object.values(config.priceIds));
    this.stripe = new Stripe(config.secretKey, {
      timeout: config.timeoutMs,
      maxNetworkRetries: config.maxNetworkRetries,
      appInfo: { name: "FactorSage QA fixtures", version: "1.0.0" },
    });
  }

  async listTestClocks(): Promise<readonly StripeFixtureClock[]> {
    return this.call("testClocks.list", async () => {
      const clocks: StripeFixtureClock[] = [];
      for await (const clock of this.stripe.testHelpers.testClocks.list({
        limit: 100,
      })) {
        clocks.push(this.toClock("testClocks.list", clock));
      }
      return clocks;
    });
  }

  async retrieveTestClock(clockId: string): Promise<StripeFixtureClock | null> {
    return this.call("testClocks.retrieve", async () => {
      try {
        return this.toClock(
          "testClocks.retrieve",
          await this.stripe.testHelpers.testClocks.retrieve(clockId),
        );
      } catch (error: unknown) {
        if (isResourceMissing(error)) {
          return null;
        }
        throw error;
      }
    });
  }

  async createTestClock(input: {
    readonly name: string;
    readonly frozenTime: Date;
    readonly idempotencyKey: string;
  }): Promise<StripeFixtureClock> {
    return this.call("testClocks.create", async () =>
      this.toClock(
        "testClocks.create",
        await this.stripe.testHelpers.testClocks.create(
          { name: input.name, frozen_time: toSeconds(input.frozenTime) },
          { idempotencyKey: input.idempotencyKey },
        ),
      ),
    );
  }

  async advanceTestClock(input: {
    readonly clockId: string;
    readonly frozenTime: Date;
    readonly idempotencyKey: string;
  }): Promise<StripeFixtureClock> {
    return this.call("testClocks.advance", async () =>
      this.toClock(
        "testClocks.advance",
        await this.stripe.testHelpers.testClocks.advance(
          input.clockId,
          { frozen_time: toSeconds(input.frozenTime) },
          { idempotencyKey: input.idempotencyKey },
        ),
      ),
    );
  }

  async deleteTestClock(clockId: string): Promise<void> {
    await this.call("testClocks.del", async () => {
      try {
        await this.stripe.testHelpers.testClocks.del(clockId);
      } catch (error: unknown) {
        if (!isResourceMissing(error)) {
          throw error;
        }
      }
    });
  }

  async listTestClockCustomers(
    clockId: string,
  ): Promise<readonly StripeFixtureCustomer[]> {
    return this.call("customers.list", async () => {
      const customers: StripeFixtureCustomer[] = [];
      for await (const customer of this.stripe.customers.list({
        test_clock: clockId,
        limit: 100,
      })) {
        customers.push(this.toCustomer("customers.list", customer));
      }
      return customers;
    });
  }

  async retrieveCustomer(
    customerId: string,
  ): Promise<StripeFixtureCustomer | null> {
    return this.call("customers.retrieve", async () => {
      try {
        const customer = await this.stripe.customers.retrieve(customerId);
        if (customer.deleted) {
          return null;
        }
        return this.toCustomer("customers.retrieve", customer);
      } catch (error: unknown) {
        if (isResourceMissing(error)) {
          return null;
        }
        throw error;
      }
    });
  }

  async createTestClockCustomer(input: {
    readonly clockId: string;
    readonly email: string;
    readonly name: string;
    readonly metadata: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
  }): Promise<StripeFixtureCustomer> {
    return this.call("customers.create", async () =>
      this.toCustomer(
        "customers.create",
        await this.stripe.customers.create(
          {
            test_clock: input.clockId,
            email: input.email,
            name: input.name,
            metadata: { ...input.metadata },
          },
          { idempotencyKey: input.idempotencyKey },
        ),
      ),
    );
  }

  async attachTestPaymentMethod(input: {
    readonly customerId: string;
    readonly behavior: StripeFixturePaymentBehavior;
    readonly metadata: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
  }): Promise<{ readonly id: string }> {
    return this.call("paymentMethods.attach", async () => {
      const paymentMethod = await this.stripe.paymentMethods.attach(
        FIXTURE_PAYMENT_METHOD_TOKENS[input.behavior],
        { customer: input.customerId },
        { idempotencyKey: input.idempotencyKey },
      );
      this.assertTestMode("paymentMethods.attach", paymentMethod);
      // Attaching takes no metadata, so the tags are a second call. Setting them is declarative —
      // running it twice changes nothing — which is why it carries no idempotency key.
      await this.stripe.paymentMethods.update(paymentMethod.id, {
        metadata: { ...input.metadata },
      });
      return { id: paymentMethod.id };
    });
  }

  async listSubscriptions(
    customerId: string,
  ): Promise<readonly StripeFixtureSubscription[]> {
    return this.call("subscriptions.list", async () => {
      const subscriptions: StripeFixtureSubscription[] = [];
      for await (const subscription of this.stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 100,
      })) {
        subscriptions.push(
          this.toSubscription("subscriptions.list", subscription),
        );
      }
      return subscriptions;
    });
  }

  async createSubscription(input: {
    readonly customerId: string;
    readonly priceId: string;
    readonly paymentMethodId: string;
    readonly metadata: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
  }): Promise<StripeFixtureSubscription> {
    if (!this.catalogPriceIds.has(input.priceId)) {
      throw new StripeFixtureError(
        "Refusing to create a fixture subscription on a price that is not one of the four " +
          "configured FactorSage catalog prices.",
      );
    }
    return this.call("subscriptions.create", async () =>
      this.toSubscription(
        "subscriptions.create",
        await this.stripe.subscriptions.create(
          {
            customer: input.customerId,
            items: [{ price: input.priceId, quantity: 1 }],
            default_payment_method: input.paymentMethodId,
            // A fixture is either a paid subscription or nothing: without this a declined first
            // payment would leave an `incomplete` subscription holding the customer's paid slot.
            payment_behavior: "error_if_incomplete",
            metadata: { ...input.metadata },
          },
          { idempotencyKey: input.idempotencyKey },
        ),
      ),
    );
  }

  async setSubscriptionPaymentMethod(input: {
    readonly subscriptionId: string;
    readonly paymentMethodId: string;
  }): Promise<StripeFixtureSubscription> {
    return this.call("subscriptions.update", async () =>
      this.toSubscription(
        "subscriptions.update",
        await this.stripe.subscriptions.update(input.subscriptionId, {
          default_payment_method: input.paymentMethodId,
        }),
      ),
    );
  }

  /**
   * `cancel_at: "min_period_end"` is the request Customer Portal makes on the pinned API version,
   * and it is why the result comes back in Stripe's newer representation: `cancel_at` set, with
   * `cancel_at_period_end` **false**. Sending the older `cancel_at_period_end: true` instead would
   * build a fixture in a shape no FactorSage customer can produce.
   */
  async scheduleCancellationAtPeriodEnd(
    subscriptionId: string,
  ): Promise<StripeFixtureSubscription> {
    return this.call("subscriptions.update", async () =>
      this.toSubscription(
        "subscriptions.update",
        await this.stripe.subscriptions.update(subscriptionId, {
          cancel_at: "min_period_end",
        }),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async call<T>(operation: string, run: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await run();
      this.logger.debug({
        event: "billing.stripe.fixture.call.completed",
        operation,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error: unknown) {
      if (error instanceof StripeFixtureError) {
        throw error;
      }
      const stripeError =
        error instanceof Stripe.errors.StripeError ? error : null;
      this.logger.debug({
        event: "billing.stripe.fixture.call.failed",
        operation,
        durationMs: Date.now() - startedAt,
        stripeErrorType: stripeError?.type ?? null,
        stripeErrorCode: stripeError?.code ?? null,
        stripeStatusCode: stripeError?.statusCode ?? null,
      });
      const detail =
        error instanceof Error ? error.message : "an unknown error occurred";
      throw new StripeFixtureError(
        `Stripe ${operation} failed` +
          (stripeError?.code ? ` (${stripeError.code})` : "") +
          `: ${redactStripeCredentials(detail)}`,
      );
    }
  }

  private assertTestMode(operation: string, object: { livemode: boolean }): void {
    if (object.livemode !== false) {
      throw new StripeFixtureError(
        `Stripe ${operation} returned a live-mode object. Billing QA fixtures are test-mode only; ` +
          "nothing was done with it.",
      );
    }
  }

  private toClock(
    operation: string,
    clock: Stripe.TestHelpers.TestClock,
  ): StripeFixtureClock {
    this.assertTestMode(operation, clock);
    return {
      id: clock.id,
      name: clock.name,
      status: clock.status,
      frozenTime: new Date(clock.frozen_time * 1000),
      deletesAfter: secondsToDate(clock.deletes_after),
      livemode: clock.livemode,
    };
  }

  private toCustomer(
    operation: string,
    customer: Stripe.Customer,
  ): StripeFixtureCustomer {
    this.assertTestMode(operation, customer);
    const clock = customer.test_clock ?? null;
    return {
      id: customer.id,
      email: customer.email,
      metadata: { ...customer.metadata },
      testClockId: typeof clock === "string" ? clock : (clock?.id ?? null),
      livemode: customer.livemode,
    };
  }

  private toSubscription(
    operation: string,
    subscription: Stripe.Subscription,
  ): StripeFixtureSubscription {
    this.assertTestMode(operation, subscription);
    // The period is read from the item, exactly as `toSubscriptionState` reads it.
    const item = subscription.items.data[0] ?? null;
    return {
      id: subscription.id,
      customerId:
        typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer.id,
      status: subscription.status,
      priceId: item?.price?.id ?? null,
      metadata: { ...subscription.metadata },
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      cancelAt: secondsToDate(subscription.cancel_at),
      canceledAt: secondsToDate(subscription.canceled_at),
      currentPeriodStart: secondsToDate(item?.current_period_start),
      currentPeriodEnd: secondsToDate(item?.current_period_end),
      livemode: subscription.livemode,
    };
  }
}

function toSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}
