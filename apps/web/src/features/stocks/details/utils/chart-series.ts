import type {
  DailyPriceResponse,
  DailyTechnicalResponse,
  IntrinsicValueBlendIdResponse,
  IntrinsicValueBlendResponse,
  IntrinsicValueModelResponse,
  IntrinsicValueResponse,
  TechnicalSeriesFieldResponse,
} from "@intrinsic/contracts";

/** One dated observation handed to the chart; dates stay canonical `YYYY-MM-DD` strings. */
export type ChartPoint = {
  date: string;
  value: number;
};

/**
 * Where an enabled series is drawn. Price-scaled series overlay the price pane; a unitless
 * oscillator is never drawn over the price scale and goes to the shared lower oscillator pane.
 */
export type ChartSeriesPlacement = "PRICE_OVERLAY" | "OSCILLATOR_PANE";

/** A named line drawn beside the price series — on it, or in the shared oscillator pane. */
export type ChartOverlaySeries = {
  id: string;
  label: string;
  color: string;
  placement: ChartSeriesPlacement;
  /**
   * Fixed value scale of an oscillator-pane series, from the catalog's structured metadata. The
   * pane renders this range rather than autoscaling, so every RSI shares the same 0-100 axis.
   * Absent for price overlays, which share the price scale.
   */
  scale?: { min: number; max: number };
  points: readonly ChartPoint[];
};

export function closeSeries(
  prices: readonly DailyPriceResponse[],
): ChartPoint[] {
  return prices.map((row) => ({ date: row.date, value: row.close }));
}

/**
 * Technical-series line: a moving average (daily or weekly) or a daily oscillator.
 *
 * Warm-up days without a value are omitted entirely so the chart starts the line at its first real
 * observation instead of interpolating over missing data. A weekly field intentionally repeats the
 * latest completed week's value across that week's trading days: the backend materialized it that
 * way, and flattening it here would misrepresent the point-in-time series.
 */
export function technicalSeries(
  technicals: readonly DailyTechnicalResponse[],
  indicator: TechnicalSeriesFieldResponse,
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
