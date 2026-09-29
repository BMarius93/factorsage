/**
 * Fundamental Metrics V1: the fifteen statement-derived metrics locked by
 * `docs/decisions/fundamental-metrics-v1.md`.
 *
 * This registry owns what is calculated and persisted for each metric: its stable machine
 * identity, the `DailyDerivedState` field it is materialized into, and the unit its number is
 * expressed in. Identity and storage field are two separate concepts related by this table, never
 * by changing case or parsing one into the other.
 *
 * It deliberately carries no product label and no grouping. Those are presentation, owned by the
 * one product-facing catalog in `@intrinsic/contracts` once a surface needs them and pinned against
 * this registry by a drift test — the same split `SELECTABLE_SERIES_CATALOG` keeps with the moving
 * average and oscillator registries.
 *
 * Units are part of what a stored number means, so they live here:
 *
 * - `PERCENT` values are **percentage points**. An economic ratio of `0.1542` is stored, evaluated
 *   and compared as `15.42`, exactly as a Strategy user types `15%` as `15`. Nothing converts a
 *   fraction at evaluation time.
 * - `MULTIPLE` values are raw ratios: a Debt / Equity of `0.75` is `0.75`.
 *
 * Unavailability is absence at every layer — an omitted key here, `NULL` in PostgreSQL — and never
 * zero, infinity or a stale earlier value. Valuation ratios (`P/E`, `P/S`, `P/FCF`, `EV/EBITDA`)
 * combine a statement denominator with a market price; they are not fundamentals and are not here.
 */
export const FUNDAMENTAL_METRIC_UNITS = ["PERCENT", "MULTIPLE"] as const;
export type FundamentalMetricUnit = (typeof FUNDAMENTAL_METRIC_UNITS)[number];

export type FundamentalMetricDefinition = {
  /** Stable machine identity. Permanent: future Strategy documents and fingerprints carry it. */
  id: string;
  /** The `DailyDerivedState` field, and PostgreSQL column, the value is materialized into. */
  field: string;
  unit: FundamentalMetricUnit;
};

/** The complete V1 catalog, in the order of the methodology decision. Exactly fifteen entries. */
export const FUNDAMENTAL_METRICS = [
  {
    id: "REVENUE_GROWTH_TTM_YOY",
    field: "revenueGrowthTtmYoy",
    unit: "PERCENT",
  },
  { id: "EPS_GROWTH_TTM_YOY", field: "epsGrowthTtmYoy", unit: "PERCENT" },
  { id: "FCF_GROWTH_TTM_YOY", field: "fcfGrowthTtmYoy", unit: "PERCENT" },
  { id: "GROSS_MARGIN_TTM", field: "grossMarginTtm", unit: "PERCENT" },
  { id: "OPERATING_MARGIN_TTM", field: "operatingMarginTtm", unit: "PERCENT" },
  { id: "NET_MARGIN_TTM", field: "netMarginTtm", unit: "PERCENT" },
  { id: "FCF_MARGIN_TTM", field: "fcfMarginTtm", unit: "PERCENT" },
  { id: "ROIC_TTM", field: "roicTtm", unit: "PERCENT" },
  { id: "ROE_TTM", field: "roeTtm", unit: "PERCENT" },
  { id: "ROA_TTM", field: "roaTtm", unit: "PERCENT" },
  { id: "DEBT_TO_EQUITY", field: "debtToEquity", unit: "MULTIPLE" },
  { id: "CURRENT_RATIO", field: "currentRatio", unit: "MULTIPLE" },
  {
    id: "NET_DEBT_TO_EBITDA_TTM",
    field: "netDebtToEbitdaTtm",
    unit: "MULTIPLE",
  },
  {
    id: "INTEREST_COVERAGE_TTM",
    field: "interestCoverageTtm",
    unit: "MULTIPLE",
  },
  { id: "ASSET_TURNOVER_TTM", field: "assetTurnoverTtm", unit: "MULTIPLE" },
] as const satisfies readonly FundamentalMetricDefinition[];

export type FundamentalMetricId = (typeof FUNDAMENTAL_METRICS)[number]["id"];

/** The field-name type that makes an unregistered fundamental field a compile error. */
export type FundamentalMetricField =
  (typeof FUNDAMENTAL_METRICS)[number]["field"];

/** Every fundamental metric identity, in registry order. */
export const FUNDAMENTAL_METRIC_IDS: readonly FundamentalMetricId[] =
  FUNDAMENTAL_METRICS.map((metric) => metric.id);

/** Every fundamental metric field, in registry order. */
export const FUNDAMENTAL_METRIC_FIELDS: readonly FundamentalMetricField[] =
  FUNDAMENTAL_METRICS.map((metric) => metric.field);

/**
 * The registry entry for one identity: the single lookup from a metric to its storage field, so
 * no caller derives a field name from an identity string.
 */
export function fundamentalMetricDefinition(
  id: FundamentalMetricId,
): (typeof FUNDAMENTAL_METRICS)[number] {
  const definition = FUNDAMENTAL_METRICS.find((metric) => metric.id === id);
  if (!definition) {
    throw new Error(`Unsupported fundamental metric ${id}`);
  }
  return definition;
}

/**
 * The fifteen metrics as evaluated from the point-in-time statement set of one trading day.
 *
 * A key is present only when that metric is available; an omitted key is the one representation
 * of unavailable. Values carry full calculation precision — storage quantization and display
 * rounding happen later and never feed back.
 */
export type FundamentalMetricSnapshot = Partial<
  Record<FundamentalMetricField, number>
>;
