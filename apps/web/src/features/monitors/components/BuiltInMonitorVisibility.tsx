"use client";

import type { MonitorSummaryResponse } from "@intrinsic/contracts";
import { useState } from "react";
import { Switch } from "../../../components/ui/Switch";
import { requestFailureMessage } from "../../../lib/api/entitlement-errors";
import type { SignInGate } from "../../auth/hooks/use-sign-in-prompt";
import { setBuiltInMonitorVisibility } from "../api/monitors-api";
import styles from "./MonitorsPage.module.css";

/**
 * Whether a built-in monitor's signals appear on **this** viewer's dashboard.
 *
 * Deliberately not the same control as a customer monitor's `enabled`, which is that monitor's real
 * lifecycle. This is one row in `UserBuiltInMonitorPreference`
 * (`docs/decisions/builtin-dashboard-signals-v1.md` section 5.2): the shared `SYSTEM` monitor keeps
 * being evaluated for everyone whatever this says, and the operator's `isPublished` /
 * `isGloballyEnabled` switches are a third, separate thing that only an administrator touches.
 *
 * A Guest has nowhere to store a preference, so the control is shown — it is how the feature is
 * discovered — and asks for an account rather than pretending to save anything.
 *
 * The request is owned per row so a failure is reported on the monitor it belongs to, and one
 * in-flight change cannot freeze every other row.
 */
export function BuiltInMonitorVisibility({
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
  // Absence of a stored preference is the built-in default, which is "shown".
  const visible = monitor.dashboardVisible !== false;

  const toggle = (next: boolean) =>
    gate.attempt(
      {
        title: "Sign in to choose your dashboard monitors",
        body: "Which built-in monitors appear on your dashboard is saved to your account. Sign in or create a free account to keep your choice.",
      },
      () => void save(next),
    );

  async function save(next: boolean) {
    if (pending) {
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      await setBuiltInMonitorVisibility(monitor.id, { visible: next });
      onChanged({ ...monitor, dashboardVisible: next });
    } catch (error) {
      setFailure(
        requestFailureMessage(
          error,
          `That change did not save. ${monitor.name} is still ${
            visible ? "shown on" : "hidden from"
          } your dashboard.`,
        ),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <span className={styles.visibilityCell}>
      <Switch
        checked={visible}
        label={`Show ${monitor.name} on my dashboard`}
        pending={pending}
        onChange={toggle}
        testId="built-in-monitor-toggle"
      />
      {failure ? (
        <span
          className={styles.rowError}
          role="alert"
          data-testid="monitor-visibility-error"
        >
          {failure}
        </span>
      ) : null}
    </span>
  );
}
