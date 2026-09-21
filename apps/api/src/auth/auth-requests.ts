import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type ForgotPasswordRequest,
  type LoginRequest,
  type RegisterRequest,
  type ResetPasswordRequest,
  type ResendVerificationRequest,
  type VerifyEmailRequest,
} from "@intrinsic/contracts";
import { BadRequestException } from "@nestjs/common";
import { isValidEmail, normalizeEmail } from "./email";

/** Generous upper bound; real tokens are 43 base64url characters. */
const MAX_TOKEN_LENGTH = 512;

function stringField(body: unknown, field: string): string {
  if (typeof body !== "object" || body === null || !(field in body)) {
    throw new BadRequestException(`Invalid request: ${field} is required`);
  }

  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== "string") {
    throw new BadRequestException(`Invalid request: ${field} is required`);
  }
  return value;
}

function requireEmail(body: unknown): string {
  const email = normalizeEmail(stringField(body, "email"));
  if (!isValidEmail(email)) {
    throw new BadRequestException("Enter a valid email address");
  }
  return email;
}

export function parseLoginRequest(body: unknown): LoginRequest {
  const email = requireEmail(body);
  const password = stringField(body, "password");

  // Login only bounds the input; the real policy applies at registration so an old password
  // that predates a policy change still authenticates.
  if (password.length === 0 || password.length > PASSWORD_MAX_LENGTH) {
    throw new BadRequestException("Invalid login request");
  }

  return { email, password };
}

/** The one place the product's password policy is applied to a password being *set*. */
function requirePolicyPassword(body: unknown): string {
  const password = stringField(body, "password");

  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new BadRequestException(
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new BadRequestException(
      `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
    );
  }

  return password;
}

/**
 * Email-first registration (AUTH-003): only the address is read. Anything else in the body — a
 * `password` from a client built before AUTH-003, a `role` or `plan` somebody hoped would stick —
 * is ignored and never reaches a log or the database.
 */
export function parseRegisterRequest(body: unknown): RegisterRequest {
  return { email: requireEmail(body) };
}

function requireToken(body: unknown, rejection: string): string {
  const token = stringField(body, "token").trim();
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new BadRequestException(rejection);
  }
  return token;
}

/**
 * Verification sets the account's password (AUTH-002), so it takes the full registration policy,
 * exactly like a reset. A request without a password — the pre-AUTH-002 shape — is refused here,
 * before any token is looked at.
 */
export function parseVerifyEmailRequest(body: unknown): VerifyEmailRequest {
  return {
    token: requireToken(body, "Invalid verification request"),
    password: requirePolicyPassword(body),
    // Only bounded here. Whether it is the version currently required is decided by
    // `LegalService.assertRequiredTermsVersion`, which is the one place that decides, and which
    // runs before anything is redeemed.
    termsVersion: requireTermsVersion(body),
  };
}

/**
 * The accepted Terms version. Missing, non-string, empty or absurdly long is a `400` before any
 * token is looked at, so a client built before legal acceptance existed cannot activate an
 * account without recording one — its link stays unspent and works once the page is reloaded.
 */
function requireTermsVersion(body: unknown): string {
  const version = stringField(body, "termsVersion").trim();
  if (version.length === 0 || version.length > 64) {
    throw new BadRequestException(
      "Invalid request: termsVersion is required",
    );
  }
  return version;
}

export function parseForgotPasswordRequest(
  body: unknown,
): ForgotPasswordRequest {
  return { email: requireEmail(body) };
}

/**
 * A reset sets a new password, so the full registration policy applies — an old password that
 * predates a policy change may still authenticate, but a newly chosen one must satisfy today's.
 */
export function parseResetPasswordRequest(body: unknown): ResetPasswordRequest {
  return {
    token: requireToken(body, "Invalid password reset request"),
    password: requirePolicyPassword(body),
  };
}

export function parseResendVerificationRequest(
  body: unknown,
): ResendVerificationRequest {
  return { email: requireEmail(body) };
}
