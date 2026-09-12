import { BillingError } from "@intrinsic/contracts";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import {
  BillingReconciliationService,
  type WebhookEventRecord,
} from "./billing-reconciliation.service";
import { BILLING_LOGGER, STRIPE_GATEWAY } from "./billing.tokens";
import type { StripeGateway, StripeWebhookEnvelope } from "./stripe-gateway";

/**
 * `POST /webhooks/stripe` — the authoritative billing synchronization path.
 *
 * No session, no cookie, no CSRF token: the caller is Stripe, and the only thing that authenticates
 * it is a signature over the raw body computed with this endpoint's signing secret. Unsigned JSON is
 * never accepted, and a body that has been parsed and re-serialized cannot verify — which is why
 * `main.ts` enables Nest's `rawBody` and this handler reads `request.rawBody` rather than
 * `request.body`.
 *
 * ## The event set, and why it is this one
 *
 * Every handled event does the same thing: resolve which FactorSage user it concerns, then run the
 * one reconciliation. None of them carries a plan decision of its own, so the list is about *when to
 * look*, not about *what to do* — which is what keeps it short instead of a switch over Stripe's
 * whole catalogue (decision document section 12).
 *
 * | Event | Why FactorSage needs it |
 * | --- | --- |
 * | `checkout.session.completed` | Binds a new subscription to the user; the earliest moment a purchase is knowable. |
 * | `customer.subscription.created` | A subscription exists, including one created in the Dashboard. |
 * | `customer.subscription.updated` | Price, status, cancel-at-period-end, and the phase transition that applies a scheduled downgrade. |
 * | `customer.subscription.deleted` | The subscription actually ended. This is what makes a user FREE. |
 * | `customer.subscription.pending_update_applied` | A held upgrade was paid and the new price is now current. |
 * | `customer.subscription.pending_update_expired` | A held upgrade was never paid and Stripe discarded it. |
 * | `invoice.paid` | Recovers `past_due` to `active`, and confirms an upgrade proration. |
 * | `invoice.payment_failed` | Enters the recovery window, or fails an upgrade. |
 * | `subscription_schedule.updated` / `.released` / `.aborted` | Keeps the mirrored *pending* change honest when a schedule is edited, released or abandoned. |
 *
 * Anything else is acknowledged and recorded as ignored. Returning `2xx` for it is deliberate:
 * Stripe retries non-2xx for days, and retrying an event this deployment will never act on is noise
 * that hides the failures that matter.
 *
 * ## Response codes are a control channel
 *
 * `200` means "durably handled, do not send again". `500` means "try again" and is returned for a
 * transient failure, because Stripe's retry is the recovery mechanism and swallowing the error
 * would silently drop a billing change. An invalid signature is `400`, which Stripe does not retry.
 */

const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.pending_update_applied",
  "customer.subscription.pending_update_expired",
  "invoice.paid",
  "invoice.payment_failed",
  "subscription_schedule.updated",
  "subscription_schedule.released",
  "subscription_schedule.aborted",
]);

type RawBodyRequest = Request & { rawBody?: Buffer };

@Controller("webhooks")
export class StripeWebhookController {
  constructor(
    @Inject(BILLING_LOGGER) private readonly logger: StructuredLogger,
    @Inject(BillingReconciliationService)
    private readonly reconciliation: BillingReconciliationService,
    @Inject(STRIPE_GATEWAY) private readonly stripe: StripeGateway | null,
  ) {}

  @Post("stripe")
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() request: RawBodyRequest,
    @Headers("stripe-signature") signature: string | undefined,
  ): Promise<{ received: true; outcome: string }> {
    if (!this.stripe) {
      // Not configured. `503` rather than `404`: the route exists, the deployment simply has no
      // billing, and telling Stripe to retry is harmless and honest.
      this.logger.warn({ event: "billing.webhook.not-configured" });
      throw new BillingError("Billing is not configured", {
        code: "BILLING_NOT_CONFIGURED",
      });
    }

    const rawBody = request.rawBody;
    if (!rawBody || !signature) {
      this.logger.warn({
        event: "billing.webhook.malformed",
        hasRawBody: Boolean(rawBody),
        hasSignature: Boolean(signature),
      });
      throw new BillingError("Invalid webhook request", {
        code: "BILLING_WEBHOOK_INVALID_SIGNATURE",
      });
    }

    // Throws `BILLING_WEBHOOK_INVALID_SIGNATURE` -> 400. Nothing below runs for an unsigned or
    // wrongly signed payload, including any database write.
    const event = this.stripe.constructWebhookEvent(rawBody, signature);

    const record: WebhookEventRecord = {
      stripeEventId: event.id,
      type: event.type,
      stripeCreatedAt: event.created,
    };

    this.logger.info({
      event: "billing.webhook.received",
      stripeEventId: event.id,
      type: event.type,
      livemode: event.livemode,
    });

    // An event from the *other* Stripe mode. A different account's secret would already have failed
    // the signature check, but one account's own live and test events are signed by different
    // secrets for the same endpoint, and a misconfigured Dashboard endpoint can point live traffic
    // at a sandbox deployment. Applying it would mirror live billing into a test database.
    if (event.livemode === this.stripe.testMode) {
      this.logger.error({
        event: "billing.webhook.environment-mismatch",
        stripeEventId: event.id,
        type: event.type,
        eventLivemode: event.livemode,
        gatewayTestMode: this.stripe.testMode,
      });
      await this.reconciliation.recordIgnoredEvent({
        event: record,
        outcome: "IGNORED_ENVIRONMENT_MISMATCH",
      });
      return { received: true, outcome: "IGNORED_ENVIRONMENT_MISMATCH" };
    }

    if (!HANDLED_EVENT_TYPES.has(event.type)) {
      this.logger.debug({
        event: "billing.webhook.unhandled-type",
        stripeEventId: event.id,
        type: event.type,
      });
      await this.reconciliation.recordIgnoredEvent({
        event: record,
        outcome: "IGNORED_UNHANDLED_TYPE",
      });
      return { received: true, outcome: "IGNORED_UNHANDLED_TYPE" };
    }

    const userId = await this.resolveUser(event);
    if (!userId) {
      // A customer this deployment has never seen: created directly in the Dashboard, belonging to
      // another environment, or already deleted. Recorded and acknowledged — there is no local user
      // to reconcile, and no amount of retrying will produce one.
      this.logger.warn({
        event: "billing.webhook.unknown-subject",
        stripeEventId: event.id,
        type: event.type,
        hasCustomer: event.customerId !== null,
      });
      await this.reconciliation.recordIgnoredEvent({
        event: record,
        outcome: "IGNORED_UNKNOWN_CUSTOMER",
      });
      return { received: true, outcome: "IGNORED_UNKNOWN_CUSTOMER" };
    }

    // One path for every handled type. The event says *look now*; Stripe's current state says what
    // is true, and the reconciler decides the plan. Out-of-order and duplicate deliveries therefore
    // converge instead of replaying as an event log.
    const result = await this.reconciliation.reconcileUser({
      userId,
      trigger: "WEBHOOK",
      webhookEvent: record,
      ...(event.customerId ? { adoptStripeCustomerId: event.customerId } : {}),
    });

    this.logger.info({
      event: "billing.webhook.processed",
      stripeEventId: event.id,
      type: event.type,
      actorUserId: userId,
      outcome: result.outcome,
      previousPlan: result.previousPlan,
      plan: result.plan,
      planChanged: result.planChanged,
      planReason: result.planReason,
    });

    return { received: true, outcome: result.outcome };
  }

  /**
   * Which FactorSage user an event concerns.
   *
   * The Stripe Customer ID first, because `User.stripeCustomerId` is the authoritative link and it
   * is immutable. Checkout Session metadata is the fallback, and only for the one event type where
   * this server wrote it: it covers the narrow window in which a Checkout completes before the
   * customer id is readable from the payload. Email is never used — two Stripe customers can share
   * an address, and a user can change theirs (decision document section 4).
   */
  private async resolveUser(
    event: StripeWebhookEnvelope,
  ): Promise<string | null> {
    if (event.customerId) {
      const byCustomer = await this.reconciliation.findUserByStripeCustomerId(
        event.customerId,
      );
      if (byCustomer) {
        return byCustomer;
      }
    }

    if (event.metadataUserId) {
      // Metadata resolves an id we wrote; it is still checked against a real row, so a forged
      // value — which would require forging a Stripe signature first — names nothing.
      const exists = await this.reconciliation.userExists(event.metadataUserId);
      if (exists) {
        return event.metadataUserId;
      }
    }

    return null;
  }
}
