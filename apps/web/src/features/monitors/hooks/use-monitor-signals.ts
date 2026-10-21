"use client";

import type {
  MonitorLevelKind,
  MonitorSignalRowResponse,
  MonitorSignalRowState,
  MonitorSignalTableCounts,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../../lib/api/client";
import {
  useCursorFeed,
  type CursorFeedStatus,
} from "../../../lib/use-cursor-feed";
import { fetchMonitorSignals } from "../api/monitors-api";

export type SignalTableStatus = CursorFeedStatus;

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
  /** How many rows each group holds under the level filter, from the first page. */
  readonly counts: MonitorSignalTableCounts | undefined;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  /** The last "Show more signals" failed; `loadMore` tries it again. */
  readonly loadMoreFailed: boolean;
  /**
   * The table changed while the reader was paging (a session was evaluated) and was read again from
   * its first page, rather than continued with rows from two different states.
   */
  readonly restarted: boolean;
  readonly loadMore: () => void;
  readonly reload: () => void;
};

/**
 * The Monitor's one Signal table (`docs/decisions/monitor-eod-v2.md` §6.2), one page at a time.
 *
 * Pages come from `useCursorFeed` — one request at a time, de-duplicated by id, a page of other
 * filters never appended, a failed page shown and retried. The API pages one consistent table: when
 * an evaluation changes it between two pages, the next page answers 409, and the table starts over
 * from its first page with a note, so no occurrence is shown twice (active, then ended) or skipped.
 */
export function useMonitorSignals(
  monitorId: string,
  filters: SignalTableFilters,
): MonitorSignalTableState {
  const { state, levelKind } = filters;
  const key = JSON.stringify([monitorId, state ?? null, levelKind ?? null]);
  const [restarted, setRestarted] = useState(false);
  const restart = useRef<() => void>(() => undefined);

  const feed = useCursorFeed<
    MonitorSignalRowResponse,
    MonitorSignalTableCounts | undefined
  >({
    key,
    fetchPage: (cursor, signal) =>
      fetchMonitorSignals(
        monitorId,
        {
          ...(state ? { state } : {}),
          ...(levelKind ? { levelKind } : {}),
          limit: SIGNAL_TABLE_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        },
        { signal },
      ).then(
        (page) => ({
          items: page.rows,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          meta: page.counts,
        }),
        (error: unknown) => {
          if (cursor && error instanceof ApiError && error.status === 409) {
            restart.current();
          }
          throw error;
        },
      ),
    getId: (row) => row.id,
  });

  const reload = feed.reload;
  useEffect(() => {
    restart.current = () => {
      setRestarted(true);
      reload();
    };
  }, [reload]);

  // Other filters are another table: the note belonged to the one the reader left.
  useEffect(() => {
    setRestarted(false);
  }, [key]);

  const reloadAndForget = useCallback(() => {
    setRestarted(false);
    reload();
  }, [reload]);

  return {
    status: feed.status,
    rows: feed.items,
    counts: feed.meta,
    hasMore: feed.hasMore,
    loadingMore: feed.loadingMore,
    loadMoreFailed: feed.loadMoreFailed,
    restarted,
    loadMore: feed.loadMore,
    reload: reloadAndForget,
  };
}
