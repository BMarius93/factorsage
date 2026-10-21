"use client";

import {
  isTerminalBacktestStatus,
  type BacktestRunSummaryResponse,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchActiveBacktestRuns } from "../api/backtests-api";

export type BacktestRunsStatus = "loading" | "ready" | "error";

export type BacktestRunsState = {
  readonly status: BacktestRunsStatus;
  /** The runs still queued or executing, newest first. */
  readonly runs: readonly BacktestRunSummaryResponse[];
  readonly retry: () => void;
};

/**
 * How often a view re-reads runs while one of them is still queued or executing (UI-048). Coarser
 * than a run's own page, which polls its progress about once a second: a row only needs to move
 * from "Running 42%" to its result without a reload.
 */
export const BACKTEST_COLLECTION_POLL_INTERVAL_MS = 5_000;

/**
 * The signed-in user's runs that hold a concurrency slot — queued or executing — for the New
 * backtest form, which shows the plan's limit before anything is submitted (UI-020).
 *
 * It reads only those runs (`GET /backtests?status=ACTIVE`), never the history, and re-reads them
 * **only while** there are some, so a slot that frees while the form is open is noticed. Once none
 * is in flight the polling stops; it is cleaned up on unmount.
 */
export function useActiveBacktestRuns(): BacktestRunsState {
  const [status, setStatus] = useState<BacktestRunsStatus>("loading");
  const [runs, setRuns] = useState<readonly BacktestRunSummaryResponse[]>([]);
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    setStatus("loading");
    const controller = new AbortController();

    fetchActiveBacktestRuns({ signal: controller.signal })
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
      // A background refresh: what is shown stays until the new answer arrives, and a failed
      // refresh keeps it rather than replacing the form's notice with an error.
      fetchActiveBacktestRuns({ signal: controller.signal })
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
