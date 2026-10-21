"use client";

import type {
  FundamentalMetricId,
  StockSummaryResponse,
  ValuationRatioId,
} from "@intrinsic/contracts";
import { useMemo } from "react";
import { EmptyState } from "../../../../components/ui/EmptyState";
import forms from "../../../../components/ui/forms.module.css";
import { SectionCard } from "../../../../components/ui/SectionCard";
import { Skeleton } from "../../../../components/ui/Skeleton";
import type { StockSummaryStatus } from "../hooks/use-stock-summary";
import { summarizeQuote } from "../utils/price-summary";
import { technicalRows } from "../utils/technicals";
import { selectLatestValuations } from "../utils/valuation";
import { StockFundamentals } from "./StockFundamentals";
import { StockMetrics } from "./StockMetrics";
import { StockTechnicalSummary } from "./StockTechnicalSummary";
import { StockValuationRatios } from "./StockValuationRatios";
import { StockValuationSummary } from "./StockValuationSummary";
import styles from "./StockResearch.module.css";

type StockResearchProps = {
  readonly symbol: string;
  readonly status: StockSummaryStatus;
  readonly summary?: StockSummaryResponse;
  readonly onRetry: () => void;
  /** The ratio and the metric the chart's panes draw, so a card can say which one is on it. */
  readonly chartedValuation: ValuationRatioId | null;
  readonly chartedFundamental: FundamentalMetricId | null;
  readonly onShowValuation: (id: ValuationRatioId) => void;
  readonly onShowFundamental: (id: FundamentalMetricId) => void;
};

/**
 * The financial research cards under the chart: Intrinsic value, Valuation ratios and Technicals in
 * one column, Fundamentals and Key facts in the other on a wide screen, and one column in that order
 * on a phone.
 *
 * Everything here comes from the summary alone, so the cards render the moment it arrives — whether
 * or not the chart's history has — and a chart failure or retry never touches them. While the
 * summary is on its way each card already stands in its final place under its real title, with a
 * placeholder body; a failure is stated here, with its own retry, and leaves the chart alone. The
 * two columns are two independent stacks, so a card that grows when its data lands only moves the
 * cards under it in its own column — never one across the page.
 */
export function StockResearch({
  symbol,
  status,
  summary,
  onRetry,
  chartedValuation,
  chartedFundamental,
  onShowValuation,
  onShowFundamental,
}: StockResearchProps) {
  const priceSummary = useMemo(
    () => (summary?.quote ? summarizeQuote(summary.quote) : undefined),
    [summary],
  );
  const valuationSnapshot = useMemo(
    () =>
      summary
        ? selectLatestValuations(
            summary.intrinsicValues,
            summary.intrinsicValueBlends,
          )
        : undefined,
    [summary],
  );
  const technicals = useMemo(
    () => (summary ? technicalRows(summary.technicals) : []),
    [summary],
  );

  if (status === "error") {
    return (
      <div className={styles.failed}>
        <EmptyState
          variant="error"
          testId="stock-summary-error"
          title="The financial summary could not be loaded"
          body={
            <p>
              Intrinsic value, valuation ratios, fundamentals, technicals and
              key facts for {symbol} are temporarily unavailable. The price
              chart is not affected.
            </p>
          }
          actions={
            <button
              type="button"
              className={forms.secondaryButton}
              onClick={onRetry}
            >
              Try again
            </button>
          }
        />
      </div>
    );
  }

  if (!summary) {
    return (
      <div
        className={styles.columns}
        aria-busy="true"
        data-testid="stock-research-loading"
      >
        <div className={styles.stack}>
          <LoadingCard id="valuation" title="Intrinsic value" size="tall" />
          <LoadingCard
            id="valuation-ratios"
            title="Valuation ratios"
            size="medium"
          />
          <LoadingCard id="technicals" title="Technicals" size="short" />
        </div>
        <div className={styles.stack}>
          <LoadingCard
            id="fundamentals"
            title="Fundamentals"
            size="fundamentals"
          />
          <LoadingCard id="key-facts" title="Key facts" size="tall" />
        </div>
      </div>
    );
  }

  const { security } = summary;
  const asOf = summary.quote?.date;
  return (
    <div className={styles.columns} data-testid="stock-research">
      <div className={styles.stack}>
        <StockValuationSummary
          {...(valuationSnapshot ? { snapshot: valuationSnapshot } : {})}
          {...(summary.quote
            ? {
                latestClose: {
                  value: summary.quote.close,
                  date: summary.quote.date,
                },
              }
            : {})}
          currency={security.currency}
        />
        <StockValuationRatios
          ratios={summary.valuationRatios}
          {...(asOf ? { asOf } : {})}
          charted={chartedValuation}
          onShow={onShowValuation}
          onRetry={onRetry}
        />
        <StockTechnicalSummary
          rows={technicals}
          {...(summary.quote
            ? {
                latestClose: {
                  value: summary.quote.close,
                  date: summary.quote.date,
                },
              }
            : {})}
          currency={security.currency}
        />
      </div>
      <div className={styles.stack}>
        <StockFundamentals
          readings={summary.fundamentals}
          {...(asOf ? { asOf } : {})}
          {...(summary.latestQuarter
            ? { latestQuarter: summary.latestQuarter }
            : {})}
          charted={chartedFundamental}
          onShow={onShowFundamental}
        />
        <StockMetrics
          security={security}
          {...(summary.profile ? { profile: summary.profile } : {})}
          {...(priceSummary ? { summary: priceSummary } : {})}
        />
      </div>
    </div>
  );
}

/**
 * A card that has not loaded yet, already in its final place under its real title: only the body is
 * a placeholder, sized like the card it stands in for.
 */
function LoadingCard({
  id,
  title,
  size,
}: {
  readonly id: string;
  readonly title: string;
  readonly size: "short" | "medium" | "tall" | "fundamentals";
}) {
  return (
    <SectionCard id={id} title={title}>
      <div className={styles.placeholder} data-size={size} aria-hidden="true">
        <Skeleton height="100%" />
      </div>
      <span className={styles.srOnly}>Loading {title.toLowerCase()}…</span>
    </SectionCard>
  );
}
