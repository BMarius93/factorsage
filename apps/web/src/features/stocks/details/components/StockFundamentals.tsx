"use client";

import {
  FUNDAMENTAL_METRIC_GROUPED,
  type FundamentalMetricId,
  type StockSummaryQuarterResponse,
  type StockSummaryReadingResponse,
} from "@intrinsic/contracts";
import { useId } from "react";
import { InfoTip } from "../../../../components/ui/InfoTip";
import { SectionCard } from "../../../../components/ui/SectionCard";
import { formatFundamentalValue, formatLocalDate } from "../utils/format";
import { ResearchReading } from "./ResearchReading";
import styles from "./ResearchCards.module.css";

type StockFundamentalsProps = {
  readonly readings: readonly StockSummaryReadingResponse<FundamentalMetricId>[];
  /** The newest session — the one every current reading is stated for. */
  readonly asOf?: string;
  /** The newest quarterly period public by that session. */
  readonly latestQuarter?: StockSummaryQuarterResponse;
  /** The metric drawn in the chart's fundamentals pane, or `null`. */
  readonly charted: FundamentalMetricId | null;
  readonly onShow: (id: FundamentalMetricId) => void;
};

const EXPLANATION =
  "Each metric is calculated from the statements public on that session and changes only when a new or revised statement becomes public — the same stored readings Strategies and Backtests evaluate. Percentages are percentage points; multiples are raw ratios. A metric is unavailable when its statements do not support it; it is never shown as zero.";

/** "Latest quarter: Q2 FY2026, ended Jun 28, 2026 · public from Aug 1, 2026". */
function periodLine(quarter: StockSummaryQuarterResponse): string {
  return `Latest quarter: ${quarter.period} FY${quarter.fiscalYear}, ended ${formatLocalDate(
    quarter.fiscalDate,
  )} · public from ${formatLocalDate(quarter.availableFrom)}`;
}

/**
 * All fifteen Fundamental Metrics, grouped as `FUNDAMENTAL_METRIC_GROUPED` groups them — Growth,
 * Profitability, Quality, Leverage, Liquidity, Solvency, Efficiency — in its labels, order and units.
 *
 * Every figure is the persisted point-in-time reading the API returned, never calculated here. The
 * card states three different dates and keeps them apart: the session the readings are for (the
 * newest close), the latest reporting period public by then and when it became public, and — for a
 * metric unavailable on the newest session — the earlier session its reading belongs to. A metric
 * with no reading in the year says "Unavailable", never zero; a negative reading keeps its sign.
 * Every row is a button that draws that metric's history in the chart's fundamentals pane.
 */
export function StockFundamentals({
  readings,
  asOf,
  latestQuarter,
  charted,
  onShow,
}: StockFundamentalsProps) {
  const hintId = useId();
  const byId = new Map(readings.map((reading) => [reading.id, reading]));
  return (
    <SectionCard
      id="fundamentals"
      title="Fundamentals"
      caption={
        <>
          <span className={styles.captionTip}>
            <InfoTip label="fundamental metrics" testId="fundamentals-tip">
              {EXPLANATION}
            </InfoTip>
          </span>{" "}
          {asOf ? `As of ${formatLocalDate(asOf)} close` : "Latest readings"}
        </>
      }
    >
      {latestQuarter ? (
        <p className={styles.period} data-testid="fundamentals-period">
          {periodLine(latestQuarter)}
        </p>
      ) : null}
      <div className={styles.groups}>
        <div className={styles.groupColumns}>
          {FUNDAMENTAL_METRIC_GROUPED.map((group) => {
            const headingId = `${hintId}-${group.id}`;
            return (
              <section
                key={group.id}
                className={styles.group}
                aria-labelledby={headingId}
              >
                <h3 className={styles.groupTitle} id={headingId}>
                  {group.label}
                </h3>
                <ul className={styles.readings}>
                  {group.metrics.map((metric) => {
                    const reading = byId.get(metric.id);
                    return (
                      <ResearchReading
                        key={metric.id}
                        label={metric.label}
                        {...(reading?.value === undefined
                          ? {}
                          : {
                              value: formatFundamentalValue(
                                reading.value,
                                metric.unit,
                              ),
                            })}
                        {...(reading?.date !== undefined &&
                        reading.date !== asOf
                          ? { readingDate: reading.date }
                          : {})}
                        charted={charted === metric.id}
                        onShow={() => onShow(metric.id)}
                        hintId={hintId}
                        testId={`fundamental-${metric.id}`}
                      />
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
      <p className={styles.hint} id={hintId}>
        Select a metric to chart its history.
      </p>
    </SectionCard>
  );
}
