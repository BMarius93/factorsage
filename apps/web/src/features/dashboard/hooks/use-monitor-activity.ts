"use client";

import type {
  DashboardActivityEventResponse,
  MonitorActivityKind,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useCursorFeed,
  type CursorFeedStatus,
} from "../../../lib/use-cursor-feed";
import { fetchMonitorActivity } from "../api/dashboard-api";
import { mergeArrivals } from "../utils/activity";

export type ActivityStatus = CursorFeedStatus;

/** How many events the Dashboard opens with, and how many each "show older" adds. */
export const ACTIVITY_PAGE_SIZE = 15;

/** The most `since` reads one refresh makes while a backlog remains, before asking the reader. */
export const ACTIVITY_CATCH_UP_READS = 5;

/**
 * What arrived since the reader last went to the newest activity: events placed above everything
 * that was shown, events written late for a session already shown, and whether more arrived than
 * one refresh could place (`backlog`), which only a fresh read of the newest page shows.
 */
export type ActivityArrivals = {
  readonly above: number;
  readonly within: number;
  readonly backlog: boolean;
};

export type MonitorActivityState = {
  readonly status: ActivityStatus;
  readonly events: readonly DashboardActivityEventResponse[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  /** The last "show older" failed; `loadMore` tries it again. */
  readonly loadMoreFailed: boolean;
  /** Older pages loaded since the feed last started from its newest page. */
  readonly olderPages: number;
  readonly loadMore: () => void;
  /** Re-reads the newest page now, replacing whatever is loaded. */
  readonly reload: () => void;
  /** The Dashboard's timer calls this: it places whatever was written since the last look. */
  readonly refresh: () => void;
  /** Arrivals not yet acknowledged; `null` when there are none. */
  readonly arrivals: ActivityArrivals | null;
  /** The reader has gone to the newest activity: the arrivals are no longer news. */
  readonly acknowledge: () => void;
  /** The last look for new activity failed; the next one tries again. */
  readonly refreshFailed: boolean;
};

type ActivityMeta = { readonly watermark?: string };

type Options = {
  /**
   * Called synchronously just before arrivals change what is shown, while the page still shows the
   * old list: where a scroll anchor is captured.
   */
  readonly onBeforeMerge?: () => void;
};

/**
 * The Dashboard's Monitor Activity feed (`docs/decisions/monitor-eod-v2.md` §6), one page at a time.
 *
 * Pages come from `useCursorFeed`: one request at a time, de-duplicated by id, stale answers dropped
 * and failures shown. Choosing another Monitor or another kind of event starts over. Both filters
 * travel to the API on every read, so every page, cursor and arrival is of the filtered feed.
 *
 * **Arrivals are merged, never lost (DB-2).** The newest page answers with a `watermark`, and the
 * Dashboard's timer asks what was written after it. Whatever comes back is placed where the feed's
 * order puts it — above what is shown when it is new, among the loaded sessions when it was written
 * late for an older one — so older pages the reader opened stay exactly where they are, nothing is
 * replaced mid-read, and an event written days late for a session the reader already passed still
 * appears. The page keeps the reader's place while rows are added above it (`onBeforeMerge`). The
 * arrivals are counted until the reader goes to the newest activity.
 */
export function useMonitorActivity(
  monitorId: string | null,
  kind: MonitorActivityKind | null = null,
  { onBeforeMerge }: Options = {},
): MonitorActivityState {
  const filters = {
    ...(monitorId ? { monitorId } : {}),
    ...(kind ? { kind } : {}),
  };
  const key = JSON.stringify([monitorId, kind]);
  const feed = useCursorFeed<DashboardActivityEventResponse, ActivityMeta>({
    key,
    fetchPage: (cursor, signal) =>
      fetchMonitorActivity(
        {
          ...filters,
          limit: ACTIVITY_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        },
        { signal },
      ).then((page) => ({
        items: page.events,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        meta: page.watermark ? { watermark: page.watermark } : {},
      })),
    getId: (event) => event.id,
  });

  const [arrivals, setArrivals] = useState<ActivityArrivals | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const watermark = useRef<string | undefined>(undefined);
  // Bumped whenever the feed starts over, so a look that began before it changes nothing after.
  const epoch = useRef(0);
  const looking = useRef(false);
  const latest = useRef({ feed, filters, onBeforeMerge });
  useEffect(() => {
    latest.current = { feed, filters, onBeforeMerge };
  });

  // A newest page restarts the reader's place in insertion order: nothing before it is news.
  useEffect(() => {
    epoch.current += 1;
    watermark.current = feed.meta?.watermark;
    setArrivals(null);
    setRefreshFailed(false);
  }, [feed.meta]);

  useEffect(() => {
    epoch.current += 1;
    watermark.current = undefined;
  }, [key]);

  const refresh = useCallback(() => {
    const since = watermark.current;
    if (since === undefined || looking.current) return;
    looking.current = true;
    const started = epoch.current;
    const { filters: asked } = latest.current;
    void (async () => {
      let from = since;
      try {
        for (let read = 0; read < ACTIVITY_CATCH_UP_READS; read += 1) {
          const page = await fetchMonitorActivity({ ...asked, since: from });
          if (started !== epoch.current) return;
          const { feed: shown, onBeforeMerge: beforeMerge } = latest.current;
          const complete = !shown.hasMore;
          const merge = mergeArrivals(shown.items, page.events, { complete });
          if (merge.above + merge.within > 0) {
            beforeMerge?.();
            shown.update(
              (items) => mergeArrivals(items, page.events, { complete }).events,
            );
            setArrivals((current) => ({
              above: (current?.above ?? 0) + merge.above,
              within: (current?.within ?? 0) + merge.within,
              backlog: current?.backlog ?? false,
            }));
          }
          const next = page.watermark ?? from;
          watermark.current = next;
          if (!page.truncated) {
            setRefreshFailed(false);
            return;
          }
          if (next === from) break;
          from = next;
        }
        // More arrived than this look could place: say so, and let the reader take the newest.
        setRefreshFailed(false);
        setArrivals((current) => ({
          above: current?.above ?? 0,
          within: current?.within ?? 0,
          backlog: true,
        }));
      } catch {
        if (started === epoch.current) setRefreshFailed(true);
      } finally {
        looking.current = false;
      }
    })();
  }, []);

  const acknowledge = useCallback(() => {
    setArrivals((current) => (current?.backlog ? current : null));
  }, []);

  return {
    status: feed.status,
    events: feed.items,
    hasMore: feed.hasMore,
    loadingMore: feed.loadingMore,
    loadMoreFailed: feed.loadMoreFailed,
    olderPages: feed.olderPages,
    loadMore: feed.loadMore,
    reload: feed.reload,
    refresh,
    arrivals,
    acknowledge,
    refreshFailed,
  };
}
