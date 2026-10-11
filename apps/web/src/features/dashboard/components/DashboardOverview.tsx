"use client";

import type { DashboardRowResponse } from "@intrinsic/contracts";
import Link from "next/link";
import type { ReactNode } from "react";
import { useSignInPrompt } from "../../auth/hooks/use-sign-in-prompt";
import { SIGN_IN_TO_BACKTEST } from "../../auth/utils/sign-in-prompts";
import styles from "./DashboardOverview.module.css";

/** The canonical New Backtest route. There is exactly one, and this is it. */
const NEW_BACKTEST_HREF = "/backtests/new";

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
 * The Dashboard's opening strip: `Run Backtest · Current matches`, two cards in one visual family.
 *
 * It used to carry three market-reference cards between them — S&P 500, DJIA and VIX. The ETF
 * market overview below replaced them (`docs/decisions/etf-market-overview-v1.md`): it answers what
 * those three cards gestured at, across twenty funds and six periods. What stays here is the one
 * action and the one number a returning user opens the Dashboard for, kept compact so the market and
 * the matches are what the first screen holds.
 *
 * The Run Backtest item is a card, not a button parked beside a card. It is the same rectangle, the
 * same radius and the same row as the count beside it, wearing the product's one solid-blue action
 * treatment because it is the only thing here that does something.
 *
 * The strip shares the market overview's column grid — two columns below 1,280px, three from there,
 * with the strip's cards in the first two — so its edges line up with the groups beneath it.
 */
export function DashboardOverview({ rows, rowsReady }: DashboardOverviewProps) {
  const gate = useSignInPrompt();

  return (
    <section
      className={styles.overview}
      aria-label="Run a backtest and current matches"
      data-testid="dashboard-overview"
    >
      <div className={styles.grid}>
        <RunBacktestCard gate={gate} />
        <MatchesCard rows={rows} ready={rowsReady} />
      </div>
      {gate.prompt}
    </section>
  );
}

function RunBacktestCard({
  gate,
}: {
  readonly gate: ReturnType<typeof useSignInPrompt>;
}) {
  const content = (
    <>
      <span className={styles.actionText}>
        <span className={styles.actionTitle}>Run Backtest</span>
        <span className={styles.actionLead}>Test a strategy</span>
      </span>
      <span className={styles.actionGlyph} aria-hidden="true">
        <PlayIcon />
      </span>
    </>
  );

  // A signed-in viewer gets a real link: middle-click, open in a new tab and the browser's own
  // status bar all work, and none of them would if this were a button that navigated.
  //
  // A Guest gets a button, because the honest answer to the click is a question, not a destination.
  // `useSignInPrompt` asks it in place — `docs/decisions/builtin-dashboard-signals-v1.md` section
  // 5.1 refuses anonymous persistence, and bouncing a visitor to `/login` would throw away the
  // Dashboard they were reading in order to say so.
  //
  // While the session is still resolving the card is a button too: it cannot know yet, and
  // rendering a link a Guest would follow is the one wrong answer of the two.
  if (gate.signedIn) {
    return (
      <Link
        className={`${styles.card} ${styles.actionCard}`}
        href={NEW_BACKTEST_HREF}
        data-testid="dashboard-run-backtest"
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      type="button"
      className={`${styles.card} ${styles.actionCard}`}
      data-testid="dashboard-run-backtest"
      onClick={() =>
        gate.attempt(
          { ...SIGN_IN_TO_BACKTEST, next: NEW_BACKTEST_HREF },
          () => {},
        )
      }
    >
      {content}
    </button>
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
          {ready ? `${active} active · ${waiting} waiting` : "\u00a0"}
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

function PlayIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
      <path d="M3 2.69a1.1 1.1 0 0 1 1.648-.96l9.401 5.311a1.1 1.1 0 0 1 0 1.918L4.648 14.271A1.1 1.1 0 0 1 3 13.311V2.69z" />
    </svg>
  );
}
