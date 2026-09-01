"use client";

import type { StockDetailsResponse } from "@intrinsic/contracts";
import Link from "next/link";
import { useMemo, useState } from "react";
import { PageContainer } from "../../../../components/layout/PageContainer";
import type { StockHistoryWindow } from "../api/stock-details-api";
import { useExtendedHistory } from "../hooks/use-extended-history";
import { useStockDetails } from "../hooks/use-stock-details";
import {
  blendSeries,
  closeSeries,
  technicalSeries,
  type ChartOverlaySeries,
} from "../utils/chart-series";
import { CHART_COLORS } from "../utils/chart-theme";
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

type OverlayId = "intrinsic" | "sma50" | "sma200";

type OverlayToggleProps = {
  readonly label: string;
  readonly color: string;
  readonly pressed: boolean;
  readonly onToggle: () => void;
};

function OverlayToggle({ label, color, pressed, onToggle }: OverlayToggleProps) {
  return (
    <button
      type="button"
      className={styles.overlayToggle}
      aria-pressed={pressed}
      onClick={onToggle}
    >
      <span
        className={styles.overlayDot}
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      {label}
    </button>
  );
}

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
  const [overlaysEnabled, setOverlaysEnabled] = useState<
    Record<OverlayId, boolean>
  >({ intrinsic: true, sma50: false, sma200: false });

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
  const needsExtended = rangeExceedsWindow(range, window.from, latestDate);
  const extended = useExtendedHistory(symbol, needsExtended, security.ipoDate);
  const extendedHistory =
    extended.status === "ready" ? extended.history : undefined;
  const source =
    needsExtended && extendedHistory
      ? {
          prices: extendedHistory.prices,
          technicals: extendedHistory.technicals,
          blends: extendedHistory.intrinsicValueBlends,
        }
      : {
          prices: details.prices,
          technicals: details.technicals,
          blends: details.intrinsicValueBlends,
        };

  const rangeStart = rangeStartDate(range, latestDate);
  const chartPoints = useMemo(
    () =>
      sliceFromDate(closeSeries(source.prices), rangeStart, (point) => point.date),
    [source.prices, rangeStart],
  );
  const chartOverlays = useMemo(() => {
    const list: ChartOverlaySeries[] = [];
    if (overlaysEnabled.intrinsic) {
      const points = sliceFromDate(
        blendSeries(source.blends, "BALANCED"),
        rangeStart,
        (point) => point.date,
      );
      if (points.length > 0) {
        list.push({
          id: "intrinsic",
          label: "Intrinsic (Balanced)",
          color: CHART_COLORS.intrinsic,
          points,
        });
      }
    }
    for (const overlay of [
      { id: "sma50" as const, key: "sma50d" as const, label: "SMA 50", color: CHART_COLORS.sma50 },
      { id: "sma200" as const, key: "sma200d" as const, label: "SMA 200", color: CHART_COLORS.sma200 },
    ]) {
      if (!overlaysEnabled[overlay.id]) {
        continue;
      }
      const points = sliceFromDate(
        technicalSeries(source.technicals, overlay.key),
        rangeStart,
        (point) => point.date,
      );
      if (points.length > 0) {
        list.push({
          id: overlay.id,
          label: overlay.label,
          color: overlay.color,
          points,
        });
      }
    }
    return list;
  }, [overlaysEnabled, source.blends, source.technicals, rangeStart]);

  // Toggle availability comes from the always-loaded details window so controls do not appear and
  // disappear as range data loads.
  const hasIntrinsicOverlay = details.intrinsicValueBlends.some(
    (blend) => blend.blendId === "BALANCED",
  );
  const hasSma50 = details.technicals.some((row) => row.sma50d !== undefined);
  const hasSma200 = details.technicals.some((row) => row.sma200d !== undefined);
  const toggleOverlay = (id: OverlayId) =>
    setOverlaysEnabled((current) => ({ ...current, [id]: !current[id] }));

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
              {hasIntrinsicOverlay || hasSma50 || hasSma200 ? (
                <div className={styles.overlayToggles} role="group" aria-label="Chart overlays">
                  {hasIntrinsicOverlay ? (
                    <OverlayToggle
                      label="Intrinsic value"
                      color={CHART_COLORS.intrinsic}
                      pressed={overlaysEnabled.intrinsic}
                      onToggle={() => toggleOverlay("intrinsic")}
                    />
                  ) : null}
                  {hasSma50 ? (
                    <OverlayToggle
                      label="SMA 50"
                      color={CHART_COLORS.sma50}
                      pressed={overlaysEnabled.sma50}
                      onToggle={() => toggleOverlay("sma50")}
                    />
                  ) : null}
                  {hasSma200 ? (
                    <OverlayToggle
                      label="SMA 200"
                      color={CHART_COLORS.sma200}
                      pressed={overlaysEnabled.sma200}
                      onToggle={() => toggleOverlay("sma200")}
                    />
                  ) : null}
                </div>
              ) : null}
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
