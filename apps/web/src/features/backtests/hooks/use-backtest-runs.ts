"use client";

import type { BacktestRunSummaryResponse } from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBacktestRuns } from "../api/backtests-api";

export type BacktestRunsStatus = "loading" | "ready" | "error";

export type BacktestRunsState = {
  readonly status: BacktestRunsStatus;
  readonly runs: readonly BacktestRunSummaryResponse[];
  readonly retry: () => void;
};

/** Loads the signed-in user's backtest runs once; a run's own page owns live progress. */
export function useBacktestRuns(): BacktestRunsState {
  const [status, setStatus] = useState<BacktestRunsStatus>("loading");
  const [runs, setRuns] = useState<readonly BacktestRunSummaryResponse[]>([]);
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    setStatus("loading");
    const controller = new AbortController();

    fetchBacktestRuns({ signal: controller.signal })
      .then((result) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setRuns(result);
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

  return { status, runs, retry };
}
