import { BillingError, type BillingReasonCode } from "@intrinsic/contracts";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Inject,
} from "@nestjs/common";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../auth/authenticated-request";
import { BILLING_LOGGER } from "./billing.tokens";

/**
 * The one place a billing refusal becomes HTTP.
 *
 * Registered globally by `BillingModule`, exactly like `EntitlementExceptionFilter` — so a
 * `BillingError` thrown from a controller, a service or the Stripe adapter answers identically, and
 * a new billing operation cannot forget to map it.
 *
 * The body carries the stable `code` and nothing else about Stripe. No Stripe error object, no
 * request id, no customer or subscription id, no payload: the original failure was already logged
 * server-side before translation, so support can recover the detail without any of it crossing the
 * wire (decision document sections 20 and 21).
 */
@Catch(BillingError)
export class BillingExceptionFilter implements ExceptionFilter {
  constructor(
    @Inject(BILLING_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  catch(error: BillingError, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();
    const status = statusFor(error.detail.code);

    this.logger.warn({
      event: "billing.request.refused",
      actorUserId: request.authUser?.id ?? null,
      code: error.detail.code,
      priceKey: error.detail.priceKey ?? null,
      plan: error.detail.plan ?? null,
      operation: `${request.method} ${request.route?.path ?? request.path}`,
      statusCode: status,
    });

    response.status(status).json({
      statusCode: status,
      message: error.message,
      ...error.detail,
    });
  }
}

/**
 * Which HTTP status each billing reason answers with.
 *
 * Every code is listed. A billing failure is not an entitlement failure and mostly is not a
 * malformed request either, so the mapping is explicit rather than defaulted:
 *
 * - `401` only for a missing session, where signing in really is the remedy.
 * - `400` where the caller sent something the server will never accept.
 * - `402 Payment Required` where money is the blocker — the one status that tells a UI to send the
 *   user to their payment method rather than to an upgrade page.
 * - `409 Conflict` for a state clash: already subscribed, nothing to change, an invariant violation.
 * - `503` where Stripe or this deployment's configuration is the problem, not the caller. A
 *   misconfigured catalog is deliberately *not* a `500`: the request was fine and a retry after the
 *   operator fixes configuration will work.
 */
function statusFor(code: BillingReasonCode): number {
  switch (code) {
    case "BILLING_AUTH_REQUIRED":
      return HttpStatus.UNAUTHORIZED;

    case "BILLING_INVALID_PRICE_KEY":
      return HttpStatus.BAD_REQUEST;

    case "BILLING_WEBHOOK_INVALID_SIGNATURE":
      return HttpStatus.BAD_REQUEST;

    case "BILLING_PAYMENT_REQUIRED":
      return HttpStatus.PAYMENT_REQUIRED;

    case "BILLING_ALREADY_SUBSCRIBED":
    case "BILLING_NO_SUBSCRIPTION":
    case "BILLING_CHANGE_NOT_ALLOWED":
    case "BILLING_CUSTOMER_CONFLICT":
    case "BILLING_SUBSCRIPTION_CONFLICT":
    case "BILLING_WEBHOOK_UNSUPPORTED_STATE":
      return HttpStatus.CONFLICT;

    case "BILLING_NOT_CONFIGURED":
    case "BILLING_CATALOG_MISCONFIGURED":
    case "BILLING_STRIPE_UNAVAILABLE":
    case "BILLING_PORTAL_UNAVAILABLE":
    case "BILLING_CHECKOUT_FAILED":
    case "BILLING_SUBSCRIPTION_UPDATE_FAILED":
      return HttpStatus.SERVICE_UNAVAILABLE;
  }
}
