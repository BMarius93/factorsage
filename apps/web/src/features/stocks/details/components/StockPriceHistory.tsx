"use client";

import {
  findFundamentalMetric,
  findValuationRatio,
  type FundamentalMetricId,
  type SelectableSeriesId,
  type StockDetailsResponse,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SectionCard } from "../../../../components/ui/SectionCard";
import { Skeleton } from "../../../../components/ui/Skeleton";
import type { StockHistoryWindow } from "../api/stock-details-api";
import { useFundamentalHistory } from "../hooks/use-fundamental-history";
import { useIndicatorSelection } from "../hooks/use-indicator-selection";
import type { SeriesHistoryStatus } from "../hooks/use-series-history";
import { useStockHistory } from "../hooks/use-stock-history";
import { useValuationHistory } from "../hooks/use-valuation-history";
import {
  closeSeries,
  relativeVolumeByDate,
  volumeSeries,
} from "../utils/chart-series";
import { buildFundamentalSeries } from "../utils/fundamental-series";
import { historyRequestStart } from "../utils/history-window";
import {
  DEFAULT_PRICE_RANGE,
  rangeStartDate,
  type PriceRangeKey,
} from "../utils/price-ranges";
import {
  availableSeriesIds,
  buildOverlays,
  type SeriesSource,
} from "../utils/series-catalog";
import { buildValuationSeries } from "../utils/valuation-series";
import { ChartKey } from "./ChartKey";
import { IndicatorsMenu } from "./IndicatorsMenu";
import { StockPriceChart } from "./StockPriceChart";
import { StockRangeSelector } from "./StockRangeSelector";
import styles from "./StockPriceHistory.module.css";

const TITLE = "Price history";
const CAPTION = "Daily closing prices · End-of-day data";

type StockPriceHistoryProps = {
  readonly symbol: string;
  /** The chart's opening window, as the composite endpoint returned it. */
  readonly details: StockDetailsResponse;
  /** The bounded window `details` was requested for. */
  readonly window: StockHistoryWindow;
  /** The one valuation ratio in its own pane — chosen here or from a financial card. */
  readonly valuation: ValuationRatioId | null;
  readonly onChooseValuation: (id: ValuationRatioId | null) => void;
  /** The one Fundamental Metric in its own pane — chosen here or from a financial card. */
  readonly fundamental: FundamentalMetricId | null;
  readonly onChooseFundamental: (id: FundamentalMetricId | null) => void;
};

/**
 * The Price History section: the chart, its range and `Indicators` controls, and every history it
 * extends on demand.
 *
 * Its data is its own — the composite one-year window, then older windows as the viewport asks — so
 * it renders the moment that window arrives, whatever the financial cards are doing, and the cards
 * render without waiting for it. The overlay selection lives here because it depends on the loaded
 * history; the valuation-ratio and Fundamental-Metric panes are chosen by the page, so a card can
 * choose one while this section is still loading and it applies as soon as the chart mounts.
 */
export function StockPriceHistory({
  symbol,
  details,
  window,
  valuation,
  onChooseValuation,
  fundamental,
  onChooseFundamental,
}: StockPriceHistoryProps) {
  const [range, setRange] = useState<PriceRangeKey>(DEFAULT_PRICE_RANGE);
  const { security } = details;
  const latestDate = details.prices.at(-1)?.date ?? window.to;

  // Everything the chart draws, extended backwards on demand. The page opened on the composite
  // endpoint's bounded window; from here the viewport decides what else is loaded.
  const initial = useMemo(
    () => ({
      prices: details.prices,
      technicals: details.technicals,
      intrinsicValues: details.intrinsicValues,
      intrinsicValueBlends: details.intrinsicValueBlends,
    }),
    [details],
  );
  const loaded = useStockHistory({
    symbol,
    bounds: details.history,
    initial,
    initialFrom: window.from,
  });

  // The window a selected range asks to see. `MAX` is the whole permitted horizon — the 30-year
  // product limit, or this security's listing date when that is later — and no longer unbounded.
  //
  // Anchored to the window the page was loaded for, never to the last close inside it. The two
  // differ by however long the market has been closed, so anchoring to the close would put the
  // default one-year range a few days before the year that was already loaded — and every page
  // view would open with a history request for those few days.
  const frameFrom = rangeStartDate(range, window.to) ?? loaded.historyStart;
  const { requestFrom } = loaded;

  // Whether the history a selected range asks for is all in. A calendar start rarely lands on a
  // trading day, so this is answered from what has been *asked for*, not from the oldest bar —
  // and exhaustion counts, because a range reaching past a security's first trading day is as
  // satisfied as it will ever be.
  const frameLoaded = loaded.exhausted || loaded.loadedFrom <= frameFrom;

  // Picking a range that reaches past what is loaded is a history request like any other; the
  // chart keeps showing what it already has while the rest arrives.
  useEffect(() => {
    requestFrom(frameFrom);
  }, [requestFrom, frameFrom]);

  // Panning or zooming past the oldest loaded bar. The chart reports how much empty space is on
  // screen and this turns it into a bounded older window, never a jump to the whole horizon.
  const onReachHistoryEdge = useCallback(
    (barsBeforeLoaded: number) => {
      const next = historyRequestStart({
        loadedFrom: loaded.loadedFrom,
        barsBeforeLoaded,
        historyStart: loaded.historyStart,
      });
      if (next) {
        requestFrom(next);
      }
    },
    [requestFrom, loaded.loadedFrom, loaded.historyStart],
  );

  const source: SeriesSource = useMemo(
    () => ({
      technicals: loaded.history.technicals,
      blends: loaded.history.intrinsicValueBlends,
      intrinsicValues: loaded.history.intrinsicValues,
    }),
    [loaded.history],
  );
  // Availability is answered over everything loaded, so a series that only becomes evaluable once
  // older history arrives stops being reported as unavailable. It never narrows: the chosen set
  // survives, because a widening load can only add.
  const available = useMemo(() => availableSeriesIds(source), [source]);
  const { selected, toggle } = useIndicatorSelection(available);

  const chartPoints = useMemo(
    () => closeSeries(loaded.history.prices),
    [loaded.history.prices],
  );
  // Volume rides on the same canonical bars as the close, so it needs no second request and is
  // already aligned to the chart's session axis.
  const chartVolume = useMemo(
    () => volumeSeries(loaded.history.prices),
    [loaded.history.prices],
  );
  // The precomputed Relative Volume readings, taken straight off the daily technical rows. The
  // page never calculates one: the backend materialized them when the derived state was prepared.
  const chartRelativeVolume = useMemo(
    () => relativeVolumeByDate(loaded.history.technicals),
    [loaded.history.technicals],
  );
  // The close series is the chart's trading-day axis: every overlay is aligned to it so a day a
  // series has no value for stays visibly absent instead of being drawn through.
  const tradingDays = useMemo(
    () => chartPoints.map((point) => point.date),
    [chartPoints],
  );
  const chartOverlays = useMemo(
    () => buildOverlays(source, selected, tradingDays),
    [source, selected, tradingDays],
  );

  // The chosen valuation ratio, and only it — never the other four — over exactly the history the
  // price chart holds, by the same rule as the Fundamental Metric below: from the loaded-from
  // watermark to the newest bar, the gap alone when older history arrives, nothing until a ratio is
  // chosen. Every reading is the backend's, computed with the calculation a Strategy reads; where
  // the line breaks is decided there, never here.
  const valuationHistory = useValuationHistory({
    symbol,
    ratioId: valuation,
    from: loaded.loadedFrom,
    to: tradingDays.at(-1) ?? window.to,
  });
  const valuationRatio =
    valuation === null ? undefined : findValuationRatio(valuation);
  const chartValuation = useMemo(
    () =>
      valuation !== null && valuationHistory.loaded
        ? buildValuationSeries(valuation, valuationHistory.rows, tradingDays)
        : undefined,
    [valuation, valuationHistory.loaded, valuationHistory.rows, tradingDays],
  );
  const valuationDrawn =
    chartValuation !== undefined && chartValuation.points.length > 0;

  // The chosen Fundamental Metric, and only it, over exactly the history the price chart holds:
  // from the loaded-from watermark to the newest bar on the chart, so the metric never answers for
  // a session the price series does not have, and when older price history arrives the metric's
  // gap is asked for too. Nothing is loaded until a metric is chosen, and nothing about it is
  // calculated here — every session arrives as the backend materialized it.
  const fundamentalHistory = useFundamentalHistory({
    symbol,
    metricId: fundamental,
    from: loaded.loadedFrom,
    to: tradingDays.at(-1) ?? window.to,
  });
  const fundamentalMetric =
    fundamental === null ? undefined : findFundamentalMetric(fundamental);
  const chartFundamental = useMemo(
    () =>
      fundamental !== null && fundamentalHistory.loaded
        ? buildFundamentalSeries(
            fundamental,
            fundamentalHistory.rows,
            tradingDays,
          )
        : undefined,
    [
      fundamental,
      fundamentalHistory.loaded,
      fundamentalHistory.rows,
      tradingDays,
    ],
  );
  const fundamentalDrawn =
    chartFundamental !== undefined && chartFundamental.points.length > 0;

  // The legend and the picker read the same assignment, so a swatch always matches its line.
  const overlayColors = useMemo(
    () => new Map(chartOverlays.map((overlay) => [overlay.id, overlay.color])),
    [chartOverlays],
  );
  // The persistent key names what is drawn, in the panes' order: the overlays, then the valuation
  // ratio and the fundamental once each line is.
  const keyEntries = useMemo(
    () => [
      ...chartOverlays,
      ...(chartValuation && valuationDrawn ? [chartValuation] : []),
      ...(chartFundamental && fundamentalDrawn ? [chartFundamental] : []),
    ],
    [
      chartOverlays,
      chartValuation,
      valuationDrawn,
      chartFundamental,
      fundamentalDrawn,
    ],
  );
  const colorOf = (id: SelectableSeriesId) => overlayColors.get(id);

  return (
    <SectionCard
      id="price-history"
      title={TITLE}
      caption={CAPTION}
      aside={
        <div className={styles.chartTools}>
          <StockRangeSelector value={range} onChange={setRange} />
          <IndicatorsMenu
            selected={selected}
            available={available}
            onToggle={toggle}
            colorOf={colorOf}
            valuation={valuation}
            onChooseValuation={onChooseValuation}
            fundamental={fundamental}
            onChooseFundamental={onChooseFundamental}
          />
        </div>
      }
    >
      <StockPriceChart
        points={chartPoints}
        volume={chartVolume}
        relativeVolume={chartRelativeVolume}
        overlays={chartOverlays}
        {...(chartValuation ? { valuation: chartValuation } : {})}
        // Only while the chosen ratio has nothing yet, as for the fundamental below.
        valuationPending={
          valuation !== null &&
          valuationHistory.status === "loading" &&
          !valuationHistory.loaded
        }
        {...(chartFundamental ? { fundamental: chartFundamental } : {})}
        // Only while the chosen metric has nothing yet: an older gap of a metric already on
        // screen, drawn or not, holds no extra room.
        fundamentalPending={
          fundamental !== null &&
          fundamentalHistory.status === "loading" &&
          !fundamentalHistory.loaded
        }
        currency={security.currency}
        loading={loaded.status === "loading"}
        // The two moments a range is allowed to reframe the chart: when it is picked, and
        // when the history it asked for has arrived. Panning and zooming in between stays
        // the user's, through overlay toggles and data updates alike.
        fitKey={`${range}|${frameLoaded}`}
        frameFrom={frameFrom}
        frameTo={latestDate}
        // The bound the API reports, passed through untouched: it bounds the viewport for the
        // same reason it bounds the requests, and recomputing it here would be a second answer.
        historyStart={loaded.historyStart}
        historyExhausted={loaded.exhausted}
        onReachHistoryEdge={onReachHistoryEdge}
        ariaLabel={`${security.symbol} daily closing price chart, ${range} range`}
      />
      <ChartKey overlays={keyEntries} />
      {valuationRatio ? (
        <PaneSeriesStatus
          label={valuationRatio.label}
          status={valuationHistory.status}
          loaded={valuationHistory.loaded}
          drawn={valuationDrawn}
          onRetry={valuationHistory.retry}
          testId="valuation-status"
        />
      ) : null}
      {fundamentalMetric ? (
        <PaneSeriesStatus
          label={fundamentalMetric.label}
          status={fundamentalHistory.status}
          loaded={fundamentalHistory.loaded}
          drawn={fundamentalDrawn}
          onRetry={fundamentalHistory.retry}
          testId="fundamental-status"
        />
      ) : null}

      {loaded.status === "error" ? (
        <p className={styles.chartError} role="alert">
          Older history could not be loaded.{" "}
          <button
            type="button"
            className={styles.inlineRetry}
            onClick={loaded.retry}
          >
            Try again
          </button>
        </p>
      ) : null}
    </SectionCard>
  );
}

/**
 * The Price History section while its opening window is on its way: the same frame, title and
 * caption, with placeholders exactly the size of the controls and the chart they stand in for, so
 * nothing above or below it moves when the chart arrives.
 */
export function PriceHistoryLoading() {
  return (
    <SectionCard
      id="price-history"
      title={TITLE}
      caption={CAPTION}
      aside={
        <div className={styles.chartTools} aria-hidden="true">
          <span className={styles.rangePlaceholder}>
            <Skeleton height="100%" radius="control" />
          </span>
          <span className={styles.indicatorsPlaceholder}>
            <Skeleton height="100%" radius="control" />
          </span>
        </div>
      }
    >
      <div
        className={styles.chartPlaceholder}
        role="status"
        aria-label="Loading the price chart"
        data-testid="price-history-loading"
      >
        <Skeleton height="100%" />
      </div>
      <div className={styles.keyPlaceholder} aria-hidden="true" />
    </SectionCard>
  );
}

/**
 * The Price History section when its opening window could not be loaded: said here, in the chart's
 * own place and size, with a retry that asks for the chart's window again and nothing else. The
 * financial cards are unaffected.
 */
export function PriceHistoryFailed({
  onRetry,
}: {
  readonly onRetry: () => void;
}) {
  return (
    <SectionCard id="price-history" title={TITLE} caption={CAPTION}>
      <div className={styles.chartFailed} data-testid="price-history-error">
        <p className={styles.failedTitle} role="alert">
          The price chart could not be loaded.
        </p>
        <p className={styles.failedBody}>
          This is usually temporary. The financial summary below is not
          affected.
        </p>
        <button type="button" className={styles.retryButton} onClick={onRetry}>
          Try again
        </button>
      </div>
      <div className={styles.keyPlaceholder} aria-hidden="true" />
    </SectionCard>
  );
}

/**
 * What a pane of its own cannot say for itself — the chosen valuation ratio's or Fundamental
 * Metric's: that it is still on its way, that it could not be loaded, or that it has no value
 * anywhere in the loaded history.
 *
 * Loading is never reported as "no values", and a failed request is never reported as the series
 * being unavailable — the first is a wait and the second a fact about the company, and neither is
 * the other. Once the line is drawn there is nothing to add: the pane shows its own gaps.
 */
function PaneSeriesStatus({
  label,
  status,
  loaded,
  drawn,
  onRetry,
  testId,
}: {
  readonly label: string;
  readonly status: SeriesHistoryStatus;
  readonly loaded: boolean;
  readonly drawn: boolean;
  readonly onRetry: () => void;
  readonly testId: string;
}) {
  if (status === "error") {
    return (
      <p className={styles.chartError} role="alert">
        {loaded ? `Older ${label} history` : label} could not be loaded.{" "}
        <button type="button" className={styles.inlineRetry} onClick={onRetry}>
          Try again
        </button>
      </p>
    );
  }
  if (!loaded || status === "loading") {
    // A drawn line extending into older history needs no announcement, exactly as the price
    // chart's own older windows arrive quietly; anything else is waiting, not empty.
    return drawn ? null : (
      <p className={styles.seriesStatus} role="status" data-testid={testId}>
        Loading {label}…
      </p>
    );
  }
  if (!drawn) {
    return (
      <p className={styles.seriesStatus} role="status" data-testid={testId}>
        {label} is unavailable for every session in the loaded history.
      </p>
    );
  }
  return null;
}
