import type { UpdateBuiltInMonitorVisibilityRequest } from "@intrinsic/contracts";
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
  limit: number;
  cursor?: string;
};

/** `?monitorId=&limit=&cursor=` and nothing else. */
export function parseActivityQuery(query: unknown): ActivityQuery {
  const record =
    typeof query === "object" && query !== null
      ? (query as Record<string, unknown>)
      : {};
  for (const key of Object.keys(record)) {
    if (!["monitorId", "limit", "cursor"].includes(key)) {
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
  const cursor = text("cursor");
  return {
    limit,
    ...(monitorId ? { monitorId } : {}),
    ...(cursor ? { cursor } : {}),
  };
}
