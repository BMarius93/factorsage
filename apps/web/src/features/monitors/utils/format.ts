import type {
  MonitorLevelKind,
  MonitorSecurityStatus,
  MonitorSignalKind,
} from "@intrinsic/contracts";

/**
 * Display formatting for the monitors feature.
 *
 * Stock counts reuse `stockCountLabel` from the lists feature rather than restating the phrase, so
 * a list's size cannot read one way on its own page and another way on a monitor card.
 */

/** An ISO instant as a locale-aware date **and** time; the raw value if it cannot be parsed. */
export function formatMonitorTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.valueOf())) {
    return iso;
  }
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** What a monitor that has never completed a cycle reports instead of a time. */
export const NEVER_CHECKED_LABEL = "Not checked yet";

/**
 * The "last checked" line.
 *
 * `lastScanAt` is observability, never an input to Signal semantics — a monitor that has never been
 * included in a completed cycle says so instead of borrowing its creation time. It is also cleared
 * when the monitor is rebound, because the configuration it now names has not been checked.
 */
export function lastScanLabel(lastScanAt: string | undefined): string {
  return lastScanAt === undefined
    ? NEVER_CHECKED_LABEL
    : `Checked ${formatMonitorTimestamp(lastScanAt)}`;
}

/**
 * How each status reads, and the tone it carries.
 *
 * The four are kept apart deliberately: `ai/product/monitors.md` treats "could not be decided" as a
 * different answer from "did not match", and neither is the same as "nothing has looked yet".
 */
export const SECURITY_STATUS_LABELS: Record<MonitorSecurityStatus, string> = {
  MATCHED: "Matched",
  NO_MATCH: "No match",
  NOT_EVALUABLE: "Not evaluable",
  NOT_CHECKED: "Not checked yet",
};

export const SECURITY_STATUS_TONES: Record<MonitorSecurityStatus, string> = {
  MATCHED: "positive",
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
