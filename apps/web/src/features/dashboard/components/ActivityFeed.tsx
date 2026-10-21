"use client";

import type { DashboardActivityEventResponse } from "@intrinsic/contracts";
import { memo, useMemo, type MouseEvent } from "react";
import { EntityReferenceChip } from "../../../components/ui/EntityReference";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { StockIdentity } from "../../../components/ui/StockIdentity";
import { formatDayLong } from "../../../lib/dates";
import {
  LEVEL_KIND_LABELS,
  RESOLUTION_REASON_LABELS,
} from "../../monitors/utils/format";
import { stockDetailsHref } from "../../stocks/search/utils/stock-routes";
import { LEVEL_KIND_TONES } from "../../strategies/utils/format";
import { groupBySession } from "../utils/activity";
import { ActivityConditions } from "./ActivityConditions";
import styles from "./ActivityFeed.module.css";

/**
 * `Activated` or `Ended`: what the event was, as the feed shows it beside its level.
 *
 * Read from the event's own `kind`, never inferred from its level or a colour. Every ending the feed
 * lists is a market observation (`CONDITIONS_ENDED`) whose ✕ line says which condition stopped
 * holding; any other reason would be named after it, so an ending is never mistaken for another.
 */
export function activityStateLabel(
  event: Pick<DashboardActivityEventResponse, "kind" | "reason">,
): string {
  if (event.kind === "ACTIVATED") {
    return "Activated";
  }
  const reason = RESOLUTION_REASON_LABELS[event.reason];
  return reason === "ended" || event.reason === "CONDITIONS_ENDED"
    ? "Ended"
    : `Ended · ${reason}`;
}

/**
 * Monitor activity as a feed of market sessions (`docs/decisions/monitor-eod-v2.md` §6–§7,
 * Dashboard V2).
 *
 * A table, deliberately: each event is one row — the stock, what happened and under which Monitor,
 * and every condition that decided it — so the three facts line up down the page however many
 * conditions a row carries. Rows grow with their conditions and are never clipped. The events are
 * grouped under one heading per exchange session (`groupBySession`), newest first, so a date is
 * written once rather than on every row.
 *
 * - **The level, without its step.** `Buy`, `Sell`, `Final exit`: the step number a Strategy gives a
 *   level (`Buy 2`) is not shown here, and nothing else about the event changes — each step's event
 *   is its own row, keyed by its own id, even beside another step of the same stock on the same
 *   session under the same Monitor. The step stays on the row as `data-level-index`.
 * - **No price.** An activation's price is not shown on its own; a price that a condition compared
 *   is shown on that condition's line.
 * - **The Monitor** that observed the event names it under the level, linked to its page.
 *
 * Table roles are written explicitly, as `DataTable` writes them, because the rows are laid out as
 * a grid rather than with table layout (`ActivityFeed.module.css`). A click on a row that lands on
 * no control opens the stock, through the row's one stock link.
 */
export const ActivityFeed = memo(function ActivityFeed({
  events,
  testId = "dashboard-activity",
}: {
  readonly events: readonly DashboardActivityEventResponse[];
  readonly testId?: string;
}) {
  const sessions = useMemo(() => groupBySession(events), [events]);

  return (
    <table
      className={styles.feed}
      role="table"
      aria-label="Monitor activity"
      data-testid={testId}
    >
      <thead className={styles.head} role="rowgroup">
        <tr className={styles.headRow} role="row">
          <th role="columnheader" scope="col" className={styles.th}>
            Stock
          </th>
          <th role="columnheader" scope="col" className={styles.th}>
            Signal
          </th>
          <th role="columnheader" scope="col" className={styles.th}>
            Conditions
          </th>
        </tr>
      </thead>
      {sessions.map((session) => (
        <tbody
          key={session.sessionDate}
          className={styles.session}
          role="rowgroup"
          data-testid="dashboard-session-group"
          data-session={session.sessionDate}
        >
          <tr className={styles.sessionRow} role="row">
            <th
              role="rowheader"
              scope="rowgroup"
              colSpan={3}
              className={styles.sessionHeader}
            >
              <time
                dateTime={session.sessionDate}
                data-testid="dashboard-session"
              >
                {formatDayLong(session.sessionDate)}
              </time>
            </th>
          </tr>
          {session.events.map((event) => (
            <ActivityRow key={event.id} event={event} />
          ))}
        </tbody>
      ))}
    </table>
  );
});

function openStockFromRow(event: MouseEvent<HTMLTableRowElement>) {
  // A click on a link, a button or a form control belongs to that control, never to the row.
  if (
    (event.target as HTMLElement).closest(
      "a, button, input, select, textarea, label, summary, details",
    )
  ) {
    return;
  }
  // Selecting a condition's values to copy them is not a navigation.
  if ((window.getSelection()?.toString().length ?? 0) > 0) {
    return;
  }
  event.currentTarget
    .querySelector<HTMLAnchorElement>('[data-column="stock"] a')
    ?.click();
}

const ActivityRow = memo(function ActivityRow({
  event,
}: {
  readonly event: DashboardActivityEventResponse;
}) {
  return (
    <tr
      className={styles.row}
      role="row"
      data-testid="dashboard-activity-row"
      data-event-id={event.id}
      data-kind={event.kind}
      data-level={event.levelKind}
      data-level-index={event.levelIndex}
      data-monitor-id={event.monitor.id}
      onClick={openStockFromRow}
    >
      <td role="cell" data-column="stock">
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
      </td>
      <td className={styles.signal} role="cell" data-column="signal">
        <span className={styles.signalLine}>
          <StatusBadge
            tone={LEVEL_KIND_TONES[event.levelKind]}
            variant="text"
            testId="dashboard-event-level"
            dataAttributes={{ "data-level": event.levelKind }}
          >
            {LEVEL_KIND_LABELS[event.levelKind]}
          </StatusBadge>
          <span
            className={styles.state}
            data-kind={event.kind}
            data-testid="dashboard-event-state"
          >
            <span className={styles.stateDot} aria-hidden="true" />
            {activityStateLabel(event)}
          </span>
        </span>
        <span className={styles.monitor} data-testid="dashboard-event-monitor">
          <span className={styles.srOnly}>Monitor: </span>
          <EntityReferenceChip
            kind="monitor"
            name={event.monitor.name}
            href={`/monitors/${event.monitor.id}`}
          />
        </span>
        {event.observationBasis === "LIVE_QUOTE" ? (
          // An occurrence the earlier live-quote Monitor decided on an intraday price, said quietly.
          <span className={styles.basis} data-testid="dashboard-event-basis">
            Intraday quote
          </span>
        ) : null}
      </td>
      <td
        className={styles.conditionsCell}
        role="cell"
        data-column="conditions"
      >
        <ActivityConditions why={event.why} />
      </td>
    </tr>
  );
});
