"use client";

import {
  MARKET_OVERVIEW_GROUP_IDS,
  MARKET_OVERVIEW_PERIODS,
  type MarketOverviewGroupId,
  type MarketOverviewGroupResponse,
  type MarketOverviewInstrumentResponse,
  type MarketOverviewPeriod,
  type MarketOverviewResponse,
} from "@intrinsic/contracts";
import { useState, type ReactNode } from "react";
import { EmptyState } from "../../../components/ui/EmptyState";
import { SegmentedControl } from "../../../components/ui/SegmentedControl";
import { SelectControl } from "../../../components/ui/SelectControl";
import { Skeleton } from "../../../components/ui/Skeleton";
import forms from "../../../components/ui/forms.module.css";
import { useMarketOverview } from "../hooks/use-market-overview";
import {
  describeReturn,
  describeSparkline,
  formatLongSessionDate,
  formatReturn,
  formatSessionDate,
  PERIOD_NAMES,
  sparklineTone,
} from "../utils/format";
import { MarketSparkline } from "./MarketSparkline";
import styles from "./MarketOverview.module.css";

type SortState = Partial<Record<MarketOverviewGroupId, MarketOverviewPeriod>>;

/** Footnote markers for instruments that carry a note, in display order. */
const NOTE_MARKERS = ["*", "†", "‡", "§"] as const;

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
 * - **≥ 1,280px** — Benchmarks, Sector Performance and Macro & Alternatives side by side, each a
 *   card of two-line rows: ticker, name and trend line on the first, the six returns under column
 *   headings on the second;
 * - **880–1,279px** — Benchmarks beside Macro & Alternatives, Sector Performance across both below
 *   them with its rows in two columns, so no row is stretched to the full page;
 * - **< 880px** — a category selector (a choice of *group*, never of period) and one purpose-built
 *   card per ETF: identity, a wider trend line, and the six returns as a labelled 3 × 2 grid.
 *
 * Everything is end-of-day and price-only, and the footnote says so. The numbers come from the API
 * as computed; this component formats and arranges them and calculates nothing.
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
        <div className={styles.heading}>
          <h2 id="market-overview-title" className={styles.title}>
            Market overview
          </h2>
          <p className={styles.meta} data-testid="market-overview-asof">
            {ready && overview.asOf ? (
              <>
                End-of-day price returns <span aria-hidden="true">·</span> As of
                the close on{" "}
                <time dateTime={overview.asOf}>
                  {formatLongSessionDate(overview.asOf)}
                </time>
              </>
            ) : (
              "End-of-day price returns"
            )}
          </p>
        </div>
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
        <>
          <div className={styles.groups}>
            {groups.map((group) => (
              <GroupCard
                key={group.id}
                group={group}
                selected={group.id === category}
                sort={sorts[group.id]}
                onSort={(period) => toggleSort(group.id, period)}
                markers={noteMarkers(groups)}
              />
            ))}
          </div>
          <Footnote overview={overview} />
        </>
      ) : null}
    </section>
  );
}

function GroupCard({
  group,
  selected,
  sort,
  onSort,
  markers,
}: {
  readonly group: MarketOverviewGroupResponse;
  readonly selected: boolean;
  readonly sort: MarketOverviewPeriod | undefined;
  readonly onSort: (period: MarketOverviewPeriod) => void;
  readonly markers: ReadonlyMap<string, string>;
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
      <div className={styles.groupBody} data-split={group.id === "US_SECTORS" ? "true" : undefined}>
        <ColumnHeadings group={group} sort={sort} onSort={onSort} />
        {group.id === "US_SECTORS" ? (
          // The second column's headings, for the band where the sector rows run in two columns.
          // Decorative there: the first set already names the columns and owns the sort buttons.
          <ColumnHeadings group={group} sort={sort} onSort={onSort} echo />
        ) : null}
        <ol className={styles.list} aria-label={`${group.label} ETFs`}>
          {instruments.map((instrument) => (
            <InstrumentRow
              key={instrument.ticker}
              instrument={instrument}
              marker={markers.get(instrument.ticker)}
            />
          ))}
        </ol>
      </div>
    </section>
  );
}

/**
 * The six period headings over the returns, as sort buttons: one click sorts the group by that
 * period, strongest first; a second click restores the catalog order.
 */
function ColumnHeadings({
  group,
  sort,
  onSort,
  echo,
}: {
  readonly group: MarketOverviewGroupResponse;
  readonly sort: MarketOverviewPeriod | undefined;
  readonly onSort: (period: MarketOverviewPeriod) => void;
  readonly echo?: boolean;
}) {
  return (
    <div
      className={styles.columnHeadings}
      data-echo={echo ? "true" : undefined}
      {...(echo
        ? { "aria-hidden": true }
        : { role: "group", "aria-label": `Sort ${group.label} by return` })}
    >
      {MARKET_OVERVIEW_PERIODS.map((period) => (
        <button
          key={period}
          type="button"
          className={styles.columnHeading}
          aria-pressed={sort === period}
          data-active={sort === period ? "true" : undefined}
          title={`${PERIOD_NAMES[period]} return`}
          tabIndex={echo ? -1 : undefined}
          onClick={() => onSort(period)}
          {...(echo ? {} : { "data-testid": `market-overview-sort-${group.id}-${period}` })}
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
  );
}

function InstrumentRow({
  instrument,
  marker,
}: {
  readonly instrument: MarketOverviewInstrumentResponse;
  readonly marker: string | undefined;
}) {
  const noteId = marker ? `market-overview-note-${instrument.ticker}` : undefined;

  return (
    <li
      className={styles.row}
      data-status={instrument.status}
      data-testid={`market-overview-row-${instrument.ticker}`}
      {...(noteId ? { "aria-describedby": noteId } : {})}
    >
      <div className={styles.identity}>
        <span className={styles.ticker} data-testid="market-overview-ticker">
          {instrument.ticker}
        </span>
        <span className={styles.name} title={instrument.name}>
          {instrument.name}
          {marker ? (
            <span className={styles.marker} aria-hidden="true">
              {marker}
            </span>
          ) : null}
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
    </li>
  );
}

function Footnote({ overview }: { readonly overview: MarketOverviewResponse }) {
  const markers = noteMarkers(overview.groups);
  const noted = overview.groups
    .flatMap((group) => group.instruments)
    .filter((instrument) => instrument.note && markers.has(instrument.ticker));

  return (
    <FootnoteText>
      {noted.map((instrument) => (
        <p key={instrument.ticker} id={`market-overview-note-${instrument.ticker}`}>
          <span aria-hidden="true">{markers.get(instrument.ticker)} </span>
          {instrument.ticker}: {instrument.note}
        </p>
      ))}
    </FootnoteText>
  );
}

/**
 * What every number above is, in one paragraph. Static, so it is on screen while the data loads as
 * well; the instruments' own notes follow it once they are known, in a line reserved for them.
 */
function FootnoteText({ children }: { readonly children?: ReactNode }) {
  return (
    <div className={styles.footnote} data-testid="market-overview-footnote">
      <p>
        Price returns from split-adjusted end-of-day closes of exchange-traded funds, excluding
        dividends and other distributions. Fund prices are share prices, not index levels. 1W
        covers 7 calendar days; YTD runs from the previous year&apos;s final close. Trend lines
        show the trailing year, weekly.
      </p>
      <div className={styles.notes}>{children}</div>
    </div>
  );
}

/**
 * The loading shape: the real groups, row counts, row anatomy and footnote, built from the same
 * classes as the loaded rows with placeholders sized in `em`, so every row is the height it will
 * be at every width and nothing below the overview moves when the data lands.
 */
function OverviewSkeleton() {
  return (
    <>
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
            <div
              className={styles.groupBody}
              data-split={id === "US_SECTORS" ? "true" : undefined}
            >
              <div className={styles.columnHeadings} />
              {id === "US_SECTORS" ? (
                <div className={styles.columnHeadings} data-echo="true" />
              ) : null}
              <ol className={styles.list}>
                {Array.from({ length: MARKET_OVERVIEW_SKELETON_ROWS[id] }, (_, index) => (
                  <li key={index} className={styles.row}>
                    <div className={styles.identity}>
                      <span className={styles.ticker}>
                        <Skeleton height="1.2em" width="9rem" />
                      </span>
                    </div>
                    <div className={styles.trend}>
                      <Skeleton height="100%" width="100%" />
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
                  </li>
                ))}
              </ol>
            </div>
          </section>
        ))}
      </div>
      <FootnoteText />
    </>
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

function noteMarkers(
  groups: readonly MarketOverviewGroupResponse[],
): ReadonlyMap<string, string> {
  const markers = new Map<string, string>();
  for (const instrument of groups.flatMap((group) => group.instruments)) {
    const marker = NOTE_MARKERS[markers.size];
    if (instrument.note && marker) {
      markers.set(instrument.ticker, marker);
    }
  }
  return markers;
}

function isPeriod(value: string): value is MarketOverviewPeriod {
  return (MARKET_OVERVIEW_PERIODS as readonly string[]).includes(value);
}
