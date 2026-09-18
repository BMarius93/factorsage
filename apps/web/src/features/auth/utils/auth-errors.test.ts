import { OAUTH_ERROR_CODES } from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../lib/api/client";
import {
  GENERIC_SIGN_IN_ERROR,
  UNEXPECTED_ERROR,
  describeLoginFailure,
  describeOAuthError,
  describeRequestError,
} from "./auth-errors";

describe("describeLoginFailure", () => {
  it("collapses every credential rejection into one message", () => {
    for (const status of [400, 401, 403]) {
      expect(describeLoginFailure(new ApiError(status, "detail"))).toBe(
        GENERIC_SIGN_IN_ERROR,
      );
    }
    // A code that once meant "verify your email" is no longer special (AUTH-003).
    expect(
      describeLoginFailure(new ApiError(403, "…", "EMAIL_NOT_VERIFIED")),
    ).toBe(GENERIC_SIGN_IN_ERROR);
  });

  it("does not present server-side detail as a credential problem", () => {
    expect(describeLoginFailure(new ApiError(500, "Internal server error"))).toBe(
      UNEXPECTED_ERROR,
    );
    expect(describeLoginFailure(new TypeError("Failed to fetch"))).toBe(
      UNEXPECTED_ERROR,
    );
  });
});

describe("describeRequestError", () => {
  it("surfaces an actionable 4xx message from the API", () => {
    expect(
      describeRequestError(new ApiError(400, "Enter a valid email address")),
    ).toBe("Enter a valid email address");
  });

  it("hides 5xx and non-API failures behind a neutral message", () => {
    expect(describeRequestError(new ApiError(503, "smtp down"))).toBe(
      UNEXPECTED_ERROR,
    );
    expect(describeRequestError(new Error("boom"))).toBe(UNEXPECTED_ERROR);
  });
});

describe("describeOAuthError", () => {
  it("explains each error code the API can redirect with", () => {
    expect(describeOAuthError("oauth_state")).toContain("expired");
    expect(describeOAuthError("oauth_provider")).toContain("Google");
    expect(describeOAuthError("oauth_email_unverified")).toContain("verified");
    expect(describeOAuthError("oauth_link_not_allowed")).toContain(
      "already uses that email address",
    );
    expect(describeOAuthError("oauth_unavailable")).toContain("not available");
  });

  it("covers every code the contract defines, so none falls back to a generic message", () => {
    for (const code of OAUTH_ERROR_CODES) {
      expect(describeOAuthError(code)).not.toBe(UNEXPECTED_ERROR);
      expect(describeOAuthError(code)).toBeTruthy();
    }
  });

  it("ignores a missing or unrecognized value rather than inventing an error", () => {
    expect(describeOAuthError(null)).toBeNull();
    expect(describeOAuthError("something-else")).toBeNull();
  });
});
