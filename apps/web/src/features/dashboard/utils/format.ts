import type {
  DashboardFreshness,
  DashboardRowResponse,
  DashboardRowState,
} from "@intrinsic/contracts";
import type { StatusTone } from "../../../components/ui/StatusBadge";
import { LEVEL_KIND_LABELS } from "../../monitors/utils/format";

/** The two states a Dashboard row can be in, as the product says them. */
export const ROW_STATE_LABELS: Record<DashboardRowState, string> = {
  ACTIVE: "Active",
  PENDING_TRIGGER: "Waiting for trigger",
};

export const ROW_STATE_TONES: Record<DashboardRowState, StatusTone> = {
  ACTIVE: "positive",
  PENDING_TRIGGER: "active",
};

export const LEVEL_TONES = {
  BUY: "positive",
  SELL: "negative",
  FINAL_EXIT: "warning",
} as const satisfies Record<DashboardRowResponse["levelKind"], StatusTone>;

/** `Buy 100%`, `Sell 50%`, `Final exit`. */
export function levelLabel(
  row: Pick<DashboardRowResponse, "levelKind" | "levelPercentage">,
): string {
  const kind = LEVEL_KIND_LABELS[row.levelKind];
  return row.levelPercentage === undefined
    ? kind
    : `${kind} ${row.levelPercentage}%`;
}

/** A `YYYY-MM-DD` session as `Sep 15, 2026`, without a timezone shift. */
export function formatSessionDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) {
    return date;
  }
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** `just now`, `4 min ago`, `3 h ago`, `2 days ago`. */
export function formatAge(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return iso;
  }
  const minutes = Math.max(0, Math.round((now.getTime() - then) / 60_000));
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours} h ago`;
  }
  return `${Math.round(hours / 24)} days ago`;
}

export const FRESHNESS_TONES: Record<DashboardFreshness, StatusTone> = {
  CURRENT: "positive",
  STALE: "warning",
  NOT_SCANNED: "pending",
  PAUSED: "pending",
};

/**
 * What a monitor's freshness says. A stale scan is never described as current: the Dashboard's
 * rows are only as recent as the scan behind them.
 */
export function freshnessLabel(
  freshness: DashboardFreshness,
  lastScanAt: string | undefined,
  now: Date,
): string {
  switch (freshness) {
    case "CURRENT":
      return lastScanAt ? `Updated ${formatAge(lastScanAt, now)}` : "Updated";
    case "STALE":
      return lastScanAt
        ? `Stale · last scan ${formatAge(lastScanAt, now)}`
        : "Stale";
    case "NOT_SCANNED":
      return "Not scanned yet";
    case "PAUSED":
      return "Paused";
  }
}
