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

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    setStatus("loading");
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

  const applyCreated = useCallback((detail: MonitorDetailResponse) => {
    // The API orders by `updatedAt` descending, so a new monitor belongs at the front.
    setMonitors((current) => [summaryOf(detail), ...current]);
  }, []);

  const applyUpdated = useCallback((summary: MonitorSummaryResponse) => {
    setMonitors((current) =>
      current.map((entry) => (entry.id === summary.id ? summary : entry)),
    );
  }, []);

  const applyDeleted = useCallback((monitorId: string) => {
    setMonitors((current) => current.filter((entry) => entry.id !== monitorId));
  }, []);

  return {
    status,
    monitors,
    retry,
    applyCreated,
    applyUpdated,
    applyDeleted,
  };
}
