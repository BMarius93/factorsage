import {
  LEGAL_REQUEST_DETAILS_MAX_LENGTH,
  LEGAL_REQUEST_KINDS,
  type LegalAcceptanceRequest,
  type LegalRequestKind,
  type LegalRequestSubmission,
} from "@intrinsic/contracts";
import { BadRequestException } from "@nestjs/common";

/**
 * Request parsing for the legal endpoints, in the same shape as `auth-requests.ts`: the whole
 * accepted surface is stated here, and a controller never reaches into an untyped body.
 */

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

/**
 * The acceptance body is a version and nothing else.
 *
 * Deliberately no boolean "I agree": a boolean records that a checkbox was ticked, not *what* was
 * agreed to, and it is the version plus the document digest that make the record evidence. The
 * version is only bounded here; `LegalService.assertRequiredTermsVersion` decides whether it is
 * the one currently required, and it is the only thing that decides.
 */
export function parseLegalAcceptanceRequest(
  body: unknown,
): LegalAcceptanceRequest {
  const termsVersion = stringField(body, "termsVersion").trim();
  if (termsVersion.length === 0 || termsVersion.length > 64) {
    throw new BadRequestException("Invalid request: termsVersion is required");
  }
  return { termsVersion };
}

function isRequestKind(value: string): value is LegalRequestKind {
  return (LEGAL_REQUEST_KINDS as readonly string[]).includes(value);
}

export function parseLegalRequestSubmission(
  body: unknown,
): LegalRequestSubmission {
  const kind = stringField(body, "kind");
  if (!isRequestKind(kind)) {
    throw new BadRequestException("Invalid request: unsupported request kind");
  }

  const details = stringField(body, "details").trim();
  if (details.length === 0) {
    throw new BadRequestException(
      "Describe what you are asking for so the request can be handled.",
    );
  }
  if (details.length > LEGAL_REQUEST_DETAILS_MAX_LENGTH) {
    throw new BadRequestException(
      `Keep the description under ${LEGAL_REQUEST_DETAILS_MAX_LENGTH} characters.`,
    );
  }

  return { kind, details };
}
