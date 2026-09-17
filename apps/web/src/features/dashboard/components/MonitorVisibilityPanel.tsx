"use client";

import type { DashboardMonitorResponse } from "@intrinsic/contracts";
import Link from "next/link";
import { useState } from "react";
import { EntityReferenceChip } from "../../../components/ui/EntityReference";
import { SectionCard } from "../../../components/ui/SectionCard";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { Switch } from "../../../components/ui/Switch";
import { requestFailureMessage } from "../../../lib/api/entitlement-errors";
import { SignInPrompt } from "../../auth/components/SignInPrompt";
import { updateMonitor } from "../../monitors/api/monitors-api";
import { setBuiltInMonitorVisibility } from "../api/dashboard-api";
import { FRESHNESS_TONES, freshnessLabel } from "../utils/format";
import styles from "./MonitorVisibilityPanel.module.css";

type MonitorVisibilityPanelProps = {
  readonly monitors: readonly DashboardMonitorResponse[];
  readonly guest: boolean;
  readonly now: Date;
  /** Called after a change was saved, so the page re-reads the Dashboard. */
  readonly onChanged: () => void;
};

/**
 * Which monitors feed the Dashboard, with a switch for each.
 *
 * Two different switches share one control, and the API response says which one each is: a
 * built-in's switch is this user's own visibility preference and never touches the shared
 * monitor; a customer's own monitor switch is its real `enabled` lifecycle. A Guest has nowhere to
 * store a preference, so the switch asks them to sign in instead.
 */
export function MonitorVisibilityPanel({
  monitors,
  guest,
  now,
  onChanged,
}: MonitorVisibilityPanelProps) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(
    null,
  );
  const [promptOpen, setPromptOpen] = useState(false);

  async function toggle(monitor: DashboardMonitorResponse, next: boolean) {
    if (guest) {
      setPromptOpen(true);
      return;
    }
    setPending(monitor.id);
    setError(null);
    try {
      if (monitor.control === "BUILT_IN_PREFERENCE") {
        await setBuiltInMonitorVisibility(monitor.id, { visible: next });
      } else {
        await updateMonitor(monitor.id, { enabled: next });
      }
      onChanged();
    } catch (caught) {
      setError({
        id: monitor.id,
        message: requestFailureMessage(
          caught,
          "The change could not be saved. Try again.",
        ),
      });
    } finally {
      setPending(null);
    }
  }

  return (
    <SectionCard
      id="dashboard-monitors"
      title="Monitors"
      caption={
        guest
          ? "The built-in monitors every visitor sees."
          : "Choose which monitors appear on your dashboard. Hiding a built-in monitor only changes your view."
      }
      aside={
        guest ? null : (
          <Link className={styles.manageLink} href="/monitors">
            Manage your monitors
          </Link>
        )
      }
    >
      <ul className={styles.grid} data-testid="dashboard-monitors">
        {monitors.map((monitor) => (
          <li
            key={monitor.id}
            className={styles.card}
            data-testid="dashboard-monitor"
            data-visible={monitor.visible ? "true" : "false"}
          >
            <div className={styles.header}>
              <div className={styles.identity}>
                <Link className={styles.name} href={`/monitors/${monitor.id}`}>
                  {monitor.name}
                </Link>
                {monitor.ownership === "SYSTEM" ? (
                  <StatusBadge tone="neutral" variant="outline">
                    Built-in
                  </StatusBadge>
                ) : null}
              </div>
              <Switch
                checked={monitor.visible}
                label={
                  monitor.control === "BUILT_IN_PREFERENCE"
                    ? `Show ${monitor.name} on my dashboard`
                    : `Enable ${monitor.name}`
                }
                pending={pending === monitor.id}
                onChange={(next) => void toggle(monitor, next)}
                testId="dashboard-monitor-toggle"
              />
            </div>
            <div className={styles.links}>
              <EntityReferenceChip
                kind="strategy"
                name={monitor.strategy.name}
                href={`/strategies/${monitor.strategy.id}`}
              />
              <EntityReferenceChip
                kind="list"
                name={monitor.stockList.name}
                href={`/lists/${monitor.stockList.id}`}
              />
            </div>
            <div className={styles.facts}>
              <span>
                <strong>{monitor.activeCount}</strong> active
              </span>
              <span>
                <strong>{monitor.pendingCount}</strong> waiting
              </span>
              <StatusBadge
                tone={FRESHNESS_TONES[monitor.freshness]}
                variant="outline"
                title={
                  monitor.lastScanAt
                    ? new Date(monitor.lastScanAt).toLocaleString()
                    : undefined
                }
                dataAttributes={{ "data-freshness": monitor.freshness }}
              >
                {freshnessLabel(monitor.freshness, monitor.lastScanAt, now)}
              </StatusBadge>
            </div>
            {error?.id === monitor.id ? (
              <p className={styles.error} role="alert">
                {error.message}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {promptOpen ? (
        <SignInPrompt
          title="Sign in to customise your dashboard"
          body="Choosing which monitors appear on your dashboard is saved to your account. Sign in or create a free account to keep your choice."
          onClose={() => setPromptOpen(false)}
        />
      ) : null}
    </SectionCard>
  );
}
