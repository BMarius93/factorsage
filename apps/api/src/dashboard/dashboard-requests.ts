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
