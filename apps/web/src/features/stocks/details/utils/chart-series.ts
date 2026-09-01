import type {
  DailyPriceResponse,
  DailyTechnicalResponse,
  IntrinsicValueBlendIdResponse,
  IntrinsicValueBlendResponse,
} from "@intrinsic/contracts";
import type { TechnicalIndicatorKey } from "./technicals";

/** One dated observation handed to the chart; dates stay canonical `YYYY-MM-DD` strings. */
export type ChartPoint = {
  date: string;
  value: number;
};

/** A named line drawn on top of the price series. */
export type ChartOverlaySeries = {
  id: string;
  label: string;
  color: string;
  points: readonly ChartPoint[];
};

export function closeSeries(
  prices: readonly DailyPriceResponse[],
): ChartPoint[] {
  return prices.map((row) => ({ date: row.date, value: row.close }));
}

/**
 * Daily indicator line. Warm-up days without a value are omitted entirely so the chart starts the
 * line at its first real observation instead of interpolating over missing data.
 */
export function technicalSeries(
  technicals: readonly DailyTechnicalResponse[],
  indicator: TechnicalIndicatorKey,
): ChartPoint[] {
  return technicals.flatMap((row) => {
    const value = row[indicator];
    return value === undefined ? [] : [{ date: row.date, value }];
  });
}

/**
 * Materialized intrinsic-value blend line. The backend already carries each eligible value forward
 * per trading day, so consecutive points are real daily observations, not invented interpolation;
 * days before the first eligible valuation are absent and stay absent.
 */
export function blendSeries(
  blends: readonly IntrinsicValueBlendResponse[],
  blendId: IntrinsicValueBlendIdResponse,
): ChartPoint[] {
  return blends.flatMap((row) =>
    row.blendId === blendId
      ? [{ date: row.valuationDate, value: row.valuePerShare }]
      : [],
  );
}
