"use client";

import type { StrategyDetailResponse } from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../../lib/api/client";
import { fetchStrategy } from "../api/strategies-api";

/**
 * `not-found` is a product state, not an error: a deleted strategy, or one belonging to another
 * user, answers 404 and deserves its own surface rather than a retry button that can never work.
 */
export type StrategyStatus = "loading" | "ready" | "not-found" | "error";

export type StrategyState = {
  readonly status: StrategyStatus;
  readonly strategy: StrategyDetailResponse | null;
  readonly retry: () => void;
};

/** Loads one strategy, mirroring `use-stock-list`'s treatment of 404. */
export function useStrategy(strategyId: string): StrategyState {
  const [status, setStatus] = useState<StrategyStatus>("loading");
  const [strategy, setStrategy] = useState<StrategyDetailResponse | null>(null);
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    setStatus("loading");
    const controller = new AbortController();

    fetchStrategy(strategyId, { signal: controller.signal })
      .then((result) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setStrategy(result);
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
            ? "not-found"
            : "error",
        );
      });

    return () => controller.abort();
  }, [strategyId, attempt]);

  return { status, strategy, retry };
}
