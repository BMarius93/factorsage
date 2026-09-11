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

export type MonitorDetailResponse = MonitorSummaryResponse & {
  signals: MonitorSignalResponse[];
};

export type CreateMonitorRequest = {
  name: string;
  strategyId: string;
  stockListId: string;
  /** Defaults to enabled: a Monitor the user just created is one they want running. */
  enabled?: boolean;
};

export type UpdateMonitorRequest = {
  name?: string;
  enabled?: boolean;
};
