"use client";

import type { DashboardRowResponse } from "@intrinsic/contracts";
import styles from "./DashboardOverview.module.css";

type DashboardOverviewProps = {
  /**
   * Every row the viewer's Dashboard source set returned, **before** the state and action filters.
   *
   * That is the whole point of passing them rather than the filtered list: the card reports what is
   * matching right now, and a reader narrowing the table below to `Buy` has not changed the market
   * or the monitors. A card that moved with the filters would be a second, worse copy of the counts
   * already on the filter buttons.
   */
  readonly rows: readonly DashboardRowResponse[];
  /** False while the Dashboard itself is still loading, so the count is never shown as a premature 0. */
  readonly rowsReady: boolean;
};

/**
 * The Dashboard's opening strip: how much is matching right now, in one card.
 *
 * It used to open with a `Run Backtest` card beside the count, and before that with three
 * market-reference cards between them. The market cards became the ETF market overview below
 * (`docs/decisions/etf-market-overview-v1.md`), and the action was removed as redundant: a backtest
 * starts from the Backtests area in the main navigation, or from the List, Strategy or Monitor it is
 * about. What stays is the one number a returning user opens the Dashboard for, kept compact so the
 * market and the matches are what the first screen holds.
 *
 * The strip keeps the market overview's column grid from 880px — the card is one column of two —
 * so its edges line up with the group beneath it. On a phone the card takes the row.
 */
export function DashboardOverview({ rows, rowsReady }: DashboardOverviewProps) {
  return (
    <section
      className={styles.overview}
      aria-label="Current matches summary"
      data-testid="dashboard-overview"
    >
      <div className={styles.grid}>
        <MatchesCard rows={rows} ready={rowsReady} />
      </div>
    </section>
  );
}

/**
 * How much is matching right now, from the Dashboard's own rows.
 *
 * Deliberately not a new endpoint. `GET /dashboard` already returns exactly the set this counts —
 * a Guest's published built-ins, a customer's visible built-ins plus their own eligible monitors —
 * and asking a second endpoint for a number derived from data already in hand would only create a
 * way for the card and the table below it to disagree.
 *
 * It is the *viewer's* count, never a platform-wide one. Two people with different monitors visible
 * see different numbers here, and that is correct.
 */
function MatchesCard({
  rows,
  ready,
}: {
  readonly rows: readonly DashboardRowResponse[];
  readonly ready: boolean;
}) {
  const active = rows.filter((row) => row.state === "ACTIVE").length;
  const waiting = rows.filter((row) => row.state === "PENDING_TRIGGER").length;

  return (
    <a
      className={`${styles.card} ${styles.matchesCard}`}
      href="#signals"
      data-testid="dashboard-matches-card"
    >
      <span className={styles.matchesText}>
        {/* "Current", not "Real-time": this is an end-of-day product (UI-025). */}
        <span className={styles.label}>Current matches</span>
        <span
          className={styles.matchesBreakdown}
          data-testid="dashboard-matches-breakdown"
        >
          {ready ? `${active} active · ${waiting} waiting` : " "}
        </span>
      </span>
      {ready ? (
        <span className={styles.value} data-testid="dashboard-matches-total">
          {rows.length}
        </span>
      ) : (
        <span className={styles.valueUnavailable}>—</span>
      )}
    </a>
  );
}
