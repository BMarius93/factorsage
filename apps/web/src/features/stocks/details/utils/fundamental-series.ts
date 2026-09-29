import {
  findFundamentalMetric,
  FUNDAMENTAL_METRIC_GROUPED,
  type DailyFundamentalMetricResponse,
  type FundamentalMetricId,
} from "@intrinsic/contracts";
import type {
  ChartFundamentalSeries,
  ChartLinePoint,
  ChartPoint,
} from "./chart-series";
import { CHART_COLORS } from "./chart-theme";

/**
 * Adapter between the Fundamental Metrics catalog and the Stock Details chart.
 *
 * Identities, labels, groups, order and units are the catalog's, in `@intrinsic/contracts`; this
 * module only turns one metric's loaded history into what the chart draws. It never calculates a
 * metric, never carries a value across a session the backend left without one, and never learns how
 * a metric is stored — the page only ever speaks the stable identity.
 */

/** The Fundamentals section of the picker: the catalog grouped exactly as the catalog groups it. */
export const FUNDAMENTAL_GROUPS = FUNDAMENTAL_METRIC_GROUPED;

/**
 * The drawn line for one metric, on the price chart's own session axis.
 *
 * The chart has one time axis, the close series' trading days, and the fundamental is drawn on it
 * and nowhere else. A session the backend returned a value for reads that value; every other
 * trading day between the metric's first and last value is whitespace — no value at all. Nothing is
 * carried forward here: the backend already carried each statement event onto every later session,
 * so a session without a value is the metric being unavailable, never the metric being unchanged.
 *
 * Two edges are deliberately not drawn:
 *
 * - trading days before the first value and after the last one — nothing is drawn there either
 *   way, and the hover legend reads those sessions from the readings map instead;
 * - a returned session the price chart does not carry, such as a newer bar a later freshness check
 *   appended after the page loaded. Drawing it would add a bar to the shared time scale that the
 *   price series does not have — a session the chart never shows prices for.
 */
export function fundamentalLinePoints(
  rows: readonly DailyFundamentalMetricResponse[],
  tradingDays: readonly string[],
): ChartLinePoint[] {
  const values = new Map<string, number>();
  for (const row of rows) {
    if (row.value !== undefined) {
      values.set(row.date, row.value);
    }
  }
  const first = tradingDays.findIndex((date) => values.has(date));
  if (first === -1) {
    return [];
  }
  let last = tradingDays.length - 1;
  while (!values.has(tradingDays[last] as string)) {
    last -= 1;
  }
  return tradingDays.slice(first, last + 1).map((date) => {
    const value = values.get(date);
    return value === undefined ? { date } : { date, value };
  });
}

/**
 * What the chart draws for the chosen metric, or `undefined` for an identity the catalog does not
 * define — which the page never asks for, and which must not draw a line under a guessed label.
 */
export function buildFundamentalSeries(
  metricId: FundamentalMetricId,
  rows: readonly DailyFundamentalMetricResponse[],
  /** The chart's trading-day axis, ascending — the dates of the always-visible close series. */
  tradingDays: readonly string[],
): ChartFundamentalSeries | undefined {
  const metric = findFundamentalMetric(metricId);
  if (!metric) {
    return undefined;
  }
  const sessions = new Set(tradingDays);
  return {
    id: metric.id,
    label: metric.label,
    unit: metric.unit,
    color: CHART_COLORS.fundamental,
    points: fundamentalLinePoints(rows, tradingDays),
    readings: new Map(
      rows
        .filter((row) => sessions.has(row.date))
        .map((row) => [row.date, row.value] as const),
    ),
  };
}

/**
 * The line split into its stretches of consecutive available sessions.
 *
 * Each stretch is drawn as its own step line, which is what keeps an unavailable interval empty: a
 * single step line would join the last value before the gap to the first value after it with a
 * horizontal and a vertical edge, drawing a transition the data never had. Colouring the bridge
 * transparent, as the price overlays do, cannot remove both edges of a step.
 */
export function fundamentalRuns(
  points: readonly ChartLinePoint[],
): ChartPoint[][] {
  const runs: ChartPoint[][] = [];
  let current: ChartPoint[] = [];
  for (const point of points) {
    if (point.value === undefined) {
      if (current.length > 0) {
        runs.push(current);
        current = [];
      }
      continue;
    }
    current.push({ date: point.date, value: point.value });
  }
  if (current.length > 0) {
    runs.push(current);
  }
  return runs;
}

/**
 * The drawn line's transitions, for the chart's DOM contract: `date=value` where a stretch starts
 * or its value changes, and `date=` where an unavailable interval starts.
 *
 * Derived from exactly the points handed to the chart, so a browser test reads what is drawn —
 * the first eligible session, every step, every gap and every restoration — without inspecting
 * canvas pixels.
 */
export function fundamentalSteps(points: readonly ChartLinePoint[]): string {
  const steps: string[] = [];
  let previous: number | undefined | null = null;
  for (const point of points) {
    if (point.value !== previous) {
      steps.push(`${point.date}=${point.value ?? ""}`);
      previous = point.value;
    }
  }
  return steps.join(";");
}
