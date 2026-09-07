"use client";

import type {
  StrategyDetailResponse,
  StrategySummaryResponse,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchStrategies } from "../api/strategies-api";

export type StrategiesStatus = "loading" | "ready" | "error";

export type StrategiesState = {
  readonly status: StrategiesStatus;
  readonly strategies: readonly StrategySummaryResponse[];
  readonly retry: () => void;
  /** Local state updates after successful mutations, so the page never refetches blindly. */
  readonly applyUpdated: (summary: StrategySummaryResponse) => void;
  readonly applyDeleted: (strategyId: string) => void;
};

/** The summary shape `GET /strategies` would report for a freshly saved strategy. */
export function summaryOf(
  detail: StrategyDetailResponse,
): StrategySummaryResponse {
  return {
    id: detail.id,
    name: detail.name,
    ...(detail.description === undefined
      ? {}
      : { description: detail.description }),
    buyLevelCount: detail.buyLevelCount,
    sellLevelCount: detail.sellLevelCount,
    hasFinalExit: detail.hasFinalExit,
    versionNumber: detail.versionNumber,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };
}

/** Loads the signed-in user's strategies once and keeps them in sync with local mutations. */
export function useStrategies(): StrategiesState {
  const [status, setStatus] = useState<StrategiesStatus>("loading");
  const [strategies, setStrategies] = useState<
    readonly StrategySummaryResponse[]
  >([]);
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    setStatus("loading");
    const controller = new AbortController();

    fetchStrategies({ signal: controller.signal })
      .then((result) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setStrategies(result);
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

  const applyUpdated = useCallback((summary: StrategySummaryResponse) => {
    setStrategies((current) =>
      current.map((entry) => (entry.id === summary.id ? summary : entry)),
    );
  }, []);

  const applyDeleted = useCallback((strategyId: string) => {
    setStrategies((current) =>
      current.filter((entry) => entry.id !== strategyId),
    );
  }, []);

  return { status, strategies, retry, applyUpdated, applyDeleted };
}
