"use client";

import {
  VALUATION_RATIO_CATALOG,
  type StockSummaryValuationRatiosResponse,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import { useId } from "react";
import { InfoTip } from "../../../../components/ui/InfoTip";
import { SectionCard } from "../../../../components/ui/SectionCard";
import { formatLocalDate, formatMultiple } from "../utils/format";
import { ResearchReading } from "./ResearchReading";
import styles from "./ResearchCards.module.css";

type StockValuationRatiosProps = {
  readonly ratios: StockSummaryValuationRatiosResponse;
  /** The newest session — the close every available ratio is read at. */
  readonly asOf?: string;
  /** The ratio drawn in the chart's valuation pane, or `null`. */
  readonly charted: ValuationRatioId | null;
  readonly onShow: (id: ValuationRatioId) => void;
  /** Asks for the summary again after its ratios could not be prepared. */
  readonly onRetry: () => void;
};

const EXPLANATION =
  "Each ratio is the company's market value at the close against its statements over the latest four reported quarters, or its latest balance sheet for P/B — the same calculation Strategies, Backtests and Monitors use. A ratio is unavailable when an input is missing or not positive, or the price basis cannot be trusted that day; it is never shown as zero.";

/**
 * The five valuation ratios at the newest close, in `VALUATION_RATIO_CATALOG`'s order and labels.
 *
 * Every figure is the API's: computed by the one valuation-ratio calculation, never in the browser,
 * and never taken from a provider's ratio endpoint. A ratio unavailable on the newest session shows
 * the newest earlier reading the year holds, with that reading's own date — or "Unavailable" when
 * there is none — and is never shown as zero. Every row is a button that draws that ratio's history
 * in the chart's valuation pane.
 */
export function StockValuationRatios({
  ratios,
  asOf,
  charted,
  onShow,
  onRetry,
}: StockValuationRatiosProps) {
  const hintId = useId();
  const readings =
    ratios.status === "AVAILABLE"
      ? new Map(ratios.readings.map((reading) => [reading.id, reading]))
      : undefined;
  return (
    <SectionCard
      id="valuation-ratios"
      title="Valuation ratios"
      caption={
        <>
          <span className={styles.captionTip}>
            <InfoTip label="valuation ratios" testId="valuation-ratios-tip">
              {EXPLANATION}
            </InfoTip>
          </span>{" "}
          {asOf
            ? `At close · ${formatLocalDate(asOf)} · Multiples of trailing statements`
            : "Multiples of trailing statements"}
        </>
      }
    >
      {readings ? null : (
        <p className={styles.sectionError} role="alert">
          Valuation ratios could not be calculated right now.{" "}
          <button
            type="button"
            className={styles.inlineRetry}
            onClick={onRetry}
          >
            Try again
          </button>
        </p>
      )}
      <ul className={styles.readings} aria-label="Valuation ratios">
        {VALUATION_RATIO_CATALOG.map((ratio) => {
          const reading = readings?.get(ratio.id);
          const value =
            reading?.value === undefined
              ? undefined
              : formatMultiple(reading.value);
          return (
            <ResearchReading
              key={ratio.id}
              label={ratio.label}
              {...(value === undefined ? {} : { value })}
              {...(readings ? {} : { emptyLabel: "Not loaded" })}
              {...(reading?.date !== undefined && reading.date !== asOf
                ? { readingDate: reading.date }
                : {})}
              charted={charted === ratio.id}
              onShow={() => onShow(ratio.id)}
              hintId={hintId}
              testId={`valuation-ratio-${ratio.id}`}
            />
          );
        })}
      </ul>
      <p className={styles.hint} id={hintId}>
        Select a ratio to chart its history.
      </p>
    </SectionCard>
  );
}
