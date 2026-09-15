import { RATE_LIMIT_HEADERS } from "@intrinsic/contracts";
import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Observable } from "rxjs";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../auth/authenticated-request";
import {
  UNDECLARED_ROUTE_POLICY,
  type RateLimitPolicyName,
} from "./rate-limit-policies";
import {
  RATE_LIMIT_EXEMPT_KEY,
  RATE_LIMIT_POLICY_KEY,
} from "./rate-limit.decorator";
import { RateLimitService, type RateLimitDecision } from "./rate-limit.service";

/**
 * The one enforcement point for API rate limiting.
 *
 * Registered globally by `RateLimitModule`, so an endpoint cannot escape it by forgetting a
 * `@UseGuards`, and reading route metadata through `Reflector` exactly as `RolesGuard` reads
 * `@Roles`.
 *
 * ## Why an interceptor rather than a guard
 *
 * The obvious shape for this in Nest is a guard, and it is the wrong one *here*, for a concrete
 * ordering reason. Nest runs enhancers global → controller → method, so a globally registered
 * guard runs **before** the controller's `@UseGuards(CookieAuthGuard)` and would see no
 * `request.authUser` — every authenticated route would silently fall back to IP keying, which is
 * precisely the failure mode where one office shares one allowance. Global interceptors run after
 * every guard, so the session is resolved by the time this runs; `rate-limit.ordering.test.ts`
 * pins that ordering rather than trusting it.
 *
 * The two alternatives were rejected on their merits: applying the guard per controller after
 * `CookieAuthGuard` makes protection something an author can forget, and having the limiter parse
 * the session cookie itself would give the API a second authentication path to keep correct.
 *
 * Running after the guards also puts the limiter after authentication and before the handler,
 * which is the order `docs/decisions/entitlements-v1.md` section 10 describes — and comfortably
 * before the entitlement checks inside the writing transaction, which are the expensive ones.
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (context.getType() !== "http") {
      return next.handle();
    }

    const exemption = this.reflector.getAllAndOverride<string>(
      RATE_LIMIT_EXEMPT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (exemption) {
      return next.handle();
    }

    const policy =
      this.reflector.getAllAndOverride<RateLimitPolicyName>(
        RATE_LIMIT_POLICY_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? UNDECLARED_ROUTE_POLICY;

    const http = context.switchToHttp();
    // Throws `RateLimitError` for a refusal; `RateLimitExceptionFilter` turns it into HTTP. The
    // handler is never reached, so nothing downstream has to know a limit exists.
    const decision = await this.limiter.consume(
      policy,
      http.getRequest<AuthenticatedRequest>(),
    );
    if (decision) {
      applyRateLimitHeaders(http.getResponse<Response>(), decision);
    }
    return next.handle();
  }
}

/**
 * Writes the `RateLimit-*` headers for a permitted request.
 *
 * Exported because the exception filter writes the same family on a refusal: the headers are set
 * in exactly two places that share this function, never per endpoint, so a client sees the same
 * shape whichever way a request ends.
 */
export function applyRateLimitHeaders(
  response: Response,
  decision: RateLimitDecision,
): void {
  response.setHeader(RATE_LIMIT_HEADERS.policy, decision.policy);
  response.setHeader(RATE_LIMIT_HEADERS.limit, String(decision.limit));
  response.setHeader(RATE_LIMIT_HEADERS.remaining, String(decision.remaining));
  response.setHeader(RATE_LIMIT_HEADERS.reset, String(decision.resetSeconds));
}
