import type { StrategyLevelKind } from "./strategies.js";
import type { StockListSecurityResponse } from "./stock-lists.js";

/**
 * The Monitor API shapes.
 *
 * `ai/product/monitors.md` is the product decision this file carries; it is not restated or
 * reinterpreted here. A Monitor pairs a Strategy with a monitored universe and an `enabled` flag —
 * and nothing else. There is deliberately **no** cadence, interval, schedule or threshold field:
 * cadence is an application decision, and exposing one would make it a user-configurable one.
 *
 * Strategy semantics stay owned by `strategies.ts`. A Monitor references a Strategy; it never
 * embeds, copies or extends a definition.
 */

/** Shared input limits so the browser UI and the API cannot disagree. */
export const MONITOR_NAME_MAX_LENGTH = 120;

/**
 * Why one Signal exists.
 *
 * This is **explanation**, not a second product concept. `ai/product/monitors.md` is explicit that
 * a condition-only match and a trigger event are both Signals; the UI may explain the difference,
 * and this is what it explains it from.
 */
export const MONITOR_SIGNAL_KINDS = ["CONDITION", "TRIGGER"] as const;
export type MonitorSignalKind = (typeof MONITOR_SIGNAL_KINDS)[number];

/**
 * Which Strategy level produced a Signal.
 *
 * An alias of the canonical `StrategyLevelKind`, never a second list: a Monitor reports on the
 * Strategy's own levels, so a Monitor-specific copy could only ever drift from them.
 */
export type MonitorLevelKind = StrategyLevelKind;

/** One row of `GET /monitors`. */
export type MonitorSummaryResponse = {
  id: string;
  name: string;
  enabled: boolean;
  strategyId: string;
  strategyName: string;
  stockListId: string;
  stockListName: string;
  securityCount: number;
  /** Signals currently active for this Monitor. */
  activeSignalCount: number;
  /** When this Monitor was last included in an evaluation cycle. */
  lastScanAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type MonitorSignalResponse = {
  id: string;
  security: StockListSecurityResponse;
  levelKind: MonitorLevelKind;
  /** The canonical level id inside the Strategy definition the Signal was decided under. */
  levelId: string;
  kind: MonitorSignalKind;
  /** The provisional observation this Signal was decided on. */
  observationDate: string;
  observationPrice: number;
  detectedAt: string;
  /** Absent while the matched state is still active. */
  resolvedAt?: string;
};

/**
 * What the durable Monitor state can truthfully say about one monitored security.
 *
 * Deliberately four states, not a boolean. `ai/product/monitors.md` keeps `NOT_EVALUABLE` distinct
 * from a decided non-match — a provider outage is not the same answer as "the rule did not hold" —
 * and a security nothing has evaluated yet is neither. Collapsing any of them into `NO_MATCH`
 * would report a decision that was never made.
 */
export const MONITOR_SECURITY_STATUSES = [
  /** At least one level of the Strategy currently has an active Signal for this security. */
  "MATCHED",
  /** Evaluated and decided, and no level currently matches. */
  "NO_MATCH",
  /** Evaluated, but its inputs could not decide the rule — warm-up, missing data, no quote. */
  "NOT_EVALUABLE",
  /** No cycle has evaluated this security under the Monitor's current configuration yet. */
  "NOT_CHECKED",
] as const;
export type MonitorSecurityStatus = (typeof MONITOR_SECURITY_STATUSES)[number];

/** One level currently matching for a security, and the Signal that says so. */
export type MonitorMatchedLevelResponse = {
  /** The canonical level id inside the Strategy definition. */
  levelId: string;
  levelKind: MonitorLevelKind;
  kind: MonitorSignalKind;
  signalId: string;
  observationPrice: number;
  detectedAt: string;
};

/**
 * One security of the Monitor's current Stock List, with what its durable state says.
 *
 * This is a projection of persisted `MonitorSignalState`, never a re-evaluation: the worker owns
 * what a Strategy decides, and nothing re-derives it to render a page.
 */
export type MonitorSecurityEvaluationResponse = {
  security: StockListSecurityResponse;
  status: MonitorSecurityStatus;
  /** Non-empty exactly when `status` is `MATCHED`. */
  matchedLevels: MonitorMatchedLevelResponse[];
  /**
   * When this security's recorded status last **changed**.
   *
   * Not "when it was last evaluated": an evaluation that repeats the recorded outcome deliberately
   * writes nothing, so this timestamp does not move on every cycle. `Monitor.lastScanAt` is what
   * says when the Monitor was last checked.
   */
  statusSince?: string;
};

export type MonitorDetailResponse = MonitorSummaryResponse & {
  /**
   * Every security in the Monitor's current Stock List, with its current status. Ordered by
   * symbol so the table is stable between requests.
   */
  securities: MonitorSecurityEvaluationResponse[];
  signals: MonitorSignalResponse[];
};

export type CreateMonitorRequest = {
  name: string;
  strategyId: string;
  stockListId: string;
  /** Defaults to enabled: a Monitor the user just created is one they want running. */
  enabled?: boolean;
};

/**
 * What a user may change about a Monitor.
 *
 * `strategyId` and `stockListId` **rebind** the Monitor to a different Strategy or Stock List.
 * That is a different operation from editing the contents of the ones it already references: a
 * Monitor is live, so editing a Strategy's rules or a List's membership already changes what is
 * watched on the next cycle, with no request at all. Rebinding changes *which* Strategy or List is
 * watched, and crosses a configuration boundary — see `ai/product/monitors.md`.
 *
 * There is still deliberately no cadence, interval, schedule, threshold or notification field.
 */
export type UpdateMonitorRequest = {
  name?: string;
  enabled?: boolean;
  strategyId?: string;
  stockListId?: string;
};
