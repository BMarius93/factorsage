"use client";

import type {
  StockListDetailResponse,
  StockListItemResponse,
  StockListSummaryResponse,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../../lib/api/client";
import { fetchStockList } from "../api/stock-lists-api";

export type StockListStatus = "loading" | "ready" | "not-found" | "error";

export type StockListState = {
  readonly status: StockListStatus;
  readonly detail?: StockListDetailResponse;
  readonly retry: () => void;
  /** Replaces the whole detail, e.g. after a batch item add. */
  readonly applyDetail: (detail: StockListDetailResponse) => void;
  /** Replaces one item in place, e.g. after a buy-window save. */
  readonly applyItem: (item: StockListItemResponse) => void;
  readonly applyItemRemoved: (itemId: string) => void;
  /** Applies renamed metadata from the summary a PATCH returns. */
  readonly applyMeta: (summary: StockListSummaryResponse) => void;
};

/**
 * Loads one of the signed-in user's lists. A 404 is a product state — the list does not exist or
 * belongs to someone else, which the API deliberately reports identically.
 */
export function useStockList(listId: string): StockListState {
  const [status, setStatus] = useState<StockListStatus>("loading");
  const [detail, setDetail] = useState<StockListDetailResponse | undefined>();
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    setStatus("loading");
    setDetail(undefined);
    const controller = new AbortController();

    fetchStockList(listId, { signal: controller.signal })
      .then((result) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setDetail(result);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (requestId !== latestRequestRef.current || controller.signal.aborted) {
          return;
        }
        setStatus(
          error instanceof ApiError && error.status === 404
            ? "not-found"
            : "error",
        );
      });

    return () => controller.abort();
  }, [listId, attempt]);

  const applyDetail = useCallback((next: StockListDetailResponse) => {
    setDetail(next);
  }, []);

  const applyItem = useCallback((item: StockListItemResponse) => {
    setDetail((current) =>
      current
        ? {
            ...current,
            items: current.items.map((entry) =>
              entry.id === item.id ? item : entry,
            ),
          }
        : current,
    );
  }, []);

  const applyItemRemoved = useCallback((itemId: string) => {
    setDetail((current) =>
      current
        ? {
            ...current,
            items: current.items.filter((entry) => entry.id !== itemId),
          }
        : current,
    );
  }, []);

  const applyMeta = useCallback((summary: StockListSummaryResponse) => {
    setDetail((current) => {
      if (!current) {
        return current;
      }
      const next = {
        ...current,
        name: summary.name,
        updatedAt: summary.updatedAt,
        description: summary.description,
      };
      if (summary.description === undefined) {
        // A cleared description disappears rather than lingering as an undefined-valued key.
        delete next.description;
      }
      return next;
    });
  }, []);

  return {
    status,
    ...(detail ? { detail } : {}),
    retry,
    applyDetail,
    applyItem,
    applyItemRemoved,
    applyMeta,
  };
}
