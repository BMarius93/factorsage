"use client";

import {
  MARKET_OVERVIEW_GROUP_IDS,
  MARKET_OVERVIEW_PERIODS,
  type MarketOverviewGroupId,
  type MarketOverviewGroupResponse,
  type MarketOverviewInstrumentResponse,
  type MarketOverviewPeriod,
} from "@intrinsic/contracts";
import { useState } from "react";
import { EmptyState } from "../../../components/ui/EmptyState";
import { SegmentedControl } from "../../../components/ui/SegmentedControl";
import { SelectControl } from "../../../components/ui/SelectControl";
import { Skeleton } from "../../../components/ui/Skeleton";
import forms from "../../../components/ui/forms.module.css";
import { useMarketOverview } from "../hooks/use-market-overview";
import {
  describeReturn,
  describeSparkline,
  formatReturn,
  formatSessionDate,
  PERIOD_NAMES,
  sparklineTone,
} from "../utils/format";
import { MarketSparkline } from "./MarketSparkline";
import styles from "./MarketOverview.module.css";

type SortState = Partial<Record<MarketOverviewGroupId, MarketOverviewPeriod>>;

/**
 * How many rows each group's loading skeleton holds, so nothing below it moves when the data lands.
 * The server owns the list; this is only the skeleton's shape, and a unit test holds it to a real
 * response so the two cannot drift apart.
 */
export const MARKET_OVERVIEW_SKELETON_ROWS: Record<MarketOverviewGroupId, number> = {
  BENCHMARKS: 5,
  US_SECTORS: 11,
  MACRO_ALTERNATIVES: 4,
};

/**
 * The Dashboard's market overview: twenty ETFs in three groups, every one with all six trailing
 * returns and a one-year trend line at once (`docs/decisions/etf-market-overview-v1.md`).
 *
 * There is no period selector: 1W, 1M, 3M, 6M, YTD and 1Y are all on screen, because the question
 * this answers is how short-, medium- and long-term moves differ, and a selector would hide five of
 * the six answers. Each group may be **sorted** by one period — strongest first — from its column
 * headings; the catalog order is the default and one more click restores it.
 *
 * One markup, three compositions, switched by CSS at the product's own breakpoints:
 *
 * - **≥ 1,280px** — two columns that start and end together: Benchmarks over Macro & Alternatives
 *   on the left, Sector Performance on the right. Every group is the same eight-column table —
 *   Market, the six returns, Chart 1Y — with one line per fund;
 * - **880–1,279px** — the same three tables, one under another across the page;
 * - **< 880px** — a category selector (a choice of *group*, never of period) and one compact card
 *   per ETF: the market and its ticker on one line and the six returns as a labelled 3 × 2 grid.
 *   The trend line is the desktop table's last column and is not drawn on a card.
 *
 * A fund is called by the market it tracks, with its ticker beside the name in a quieter voice.
 * Nothing on the page explains the numbers: they are end-of-day price returns, which the contract
 * states (`MARKET_OVERVIEW_BASIS`, `MARKET_OVERVIEW_RETURN_BASIS`), and the overview is kept short
 * so that the matches below it start on the first screen. The numbers come from the API as
 * computed; this component formats and arranges them and calculates nothing.
 */
export function MarketOverview() {
  const { status, overview, reload } = useMarketOverview();
  const [category, setCategory] = useState<MarketOverviewGroupId>("BENCHMARKS");
  const [sorts, setSorts] = useState<SortState>({});

  const groups = overview?.groups ?? [];
  const ready = status === "ready" && overview !== null;
  const empty = ready && overview.status === "UNAVAILABLE";

  const toggleSort = (group: MarketOverviewGroupId, period: MarketOverviewPeriod) =>
    setSorts((current) => ({
      ...current,
      [group]: current[group] === period ? undefined : period,
    }));
  const chooseSort = (group: MarketOverviewGroupId, value: string) =>
    setSorts((current) => ({
      ...current,
      [group]: isPeriod(value) ? value : undefined,
    }));

  return (
    <section
      className={styles.section}
      aria-labelledby="market-overview-title"
      aria-busy={status === "loading"}
      data-testid="market-overview"
      data-status={ready ? overview.status : status.toUpperCase()}
    >
      <div className={styles.header}>
        <h2 id="market-overview-title" className={styles.title}>
          Market overview
        </h2>
        {ready && !empty ? (
          <div className={styles.compactControls}>
            <div className={styles.categories}>
              <SegmentedControl
                label="Market category"
                testId="market-overview-category"
                value={category}
                onChange={setCategory}
                fill
                options={groups.map((group) => ({
                  value: group.id,
                  label: group.shortLabel,
                }))}
              />
            </div>
            <SelectControl
              id="market-overview-sort"
              label="Sort"
              testId="market-overview-sort"
              value={sorts[category] ?? "DEFAULT"}
              onChange={(value) => chooseSort(category, value)}
              options={[
                { value: "DEFAULT", label: "Default order" },
                ...MARKET_OVERVIEW_PERIODS.map((period) => ({
                  value: period,
                  label: `${period} return, highest first`,
                })),
              ]}
            />
          </div>
        ) : status === "loading" ? (
          <div className={styles.compactControls} aria-hidden="true">
            <div className={styles.categories}>
              <Skeleton height="var(--button-height)" width="100%" radius="control" />
            </div>
            <div className={styles.sortSkeleton}>
              <Skeleton height="var(--action-height)" width="100%" radius="control" />
            </div>
          </div>
        ) : null}
      </div>

      {status === "loading" ? <OverviewSkeleton /> : null}

      {status === "error" ? (
        <EmptyState
          variant="error"
          testId="market-overview-error"
          title="Market data could not be loaded"
          body={<p>This is usually temporary — try again in a moment.</p>}
          actions={
            <button type="button" className={forms.secondaryButton} onClick={reload}>
              Try again
            </button>
          }
        />
      ) : null}

      {empty ? (
        <EmptyState
          variant="compact"
          testId="market-overview-unavailable"
          title="Market data is not available right now"
          body={
            <p>
              The ETF price histories behind this overview could not be read. The rest of
              the Dashboard is unaffected.
            </p>
          }
          actions={
            <button type="button" className={forms.secondaryButton} onClick={reload}>
              Try again
            </button>
          }
        />
      ) : null}

      {ready && !empty ? (
        <div className={styles.groups}>
          {groups.map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              selected={group.id === category}
              sort={sorts[group.id]}
              onSort={(period) => toggleSort(group.id, period)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function GroupCard({
  group,
  selected,
  sort,
  onSort,
}: {
  readonly group: MarketOverviewGroupResponse;
  readonly selected: boolean;
  readonly sort: MarketOverviewPeriod | undefined;
  readonly onSort: (period: MarketOverviewPeriod) => void;
}) {
  const titleId = `market-overview-group-${group.id}-title`;
  const instruments = sort ? sortedBy(group.instruments, sort) : group.instruments;

  return (
    <section
      className={styles.group}
      data-group={group.id}
      data-selected={selected ? "true" : undefined}
      aria-labelledby={titleId}
      data-testid={`market-overview-group-${group.id}`}
    >
      <h3 id={titleId} className={styles.groupTitle}>
        {group.label}
      </h3>
      <div className={styles.groupBody}>
        <ColumnHeadings group={group} sort={sort} onSort={onSort} />
        <ol className={styles.list} aria-label={`${group.label} ETFs`}>
          {instruments.map((instrument) => (
            <InstrumentRow key={instrument.ticker} instrument={instrument} />
          ))}
        </ol>
      </div>
    </section>
  );
}

/**
 * The table's heading row: `Market`, the six periods and `Chart 1Y`, over the columns they name.
 *
 * The six periods are sort buttons: one click sorts the group by that period, strongest first; a
 * second click restores the catalog order. `Market` and `Chart 1Y` are captions for the eye only.
 * A row already says what each of its cells is — the fund by name, every return under its own
 * period label, the trend line in words — so assistive technology is told nothing twice.
 */
function ColumnHeadings({
  group,
  sort,
  onSort,
}: {
  readonly group: MarketOverviewGroupResponse;
  readonly sort: MarketOverviewPeriod | undefined;
  readonly onSort: (period: MarketOverviewPeriod) => void;
}) {
  return (
    <div
      className={styles.columnHeadings}
      data-testid={`market-overview-columns-${group.id}`}
    >
      <span className={styles.columnLabel} aria-hidden="true">
        Market
      </span>
      <div
        className={styles.periodHeadings}
        role="group"
        aria-label={`Sort ${group.label} by return`}
      >
        {MARKET_OVERVIEW_PERIODS.map((period) => (
          <button
            key={period}
            type="button"
            className={styles.columnHeading}
            aria-pressed={sort === period}
            data-active={sort === period ? "true" : undefined}
            title={`${PERIOD_NAMES[period]} return`}
            onClick={() => onSort(period)}
            data-testid={`market-overview-sort-${group.id}-${period}`}
          >
            <span className={styles.srOnly}>Sort by {PERIOD_NAMES[period]} return</span>
            {/* Before the label, so the label's right edge is the value column's right edge. */}
            <span className={styles.sortGlyph} aria-hidden="true">
              {sort === period ? "↓" : ""}
            </span>
            <span aria-hidden="true">{period}</span>
          </button>
        ))}
      </div>
      <span className={styles.columnLabel} data-column="chart" aria-hidden="true">
        Chart 1Y
      </span>
    </div>
  );
}

/**
 * One fund: the market it tracks, its six returns and its trailing-year trend line, in the order
 * the table's columns name them.
 *
 * The market's name comes first and the ticker follows it on the same line. Where the line is too
 * short for both, the name gives way with an ellipsis — the whole name stays in its tooltip — and
 * the ticker, which is what a reader searches by, is never cut.
 */
function InstrumentRow({
  instrument,
}: {
  readonly instrument: MarketOverviewInstrumentResponse;
}) {
  return (
    <li
      className={styles.row}
      data-status={instrument.status}
      data-testid={`market-overview-row-${instrument.ticker}`}
    >
      <div className={styles.identity}>
        <span
          className={styles.name}
          title={instrument.name}
          data-testid="market-overview-name"
        >
          {instrument.name}
        </span>
        <span className={styles.ticker}>
          (<span data-testid="market-overview-ticker">{instrument.ticker}</span>)
        </span>
        {instrument.status === "STALE" && instrument.sessionDate ? (
          <span
            className={styles.flag}
            data-tone="warning"
            title="This fund's latest close is older than the overview's"
            data-testid={`market-overview-stale-${instrument.ticker}`}
          >
            As of {formatSessionDate(instrument.sessionDate)}
          </span>
        ) : null}
        {instrument.status === "UNAVAILABLE" ? (
          <span
            className={styles.flag}
            data-testid={`market-overview-unavailable-${instrument.ticker}`}
          >
            No data
          </span>
        ) : null}
      </div>
      <dl className={styles.returns}>
        {MARKET_OVERVIEW_PERIODS.map((period) => {
          const value = instrument.returns[period];
          const formatted = formatReturn(value);
          return (
            <div key={period} className={styles.metric}>
              <dt className={styles.metricLabel}>
                <abbr title={PERIOD_NAMES[period]}>{period}</abbr>
              </dt>
              <dd
                className={styles.metricValue}
                data-tone={formatted.tone}
                data-testid={`market-overview-return-${instrument.ticker}-${period}`}
                title={describeReturn(period, value)}
              >
                {formatted.tone === "unavailable" ? (
                  <>
                    <span aria-hidden="true">{formatted.text}</span>
                    <span className={styles.srOnly}>not available</span>
                  </>
                ) : (
                  formatted.text
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      <div className={styles.trend}>
        {instrument.sparkline ? (
          <MarketSparkline
            values={instrument.sparkline.values}
            tone={sparklineTone(instrument)}
            idPrefix={`market-overview-${instrument.ticker}`}
            label={describeSparkline(instrument)}
          />
        ) : (
          <span className={styles.trendEmpty} aria-hidden="true" />
        )}
      </div>
    </li>
  );
}

/**
 * The loading shape: the real groups, row counts and row anatomy, built from the same classes as
 * the loaded rows with placeholders sized in `em`, so every row is the height it will be at every
 * width and nothing below the overview moves when the data lands.
 */
function OverviewSkeleton() {
  return (
    <div className={styles.groups} aria-hidden="true" data-testid="market-overview-loading">
      {MARKET_OVERVIEW_GROUP_IDS.map((id) => (
        <section
          key={id}
          className={styles.group}
          data-group={id}
          data-selected={id === "BENCHMARKS" ? "true" : undefined}
        >
          <div className={styles.groupTitle}>
            <Skeleton height="1.2em" width="8rem" />
          </div>
          <div className={styles.groupBody}>
            <div className={styles.columnHeadings} />
            <ol className={styles.list}>
              {Array.from({ length: MARKET_OVERVIEW_SKELETON_ROWS[id] }, (_, index) => (
                <li key={index} className={styles.row}>
                  <div className={styles.identity}>
                    <span className={styles.name}>
                      <Skeleton height="1.2em" width="9rem" />
                    </span>
                  </div>
                  <div className={styles.returns}>
                    {MARKET_OVERVIEW_PERIODS.map((period) => (
                      <div key={period} className={styles.metric}>
                        <span className={styles.metricLabel}>
                          <Skeleton height="1.2em" width="1.6rem" />
                        </span>
                        <span className={styles.metricValue}>
                          <Skeleton height="1.2em" width="3.2rem" />
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className={styles.trend}>
                    <Skeleton height="100%" width="100%" />
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>
      ))}
    </div>
  );
}

/** Highest return first; an unavailable return sorts last; ties keep the catalog order. */
function sortedBy(
  instruments: readonly MarketOverviewInstrumentResponse[],
  period: MarketOverviewPeriod,
): MarketOverviewInstrumentResponse[] {
  return instruments
    .map((instrument, index) => ({ instrument, index }))
    .sort((left, right) => {
      const a = left.instrument.returns[period];
      const b = right.instrument.returns[period];
      if (a === null || b === null) {
        return a === b ? left.index - right.index : a === null ? 1 : -1;
      }
      return b - a || left.index - right.index;
    })
    .map(({ instrument }) => instrument);
}

function isPeriod(value: string): value is MarketOverviewPeriod {
  return (MARKET_OVERVIEW_PERIODS as readonly string[]).includes(value);
}
