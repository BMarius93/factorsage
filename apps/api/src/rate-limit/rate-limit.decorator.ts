import { SetMetadata } from "@nestjs/common";
import type { DeclarableRateLimitPolicyName } from "./rate-limit-policies";

export const RATE_LIMIT_POLICY_KEY = "rate-limit:policy";
export const RATE_LIMIT_EXEMPT_KEY = "rate-limit:exempt";

/**
 * Declares which rate-limit policy protects a route.
 *
 * ```ts
 * @RateLimit("stock-search")
 * @Get("search")
 * async searchStocks(...) {}
 * ```
 *
 * Route metadata read by a globally-registered interceptor, mirroring `@Roles` / `RolesGuard`
 * exactly: the declaration sits on the endpoint where its author reads it, the mechanism sits in
 * one place, and no controller imports Redis, a limiter or a number.
 *
 * May also be applied to a controller, where it becomes that controller's default; a method-level
 * declaration overrides it. The argument is a union of catalog names, so a typo does not compile
 * and a renamed policy fails the build at every route that used it.
 */
export const RateLimit = (policy: DeclarableRateLimitPolicyName) =>
  SetMetadata(RATE_LIMIT_POLICY_KEY, policy);

/**
 * Declares that a route is deliberately **not** rate limited, and why.
 *
 * The reason is mandatory and is surfaced by `rate-limit-coverage.test.ts`, so an exemption is a
 * decision somebody wrote down rather than a decorator somebody forgot. There are only two classes
 * of legitimate exemption, and both are about a caller that is not a user:
 *
 * - orchestrator probes, where a throttled health check takes a healthy instance out of rotation;
 * - the Stripe webhook, whose caller is authenticated by a signature over the raw body and whose
 *   delivery volume is Stripe's retry schedule, not a person's behaviour. Refusing one costs a
 *   billing event and buys nothing (`ai/architecture/billing.md`).
 */
export const RateLimitExempt = (reason: string) =>
  SetMetadata(RATE_LIMIT_EXEMPT_KEY, reason);
