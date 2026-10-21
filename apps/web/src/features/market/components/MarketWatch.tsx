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
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import { EmptyState } from "../../../components/ui/EmptyState";
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
 * The Dashboard's Market watch: the twenty market-overview ETFs as an ultra-compact sidebar beside
 * Monitor activity, on a wide desktop only (`docs/decisions/etf-market-overview-v1.md`, Dashboard
 * V2).
 *
 * It is a pane, not a card: no border, radius or margin of its own — the Dashboard places it flush
 * against the page's right edge, under the topbar, with one hairline between it and the feed. The
 * title and the period selector stay put; the three groups scroll beneath them in their own region.
 *
 * One period at a time for the whole list — `1W | 1M | 3M | 6M | YTD | 1Y` — and every row shows
 * that period's return **and** that period's trend line, both from one response
 * (`instrument.returns[period]`, `instrument.sparklines[period]`), so switching the period changes
 * twenty rows at once and makes no request. The period rotates by itself (`usePeriodRotation`):
 * every eight seconds the returns and lines dim, change and come back, and the newly selected period
 * takes one soft highlight. Pointing at or working inside the sidebar pauses it; choosing a period
 * — any, the one on screen included — stops it for the rest of the page's life.
 *
 * The groups and rows are the API's, in the API's order, and never reorder: a period change
 * changes numbers and lines, not positions, and never the scroll position. Each row is one line:
 * the fund's mark, its ticker, the market it tracks, the return and the line. Nothing here
 * calculates: the API measured every return and prepared every line from stored end-of-day closes.
 *
 * Nothing is announced as it rotates: the rows are not a live region, so a screen reader is not read
 * twenty new numbers every few seconds. The period on screen is the selector's pressed option.
 */
export const MarketWatch = memo(function MarketWatch() {
  const { status, overview, reload } = useMarketOverview();
  const ready = status === "ready" && overview !== null;
  const empty = ready && overview.status === "UNAVAILABLE";
  const showRows = ready && !empty;
  const [pointerInside, setPointerInside] = useState(false);
  const [keyboardInside, setKeyboardInside] = useState(false);
  // Rotates only while there are rows to rotate — never behind a skeleton or an error panel — and
  // waits while the reader points at the sidebar or moves through it from the keyboard.
  const rotation = usePeriodRotation({
    active: showRows,
    held: pointerInside || keyboardInside,
  });
  const { period } = rotation;
  // True between a pointer press inside and its release, so the focus a click gives a control is
  // not taken for keyboard focus: a click is already covered by the pointer being inside.
  const pointerFocus = useRef(false);

  const onFocus = () => {
    setKeyboardInside(!pointerFocus.current);
  };
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setKeyboardInside(false);
    }
  };

  return (
    <div
      className={styles.watch}
      data-testid="market-watch"
      data-status={ready ? overview.status : status.toUpperCase()}
      data-period={period}
      data-auto={rotation.auto ? "on" : "off"}
      data-rotating={rotation.rotating ? "true" : undefined}
      data-phase={rotation.phase}
      aria-busy={status === "loading"}
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
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
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h2 id="market-watch-title" className={styles.title}>
            Market watch
          </h2>
          {/* The close every number is measured to. Fixed while the period rotates. */}
          {showRows && overview.asOf ? (
            <span className={styles.asOf} data-testid="market-watch-as-of">
              Close ·{" "}
              <time dateTime={overview.asOf}>{formatDay(overview.asOf)}</time>
            </span>
          ) : null}
        </div>
        {showRows ? (
          <div className={styles.periods}>
            <SegmentedControl
              label="Return period"
              testId="market-watch-period"
              value={period}
              onChange={rotation.select}
              options={PERIOD_OPTIONS}
              highlight={rotation.arrived}
              fill
              compact
            />
          </div>
        ) : null}
      </header>

      <div
        className={styles.scroll}
        role="region"
        aria-label="Market watch ETFs"
        // A keyboard can reach and scroll the list; it holds no other tab stop.
        tabIndex={0}
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
      </div>
    </div>
  );
});

/**
 * One fund on one line: its mark, its ticker, the market it tracks, the period's return and the
 * period's line. Memoised on the instrument and the period, so a rotation's dimming — an attribute
 * on the sidebar, styled in CSS — never redraws a row; only the swap itself does.
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
      <span className={styles.ticker} data-testid="market-watch-ticker">
        {ticker}
      </span>
      <span className={styles.nameCell}>
        <span
          className={styles.name}
          title={instrument.name}
          data-testid="market-watch-name"
        >
          {instrument.name}
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
                  <span className={styles.ticker}>
                    <Skeleton height="1em" width="2.2rem" />
                  </span>
                  <span className={styles.nameCell}>
                    <Skeleton height="1em" width="5.5rem" />
                  </span>
                  <span className={styles.value}>
                    <Skeleton height="1em" width="2.6rem" />
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
          <header className={styles.header}>
            <div className={styles.titleRow}>
              <h2 id="market-watch-title" className={styles.title}>
                Market watch
              </h2>
            </div>
          </header>
          <div className={styles.state}>
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
          </div>
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
