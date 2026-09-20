"use client";

import {
  isTerminalBacktestStatus,
  type BacktestRunSummaryResponse,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBacktestRuns } from "../api/backtests-api";

export type BacktestRunsStatus = "loading" | "ready" | "error";

export type BacktestRunsState = {
  readonly status: BacktestRunsStatus;
  readonly runs: readonly BacktestRunSummaryResponse[];
  readonly retry: () => void;
};

/**
 * How often the collection re-reads while a run is still queued or executing (UI-048). Coarser than
 * a run's own page, which polls its progress about once a second: a collection row only needs to
 * move from "Running 42%" to its result without a reload.
 */
export const BACKTEST_COLLECTION_POLL_INTERVAL_MS = 5_000;

/**
 * Loads the signed-in user's backtest runs, and keeps re-reading them **only while** one of them is
 * still queued or running. Once every run is terminal the polling stops, and it is cleaned up on
 * unmount; a run's own page owns fine-grained live progress.
 */
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

  const inFlight = runs.some((run) => !isTerminalBacktestStatus(run.status));

  useEffect(() => {
    if (status !== "ready" || !inFlight) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const requestId = ++latestRequestRef.current;
      // A background refresh: the rows already on screen stay until the new ones arrive, and a
      // failed refresh keeps them rather than replacing the page with an error.
      fetchBacktestRuns({ signal: controller.signal })
        .then((result) => {
          if (requestId === latestRequestRef.current) {
            setRuns(result);
          }
        })
        .catch(() => undefined);
    }, BACKTEST_COLLECTION_POLL_INTERVAL_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [status, inFlight, runs]);

  return { status, runs, retry };
}
