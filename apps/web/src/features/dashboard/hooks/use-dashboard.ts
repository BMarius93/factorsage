"use client";

import type {
  BacktestRunSummaryResponse,
  MonitorSummaryResponse,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBacktestRuns } from "../../backtests/api/backtests-api";
import { fetchMonitors } from "../../monitors/api/monitors-api";

export type DashboardStatus = "loading" | "ready" | "error";

export type DashboardState = {
  readonly status: DashboardStatus;
  readonly monitors: readonly MonitorSummaryResponse[];
  readonly runs: readonly BacktestRunSummaryResponse[];
  readonly retry: () => void;
};

/**
 * Everything the dashboard renders, in exactly two requests.
 *
 * Deliberately the two *collection* endpoints and nothing else. The home page wants the stocks
 * currently matching across every monitor, and V2 has no aggregate read model for that — only
 * `GET /monitors/{id}`, which carries one monitor's evaluated securities. Fanning that out would
 * make opening the application cost one request per monitor and grow with the user's account, so
 * the dashboard shows what the collections truthfully answer and links into each monitor for the
 * per-stock detail. The missing endpoint is recorded in `ai/architecture/frontend.md`.
 */
export function useDashboard(): DashboardState {
  const [status, setStatus] = useState<DashboardStatus>("loading");
  const [monitors, setMonitors] = useState<readonly MonitorSummaryResponse[]>(
    [],
  );
  const [runs, setRuns] = useState<readonly BacktestRunSummaryResponse[]>([]);
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    const controller = new AbortController();
    setStatus((current) => (current === "ready" ? current : "loading"));

    Promise.all([
      fetchMonitors({ signal: controller.signal }),
      fetchBacktestRuns({ signal: controller.signal }),
    ])
      .then(([monitorResult, runResult]) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setMonitors(monitorResult);
        setRuns(runResult);
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

  return { status, monitors, runs, retry };
}
