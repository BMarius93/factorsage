/**
 * Built-in (SYSTEM) content: the platform's own Lists, Strategies and Monitors.
 *
 * `docs/decisions/builtin-dashboard-signals-v1.md` is the product decision. Built-ins are ordinary
 * domain objects with a different owner: everybody — Guests included — may read and use a standard
 * built-in, only an `ADMIN` may change one, and none of them counts against a customer's own
 * content. A **premium** built-in is read in full and used only on a plan that includes premium
 * content (`docs/decisions/entitlements-v2.md` §6).
 */
export const CONTENT_OWNERSHIPS = ["USER", "SYSTEM"] as const;
export type ContentOwnership = (typeof CONTENT_OWNERSHIPS)[number];

/** Carried by every List, Strategy and Monitor response. */
export type ContentOwnershipResponse = {
  ownership: ContentOwnership;
  /** The immutable identity of a built-in. Absent for a customer's own content. */
  systemKey?: string;
  /**
   * Whether the viewer may change this object: their own content, or a built-in when the viewer
   * is an administrator. Presentation only — every mutation is authorized by the API.
   */
  canEdit: boolean;
  /**
   * Present on a **premium** built-in (`docs/decisions/entitlements-v2.md` §6) — a premium
   * predefined List or Strategy, or a point-in-time index universe. Absent for everything else.
   */
  premium?: true;
  /**
   * Present when the object is premium and the viewer's plan does not include premium content: its
   * name, description and size are shown, its membership or rules are not, and it cannot be
   * backtested or duplicated. Presentation only — the API refuses each of those itself.
   */
  locked?: true;
};

/** The `code` of a 403 refusing a non-administrator's change to built-in content. */
export const SYSTEM_CONTENT_READ_ONLY_CODE =
  "SYSTEM_CONTENT_READ_ONLY" as const;
/** The `code` of a 409 refusing to delete built-in content, which is never deleted. */
export const SYSTEM_CONTENT_PROTECTED_CODE =
  "SYSTEM_CONTENT_PROTECTED" as const;

/** One built-in object as the administrator surface lists it. */
export type BuiltInContentItemResponse = {
  id: string;
  systemKey: string;
  name: string;
  displayOrder?: number;
  updatedAt: string;
  /** The administrator who last edited it, when one has. */
  updatedByEmail?: string;
};

export type BuiltInMonitorAdminResponse = BuiltInContentItemResponse & {
  isPublished: boolean;
  isGloballyEnabled: boolean;
  strategyId: string;
  strategyName: string;
  stockListId: string;
  stockListName: string;
  lastScanAt?: string;
  activeCount: number;
  pendingCount: number;
};

/** `GET /admin/built-ins`. */
export type BuiltInContentAdminResponse = {
  lists: (BuiltInContentItemResponse & { itemCount: number })[];
  strategies: (BuiltInContentItemResponse & { versionNumber: number })[];
  monitors: BuiltInMonitorAdminResponse[];
};
