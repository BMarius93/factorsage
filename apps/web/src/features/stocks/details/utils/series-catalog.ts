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
            points,
          },
        ];
  });
}
