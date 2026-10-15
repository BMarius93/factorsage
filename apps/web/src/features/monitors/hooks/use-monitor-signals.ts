"use client";

import type {
  MonitorLevelKind,
  MonitorSignalRowResponse,
  MonitorSignalRowState,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMonitorSignals } from "../api/monitors-api";

export type SignalTableStatus = "loading" | "ready" | "error";

/** Rows per page of the Monitor's Signal table. */
export const SIGNAL_TABLE_PAGE_SIZE = 25;

export type SignalTableFilters = {
  /** Absent: active occurrences, then resolved ones. */
  readonly state?: MonitorSignalRowState;
  readonly levelKind?: MonitorLevelKind;
};

export type MonitorSignalTableState = {
  readonly status: SignalTableStatus;
  readonly rows: readonly MonitorSignalRowResponse[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loadMore: () => void;
  readonly reload: () => void;
};

/** The Monitor's one Signal table (`docs/decisions/monitor-eod-v2.md` §6), one page at a time. */
export function useMonitorSignals(
  monitorId: string,
  filters: SignalTableFilters,
): MonitorSignalTableState {
  const [status, setStatus] = useState<SignalTableStatus>("loading");
  const [rows, setRows] = useState<MonitorSignalRowResponse[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);
  const { state, levelKind } = filters;

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const request = ++latest.current;
    const controller = new AbortController();
    setStatus("loading");
    fetchMonitorSignals(
      monitorId,
      {
        ...(state ? { state } : {}),
        ...(levelKind ? { levelKind } : {}),
        limit: SIGNAL_TABLE_PAGE_SIZE,
      },
      { signal: controller.signal },
    )
      .then((page) => {
        if (request !== latest.current) return;
        setRows(page.rows);
        setCursor(page.nextCursor);
        setStatus("ready");
      })
      .catch(() => {
        if (request !== latest.current || controller.signal.aborted) return;
        setStatus("error");
      });
    return () => controller.abort();
  }, [monitorId, state, levelKind, attempt]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    const request = latest.current;
    setLoadingMore(true);
    fetchMonitorSignals(monitorId, {
      ...(state ? { state } : {}),
      ...(levelKind ? { levelKind } : {}),
      limit: SIGNAL_TABLE_PAGE_SIZE,
      cursor,
    })
      .then((page) => {
        if (request !== latest.current) return;
        setRows((current) => [...current, ...page.rows]);
        setCursor(page.nextCursor);
      })
      .catch(() => undefined)
      .finally(() => setLoadingMore(false));
  }, [cursor, loadingMore, monitorId, state, levelKind]);

  return {
    status,
    rows,
    hasMore: cursor !== undefined,
    loadingMore,
    loadMore,
    reload,
  };
}
