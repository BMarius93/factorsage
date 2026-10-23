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
 * **One** effective state per monitor (UI-021), for the monitor's own page header.
 *
 * `enabled` is what the viewer asked for — on a built-in, their own choice for their account — and
 * the operational status is what the system does with it. A monitor the plan has stopped reads
 * "Paused — plan limit" with its reason as text, never beside a contradictory "Enabled"; a built-in
 * FactorSage paused for everyone reads "Paused by FactorSage" whatever the viewer chose. Otherwise
 * it is the viewer's switch, Enabled or Disabled. The collection shows the switch itself
 * (`MonitorEnabledControl`) with the same paused states under it, so the two cannot disagree.
 */
export function MonitorStateBadge({
  monitor,
  builtIn = false,
  showReason = false,
  size = "default",
}: {
  readonly monitor: OperationalState & {
    readonly enabled: boolean;
    readonly isGloballyEnabled?: boolean;
  };
  readonly builtIn?: boolean;
  /** Adds the short reason under a paused state — for a collection row, where there is room. */
  readonly showReason?: boolean;
  /** `small` in a compact table, where the pill should not set the row's height. */
  readonly size?: "default" | "small";
}) {
  if (!builtIn && monitor.enabled && isBlockedByEntitlement(monitor)) {
    return (
      <span className={styles.state}>
        <StatusBadge
          tone="blocked"
          size={size}
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
  if (builtIn && monitor.isGloballyEnabled === false) {
    return (
      <StatusBadge
        tone="pending"
        size={size}
        testId="monitor-state-pill"
        dataAttributes={{ "data-state": "PAUSED_GLOBALLY" }}
      >
        Paused by FactorSage
      </StatusBadge>
    );
  }
  return (
    <StatusBadge
      tone={monitor.enabled ? "positive" : "pending"}
      size={size}
      testId="monitor-state-pill"
      dataAttributes={{
        "data-state": monitor.enabled ? "ENABLED" : "DISABLED",
      }}
    >
      {monitor.enabled ? "Enabled" : "Disabled"}
    </StatusBadge>
  );
}
