import { EMAIL_NOT_VERIFIED_CODE, OAUTH_ERROR_CODES } from "@intrinsic/contracts";
import { ApiError } from "../../../lib/api/client";

/** Shown whenever the API declines to say more; it must never hint at which part was wrong. */
export const GENERIC_SIGN_IN_ERROR = "Unable to sign in with those credentials.";

export const UNEXPECTED_ERROR =
  "Something went wrong. Please check your connection and try again.";

export type LoginFailure =
  | { kind: "email_not_verified" }
  | { kind: "message"; message: string };

export function describeLoginFailure(error: unknown): LoginFailure {
  if (error instanceof ApiError && error.code === EMAIL_NOT_VERIFIED_CODE) {
    return { kind: "email_not_verified" };
  }

  if (error instanceof ApiError) {
    // 4xx responses are safe to surface verbatim; a 5xx message is server detail the user
    // cannot act on.
    return {
      kind: "message",
      message:
        error.status >= 500 ? UNEXPECTED_ERROR : GENERIC_SIGN_IN_ERROR,
    };
  }

  return { kind: "message", message: UNEXPECTED_ERROR };
}

/** Surfaces the API's own 4xx message (duplicate email, weak password) when there is one. */
export function describeRequestError(error: unknown): string {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return error.message;
  }
  return UNEXPECTED_ERROR;
}

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_state:
    "That sign-in attempt expired or could not be verified. Please try again.",
  oauth_provider:
    "Google could not complete the sign-in. Please try again in a moment.",
  oauth_email_unverified:
    "Google has not verified the email address on that account, so it cannot be used to sign in.",
  oauth_unavailable: "Google sign-in is not available for this deployment.",
};

/** Maps the API's redirect `error` parameter to copy, ignoring anything it did not send. */
export function describeOAuthError(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return OAUTH_ERROR_CODES.includes(value as (typeof OAUTH_ERROR_CODES)[number])
    ? (OAUTH_ERROR_MESSAGES[value] ?? UNEXPECTED_ERROR)
    : null;
}
