import type { SharedBacktestPreviewPoint } from "@intrinsic/contracts";

/**
 * The link-preview chart's geometry: SVG paths for the Strategy and the benchmark, drawn from the
 * thinned series the API sends (`sampleSharedBacktestPreview`, which already kept every bucket's
 * peaks and troughs).
 *
 * Pure and deterministic, so the same report always draws the same picture. Values map linearly
 * onto one shared vertical axis — the interactive chart's own scale, absolute money with both
 * scenarios funded by the same contributions — and dates map onto the horizontal one, so uneven
 * thinning never stretches a period. A benchmark gap breaks its line rather than bridging it, the
 * way the interactive chart draws a gap.
 *
 * Drawing only: nothing here produces a figure anybody reads.
 */

export type PreviewChartBox = {
  readonly width: number;
  readonly height: number;
};

export type PreviewChartPaths = {
  /** The Strategy line. */
  readonly strategy: string;
  /** The Strategy line closed down to the baseline, for its soft fill. */
  readonly strategyArea: string;
  /** The benchmark line, or null when the run recorded no benchmark value. */
  readonly benchmark: string | null;
};

/** Room above and below the extremes, so a peak never touches the frame. */
const VERTICAL_PADDING = 0.08;

function coordinate(value: number): string {
  return (Math.round(value * 10) / 10).toString();
}

function dayOf(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

/** Null when there is not enough to draw a line: fewer than two points. */
export function previewChartPaths(
  series: readonly SharedBacktestPreviewPoint[],
  box: PreviewChartBox,
): PreviewChartPaths | null {
  if (series.length < 2) {
    return null;
  }
  const first = dayOf((series[0] as SharedBacktestPreviewPoint).date);
  const last = dayOf((series.at(-1) as SharedBacktestPreviewPoint).date);
  const span = Math.max(1, last - first);

  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const point of series) {
    for (const value of [point.strategyValue, point.benchmarkValue]) {
      if (value !== null && Number.isFinite(value)) {
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }
  }
  const range = high - low;
  const padding = range > 0 ? range * VERTICAL_PADDING : Math.abs(high) || 1;
  const bottom = low - padding;
  const top = high + padding;

  const x = (date: string) => ((dayOf(date) - first) / span) * box.width;
  const y = (value: number) =>
    box.height - ((value - bottom) / (top - bottom)) * box.height;

  const strategySegments = series.map(
    (point, index) =>
      `${index === 0 ? "M" : "L"}${coordinate(x(point.date))} ${coordinate(y(point.strategyValue))}`,
  );
  const strategy = strategySegments.join(" ");
  const strategyArea = `${strategy} L${coordinate(box.width)} ${coordinate(box.height)} L0 ${coordinate(box.height)} Z`;

  let benchmark = "";
  let drawing = false;
  for (const point of series) {
    if (
      point.benchmarkValue === null ||
      !Number.isFinite(point.benchmarkValue)
    ) {
      drawing = false;
      continue;
    }
    benchmark += `${benchmark === "" ? "" : " "}${drawing ? "L" : "M"}${coordinate(x(point.date))} ${coordinate(y(point.benchmarkValue))}`;
    drawing = true;
  }

  return {
    strategy,
    strategyArea,
    benchmark: benchmark === "" ? null : benchmark,
  };
}
