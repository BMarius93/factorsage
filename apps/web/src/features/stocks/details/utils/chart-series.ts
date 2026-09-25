import type {
  DailyPriceResponse,
  DailyTechnicalResponse,
  IntrinsicValueBlendIdResponse,
  IntrinsicValueBlendResponse,
  IntrinsicValueModelResponse,
  IntrinsicValueResponse,
  RelativeVolumeValuesResponse,
  TechnicalSeriesFieldResponse,
} from "@intrinsic/contracts";

/** One dated observation handed to the chart; dates stay canonical `YYYY-MM-DD` strings. */
export type ChartPoint = {
  date: string;
  value: number;
};

/**
 * One point of a drawn line, where `value` may be absent.
 *
 * An absent value is *whitespace* in Lightweight Charts terms: the date exists on the time scale
 * but the series has no observation for it, and the line is broken rather than drawn through it.
 * That distinction is the difference between "this model was not calculable on these days" and
 * "these days do not exist", and it is what keeps a genuine unavailable interval from being
 * rendered as an invented straight line between the values on either side of it.
 */
export type ChartLinePoint = {
  date: string;
  value?: number;
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
  /**
   * The line, aligned to the chart's trading-day axis. Interior days the series has no value for
   * are present as whitespace so the gap stays a gap; see `ChartLinePoint`.
   */
  points: readonly ChartLinePoint[];
};

export function closeSeries(
  prices: readonly DailyPriceResponse[],
): ChartPoint[] {
  return prices.map((row) => ({ date: row.date, value: row.close }));
}

/**
 * Daily traded volume, on the same session axis as the close series.
 *
 * Volume rides on the canonical price bar, so it needs no second request and no alignment step: a
 * session that has a close has a volume. Zero is a real reading and is drawn as a zero-height bar
 * rather than omitted.
 */
export function volumeSeries(
  prices: readonly DailyPriceResponse[],
): ChartPoint[] {
  return prices.flatMap((row) =>
    Number.isFinite(row.volume) ? [{ date: row.date, value: row.volume }] : [],
  );
}

/**
 * The Relative Volume readings of each session, keyed by date.
 *
 * A lookup rather than a series: RVOL is reported in the chart's hover legend beside the volume
 * bar, not drawn as a line. Sessions still inside a period's warm-up simply have no entry for it,
 * so the legend omits the row instead of printing a fabricated multiple.
 */
export function relativeVolumeByDate(
  technicals: readonly DailyTechnicalResponse[],
): Map<string, RelativeVolumeValuesResponse> {
  return new Map(
    technicals.map((row) => [
      row.date,
      {
        ...(row.rvol10 === undefined ? {} : { rvol10: row.rvol10 }),
        ...(row.rvol20 === undefined ? {} : { rvol20: row.rvol20 }),
        ...(row.rvol50 === undefined ? {} : { rvol50: row.rvol50 }),
      },
    ]),
  );
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
