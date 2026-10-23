"use client";

import type { MonitorSummaryResponse } from "@intrinsic/contracts";
import { useRef, useState } from "react";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { Switch } from "../../../components/ui/Switch";
import { requestFailureMessage } from "../../../lib/api/entitlement-errors";
import type { SignInGate } from "../../auth/hooks/use-sign-in-prompt";
import { updateMonitor } from "../api/monitors-api";
import {
  blockedShortReason,
  isBlockedByEntitlement,
} from "../utils/blocked-status";
import { synchronizationNote } from "../utils/synchronization";
import styles from "./MonitorsPage.module.css";

/**
 * The one Enabled / Disabled switch every monitor row has (`docs/decisions/monitor-eod-v2.md` §12,
 * `builtin-dashboard-signals-v1.md` §17b).
 *
 * The same control for a customer's own monitor and a built-in, through the same request
 * (`PATCH /monitors/:id { enabled }`): on one's own monitor it is the monitor's lifecycle, on a
 * built-in it is this viewer's own choice — whether its activity reaches their Dashboard — while the
 * shared built-in keeps being evaluated for everyone. A Guest has nowhere to store a choice, so the
 * switch is shown and asks for an account rather than pretending to save anything.
 *
 * The switch already says Enabled or Disabled, so nothing repeats it. Under it goes only what the
 * switch cannot say: a plan limit holding an enabled monitor back, FactorSage pausing a built-in for
 * everyone, or the monitor catching up on its activity window — so a monitor that is not evaluating
 * is never presented as if it were.
 *
 * The request is owned per row: a failure is reported on the monitor it belongs to, the switch
 * holds its state until the server answers, and one in-flight change cannot freeze another row.
 */
export function MonitorEnabledControl({
  monitor,
  gate,
  onChanged,
}: {
  readonly monitor: MonitorSummaryResponse;
  readonly gate: SignInGate;
  readonly onChanged: (summary: MonitorSummaryResponse) => void;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A ref, not state: a second press before the re-render must not start a second request.
  const inFlight = useRef(false);
  const builtIn = monitor.ownership === "SYSTEM";

  const toggle = (next: boolean) =>
    gate.attempt(
      {
        title: "Sign in to choose your monitors",
        body: "Which monitors are enabled for you is saved to your account. Sign in or create a free account to keep your choice.",
      },
      () => void save(next),
    );

  async function save(next: boolean) {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setPending(true);
    setFailure(null);
    try {
      onChanged(await updateMonitor(monitor.id, { enabled: next }));
    } catch (error) {
      // Enabling one monitor too many is a plan limit, not a failed save: the API's own message
      // names the limit and the count.
      setFailure(
        requestFailureMessage(
          error,
          `That change did not save. ${monitor.name} is still ${
            monitor.enabled ? "enabled" : "disabled"
          }.`,
        ),
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const blocked =
    !builtIn && monitor.enabled && isBlockedByEntitlement(monitor);
  const pausedForEveryone =
    builtIn && monitor.enabled && monitor.isGloballyEnabled === false;
  const sync = synchronizationNote(monitor);

  return (
    <span
      className={styles.enabledCell}
      data-testid="monitor-enabled-control"
      data-enabled={monitor.enabled ? "true" : "false"}
    >
      <span className={styles.enabledLine}>
        <Switch
          checked={monitor.enabled}
          label={`${monitor.name}: ${monitor.enabled ? "enabled" : "disabled"}`}
          pending={pending}
          onChange={toggle}
          testId="monitor-enabled-switch"
        />
        <span className={styles.enabledText} aria-hidden="true">
          {pending
            ? monitor.enabled
              ? "Disabling…"
              : "Enabling…"
            : monitor.enabled
              ? "Enabled"
              : "Disabled"}
        </span>
      </span>
      {blocked ? (
        <span className={styles.stateNote}>
          <StatusBadge
            tone="blocked"
            size="small"
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
          <span
            className={styles.stateReason}
            data-testid="monitor-state-reason"
          >
            {blockedShortReason(monitor.blockedReason)}
          </span>
        </span>
      ) : null}
      {pausedForEveryone ? (
        <span className={styles.stateNote}>
          <StatusBadge
            tone="pending"
            size="small"
            testId="monitor-state-pill"
            dataAttributes={{ "data-state": "PAUSED_GLOBALLY" }}
          >
            Paused by FactorSage
          </StatusBadge>
        </span>
      ) : null}
      {sync ? (
        <span
          className={styles.stateNote}
          data-testid="monitor-synchronization"
          data-state={sync.state}
        >
          <StatusBadge
            tone={sync.state === "SYNCHRONIZING" ? "active" : "warning"}
            size="small"
          >
            {sync.label}
          </StatusBadge>
          <span className={styles.stateReason}>{sync.detail}</span>
        </span>
      ) : null}
      {failure ? (
        <span
          className={styles.rowError}
          role="alert"
          data-testid="monitor-toggle-error"
        >
          {failure}
        </span>
      ) : null}
    </span>
  );
}
