import {
  findValuationRatio,
  type DailyValuationRatioResponse,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import type { ChartValuationSeries } from "./chart-series";
import { CHART_COLORS } from "./chart-theme";
import { sessionLinePoints } from "./session-line";

/**
 * Adapter between the valuation ratio catalog and the Stock Details chart.
 *
 * Identities, labels and order are the catalog's (`VALUATION_RATIO_CATALOG` in
 * `@intrinsic/contracts`); every reading is the backend's, computed with the calculation Strategy,
 * Backtest and Monitor read. This module only turns one ratio's loaded history into what the chart
 * draws. It never calculates a ratio, never carries a reading across a session the backend left
 * without one, and never masks a session the backend answered — where the line breaks is decided by
 * the server alone.
 */

/**
 * What the chart draws for the chosen ratio, or `undefined` for an identity the catalog does not
 * define — which the page never asks for, and which must not draw a line under a guessed label.
 */
export function buildValuationSeries(
  ratioId: ValuationRatioId,
  rows: readonly DailyValuationRatioResponse[],
  /** The chart's trading-day axis, ascending — the dates of the always-visible close series. */
  tradingDays: readonly string[],
): ChartValuationSeries | undefined {
  const ratio = findValuationRatio(ratioId);
  if (!ratio) {
    return undefined;
  }
  const sessions = new Set(tradingDays);
  return {
    id: ratio.id,
    label: ratio.label,
    color: CHART_COLORS.valuation,
    points: sessionLinePoints(rows, tradingDays),
    readings: new Map(
      rows
        .filter((row) => sessions.has(row.date))
        .map((row) => [row.date, row.value] as const),
    ),
  };
}
