import {
  findFundamentalMetric,
  FUNDAMENTAL_METRIC_GROUPED,
  type DailyFundamentalMetricResponse,
  type FundamentalMetricId,
} from "@intrinsic/contracts";
import type { ChartFundamentalSeries, ChartLinePoint } from "./chart-series";
import { CHART_COLORS } from "./chart-theme";
import { sessionLinePoints } from "./session-line";

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
 * The drawn line for one metric, on the price chart's own session axis, and its stretches: the rules
 * every single-choice pane series shares (`./session-line`). The backend already carried each
 * statement event onto every later session, so a session without a value is the metric being
 * unavailable, never unchanged; each stretch is then drawn as a step line of its own.
 */
export {
  sessionLinePoints as fundamentalLinePoints,
  sessionLineRuns as fundamentalRuns,
} from "./session-line";

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
    points: sessionLinePoints(rows, tradingDays),
    readings: new Map(
      rows
        .filter((row) => sessions.has(row.date))
        .map((row) => [row.date, row.value] as const),
    ),
  };
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
