import {
  RATE_LIMITED_CODE,
  type EntitlementReasonCode,
} from "@intrinsic/contracts";
import { ApiError } from "../client";

/**
 * The refusals every mutation surface must word through `requestFailureMessage` (UX-001), built
 * once so each component test asserts the same shapes the API really sends.
 */

/** A `403` plan-limit refusal: a stable reason code plus the API's own product wording. */
export function entitlementRefusal(
  code: EntitlementReasonCode,
  message = "Your plan allows 10 stocks per list; this change would make 11.",
): ApiError {
  return new ApiError(403, message, code);
}

/** A `429`, told to wait two minutes. */
export function rateLimited(): ApiError {
  return new ApiError(
    429,
    "Too many requests",
    RATE_LIMITED_CODE,
    undefined,
    120,
  );
}

/** The canonical copy `rateLimited()` must produce on every surface. */
export const RATE_LIMITED_COPY =
  "Too many requests. Please try again in 2 minutes.";

/** Something no translator recognises: the surface's own fallback must be what shows. */
export function unexpectedFailure(): ApiError {
  return new ApiError(500, "Internal server error");
}
