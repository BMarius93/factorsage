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
import {
  fetchMonitorActivity,
  type ActivityReader,
} from "../api/dashboard-api";
import { rangeArrivals, rangeChanged, replaceRange } from "../utils/activity";

export type ActivityStatus = CursorFeedStatus;

/** How many events the Dashboard opens with, and how many each older page adds. */
export const ACTIVITY_PAGE_SIZE = 25;

/**
 * How many older pages load on their own as the reader scrolls, per visit and per filter. After
 * them the feed waits for **Show more activity**: an endless page would put the footer, and the
 * disclosure in it, out of reach.
 */
export const ACTIVITY_AUTO_LOAD_PAGES = 4;

/**
 * The most reads one refresh makes to re-read the range a reader holds (200 events each). A reader
 * holding more than that is offered the newest page instead.
 */
export const ACTIVITY_REFRESH_READS = 10;

/**
 * What arrived since the reader last went to the newest activity: events placed above everything
 * that was shown, events written late for a session already shown, and whether the range held was too
 * long to re-read in one refresh (`backlog`), when only a fresh read of the newest page shows it.
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
  /** The Dashboard's timer calls this: it re-reads everything shown and places what is new. */
  readonly refresh: () => void;
  /** Arrivals not yet acknowledged; `null` when there are none. */
  readonly arrivals: ActivityArrivals | null;
  /** The reader has gone to the newest activity: the arrivals are no longer news. */
  readonly acknowledge: () => void;
  /** The last look for new activity failed; the next one tries again. */
  readonly refreshFailed: boolean;
};

type Options = {
  /**
   * Called synchronously just before a refresh changes what is shown, while the page still shows the
   * old list: where a scroll anchor is captured.
   */
  readonly onBeforeMerge?: () => void;
  /**
   * Where the events are read from: the Dashboard's feed by default, or one Monitor's own history
   * (`fetchMonitorHistory`). The same pages, cursors and `through` re-reads either way.
   */
  readonly read?: ActivityReader;
  /** Names the source when `read` is given, so another source starts the feed over. */
  readonly source?: string;
};

/**
 * The Dashboard's Monitor Activity feed (`docs/decisions/monitor-eod-v2.md` §6), one page at a time.
 *
 * Pages come from `useCursorFeed`: one request at a time, de-duplicated by id, stale answers dropped
 * and failures shown. Choosing another Monitor or another kind of event starts over. Both filters
 * travel to the API on every read, so every page, cursor and refresh is of the filtered feed.
 *
 * **A refresh re-reads what the reader holds (DB-2).** On the Dashboard's timer the feed re-reads
 * the range from the newest event down to the oldest one loaded (`through`) and puts that read in
 * its place: new events appear above, an event written late for a session the reader already passed
 * appears inside that session, and older pages stay open — nothing is lost and nothing is paused.
 * The range is read by key, so an event is found whenever it was committed; no clock or commit order
 * is relied on. The page keeps the reader's place while rows are added above it (`onBeforeMerge`),
 * and the arrivals are counted until the reader goes to the newest activity.
 */
export function useMonitorActivity(
  monitorId: string | null,
  kind: MonitorActivityKind | null = null,
  { onBeforeMerge, read = fetchMonitorActivity, source }: Options = {},
): MonitorActivityState {
  const filters = {
    ...(monitorId ? { monitorId } : {}),
    ...(kind ? { kind } : {}),
  };
  const key = JSON.stringify([source ?? null, monitorId, kind]);
  const feed = useCursorFeed<DashboardActivityEventResponse>({
    key,
    fetchPage: (cursor, signal) =>
      read(
        {
          ...filters,
          limit: ACTIVITY_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        },
        { signal },
      ).then((page) => ({
        items: page.events,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      })),
    getId: (event) => event.id,
  });

  const [arrivals, setArrivals] = useState<ActivityArrivals | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  // Bumped whenever the feed starts over, so a look that began before it changes nothing after.
  const epoch = useRef(0);
  const looking = useRef(false);
  const latest = useRef({ feed, filters, onBeforeMerge, read });
  useEffect(() => {
    latest.current = { feed, filters, onBeforeMerge, read };
  });

  // The newest page again — after a reload or another filter — is the reader's new starting point:
  // nothing before it is news.
  useEffect(() => {
    epoch.current += 1;
    setArrivals(null);
    setRefreshFailed(false);
  }, [feed.restarts, key]);

  const refresh = useCallback(() => {
    const { feed: shown, filters: asked, read: reader } = latest.current;
    if (looking.current || shown.status !== "ready") return;
    const bottom = shown.items[shown.items.length - 1];
    if (!bottom) {
      // Nothing held yet: the newest page is the whole range.
      shown.reload();
      return;
    }
    looking.current = true;
    const started = epoch.current;
    void (async () => {
      try {
        const range: DashboardActivityEventResponse[] = [];
        let cursor: string | undefined;
        let windowStart: string | undefined;
        for (let read = 0; read < ACTIVITY_REFRESH_READS; read += 1) {
          const page = await reader({
            ...asked,
            through: bottom.id,
            ...(cursor ? { cursor } : {}),
          });
          if (started !== epoch.current) return;
          range.push(...page.events);
          windowStart = page.windowStart ?? windowStart;
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        setRefreshFailed(false);
        if (cursor) {
          // More than one refresh can re-read: the reader takes the newest page when they choose to.
          setArrivals((current) => ({
            above: current?.above ?? 0,
            within: current?.within ?? 0,
            backlog: true,
          }));
          return;
        }
        const current = latest.current;
        // The rolling window moved past the oldest event held: what the reader holds is now every
        // event the window still has, and the ones older than its first day leave the feed.
        const agedOut =
          windowStart !== undefined && bottom.sessionDate < windowStart;
        if (!agedOut && !range.some((event) => event.id === bottom.id)) {
          // What ended the range is no longer in this feed (its Monitor was hidden): start over.
          current.feed.reload();
          return;
        }
        if (!agedOut && !rangeChanged(current.feed.items, range, bottom.id)) {
          return;
        }
        const counted = rangeArrivals(current.feed.items, range);
        current.onBeforeMerge?.();
        current.feed.update((items) =>
          agedOut ? [...range] : replaceRange(items, range, bottom.id),
        );
        if (counted.above + counted.within > 0) {
          setArrivals((previous) => ({
            above: (previous?.above ?? 0) + counted.above,
            within: (previous?.within ?? 0) + counted.within,
            backlog: previous?.backlog ?? false,
          }));
        }
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
