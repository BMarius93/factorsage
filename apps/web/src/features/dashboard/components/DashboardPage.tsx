"use client";

import {
  MONITOR_ACTIVITY_KINDS,
  type DashboardMonitorResponse,
  type MonitorActivityKind,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "../../../components/ui/EmptyState";
import { SelectControl } from "../../../components/ui/SelectControl";
import { SkeletonList } from "../../../components/ui/Skeleton";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import forms from "../../../components/ui/forms.module.css";
import { useMediaQuery } from "../../../lib/use-media-query";
import { useNow } from "../../../lib/use-now";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { signInHref } from "../../auth/utils/guest-routes";
import { DisclosureNote } from "../../legal/components/DisclosureNote";
import {
  MarketWatch,
  MarketWatchBoundary,
} from "../../market/components/MarketWatch";
import { DASHBOARD_REFRESH_MS, useDashboard } from "../hooks/use-dashboard";
import {
  type NewActivity,
  useMonitorActivity,
} from "../hooks/use-monitor-activity";
import { ACTIVITY_KIND_FILTER_LABELS } from "../utils/activity";
import { FRESHNESS_TONES, freshnessLabel } from "../utils/format";
import { ActivityFeed } from "./ActivityFeed";
import styles from "./DashboardPage.module.css";

const ALL_MONITORS = "ALL";
const ALL_EVENTS = "ALL";

const EVENT_FILTER_OPTIONS = [
  { value: ALL_EVENTS, label: "All events" },
  ...MONITOR_ACTIVITY_KINDS.map((kind) => ({
    value: kind,
    label: ACTIVITY_KIND_FILTER_LABELS[kind],
  })),
];

/**
 * Where Market watch exists at all: a wide desktop. The same query as the two-pane grid in
 * `DashboardPage.module.css`, which reserves the sidebar's track before Market watch mounts.
 */
export const MARKET_WATCH_MEDIA_QUERY = "(min-width: 1280px)";

function isActivityKind(value: string): value is MonitorActivityKind {
  return (MONITOR_ACTIVITY_KINDS as readonly string[]).includes(value);
}

/**
 * The application home, at `/`: Monitor activity, with Market watch beside it on a wide desktop
 * (`docs/decisions/monitor-eod-v2.md` §7, `docs/decisions/etf-market-overview-v1.md` §6).
 *
 * **Layout.** One page in two panes, not two cards. From 1,280px the feed takes the width that is
 * left and Market watch is a fixed-width sidebar flush against the right edge, from just under the
 * topbar to the bottom of the screen, divided from the feed by one hairline. The feed scrolls with
 * the page; the sidebar stays where it is and scrolls its own list. Below 1,280px there is no
 * sidebar at all: Market watch is **not mounted**, so it neither renders, fetches nor starts its
 * timer, and the feed takes the whole width. The sidebar's track is reserved in CSS at the same
 * query, so the feed does not move when Market watch appears after hydration.
 *
 * **The feed** lists what the Monitors the viewer can see **observed** after each market close — a
 * stock becoming a match, or a match ending because its conditions stopped holding — grouped under
 * the session it happened on, newest first, each with every condition that decided it. History a
 * new Monitor replayed, edits, removals and a trigger day passing are not activity; they live on
 * each Monitor's own page. Two filters narrow it — one Monitor, one kind of event — and both are
 * applied by the API, so every page, the "new events" count and "Show older activity" are of the
 * narrowed feed. A Guest sees the published built-in Monitors; a signed-in user sees those they
 * have not hidden, plus their own enabled ones. Nothing is described as live: every row is a
 * finalized end-of-day session.
 */
export function DashboardPage() {
  const { status, dashboard, reload } = useDashboard();
  const { state: session } = useAuthSession();
  const [monitorFilter, setMonitorFilter] = useState<string>(ALL_MONITORS);
  const [eventFilter, setEventFilter] = useState<string>(ALL_EVENTS);

  const monitors = dashboard?.monitors ?? [];
  const shownMonitors = monitors.filter((monitor) => monitor.visible);
  // A Monitor that is no longer shown (hidden elsewhere since) is not a filter that can match:
  // the feed falls back to every Monitor rather than to an empty page that cannot explain itself.
  const monitorId =
    monitorFilter !== ALL_MONITORS &&
    shownMonitors.some((monitor) => monitor.id === monitorFilter)
      ? monitorFilter
      : null;
  const kind = isActivityKind(eventFilter) ? eventFilter : null;
  const filtered = monitorId !== null || kind !== null;

  const activity = useMonitorActivity(monitorId, kind);
  // One clock for the page, ticking while it stays open, so "Updated 12 min ago" stays true.
  const now = useNow(30_000);
  // False on the server and through hydration, then the real answer: Market watch mounts after
  // hydration on a wide desktop and never below it.
  const wide = useMediaQuery(MARKET_WATCH_MEDIA_QUERY);

  // The feed re-reads its newest page on the Dashboard's slow timer, so a session evaluated while
  // the page is open shows up — unless the reader has opened older activity, in which case the
  // timer only reports what is new and the list waits for them (DB-2).
  const refreshActivity = activity.refresh;
  useEffect(() => {
    const timer = setInterval(refreshActivity, DASHBOARD_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshActivity]);

  // Asking for the newest activity replaces the expanded list and removes the button that asked,
  // so focus and the view move to the top of the refreshed feed rather than being lost.
  const returnToNewest = useRef(false);
  useEffect(() => {
    if (!returnToNewest.current || activity.paused) return;
    returnToNewest.current = false;
    const heading = document.getElementById("activity-title");
    if (heading && heading.getBoundingClientRect().top < 0) {
      heading.scrollIntoView({ block: "start" });
    }
    document
      .querySelector<HTMLElement>(
        '[data-testid="dashboard-activity"] tbody a[href]',
      )
      ?.focus({ preventScroll: true });
  }, [activity.paused, activity.events]);

  const guest =
    dashboard?.viewer === "GUEST" || session.status === "unauthenticated";
  const loading = status === "loading" || activity.status === "loading";
  const failed = status === "error" || activity.status === "error";
  const events = activity.events;
  const clearFilters = () => {
    setMonitorFilter(ALL_MONITORS);
    setEventFilter(ALL_EVENTS);
  };

  return (
    <div className={styles.page} data-testid="dashboard-page">
      <h1 className={styles.srOnly}>Dashboard</h1>

      <div className={styles.layout} data-testid="dashboard-layout">
        <div className={styles.main} data-testid="dashboard-main">
          {guest && status === "ready" ? (
            <div
              className={styles.guestNotice}
              data-testid="dashboard-guest-notice"
            >
              <p>
                A <b>Monitor</b> watches a <b>List</b> using a <b>Strategy</b>.
                You&apos;re viewing FactorSage&apos;s built-in monitors. Sign in
                to choose which ones appear here, create your own, and backtest
                any of them.
              </p>
              <Link className={forms.tintedButton} href={signInHref()}>
                Sign in
              </Link>
            </div>
          ) : null}

          <section
            id="activity"
            className={styles.activity}
            aria-labelledby="activity-title"
            data-testid="dashboard-activity-section"
          >
            <header className={styles.activityHeader}>
              <div className={styles.heading}>
                <h2 id="activity-title" className={styles.title}>
                  Monitor activity
                </h2>
                {dashboard ? (
                  <OverallFreshness monitors={shownMonitors} now={now} />
                ) : null}
              </div>
              {dashboard && shownMonitors.length > 0 ? (
                <div className={styles.filters} data-testid="dashboard-filters">
                  <SelectControl
                    id="dashboard-monitor-filter"
                    label="Monitor"
                    value={monitorId ?? ALL_MONITORS}
                    onChange={setMonitorFilter}
                    options={[
                      { value: ALL_MONITORS, label: "All monitors" },
                      ...shownMonitors.map((monitor) => ({
                        value: monitor.id,
                        label: monitor.name,
                      })),
                    ]}
                    testId="dashboard-monitor-filter"
                  />
                  <SelectControl
                    id="dashboard-event-filter"
                    label="Event"
                    value={kind ?? ALL_EVENTS}
                    onChange={setEventFilter}
                    options={EVENT_FILTER_OPTIONS}
                    testId="dashboard-event-filter"
                  />
                </div>
              ) : null}
            </header>

            {loading && !failed ? (
              <div
                className={styles.state}
                aria-label="Loading monitor activity"
                data-testid="dashboard-activity-loading"
              >
                <SkeletonList rows={6} />
              </div>
            ) : null}

            {failed ? (
              <div className={styles.state}>
                <EmptyState
                  variant="error"
                  title="Monitor activity could not be loaded"
                  body={
                    <p>This is usually temporary — try again in a moment.</p>
                  }
                  actions={
                    <button
                      type="button"
                      className={forms.secondaryButton}
                      onClick={() => {
                        reload();
                        activity.reload();
                      }}
                    >
                      Try again
                    </button>
                  }
                />
              </div>
            ) : null}

            {!loading && !failed && dashboard ? (
              <>
                {events.length === 0 ? (
                  <div className={styles.state}>
                    {filtered ? (
                      <EmptyState
                        variant="compact"
                        testId="dashboard-activity-empty"
                        title="No matching activity"
                        body={
                          <p>
                            Nothing in the activity history matches these
                            filters.
                          </p>
                        }
                        actions={
                          <button
                            type="button"
                            className={forms.secondaryButton}
                            onClick={clearFilters}
                            data-testid="dashboard-clear-filters"
                          >
                            Clear filters
                          </button>
                        }
                      />
                    ) : (
                      <EmptyState
                        variant="compact"
                        testId="dashboard-activity-empty"
                        title={
                          shownMonitors.length === 0
                            ? "No monitors are shown"
                            : "No activity yet"
                        }
                        body={
                          <p>
                            {shownMonitors.length === 0
                              ? "Turn a monitor back on from the Monitors page to see its activity here."
                              : "When a monitor sees a stock start or stop matching at a market close, it appears here. Each monitor's own page shows its full history."}
                          </p>
                        }
                        actions={
                          shownMonitors.length === 0 ? (
                            <Link
                              className={forms.secondaryButton}
                              href="/monitors"
                            >
                              Go to monitors
                            </Link>
                          ) : undefined
                        }
                      />
                    )}
                  </div>
                ) : (
                  <>
                    {activity.paused ? (
                      <div
                        className={styles.pausedBar}
                        data-testid="dashboard-activity-paused"
                      >
                        <p role="status" className={styles.pausedText}>
                          {newActivityLabel(activity.newActivity)}
                        </p>
                        <button
                          type="button"
                          className={forms.tintedButton}
                          data-testid="dashboard-activity-show-newest"
                          onClick={() => {
                            returnToNewest.current = true;
                            activity.reload();
                          }}
                        >
                          Show newest
                        </button>
                      </div>
                    ) : null}
                    <ActivityFeed events={events} />
                  </>
                )}
                {activity.hasMore ? (
                  <div className={styles.more}>
                    <button
                      type="button"
                      className={forms.secondaryButton}
                      onClick={activity.loadMore}
                      disabled={activity.loadingMore}
                      data-testid="dashboard-activity-more"
                    >
                      {activity.loadingMore
                        ? "Loading…"
                        : "Show older activity"}
                    </button>
                  </div>
                ) : null}
                <div className={styles.disclosure}>
                  <DisclosureNote id="signals" />
                </div>
              </>
            ) : null}
          </section>
        </div>

        {/* The market the activity happened in, on a wide desktop only. Its own request, its own
            timer and its own failure states: nothing in it can blank the feed. */}
        {wide ? (
          <aside
            className={styles.sidebar}
            aria-labelledby="market-watch-title"
            data-testid="dashboard-sidebar"
          >
            <MarketWatchBoundary>
              <MarketWatch />
            </MarketWatchBoundary>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What the paused feed says about activity that arrived since the reader opened older pages. A count
 * only when it is exact; otherwise that there is new activity, and nothing at all is never claimed.
 */
export function newActivityLabel(newActivity: NewActivity | null): string {
  if (newActivity === null) {
    return "Updates are paused while you read older activity.";
  }
  if (newActivity.count === null) {
    return "New events are available.";
  }
  return newActivity.count === 1
    ? "1 new event"
    : `${newActivity.count} new events`;
}

/**
 * How recently the Monitors shown were evaluated: the newest evaluation among them, and a warning
 * when any of them is stale. Never labelled live.
 */
function OverallFreshness({
  monitors,
  now,
}: {
  readonly monitors: readonly DashboardMonitorResponse[];
  readonly now: Date;
}) {
  const scanned = monitors
    .map((monitor) => monitor.lastScanAt)
    .filter((value): value is string => value !== undefined)
    .sort();
  const newest = scanned[scanned.length - 1];
  const stale = monitors.some((monitor) => monitor.freshness === "STALE");
  const freshness = stale ? "STALE" : newest ? "CURRENT" : "NOT_SCANNED";
  const label = freshnessLabel(freshness, newest, now);

  if (freshness === "CURRENT") {
    return (
      <span className={styles.freshness} data-testid="dashboard-freshness">
        {label}
      </span>
    );
  }

  return (
    <StatusBadge tone={FRESHNESS_TONES[freshness]} testId="dashboard-freshness">
      {label}
    </StatusBadge>
  );
}
