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
    : rateLimitWaitMessage(seconds);
}

/** The throttled copy for a known wait — also what a surface says while it is still waiting. */
export function rateLimitWaitMessage(seconds: number): string {
  return `Too many requests. Please try again in ${describeWait(seconds)}.`;
}

/** Waits assumed when a throttled answer does not say how long; long enough not to be refused again. */
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 30;
const DEFAULT_THROTTLING_UNAVAILABLE_WAIT_SECONDS = 5;

/**
 * How long a surface must hold off before asking again, in milliseconds, or `0` when the failure
 * says nothing about waiting. Honours the server's `Retry-After` whenever it sent one.
 */
export function retryWaitMs(error: unknown): number {
  if (isRateLimitError(error)) {
    return (
      ((error as ApiError).retryAfterSeconds ??
        DEFAULT_RATE_LIMIT_WAIT_SECONDS) * 1000
    );
  }
  if (isThrottlingUnavailableError(error)) {
    return (
      ((error as ApiError).retryAfterSeconds ??
        DEFAULT_THROTTLING_UNAVAILABLE_WAIT_SECONDS) * 1000
    );
  }
  return 0;
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
