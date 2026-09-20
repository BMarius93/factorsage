import type {
  MonitorLevelKind,
  MonitorSecurityStatus,
  MonitorSignalKind,
  MonitorTransitionReason,
} from "@intrinsic/contracts";
import type { StatusTone } from "../../../components/ui/StatusBadge";
import { formatDateTime } from "../../../lib/dates";

/**
 * Display formatting for the monitors feature.
 *
 * Stock counts reuse `stockCountLabel` from the lists feature rather than restating the phrase, so
 * a list's size cannot read one way on its own page and another way on a monitor card.
 */

/** An ISO instant as a date **and** time, through the product's one date module. */
export function formatMonitorTimestamp(iso: string): string {
  return formatDateTime(iso);
}

/** What a monitor that has never completed a cycle reports instead of a time. */
export const NEVER_CHECKED_LABEL = "Not checked yet";

/**
 * When a monitor was last checked.
 *
 * `lastScanAt` is observability, never an input to Signal semantics — a monitor that has never been
 * included in a completed cycle says so instead of borrowing its creation time. It is also cleared
 * when the monitor is rebound, because the configuration it now names has not been checked.
 *
 * The value carries no "Checked" prefix: every surface that shows it already labels it, on the
 * collection as a column header and on a phone card as the row's own label.
 */
export function lastScanLabel(lastScanAt: string | undefined): string {
  return lastScanAt === undefined
    ? NEVER_CHECKED_LABEL
    : formatMonitorTimestamp(lastScanAt);
}

/**
 * How each status reads, and the tone it carries.
 *
 * The five are kept apart deliberately: `ai/product/monitors.md` treats "could not be decided" as a
 * different answer from "did not match", and neither is the same as "nothing has looked yet".
 */
export const SECURITY_STATUS_LABELS: Record<MonitorSecurityStatus, string> = {
  MATCHED: "Matched",
  WAITING_FOR_TRIGGER: "Waiting for trigger",
  NO_MATCH: "No match",
  NOT_EVALUABLE: "Not evaluable",
  NOT_CHECKED: "Not checked yet",
};

export const SECURITY_STATUS_TONES: Record<MonitorSecurityStatus, StatusTone> =
  {
    MATCHED: "positive",
    WAITING_FOR_TRIGGER: "active",
    NO_MATCH: "neutral",
    NOT_EVALUABLE: "warning",
    NOT_CHECKED: "pending",
  };

/** `BUY` / `SELL` / `FINAL_EXIT` as the product writes them. */
export const LEVEL_KIND_LABELS: Record<MonitorLevelKind, string> = {
  BUY: "Buy",
  SELL: "Sell",
  FINAL_EXIT: "Final exit",
};

/** Why a Signal exists. Both remain Signals; this only explains which produced it. */
export const SIGNAL_KIND_LABELS: Record<MonitorSignalKind, string> = {
  CONDITION: "Condition",
  TRIGGER: "Trigger",
};

/** An observation price. Monitor prices are plain USD amounts, like every other price surface. */
export function formatObservationPrice(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

/**
 * How many Signals are currently active.
 *
 * Both condition matches and trigger events are Signals, so there is deliberately one count rather
 * than two — `ai/product/monitors.md` keeps that distinction an explanation, not a second concept.
 */
export function activeSignalLabel(count: number): string {
  if (count === 0) {
    return "No active signals";
  }
  return `${count} active ${count === 1 ? "signal" : "signals"}`;
}

/**
 * Why a Signal ended, in the product's words (UI-026). `resolutionReason` is recorded on every
 * resolution; "Ended Sep 18" alone left the reader to guess whether the stock stopped qualifying or
 * something about the monitor changed. Reasons that only ever start a state read as a plain end.
 */
export const RESOLUTION_REASON_LABELS: Record<MonitorTransitionReason, string> =
  {
    CONDITIONS_MET: "ended",
    SETUP_STARTED: "ended",
    TRIGGER_FIRED: "ended",
    CONDITIONS_ENDED: "conditions no longer hold",
    EVENT_SESSION_ENDED: "trigger day passed",
    BUY_WINDOW_CLOSED: "membership period ended",
    LOGIC_CHANGED: "strategy logic changed",
    LEVEL_REMOVED: "level removed from the strategy",
    MEMBER_REMOVED: "stock left the list",
    MONITOR_REBOUND: "monitor now watches something else",
    RECONSTRUCTED: "ended",
  };

/**
 * The order monitored stocks are listed in (UI-026): what is happening first — matched, then
 * waiting for a trigger — then what could not be decided, then plain non-matches, then what has
 * not been checked. Symbol order breaks ties, as the API sends it.
 */
export const SECURITY_STATUS_ORDER: Record<MonitorSecurityStatus, number> = {
  MATCHED: 0,
  WAITING_FOR_TRIGGER: 1,
  NOT_EVALUABLE: 2,
  NO_MATCH: 3,
  NOT_CHECKED: 4,
};
