import {
  ENTITLEMENT_REASON_CODES,
  type EntitlementReasonCode,
} from "@intrinsic/contracts";
import { ApiError } from "./client";
import { rateLimitMessage } from "./rate-limit-errors";

/**
 * Recognising an entitlement refusal in the browser.
 *
 * A plan limit is not a transient failure and not a malformed request, and showing it as either is
 * a dead end: "try again in a moment" is false — the next attempt fails identically — and "check
 * your input" sends the user round a loop they cannot exit. The API already answers with a stable
 * reason code and a message written in product vocabulary ("Your plan allows 10 stocks per list;
 * this change would make 11"), so the only thing the UI has to do is recognise it and show it.
 *
 * The server enforces the limit regardless. Nothing here decides anything — it is presentation of
 * a decision already made.
 */

export function entitlementReason(
  error: unknown,
): EntitlementReasonCode | undefined {
  if (!(error instanceof ApiError) || error.code === undefined) {
    return undefined;
  }
  return (ENTITLEMENT_REASON_CODES as readonly string[]).includes(error.code)
    ? (error.code as EntitlementReasonCode)
    : undefined;
}

export function isEntitlementError(error: unknown): boolean {
  return entitlementReason(error) !== undefined;
}

/**
 * The message to show for a failed request, preferring the API's own words.
 *
 * `429` and its `503` sibling come first, because they are the two failures where a generic
 * "something went wrong" is actively harmful: it invites the immediate retry that caused them.
 * `403` with an entitlement code is a plan limit; `400` is the API disagreeing with a document the
 * client also validated. All of those are worth reading verbatim. Anything else is genuinely
 * unknown, and `fallback` says so.
 */
export function requestFailureMessage(
  error: unknown,
  fallback: string,
): string {
  const throttled = rateLimitMessage(error);
  if (throttled) {
    return throttled;
  }
  if (isEntitlementError(error)) {
    return (error as ApiError).message;
  }
  if (error instanceof ApiError && error.status === 400) {
    return error.message;
  }
  return fallback;
}
