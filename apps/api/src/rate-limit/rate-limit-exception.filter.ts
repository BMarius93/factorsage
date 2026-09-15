import {
  RateLimitError,
  RATE_LIMITED_CODE,
  RATE_LIMIT_HEADERS,
  type RateLimitErrorResponse,
} from "@intrinsic/contracts";
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from "@nestjs/common";
import type { Response } from "express";
import { applyRateLimitHeaders } from "./rate-limit.interceptor";

/**
 * The one place a rate-limit refusal becomes HTTP.
 *
 * Registered globally by `RateLimitModule`, exactly like `EntitlementExceptionFilter` and
 * `BillingExceptionFilter`, so every refusal answers identically and the body is the same
 * machine-readable shape the rest of the API already uses: `statusCode`, a human `message`, a
 * stable `code`, and the numbers behind it.
 *
 * Two statuses, and the difference matters to a client:
 *
 * - `429` — the caller really did exceed an allowance. `Retry-After` is the measured time until
 *   that allowance refills, so a client can wait exactly as long as it must.
 * - `503` — the limiter could not answer and the endpoint's policy is fail-closed. The caller's
 *   allowance is untouched; presenting this as "slow down" would be wrong, which is why it carries
 *   its own code.
 *
 * Nothing is logged here: the service already logged the refusal with the policy, actor and
 * operation before throwing, and logging again would double every line.
 */
@Catch(RateLimitError)
export class RateLimitExceptionFilter implements ExceptionFilter {
  catch(error: RateLimitError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status =
      error.detail.code === RATE_LIMITED_CODE
        ? HttpStatus.TOO_MANY_REQUESTS
        : HttpStatus.SERVICE_UNAVAILABLE;

    response.setHeader(
      RATE_LIMIT_HEADERS.retryAfter,
      String(error.detail.retryAfterSeconds),
    );
    if (error.detail.limit !== undefined) {
      applyRateLimitHeaders(response, {
        policy: error.detail.policy as never,
        limit: error.detail.limit,
        remaining: error.detail.remaining ?? 0,
        resetSeconds: error.detail.retryAfterSeconds,
      });
    }

    const body: RateLimitErrorResponse = {
      statusCode: status,
      message: error.message,
      code: error.detail.code,
      policy: error.detail.policy,
      retryAfterSeconds: error.detail.retryAfterSeconds,
    };
    response.status(status).json(body);
  }
}
