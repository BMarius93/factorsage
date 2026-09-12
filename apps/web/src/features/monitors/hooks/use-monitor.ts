"use client";

import type { MonitorDetailResponse } from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../../lib/api/client";
import { fetchMonitor } from "../api/monitors-api";

export type MonitorStatus = "loading" | "ready" | "missing" | "error";

export type MonitorState = {
  readonly status: MonitorStatus;
  readonly monitor: MonitorDetailResponse | null;
  /** Re-reads the monitor from the API. */
  readonly reload: () => void;
};

/**
 * Loads one monitor with its evaluation table and Signals.
 *
 * A monitor that is not the caller's answers exactly like one that does not exist, so `missing` is
 * reported for a 404 rather than a generic failure — the page can then say the monitor is gone
 * instead of inviting a retry that will never succeed.
 *
 * `reload` re-reads rather than patching local state: an edit that rebinds the monitor changes the
 * whole evaluation table, so re-deriving it in the browser would be a second implementation of
 * what the API just decided.
 */
export function useMonitor(monitorId: string): MonitorState {
  const [status, setStatus] = useState<MonitorStatus>("loading");
  const [monitor, setMonitor] = useState<MonitorDetailResponse | null>(null);
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);
  const reload = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    setStatus("loading");
    const controller = new AbortController();

    fetchMonitor(monitorId, { signal: controller.signal })
      .then((result) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setMonitor(result);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (
          requestId !== latestRequestRef.current ||
          controller.signal.aborted
        ) {
          return;
        }
        setStatus(
          error instanceof ApiError && error.status === 404
            ? "missing"
            : "error",
        );
      });

    return () => controller.abort();
  }, [monitorId, attempt]);

  return { status, monitor, reload };
}
