import { EMAIL_NOT_VERIFIED_CODE } from "@intrinsic/contracts";
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
  it("recognizes the unverified-email code so the UI can offer a resend", () => {
    expect(
      describeLoginFailure(new ApiError(403, "…", EMAIL_NOT_VERIFIED_CODE)),
    ).toEqual({ kind: "email_not_verified" });
  });

  it("collapses every credential rejection into one message", () => {
    for (const status of [400, 401, 403]) {
      expect(describeLoginFailure(new ApiError(status, "detail"))).toEqual({
        kind: "message",
        message: GENERIC_SIGN_IN_ERROR,
      });
    }
  });

  it("does not present server-side detail as a credential problem", () => {
    expect(describeLoginFailure(new ApiError(500, "Internal server error"))).toEqual(
      { kind: "message", message: UNEXPECTED_ERROR },
    );
    expect(describeLoginFailure(new TypeError("Failed to fetch"))).toEqual({
      kind: "message",
      message: UNEXPECTED_ERROR,
    });
  });
});

describe("describeRequestError", () => {
  it("surfaces an actionable 4xx message from the API", () => {
    expect(
      describeRequestError(new ApiError(409, "An account with this email already exists")),
    ).toBe("An account with this email already exists");
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
    expect(describeOAuthError("oauth_unavailable")).toContain("not available");
  });

  it("ignores a missing or unrecognized value rather than inventing an error", () => {
    expect(describeOAuthError(null)).toBeNull();
    expect(describeOAuthError("something-else")).toBeNull();
  });
});
