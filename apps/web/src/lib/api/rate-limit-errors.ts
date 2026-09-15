import {
  RATE_LIMITED_CODE,
  RATE_LIMIT_UNAVAILABLE_CODE,
} from "@intrinsic/contracts";
import { ApiError } from "./client";

/**
 * Recognising a throttled request in the browser.
 *
 * A `429` is neither a transient glitch nor a malformed request, and showing it as either is a
 * dead end in the same way an entitlement refusal is: "something went wrong, try again" invites an
 * immediate retry that is guaranteed to fail and makes the situation worse. The API already sends
 * a stable code and a number of seconds, so the only thing the UI has to do is say what actually
 * happened and for how long.
 *
 * `503 RATE_LIMIT_UNAVAILABLE` is deliberately a separate case: the caller did nothing wrong, so
 * it must not read as "you are going too fast".
 */

export function isRateLimitError(error: unknown): boolean {
  return error instanceof ApiError && error.code === RATE_LIMITED_CODE;
}

export function isThrottlingUnavailableError(error: unknown): boolean {
  return (
    error instanceof ApiError && error.code === RATE_LIMIT_UNAVAILABLE_CODE
  );
}

/** Copy for a throttled or throttling-unavailable failure, or `undefined` for anything else. */
export function rateLimitMessage(error: unknown): string | undefined {
  if (isThrottlingUnavailableError(error)) {
    return "The service is busy right now. Please try again in a few seconds.";
  }
  if (!isRateLimitError(error)) {
    return undefined;
  }
  const seconds = (error as ApiError).retryAfterSeconds;
  return seconds === undefined
    ? "Too many requests. Please slow down and try again shortly."
    : `Too many requests. Please try again in ${describeWait(seconds)}.`;
}

/**
 * The wait, in words a person reads rather than a raw second count.
 *
 * Windows here run from five minutes to an hour, and "try again in 3421 seconds" is not something
 * anyone can act on. Rounded up, never down: telling someone to come back before the allowance
 * refills would send them straight into a second refusal.
 */
function describeWait(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
