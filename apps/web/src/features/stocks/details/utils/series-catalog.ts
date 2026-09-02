import {
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

/** Default chart state: `Balanced` on, every other overlay off. Price is always drawn separately. */
export const DEFAULT_SELECTED_SERIES: readonly SelectableSeriesId[] = [
  "BALANCED",
];

/** Points of one catalog entry, in the ascending order the backend returned. */
export function seriesPoints(
  source: SeriesSource,
  series: SelectableSeries,
): ChartPoint[] {
  switch (series.source.kind) {
    case "MOVING_AVERAGE":
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
 * Availability is answered from the always-loaded details window rather than the currently
 * selected chart range, so an option does not flicker between enabled and disabled while a longer
 * history loads. An entry outside this set stays visible in the picker and is marked unavailable;
 * it is never replaced by another period, another model, or by zero.
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
 * `sliceFrom` applies the chart's visible range; an entry with no point in that range is dropped
 * rather than drawn as an empty line.
 */
export function buildOverlays(
  source: SeriesSource,
  selected: ReadonlySet<SelectableSeriesId>,
  sliceFrom: (points: ChartPoint[]) => ChartPoint[],
): ChartOverlaySeries[] {
  const enabled = SELECTABLE_SERIES_CATALOG.filter((series) =>
    selected.has(series.id),
  );
  return enabled.flatMap((series, position) => {
    const points = sliceFrom(seriesPoints(source, series));
    return points.length === 0
      ? []
      : [
          {
            id: series.id,
            label: series.label,
            color: overlayColorAt(position),
            points,
          },
        ];
  });
}
