import {
  BUY_WINDOW_MODES,
  BUY_WINDOW_MAX_RANGES,
  STOCK_LIST_DESCRIPTION_MAX_LENGTH,
  STOCK_LIST_MAX_SECURITIES_PER_ADD,
  STOCK_LIST_NAME_MAX_LENGTH,
  type AddStockListItemsRequest,
  type BuyWindowMode,
  type CreateStockListRequest,
  type UpdateStockListRequest,
} from "@intrinsic/contracts";
import type { BuyWindowRange } from "@intrinsic/domain";
import { BadRequestException } from "@nestjs/common";

/** Generous structural bound; real ids are 36-character UUIDs. */
const MAX_SECURITY_ID_LENGTH = 64;

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestException("Invalid request body");
  }
  return body as Record<string, unknown>;
}

function parseName(value: unknown): string {
  if (typeof value !== "string") {
    throw new BadRequestException("Invalid request: name is required");
  }
  const name = value.trim();
  if (name.length === 0) {
    throw new BadRequestException("A list needs a name");
  }
  if (name.length > STOCK_LIST_NAME_MAX_LENGTH) {
    throw new BadRequestException(
      `A list name must be at most ${STOCK_LIST_NAME_MAX_LENGTH} characters`,
    );
  }
  return name;
}

function parseDescription(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new BadRequestException("Invalid request: description must be text");
  }
  const description = value.trim();
  if (description.length > STOCK_LIST_DESCRIPTION_MAX_LENGTH) {
    throw new BadRequestException(
      `A list description must be at most ${STOCK_LIST_DESCRIPTION_MAX_LENGTH} characters`,
    );
  }
  return description.length === 0 ? null : description;
}

function parseSecurityIds(value: unknown, required: boolean): string[] {
  if (value === undefined && !required) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new BadRequestException(
      "Invalid request: securityIds must be an array of catalog security ids",
    );
  }
  const unique = new Set<string>();
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.trim().length === 0 ||
      entry.length > MAX_SECURITY_ID_LENGTH
    ) {
      throw new BadRequestException(
        "Invalid request: securityIds must be an array of catalog security ids",
      );
    }
    unique.add(entry);
  }
  if (required && unique.size === 0) {
    throw new BadRequestException("Select at least one stock to add");
  }
  if (unique.size > STOCK_LIST_MAX_SECURITIES_PER_ADD) {
    throw new BadRequestException(
      `At most ${STOCK_LIST_MAX_SECURITIES_PER_ADD} securities can be added in one request`,
    );
  }
  return [...unique];
}

export function parseCreateStockListRequest(
  body: unknown,
): CreateStockListRequest & { securityIds: string[] } {
  const record = asRecord(body);
  const name = parseName(record.name);
  const description =
    record.description === undefined ? null : parseDescription(record.description);
  const securityIds = parseSecurityIds(record.securityIds, false);
  return { name, ...(description === null ? {} : { description }), securityIds };
}

export function parseUpdateStockListRequest(
  body: unknown,
): UpdateStockListRequest {
  const record = asRecord(body);
  if (record.name === undefined && record.description === undefined) {
    throw new BadRequestException(
      "Invalid request: provide a name or description to update",
    );
  }
  return {
    ...(record.name === undefined ? {} : { name: parseName(record.name) }),
    ...(record.description === undefined
      ? {}
      : { description: parseDescription(record.description) }),
  };
}

export function parseAddStockListItemsRequest(
  body: unknown,
): AddStockListItemsRequest {
  const record = asRecord(body);
  return { securityIds: parseSecurityIds(record.securityIds, true) };
}

export type ParsedReplaceBuyWindowsRequest = {
  mode: BuyWindowMode;
  ranges: BuyWindowRange[];
};

/**
 * Structural validation only: date format, ordering, and the FULL/CUSTOM invariants are the
 * domain's job (`normalizeBuyWindowConfiguration`), so the two layers cannot disagree.
 */
export function parseReplaceBuyWindowsRequest(
  body: unknown,
): ParsedReplaceBuyWindowsRequest {
  const record = asRecord(body);
  const mode = record.mode;
  if (
    typeof mode !== "string" ||
    !BUY_WINDOW_MODES.includes(mode as BuyWindowMode)
  ) {
    throw new BadRequestException(
      "Invalid request: mode must be FULL or CUSTOM",
    );
  }
  if (!Array.isArray(record.ranges)) {
    throw new BadRequestException(
      "Invalid request: ranges must be an array of { startDate, endDate } objects",
    );
  }
  if (record.ranges.length > BUY_WINDOW_MAX_RANGES) {
    throw new BadRequestException(
      `At most ${BUY_WINDOW_MAX_RANGES} buy-window ranges can be submitted`,
    );
  }

  const ranges: BuyWindowRange[] = [];
  for (const entry of record.ranges) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new BadRequestException(
        "Invalid request: ranges must be an array of { startDate, endDate } objects",
      );
    }
    const { startDate, endDate } = entry as Record<string, unknown>;
    if (typeof startDate !== "string") {
      throw new BadRequestException(
        "Invalid request: every range needs a startDate",
      );
    }
    if (
      endDate !== null &&
      endDate !== undefined &&
      typeof endDate !== "string"
    ) {
      throw new BadRequestException(
        "Invalid request: a range endDate must be a date or null",
      );
    }
    ranges.push({ startDate, endDate: endDate ?? null });
  }

  return { mode: mode as BuyWindowMode, ranges };
}
