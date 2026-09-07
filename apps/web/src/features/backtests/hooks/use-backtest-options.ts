"use client";

import type {
  BenchmarkResponse,
  StockListSummaryResponse,
  StrategySummaryResponse,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchStockLists } from "../../lists/api/stock-lists-api";
import { fetchStrategies } from "../../strategies/api/strategies-api";
import { fetchBenchmarks } from "../api/backtests-api";

export type BacktestOptionsStatus = "loading" | "ready" | "error";

export type BacktestOptionsState = {
  readonly status: BacktestOptionsStatus;
  readonly strategies: readonly StrategySummaryResponse[];
  readonly lists: readonly StockListSummaryResponse[];
  readonly benchmarks: readonly BenchmarkResponse[];
  readonly retry: () => void;
};

/**
 * Everything a submission has to choose between.
 *
 * All three collections come from the canonical endpoints that own them — the form never keeps a
 * local benchmark list, and never re-implements the strategy or stock-list fetch that those
 * features already own. The three load together because a partially populated form cannot be
 * submitted anyway.
 */
export function useBacktestOptions(): BacktestOptionsState {
  const [status, setStatus] = useState<BacktestOptionsStatus>("loading");
  const [strategies, setStrategies] = useState<
    readonly StrategySummaryResponse[]
  >([]);
  const [lists, setLists] = useState<readonly StockListSummaryResponse[]>([]);
  const [benchmarks, setBenchmarks] = useState<readonly BenchmarkResponse[]>(
    [],
  );
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    setStatus("loading");
    const controller = new AbortController();
    const options = { signal: controller.signal };

    Promise.all([
      fetchStrategies(options),
      fetchStockLists(options),
      fetchBenchmarks(options),
    ])
      .then(([loadedStrategies, loadedLists, loadedBenchmarks]) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setStrategies(loadedStrategies);
        setLists(loadedLists);
        setBenchmarks(loadedBenchmarks);
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

  return { status, strategies, lists, benchmarks, retry };
}
