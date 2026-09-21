import type {
  AuthUser,
  LegalAcceptanceStatusResponse,
  LegalRequestListResponse,
  LegalRequestReceipt,
} from "@intrinsic/contracts";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UseGuards,
} from "@nestjs/common";
import { CookieAuthGuard } from "../auth/cookie-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import { assertRequiredTermsVersion } from "./legal-acceptance-records";
import { LegalAcceptanceExempt } from "./legal-acceptance.decorator";
import {
  parseLegalAcceptanceRequest,
  parseLegalRequestSubmission,
} from "./legal-requests";
import { LegalService } from "./legal.service";

/**
 * The account-facing half of the legal surface: acceptance, and the request channels.
 *
 * **Every route here is exempt from the acceptance gate**, and that is the point rather than an
 * oversight. Accepting is impossible if reading your acceptance state is refused for not having
 * accepted, and the specification is explicit that a user who declines must still be able to
 * submit a statutory withdrawal, a privacy request and a support message. A compliance gate that
 * traps a paying customer is worse than no gate.
 *
 * The documents themselves are not served from here. They are static content compiled into the
 * web application from `@intrinsic/contracts`, so a legal page has no API dependency at all and
 * stays readable for a Guest, for an expired session and for a user who has declined.
 */
@Controller("legal")
@LegalAcceptanceExempt(
  "Accepting the Terms, and exercising the rights a declining user keeps — withdrawal, privacy " +
    "requests, nonconformity reports and support — must not themselves require acceptance.",
)
export class LegalController {
  constructor(@Inject(LegalService) private readonly legal: LegalService) {}

  /** What this account has accepted, and whether the required Terms version is outstanding. */
  @RateLimit("session-probe")
  @Get("acceptance")
  @UseGuards(CookieAuthGuard)
  acceptanceStatus(
    @CurrentUser() user: AuthUser,
  ): Promise<LegalAcceptanceStatusResponse> {
    return this.legal.acceptanceStatus(user.id);
  }

  /**
   * Records acceptance of the current Terms version for the **authenticated** account.
   *
   * Identity-bound by construction: there is no email in the body and no token in the URL, so
   * nothing here can record acceptance on behalf of somebody whose address was merely typed into
   * a registration form. The surface is resolved server-side from persisted state.
   *
   * Idempotent: repeated or concurrent calls for one version produce one row.
   */
  @RateLimit("mutation")
  @Post("acceptance")
  @HttpCode(HttpStatus.OK)
  @UseGuards(CookieAuthGuard)
  async accept(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<LegalAcceptanceStatusResponse> {
    const request = parseLegalAcceptanceRequest(body);
    assertRequiredTermsVersion(request.termsVersion);
    const surface = await this.legal.resolveSurface(user.id);
    await this.legal.recordAcceptance({ userId: user.id, surface });
    return this.legal.acceptanceStatus(user.id);
  }

  /**
   * Submits a privacy, withdrawal, nonconformity or support request and returns its receipt.
   *
   * The response **is** the durable receipt: a reference, the server's submission time and the
   * text submitted, which the browser renders and offers to save. No email is sent, because
   * there is no approved monitored mailbox to send from or to (`O2`), and promising a delivery
   * that does not happen would be worse than saying so plainly.
   *
   * Submitting is not deciding. Nothing here calculates a refund, waives a right, erases data or
   * touches a subscription.
   */
  @RateLimit("mutation")
  @Post("requests")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CookieAuthGuard)
  submitRequest(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<LegalRequestReceipt> {
    return this.legal.submitRequest(user.id, parseLegalRequestSubmission(body));
  }

  /** This account's own requests, newest first, so a receipt can be found again. */
  @RateLimit("standard-read")
  @Get("requests")
  @UseGuards(CookieAuthGuard)
  async listRequests(
    @CurrentUser() user: AuthUser,
  ): Promise<LegalRequestListResponse> {
    return { requests: await this.legal.listRequests(user.id) };
  }
}
