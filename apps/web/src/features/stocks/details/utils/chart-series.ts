import type {
  DailyPriceResponse,
  DailyTechnicalResponse,
  IntrinsicValueBlendIdResponse,
  IntrinsicValueBlendResponse,
  IntrinsicValueModelResponse,
  IntrinsicValueResponse,
  MovingAverageFieldResponse,
} from "@intrinsic/contracts";

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
 * Moving-average line, daily or weekly.
 *
 * Warm-up days without a value are omitted entirely so the chart starts the line at its first real
 * observation instead of interpolating over missing data. A weekly field intentionally repeats the
 * latest completed week's value across that week's trading days: the backend materialized it that
 * way, and flattening it here would misrepresent the point-in-time series.
 */
export function technicalSeries(
  technicals: readonly DailyTechnicalResponse[],
  indicator: MovingAverageFieldResponse,
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

/**
 * Materialized intrinsic-value model line, with the same carry-forward semantics as a blend: the
 * backend repeats each eligible valuation per trading day and leaves pre-eligibility days absent.
 */
export function intrinsicModelSeries(
  values: readonly IntrinsicValueResponse[],
  model: IntrinsicValueModelResponse,
): ChartPoint[] {
  return values.flatMap((row) =>
    row.model === model
      ? [{ date: row.valuationDate, value: row.valuePerShare }]
      : [],
  );
}
