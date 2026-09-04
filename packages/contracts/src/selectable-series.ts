import type {
  IntrinsicValueBlendIdResponse,
  IntrinsicValueModelResponse,
  MovingAverageFieldResponse,
  OscillatorFieldResponse,
} from "./stock-data.js";

/**
 * The one canonical catalog of selectable technical and intrinsic-value series.
 *
 * `docs/decisions/selectable-series-catalog.md` is the product decision this file implements. Every
 * consumer reads its option identities, grouping, ordering and labels from here:
 *
 * - Stock Details renders the whole catalog as the grouped multi-select `Indicators` control;
 * - Strategy condition operands render filtered single-select views of the same entries;
 * - the API validates selection/filter identifiers against the same ids.
 *
 * No feature may keep a second option list. Adding, removing, relabelling or reordering a series is
 * a change to this file, and `selectable-series.test.ts` locks the resulting catalog down.
 *
 * It lives in `@intrinsic/contracts` because that is the only package the web app may depend on and
 * it is also available to the API and worker. The backend/domain identities stay structured in
 * `@intrinsic/domain` (`MATERIALIZED_MOVING_AVERAGES`, `INTRINSIC_VALUE_MODELS`,
 * `INTRINSIC_VALUE_BLEND_IDS`); the `source` discriminator below is the structured identity this
 * catalog carries, and `label` is never a persistence identity.
 */

export const SELECTABLE_SERIES_GROUPS = [
  "MOVING_AVERAGES_DAILY",
  "MOVING_AVERAGES_WEEKLY",
  "OSCILLATORS",
  "INTRINSIC_VALUE_BLENDS",
  "INTRINSIC_VALUE_MODELS",
] as const;

export type SelectableSeriesGroupId = (typeof SELECTABLE_SERIES_GROUPS)[number];

/** Display names of the catalog groups, in canonical order. */
export const SELECTABLE_SERIES_GROUP_LABELS = {
  MOVING_AVERAGES_DAILY: "Moving averages — Daily",
  MOVING_AVERAGES_WEEKLY: "Moving averages — Weekly",
  OSCILLATORS: "Oscillators",
  INTRINSIC_VALUE_BLENDS: "Intrinsic Value — Blends",
  INTRINSIC_VALUE_MODELS: "Intrinsic Value — Models",
} as const satisfies Record<SelectableSeriesGroupId, string>;

export type MovingAverageTypeResponse = "SMA" | "EMA";
export type TechnicalTimeframeResponse = "1D" | "1W";
export type OscillatorTypeResponse = "RSI";

/**
 * Structured identity of one catalog entry.
 *
 * A moving average is identified by type, period and timeframe — `SMA(20, 1D)` and `SMA(20, 1W)`
 * are different series — plus the `DailyTechnicalResponse` field carrying its value. Intrinsic
 * entries are identified by their canonical model or blend id. Consumers switch on `kind` rather
 * than parsing the entry id or the label.
 */
export type SelectableSeriesSource =
  | {
      kind: "MOVING_AVERAGE";
      type: MovingAverageTypeResponse;
      /** Number of source bars in the window, never calendar days or weeks. */
      period: number;
      timeframe: TechnicalTimeframeResponse;
      field: MovingAverageFieldResponse;
    }
  | {
      kind: "OSCILLATOR";
      /**
       * Oscillator family. It doubles as the pane-compatibility group: series of one family share
       * one chart pane and one fixed scale, so every `RSI` entry draws into the single RSI pane.
       */
      type: OscillatorTypeResponse;
      /** Number of source bars in the window, never calendar days or weeks. */
      period: number;
      timeframe: TechnicalTimeframeResponse;
      field: OscillatorFieldResponse;
      /** Fixed unit range every value lies within; the shared pane renders it as its scale. */
      range: { min: number; max: number };
      /** Oscillators are unitless and are never drawn over the price scale. */
      placement: "SEPARATE_PANE";
    }
  | { kind: "INTRINSIC_VALUE_BLEND"; blendId: IntrinsicValueBlendIdResponse }
  | { kind: "INTRINSIC_VALUE_MODEL"; model: IntrinsicValueModelResponse };

export type SelectableSeries = {
  /** Stable identity used by selection state, API filters and future strategy persistence. */
  id: SelectableSeriesId;
  group: SelectableSeriesGroupId;
  /**
   * Present with `true` only on the entries Stock Details enables before any user interaction.
   * Omission is the catalog's explicit "off by default": every oscillator, for example, starts
   * unchecked. The web derives its initial selection from this flag rather than keeping a second
   * default list.
   */
  defaultSelected?: true;
  /**
   * The one product label, used by every surface: the dropdown, the chart legend and the
   * valuation summary.
   *
   * There is deliberately no second, shorter label. Measured in the browser, the widest label
   * ("Dividend Discount (DDM)", 148px at 13px Geist) fits the valuation summary's label column on
   * desktop with room to spare (465px available) and wraps to a second line only on a 390px phone
   * (123px available). That row is a `min-height: 44px` flex row with no `nowrap` and no
   * truncation, so wrapping grows the row and nothing overflows or is cut off — not a presentation
   * requirement worth a parallel label vocabulary.
   */
  label: string;
  source: SelectableSeriesSource;
};

/**
 * Every selectable series, in canonical group and in-group order.
 *
 * The moving-average entries address the periods `@intrinsic/domain` materializes; the intrinsic
 * entries address its canonical blends and models. Price is the chart's always-visible base series
 * and is deliberately not an entry. `selectable-series.test.ts` holds the one snapshot that pins
 * the exact membership, so consumers derive counts from this array rather than restating them.
 */
export const SELECTABLE_SERIES_CATALOG = [
  {
    id: "SMA_20D",
    group: "MOVING_AVERAGES_DAILY",
    label: "SMA 20D",
    source: {
      kind: "MOVING_AVERAGE",
      type: "SMA",
      period: 20,
      timeframe: "1D",
      field: "sma20d",
    },
  },
  {
    id: "SMA_50D",
    group: "MOVING_AVERAGES_DAILY",
    label: "SMA 50D",
    source: {
      kind: "MOVING_AVERAGE",
      type: "SMA",
      period: 50,
      timeframe: "1D",
      field: "sma50d",
    },
  },
  {
    id: "SMA_100D",
    group: "MOVING_AVERAGES_DAILY",
    label: "SMA 100D",
    source: {
      kind: "MOVING_AVERAGE",
      type: "SMA",
      period: 100,
      timeframe: "1D",
      field: "sma100d",
    },
  },
  {
    id: "SMA_200D",
    group: "MOVING_AVERAGES_DAILY",
    label: "SMA 200D",
    source: {
      kind: "MOVING_AVERAGE",
      type: "SMA",
      period: 200,
      timeframe: "1D",
      field: "sma200d",
    },
  },
  {
    id: "EMA_20D",
    group: "MOVING_AVERAGES_DAILY",
    label: "EMA 20D",
    source: {
      kind: "MOVING_AVERAGE",
      type: "EMA",
      period: 20,
      timeframe: "1D",
      field: "ema20d",
    },
  },
  {
    id: "EMA_50D",
    group: "MOVING_AVERAGES_DAILY",
    label: "EMA 50D",
    source: {
      kind: "MOVING_AVERAGE",
      type: "EMA",
      period: 50,
      timeframe: "1D",
      field: "ema50d",
    },
  },
  {
    id: "EMA_200D",
    group: "MOVING_AVERAGES_DAILY",
    label: "EMA 200D",
    source: {
      kind: "MOVING_AVERAGE",
      type: "EMA",
      period: 200,
      timeframe: "1D",
      field: "ema200d",
    },
  },
  {
    id: "SMA_20W",
    group: "MOVING_AVERAGES_WEEKLY",
    label: "SMA 20W",
    source: {
      kind: "MOVING_AVERAGE",
      type: "SMA",
      period: 20,
      timeframe: "1W",
      field: "sma20w",
    },
  },
  {
    id: "SMA_50W",
    group: "MOVING_AVERAGES_WEEKLY",
    label: "SMA 50W",
    source: {
      kind: "MOVING_AVERAGE",
      type: "SMA",
      period: 50,
      timeframe: "1W",
      field: "sma50w",
    },
  },
  {
    id: "SMA_100W",
    group: "MOVING_AVERAGES_WEEKLY",
    label: "SMA 100W",
    source: {
      kind: "MOVING_AVERAGE",
      type: "SMA",
      period: 100,
      timeframe: "1W",
      field: "sma100w",
    },
  },
  {
    id: "SMA_200W",
    group: "MOVING_AVERAGES_WEEKLY",
    label: "SMA 200W",
    source: {
      kind: "MOVING_AVERAGE",
      type: "SMA",
      period: 200,
      timeframe: "1W",
      field: "sma200w",
    },
  },
  {
    id: "EMA_20W",
    group: "MOVING_AVERAGES_WEEKLY",
    label: "EMA 20W",
    source: {
      kind: "MOVING_AVERAGE",
      type: "EMA",
      period: 20,
      timeframe: "1W",
      field: "ema20w",
    },
  },
  {
    id: "EMA_50W",
    group: "MOVING_AVERAGES_WEEKLY",
    label: "EMA 50W",
    source: {
      kind: "MOVING_AVERAGE",
      type: "EMA",
      period: 50,
      timeframe: "1W",
      field: "ema50w",
    },
  },
  {
    id: "EMA_200W",
    group: "MOVING_AVERAGES_WEEKLY",
    label: "EMA 200W",
    source: {
      kind: "MOVING_AVERAGE",
      type: "EMA",
      period: 200,
      timeframe: "1W",
      field: "ema200w",
    },
  },
  {
    id: "RSI_7D",
    group: "OSCILLATORS",
    label: "RSI 7D",
    source: {
      kind: "OSCILLATOR",
      type: "RSI",
      period: 7,
      timeframe: "1D",
      field: "rsi7d",
      range: { min: 0, max: 100 },
      placement: "SEPARATE_PANE",
    },
  },
  {
    id: "RSI_14D",
    group: "OSCILLATORS",
    label: "RSI 14D",
    source: {
      kind: "OSCILLATOR",
      type: "RSI",
      period: 14,
      timeframe: "1D",
      field: "rsi14d",
      range: { min: 0, max: 100 },
      placement: "SEPARATE_PANE",
    },
  },
  {
    id: "RSI_21D",
    group: "OSCILLATORS",
    label: "RSI 21D",
    source: {
      kind: "OSCILLATOR",
      type: "RSI",
      period: 21,
      timeframe: "1D",
      field: "rsi21d",
      range: { min: 0, max: 100 },
      placement: "SEPARATE_PANE",
    },
  },
  {
    id: "BALANCED",
    group: "INTRINSIC_VALUE_BLENDS",
    label: "Balanced",
    defaultSelected: true,
    source: { kind: "INTRINSIC_VALUE_BLEND", blendId: "BALANCED" },
  },
  {
    id: "CONSERVATIVE",
    group: "INTRINSIC_VALUE_BLENDS",
    label: "Conservative",
    source: { kind: "INTRINSIC_VALUE_BLEND", blendId: "CONSERVATIVE" },
  },
  {
    id: "DIVIDEND",
    group: "INTRINSIC_VALUE_BLENDS",
    label: "Dividend",
    source: { kind: "INTRINSIC_VALUE_BLEND", blendId: "DIVIDEND" },
  },
  {
    id: "DCF_FCFF",
    group: "INTRINSIC_VALUE_MODELS",
    label: "DCF (FCFF)",
    source: { kind: "INTRINSIC_VALUE_MODEL", model: "DCF_FCFF" },
  },
  {
    id: "RESIDUAL_INCOME",
    group: "INTRINSIC_VALUE_MODELS",
    label: "Residual Income",
    source: { kind: "INTRINSIC_VALUE_MODEL", model: "RESIDUAL_INCOME" },
  },
  {
    id: "DDM",
    group: "INTRINSIC_VALUE_MODELS",
    label: "Dividend Discount (DDM)",
    source: { kind: "INTRINSIC_VALUE_MODEL", model: "DDM" },
  },
  {
    id: "GRAHAM",
    group: "INTRINSIC_VALUE_MODELS",
    label: "Graham",
    source: { kind: "INTRINSIC_VALUE_MODEL", model: "GRAHAM" },
  },
] as const satisfies readonly (Omit<SelectableSeries, "id"> & {
  id: string;
})[];

export type SelectableSeriesId =
  (typeof SELECTABLE_SERIES_CATALOG)[number]["id"];

/**
 * The catalog grouped for rendering, preserving canonical group order and in-group order.
 *
 * Built from the flat catalog so a grouped view can never drift from the flat one.
 */
export const SELECTABLE_SERIES_GROUPED: readonly {
  id: SelectableSeriesGroupId;
  label: string;
  series: readonly SelectableSeries[];
}[] = SELECTABLE_SERIES_GROUPS.map((group) => ({
  id: group,
  label: SELECTABLE_SERIES_GROUP_LABELS[group],
  series: SELECTABLE_SERIES_CATALOG.filter((entry) => entry.group === group),
}));

/**
 * Entries Stock Details enables before any user interaction, in canonical order.
 *
 * Derived from the per-entry `defaultSelected` flag so the initial chart state is catalog product
 * metadata rather than a second list kept by the web app. Everything not listed here — every
 * oscillator included — starts off.
 */
export const DEFAULT_SELECTED_SERIES_IDS: readonly SelectableSeriesId[] =
  SELECTABLE_SERIES_CATALOG.flatMap((entry) =>
    "defaultSelected" in entry && entry.defaultSelected ? [entry.id] : [],
  );

const SERIES_BY_ID = new Map<string, SelectableSeries>(
  SELECTABLE_SERIES_CATALOG.map((entry) => [entry.id, entry]),
);

/**
 * The catalog entry for `id`, or `undefined` when the identifier is not a catalog series.
 *
 * This is the single lookup and validation entry point. Callers that only need to know whether an
 * identifier is valid still use it and check for `undefined`: every real caller goes on to read
 * the entry's `source` or `label`, so a separate boolean type guard would only ever duplicate this
 * map lookup.
 */
export function findSelectableSeries(id: string): SelectableSeries | undefined {
  return SERIES_BY_ID.get(id);
}

/**
 * Blend and model identities paired with the label a dense surface should render, in canonical
 * catalog order.
 *
 * The intrinsic-value endpoints speak `blendId`/`model` rather than catalog id, so a consumer of
 * those responses would otherwise need its own ordered list to render them. These projections
 * exist precisely so it does not: ordering and labels stay owned by the catalog.
 */
export const INTRINSIC_VALUE_BLEND_OPTIONS: readonly {
  blendId: IntrinsicValueBlendIdResponse;
  label: string;
}[] = SELECTABLE_SERIES_CATALOG.flatMap((entry) =>
  entry.source.kind === "INTRINSIC_VALUE_BLEND"
    ? [{ blendId: entry.source.blendId, label: entry.label }]
    : [],
);

export const INTRINSIC_VALUE_MODEL_OPTIONS: readonly {
  model: IntrinsicValueModelResponse;
  label: string;
}[] = SELECTABLE_SERIES_CATALOG.flatMap((entry) =>
  entry.source.kind === "INTRINSIC_VALUE_MODEL"
    ? [{ model: entry.source.model, label: entry.label }]
    : [],
);

/**
 * Consumer-facing filtered views of the catalog.
 *
 * Strategy predicates select from these rather than building their own lists; Stock Details uses
 * the whole catalog. Keeping the filters here is what makes "one catalog, many consumers" true
 * instead of aspirational.
 */
export const MOVING_AVERAGE_SERIES: readonly SelectableSeries[] =
  SELECTABLE_SERIES_CATALOG.filter(
    (entry) => entry.source.kind === "MOVING_AVERAGE",
  );

export const OSCILLATOR_SERIES: readonly SelectableSeries[] =
  SELECTABLE_SERIES_CATALOG.filter(
    (entry) => entry.source.kind === "OSCILLATOR",
  );

/**
 * Every series the daily technical endpoint serves and its `series=` filter accepts: the moving
 * averages plus the daily oscillators. The intrinsic entries are deliberately not here — they are
 * served by the intrinsic-value and blend endpoints, which apply their own point-in-time rules.
 */
export const TECHNICAL_SERIES: readonly SelectableSeries[] =
  SELECTABLE_SERIES_CATALOG.filter(
    (entry) =>
      entry.source.kind === "MOVING_AVERAGE" ||
      entry.source.kind === "OSCILLATOR",
  );

export const INTRINSIC_VALUE_SERIES: readonly SelectableSeries[] =
  SELECTABLE_SERIES_CATALOG.filter(
    (entry) =>
      entry.source.kind === "INTRINSIC_VALUE_BLEND" ||
      entry.source.kind === "INTRINSIC_VALUE_MODEL",
  );

/**
 * Moving averages comparable with `id`: same timeframe, excluding the identity itself.
 *
 * Daily-to-weekly comparisons are excluded in V1, and a moving average can never be compared with
 * itself; both rules live here so no predicate re-implements them.
 */
export function comparableMovingAverages(
  id: SelectableSeriesId,
): readonly SelectableSeries[] {
  const left = findSelectableSeries(id);
  if (!left || left.source.kind !== "MOVING_AVERAGE") {
    return [];
  }
  const timeframe = left.source.timeframe;
  return MOVING_AVERAGE_SERIES.filter(
    (entry) =>
      entry.id !== id &&
      entry.source.kind === "MOVING_AVERAGE" &&
      entry.source.timeframe === timeframe,
  );
}
