"use client";

import type {
  SelectableSeriesId,
  StockDetailsResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageContainer } from "../../../../components/layout/PageContainer";
import type { StockHistoryWindow } from "../api/stock-details-api";
import { useIndicatorSelection } from "../hooks/use-indicator-selection";
import { useStockDetails } from "../hooks/use-stock-details";
import { useStockHistory } from "../hooks/use-stock-history";
import { closeSeries } from "../utils/chart-series";
import { historyRequestStart } from "../utils/history-window";
import {
  availableSeriesIds,
  buildOverlays,
  type SeriesSource,
} from "../utils/series-catalog";
import {
  DEFAULT_PRICE_RANGE,
  rangeStartDate,
  type PriceRangeKey,
} from "../utils/price-ranges";
import { summarizePrices } from "../utils/price-summary";
import { selectLatestTechnicals } from "../utils/technicals";
import { selectLatestValuations } from "../utils/valuation";
import { IndicatorsMenu } from "./IndicatorsMenu";
import { StockDetailsSkeleton } from "./StockDetailsSkeleton";
import { StockHeader } from "./StockHeader";
import { StockMetrics } from "./StockMetrics";
import { StockPriceChart } from "./StockPriceChart";
import { StockRangeSelector } from "./StockRangeSelector";
import { StockStatusPanel } from "./StockStatusPanel";
import { StockTechnicalSummary } from "./StockTechnicalSummary";
import { StockValuationSummary } from "./StockValuationSummary";
import styles from "./StockDetails.module.css";

type StockDetailsProps = {
  /** Normalized upper-case ticker from the route. */
  readonly symbol: string;
};

/**
 * Stock Details page feature: resolves the symbol against the real API and renders the identity
 * header, price history chart, valuation, technicals, and key facts — or the matching loading,
 * not-found, and error states.
 */
export function StockDetails({ symbol }: StockDetailsProps) {
  const state = useStockDetails(symbol);

  if (state.status === "loading") {
    return (
      <PageContainer>
        <StockDetailsSkeleton />
      </PageContainer>
    );
  }

  if (state.status === "not-found") {
    return (
      <PageContainer>
        <StockStatusPanel
          title="Stock not found"
          description={
            symbol === ""
              ? "This page needs a stock symbol. Use the search above to find a supported stock."
              : `${symbol} is not in the supported stock catalog. Check the spelling or use the search above to find a supported stock.`
          }
        >
          <Link className={styles.actionLink} href="/dashboard">
            Back to Dashboard
          </Link>
        </StockStatusPanel>
      </PageContainer>
    );
  }

  if (state.status === "error" || !state.details || !state.window) {
    return (
      <PageContainer>
        <StockStatusPanel
          title="Something went wrong"
          description={`${symbol} could not be loaded right now. This is usually temporary — try again in a moment.`}
        >
          <button
            type="button"
            className={styles.retryButton}
            onClick={state.retry}
          >
            Try again
          </button>
          <Link className={styles.actionLink} href="/dashboard">
            Back to Dashboard
          </Link>
        </StockStatusPanel>
      </PageContainer>
    );
  }

  return (
    <StockDetailsContent
      key={symbol}
      symbol={symbol}
      details={state.details}
      window={state.window}
    />
  );
}

type StockDetailsContentProps = {
  readonly symbol: string;
  readonly details: StockDetailsResponse;
  readonly window: StockHistoryWindow;
};

function StockDetailsContent({
  symbol,
  details,
  window,
}: StockDetailsContentProps) {
  const [range, setRange] = useState<PriceRangeKey>(DEFAULT_PRICE_RANGE);

  const { security, profile } = details;
  const summary = useMemo(() => summarizePrices(details.prices), [details.prices]);
  const valuationSnapshot = useMemo(
    () =>
      selectLatestValuations(details.intrinsicValues, details.intrinsicValueBlends),
    [details.intrinsicValues, details.intrinsicValueBlends],
  );
  const technicalSnapshot = useMemo(
    () => selectLatestTechnicals(details.technicals),
    [details.technicals],
  );

  const latestDate = summary?.latestDate ?? window.to;

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
  const chartOverlays = useMemo(
    () => buildOverlays(source, selected),
    [source, selected],
  );
  // The legend and the picker read the same assignment, so a swatch always matches its line.
  const overlayColors = useMemo(
    () => new Map(chartOverlays.map((overlay) => [overlay.id, overlay.color])),
    [chartOverlays],
  );
  const colorOf = (id: SelectableSeriesId) => overlayColors.get(id);

  return (
    <PageContainer>
      <div className={styles.page}>
        <StockHeader security={security} {...(summary ? { summary } : {})} />

        <section className={styles.chartCard} aria-labelledby="price-history-title">
          <div className={styles.chartHeading}>
            <div>
              <h2 className={styles.chartTitle} id="price-history-title">
                Price history
              </h2>
              <p className={styles.chartCaption}>
                Daily closing prices · End-of-day data
              </p>
            </div>
            <div className={styles.chartTools}>
              <StockRangeSelector value={range} onChange={setRange} />
              <IndicatorsMenu
                selected={selected}
                available={available}
                onToggle={toggle}
                colorOf={colorOf}
              />
            </div>
          </div>

          <StockPriceChart
            points={chartPoints}
            overlays={chartOverlays}
            currency={security.currency}
            loading={loaded.status === "loading"}
            // The two moments a range is allowed to reframe the chart: when it is picked, and
            // when the history it asked for has arrived. Panning and zooming in between stays
            // the user's, through overlay toggles and data updates alike.
            fitKey={`${range}|${frameLoaded}`}
            frameFrom={frameFrom}
            frameTo={latestDate}
            historyExhausted={loaded.exhausted}
            onReachHistoryEdge={onReachHistoryEdge}
            ariaLabel={`${security.symbol} daily closing price chart, ${range} range`}
          />

          {loaded.status === "error" ? (
            <p className={styles.chartError} role="alert">
              Older price history could not be loaded.{" "}
              <button
                type="button"
                className={styles.inlineRetry}
                onClick={loaded.retry}
              >
                Try again
              </button>
            </p>
          ) : null}
        </section>

        <div className={styles.columns}>
          <div className={styles.column}>
            <StockValuationSummary
              {...(valuationSnapshot ? { snapshot: valuationSnapshot } : {})}
              {...(summary
                ? {
                    latestClose: {
                      value: summary.latestClose,
                      date: summary.latestDate,
                    },
                  }
                : {})}
              currency={security.currency}
            />
            {technicalSnapshot ? (
              <StockTechnicalSummary
                snapshot={technicalSnapshot}
                {...(summary ? { latestClose: summary.latestClose } : {})}
                currency={security.currency}
              />
            ) : null}
          </div>
          <div className={styles.column}>
            <StockMetrics
              security={security}
              {...(profile ? { profile } : {})}
              {...(summary ? { summary } : {})}
            />
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
