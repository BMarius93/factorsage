/**
 * The one product-facing catalog of the Valuation Ratios V1.
 *
 * `docs/decisions/valuation-ratios-v1.md` is the methodology this catalog names. Like the Fundamental
 * Metrics catalog, it lives in `@intrinsic/contracts` because this is the only package the web app may
 * depend on, and the Strategy Builder, the backend validator and the calculation in
 * `@intrinsic/stock-data` must read one list: each ratio's identity, its one label, the smallest Value
 * a rule may name, and the words that explain it.
 *
 * Every ratio is a raw multiple of the company's market capitalisation, or of its enterprise value
 * for EV/EBITDA: a P/E of 15.2 is 15.2, entered as `15` and shown as `15x`. Nothing here is stored
 * per session; the calculation projects a ratio when it is read.
 */

/**
 * The family's one product label wherever the five ratios are offered together: the Strategy
 * Builder's metric category (where Margin of Safety sits beside them) and the Stock Details chart's
 * section both read it.
 */
export const VALUATION_RATIOS_LABEL = "Valuation";

export type ValuationRatioCatalogEntry = {
  /**
   * Stable machine identity. Permanent: a Strategy document, its fingerprint and every frame column
   * carry it. Never a label, and never parsed.
   */
  id: string;
  /** The one product label, used by every surface. */
  label: string;
  /**
   * The smallest threshold a rule may compare with, present only where the ratio's own mathematics
   * has a floor: a ratio of a positive market capitalisation to a positive denominator is never
   * below zero. EV/EBITDA has none, because net cash larger than the market capitalisation makes its
   * enterprise value negative.
   */
  minimum?: number;
  /** What the ratio measures, in one sentence of product vocabulary. */
  summary: string;
  /** The canonical formula, in product vocabulary. */
  formula: string;
};

/** Every Valuation Ratio, in canonical order: exactly five. */
export const VALUATION_RATIO_CATALOG = [
  {
    id: "PRICE_TO_EARNINGS_TTM",
    label: "P/E",
    minimum: 0,
    summary:
      "Market capitalisation as a multiple of net income over the latest four reported quarters.",
    formula:
      "P/E = Market Cap / Net Income TTM, where Market Cap = Close * Diluted Shares",
  },
  {
    id: "PRICE_TO_SALES_TTM",
    label: "P/S",
    minimum: 0,
    summary:
      "Market capitalisation as a multiple of revenue over the latest four reported quarters.",
    formula:
      "P/S = Market Cap / Revenue TTM, where Market Cap = Close * Diluted Shares",
  },
  {
    id: "PRICE_TO_BOOK",
    label: "P/B",
    minimum: 0,
    summary:
      "Market capitalisation as a multiple of stockholders' equity on the latest reported balance sheet.",
    formula:
      "P/B = Market Cap / Stockholders' Equity, where Market Cap = Close * Diluted Shares",
  },
  {
    id: "PRICE_TO_FCF_TTM",
    label: "P/FCF",
    minimum: 0,
    summary:
      "Market capitalisation as a multiple of free cash flow over the latest four reported quarters.",
    formula:
      "P/FCF = Market Cap / FCF TTM, where Market Cap = Close * Diluted Shares and FCF = Operating Cash Flow + Capital Expenditure",
  },
  {
    id: "EV_TO_EBITDA_TTM",
    label: "EV/EBITDA",
    summary:
      "Enterprise value, the market capitalisation plus net debt, as a multiple of EBITDA over the latest four reported quarters.",
    formula:
      "EV/EBITDA = (Market Cap + Net Debt) / EBITDA TTM, where Market Cap = Close * Diluted Shares",
  },
] as const satisfies readonly ValuationRatioCatalogEntry[];

export type ValuationRatioId = (typeof VALUATION_RATIO_CATALOG)[number]["id"];

/** Every valuation ratio identity, in canonical order. */
export const VALUATION_RATIO_IDS: readonly ValuationRatioId[] =
  VALUATION_RATIO_CATALOG.map((entry) => entry.id);

/**
 * Whether a value is one of the catalog's identities, by exact match.
 *
 * The one runtime check of a stored or submitted identity: no case folding and no label matching, so
 * `pe` or `P/E` is simply not an identity.
 */
export function isValuationRatioId(value: unknown): value is ValuationRatioId {
  return (
    typeof value === "string" &&
    (VALUATION_RATIO_IDS as readonly string[]).includes(value)
  );
}

/**
 * The catalog entry for an identity, or `undefined` when it is not one.
 *
 * Non-throwing, so rendering a drifted document never crashes: validation is what rejects an unknown
 * identity.
 */
export function findValuationRatio(
  id: string,
): ValuationRatioCatalogEntry | undefined {
  return VALUATION_RATIO_CATALOG.find((entry) => entry.id === id);
}
