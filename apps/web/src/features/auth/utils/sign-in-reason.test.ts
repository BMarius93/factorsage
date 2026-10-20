import { describe, expect, it } from "vitest";
import { SIGN_IN_REASONS, signInReason } from "./sign-in-reason";

describe("signInReason (GL-7)", () => {
  it.each([
    ["/backtests", SIGN_IN_REASONS.backtests],
    [
      "/backtests/new?strategyId=s-1&stockListId=l-2",
      SIGN_IN_REASONS.backtests,
    ],
    [
      "/backtests/00000000-0000-4000-8000-000000000000",
      SIGN_IN_REASONS.backtests,
    ],
    ["/strategies/new", SIGN_IN_REASONS.newStrategy],
    ["/lists?new=1", SIGN_IN_REASONS.newList],
    ["/billing", SIGN_IN_REASONS.billing],
    ["/billing?checkout=success", SIGN_IN_REASONS.billing],
    ["/legal/requests", SIGN_IN_REASONS.privacyRequests],
    ["/backtests/", SIGN_IN_REASONS.backtests],
  ])("names why %s needs an account", (next, expected) => {
    expect(signInReason(next)).toBe(expected);
  });

  it("falls back to one generic line for any other page that needs an account", () => {
    for (const next of ["/admin", "/lists/actor-groups/g-1", "/no-such-page"]) {
      expect(signInReason(next)).toBe(SIGN_IN_REASONS.fallback);
    }
  });

  it("says nothing for pages a Guest can already read", () => {
    // The topbar's own "Sign in" carries the page it was used on; that is not a bounce.
    for (const next of [
      "/lists",
      "/strategies",
      "/strategies/s-1",
      "/monitors",
      "/stocks/AAPL",
      "/pricing",
      "/terms",
      "/dashboard",
    ]) {
      expect(signInReason(next)).toBeNull();
    }
  });

  it("says nothing without a destination, or for the sign-in pages themselves", () => {
    for (const next of [
      null,
      undefined,
      "",
      "/",
      "/login",
      "/register?next=%2Fbilling",
    ]) {
      expect(signInReason(next)).toBeNull();
    }
  });

  it.each([
    ["a protocol-relative URL", "//evil.example/backtests"],
    ["an absolute URL", "https://evil.example/backtests"],
    ["a slash-backslash", "/\\evil.example/backtests"],
    ["a double-encoded //", "/%2F%2Fevil.example/backtests"],
    ["a control character", "/backtests\n"],
    ["a non-string", 42],
  ])("ignores %s, as the redirect does", (_label, next) => {
    expect(signInReason(next)).toBeNull();
  });

  it("only ever returns one of its own lines — nothing from the link is echoed", () => {
    const lines = new Set<string>(Object.values(SIGN_IN_REASONS));
    for (const next of [
      "/backtests?message=Your%20account%20is%20locked",
      "/somewhere-else?reason=<script>alert(1)</script>",
      "/billing#Enter-your-card-number-here",
    ]) {
      const reason = signInReason(next);
      expect(reason).not.toBeNull();
      expect(lines.has(reason ?? "")).toBe(true);
      expect(reason).not.toMatch(/locked|script|card/i);
    }
  });
});
