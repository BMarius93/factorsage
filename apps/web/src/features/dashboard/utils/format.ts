import type {
  DashboardFreshness,
  DashboardRowResponse,
  DashboardRowState,
} from "@intrinsic/contracts";
import type { StatusTone } from "../../../components/ui/StatusBadge";
import { LEVEL_KIND_LABELS } from "../../monitors/utils/format";
import { formatRelative } from "../../../lib/dates";

/** The two states a Dashboard row can be in, as the product says them. */
export const ROW_STATE_LABELS: Record<DashboardRowState, string> = {
  ACTIVE: "Active",
  PENDING_TRIGGER: "Waiting for trigger",
};

/**
 * The same two states as a compact filter label.
 *
 * `Waiting for trigger` is the honest full name and stays on the row badge and in the reason text,
 * where there is room to be precise. A segmented control has no such room: three buttons and their
 * counts must fit one line on a phone, and a truncated label teaches nothing.
 */
export const ROW_STATE_FILTER_LABELS: Record<DashboardRowState, string> = {
  ACTIVE: "Active",
  PENDING_TRIGGER: "Waiting",
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

/** `just now`, `4 min ago`, `3 h ago`, `2 days ago`, through the product's one date module. */
export function formatAge(iso: string, now: Date): string {
  return formatRelative(iso, now);
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
