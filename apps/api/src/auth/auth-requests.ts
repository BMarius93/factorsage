import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type LoginRequest,
  type RegisterRequest,
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

export function parseRegisterRequest(body: unknown): RegisterRequest {
  const email = requireEmail(body);
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

  return { email, password };
}

export function parseVerifyEmailRequest(body: unknown): VerifyEmailRequest {
  const token = stringField(body, "token").trim();
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new BadRequestException("Invalid verification request");
  }
  return { token };
}

export function parseResendVerificationRequest(
  body: unknown,
): ResendVerificationRequest {
  return { email: requireEmail(body) };
}
