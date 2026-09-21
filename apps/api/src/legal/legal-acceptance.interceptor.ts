import { LegalError, REQUIRED_TERMS_VERSION } from "@intrinsic/contracts";
import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Observable } from "rxjs";
import type { AuthenticatedRequest } from "../auth/authenticated-request";
import { LEGAL_ACCEPTANCE_EXEMPT_KEY } from "./legal-acceptance.decorator";

export const LEGAL_ACCEPTANCE_REQUIRED_MESSAGE =
  "Accept the current Terms of Service to continue using this account.";

/**
 * The one server-side enforcement point for Terms acceptance.
 *
 * Registered globally by `LegalModule`, so a route cannot escape it by forgetting a `@UseGuards`,
 * and read through `Reflector` exactly as `@RateLimit` and `@Roles` are. A direct API request
 * from a client that never rendered the acceptance screen is refused here, which is what makes
 * the gate a server guarantee rather than a React redirect somebody can skip with `curl`.
 *
 * ## Why an interceptor rather than a guard
 *
 * The same ordering reason as `RateLimitInterceptor`: Nest runs enhancers global → controller →
 * method, so a globally registered **guard** runs before the controller's
 * `@UseGuards(CookieAuthGuard)` and would see no session at all — it would let every
 * authenticated request through. Global interceptors run after every guard, so by the time this
 * runs the session is resolved and `request.legalAcceptance` carries the answer.
 *
 * ## Why it costs no query
 *
 * `CookieAuthGuard` already reloads the user from PostgreSQL on every request. The acceptance
 * lookup rides on that same `SELECT` (`UsersService.findAuthUserById`), so enforcement adds a
 * join to an existing read rather than a second round trip, and — more importantly — the
 * acceptance state is read on the same row, in the same query, as the identity it is about.
 *
 * ## What it deliberately does not do
 *
 * It never applies to a Guest. An unauthenticated caller has no acceptance to be missing, and
 * refusing them here would break every public page. It also never applies to an exempt route:
 * see `LegalAcceptanceExempt` for the three classes, of which the load-bearing one is that a user
 * who declines must still be able to cancel, submit statutory requests, reach support and sign
 * out.
 */
@Injectable()
export class LegalAcceptanceInterceptor implements NestInterceptor {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") {
      return next.handle();
    }

    const exemption = this.reflector.getAllAndOverride<string>(
      LEGAL_ACCEPTANCE_EXEMPT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (exemption) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // No session, nothing to have accepted. Guest access is decided by the route's own guards.
    if (!request.authUser) {
      return next.handle();
    }

    if (request.legalAcceptance?.termsAccepted !== true) {
      throw new LegalError(LEGAL_ACCEPTANCE_REQUIRED_MESSAGE, {
        code: "LEGAL_ACCEPTANCE_REQUIRED",
        requiredTermsVersion: REQUIRED_TERMS_VERSION,
      });
    }

    return next.handle();
  }
}
