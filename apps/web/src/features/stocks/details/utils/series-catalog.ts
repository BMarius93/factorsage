import {
  DEFAULT_SELECTED_SERIES_IDS,
  SELECTABLE_SERIES_CATALOG,
  SELECTABLE_SERIES_GROUPED,
  type DailyTechnicalResponse,
  type IntrinsicValueBlendResponse,
  type IntrinsicValueResponse,
  type SelectableSeries,
  type SelectableSeriesId,
} from "@intrinsic/contracts";
import {
  blendSeries,
  intrinsicModelSeries,
  technicalSeries,
  type ChartLinePoint,
  type ChartOverlaySeries,
  type ChartPoint,
} from "./chart-series";
import { overlayColorAt } from "./chart-theme";

/**
 * Adapter between the canonical selectable-series catalog and the Stock Details chart.
 *
 * The catalog itself lives in `@intrinsic/contracts` and is shared with future Strategy code; this
 * module only says how one catalog entry is read out of the loaded Stock Details payload and drawn.
 * It never decides which series exist, how they are grouped, labelled or ordered, and it never
 * calculates a valuation — every value comes from the backend contracts as-is.
 */

/** The three dated arrays a catalog entry can be projected from. */
export type SeriesSource = {
  readonly technicals: readonly DailyTechnicalResponse[];
  readonly blends: readonly IntrinsicValueBlendResponse[];
  readonly intrinsicValues: readonly IntrinsicValueResponse[];
};

export const INDICATOR_GROUPS = SELECTABLE_SERIES_GROUPED;

/**
 * Default chart state, straight from the catalog's own `defaultSelected` metadata: `Balanced` on,
 * every other overlay — every oscillator included — off. Price is always drawn separately.
 */
export const DEFAULT_SELECTED_SERIES: readonly SelectableSeriesId[] =
  DEFAULT_SELECTED_SERIES_IDS;

/** Points of one catalog entry, in the ascending order the backend returned. */
export function seriesPoints(
  source: SeriesSource,
  series: SelectableSeries,
): ChartPoint[] {
  switch (series.source.kind) {
    case "MOVING_AVERAGE":
    case "OSCILLATOR":
      return technicalSeries(source.technicals, series.source.field);
    case "INTRINSIC_VALUE_BLEND":
      return blendSeries(source.blends, series.source.blendId);
    case "INTRINSIC_VALUE_MODEL":
      return intrinsicModelSeries(source.intrinsicValues, series.source.model);
  }
}

/**
 * Catalog entries the loaded payload can actually draw.
 *
 * Availability is answered over everything loaded, not over the currently visible window, so
 * scrolling does not flicker an option between enabled and disabled and a series that becomes
 * evaluable once older history arrives stops being reported as unavailable. An entry outside this
 * set stays visible in the picker and is marked unavailable; it is never replaced by another
 * period, another model, or by zero.
 */
export function availableSeriesIds(
  source: SeriesSource,
): ReadonlySet<SelectableSeriesId> {
  return new Set(
    SELECTABLE_SERIES_CATALOG.filter(
      (series) => seriesPoints(source, series).length > 0,
    ).map((series) => series.id),
  );
}

/**
 * Overlay lines for the enabled selection, ordered canonically.
 *
 * Ordering is the catalog's, not the click order, so the legend, the chart and the picker always
 * agree and the deterministic colour policy assigns the same hue to the same selection every time.
 * Colour positions span the whole enabled set across both panes, so simultaneously enabled series
 * stay distinguishable wherever they are drawn. An entry with no point in the loaded history is
 * dropped rather than drawn as an empty line; what of it is on screen is the viewport's business,
 * not this module's.
 *
 * Placement comes from the catalog's structured source: an oscillator entry is routed to the
 * shared oscillator pane with its fixed catalog scale, and is never drawn over the price scale.
 */
export function buildOverlays(
  source: SeriesSource,
  selected: ReadonlySet<SelectableSeriesId>,
  /** The chart's trading-day axis, ascending — the dates of the always-visible close series. */
  tradingDays: readonly string[],
): ChartOverlaySeries[] {
  const enabled = SELECTABLE_SERIES_CATALOG.filter((series) =>
    selected.has(series.id),
  );
  return enabled.flatMap((series, position) => {
    const points = seriesPoints(source, series);
    return points.length === 0
      ? []
      : [
          {
            id: series.id,
            label: series.label,
            color: overlayColorAt(position),
            ...(series.source.kind === "OSCILLATOR"
              ? {
                  placement: "OSCILLATOR_PANE" as const,
                  scale: { ...series.source.range },
                }
              : { placement: "PRICE_OVERLAY" as const }),
            points: alignToTradingDays(points, tradingDays),
          },
        ];
  });
}

/**
 * Aligns one series to the chart's trading-day axis, marking the days it has no value for.
 *
 * Lightweight Charts joins consecutive data points with a straight segment, so a series that
 * simply omits the days its source was not calculable is drawn as a diagonal *through* them —
 * inventing intermediate values the backend deliberately did not materialize. `AAPL`'s dividend
 * discount model, absent across the 1996-2012 dividend suspension, was drawn as one straight
 * fifteen-year line between the value before it and the value after.
 *
 * A whitespace point — a date with no `value` — is the library's own representation of "no
 * observation here" and breaks the line instead. Every interior trading day the series does not
 * cover becomes one, which is exactly the set of days the backend materialized as unavailable:
 * intrinsic values are carried forward onto every trading day until an information event changes
 * or invalidates them, so an interior hole is never sparseness, it is absence.
 *
 * Only interior days are filled. Absence *before* a series' first value is warm-up or
 * pre-eligibility and absence *after* its last one is a source that has become unavailable;
 * neither draws anything, so neither needs a marker.
 */
export function alignToTradingDays(
  points: readonly ChartPoint[],
  tradingDays: readonly string[],
): ChartLinePoint[] {
  if (points.length === 0) {
    return [];
  }
  const byDate = new Map(points.map((point) => [point.date, point.value]));
  const first = points[0]?.date as string;
  const last = points[points.length - 1]?.date as string;
  const aligned: ChartLinePoint[] = [];
  for (const date of tradingDays) {
    if (date < first || date > last) {
      continue;
    }
    const value = byDate.get(date);
    aligned.push(value === undefined ? { date } : { date, value });
    byDate.delete(date);
  }
  // A series point on a day the price axis does not carry would otherwise be dropped. It should
  // not happen — both come from the same canonical trading calendar — but silently losing an
  // observation would be worse than drawing it, so anything left over is merged back in.
  if (byDate.size > 0) {
    for (const [date, value] of byDate) {
      aligned.push({ date, value });
    }
    aligned.sort((left, right) => left.date.localeCompare(right.date));
  }
  return aligned;
}
