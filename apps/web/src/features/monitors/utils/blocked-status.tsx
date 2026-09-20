import type {
  MonitorBlockedReason,
  MonitorSummaryResponse,
} from "@intrinsic/contracts";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import styles from "./blocked-status.module.css";

/**
 * Why an enabled monitor is not scanning, in the user's own terms.
 *
 * Both reasons are things the user can act on, and they need different actions — one is fixed by
 * editing a list, the other by disabling a monitor or upgrading — so they are never collapsed into
 * one message.
 */
export function blockedExplanation(
  reason: MonitorBlockedReason | undefined,
): string {
  if (reason === "LIST_OVER_LIMIT") {
    return "Its stock list holds more stocks than your plan allows, so it cannot scan until the list is smaller or your plan is larger.";
  }
  return "Your plan allows fewer active monitors than you have enabled, so this one is waiting for a slot.";
}

type OperationalState = Pick<
  MonitorSummaryResponse,
  "operationalStatus" | "blockedReason"
>;

export function isBlockedByEntitlement(monitor: OperationalState): boolean {
  return monitor.operationalStatus === "BLOCKED_BY_ENTITLEMENT";
}

/** The short reason shown inline under the state, on every device (UI-021). */
export function blockedShortReason(
  reason: MonitorBlockedReason | undefined,
): string {
  return reason === "LIST_OVER_LIMIT"
    ? "Its list is over your plan's stock limit"
    : "Over your plan's active-monitor limit";
}

/**
 * **One** effective state per monitor (UI-021).
 *
 * `enabled` is what the user asked for; the operational status is what the system does with it.
 * They used to render as two pills side by side — "Enabled" and "Not scanning" — which read as a
 * contradiction, and the reason lived in a hover tooltip a phone cannot open. A monitor the plan
 * has stopped now reads "Paused — plan limit", its reason sits under it as text, and the
 * configured intent is a secondary fact on the monitor's own page. Collection and detail share
 * this component so they cannot drift apart.
 */
export function MonitorStateBadge({
  monitor,
  builtIn = false,
  showReason = false,
}: {
  readonly monitor: OperationalState & { readonly enabled: boolean };
  readonly builtIn?: boolean;
  /** Adds the short reason under a paused state — for a collection row, where there is room. */
  readonly showReason?: boolean;
}) {
  if (!builtIn && monitor.enabled && isBlockedByEntitlement(monitor)) {
    return (
      <span className={styles.state}>
        <StatusBadge
          tone="blocked"
          testId="monitor-state-pill"
          dataAttributes={{
            "data-state": "BLOCKED",
            ...(monitor.blockedReason
              ? { "data-blocked-reason": monitor.blockedReason }
              : {}),
          }}
        >
          Paused — plan limit
        </StatusBadge>
        {showReason ? (
          <span className={styles.reason} data-testid="monitor-state-reason">
            {blockedShortReason(monitor.blockedReason)}
          </span>
        ) : null}
      </span>
    );
  }
  const label = builtIn
    ? monitor.enabled
      ? "Running"
      : "Paused"
    : monitor.enabled
      ? "Enabled"
      : "Disabled";
  return (
    <StatusBadge
      tone={monitor.enabled ? "positive" : "pending"}
      testId="monitor-state-pill"
      dataAttributes={{
        "data-state": monitor.enabled ? "ENABLED" : "DISABLED",
      }}
    >
      {label}
    </StatusBadge>
  );
}
