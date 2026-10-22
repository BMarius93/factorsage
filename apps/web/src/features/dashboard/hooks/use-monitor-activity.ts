"use client";

import type {
  DashboardActivityEventResponse,
  MonitorActivityKind,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMonitorActivity } from "../api/dashboard-api";

export type ActivityStatus = "loading" | "ready" | "error";

/** How many events the Dashboard opens with, and how many each "show older" adds. */
export const ACTIVITY_PAGE_SIZE = 15;

/**
 * Activity that arrived while the feed was paused.
 *
 * `count` is exact only when the newest event on screen still appears in the newest page: the
 * events above it are then precisely the new ones. When it does not (a full page or more arrived)
 * the number is unknown and is `null` — the feed says new activity exists without inventing how
 * much.
 */
export type NewActivity = { readonly count: number | null };

export type MonitorActivityState = {
  readonly status: ActivityStatus;
  readonly events: readonly DashboardActivityEventResponse[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loadMore: () => void;
  /** Re-reads the newest page now, replacing whatever is loaded, and resumes automatic refresh. */
  readonly reload: () => void;
  /**
   * The Dashboard's timer calls this. It re-reads the newest page — unless older activity has been
   * loaded, in which case the list is left exactly as it is and only `newActivity` is updated.
   */
  readonly refresh: () => void;
  /** True while older pages are loaded and automatic replacement is paused (DB-2). */
  readonly paused: boolean;
  readonly newActivity: NewActivity | null;
};

/**
 * The Dashboard's Monitor Activity feed (`docs/decisions/monitor-eod-v2.md` §6), one page at a time.
 *
 * `reload` re-reads the first page — the newest sessions — and keeps what is on screen until it
 * answers; `loadMore` appends the next older page. Choosing another Monitor or another kind of event
 * starts over.
 *
 * Both filters travel to the API on every read — the first page, every older page and the paused
 * check for new events — so the server filters the whole history and every page, cursor and count
 * is of the filtered feed. Nothing is filtered in the browser, where only the loaded pages are.
 *
 * Reading older activity **pauses** the automatic refresh (DB-2). Replacing the list with its
 * newest page every minute used to throw away every older page the reader had opened, mid-read.
 * While paused, `refresh` only looks: it fetches the newest page and reports how many events are
 * new, and the list moves only when the reader asks for it with `reload`, which also resumes the
 * automatic refresh. New rows are never merged into the expanded list on their own.
 */
export function useMonitorActivity(
  monitorId: string | null,
  kind: MonitorActivityKind | null = null,
): MonitorActivityState {
  const [status, setStatus] = useState<ActivityStatus>("loading");
  const [events, setEvents] = useState<DashboardActivityEventResponse[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [paused, setPaused] = useState(false);
  const [newActivity, setNewActivity] = useState<NewActivity | null>(null);
  const latest = useRef(0);
  const hasContent = useRef(false);
  // Read by the timer's check without re-creating `refresh` whenever a page of events arrives.
  const newestShownRef = useRef<string | undefined>(undefined);
  const pausedRef = useRef(false);

  useEffect(() => {
    newestShownRef.current = events[0]?.id;
    pausedRef.current = paused;
  }, [events, paused]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    hasContent.current = false;
  }, [monitorId, kind]);

  useEffect(() => {
    const request = ++latest.current;
    const controller = new AbortController();
    if (!hasContent.current) {
      setStatus("loading");
    }
    fetchMonitorActivity(
      {
        ...(monitorId ? { monitorId } : {}),
        ...(kind ? { kind } : {}),
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
        // A fresh newest page is the normal, auto-refreshing state again.
        pausedRef.current = false;
        setPaused(false);
        setNewActivity(null);
      })
      .catch(() => {
        if (request !== latest.current || controller.signal.aborted) return;
        if (!hasContent.current) setStatus("error");
      });
    return () => controller.abort();
  }, [monitorId, kind, attempt]);

  const checkForNewActivity = useCallback(() => {
    const request = latest.current;
    fetchMonitorActivity({
      ...(monitorId ? { monitorId } : {}),
      ...(kind ? { kind } : {}),
      limit: ACTIVITY_PAGE_SIZE,
    })
      .then((page) => {
        // A reload or a different filter since the check started makes its answer stale.
        if (request !== latest.current || !pausedRef.current) return;
        const newest = newestShownRef.current;
        const position =
          newest === undefined
            ? -1
            : page.events.findIndex((event) => event.id === newest);
        if (position === 0) {
          setNewActivity(null);
          return;
        }
        setNewActivity({ count: position > 0 ? position : null });
      })
      // A failed look changes nothing: the list on screen is still true.
      .catch(() => undefined);
  }, [monitorId, kind]);

  const refresh = useCallback(() => {
    if (pausedRef.current) {
      checkForNewActivity();
    } else {
      reload();
    }
  }, [checkForNewActivity, reload]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    const request = latest.current;
    setLoadingMore(true);
    // From the first older page on, the reader is browsing history: stop replacing the list.
    pausedRef.current = true;
    setPaused(true);
    fetchMonitorActivity({
      ...(monitorId ? { monitorId } : {}),
      ...(kind ? { kind } : {}),
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
  }, [cursor, loadingMore, monitorId, kind]);

  return {
    status,
    events,
    hasMore: cursor !== undefined,
    loadingMore,
    loadMore,
    reload,
    refresh,
    paused,
    newActivity,
  };
}
