"use client";

import type {
  MonitorDetailResponse,
  MonitorSummaryResponse,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMonitors } from "../api/monitors-api";

export type MonitorsStatus = "loading" | "ready" | "error";

export type MonitorsState = {
  readonly status: MonitorsStatus;
  readonly monitors: readonly MonitorSummaryResponse[];
  readonly retry: () => void;
  /** Local state updates after successful mutations, so the page never refetches blindly. */
  readonly applyCreated: (detail: MonitorDetailResponse) => void;
  readonly applyUpdated: (summary: MonitorSummaryResponse) => void;
  readonly applyDeleted: (monitorId: string) => void;
};

/**
 * The summary shape `GET /monitors` would report for a freshly created monitor.
 *
 * A detail response already *is* a summary plus its Signals, so every field is carried across
 * rather than recomputed — the universe size and the active-Signal count are the API's, never a
 * browser-side tally.
 */
export function summaryOf(
  detail: MonitorDetailResponse,
): MonitorSummaryResponse {
  return {
    id: detail.id,
    name: detail.name,
    enabled: detail.enabled,
    strategyId: detail.strategyId,
    strategyName: detail.strategyName,
    stockListId: detail.stockListId,
    stockListName: detail.stockListName,
    securityCount: detail.securityCount,
    activeSignalCount: detail.activeSignalCount,
    ...(detail.lastScanAt === undefined
      ? {}
      : { lastScanAt: detail.lastScanAt }),
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    // Derived server-side from the owner's entitlements and their whole Monitor set. The browser
    // cannot recompute it — the active-capacity rule is positional across every Monitor the user
    // has — so it is carried across like every other field.
    operationalStatus: detail.operationalStatus,
    ...(detail.blockedReason === undefined
      ? {}
      : { blockedReason: detail.blockedReason }),
  };
}

/** Loads the signed-in user's monitors once and keeps them in sync with local mutations. */
export function useMonitors(): MonitorsState {
  const [status, setStatus] = useState<MonitorsStatus>("loading");
  const [monitors, setMonitors] = useState<readonly MonitorSummaryResponse[]>(
    [],
  );
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  const reload = retry;

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    // Only the first load blanks the page. A refresh after a mutation keeps the collection on
    // screen and swaps it when the answer arrives — otherwise toggling one monitor would flash
    // every card away, which is worse than the stale status it exists to fix.
    setStatus((current) => (current === "ready" ? current : "loading"));
    const controller = new AbortController();

    fetchMonitors({ signal: controller.signal })
      .then((result) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setMonitors(result);
        setStatus("ready");
      })
      .catch(() => {
        if (
          requestId !== latestRequestRef.current ||
          controller.signal.aborted
        ) {
          return;
        }
        setStatus("error");
      });

    return () => controller.abort();
  }, [attempt]);

  /**
   * Re-reads the whole collection.
   *
   * A monitor's `operationalStatus` is **not** a property of that monitor alone: the plan's active
   * slots go to the first `N` enabled monitors in a fixed order, so enabling, disabling, creating
   * or deleting one changes whether *others* are scanning. Patching only the row that was mutated
   * would leave every sibling showing a status the server no longer holds — a monitor reading
   * "Not scanning" when it had just taken over the freed slot.
   *
   * The single mutated row is still applied first, so the control the user touched responds
   * immediately rather than waiting for the round trip.
   */
  const applyCreated = useCallback(
    (detail: MonitorDetailResponse) => {
      // The API orders by `updatedAt` descending, so a new monitor belongs at the front.
      setMonitors((current) => [summaryOf(detail), ...current]);
      reload();
    },
    [reload],
  );

  const applyUpdated = useCallback(
    (summary: MonitorSummaryResponse) => {
      setMonitors((current) =>
        current.map((entry) => (entry.id === summary.id ? summary : entry)),
      );
      reload();
    },
    [reload],
  );

  const applyDeleted = useCallback(
    (monitorId: string) => {
      setMonitors((current) =>
        current.filter((entry) => entry.id !== monitorId),
      );
      reload();
    },
    [reload],
  );

  return {
    status,
    monitors,
    retry,
    applyCreated,
    applyUpdated,
    applyDeleted,
  };
}
