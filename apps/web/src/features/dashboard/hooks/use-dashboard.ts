"use client";

import type { DashboardResponse } from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDashboard } from "../api/dashboard-api";

export type DashboardStatus = "loading" | "ready" | "error";

export type DashboardState = {
  readonly status: DashboardStatus;
  readonly dashboard: DashboardResponse | null;
  /** Re-reads the Dashboard; the current content stays on screen meanwhile. */
  readonly reload: () => void;
};

/** How often an open Dashboard re-reads itself. The scan cadence is minutes, not seconds. */
export const DASHBOARD_REFRESH_MS = 60_000;

/**
 * The Dashboard read model, from its one endpoint.
 *
 * The server joins monitors, lifecycle state, Signals and Strategy descriptions into one response,
 * so the page never fans out per monitor. An open page re-reads it on a slow timer so a scan that
 * lands while it is open shows up; a failed background refresh keeps what is on screen.
 */
export function useDashboard(): DashboardState {
  const [status, setStatus] = useState<DashboardStatus>("loading");
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);
  const hasContentRef = useRef(false);

  const reload = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    const controller = new AbortController();
    if (!hasContentRef.current) {
      setStatus("loading");
    }
    fetchDashboard({ signal: controller.signal })
      .then((loaded) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        hasContentRef.current = true;
        setDashboard(loaded);
        setStatus("ready");
      })
      .catch(() => {
        if (
          requestId !== latestRequestRef.current ||
          controller.signal.aborted
        ) {
          return;
        }
        if (!hasContentRef.current) {
          setStatus("error");
        }
      });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    const timer = setInterval(reload, DASHBOARD_REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  return { status, dashboard, reload };
}
