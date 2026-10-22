"use client";

import type { BacktestShareResponse } from "@intrinsic/contracts";
import { useCallback, useEffect, useState } from "react";
import {
  enableBacktestShare,
  fetchBacktestShare,
  revokeBacktestShare,
} from "../api/backtests-api";

export type BacktestShareState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly share: BacktestShareResponse }
  | { readonly status: "error" };

export type BacktestShareControls = {
  readonly state: BacktestShareState;
  /** Creates the run's public link, or returns the one it already has. Rejects on failure. */
  readonly enable: () => Promise<void>;
  /** Stops sharing. Rejects on failure, leaving the link as it was. */
  readonly revoke: () => Promise<void>;
  readonly retry: () => void;
};

const NOT_SHARED: BacktestShareResponse = {
  shared: false,
  url: null,
  sharedAt: null,
};

/**
 * The owner's view of one run's public link (`docs/decisions/backtest-sharing-v1.md`).
 *
 * Read once, and only for a run that can be shared — a completed one — so the result page makes no
 * request about sharing while a run is still executing. Every answer comes from the API: the page
 * never assumes a link exists, or has stopped existing, before the server says so.
 */
export function useBacktestShare(
  runId: string,
  enabled: boolean,
): BacktestShareControls {
  const [state, setState] = useState<BacktestShareState>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchBacktestShare(runId, { signal: controller.signal })
      .then((share) => setState({ status: "ready", share }))
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ status: "error" });
        }
      });
    return () => controller.abort();
  }, [runId, enabled, attempt]);

  const enable = useCallback(async () => {
    const share = await enableBacktestShare(runId);
    setState({ status: "ready", share });
  }, [runId]);

  const revoke = useCallback(async () => {
    await revokeBacktestShare(runId);
    setState({ status: "ready", share: NOT_SHARED });
  }, [runId]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { state, enable, revoke, retry };
}
