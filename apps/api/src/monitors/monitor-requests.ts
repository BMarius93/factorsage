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
        `Invalid request: \`${key}\` is not part of a monitor. A monitor is a strategy, a stock list and whether it is enabled; monitoring cadence is not configurable.`,
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
};

export function parseUpdateMonitorRequest(
  body: unknown,
): ParsedUpdateMonitorRequest {
  const record = asRecord(body);
  rejectUnknownKeys(record, ["name", "enabled"]);
  if (record.name === undefined && record.enabled === undefined) {
    throw new BadRequestException(
      "Invalid request: provide a name or enabled to update",
    );
  }
  return {
    ...(record.name === undefined ? {} : { name: parseName(record.name) }),
    ...(record.enabled === undefined
      ? {}
      : { enabled: parseEnabled(record.enabled) }),
  };
}
