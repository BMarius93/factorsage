import type { StockSectorAssignmentResponse } from "./stock-sector-etfs.js";
import type { ContentOwnershipResponse } from "./builtins.js";
import type {
  MonitorBlockedReason,
  MonitorOperationalStatus,
} from "./entitlements.js";
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

/**
 * The durable current state of one evaluated Strategy signal under a Monitor.
 *
 * `docs/decisions/builtin-dashboard-signals-v1.md` section 2 owns the state machine:
 *
 * - `INACTIVE` — nothing is matched and no occurrence has ended since the state was reset;
 * - `PENDING_TRIGGER` — the Conditions of a triggered Signal hold, and its Trigger has not fired
 *   for this setup yet. No Signal occurrence exists;
 * - `ACTIVE` — a Signal occurrence is current;
 * - `RESOLVED` — the most recent occurrence ended.
 *
 * `NOT_EVALUABLE` is deliberately absent: it is an evaluation result, not a lifecycle state, and a
 * not-evaluable observation never moves this.
 */
export const MONITOR_LIFECYCLE_STATES = [
  "INACTIVE",
  "PENDING_TRIGGER",
  "ACTIVE",
  "RESOLVED",
] as const;
export type MonitorLifecycleState = (typeof MONITOR_LIFECYCLE_STATES)[number];

/**
 * Why a lifecycle state changed, recorded on every transition and on a resolved Signal.
 *
 * - `CONDITIONS_MET` — a condition-only Signal's Conditions became true;
 * - `SETUP_STARTED` — a triggered Signal's Conditions became true, waiting for the Trigger;
 * - `TRIGGER_FIRED` — the Trigger fired (with the Conditions holding, when there are any);
 * - `CONDITIONS_ENDED` — a required Condition became false;
 * - `EVENT_SESSION_ENDED` — a trigger-only event reached a later real exchange session;
 * - `BUY_WINDOW_CLOSED` — a BUY level's List membership no longer admitted the observation date.
 *   Recorded only by the earlier live-quote Monitor; the end-of-day Monitor gates every level on
 *   ongoing membership and records `MEMBERSHIP_CHANGED` instead;
 * - `LOGIC_CHANGED` — the level's canonical logic was edited;
 * - `LEVEL_REMOVED` — the level is no longer evaluated by the Monitor's Strategy;
 * - `MEMBER_REMOVED` — the security left the Monitor's Stock List;
 * - `MONITOR_REBOUND` — the Monitor was pointed at a different Strategy or Stock List;
 * - `RECONSTRUCTED` — the state was established by historical reconstruction rather than
 *   observed live;
 * - `MEMBERSHIP_CHANGED` — the security is still in the List but is no longer a current member
 *   there (its open-ended membership period was closed, moved or removed): an administrative
 *   ending, never a market one.
 */
export const MONITOR_TRANSITION_REASONS = [
  "CONDITIONS_MET",
  "SETUP_STARTED",
  "TRIGGER_FIRED",
  "CONDITIONS_ENDED",
  "EVENT_SESSION_ENDED",
  "BUY_WINDOW_CLOSED",
  "LOGIC_CHANGED",
  "LEVEL_REMOVED",
  "MEMBER_REMOVED",
  "MONITOR_REBOUND",
  "RECONSTRUCTED",
  "MEMBERSHIP_CHANGED",
] as const;
export type MonitorTransitionReason =
  (typeof MONITOR_TRANSITION_REASONS)[number];

/**
 * How a Signal's price was observed: `EOD_CLOSE` is its session's finalized end-of-day close;
 * `LIVE_QUOTE` marks occurrences the earlier live-quote Monitor decided on an intraday price, kept as
 * recorded (`docs/decisions/monitor-eod-v2.md` §3).
 */
export const MONITOR_OBSERVATION_BASES = ["LIVE_QUOTE", "EOD_CLOSE"] as const;
export type MonitorObservationBasis =
  (typeof MONITOR_OBSERVATION_BASES)[number];

/**
 * One predicate of a Why: the rule's own wording, in the canonical Strategy description language,
 * with the values the decision compared when they were recorded.
 */
export type MonitorWhyPredicateResponse = {
  role: "CONDITION" | "TRIGGER";
  description: string;
  /** Absent when no evidence was recorded for the decision. */
  result?: "TRUE" | "FALSE" | "NOT_EVALUABLE";
  /** The left operand on the session; `null` when it did not resolve. Absent without evidence. */
  metric?: number | null;
  /** The right operand on the session; `null` when it did not resolve. Absent without evidence. */
  value?: number | null;
  /** A Trigger's previous-session operands, when recorded. */
  previousMetric?: number | null;
  previousValue?: number | null;
};

export type MonitorWhyRuleResponse = {
  /** The FINAL EXIT Exit Rule's 1-based position when there are several; absent otherwise. */
  exitRule?: number;
  predicates: MonitorWhyPredicateResponse[];
};

/**
 * Why a lifecycle change happened, from the Strategy version that decided it — never from the
 * Strategy as it reads today (`docs/decisions/monitor-eod-v2.md` §5–§6).
 *
 * - `EVIDENCE` — every predicate with the values recorded on `sessionDate`;
 * - `RULE_ONLY` — the decided rule's wording without values: the change predates recorded evidence,
 *   and nothing is recomputed to fill the gap.
 */
export type MonitorWhyResponse = {
  basis: "EVIDENCE" | "RULE_ONLY";
  sessionDate?: string;
  rules: MonitorWhyRuleResponse[];
};

/**
 * How far the Monitor's evaluation has reached: the newest finalized session any current member was
 * evaluated through, and how many current members have reached it.
 */
export type MonitorCoverageResponse = {
  /** The newest session any current member has been evaluated through; absent before the first. */
  latestSession?: string;
  /** Current members evaluated through `latestSession`. */
  evaluatedMembers: number;
  /** Members currently in the Monitor universe (`ai/product/lists.md`, membership under a Monitor). */
  currentMembers: number;
  /** Every member of the Stock List, current or not. */
  listedMembers: number;
};

/** One row of `GET /monitors`. */
export type MonitorSummaryResponse = ContentOwnershipResponse & {
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
  /**
   * What the system will actually do with `enabled` right now.
   *
   * `enabled` is the user's persisted intent and survives everything, including a downgrade.
   * This is the separate, **derived** concept: an enabled Monitor beyond the plan's active
   * capacity, or one watching a List that is over the plan's symbol limit, reports
   * `BLOCKED_BY_ENTITLEMENT` while its `enabled` value stays `true`. Nothing here is persisted,
   * so an upgrade or a corrective edit resolves it on the next read with no write at all.
   */
  operationalStatus: MonitorOperationalStatus;
  /** Present only when `operationalStatus` is `BLOCKED_BY_ENTITLEMENT`. */
  blockedReason?: MonitorBlockedReason;
  /**
   * Built-in only. Whether customers can see it; an unpublished built-in is visible to
   * administrators alone.
   */
  isPublished?: boolean;
  /**
   * Built-in only. Whether the platform evaluates it — the operator's switch. A built-in's
   * `enabled` mirrors this, and `operationalStatus` is `DISABLED` while it is off.
   */
  isGloballyEnabled?: boolean;
  /** Built-in only. */
  displayOrder?: number;
  /**
   * Built-in only: whether this viewer's Dashboard shows the built-in's rows.
   *
   * This is the viewer's own `UserBuiltInMonitorPreference`, never a property of the shared
   * Monitor — hiding one changes nothing about whether the platform evaluates it, and a customer's
   * own Monitor has no such field because its real `enabled` lifecycle is that switch. A Guest has
   * no preference row and reads the built-in default.
   */
  dashboardVisible?: boolean;
};

export type MonitorSignalResponse = {
  id: string;
  security: StockListSecurityResponse;
  levelKind: MonitorLevelKind;
  /** The canonical level id inside the Strategy definition the Signal was decided under. */
  levelId: string;
  kind: MonitorSignalKind;
  /** The session this occurrence became active on. */
  observationDate: string;
  observationPrice: number;
  /** How `observationPrice` was observed. */
  observationBasis?: MonitorObservationBasis;
  detectedAt: string;
  /** Absent while the matched state is still active. */
  resolvedAt?: string;
  /** The session the occurrence ended on, when a session ended it. */
  resolvedObservationDate?: string;
  /** Why the occurrence ended. Absent while it is active. */
  resolutionReason?: MonitorTransitionReason;
  /**
   * True when historical reconstruction established this occurrence's activation — the Monitor
   * did not exist, or had no state for this logic, when it began.
   */
  reconstructed: boolean;
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
  /**
   * No level is active, and a triggered level's Conditions hold while its Trigger has not fired
   * (`PENDING_TRIGGER`).
   */
  "WAITING_FOR_TRIGGER",
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

/** One level whose Conditions hold while its Trigger has not fired yet. */
export type MonitorWaitingLevelResponse = {
  levelId: string;
  levelKind: MonitorLevelKind;
  /**
   * When the setup began: the close of the session it was observed on, or the scan that observed
   * it while that session was still open. Not when the row was written.
   */
  since: string;
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
  /** Levels whose setup is waiting for its Trigger, whatever the overall status. */
  waitingLevels: MonitorWaitingLevelResponse[];
  /**
   * When this security's recorded status last **changed**.
   *
   * Not "when it was last evaluated": an evaluation that repeats the recorded outcome deliberately
   * writes nothing, so this timestamp does not move on every cycle. `Monitor.lastScanAt` is what
   * says when the Monitor was last checked.
   */
  statusSince?: string;
};

/**
 * The current availability of one ETF source the Monitor's Strategy reads, derived at read time
 * from the series' durable refresh state — never persisted, because it describes the data's state
 * now, not an evaluation (`ai/architecture/strategy-etf-conditions.md` §7).
 *
 * - `READY` — the newest stored session is finalized and synchronized; conditions evaluate
 *   through it.
 * - `AWAITING_SESSION` — synchronized, but the current session's end-of-day bar is not final yet,
 *   so ETF conditions are not evaluable for it until the evening refresh lands (strict
 *   same-session alignment; nothing is carried forward).
 * - `NOT_SYNCHRONIZED` — no completed tail read proves any stored bar final.
 * - `NOT_BOOTSTRAPPED` — the series' history was never bootstrapped; an operator action.
 */
export type MonitorEtfSourceStatusResponse = {
  code: string;
  ticker: string;
  status:
    "READY" | "AWAITING_SESSION" | "NOT_SYNCHRONIZED" | "NOT_BOOTSTRAPPED";
  /** The newest finalized, synchronized session, when one exists. */
  latestSession?: string;
};

/**
 * One row of the Monitor's Signal table (`GET /monitors/:monitorId/signals`): an occurrence that is
 * active or resolved, or — only when asked for — a setup waiting for its Trigger.
 */
export const MONITOR_SIGNAL_ROW_STATES = [
  "ACTIVE",
  "RESOLVED",
  "PENDING_TRIGGER",
] as const;
export type MonitorSignalRowState = (typeof MONITOR_SIGNAL_ROW_STATES)[number];

export type MonitorSignalRowResponse = {
  /** The Signal's id, or the waiting setup's own opaque id. */
  id: string;
  state: MonitorSignalRowState;
  security: StockListSecurityResponse;
  levelKind: MonitorLevelKind;
  levelId: string;
  /** The level's position among levels of its kind, in the version that decided it. */
  levelIndex?: number;
  levelPercentage?: number;
  kind: MonitorSignalKind;
  /** The session the row is dated by: its activation, or its resolution once resolved. */
  sessionDate: string;
  /** The session the occurrence (or setup) began on. */
  activatedOn?: string;
  activationPrice?: number;
  observationBasis?: MonitorObservationBasis;
  /** The session it ended on, when a session ended it. */
  resolvedOn?: string;
  resolutionReason?: MonitorTransitionReason;
  /** History, not an observation the Monitor made, established it. */
  fromHistory: boolean;
  /**
   * Why it is active (the activating decision) or why it ended (the ending decision); absent when the
   * version that decided it cannot be read.
   */
  why?: MonitorWhyResponse;
};

export type MonitorSignalPageResponse = {
  rows: MonitorSignalRowResponse[];
  /**
   * Opaque; pass back as `cursor` for the next page. Absent on the last page. It continues only the
   * table its first page read: once a session is evaluated or the Monitor rebinds, the next page is
   * refused with 409 and the reader starts over.
   */
  nextCursor?: string;
  /** On a first page: how many rows each group holds under the level filter. */
  counts?: MonitorSignalTableCounts;
};

export type MonitorSignalTableCounts = {
  active: number;
  ended: number;
  waiting: number;
};

export type MonitorDetailResponse = MonitorSummaryResponse & {
  /**
   * Every security in the Monitor's current Stock List, with its current status. Ordered by
   * symbol so the table is stable between requests.
   */
  securities: MonitorSecurityEvaluationResponse[];
  signals: MonitorSignalResponse[];
  /**
   * One row per ETF source the Monitor's Strategy currently reads, in catalog order; absent when
   * it reads none. A non-`READY` row is why an ETF condition reports "not evaluable" right now.
   */
  etfSources?: MonitorEtfSourceStatusResponse[];
  /**
   * Which sector ETF each monitored stock's Stock's Sector rules read **now**, by symbol; absent
   * unless the Strategy reads Stock's Sector. Derived at read time from each stock's current FMP
   * sector. Every sector ETF named here also has its row in `etfSources`.
   */
  stockSectors?: StockSectorAssignmentResponse[];
  /** How far evaluation has reached across the current members. */
  coverage?: MonitorCoverageResponse;
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
  /** Built-in only, administrators only. */
  isPublished?: boolean;
  /** Built-in only, administrators only. */
  isGloballyEnabled?: boolean;
  /** Built-in only, administrators only. `null` clears it. */
  displayOrder?: number | null;
};
