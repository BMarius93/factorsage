"use client";

import {
  findFundamentalMetric,
  findValuationRatio,
  type FundamentalMetricId,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import { PageContainer } from "../../../../components/layout/PageContainer";
import { EmptyState } from "../../../../components/ui/EmptyState";
import forms from "../../../../components/ui/forms.module.css";
import { useSignInPrompt } from "../../../auth/hooks/use-sign-in-prompt";
import { AddToListDialog } from "../../../lists/components/AddToListDialog";
import { useRecordSecurityView } from "../../recent/hooks/use-recent-securities";
import { usePaneSelection } from "../hooks/use-indicator-selection";
import { useStockDetails } from "../hooks/use-stock-details";
import { useStockSummary } from "../hooks/use-stock-summary";
import { summarizePrices, summarizeQuote } from "../utils/price-summary";
import { StockHeader, StockHeaderPlaceholder } from "./StockHeader";
import {
  PriceHistoryFailed,
  PriceHistoryLoading,
  StockPriceHistory,
} from "./StockPriceHistory";
import { StockResearch } from "./StockResearch";
import styles from "./StockDetails.module.css";

const SIGN_IN_TO_ADD = {
  title: "Sign in to add this stock to a list",
  body: "Stock details are free to read. Your lists are saved to your account, so adding a stock to one needs somewhere to keep it.",
};

type StockDetailsProps = {
  /** Normalized upper-case ticker from the route. */
  readonly symbol: string;
};

/**
 * Stock Details page feature: the identity header, the price history chart and the financial
 * research cards under it, for the security the route names.
 *
 * Keyed by the symbol, so a navigation to another stock starts from nothing: no state, no selection
 * and no value of the previous security can appear under the new ticker.
 */
export function StockDetails({ symbol }: StockDetailsProps) {
  return <StockDetailsPage key={symbol} symbol={symbol} />;
}

/**
 * Two independent requests open the page, at once: the summary — the latest state every card shows
 * — and the chart's opening window. Neither waits for the other, and neither's failure or retry
 * touches the other. The layout never follows the network: the header, the chart and the cards
 * always stand in that order, each a placeholder of its own final size until its data lands, so the
 * cards render the moment the summary arrives even when the chart is still loading below the header,
 * and the chart renders the moment its window arrives even when the cards are not.
 *
 * The header reads whichever answer arrives first, since both carry the canonical identity and the
 * same newest bar; the not-found state wins as soon as either says the symbol is not in the catalog.
 */
function StockDetailsPage({ symbol }: StockDetailsProps) {
  const summaryState = useStockSummary(symbol);
  const chartState = useStockDetails(symbol);
  const panes = usePaneSelection();
  const gate = useSignInPrompt();
  const [addingToList, setAddingToList] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const chartRef = useRef<HTMLDivElement | null>(null);

  const summary = summaryState.summary;
  const details = chartState.details;
  const security = summary?.security ?? details?.security;
  const profile = summary?.profile ?? details?.profile;
  const priceSummary = useMemo(
    () =>
      summary?.quote
        ? summarizeQuote(summary.quote)
        : details
          ? summarizePrices(details.prices)
          : undefined,
    [summary, details],
  );

  const notFound =
    summaryState.status === "not-found" || chartState.status === "not-found";

  // Every route into this page goes through here — search, a list, a monitor, a backtest, a pasted
  // URL — so this one call is what makes the search dropdown's RECENT SEARCHES mean "recently
  // viewed" rather than "recently searched for". It waits for a resolved security: a symbol that
  // 404s or fails to load was never viewed.
  useRecordSecurityView(notFound ? undefined : security);

  const { chooseValuation, chooseFundamental } = panes;

  /** Brings the chart into view after a card chose what it draws, and says what it now shows. */
  const revealChart = useCallback((label: string) => {
    setAnnouncement(`${label} history shown in the price chart.`);
    const chart = chartRef.current;
    if (chart) {
      const reduceMotion =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      chart.scrollIntoView?.({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
    }
  }, []);

  const showValuation = useCallback(
    (id: ValuationRatioId) => {
      chooseValuation(id);
      revealChart(findValuationRatio(id)?.label ?? id);
    },
    [chooseValuation, revealChart],
  );

  const showFundamental = useCallback(
    (id: FundamentalMetricId) => {
      chooseFundamental(id);
      revealChart(findFundamentalMetric(id)?.label ?? id);
    },
    [chooseFundamental, revealChart],
  );

  if (notFound) {
    return (
      <PageContainer>
        <EmptyState
          as="h1"
          testId="stock-not-found"
          title="Stock not found"
          body={
            <p>
              {symbol === ""
                ? "This page needs a stock symbol. Use the search above to find a supported stock."
                : `${symbol} is not in the supported stock catalog. Check the spelling or use the search above to find a supported stock.`}
            </p>
          }
          actions={
            <Link className={forms.secondaryButton} href="/">
              Back to Dashboard
            </Link>
          }
        />
      </PageContainer>
    );
  }

  // Nothing on the page could be loaded: one statement and one retry for both, rather than two
  // empty sections each saying so.
  if (summaryState.status === "error" && chartState.status === "error") {
    return (
      <PageContainer>
        <EmptyState
          as="h1"
          variant="error"
          testId="stock-load-error"
          title={`${symbol} could not be loaded`}
          body={<p>This is usually temporary — try again in a moment.</p>}
          actions={
            <>
              <Link className={forms.secondaryButton} href="/">
                Back to Dashboard
              </Link>
              <button
                type="button"
                className={forms.secondaryButton}
                onClick={() => {
                  summaryState.retry();
                  chartState.retry();
                }}
              >
                Try again
              </button>
            </>
          }
        />
      </PageContainer>
    );
  }

  const addToList = (
    <button
      type="button"
      className={forms.secondaryButton}
      data-testid="add-to-list-button"
      disabled={!gate.resolved || security === undefined}
      onClick={() => gate.attempt(SIGN_IN_TO_ADD, () => setAddingToList(true))}
    >
      Add to list
    </button>
  );

  return (
    <PageContainer>
      <div className={styles.page}>
        {security ? (
          <StockHeader
            security={security}
            // Research leads somewhere: the stock goes into one of the caller's lists (UI-018). A
            // one-stock backtest is deliberately not offered; a backtest runs over a list.
            actions={addToList}
            {...(priceSummary ? { summary: priceSummary } : {})}
            {...(profile ? { profile } : {})}
          />
        ) : (
          <StockHeaderPlaceholder symbol={symbol} actions={addToList} />
        )}

        <div ref={chartRef} className={styles.chartAnchor}>
          {chartState.status === "ready" && details && chartState.window ? (
            <StockPriceHistory
              symbol={symbol}
              details={details}
              window={chartState.window}
              valuation={panes.valuation}
              onChooseValuation={chooseValuation}
              fundamental={panes.fundamental}
              onChooseFundamental={chooseFundamental}
            />
          ) : chartState.status === "error" ? (
            <PriceHistoryFailed onRetry={chartState.retry} />
          ) : (
            <PriceHistoryLoading />
          )}
        </div>

        <StockResearch
          symbol={symbol}
          status={summaryState.status}
          {...(summary ? { summary } : {})}
          onRetry={summaryState.retry}
          chartedValuation={panes.valuation}
          chartedFundamental={panes.fundamental}
          onShowValuation={showValuation}
          onShowFundamental={showFundamental}
        />
      </div>

      <p className={styles.srOnly} role="status" aria-live="polite">
        {announcement}
      </p>

      {gate.prompt}

      {addingToList && security ? (
        <AddToListDialog
          security={security}
          onClose={() => setAddingToList(false)}
        />
      ) : null}
    </PageContainer>
  );
}
