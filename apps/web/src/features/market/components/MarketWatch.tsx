"use client";

import {
  MARKET_OVERVIEW_GROUP_IDS,
  MARKET_OVERVIEW_PERIODS,
  type MarketOverviewGroupId,
  type MarketOverviewInstrumentResponse,
  type MarketOverviewPeriod,
} from "@intrinsic/contracts";
import {
  Component,
  memo,
  useRef,
  type FocusEvent,
  type ReactNode,
} from "react";
import { EmptyState } from "../../../components/ui/EmptyState";
import { SectionCard } from "../../../components/ui/SectionCard";
import { SegmentedControl } from "../../../components/ui/SegmentedControl";
import { Skeleton } from "../../../components/ui/Skeleton";
import forms from "../../../components/ui/forms.module.css";
import { formatDay } from "../../../lib/dates";
import { useMarketOverview } from "../hooks/use-market-overview";
import { usePeriodRotation } from "../hooks/use-period-rotation";
import {
  describeSparkline,
  formatReturn,
  formatSessionDate,
  PERIOD_RETURN_LABELS,
  returnDirection,
} from "../utils/format";
import { MarketIcon } from "./market-icons";
import { MarketSparkline } from "./MarketSparkline";
import styles from "./MarketWatch.module.css";

/**
 * How many rows each group's loading skeleton holds, so the sidebar does not change shape when the
 * data lands. The server owns the list; this is only the skeleton's shape, and a unit test holds it
 * to a full response so the two cannot drift apart.
 */
export const MARKET_WATCH_SKELETON_ROWS: Record<MarketOverviewGroupId, number> =
  {
    BENCHMARKS: 5,
    US_SECTORS: 11,
    MACRO_ALTERNATIVES: 4,
  };

const PERIOD_OPTIONS = MARKET_OVERVIEW_PERIODS.map((period) => ({
  value: period,
  label: period,
}));

/**
 * The Dashboard's Market watch: the twenty market-overview ETFs as a compact watchlist beside
 * Monitor activity, on a wide desktop only (`docs/decisions/etf-market-overview-v1.md`, the
 * Dashboard V2 amendment).
 *
 * One period at a time for the whole list — `1W | 1M | 3M | 6M | YTD | 1Y` — and every row shows
 * that period's return **and** that period's trend line, both from one response
 * (`instrument.returns[period]`, `instrument.sparklines[period]`), so switching the period changes
 * twenty rows at once and makes no request. Auto moves to the next period every ten seconds
 * (`usePeriodRotation`); choosing a period pauses it, and the Auto control resumes it.
 *
 * The groups and rows are the API's, in the API's order, and never reorder: a period change
 * changes numbers and lines, not positions. Each row is the fund's mark, its ticker over the market
 * it tracks, the return and the line. Nothing here calculates: the API measured every return and
 * prepared every line from stored end-of-day closes.
 *
 * Nothing is announced as it rotates: the rows are not a live region, so a screen reader is not read
 * twenty new numbers every ten seconds. The period on screen is the selector's pressed option and
 * the caption under it.
 */
export const MarketWatch = memo(function MarketWatch() {
  const { status, overview, reload } = useMarketOverview();
  const ready = status === "ready" && overview !== null;
  const empty = ready && overview.status === "UNAVAILABLE";
  const showRows = ready && !empty;
  // Rotates only while there are rows to rotate: never behind a skeleton or an error panel.
  const rotation = usePeriodRotation(showRows);
  const { period } = rotation;
  // True between a pointer press inside and its release, so the focus a press gives a button is
  // not taken for keyboard focus.
  const pointerFocus = useRef(false);

  // Keyboard focus inside holds the rotation; focus a pointer gave releases it.
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) {
      rotation.setHeld(!pointerFocus.current);
    }
  };
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      rotation.setHeld(false);
    }
  };

  return (
    <div
      className={styles.watch}
      data-testid="market-watch"
      data-status={ready ? overview.status : status.toUpperCase()}
      data-period={period}
      data-auto={rotation.auto ? "on" : "paused"}
      data-rotating={rotation.rotating ? "true" : undefined}
      aria-busy={status === "loading"}
      onPointerDown={() => {
        pointerFocus.current = true;
      }}
      onPointerUp={() => {
        pointerFocus.current = false;
      }}
      onPointerCancel={() => {
        pointerFocus.current = false;
      }}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <SectionCard
        id="market-watch"
        title="Market watch"
        aside={
          showRows ? (
            <AutoControl
              auto={rotation.auto}
              onToggle={() => rotation.setAuto(!rotation.auto)}
            />
          ) : null
        }
        toolbar={
          showRows ? (
            <div className={styles.periods}>
              <SegmentedControl
                label="Return period"
                testId="market-watch-period"
                value={period}
                onChange={rotation.select}
                options={PERIOD_OPTIONS}
                fill
                compact
              />
              {/* What the numbers are, in words: the period on screen and the close they are
                  measured to. Not a live region — it changes with every rotation. */}
              <p className={styles.caption} data-testid="market-watch-caption">
                {PERIOD_RETURN_LABELS[period]}
                {overview.asOf ? (
                  <> · At close · {formatDay(overview.asOf)}</>
                ) : null}
              </p>
            </div>
          ) : null
        }
        flush
        scrollLabel="Market watch ETFs"
      >
        {status === "loading" ? <WatchSkeleton /> : null}

        {status === "error" ? (
          <div className={styles.state}>
            <EmptyState
              variant="error"
              testId="market-watch-error"
              title="Market data could not be loaded"
              body={<p>This is usually temporary — try again in a moment.</p>}
              actions={
                <button
                  type="button"
                  className={forms.secondaryButton}
                  onClick={reload}
                >
                  Try again
                </button>
              }
            />
          </div>
        ) : null}

        {empty ? (
          <div className={styles.state}>
            <EmptyState
              variant="compact"
              testId="market-watch-unavailable"
              title="Market data is not available right now"
              body={
                <p>
                  The ETF price histories behind Market watch could not be read.
                  Monitor activity is unaffected.
                </p>
              }
              actions={
                <button
                  type="button"
                  className={forms.secondaryButton}
                  onClick={reload}
                >
                  Try again
                </button>
              }
            />
          </div>
        ) : null}

        {showRows ? (
          <div className={styles.groups}>
            {overview.groups.map((group) => (
              <section
                key={group.id}
                className={styles.group}
                aria-labelledby={`market-watch-group-${group.id}`}
                data-testid={`market-watch-group-${group.id}`}
              >
                <h3
                  id={`market-watch-group-${group.id}`}
                  className={styles.groupTitle}
                >
                  {group.label}
                </h3>
                <ul className={styles.list}>
                  {group.instruments.map((instrument) => (
                    <WatchRow
                      key={instrument.ticker}
                      instrument={instrument}
                      period={period}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
});

/**
 * Auto on or off, as a toggle button whose pressed state is the mode. Paused also says so in
 * words beside it, so the state never depends on reading a tint.
 */
function AutoControl({
  auto,
  onToggle,
}: {
  readonly auto: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <span className={styles.auto}>
      {auto ? null : (
        <span className={styles.autoState} data-testid="market-watch-paused">
          Paused
        </span>
      )}
      <button
        type="button"
        className={styles.autoButton}
        aria-pressed={auto}
        // The visible word first, so speech input can say what it sees (WCAG 2.5.3).
        aria-label="Auto rotate periods"
        data-active={auto ? "true" : undefined}
        onClick={onToggle}
        data-testid="market-watch-auto"
      >
        <svg
          className={styles.autoIcon}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
          <path d="M4 3.5V8h4.5" />
          <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
          <path d="M20 20.5V16h-4.5" />
        </svg>
        Auto
      </button>
    </span>
  );
}

/**
 * One fund: its mark, its ticker over the market it tracks, the period's return and the period's
 * line. Memoised on the instrument and the period, so nothing but a period change or new data
 * redraws a row.
 */
const WatchRow = memo(function WatchRow({
  instrument,
  period,
}: {
  readonly instrument: MarketOverviewInstrumentResponse;
  readonly period: MarketOverviewPeriod;
}) {
  const value = instrument.returns[period];
  const formatted = formatReturn(value);
  const line = instrument.sparklines[period];
  const { ticker } = instrument;

  return (
    <li
      className={styles.row}
      data-status={instrument.status}
      data-testid={`market-watch-row-${ticker}`}
    >
      <span className={styles.mark}>
        <MarketIcon ticker={ticker} className={styles.icon} />
      </span>
      <span className={styles.identity}>
        <span className={styles.tickerLine}>
          <span className={styles.ticker} data-testid="market-watch-ticker">
            {ticker}
          </span>
          {instrument.status === "STALE" && instrument.sessionDate ? (
            <span
              className={styles.flag}
              data-tone="warning"
              data-testid={`market-watch-stale-${ticker}`}
            >
              As of {formatSessionDate(instrument.sessionDate)}
            </span>
          ) : null}
          {instrument.status === "UNAVAILABLE" ? (
            <span
              className={styles.flag}
              data-testid={`market-watch-unavailable-${ticker}`}
            >
              No data
            </span>
          ) : null}
        </span>
        <span
          className={styles.name}
          title={instrument.name}
          data-testid="market-watch-name"
        >
          {instrument.name}
        </span>
      </span>
      <span
        className={styles.value}
        data-tone={formatted.tone}
        data-testid={`market-watch-return-${ticker}`}
      >
        {formatted.tone === "unavailable" ? (
          <>
            <span aria-hidden="true">{formatted.text}</span>
            <span className={styles.srOnly}>not available</span>
          </>
        ) : (
          formatted.text
        )}
      </span>
      <span className={styles.trend}>
        {line ? (
          <MarketSparkline
            values={line.values}
            tone={returnDirection(value)}
            idPrefix={`market-watch-${ticker}`}
            label={describeSparkline(ticker, period, line, value)}
          />
        ) : (
          <span
            className={styles.trendEmpty}
            role="img"
            aria-label={describeSparkline(ticker, period, null, value)}
            data-testid={`market-watch-${ticker}-no-trend`}
          />
        )}
      </span>
    </li>
  );
});

/**
 * The loading shape: the three groups and twenty rows at their final geometry, so the sidebar
 * keeps its size when the data lands.
 */
function WatchSkeleton() {
  return (
    <div
      className={styles.groups}
      aria-hidden="true"
      data-testid="market-watch-loading"
    >
      {MARKET_OVERVIEW_GROUP_IDS.map((id) => (
        <div key={id} className={styles.group}>
          <div className={styles.groupTitle}>
            <Skeleton height="1em" width="7rem" />
          </div>
          <ul className={styles.list}>
            {Array.from(
              { length: MARKET_WATCH_SKELETON_ROWS[id] },
              (_, index) => (
                <li key={index} className={styles.row}>
                  <span className={styles.mark}>
                    <Skeleton height="100%" width="100%" radius="control" />
                  </span>
                  <span className={styles.identity}>
                    <span className={styles.tickerLine}>
                      <Skeleton height="1em" width="2.6rem" />
                    </span>
                    <span className={styles.name}>
                      <Skeleton height="1em" width="6rem" />
                    </span>
                  </span>
                  <span className={styles.value}>
                    <Skeleton height="1em" width="2.8rem" />
                  </span>
                  <span className={styles.trend}>
                    <Skeleton height="100%" width="100%" />
                  </span>
                </li>
              ),
            )}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * Keeps a rendering failure inside Market watch: the sidebar shows its error state and Monitor
 * activity beside it carries on. A failed request is already handled by the hook; this is for a
 * body that reads as valid and still cannot be drawn.
 */
export class MarketWatchBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean; readonly attempt: number }
> {
  override state = { failed: false, attempt: 0 };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) {
      return (
        <div
          className={styles.watch}
          data-testid="market-watch"
          data-status="ERROR"
        >
          <SectionCard id="market-watch" title="Market watch">
            <EmptyState
              variant="error"
              testId="market-watch-error"
              title="Market data could not be shown"
              body={<p>Monitor activity is unaffected.</p>}
              actions={
                <button
                  type="button"
                  className={forms.secondaryButton}
                  onClick={() =>
                    this.setState((current) => ({
                      failed: false,
                      attempt: current.attempt + 1,
                    }))
                  }
                >
                  Try again
                </button>
              }
            />
          </SectionCard>
        </div>
      );
    }
    return (
      <MarketWatchKey key={this.state.attempt}>
        {this.props.children}
      </MarketWatchKey>
    );
  }
}

/** Remounts its children when the boundary retries, so a retry starts a fresh read. */
function MarketWatchKey({ children }: { readonly children: ReactNode }) {
  return <>{children}</>;
}
