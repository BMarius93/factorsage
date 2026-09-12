"use client";

import type {
  StockListSummaryResponse,
  StrategySummaryResponse,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchStockLists } from "../../lists/api/stock-lists-api";
import { fetchStrategies } from "../../strategies/api/strategies-api";

export type MonitorOptionsStatus = "loading" | "ready" | "error";

export type MonitorOptionsState = {
  readonly status: MonitorOptionsStatus;
  readonly strategies: readonly StrategySummaryResponse[];
  readonly lists: readonly StockListSummaryResponse[];
  readonly retry: () => void;
};

/**
 * The two things a monitor is made of.
 *
 * Both come from the canonical endpoints that own them, so this never keeps a second strategy or
 * stock-list fetch — and both are scoped to the authenticated caller by the API, which is what
 * makes the pickers show only the user's own rows. The browser's copy is convenience, never the
 * authority: `POST /monitors` re-checks both references against the caller before inserting.
 *
 * They load together in one round trip pair because a monitor cannot be created from half of them.
 */
export function useMonitorOptions(): MonitorOptionsState {
  const [status, setStatus] = useState<MonitorOptionsStatus>("loading");
  const [strategies, setStrategies] = useState<
    readonly StrategySummaryResponse[]
  >([]);
  const [lists, setLists] = useState<readonly StockListSummaryResponse[]>([]);
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    setStatus("loading");
    const controller = new AbortController();
    const options = { signal: controller.signal };

    Promise.all([fetchStrategies(options), fetchStockLists(options)])
      .then(([loadedStrategies, loadedLists]) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setStrategies(loadedStrategies);
        setLists(loadedLists);
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

  return { status, strategies, lists, retry };
}
