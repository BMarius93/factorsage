"use client";

import type { DashboardActivityEventResponse } from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMonitorActivity } from "../api/dashboard-api";

export type ActivityStatus = "loading" | "ready" | "error";

/** How many events the Dashboard opens with, and how many each "show older" adds. */
export const ACTIVITY_PAGE_SIZE = 15;

export type MonitorActivityState = {
  readonly status: ActivityStatus;
  readonly events: readonly DashboardActivityEventResponse[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loadMore: () => void;
  readonly reload: () => void;
};

/**
 * The Dashboard's Monitor Activity feed (`docs/decisions/monitor-eod-v2.md` §6), one page at a time.
 *
 * `reload` re-reads the first page — the newest sessions — and keeps what is on screen until it
 * answers; `loadMore` appends the next older page. Choosing another Monitor starts over.
 */
export function useMonitorActivity(
  monitorId: string | null,
): MonitorActivityState {
  const [status, setStatus] = useState<ActivityStatus>("loading");
  const [events, setEvents] = useState<DashboardActivityEventResponse[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);
  const hasContent = useRef(false);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    hasContent.current = false;
  }, [monitorId]);

  useEffect(() => {
    const request = ++latest.current;
    const controller = new AbortController();
    if (!hasContent.current) {
      setStatus("loading");
    }
    fetchMonitorActivity(
      {
        ...(monitorId ? { monitorId } : {}),
        limit: ACTIVITY_PAGE_SIZE,
      },
      { signal: controller.signal },
    )
      .then((page) => {
        if (request !== latest.current) return;
        hasContent.current = true;
        setEvents(page.events);
        setCursor(page.nextCursor);
        setStatus("ready");
      })
      .catch(() => {
        if (request !== latest.current || controller.signal.aborted) return;
        if (!hasContent.current) setStatus("error");
      });
    return () => controller.abort();
  }, [monitorId, attempt]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    const request = latest.current;
    setLoadingMore(true);
    fetchMonitorActivity({
      ...(monitorId ? { monitorId } : {}),
      limit: ACTIVITY_PAGE_SIZE,
      cursor,
    })
      .then((page) => {
        if (request !== latest.current) return;
        setEvents((current) => [...current, ...page.events]);
        setCursor(page.nextCursor);
      })
      .catch(() => undefined)
      .finally(() => setLoadingMore(false));
  }, [cursor, loadingMore, monitorId]);

  return {
    status,
    events,
    hasMore: cursor !== undefined,
    loadingMore,
    loadMore,
    reload,
  };
}
