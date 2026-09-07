import {
  STRATEGY_DESCRIPTION_MAX_LENGTH,
  STRATEGY_NAME_MAX_LENGTH,
} from "@intrinsic/contracts";
import { BadRequestException } from "@nestjs/common";

/**
 * Envelope parsing for the strategy routes.
 *
 * Hand-written, matching the repository's existing approach — there is no validation library in
 * the workspace and none should be added. This layer checks only the envelope: types, lengths and
 * unknown keys. The definition itself is never inspected here; it goes to
 * `normalizeStrategyDefinition` in `@intrinsic/contracts`, so the API and the Builder can never
 * disagree about what a valid strategy is.
 *
 * **Rejecting unknown keys is a real rule, not tidiness.** It is what stops a `stockListId`,
 * `initialCapital` or `maximumPositions` field from ever being accepted into a strategy.
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
        `Invalid request: \`${key}\` is not part of a strategy. A stock list, capital, contributions, maximum positions and the backtest date range belong to a backtest configuration.`,
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
    throw new BadRequestException("A strategy needs a name");
  }
  if (name.length > STRATEGY_NAME_MAX_LENGTH) {
    throw new BadRequestException(
      `A strategy name must be at most ${STRATEGY_NAME_MAX_LENGTH} characters`,
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
  if (description.length > STRATEGY_DESCRIPTION_MAX_LENGTH) {
    throw new BadRequestException(
      `A strategy description must be at most ${STRATEGY_DESCRIPTION_MAX_LENGTH} characters`,
    );
  }
  return description.length === 0 ? null : description;
}

export type ParsedCreateStrategyRequest = {
  name: string;
  description: string | null;
  /** Absent when the caller saved only a name; the service then stores an empty first version. */
  definition?: unknown;
};

export function parseCreateStrategyRequest(
  body: unknown,
): ParsedCreateStrategyRequest {
  const record = asRecord(body);
  rejectUnknownKeys(record, ["name", "description", "definition"]);
  return {
    name: parseName(record.name),
    description:
      record.description === undefined
        ? null
        : parseDescription(record.description),
    ...(record.definition === undefined
      ? {}
      : { definition: record.definition }),
  };
}

export type ParsedUpdateStrategyRequest = {
  name?: string;
  description?: string | null;
};

export function parseUpdateStrategyRequest(
  body: unknown,
): ParsedUpdateStrategyRequest {
  const record = asRecord(body);
  rejectUnknownKeys(record, ["name", "description"]);
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

/** The definition is handed to the canonical normalizer unexamined; only the envelope is checked. */
export function parseReplaceStrategyDefinitionRequest(body: unknown): unknown {
  const record = asRecord(body);
  rejectUnknownKeys(record, ["definition"]);
  if (record.definition === undefined) {
    throw new BadRequestException("Invalid request: definition is required");
  }
  return record.definition;
}
