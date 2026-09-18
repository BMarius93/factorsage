import type {
  MonitorBlockedReason,
  MonitorSummaryResponse,
} from "@intrinsic/contracts";
import { StatusBadge } from "../../../components/ui/StatusBadge";

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

/**
 * The effective scanning state beside the configured one.
 *
 * `enabled` is what the user asked for and never changes on its own; the operational status is
 * what the system will actually do with that intent right now. A monitor left over capacity by a
 * downgrade is still enabled, so the collection and the detail page both show this pill next to
 * "Enabled" rather than replacing it — one component, so the two surfaces cannot drift apart.
 */
export function MonitorBlockedPill({
  monitor,
}: {
  readonly monitor: OperationalState;
}) {
  if (!isBlockedByEntitlement(monitor)) {
    return null;
  }
  return (
    <StatusBadge
      tone="blocked"
      testId="monitor-blocked-pill"
      title={blockedExplanation(monitor.blockedReason)}
      {...(monitor.blockedReason
        ? {
            dataAttributes: {
              "data-blocked-reason": monitor.blockedReason,
            },
          }
        : {})}
    >
      Not scanning
    </StatusBadge>
  );
}
