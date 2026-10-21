import {
  MONITOR_ACTIVITY_KINDS,
  type MonitorActivityKind,
  type UpdateBuiltInMonitorVisibilityRequest,
} from "@intrinsic/contracts";
import { BadRequestException } from "@nestjs/common";

/** `{ "visible": boolean }` and nothing else. */
export function parseVisibilityRequest(
  body: unknown,
): UpdateBuiltInMonitorVisibilityRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestException("Invalid request body");
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "visible") {
      throw new BadRequestException(
        `Invalid request: \`${key}\` is not accepted`,
      );
    }
  }
  if (typeof record.visible !== "boolean") {
    throw new BadRequestException(
      "Invalid request: visible must be true or false",
    );
  }
  return { visible: record.visible };
}

/** The Activity feed's page size when none is asked for, and the most one page may hold. */
export const ACTIVITY_DEFAULT_LIMIT = 15;
export const ACTIVITY_MAX_LIMIT = 50;

export type ActivityQuery = {
  monitorId?: string;
  /** Narrows the feed to one kind of event; absent for both. */
  kind?: MonitorActivityKind;
  limit: number;
  cursor?: string;
  /**
   * A `watermark` from an earlier answer: read the changes written after it instead of a page.
   * Never combined with `cursor`.
   */
  since?: bigint;
};

/** `?monitorId=&kind=&limit=&cursor=&since=` and nothing else. */
export function parseActivityQuery(query: unknown): ActivityQuery {
  const record =
    typeof query === "object" && query !== null
      ? (query as Record<string, unknown>)
      : {};
  for (const key of Object.keys(record)) {
    if (!["monitorId", "kind", "limit", "cursor", "since"].includes(key)) {
      throw new BadRequestException(
        `Invalid request: \`${key}\` is not accepted`,
      );
    }
  }
  const text = (key: string): string | undefined => {
    const value = record[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new BadRequestException(
        `Invalid request: ${key} must be one value`,
      );
    }
    return value.trim();
  };
  const limitText = text("limit");
  const limit =
    limitText === undefined ? ACTIVITY_DEFAULT_LIMIT : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > ACTIVITY_MAX_LIMIT) {
    throw new BadRequestException(
      `Invalid request: limit must be a whole number from 1 to ${ACTIVITY_MAX_LIMIT}`,
    );
  }
  const monitorId = text("monitorId");
  const kindText = text("kind");
  if (
    kindText !== undefined &&
    !(MONITOR_ACTIVITY_KINDS as readonly string[]).includes(kindText)
  ) {
    throw new BadRequestException(
      `Invalid request: kind must be one of ${MONITOR_ACTIVITY_KINDS.join(", ")}`,
    );
  }
  const kind = kindText as MonitorActivityKind | undefined;
  const cursor = text("cursor");
  const sinceText = text("since");
  if (sinceText !== undefined && !/^\d{1,19}$/.test(sinceText)) {
    throw new BadRequestException(
      "Invalid request: since must be a watermark this API returned",
    );
  }
  if (sinceText !== undefined && cursor !== undefined) {
    throw new BadRequestException(
      "Invalid request: since and cursor cannot be combined",
    );
  }
  return {
    limit,
    ...(monitorId ? { monitorId } : {}),
    ...(kind ? { kind } : {}),
    ...(cursor ? { cursor } : {}),
    ...(sinceText === undefined ? {} : { since: BigInt(sinceText) }),
  };
}
