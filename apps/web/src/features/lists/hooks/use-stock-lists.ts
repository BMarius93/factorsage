"use client";

import type {
  StockListDetailResponse,
  StockListSummaryResponse,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchStockLists } from "../api/stock-lists-api";

export type StockListsStatus = "loading" | "ready" | "error";

export type StockListsState = {
  readonly status: StockListsStatus;
  readonly lists: readonly StockListSummaryResponse[];
  readonly retry: () => void;
  /** Local state updates after successful mutations, so the page never refetches blindly. */
  readonly applyCreated: (detail: StockListDetailResponse) => void;
  readonly applyUpdated: (summary: StockListSummaryResponse) => void;
  readonly applyDeleted: (listId: string) => void;
};

/** The summary shape `GET /lists` would report for a freshly created list. */
export function summaryOf(
  detail: StockListDetailResponse,
): StockListSummaryResponse {
  return {
    id: detail.id,
    name: detail.name,
    ...(detail.description === undefined
      ? {}
      : { description: detail.description }),
    itemCount: detail.items.length,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };
}

/** Loads the signed-in user's lists once and keeps them in sync with local mutations. */
export function useStockLists(): StockListsState {
  const [status, setStatus] = useState<StockListsStatus>("loading");
  const [lists, setLists] = useState<readonly StockListSummaryResponse[]>([]);
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    setStatus("loading");
    const controller = new AbortController();

    fetchStockLists({ signal: controller.signal })
      .then((result) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setLists(result);
        setStatus("ready");
      })
      .catch(() => {
        if (requestId !== latestRequestRef.current || controller.signal.aborted) {
          return;
        }
        setStatus("error");
      });

    return () => controller.abort();
  }, [attempt]);

  const applyCreated = useCallback((detail: StockListDetailResponse) => {
    // The API lists newest first.
    setLists((current) => [summaryOf(detail), ...current]);
  }, []);

  const applyUpdated = useCallback((summary: StockListSummaryResponse) => {
    setLists((current) =>
      current.map((entry) => (entry.id === summary.id ? summary : entry)),
    );
  }, []);

  const applyDeleted = useCallback((listId: string) => {
    setLists((current) => current.filter((entry) => entry.id !== listId));
  }, []);

  return { status, lists, retry, applyCreated, applyUpdated, applyDeleted };
}
