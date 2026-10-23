import {
  MONITOR_ACTIVITY_WINDOW_DAYS,
  type MonitorSummaryResponse,
} from "@intrinsic/contracts";
import { formatDay } from "../../../lib/dates";

/**
 * What the Monitors page says about a running monitor's evaluation of its activity window
 * (`docs/decisions/monitor-eod-v2.md` §12), in words — or nothing, when there is nothing to add.
 *
 * Only an enabled monitor that is evaluated has one: a disabled monitor, one paused by a plan limit
 * and a built-in paused by FactorSage are evaluating nothing (their own state says so), and a
 * synchronized monitor needs no note beside its switch. Never "live": every session is a finalized
 * close.
 */
export type SynchronizationNote = {
  readonly state: "SYNCHRONIZING" | "PARTIAL";
  readonly label: string;
  readonly detail: string;
};

export function synchronizationNote(
  monitor: Pick<MonitorSummaryResponse, "enabled" | "synchronization">,
): SynchronizationNote | null {
  const sync = monitor.synchronization;
  if (!monitor.enabled || !sync || sync.state === "SYNCHRONIZED") {
    return null;
  }
  if (sync.state === "SYNCHRONIZING") {
    return {
      state: "SYNCHRONIZING",
      label: "Synchronizing",
      detail: `Evaluating the last ${MONITOR_ACTIVITY_WINDOW_DAYS} days`,
    };
  }
  const parts: string[] = [];
  if (sync.awaitingMembers > 0) {
    parts.push(
      `${sync.awaitingMembers} of ${sync.currentMembers} ${
        sync.currentMembers === 1 ? "stock" : "stocks"
      } waiting for market data`,
    );
  }
  if (sync.historyFrom) {
    parts.push(`History recorded since ${formatDay(sync.historyFrom)}`);
  }
  return {
    state: "PARTIAL",
    label: "Partial history",
    detail:
      parts.join(" · ") ||
      `Not every stock covers the last ${MONITOR_ACTIVITY_WINDOW_DAYS} days`,
  };
}
