import { MONITOR_NAME_MAX_LENGTH } from "@intrinsic/contracts";
import { BadRequestException } from "@nestjs/common";

/**
 * Envelope parsing for the monitor routes.
 *
 * Hand-written, matching the repository's existing approach — there is no validation library in the
 * workspace and none should be added.
 *
 * **Rejecting unknown keys is a real rule, not tidiness.** It is what stops an `interval`,
 * `scanFrequency`, `cadence` or `schedule` field from ever being accepted onto a Monitor:
 * `ai/product/monitors.md` keeps cadence an application decision, and a silently ignored field
 * would look to a client exactly like a supported one.
 */
function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestException("Invalid request body");
  }
  return body as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new BadRequestException(
        `Invalid request: \`${key}\` is not part of a monitor. A monitor is a name, a strategy, a stock list and whether it is enabled; monitoring cadence is not configurable.`,
      );
    }
  }
}

function parseName(value: unknown): string {
  if (typeof value !== "string") {
    throw new BadRequestException("Invalid request: name is required");
  }
  const name = value.trim();
  if (name.length === 0) {
    throw new BadRequestException("A monitor needs a name");
  }
  if (name.length > MONITOR_NAME_MAX_LENGTH) {
    throw new BadRequestException(
      `A monitor name must be at most ${MONITOR_NAME_MAX_LENGTH} characters`,
    );
  }
  return name;
}

function parseId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestException(`Invalid request: ${field} is required`);
  }
  return value.trim();
}

function parseEnabled(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new BadRequestException(
      "Invalid request: enabled must be true or false",
    );
  }
  return value;
}

export type ParsedCreateMonitorRequest = {
  name: string;
  strategyId: string;
  stockListId: string;
  enabled: boolean;
};

export function parseCreateMonitorRequest(
  body: unknown,
): ParsedCreateMonitorRequest {
  const record = asRecord(body);
  rejectUnknownKeys(record, ["name", "strategyId", "stockListId", "enabled"]);
  return {
    name: parseName(record.name),
    strategyId: parseId(record.strategyId, "strategyId"),
    stockListId: parseId(record.stockListId, "stockListId"),
    // A Monitor the user just created is one they want running.
    enabled: record.enabled === undefined ? true : parseEnabled(record.enabled),
  };
}

export type ParsedUpdateMonitorRequest = {
  name?: string;
  enabled?: boolean;
  /** Rebinds the Monitor to a different Strategy. Ownership is checked by the service. */
  strategyId?: string;
  /** Rebinds the Monitor to a different Stock List. Ownership is checked by the service. */
  stockListId?: string;
  /** Built-in only; the service refuses them on a customer's Monitor. */
  isPublished?: boolean;
  isGloballyEnabled?: boolean;
  displayOrder?: number | null;
};

const UPDATABLE_KEYS = [
  "name",
  "enabled",
  "strategyId",
  "stockListId",
  "isPublished",
  "isGloballyEnabled",
  "displayOrder",
] as const;

/** The keys that only mean something on a built-in Monitor. */
export const BUILT_IN_MONITOR_KEYS = [
  "isPublished",
  "isGloballyEnabled",
  "displayOrder",
] as const;

function parseFlag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new BadRequestException(
      `Invalid request: ${field} must be true or false`,
    );
  }
  return value;
}

function parseDisplayOrder(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 10_000
  ) {
    throw new BadRequestException(
      "Invalid request: displayOrder must be a whole number from 0 to 10000, or null",
    );
  }
  return value;
}

export function parseUpdateMonitorRequest(
  body: unknown,
): ParsedUpdateMonitorRequest {
  const record = asRecord(body);
  rejectUnknownKeys(record, UPDATABLE_KEYS);
  if (UPDATABLE_KEYS.every((key) => record[key] === undefined)) {
    throw new BadRequestException(
      "Invalid request: provide a name, enabled, strategyId, stockListId, isPublished, isGloballyEnabled or displayOrder to update",
    );
  }
  return {
    ...(record.name === undefined ? {} : { name: parseName(record.name) }),
    ...(record.enabled === undefined
      ? {}
      : { enabled: parseEnabled(record.enabled) }),
    ...(record.strategyId === undefined
      ? {}
      : { strategyId: parseId(record.strategyId, "strategyId") }),
    ...(record.stockListId === undefined
      ? {}
      : { stockListId: parseId(record.stockListId, "stockListId") }),
    ...(record.isPublished === undefined
      ? {}
      : { isPublished: parseFlag(record.isPublished, "isPublished") }),
    ...(record.isGloballyEnabled === undefined
      ? {}
      : {
          isGloballyEnabled: parseFlag(
            record.isGloballyEnabled,
            "isGloballyEnabled",
          ),
        }),
    ...(record.displayOrder === undefined
      ? {}
      : { displayOrder: parseDisplayOrder(record.displayOrder) }),
  };
}

/** The Signal table's page size when none is asked for, and the most one page may hold. */
export const SIGNAL_TABLE_DEFAULT_LIMIT = 25;
export const SIGNAL_TABLE_MAX_LIMIT = 100;

export type SignalTableQuery = {
  /** Absent: active occurrences, then resolved ones. `PENDING_TRIGGER` lists waiting setups. */
  state?: "ACTIVE" | "RESOLVED" | "PENDING_TRIGGER";
  levelKind?: "BUY" | "SELL" | "FINAL_EXIT";
  limit: number;
  cursor?: string;
};

/** `?state=&levelKind=&limit=&cursor=` and nothing else. */
export function parseSignalTableQuery(query: unknown): SignalTableQuery {
  const record =
    typeof query === "object" && query !== null
      ? (query as Record<string, unknown>)
      : {};
  for (const key of Object.keys(record)) {
    if (!["state", "levelKind", "limit", "cursor"].includes(key)) {
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
  const state = text("state");
  if (
    state !== undefined &&
    state !== "ACTIVE" &&
    state !== "RESOLVED" &&
    state !== "PENDING_TRIGGER"
  ) {
    throw new BadRequestException(
      "Invalid request: state must be ACTIVE, RESOLVED or PENDING_TRIGGER",
    );
  }
  const levelKind = text("levelKind");
  if (
    levelKind !== undefined &&
    levelKind !== "BUY" &&
    levelKind !== "SELL" &&
    levelKind !== "FINAL_EXIT"
  ) {
    throw new BadRequestException(
      "Invalid request: levelKind must be BUY, SELL or FINAL_EXIT",
    );
  }
  const limitText = text("limit");
  const limit =
    limitText === undefined ? SIGNAL_TABLE_DEFAULT_LIMIT : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > SIGNAL_TABLE_MAX_LIMIT) {
    throw new BadRequestException(
      `Invalid request: limit must be a whole number from 1 to ${SIGNAL_TABLE_MAX_LIMIT}`,
    );
  }
  const cursor = text("cursor");
  return {
    limit,
    ...(state ? { state } : {}),
    ...(levelKind ? { levelKind } : {}),
    ...(cursor ? { cursor } : {}),
  };
}
