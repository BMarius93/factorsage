/**
 * The wire contract for API rate limiting.
 *
 * Only what a client legitimately needs to react to a refusal lives here: the stable reason codes,
 * the response body shape and the response header names. The **policy catalog** — how many points
 * each class of endpoint gets and over what window — is server-side operational configuration in
 * `apps/api/src/rate-limit/rate-limit-policies.ts` and deliberately not a contract: a deployment
 * may tune it without a contract change, and no client may depend on a specific number.
 *
 * Rate limiting is not an entitlement. `docs/decisions/entitlements-v1.md` section 10 draws that
 * line and `entitlements.rate-limiting-boundary.test.ts` enforces it: a plan never buys request
 * rate, and nothing here is reachable from the entitlement resolver.
 */

/** The caller exceeded a policy's allowance. Answered with `429 Too Many Requests`. */
export const RATE_LIMITED_CODE = "RATE_LIMITED" as const;

/**
 * The limiter itself could not answer, and the endpoint's policy is fail-closed. Answered with
 * `503 Service Unavailable`.
 *
 * Deliberately distinct from `RATE_LIMITED`: the caller did nothing wrong and their allowance is
 * untouched, so a client must not present it as "you are going too fast". Only the policies whose
 * purpose is security answer this way; capacity policies fail open instead.
 */
export const RATE_LIMIT_UNAVAILABLE_CODE = "RATE_LIMIT_UNAVAILABLE" as const;

export const RATE_LIMIT_REASON_CODES = [
  RATE_LIMITED_CODE,
  RATE_LIMIT_UNAVAILABLE_CODE,
] as const;

export type RateLimitReasonCode = (typeof RATE_LIMIT_REASON_CODES)[number];

/**
 * The body of a rate-limit refusal, shaped like every other machine-readable refusal the API
 * sends (`statusCode` + `message` + stable `code` + the numbers behind it).
 *
 * `policy` names which class of endpoint refused, so a client can tell "your search typing is too
 * fast" from "you have submitted too many backtests" without matching on the path. It is a stable
 * identifier, never a number a client should reason about.
 */
export type RateLimitErrorResponse = {
  readonly statusCode: 429 | 503;
  readonly message: string;
  readonly code: RateLimitReasonCode;
  readonly policy: string;
  /**
   * Whole seconds until the caller may retry, rounded up and at least 1. Present on
   * `RATE_LIMITED`, and on `RATE_LIMIT_UNAVAILABLE` as a conservative fixed hint.
   */
  readonly retryAfterSeconds: number;
};

/**
 * Response headers carried by every rate-limited route, on success and on refusal alike.
 *
 * The un-prefixed `RateLimit-*` spelling of the IETF draft is used rather than `X-RateLimit-*`:
 * both are widely understood, and the draft names are the ones converging on standardisation.
 * They are written in one place — the rate-limit interceptor — never per endpoint.
 *
 * The API and the web app are different origins, so these are useless to the browser unless the
 * API also lists them in `Access-Control-Expose-Headers`; `main.ts` does exactly that from this
 * list, which is why the list is a contract rather than four string literals.
 */
export const RATE_LIMIT_HEADERS = {
  /** The policy's allowance for the window. */
  limit: "RateLimit-Limit",
  /** Allowance left after this request. */
  remaining: "RateLimit-Remaining",
  /** Whole seconds until the allowance refills. */
  reset: "RateLimit-Reset",
  /** The policy identifier that produced the numbers above. */
  policy: "RateLimit-Policy",
  /** Standard `Retry-After`, in seconds. Sent only with a refusal. */
  retryAfter: "Retry-After",
} as const;

export const RATE_LIMIT_HEADER_NAMES = Object.values(
  RATE_LIMIT_HEADERS,
) as readonly string[];

/**
 * Thrown by the rate-limit enforcement point and translated to HTTP in exactly one place,
 * `RateLimitExceptionFilter`, exactly like `EntitlementError` and `BillingError`.
 */
export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly detail: {
      readonly code: RateLimitReasonCode;
      readonly policy: string;
      readonly retryAfterSeconds: number;
      /** Allowance and remaining points, when the limiter actually answered. */
      readonly limit?: number;
      readonly remaining?: number;
    },
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}
