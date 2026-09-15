import {
  RATE_LIMITED_CODE,
  RATE_LIMIT_UNAVAILABLE_CODE,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { requestFailureMessage } from "./entitlement-errors";
import {
  isRateLimitError,
  isThrottlingUnavailableError,
  rateLimitMessage,
} from "./rate-limit-errors";
import { describeLoginFailure } from "../../features/auth/utils/auth-errors";

const throttled = (retryAfterSeconds?: number) =>
  new ApiError(
    429,
    "Too many requests. Retry in 300 seconds.",
    RATE_LIMITED_CODE,
    undefined,
    retryAfterSeconds,
  );

describe("throttled responses in the browser", () => {
  it("recognises a 429 by its stable code", () => {
    expect(isRateLimitError(throttled(30))).toBe(true);
    expect(isRateLimitError(new ApiError(500, "boom"))).toBe(false);
    expect(isRateLimitError(new Error("network"))).toBe(false);
  });

  it("tells a throttled caller apart from an unavailable limiter", () => {
    const unavailable = new ApiError(
      503,
      "Request throttling is temporarily unavailable.",
      RATE_LIMIT_UNAVAILABLE_CODE,
    );
    expect(isThrottlingUnavailableError(unavailable)).toBe(true);
    expect(isRateLimitError(unavailable)).toBe(false);
    // The caller did nothing wrong, so the copy must not blame them.
    expect(rateLimitMessage(unavailable)).toContain("busy");
    expect(rateLimitMessage(unavailable)).not.toContain("Too many");
  });

  it("names the wait in units a person can act on", () => {
    expect(rateLimitMessage(throttled(1))).toContain("1 second");
    expect(rateLimitMessage(throttled(45))).toContain("45 seconds");
    expect(rateLimitMessage(throttled(300))).toContain("5 minutes");
    // Rounded up, never down: coming back early is a second refusal.
    expect(rateLimitMessage(throttled(61))).toContain("2 minutes");
    expect(rateLimitMessage(throttled(3600))).toContain("1 hour");
  });

  it("still says something useful without a Retry-After", () => {
    const message = rateLimitMessage(throttled());
    expect(message).toContain("Too many requests");
    expect(message).not.toContain("undefined");
  });

  it("returns nothing for failures that are not throttling", () => {
    expect(rateLimitMessage(new ApiError(404, "missing"))).toBeUndefined();
    expect(rateLimitMessage(undefined)).toBeUndefined();
  });

  it("is what the shared failure message shows, ahead of the generic fallback", () => {
    // The property that matters across lists, strategies, monitors and backtests: none of them
    // needs to know about rate limiting, and none of them shows "something went wrong" for a 429.
    expect(requestFailureMessage(throttled(120), "Could not save.")).toContain(
      "2 minutes",
    );
    expect(
      requestFailureMessage(new ApiError(500, "x"), "Could not save."),
    ).toBe("Could not save.");
  });

  it("never tells a throttled sign-in that the credentials were wrong", () => {
    // The specific harm: a throttled login is refused whether or not the password was right, so
    // the generic credential message would send the user to reset a password that works.
    const failure = describeLoginFailure(throttled(300));
    expect(failure.kind).toBe("message");
    expect(failure).toMatchObject({
      message: expect.stringContaining("5 minutes"),
    });
    expect(failure).not.toMatchObject({
      message: expect.stringContaining("credentials"),
    });
  });
});
