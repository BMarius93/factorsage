import { randomUUID } from "node:crypto";
import type {
  AuthUser,
  BillingChangeResponse,
  BillingCheckoutResponse,
  BillingPortalResponse,
  BillingStatusResponse,
} from "@intrinsic/contracts";
import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { getLogContext } from "@intrinsic/observability";
import { CookieAuthGuard } from "../auth/cookie-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedRequest } from "../auth/authenticated-request";
import { LegalAcceptanceExempt } from "../legal/legal-acceptance.decorator";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import { parseBillingTargetRequest } from "./billing-requests";
import { BillingReconciliationService } from "./billing-reconciliation.service";
import { BillingService } from "./billing.service";

/**
 * The user-facing billing surface.
 *
 * Every route is behind `CookieAuthGuard`, so a Guest is refused with `401` before any billing code
 * runs — guests have no billing identity at all (decision document section 4). Every operation is
 * bound to `user.id` from the verified session: there is no route parameter, body field or query
 * value naming a customer, subscription or price, which is what makes "one user cannot open
 * another's portal" a property of the shape rather than of a check somebody has to remember.
 *
 * Note what is absent: no route grants a plan, and no route accepts one. The Checkout success
 * redirect lands on the *web app*, not here, and the only thing the browser can do on return is ask
 * for status again.
 */
@Controller("billing")
@UseGuards(CookieAuthGuard)
export class BillingController {
  // Explicit tokens, matching every other controller here: the test runner transpiles with esbuild,
  // which does not emit `design:paramtypes`, so type-only injection resolves to undefined under test.
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(BillingReconciliationService)
    private readonly reconciliation: BillingReconciliationService,
  ) {}

  @RateLimit("standard-read")
  @LegalAcceptanceExempt(
    "A user who has not accepted the Terms must still see what they are paying for and when it " +
      "renews, so the cancellation path on the same page means something.",
  )
  @Get("status")
  async status(@CurrentUser() user: AuthUser): Promise<BillingStatusResponse> {
    return this.billing.readStatus(user);
  }

  /**
   * Refreshes billing state from Stripe, then returns it.
   *
   * This is what the page calls after returning from a hosted Stripe surface. It is a *read* of
   * authoritative Stripe state, not a grant: it runs the same reconciliation a webhook runs, so
   * whatever it produces is exactly what the webhook would have produced — which is why a user who
   * cancelled at the Stripe page, or whose card failed, gets the honest answer rather than the
   * optimistic one.
   *
   * Its value is latency, not authority: webhook delivery is usually faster than a browser redirect,
   * but when it is not, the user should not have to reload for a minute. A reconciliation failure is
   * therefore not fatal here — the persisted status is still returned and the webhook will converge.
   */
  @RateLimit("billing-refresh")
  @LegalAcceptanceExempt(
    "Re-reads authoritative Stripe state and grants nothing. It is what keeps the status above " +
      "honest after a hosted round trip, so it travels with it.",
  )
  @Post("refresh")
  async refresh(
    @CurrentUser() user: AuthUser,
  ): Promise<BillingStatusResponse> {
    if (this.reconciliation.configured) {
      try {
        await this.reconciliation.reconcileUser({
          userId: user.id,
          trigger: "RETURN",
        });
      } catch {
        // Already logged with full context by the reconciler. Falling through to the persisted
        // status is strictly better than failing the page: webhooks remain the authority.
      }
    }
    return this.billing.readStatus(user);
  }

  /**
   * Starts hosted Checkout. Accepts a logical catalog key and nothing else.
   *
   * Returns the URL rather than issuing a redirect, so the browser controls navigation and the
   * response stays a normal JSON error when the request is refused.
   */
  @RateLimit("billing-mutation")
  @Post("checkout")
  async checkout(
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<BillingCheckoutResponse> {
    const { priceKey } = parseBillingTargetRequest(body);
    return this.billing.createCheckoutSession({
      user,
      priceKey,
      requestId: requestIdentity(request),
    });
  }

  @RateLimit("billing-mutation")
  @LegalAcceptanceExempt(
    "The cancellation path. A compliance gate that stops a paying customer ending their " +
      "subscription is worse than no gate, and the specification requires cancellation to stay " +
      "reachable for a user who declines. Checkout and plan changes are deliberately not exempt: " +
      "buying more while refusing the Terms is exactly what the gate is for.",
  )
  @Post("portal")
  async portal(
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<BillingPortalResponse> {
    return this.billing.createPortalSession({
      user,
      requestId: requestIdentity(request),
    });
  }

  /**
   * Changes an existing subscription's price under FactorSage's transition matrix.
   *
   * Exists because Customer Portal configuration cannot express immediate-for-upgrades *and*
   * period-end-for-downgrades at once; `BillingService.changePlan` documents that in full.
   */
  @RateLimit("billing-mutation")
  @Post("change")
  async change(
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<BillingChangeResponse> {
    const { priceKey } = parseBillingTargetRequest(body);
    return this.billing.changePlan({
      user,
      priceKey,
      requestId: requestIdentity(request),
    });
  }
}

/**
 * A stable identity for this one user action, used in Stripe idempotency keys.
 *
 * The request id the observability middleware already assigned, so an internal retry of the same
 * request reuses it while a genuinely new user action gets a new one. The `randomUUID` fallback
 * exists only for a context where that middleware is not installed — a narrow integration test —
 * and is never the normal path.
 */
function requestIdentity(request: AuthenticatedRequest): string {
  const header = request.headers["x-request-id"];
  if (typeof header === "string" && header.length > 0 && header.length <= 128) {
    return header;
  }
  return getLogContext().requestId ?? randomUUID();
}
