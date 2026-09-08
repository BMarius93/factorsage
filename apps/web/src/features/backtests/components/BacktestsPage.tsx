"use client";

import {
  BACKTEST_RUN_STATUS_LABELS,
  isTerminalBacktestStatus,
  type BacktestRunStatus,
  type BacktestRunSummaryResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { PageContainer } from "../../../components/layout/PageContainer";
import forms from "../../../components/ui/forms.module.css";
import { useBacktestRuns } from "../hooks/use-backtest-runs";
import {
  formatPeriod,
  formatSignedPercent,
  formatTimestamp,
  METRIC_PLACEHOLDER,
} from "../utils/format";
import styles from "./BacktestsPage.module.css";

function statusTone(status: BacktestRunStatus): string {
  switch (status) {
    case "COMPLETED":
      return "positive";
    case "FAILED":
      return "negative";
    case "RUNNING":
    case "FINALIZING":
      return "active";
    default:
      return "pending";
  }
}

function RunCard({ run }: { readonly run: BacktestRunSummaryResponse }) {
  // Both terminal statuses are finished. A FAILED run rendered through the in-flight branch would
  // show a filled progress bar and the last running message under a "Failed" pill.
  const finished = isTerminalBacktestStatus(run.status);
  return (
    <li className={styles.card} data-testid="backtest-card">
      <Link className={styles.cardLink} href={`/backtests/${run.id}`}>
        <span className={styles.cardHead}>
          <span className={styles.cardName}>{run.strategyName}</span>
          <span
            className={styles.statusPill}
            data-tone={statusTone(run.status)}
          >
            {BACKTEST_RUN_STATUS_LABELS[run.status]}
          </span>
        </span>
        <span className={styles.cardMeta}>
          {run.stockListName} · vs {run.benchmarkName}
        </span>
        <span className={styles.cardMeta}>
          {formatPeriod(run.startDate, run.endDate)}
        </span>

        {finished ? (
          <span className={styles.figures}>
            <span className={styles.figure}>
              <span className={styles.figureLabel}>Portfolio</span>
              <span
                className={styles.figureValue}
                data-tone={
                  run.portfolioReturnPercent === null ||
                  run.portfolioReturnPercent === 0
                    ? undefined
                    : run.portfolioReturnPercent > 0
                      ? "positive"
                      : "negative"
                }
              >
                {run.portfolioReturnPercent === null
                  ? METRIC_PLACEHOLDER
                  : formatSignedPercent(run.portfolioReturnPercent)}
              </span>
            </span>
            <span className={styles.figure}>
              <span className={styles.figureLabel}>{run.benchmarkName}</span>
              <span className={styles.figureValue}>
                {run.benchmarkReturnPercent === null
                  ? METRIC_PLACEHOLDER
                  : formatSignedPercent(run.benchmarkReturnPercent)}
              </span>
            </span>
            <span className={styles.figure}>
              <span className={styles.figureLabel}>Alpha</span>
              <span
                className={styles.figureValue}
                data-tone={
                  run.alphaPercent === null || run.alphaPercent === 0
                    ? undefined
                    : run.alphaPercent > 0
                      ? "positive"
                      : "negative"
                }
              >
                {run.alphaPercent === null
                  ? METRIC_PLACEHOLDER
                  : formatSignedPercent(run.alphaPercent)}
              </span>
            </span>
          </span>
        ) : (
          <span className={styles.pending}>
            {/* A queued or executing run has no result to report; what it does have is how far
                along it is, which is the only honest thing a collection row can show. */}
            <span className={styles.track} aria-hidden="true">
              <span
                className={styles.fill}
                style={{
                  width: `${Math.min(100, Math.max(0, run.progressPercent))}%`,
                }}
              />
            </span>
            <span className={styles.pendingText}>
              {run.progressMessage ??
                `${Math.round(run.progressPercent)}% complete`}
            </span>
          </span>
        )}

        <span className={styles.cardFooter}>
          Queued {formatTimestamp(run.queuedAt)}
        </span>
      </Link>
    </li>
  );
}

/**
 * The signed-in user's backtest runs.
 *
 * A run's own page owns live progress; this collection reports the state each run was in when the
 * list was fetched, so opening the app does not start a poll per row.
 */
export function BacktestsPage() {
  const { status, runs, retry } = useBacktestRuns();

  return (
    <PageContainer>
      <div className={styles.page} data-testid="backtests-page">
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>Backtests</h1>
            <p className={styles.lead}>
              Run a strategy over a stock list and a historical period, and
              compare it against a benchmark.
            </p>
          </div>
          {status === "ready" && runs.length > 0 ? (
            <Link
              className={styles.primaryLink}
              href="/backtests/new"
              data-testid="new-backtest-button"
            >
              New backtest
            </Link>
          ) : null}
        </header>

        {status === "loading" ? (
          <div className={styles.grid} aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div key={index} className={styles.skeletonCard} />
            ))}
          </div>
        ) : null}

        {status === "error" ? (
          <div className={styles.statusPanel} role="alert">
            <h2 className={styles.statusTitle}>
              Your backtests could not be loaded
            </h2>
            <p className={styles.statusBody}>
              This is usually temporary — try again in a moment.
            </p>
            <button
              type="button"
              className={forms.secondaryButton}
              onClick={retry}
            >
              Try again
            </button>
          </div>
        ) : null}

        {status === "ready" && runs.length === 0 ? (
          <div className={styles.statusPanel} data-testid="backtests-empty">
            <h2 className={styles.statusTitle}>No backtests yet</h2>
            <p className={styles.statusBody}>
              A backtest executes one strategy over one stock list across a
              historical period, with your capital, contributions and position
              limit. Results appear while it runs.
            </p>
            <Link
              className={styles.primaryLink}
              href="/backtests/new"
              data-testid="new-backtest-button"
            >
              Run your first backtest
            </Link>
          </div>
        ) : null}

        {status === "ready" && runs.length > 0 ? (
          <ul className={styles.grid} data-testid="backtests-grid">
            {runs.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </ul>
        ) : null}
      </div>
    </PageContainer>
  );
}
