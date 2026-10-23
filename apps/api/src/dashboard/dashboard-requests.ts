import {
  MONITOR_ACTIVITY_KINDS,
  type MonitorActivityKind,
} from "@intrinsic/contracts";
import { BadRequestException } from "@nestjs/common";

/** The Activity feed's page size when none is asked for, and the most one page may hold. */
export const ACTIVITY_DEFAULT_LIMIT = 15;
export const ACTIVITY_MAX_LIMIT = 50;
/** One read of a `through` range: what a reader re-reads to refresh everything they hold. */
export const ACTIVITY_THROUGH_LIMIT = 200;

export type ActivityQuery = {
  monitorId?: string;
  /** Narrows the feed to one kind of event; absent for both. */
  kind?: MonitorActivityKind;
  limit: number;
  cursor?: string;
  /**
   * An event id: read every event from the newest down to and including it — the range a reader
   * already holds — in pages of {@link ACTIVITY_THROUGH_LIMIT}, continued with `cursor`.
   */
  through?: string;
};

/** `?monitorId=&kind=&limit=&cursor=&through=` and nothing else. */
/**
 * The query of one Monitor's own Activity history (`GET /monitors/:monitorId/activity`): the
 * Dashboard feed's, without `monitorId`, which the path already names.
 */
export function parseMonitorActivityQuery(
  query: unknown,
): Omit<ActivityQuery, "monitorId"> {
  return parseActivityQuery(query, ["kind", "limit", "cursor", "through"]);
}

export function parseActivityQuery(
  query: unknown,
  accepted: readonly string[] = [
    "monitorId",
    "kind",
    "limit",
    "cursor",
    "through",
  ],
): ActivityQuery {
  const record =
    typeof query === "object" && query !== null
      ? (query as Record<string, unknown>)
      : {};
  for (const key of Object.keys(record)) {
    if (!accepted.includes(key)) {
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
  const through = text("through");
  if (
    through !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      through,
    )
  ) {
    throw new BadRequestException(
      "Invalid request: through must be an event id",
    );
  }
  return {
    limit,
    ...(monitorId ? { monitorId } : {}),
    ...(kind ? { kind } : {}),
    ...(cursor ? { cursor } : {}),
    ...(through ? { through } : {}),
  };
}
