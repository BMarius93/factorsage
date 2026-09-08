"use client";

import {
  BACKTEST_PENDING_POLL_INTERVAL_MS,
  BACKTEST_RUNNING_POLL_INTERVAL_MS,
  isTerminalBacktestStatus,
  type BacktestFailureResponse,
  type BacktestLiveSnapshotResponse,
  type BacktestProgressResponse,
  type BacktestRunDetailResponse,
  type BacktestRunStatus,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../../lib/api/client";
import { fetchBacktestProgress, fetchBacktestRun } from "../api/backtests-api";

/**
 * `not-found` is a product state, not an error: a run belonging to another user answers exactly
 * like a missing one, and neither deserves a retry button that can never work.
 */
export type BacktestRunLoadStatus = "loading" | "ready" | "not-found" | "error";

export type BacktestRunState = {
  readonly loadStatus: BacktestRunLoadStatus;
  /** The immutable configuration, and the durable result once the run is finished. */
  readonly run: BacktestRunDetailResponse | null;
  /** The newest checkpoint applied, or null until the first poll answers. */
  readonly progress: BacktestProgressResponse | null;
  /** Effective lifecycle state: a checkpoint is newer than the detail it was fetched with. */
  readonly status: BacktestRunStatus | null;
  readonly percent: number;
  readonly message: string | null;
  readonly live: BacktestLiveSnapshotResponse | null;
  readonly failure: BacktestFailureResponse | null;
  /** True while the page is still asking for checkpoints. */
  readonly polling: boolean;
  readonly retry: () => void;
};

/**
 * A running simulation checkpoints every few simulated days, so about one request a second keeps
 * the chart visibly growing; queued and preparing states change slowly and are polled lazily.
 */
function pollIntervalFor(status: BacktestRunStatus): number {
  return status === "RUNNING" || status === "FINALIZING"
    ? BACKTEST_RUNNING_POLL_INTERVAL_MS
    : BACKTEST_PENDING_POLL_INTERVAL_MS;
}

/**
 * Follows one backtest run: the configuration once, then live checkpoints until it is terminal.
 *
 * Plain polling by product decision — no WebSocket, no SSE. Three properties make that safe:
 *
 * - requests never overlap, because the next tick is scheduled only after the previous one
 *   settles;
 * - a response that lost a race is dropped, because `sequence` is monotonic per run and a
 *   terminal run never reopens;
 * - a transient failure is invisible: the rendered page stays exactly as it is and the next tick
 *   retries, because a backtest that is minutes long must not blank out over one lost request.
 */
export function useBacktestRun(runId: string): BacktestRunState {
  const [loadStatus, setLoadStatus] =
    useState<BacktestRunLoadStatus>("loading");
  const [run, setRun] = useState<BacktestRunDetailResponse | null>(null);
  const [progress, setProgress] = useState<BacktestProgressResponse | null>(
    null,
  );
  const [polling, setPolling] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The highest checkpoint already applied. `sequence` is monotonic per run, so a lower one is
    // by definition a response that answered after a newer one and must not overwrite it.
    let appliedSequence = -1;
    // The lifecycle state the applied checkpoint reported; it decides the next tick's cadence.
    let appliedStatus: BacktestRunStatus = "QUEUED";
    // A completed or failed run is final. Once one is applied nothing may reopen it, including an
    // in-flight non-terminal response that resolves afterwards.
    let terminal = false;

    const superseded = () =>
      requestId !== latestRequestRef.current || controller.signal.aborted;

    const schedule = () => {
      if (superseded() || terminal) {
        return;
      }
      timer = setTimeout(() => {
        void poll();
      }, pollIntervalFor(appliedStatus));
    };

    /**
     * The run reached a terminal state. Polling stops and the detail is refetched exactly once, so
     * the durable result renders in place without the user reloading the page.
     */
    const settle = async () => {
      terminal = true;
      setPolling(false);
      try {
        const detail = await fetchBacktestRun(runId, {
          signal: controller.signal,
        });
        if (superseded()) {
          return;
        }
        setRun(detail);
      } catch {
        // The terminal checkpoint already carries the outcome; the page keeps what it has.
      }
    };

    const poll = async () => {
      let payload: BacktestProgressResponse;
      try {
        payload = await fetchBacktestProgress(runId, {
          signal: controller.signal,
        });
      } catch {
        if (!superseded()) {
          schedule();
        }
        return;
      }
      if (superseded() || terminal) {
        return;
      }

      if (payload.sequence >= appliedSequence) {
        appliedSequence = payload.sequence;
        appliedStatus = payload.status;
        setProgress(payload);
      }

      if (isTerminalBacktestStatus(appliedStatus)) {
        void settle();
        return;
      }
      schedule();
    };

    setLoadStatus("loading");
    fetchBacktestRun(runId, { signal: controller.signal })
      .then((detail) => {
        if (superseded()) {
          return;
        }
        setRun(detail);
        setLoadStatus("ready");
        // Persisted progress is what a page reloaded mid-run resumes from: the detail already
        // carries the last checkpoint's percent, message and live snapshot.
        appliedSequence = detail.progress.sequence;
        appliedStatus = detail.status;
        if (isTerminalBacktestStatus(detail.status)) {
          terminal = true;
          return;
        }
        setPolling(true);
        schedule();
      })
      .catch((error: unknown) => {
        if (superseded()) {
          return;
        }
        setLoadStatus(
          error instanceof ApiError && error.status === 404
            ? "not-found"
            : "error",
        );
      });

    return () => {
      controller.abort();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [runId, attempt]);

  const status = progress?.status ?? run?.status ?? null;
  // The newest checkpoint wins as a whole rather than field by field: a checkpoint that clears the
  // worker's message must not leave the one the detail was fetched with on screen.
  const checkpoint = progress ?? run?.progress ?? null;

  return {
    loadStatus,
    run,
    progress,
    status,
    percent: checkpoint?.percent ?? 0,
    message: checkpoint?.message ?? null,
    // Once a poll has answered, its live snapshot is the only one that counts — including when it
    // is deliberately null, which is exactly what a terminal payload sends. Falling through to the
    // detail's `live` would resurrect the snapshot the page happened to load with and render it as
    // a finished run's result for one poll interval.
    live: progress ? progress.live : (run?.live ?? null),
    failure: progress?.failure ?? run?.failure ?? null,
    polling,
    retry,
  };
}
