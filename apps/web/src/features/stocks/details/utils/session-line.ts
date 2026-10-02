import type { ChartLinePoint, ChartPoint } from "./chart-series";

/**
 * The session-axis rules every single-choice series in a pane of its own shares — a Fundamental
 * Metric, a valuation ratio: which of the price chart's trading days a line is drawn on, and the
 * stretches an unavailable interval splits it into.
 *
 * How a stretch is then drawn is each family's own decision, never this module's: a Fundamental
 * Metric changes only on statement events and is a step, a valuation ratio moves with the close and
 * is an ordinary line. Nothing here calculates or carries a value.
 */

/**
 * The drawn line on the price chart's own session axis.
 *
 * The chart has one time axis, the close series' trading days, and the line is drawn on it and
 * nowhere else. A session the backend returned a value for reads that value; every other trading
 * day between the first and the last value is whitespace — no value at all. Nothing is carried
 * forward: a session without a value is the series being unavailable, never unchanged.
 *
 * Two edges are deliberately not drawn:
 *
 * - trading days before the first value and after the last one — nothing is drawn there either
 *   way, and the hover legend reads those sessions from the readings map instead;
 * - a returned session the price chart does not carry, such as a newer bar a later freshness check
 *   appended after the page loaded. Drawing it would add a bar to the shared time scale that the
 *   price series does not have — a session the chart never shows prices for.
 */
export function sessionLinePoints(
  rows: readonly { readonly date: string; readonly value?: number }[],
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
 * The line split into its stretches of consecutive available sessions.
 *
 * Each stretch is drawn as a series of its own, which is what keeps an unavailable interval empty
 * whatever the line type: one series would join the last value before the gap to the first value
 * after it — a slanted segment for an ordinary line, a horizontal and a vertical edge for a step.
 */
export function sessionLineRuns(
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
 * Where each drawn stretch starts and ends, for the chart's DOM contract: `from..to` per stretch,
 * oldest first. A browser test reads from it exactly where the line is broken and where it resumes,
 * without inspecting canvas pixels.
 */
export function sessionLineStretches(runs: readonly ChartPoint[][]): string {
  return runs
    .map((run) => `${run[0]?.date ?? ""}..${run.at(-1)?.date ?? ""}`)
    .join(";");
}
