import {
  RECENT_SECURITY_LIMIT,
  type RecordSecurityViewRequest,
} from "@intrinsic/contracts";
import { BadRequestException } from "@nestjs/common";

/** Generous structural bound; real ids are 36-character UUIDs. */
const MAX_SECURITY_ID_LENGTH = 64;

function parseSecurityId(value: unknown): string {
  if (typeof value !== "string") {
    throw new BadRequestException("Invalid request: securityId is required");
  }
  const securityId = value.trim();
  if (securityId.length === 0 || securityId.length > MAX_SECURITY_ID_LENGTH) {
    throw new BadRequestException("Invalid request: securityId is not valid");
  }
  return securityId;
}

export function parseRecordSecurityViewRequest(
  body: unknown,
): RecordSecurityViewRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestException("Invalid request body");
  }
  return {
    securityId: parseSecurityId((body as Record<string, unknown>).securityId),
  };
}

/**
 * Reads the Guest's locally stored recents off the query string.
 *
 * Tolerant rather than strict, on purpose: this carries browser-local state a user can neither see
 * nor repair, so a malformed or stale entry is dropped and the rest still resolves. Nothing here is
 * trusted — every surviving id is still looked up in the catalog before it reaches a response — so
 * the only job is to bound the work: duplicates collapse and at most `RECENT_SECURITY_LIMIT` ids
 * survive, whatever the caller sent.
 */
export function parseRecentSecurityIds(
  raw: string | string[] | undefined,
): string[] {
  if (raw === undefined) {
    return [];
  }
  const values = (Array.isArray(raw) ? raw : raw.split(","))
    .map((value) => value.trim())
    .filter(
      (value) => value.length > 0 && value.length <= MAX_SECURITY_ID_LENGTH,
    );
  return [...new Set(values)].slice(0, RECENT_SECURITY_LIMIT);
}
