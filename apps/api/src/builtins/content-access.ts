import type { AuthUser, ContentOwnershipResponse } from "@intrinsic/contracts";

/**
 * Who may read and who may change a List, Strategy or Monitor.
 *
 * `docs/decisions/builtin-dashboard-signals-v1.md` section 6. Two ownerships, one rule each:
 *
 * - **USER content** belongs to one customer. Everybody else — administrators included — reads it
 *   as missing: a leaked id reveals nothing, and there is no administrator bypass of a customer's
 *   own content.
 * - **SYSTEM content** (built-ins) is readable by every viewer, Guests included, and changeable
 *   only by an `ADMIN`. A signed-in customer trying to change it is refused with a 403: the object
 *   plainly exists, so pretending otherwise would be the wrong answer.
 *
 * The role is always the one `CookieAuthGuard` reloaded from PostgreSQL, never client input.
 */

export type ContentViewer = AuthUser | null;

type OwnedRow = {
  ownership: "USER" | "SYSTEM";
  userId: string | null;
  systemKey: string | null;
};

/** A non-administrator attempted to change built-in content. */
export class SystemContentReadOnlyError extends Error {
  constructor(readonly noun: string) {
    super(`Built-in ${noun} can only be changed by an administrator`);
    this.name = "SystemContentReadOnlyError";
  }
}

/** Built-in content is never deleted; an administrator unpublishes or pauses it instead. */
export class SystemContentProtectedError extends Error {
  constructor(readonly noun: string) {
    super(`Built-in ${noun} cannot be deleted`);
    this.name = "SystemContentProtectedError";
  }
}

export function isAdministrator(viewer: ContentViewer): viewer is AuthUser {
  return viewer?.role === "ADMIN";
}

/** The rows a viewer may read: their own, and every built-in. */
export function readableWhere(viewer: ContentViewer) {
  return viewer
    ? { OR: [{ userId: viewer.id }, { ownership: "SYSTEM" as const }] }
    : { ownership: "SYSTEM" as const };
}

/**
 * The rows a viewer may change, **given that they can read the row**: their own, and — for an
 * administrator — every built-in. Use {@link assertMutable} to tell "missing" from "read-only".
 */
export function mutableWhere(viewer: AuthUser) {
  return viewer.role === "ADMIN"
    ? { OR: [{ userId: viewer.id }, { ownership: "SYSTEM" as const }] }
    : { userId: viewer.id };
}

/**
 * Decides whether a row the viewer asked to change may be changed.
 *
 * `null` means the row does not exist *for this viewer* — the caller answers 404. A built-in the
 * viewer may not change throws {@link SystemContentReadOnlyError}.
 */
export function assertMutable<T extends OwnedRow>(
  row: T | null,
  viewer: AuthUser,
  noun: string,
): T | null {
  if (!row) {
    return null;
  }
  if (row.ownership === "SYSTEM") {
    if (viewer.role !== "ADMIN") {
      throw new SystemContentReadOnlyError(noun);
    }
    return row;
  }
  return row.userId === viewer.id ? row : null;
}

/** The ownership block every List, Strategy and Monitor response carries. */
export function ownershipResponse(
  row: OwnedRow,
  viewer: ContentViewer,
): ContentOwnershipResponse {
  const system = row.ownership === "SYSTEM";
  return {
    ownership: row.ownership,
    ...(system && row.systemKey ? { systemKey: row.systemKey } : {}),
    canEdit: system
      ? isAdministrator(viewer)
      : viewer !== null && row.userId === viewer.id,
  };
}

/** The audit column a built-in edit stamps. A customer's own edit leaves it alone. */
export function auditOf(
  row: Pick<OwnedRow, "ownership">,
  viewer: AuthUser,
): { updatedByUserId?: string } {
  return row.ownership === "SYSTEM" ? { updatedByUserId: viewer.id } : {};
}

/** Built-ins first, in their operator order; customer content after, newest first. */
export const SYSTEM_FIRST_ORDER = [
  { ownership: "desc" as const },
  { displayOrder: { sort: "asc" as const, nulls: "last" as const } },
];
