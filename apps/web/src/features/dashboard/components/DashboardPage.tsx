"use client";

import type {
  DashboardActivityEventResponse,
  DashboardMonitorResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import {
  CardLinks,
  DataTable,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import { EntityReferenceChip } from "../../../components/ui/EntityReference";
import { SectionCard } from "../../../components/ui/SectionCard";
import { DisclosureNote } from "../../legal/components/DisclosureNote";
import { SelectControl } from "../../../components/ui/SelectControl";
import { SkeletonList } from "../../../components/ui/Skeleton";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { StockIdentity } from "../../../components/ui/StockIdentity";
import { signInHref } from "../../auth/utils/guest-routes";
import forms from "../../../components/ui/forms.module.css";
import { formatDay } from "../../../lib/dates";
import { useMediaQuery } from "../../../lib/use-media-query";
import { useNow } from "../../../lib/use-now";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { MonitorWhy } from "../../monitors/components/MonitorWhy";
import {
  formatObservationPrice,
  levelPositionLabel,
  RESOLUTION_REASON_LABELS,
} from "../../monitors/utils/format";
import { stockDetailsHref } from "../../stocks/search/utils/stock-routes";
import {
  MarketWatch,
  MarketWatchBoundary,
} from "../../market/components/MarketWatch";
import { DASHBOARD_REFRESH_MS, useDashboard } from "../hooks/use-dashboard";
import {
  type NewActivity,
  useMonitorActivity,
} from "../hooks/use-monitor-activity";
import { FRESHNESS_TONES, freshnessLabel } from "../utils/format";
import { LEVEL_KIND_TONES } from "../../strategies/utils/format";
import styles from "./DashboardPage.module.css";

const ALL_MONITORS = "ALL";

/**
 * Where Market watch exists at all: a wide desktop. The same query as the two-column grid in
 * `DashboardPage.module.css`, which reserves the sidebar's column before Market watch mounts.
 */
export const MARKET_WATCH_MEDIA_QUERY = "(min-width: 1280px)";

/** `Activated`, or `Ended · conditions no longer hold`: what the event was, in the product's words. */
export function activityLabel(event: DashboardActivityEventResponse): string {
  if (event.kind === "ACTIVATED") {
    return "Activated";
  }
  const reason = RESOLUTION_REASON_LABELS[event.reason];
  return reason === "ended" ? "Ended" : `Ended · ${reason}`;
}

/** The session an event was decided on, as the Session column and the narrow table's fold show it. */
function SessionDate({
  event,
  testId,
}: {
  readonly event: DashboardActivityEventResponse;
  readonly testId: string;
}) {
  return (
    <span className={styles.since} data-testid={testId}>
      <time dateTime={event.sessionDate}>{formatDay(event.sessionDate)}</time>
      {event.observationBasis === "LIVE_QUOTE" ? (
        <span className={styles.basis}> · intraday quote</span>
      ) : null}
    </span>
  );
}

/** The Monitor that observed the event, under the small label a card or a folded cell gives it. */
function MonitorOrigin({
  event,
}: {
  readonly event: DashboardActivityEventResponse;
}) {
  return (
    <span className={styles.origin}>
      <span className={styles.originItem} data-primary="true">
        <span className={styles.originLabel}>Monitor</span>
        <EntityReferenceChip
          kind="monitor"
          name={event.monitor.name}
          href={`/monitors/${event.monitor.id}`}
        />
      </span>
    </span>
  );
}

/**
 * The Monitor at the foot of a phone card. The desktop table names it with its column header
 * instead.
 */
function CardMonitor({
  event,
}: {
  readonly event: DashboardActivityEventResponse;
}) {
  return (
    <CardLinks testId="dashboard-card-monitor">
      <MonitorOrigin event={event} />
    </CardLinks>
  );
}

/**
 * The Monitor under the reason, in the **narrow table** only: when the feed's own column is too
 * narrow for six columns — beside Market watch, or in the intermediate band — the Monitor and
 * Session columns step out, the session is shown under the signal and the Monitor's chip here
 * (`DashboardPage.module.css`, the `dashboard-main` container query). Only one place ever displays
 * each, so each is read once.
 */
function FoldedMonitor({
  event,
}: {
  readonly event: DashboardActivityEventResponse;
}) {
  return (
    <span
      className={styles.foldedMonitor}
      data-testid="dashboard-folded-monitor"
    >
      <MonitorOrigin event={event} />
    </span>
  );
}

/**
 * The feed's columns: Stock, what happened, the exchange session it happened on, why, the
 * activation price and the Monitor that observed it. Strategy and List are one click away from the
 * Monitor; the feed's job is to say what changed.
 */
const COLUMNS: readonly DataTableColumn<DashboardActivityEventResponse>[] = [
  {
    key: "stock",
    header: "Stock",
    cardRole: "identity",
    minWidth: "8.5rem",
    render: (event) => (
      <span className={styles.stockCell}>
        <StockIdentity
          symbol={event.security.symbol}
          name={event.security.name}
          {...(event.security.logoUrl
            ? { logoUrl: event.security.logoUrl }
            : {})}
          href={stockDetailsHref(event.security.symbol)}
          size="sm"
          testId="dashboard-stock"
        />
      </span>
    ),
  },
  {
    key: "signal",
    header: "Signal",
    cardRole: "status",
    nowrap: true,
    render: (event) => (
      <span className={styles.badges}>
        <StatusBadge
          tone={LEVEL_KIND_TONES[event.levelKind]}
          variant="outline"
          dataAttributes={{ "data-level": event.levelKind }}
        >
          {levelPositionLabel(event)}
        </StatusBadge>
        <StatusBadge
          tone={event.kind === "ACTIVATED" ? "positive" : "neutral"}
          dataAttributes={{ "data-kind": event.kind }}
        >
          {activityLabel(event)}
        </StatusBadge>
        {/* The session, under the signal it dated, in the narrow table only. */}
        <span className={styles.foldedSession}>
          <SessionDate event={event} testId="dashboard-folded-session" />
        </span>
      </span>
    ),
  },
  {
    // The exchange session the change was observed on — the end-of-day close it was decided at,
    // never the moment the evaluation ran.
    key: "session",
    header: "Session",
    cardRole: "summary",
    nowrap: true,
    render: (event) => <SessionDate event={event} testId="dashboard-session" />,
  },
  {
    key: "why",
    header: "Why",
    cardLabel: null,
    stacked: true,
    render: (event) => (
      <>
        <MonitorWhy why={event.why} testId="dashboard-why" />
        <FoldedMonitor event={event} />
        <CardMonitor event={event} />
      </>
    ),
  },
  {
    key: "price",
    header: "Price",
    cardRole: "summary",
    align: "right",
    numeric: true,
    nowrap: true,
    // The price it activated at, on the session it activated; an ending is explained by its Why.
    render: (event) =>
      event.kind === "ACTIVATED" && event.price !== undefined ? (
        formatObservationPrice(event.price)
      ) : (
        <span className={styles.placeholder}>—</span>
      ),
  },
  {
    key: "monitor",
    header: "Monitor",
    cardRole: "hidden",
    minWidth: "9.5rem",
    render: (event) => (
      <span className={styles.entityCell}>
        <EntityReferenceChip
          kind="monitor"
          name={event.monitor.name}
          href={`/monitors/${event.monitor.id}`}
        />
      </span>
    ),
  },
];

/**
 * The application home, at `/`: the Monitor Activity feed, with Market watch beside it on a wide
 * desktop (`docs/decisions/monitor-eod-v2.md` §6, `docs/decisions/etf-market-overview-v1.md`).
 *
 * **Layout.** From 1,280px the page is two columns — the feed, then a sticky Market watch sidebar
 * about a quarter of the width. Below 1,280px there is no sidebar at all: Market watch is **not
 * mounted**, so it neither renders, fetches nor starts its timer, and the feed takes the whole
 * width. The column is reserved in CSS at the same query, so the feed does not move when Market
 * watch appears after hydration. The feed's table adapts to its own column's width, not the
 * viewport's (the `dashboard-main` container query), because beside the sidebar a wide desktop
 * gives it less room than the intermediate band does.
 *
 * The feed lists what the Monitors the viewer can see **observed** after each market close — a stock
 * becoming a match, or a match ending because its conditions stopped holding — newest session
 * first, each explained by the values that decided it. History a new Monitor replayed, edits,
 * removals and a trigger day passing are not activity; they live on each Monitor's own page. A Guest
 * sees the published built-in Monitors; a signed-in user sees those they have not hidden, plus their
 * own enabled ones. Nothing is described as live: every row is a finalized end-of-day session.
 */
export function DashboardPage() {
  const { status, dashboard, reload } = useDashboard();
  const { state: session } = useAuthSession();
  const [monitorFilter, setMonitorFilter] = useState<string>(ALL_MONITORS);
  const activity = useMonitorActivity(
    monitorFilter === ALL_MONITORS ? null : monitorFilter,
  );
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

  const monitors = dashboard?.monitors ?? [];
  const shownMonitors = monitors.filter((monitor) => monitor.visible);
  const guest =
    dashboard?.viewer === "GUEST" || session.status === "unauthenticated";
  const loading = status === "loading" || activity.status === "loading";
  const failed = status === "error" || activity.status === "error";
  const events = activity.events;

  return (
    <PageContainer>
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
                  A <b>Monitor</b> watches a <b>List</b> using a <b>Strategy</b>
                  . You&apos;re viewing FactorSage&apos;s built-in monitors.
                  Sign in to choose which ones appear here, create your own, and
                  backtest any of them.
                </p>
                <Link className={forms.tintedButton} href={signInHref()}>
                  Sign in
                </Link>
              </div>
            ) : null}

            {loading && !failed ? (
              <SectionCard ariaLabel="Loading monitor activity">
                <SkeletonList rows={6} />
              </SectionCard>
            ) : null}

            {failed ? (
              <EmptyState
                variant="error"
                title="Monitor activity could not be loaded"
                body={<p>This is usually temporary — try again in a moment.</p>}
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
            ) : null}

            {!loading && !failed && dashboard ? (
              <SectionCard
                id="activity"
                title="Monitor activity"
                caption="Matches that began or ended at a market close, newest first. Each is decided on the session's finalized close."
                aside={<OverallFreshness monitors={shownMonitors} now={now} />}
                flush={events.length > 0}
                toolbar={
                  shownMonitors.length > 1 ? (
                    <div className={styles.toolbar}>
                      <SelectControl
                        id="dashboard-monitor-filter"
                        label="Monitor"
                        value={monitorFilter}
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
                    </div>
                  ) : null
                }
              >
                {events.length === 0 ? (
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
                ) : (
                  <div className={styles.activity}>
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
                    <DataTable
                      label="Monitor activity"
                      testId="dashboard-activity"
                      rowTestId="dashboard-activity-row"
                      clickableRows
                      columns={COLUMNS}
                      rows={events}
                      getRowKey={(event) => event.id}
                    />
                  </div>
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
                <DisclosureNote id="signals" className={styles.disclosure} />
              </SectionCard>
            ) : null}
          </div>

          {/* The market the activity happened in, on a wide desktop only. Its own request, its own
            timer and its own failure states: nothing in it can blank the feed. */}
          {wide ? (
            <div className={styles.sidebar} data-testid="dashboard-sidebar">
              <MarketWatchBoundary>
                <MarketWatch />
              </MarketWatchBoundary>
            </div>
          ) : null}
        </div>
      </div>
    </PageContainer>
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
