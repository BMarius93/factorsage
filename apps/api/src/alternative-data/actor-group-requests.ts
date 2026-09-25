import {
  ACTOR_GROUP_DESCRIPTION_MAX_LENGTH,
  ACTOR_GROUP_MAX_MEMBERS_PER_ADD,
  ACTOR_GROUP_NAME_MAX_LENGTH,
} from "@intrinsic/contracts";
import { BadRequestException } from "@nestjs/common";

/**
 * Request parsing for the actor-group routes.
 *
 * It mirrors `../lists/stock-list-requests.ts`: every bound comes from `@intrinsic/contracts`, so the
 * browser and the API cannot disagree about a limit, and nothing here restates one.
 */

/** Generous structural bound; real ids are 36-character UUIDs. */
const MAX_ACTOR_ID_LENGTH = 64;

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
    throw new BadRequestException("A group needs a name");
  }
  if (name.length > ACTOR_GROUP_NAME_MAX_LENGTH) {
    throw new BadRequestException(
      `A group name must be at most ${ACTOR_GROUP_NAME_MAX_LENGTH} characters`,
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
  if (description.length > ACTOR_GROUP_DESCRIPTION_MAX_LENGTH) {
    throw new BadRequestException(
      `A group description must be at most ${ACTOR_GROUP_DESCRIPTION_MAX_LENGTH} characters`,
    );
  }
  return description.length === 0 ? null : description;
}

/**
 * Reads a list of actor ids, collapsing duplicates.
 *
 * Duplicates collapse rather than being rejected: adding the same actor twice in one request is
 * harmless and membership is a set, so refusing it would be pedantry. The bound is on the request,
 * not on the group, and the group's own maximum is enforced in the writing transaction where it
 * cannot be raced.
 */
function parseActorIds(value: unknown, required: boolean): string[] {
  if (value === undefined && !required) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new BadRequestException(
      "Invalid request: actorIds must be an array of actor ids",
    );
  }
  const unique = new Set<string>();
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.trim().length === 0 ||
      entry.length > MAX_ACTOR_ID_LENGTH
    ) {
      throw new BadRequestException("Invalid request: actorIds must be ids");
    }
    unique.add(entry);
  }
  if (unique.size > ACTOR_GROUP_MAX_MEMBERS_PER_ADD) {
    throw new BadRequestException(
      `At most ${ACTOR_GROUP_MAX_MEMBERS_PER_ADD} actors can be added in one request`,
    );
  }
  return [...unique];
}

export type ParsedCreateActorGroupRequest = {
  name: string;
  description?: string;
  actorIds: string[];
};

export function parseCreateActorGroupRequest(
  body: unknown,
): ParsedCreateActorGroupRequest {
  const raw = asRecord(body);
  const description = parseDescription(raw.description ?? null);
  return {
    name: parseName(raw.name),
    ...(description === null ? {} : { description }),
    actorIds: parseActorIds(raw.actorIds, false),
  };
}

export type ParsedUpdateActorGroupRequest = {
  name?: string;
  description?: string | null;
};

export function parseUpdateActorGroupRequest(
  body: unknown,
): ParsedUpdateActorGroupRequest {
  const raw = asRecord(body);
  const patch: ParsedUpdateActorGroupRequest = {};
  if (raw.name !== undefined) {
    patch.name = parseName(raw.name);
  }
  if (raw.description !== undefined) {
    patch.description = parseDescription(raw.description);
  }
  if (patch.name === undefined && patch.description === undefined) {
    throw new BadRequestException(
      "Invalid request: provide a name or a description to change",
    );
  }
  return patch;
}

export function parseAddActorGroupMembersRequest(body: unknown): {
  actorIds: string[];
} {
  const raw = asRecord(body);
  const actorIds = parseActorIds(raw.actorIds, true);
  if (actorIds.length === 0) {
    throw new BadRequestException("Invalid request: actorIds must not be empty");
  }
  return { actorIds };
}
