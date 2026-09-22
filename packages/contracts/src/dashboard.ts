import type { ContentOwnership } from "./builtins.js";
import type { MonitorLevelKind, MonitorLifecycleState } from "./monitors.js";
import type { StockListSecurityResponse } from "./stock-lists.js";

/**
 * The Dashboard: a table of every current Monitor match and setup the viewer can see.
 *
 * `docs/decisions/builtin-dashboard-signals-v1.md` section 4 is the product decision. The server
 * returns one normalized read model so the browser never joins unrelated endpoints; it is a
 * projection of durable Monitor state, never a re-evaluation, and it never exposes persistence
 * internals such as logic fingerprints or rule-local state.
 */

/** The two lifecycle states the Dashboard shows. `INACTIVE` and `RESOLVED` are never rows. */
export const DASHBOARD_ROW_STATES = [
  "ACTIVE",
  "PENDING_TRIGGER",
] as const satisfies readonly MonitorLifecycleState[];
export type DashboardRowState = (typeof DASHBOARD_ROW_STATES)[number];

/**
 * How honest the Monitor's latest scan lets the Dashboard be.
 *
 * - `CURRENT` — scanned within the expected cadence;
 * - `STALE` — scanned, but not recently enough to call current;
 * - `NOT_SCANNED` — no completed scan under its current configuration;
 * - `PAUSED` — not being evaluated (disabled, globally paused, or blocked by the owner's plan);
 *   its rows are frozen and therefore not shown.
 */
export const DASHBOARD_FRESHNESS = [
  "CURRENT",
  "STALE",
  "NOT_SCANNED",
  "PAUSED",
] as const;
export type DashboardFreshness = (typeof DASHBOARD_FRESHNESS)[number];

/**
 * What a visibility toggle changes.
 *
 * - `BUILT_IN_PREFERENCE` — the viewer's own Dashboard visibility of a shared built-in Monitor
 *   (`PUT /dashboard/monitors/:monitorId/visibility`); it never changes whether it is evaluated.
 * - `MONITOR_ENABLED` — a customer's own Monitor, whose real `enabled` lifecycle is the switch
 *   (`PATCH /monitors/:monitorId`).
 */
export const DASHBOARD_VISIBILITY_CONTROLS = [
  "BUILT_IN_PREFERENCE",
  "MONITOR_ENABLED",
] as const;
export type DashboardVisibilityControl =
  (typeof DASHBOARD_VISIBILITY_CONTROLS)[number];

export type DashboardEntityReference = { id: string; name: string };

/** One Monitor the viewer can put on their Dashboard. */
export type DashboardMonitorResponse = {
  id: string;
  name: string;
  ownership: ContentOwnership;
  strategy: DashboardEntityReference;
  stockList: DashboardEntityReference;
  /** Whether its rows are on this viewer's Dashboard. */
  visible: boolean;
  control: DashboardVisibilityControl;
  freshness: DashboardFreshness;
  /** The latest completed scan of its current configuration. */
  lastScanAt?: string;
  activeCount: number;
  pendingCount: number;
};

/**
 * Why a row exists, in the canonical Strategy description language (`describeCondition`,
 * `describeTrigger`). One entry per Strategy signal behind the row — FINAL EXIT may have several
 * Exit Rules current at once, and still produces one row.
 */
export type DashboardRowReason = {
  /** The FINAL EXIT Exit Rule's 1-based position; absent for BUY and SELL. */
  exitRule?: number;
  conditions: string[];
  trigger?: string;
  /** True while this signal's Trigger has not fired yet. */
  waitingForTrigger: boolean;
};

export type DashboardRowResponse = {
  /** Stable, opaque row identity. */
  id: string;
  state: DashboardRowState;
  security: StockListSecurityResponse;
  levelKind: MonitorLevelKind;
  /** The level's position among levels of its kind; absent for FINAL EXIT. */
  levelIndex?: number;
  /** The level's percentage; absent for FINAL EXIT. */
  levelPercentage?: number;
  reasons: DashboardRowReason[];
  monitor: DashboardEntityReference & { ownership: ContentOwnership };
  strategy: DashboardEntityReference;
  stockList: DashboardEntityReference;
  /** The price observed when the state began — the activation price for `ACTIVE`. */
  price?: number;
  /** The exchange session the state began on. */
  observationDate?: string;
  /**
   * When the state began, as an instant: the close of {@link observationDate}'s session, or the
   * scan that observed it when that session had not closed yet.
   *
   * It is a statement about the observation, not about when the row was written — a historically
   * reconstructed match is dated to the session it happened on however much later the scan that
   * found it ran.
   */
  since: string;
  /** True when historical reconstruction, not a live scan, established the state. */
  reconstructed: boolean;
  /** The Signal occurrence, for `ACTIVE` rows. */
  signalId?: string;
};

/** `GET /dashboard`. */
export type DashboardResponse = {
  viewer: "GUEST" | "AUTHENTICATED";
  generatedAt: string;
  /** How old a scan may be and still count as current. */
  staleAfterMs: number;
  monitors: DashboardMonitorResponse[];
  /** Newest state change first. */
  rows: DashboardRowResponse[];
};

/** `PUT /dashboard/monitors/:monitorId/visibility`. */
export type UpdateBuiltInMonitorVisibilityRequest = { visible: boolean };
