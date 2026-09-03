"use client";

import type {
  SelectableSeriesId,
  StockDetailsResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useMemo, useState } from "react";
import { PageContainer } from "../../../../components/layout/PageContainer";
import type { StockHistoryWindow } from "../api/stock-details-api";
import { useExtendedHistory } from "../hooks/use-extended-history";
import { useIndicatorSelection } from "../hooks/use-indicator-selection";
import { useStockDetails } from "../hooks/use-stock-details";
import { closeSeries } from "../utils/chart-series";
import {
  availableSeriesIds,
  buildOverlays,
  type SeriesSource,
} from "../utils/series-catalog";
import {
  DEFAULT_PRICE_RANGE,
  rangeExceedsWindow,
  rangeStartDate,
  sliceFromDate,
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
  // Measured against the window that was requested, not the last close inside it.
  const needsExtended = rangeExceedsWindow(range, window.from, window.to);
  // The long range asks for exactly its own start; only MAX is unbounded.
  const extended = useExtendedHistory(
    symbol,
    needsExtended,
    rangeStartDate(range, window.to),
    security.ipoDate,
  );
  const extendedHistory = extended.history;
  const prices =
    needsExtended && extendedHistory ? extendedHistory.prices : details.prices;
  const source: SeriesSource =
    needsExtended && extendedHistory
      ? {
          technicals: extendedHistory.technicals,
          blends: extendedHistory.intrinsicValueBlends,
          intrinsicValues: extendedHistory.intrinsicValues,
        }
      : {
          technicals: details.technicals,
          blends: details.intrinsicValueBlends,
          intrinsicValues: details.intrinsicValues,
        };

  // Option availability is answered from the always-loaded details window, so the picker does not
  // reshuffle between enabled and disabled while a longer history is still loading.
  const detailsSource: SeriesSource = useMemo(
    () => ({
      technicals: details.technicals,
      blends: details.intrinsicValueBlends,
      intrinsicValues: details.intrinsicValues,
    }),
    [details.technicals, details.intrinsicValueBlends, details.intrinsicValues],
  );
  const available = useMemo(
    () => availableSeriesIds(detailsSource),
    [detailsSource],
  );
  const { selected, toggle } = useIndicatorSelection(available);

  const rangeStart = rangeStartDate(range, latestDate);
  const chartPoints = useMemo(
    () => sliceFromDate(closeSeries(prices), rangeStart, (point) => point.date),
    [prices, rangeStart],
  );
  const chartOverlays = useMemo(
    () =>
      buildOverlays(source, selected, (points) =>
        sliceFromDate(points, rangeStart, (point) => point.date),
      ),
    [source, selected, rangeStart],
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
            loading={needsExtended && extended.status === "loading"}
            ariaLabel={`${security.symbol} daily closing price chart, ${range} range`}
          />

          {needsExtended && extended.status === "error" ? (
            <p className={styles.chartError} role="alert">
              The full price history could not be loaded.{" "}
              <button
                type="button"
                className={styles.inlineRetry}
                onClick={extended.retry}
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
