/**
 * The one product-facing catalog of the Fundamental Metrics V1.
 *
 * `docs/decisions/fundamental-metrics-v1.md` is the methodology this catalog names, and
 * `docs/decisions/fundamental-metrics-storage-and-evaluation.md` requires exactly one product catalog
 * owning each metric's identity, label, group and unit. It lives in `@intrinsic/contracts` for the
 * reason the selectable-series catalog does: this is the only package the web app may depend on, and
 * the Strategy Builder, the backend validator and — later — Stock Details must read one list.
 *
 * `@intrinsic/domain` owns what is calculated and persisted for each metric: its identity, the
 * `DailyDerivedState` field it is materialized into and its unit (`FUNDAMENTAL_METRICS`). This
 * catalog restates the identity and the unit because it cannot import that registry, and owns
 * everything the registry deliberately does not: the one label, the group, the canonical order the
 * product presents, the smallest threshold a rule may name, and the words that explain it.
 * `packages/stock-data/src/fundamental-metrics-catalog.test.ts` is the drift guard between the two:
 * a metric added to one and not the other fails there rather than silently reading as unavailable.
 *
 * No storage field appears here, and none is derived from an identity or a label: the mapping from
 * identity to field is the domain registry's, used only where a value is read.
 *
 * Units are part of what a number means:
 *
 * - `PERCENT` values are **percentage points** — a metric reading 15.42% is 15.42, and a rule set at
 *   15% compares with 15, never with 0.15;
 * - `MULTIPLE` values are raw ratios — a Debt / Equity of 0.75 is 0.75.
 *
 * Valuation ratios (`P/E`, `P/S`, `P/FCF`, `EV/EBITDA`) combine a statement with a market price;
 * they are Valuation, not Fundamentals, and are not here.
 */

/**
 * The family's one product label, wherever the fifteen metrics are offered together: the Strategy
 * Builder's metric category and the Stock Details chart's series section both read it.
 */
export const FUNDAMENTAL_METRICS_LABEL = "Fundamentals";

/** The methodology's groups, in the order it introduces them. */
export const FUNDAMENTAL_METRIC_GROUPS = [
  "GROWTH",
  "PROFITABILITY",
  "QUALITY",
  "LEVERAGE",
  "LIQUIDITY",
  "SOLVENCY",
  "EFFICIENCY",
] as const;

export type FundamentalMetricGroupId =
  (typeof FUNDAMENTAL_METRIC_GROUPS)[number];

/** The one product label per group. No surface keeps a second map. */
export const FUNDAMENTAL_METRIC_GROUP_LABELS = {
  GROWTH: "Growth",
  PROFITABILITY: "Profitability",
  QUALITY: "Quality",
  LEVERAGE: "Leverage",
  LIQUIDITY: "Liquidity",
  SOLVENCY: "Solvency",
  EFFICIENCY: "Efficiency",
} as const satisfies Record<FundamentalMetricGroupId, string>;

/**
 * The two units a fundamental metric is expressed in, which decide the Strategy Value it is compared
 * with: a `PERCENT` or a `MULTIPLE`, of the same names.
 */
export const FUNDAMENTAL_METRIC_UNITS = ["PERCENT", "MULTIPLE"] as const;

export type FundamentalMetricUnit = (typeof FUNDAMENTAL_METRIC_UNITS)[number];

export type FundamentalMetricCatalogEntry = {
  /**
   * Stable machine identity. Permanent: a Strategy document, its fingerprint and every frame column
   * carry it. Never a label, and never parsed.
   */
  id: string;
  /** The one product label, used by every surface. */
  label: string;
  group: FundamentalMetricGroupId;
  unit: FundamentalMetricUnit;
  /**
   * The smallest threshold a rule may compare with, present only where the metric's own
   * mathematics has a floor.
   *
   * A growth rate compares two positive trailing windows, so it is always above -100%; a leverage,
   * liquidity or turnover ratio of non-negative quantities is never below zero. Everything else is
   * signed without bound — a margin or a return on a loss, net cash in Net Debt / EBITDA, a negative
   * EBIT in Interest Coverage — and an invented bound would reject a legitimate rule.
   */
  minimum?: number;
  /** What the metric measures, in one sentence of product vocabulary. */
  summary: string;
  /** The canonical formula, in product vocabulary. */
  formula: string;
};

/**
 * Every Fundamental Metric, in the methodology's canonical order: exactly fifteen.
 *
 * This order is the product's: the Strategy Builder lists the metrics in it, and so will every later
 * surface. Groups are metadata of each entry rather than a second ordering.
 */
export const FUNDAMENTAL_METRIC_CATALOG = [
  {
    id: "REVENUE_GROWTH_TTM_YOY",
    label: "Revenue Growth TTM YoY",
    group: "GROWTH",
    unit: "PERCENT",
    minimum: -100,
    summary:
      "How much revenue over the latest four reported quarters grew against the four quarters before them.",
    formula:
      "Revenue Growth = (Revenue TTM / Revenue TTM a year earlier - 1) * 100",
  },
  {
    id: "EPS_GROWTH_TTM_YOY",
    label: "EPS Growth TTM YoY",
    group: "GROWTH",
    unit: "PERCENT",
    minimum: -100,
    summary:
      "How much diluted earnings per share over the latest four reported quarters grew against the four quarters before them.",
    formula: "EPS Growth = (EPS TTM / EPS TTM a year earlier - 1) * 100",
  },
  {
    id: "FCF_GROWTH_TTM_YOY",
    label: "FCF Growth TTM YoY",
    group: "GROWTH",
    unit: "PERCENT",
    minimum: -100,
    summary:
      "How much free cash flow over the latest four reported quarters grew against the four quarters before them.",
    formula:
      "FCF Growth = (FCF TTM / FCF TTM a year earlier - 1) * 100, where FCF = Operating Cash Flow + Capital Expenditure",
  },
  {
    id: "GROSS_MARGIN_TTM",
    label: "Gross Margin TTM",
    group: "PROFITABILITY",
    unit: "PERCENT",
    summary:
      "Gross profit as a percentage of revenue over the latest four reported quarters.",
    formula: "Gross Margin = Gross Profit TTM / Revenue TTM * 100",
  },
  {
    id: "OPERATING_MARGIN_TTM",
    label: "Operating Margin TTM",
    group: "PROFITABILITY",
    unit: "PERCENT",
    summary:
      "Operating income as a percentage of revenue over the latest four reported quarters.",
    formula: "Operating Margin = Operating Income TTM / Revenue TTM * 100",
  },
  {
    id: "NET_MARGIN_TTM",
    label: "Net Margin TTM",
    group: "PROFITABILITY",
    unit: "PERCENT",
    summary:
      "Net income as a percentage of revenue over the latest four reported quarters.",
    formula: "Net Margin = Net Income TTM / Revenue TTM * 100",
  },
  {
    id: "FCF_MARGIN_TTM",
    label: "FCF Margin TTM",
    group: "PROFITABILITY",
    unit: "PERCENT",
    summary:
      "Free cash flow as a percentage of revenue over the latest four reported quarters.",
    formula:
      "FCF Margin = FCF TTM / Revenue TTM * 100, where FCF = Operating Cash Flow + Capital Expenditure",
  },
  {
    id: "ROIC_TTM",
    label: "ROIC TTM",
    group: "QUALITY",
    unit: "PERCENT",
    summary:
      "Operating income after a fixed 21% tax, as a percentage of the average capital invested in the business.",
    formula:
      "ROIC = Operating Income TTM * (1 - 21%) / Average Invested Capital * 100, where Invested Capital = Total Debt + Stockholders' Equity - Cash",
  },
  {
    id: "ROE_TTM",
    label: "ROE TTM",
    group: "QUALITY",
    unit: "PERCENT",
    summary: "Net income as a percentage of average stockholders' equity.",
    formula: "ROE = Net Income TTM / Average Stockholders' Equity * 100",
  },
  {
    id: "ROA_TTM",
    label: "ROA TTM",
    group: "QUALITY",
    unit: "PERCENT",
    summary: "Net income as a percentage of average total assets.",
    formula: "ROA = Net Income TTM / Average Total Assets * 100",
  },
  {
    id: "DEBT_TO_EQUITY",
    label: "Debt / Equity",
    group: "LEVERAGE",
    unit: "MULTIPLE",
    minimum: 0,
    summary:
      "Total debt as a multiple of stockholders' equity, on the latest reported balance sheet.",
    formula: "Debt / Equity = Total Debt / Stockholders' Equity",
  },
  {
    id: "CURRENT_RATIO",
    label: "Current Ratio",
    group: "LIQUIDITY",
    unit: "MULTIPLE",
    minimum: 0,
    summary:
      "Current assets as a multiple of current liabilities, on the latest reported balance sheet.",
    formula: "Current Ratio = Current Assets / Current Liabilities",
  },
  {
    id: "NET_DEBT_TO_EBITDA_TTM",
    label: "Net Debt / EBITDA TTM",
    group: "LEVERAGE",
    unit: "MULTIPLE",
    summary:
      "Net debt on the latest reported balance sheet as a multiple of EBITDA over the latest four reported quarters.",
    formula: "Net Debt / EBITDA = Net Debt / EBITDA TTM",
  },
  {
    id: "INTEREST_COVERAGE_TTM",
    label: "Interest Coverage TTM",
    group: "SOLVENCY",
    unit: "MULTIPLE",
    summary:
      "How many times EBIT over the latest four reported quarters covers the interest expense of the same quarters.",
    formula: "Interest Coverage = EBIT TTM / Interest Expense TTM",
  },
  {
    id: "ASSET_TURNOVER_TTM",
    label: "Asset Turnover TTM",
    group: "EFFICIENCY",
    unit: "MULTIPLE",
    minimum: 0,
    summary:
      "Revenue over the latest four reported quarters as a multiple of average total assets.",
    formula: "Asset Turnover = Revenue TTM / Average Total Assets",
  },
] as const satisfies readonly FundamentalMetricCatalogEntry[];

export type FundamentalMetricId =
  (typeof FUNDAMENTAL_METRIC_CATALOG)[number]["id"];

/** Every fundamental metric identity, in canonical order. */
export const FUNDAMENTAL_METRIC_IDS: readonly FundamentalMetricId[] =
  FUNDAMENTAL_METRIC_CATALOG.map((entry) => entry.id);

/** One catalog entry with its identity typed as a catalog identity. */
export type FundamentalMetric = (typeof FUNDAMENTAL_METRIC_CATALOG)[number];

/**
 * The catalog grouped for a surface that shows the groups: canonical group order, and catalog order
 * inside each group.
 *
 * Built from the flat catalog, so a grouped view can never drift from it and never holds a metric
 * twice or leaves one out. The groups follow `FUNDAMENTAL_METRIC_GROUPS`, the order the methodology
 * introduces them, so the two Leverage metrics sit together even though the flat order interleaves
 * Current Ratio between them. A group no metric belongs to is omitted rather than rendered empty.
 */
export const FUNDAMENTAL_METRIC_GROUPED: readonly {
  readonly id: FundamentalMetricGroupId;
  readonly label: string;
  readonly metrics: readonly FundamentalMetric[];
}[] = FUNDAMENTAL_METRIC_GROUPS.flatMap((group) => {
  const metrics = FUNDAMENTAL_METRIC_CATALOG.filter(
    (entry) => entry.group === group,
  );
  return metrics.length === 0
    ? []
    : [{ id: group, label: FUNDAMENTAL_METRIC_GROUP_LABELS[group], metrics }];
});

/**
 * Whether a value is one of the catalog's identities, by exact match.
 *
 * The one runtime check of a stored or submitted identity: no case folding and no label matching, so
 * `roic_ttm` or `ROIC TTM` is simply not an identity.
 */
export function isFundamentalMetricId(
  value: unknown,
): value is FundamentalMetricId {
  return (
    typeof value === "string" &&
    (FUNDAMENTAL_METRIC_IDS as readonly string[]).includes(value)
  );
}

/**
 * The catalog entry for an identity, or `undefined` when it is not one.
 *
 * Non-throwing, so rendering a drifted document never crashes: validation is what rejects an unknown
 * identity, and a preview that threw would hide the very rule the user needs to fix.
 */
export function findFundamentalMetric(
  id: string,
): FundamentalMetricCatalogEntry | undefined {
  return FUNDAMENTAL_METRIC_CATALOG.find((entry) => entry.id === id);
}
