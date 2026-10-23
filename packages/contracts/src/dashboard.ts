import type { ContentOwnership } from "./builtins.js";
import type {
  MonitorLevelKind,
  MonitorLifecycleState,
  MonitorTransitionReason,
  MonitorWhyResponse,
} from "./monitors.js";
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

export type DashboardEntityReference = { id: string; name: string };

/** One Monitor the viewer can see. */
export type DashboardMonitorResponse = {
  id: string;
  name: string;
  ownership: ContentOwnership;
  strategy: DashboardEntityReference;
  stockList: DashboardEntityReference;
  /**
   * Whether it is Enabled for this viewer — the one user-facing switch, and exactly the Monitors
   * whose activity the Dashboard shows. A customer's own Monitor's `enabled`; a built-in's per-user
   * choice (default enabled, and always the default for a Guest). The switch itself lives on the
   * Monitors page (`PATCH /monitors/:monitorId`).
   */
  enabled: boolean;
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

/**
 * What one Monitor Activity event is (`GET /dashboard/activity`): an occurrence that a finalized
 * end-of-day session activated, or one that a session's market observation ended
 * (`docs/decisions/monitor-eod-v2.md` §6, §12). Administrative endings, a trigger day passing,
 * setups and reconstructed states never appear; neither does an event without recorded evidence or
 * one of an occurrence the earlier live-quote Monitor decided intraday.
 */
export const MONITOR_ACTIVITY_KINDS = ["ACTIVATED", "RESOLVED"] as const;
export type MonitorActivityKind = (typeof MONITOR_ACTIVITY_KINDS)[number];

export type DashboardActivityEventResponse = {
  /** Stable, opaque event identity. */
  id: string;
  kind: MonitorActivityKind;
  reason: MonitorTransitionReason;
  /** The exchange session the change was observed on. */
  sessionDate: string;
  security: StockListSecurityResponse;
  levelKind: MonitorLevelKind;
  /** The level's position among levels of its kind, in the version that decided it. */
  levelIndex?: number;
  levelPercentage?: number;
  monitor: DashboardEntityReference & { ownership: ContentOwnership };
  strategy: DashboardEntityReference;
  stockList: DashboardEntityReference;
  /** The occurrence. */
  signalId?: string;
  /** The occurrence's activation price: its session's finalized close. */
  price?: number;
  /**
   * True when the session was not being watched when it became final — a window replay, a resumed
   * Monitor's catch-up, a member added later — so the event was found afterwards, `From history`.
   * `sessionDate` is still the session the conditions held on; `recordedAt` says when it was found.
   */
  fromHistory: boolean;
  /** When FactorSage evaluated the session and recorded the event (processing time). */
  recordedAt: string;
  /** The predicates that decided it, with the values compared on `sessionDate`: always `EVIDENCE`. */
  why: MonitorWhyResponse;
};

/** `GET /dashboard/activity`: end-of-day activity, newest session first. */
export type DashboardActivityResponse = {
  viewer: "GUEST" | "AUTHENTICATED";
  generatedAt: string;
  /**
   * The Dashboard's rolling window (`MONITOR_ACTIVITY_WINDOW_DAYS`): only sessions on or after this
   * day are activity. Absent on a Monitor's own Activity history, which is not windowed.
   */
  windowStart?: string;
  events: DashboardActivityEventResponse[];
  /** Opaque; pass back as `cursor` for older events. Absent on the last page. */
  nextCursor?: string;
};
