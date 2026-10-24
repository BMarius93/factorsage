/**
 * Historical point-in-time universes: the catalog of built-in Lists whose membership is reconstructed
 * or generated from history rather than typed in (`docs/decisions/historical-universes-v1.md`).
 *
 * Every universe is one SYSTEM-owned premium List whose members carry `CUSTOM` buy windows — a
 * security is eligible to buy only while it belonged to the universe, exactly as
 * `isBuyWindowEligible` says, and is never force-sold when it leaves. A universe is one of:
 *
 * - **an index** (`INDEX_MEMBERSHIP`): the reconstructed membership of the S&P 500, the Nasdaq-100 or
 *   the Dow (`market-index.ts`, `sp500-historical-pit-v1.md`);
 * - **a ranking** (`RANK`): on each reconstitution date, the top N of a parent universe's members by
 *   one metric, read only from data available at that date's close, in effect from the next
 *   session until the next reconstitution;
 * - **a sector** (`SECTOR`): a parent index's members in one GICS sector on each date.
 *
 * This module is pure data and the rules every process must agree on. Nothing here reads a
 * database; the generator (`@intrinsic/stock-data` `historical-universes/`) evaluates these
 * definitions, persists each generation, validates it and, only when it passes, projects it into
 * the List.
 */

import type { LocalDate } from "./stock-data.js";
import {
  pointInTimeIndexUniverse,
  SP500_HISTORICAL_PIT_UNIVERSE,
  type MarketIndexKey,
} from "./market-index.js";

/** How the built-in Lists page groups the universes. */
export const HISTORICAL_UNIVERSE_CATEGORIES = [
  "MARKET_INDICES",
  "SP500_SECTORS",
  "MARKET_CAPITALIZATION",
  "INVESTMENT_STYLES",
  "DOW_STRATEGIES",
  /** Internal candidates: generated and validated for research, never in the public catalog. */
  "RESEARCH",
] as const;

export type HistoricalUniverseCategory =
  (typeof HISTORICAL_UNIVERSE_CATEGORIES)[number];

/** The heading each category has on the Lists page. */
export const HISTORICAL_UNIVERSE_CATEGORY_LABELS: Readonly<
  Record<HistoricalUniverseCategory, string>
> = {
  MARKET_INDICES: "Market Indices",
  SP500_SECTORS: "S&P 500 Sectors",
  MARKET_CAPITALIZATION: "Market Cap",
  INVESTMENT_STYLES: "Investment Styles",
  DOW_STRATEGIES: "Dow Strategies",
  RESEARCH: "Research",
};

/**
 * A universe's lifecycle.
 *
 * - `DRAFT`: defined, not generated, or generated without passing validation yet.
 * - `VALIDATED`: its latest generation passed every validation criterion; not visible to customers.
 * - `PUBLISHED`: a validated generation is projected into the built-in List.
 * - `BLOCKED`: it cannot be generated defensibly — a required historical dataset does not exist — or
 *   a generation failed a criterion no rerun can fix. The definition and its diagnostics are kept.
 */
export const HISTORICAL_UNIVERSE_STATUSES = [
  "DRAFT",
  "VALIDATED",
  "PUBLISHED",
  "BLOCKED",
] as const;

export type HistoricalUniverseStatus =
  (typeof HISTORICAL_UNIVERSE_STATUSES)[number];

/** `CATALOG`: one of the customer-facing universes. `INTERNAL`: a research candidate. */
export type HistoricalUniverseAudience = "CATALOG" | "INTERNAL";

/**
 * What a ranking universe ranks by. Every metric is evaluated on a reconstitution date `T` from data
 * whose availability is on or before `T`'s close; the selection takes effect on the next session.
 */
export const UNIVERSE_RANKING_METRICS = [
  /** Close × the latest point-in-time reported share count (valuation-ratios-v1 rules). */
  "MARKET_CAP",
  /** Price return from 252 to 21 sessions before `T` (skips the latest month). */
  "MOMENTUM_12_1",
  /** Price return over the last 126 sessions. */
  "RETURN_6M",
  /** Price return over the last 252 sessions. */
  "RETURN_12M",
  /** `MOMENTUM_12_1` divided by the annualized volatility of the same window. */
  "RISK_ADJUSTED_MOMENTUM_12_1",
  /** Annualized standard deviation of the last 252 daily log returns. */
  "VOLATILITY_252D",
  /** Mean of close × volume over the last 63 sessions. */
  "DOLLAR_VOLUME_63D",
  /** Latest regular dividend × payments per year, over the close. */
  "INDICATED_DIVIDEND_YIELD",
  /** 1 / P/E (TTM), positive earnings only. */
  "EARNINGS_YIELD_TTM",
  /** 1 / P/FCF (TTM), positive free cash flow only. */
  "FCF_YIELD_TTM",
  /** 1 / P/B, positive book only. */
  "BOOK_TO_PRICE",
  /** 1 / P/S (TTM). */
  "SALES_TO_PRICE_TTM",
  "REVENUE_GROWTH_TTM_YOY",
  "EPS_GROWTH_TTM_YOY",
  "FCF_GROWTH_TTM_YOY",
  "ROIC_TTM",
  "ROE_TTM",
  "GROSS_MARGIN_TTM",
  "INTEREST_COVERAGE_TTM",
  "NET_DEBT_TO_EBITDA_TTM",
  /** Mean percentile of revenue growth, EPS growth and 12-month return among the candidates. */
  "GROWTH_SCORE",
  /** Mean percentile of book-to-price, earnings yield and sales-to-price among the candidates. */
  "VALUE_SCORE",
  /** The as-traded share price: the close with every later split undone. */
  "NOMINAL_PRICE",
] as const;

export type UniverseRankingMetric = (typeof UNIVERSE_RANKING_METRICS)[number];

/**
 * When a ranking universe reconstitutes: on the last trading session of each listed month (1–12).
 * The selection read at that session's close takes effect on the next session.
 */
export type UniverseReconstitution = {
  readonly frequency: "MONTHLY" | "QUARTERLY" | "SEMI_ANNUAL" | "ANNUAL";
  readonly months: readonly number[];
};

/** The reconstitution calendars the catalog uses. */
export const RECONSTITUTION = {
  MONTHLY: {
    frequency: "MONTHLY",
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  },
  QUARTERLY: { frequency: "QUARTERLY", months: [3, 6, 9, 12] },
  /** Rebalanced in January and July, on the last sessions of December and June. */
  SEMI_ANNUAL: { frequency: "SEMI_ANNUAL", months: [6, 12] },
  /** Selected on the last session of the year, in effect from the first session of the next. */
  ANNUAL: { frequency: "ANNUAL", months: [12] },
} as const satisfies Record<
  UniverseReconstitution["frequency"],
  UniverseReconstitution
>;

const { MONTHLY, QUARTERLY, SEMI_ANNUAL, ANNUAL } = RECONSTITUTION;

/** What a derived universe selects from. */
export type UniverseParent =
  | { readonly kind: "INDEX"; readonly indexKey: MarketIndexKey }
  /** Another universe's selection on the same reconstitution date (Small Dogs from the Dogs). */
  | { readonly kind: "UNIVERSE"; readonly key: string };

export const GICS_SECTORS = [
  "INFORMATION_TECHNOLOGY",
  "FINANCIALS",
  "HEALTH_CARE",
  "ENERGY",
  "INDUSTRIALS",
  "UTILITIES",
  "COMMUNICATION_SERVICES",
  "CONSUMER_DISCRETIONARY",
  "CONSUMER_STAPLES",
  "MATERIALS",
  "REAL_ESTATE",
] as const;

export type GicsSector = (typeof GICS_SECTORS)[number];

export type UniverseMethod =
  | { readonly kind: "INDEX_MEMBERSHIP"; readonly indexKey: MarketIndexKey }
  | {
      readonly kind: "SECTOR";
      readonly indexKey: MarketIndexKey;
      readonly sector: GicsSector;
    }
  | {
      readonly kind: "RANK";
      readonly parent: UniverseParent;
      readonly metric: UniverseRankingMetric;
      /** `HIGHEST` selects the largest values, `LOWEST` the smallest. */
      readonly order: "HIGHEST" | "LOWEST";
      /** A fixed count, or a fraction of the candidates with a value (rounded half up). */
      readonly select:
        { readonly count: number } | { readonly fraction: number };
      readonly reconstitution: UniverseReconstitution;
      /** Leave out candidates whose value is not strictly positive (a yield of zero ranks nothing). */
      readonly positiveOnly?: boolean;
    };

/**
 * A dataset a universe cannot be generated without. A universe whose required dataset is absent
 * stays `BLOCKED` with the reason, never generated from a substitute.
 */
export const UNIVERSE_DATA_REQUIREMENTS = [
  "INDEX_MEMBERSHIP",
  "DAILY_PRICES",
  "FINANCIAL_STATEMENTS",
  "FUNDAMENTAL_METRICS",
  "DIVIDENDS",
  "STOCK_SPLITS",
  /** Point-in-time GICS sector of each member on each date. No source in V1. */
  "HISTORICAL_SECTOR_CLASSIFICATION",
] as const;

export type UniverseDataRequirement =
  (typeof UNIVERSE_DATA_REQUIREMENTS)[number];

export type HistoricalUniverseDefinition = {
  /** The built-in List's immutable `systemKey`, and the universe's identity everywhere. */
  readonly key: string;
  readonly name: string;
  /** One or two sentences for the Lists page: what it holds and how it is chosen. */
  readonly description: string;
  readonly category: HistoricalUniverseCategory;
  readonly audience: HistoricalUniverseAudience;
  /** Order inside its category. */
  readonly displayOrder: number;
  readonly method: UniverseMethod;
  /**
   * Bumped whenever the method changes a selection: a generation records the version it ran, and
   * a published generation of an older version is regenerated rather than silently relabelled.
   */
  readonly methodologyVersion: number;
  /** The methodology in full sentences, for the decision record and the List's details. */
  readonly methodology: string;
  readonly requires: readonly UniverseDataRequirement[];
};

/** Datasets no V1 source provides. A universe requiring one is blocked by definition. */
export const UNAVAILABLE_UNIVERSE_DATA: readonly UniverseDataRequirement[] = [
  "HISTORICAL_SECTOR_CLASSIFICATION",
];

const SP500: UniverseParent = { kind: "INDEX", indexKey: "SP500" };
const NASDAQ100: UniverseParent = { kind: "INDEX", indexKey: "NASDAQ100" };
const DOW30: UniverseParent = { kind: "INDEX", indexKey: "DOW30" };

const PRICE_ONLY: readonly UniverseDataRequirement[] = [
  "INDEX_MEMBERSHIP",
  "DAILY_PRICES",
];
const WITH_STATEMENTS: readonly UniverseDataRequirement[] = [
  "INDEX_MEMBERSHIP",
  "DAILY_PRICES",
  "FINANCIAL_STATEMENTS",
  "STOCK_SPLITS",
];
const WITH_FUNDAMENTALS: readonly UniverseDataRequirement[] = [
  "INDEX_MEMBERSHIP",
  "DAILY_PRICES",
  "FUNDAMENTAL_METRICS",
];
const WITH_DIVIDENDS: readonly UniverseDataRequirement[] = [
  "INDEX_MEMBERSHIP",
  "DAILY_PRICES",
  "DIVIDENDS",
];

const MARKET_CAP_METHOD =
  "Market capitalization is the session's close times the share count of the latest quarterly " +
  "income statement that was public by then, under the valuation ratios' price-basis rules " +
  "(valuation-ratios-v1): a session whose close and count cannot be shown to be on the same basis " +
  "has no value. Each listed share class of a company counts with the company's whole count.";

const RECONSTITUTION_RULE =
  "The ranking is read at the close of the last trading session of each reconstitution month, " +
  "only from data available by then; the selection takes effect from the next session and lasts " +
  "until the next reconstitution, and never extends a membership past the member's time in the " +
  "parent index. Ties are broken by the larger market capitalization, then the security's " +
  "catalog identity.";

function sectorUniverse(
  sector: GicsSector,
  label: string,
  displayOrder: number,
  note = "",
): HistoricalUniverseDefinition {
  const slug = sector.toLowerCase().replace(/_/g, "-");
  return {
    key: `sp500-sector-${slug === "information-technology" ? "technology" : slug}`,
    name: `S&P 500 ${label}`,
    description: `The S&P 500's ${label} sector members on each date.`,
    category: "SP500_SECTORS",
    audience: "CATALOG",
    displayOrder,
    method: { kind: "SECTOR", indexKey: "SP500", sector },
    methodologyVersion: 1,
    methodology:
      `The S&P 500 members classified in the GICS ${label} sector on each date, by the ` +
      `classification in force on that date.${note} Requires the point-in-time GICS sector of ` +
      "every member, which no V1 data source provides: the provider reports today's sector only, " +
      "in its own taxonomy rather than GICS.",
    requires: ["INDEX_MEMBERSHIP", "HISTORICAL_SECTOR_CLASSIFICATION"],
  };
}

function rank(input: {
  key: string;
  name: string;
  description: string;
  category: HistoricalUniverseCategory;
  audience: HistoricalUniverseAudience;
  displayOrder: number;
  parent?: UniverseParent;
  metric: UniverseRankingMetric;
  order?: "HIGHEST" | "LOWEST";
  select: { count: number } | { fraction: number };
  reconstitution: UniverseReconstitution;
  positiveOnly?: boolean;
  methodology: string;
  requires: readonly UniverseDataRequirement[];
  methodologyVersion?: number;
}): HistoricalUniverseDefinition {
  return {
    key: input.key,
    name: input.name,
    description: input.description,
    category: input.category,
    audience: input.audience,
    displayOrder: input.displayOrder,
    method: {
      kind: "RANK",
      parent: input.parent ?? SP500,
      metric: input.metric,
      order: input.order ?? "HIGHEST",
      select: input.select,
      reconstitution: input.reconstitution,
      ...(input.positiveOnly ? { positiveOnly: true } : {}),
    },
    methodologyVersion: input.methodologyVersion ?? 1,
    methodology: `${input.methodology} ${RECONSTITUTION_RULE}`,
    requires: input.requires,
  };
}

/** The customer-facing catalog: the 23 agreed universes. */
const CATALOG: readonly HistoricalUniverseDefinition[] = [
  {
    key: "sp500-historical-pit",
    name: "S&P 500 — Historical PIT",
    description:
      "Every S&P 500 constituent since 1996, each eligible to buy only while it was a member.",
    category: "MARKET_INDICES",
    audience: "CATALOG",
    displayOrder: 1,
    method: { kind: "INDEX_MEMBERSHIP", indexKey: "SP500" },
    methodologyVersion: 1,
    methodology:
      "The provider's S&P 500 change log walked backward from today's list, with identity " +
      "resolution and effective-date refinement (sp500-historical-pit-v1).",
    requires: ["INDEX_MEMBERSHIP", "DAILY_PRICES"],
  },
  {
    key: "nasdaq100-historical-pit",
    name: "Nasdaq-100 — Historical PIT",
    description:
      "Every Nasdaq-100 constituent, each eligible to buy only while it was a member.",
    category: "MARKET_INDICES",
    audience: "CATALOG",
    displayOrder: 2,
    method: { kind: "INDEX_MEMBERSHIP", indexKey: "NASDAQ100" },
    methodologyVersion: 1,
    methodology:
      "The provider's Nasdaq-100 change log walked backward from today's list with the S&P 500's " +
      "reconstruction, resolution and effective-date rules.",
    requires: ["INDEX_MEMBERSHIP", "DAILY_PRICES"],
  },
  {
    key: "dow30-historical-pit",
    name: "Dow Jones 30 — Historical PIT",
    description:
      "Every Dow Jones Industrial Average component, each eligible to buy only while it was a member.",
    category: "MARKET_INDICES",
    audience: "CATALOG",
    displayOrder: 3,
    method: { kind: "INDEX_MEMBERSHIP", indexKey: "DOW30" },
    methodologyVersion: 1,
    methodology:
      "The provider's Dow change log walked backward from today's list with the S&P 500's " +
      "reconstruction rules, plus two documented corrections where the log omits a published " +
      "change (Travelers Group, 1997; Dow Inc., 2019).",
    requires: ["INDEX_MEMBERSHIP", "DAILY_PRICES"],
  },
  sectorUniverse("INFORMATION_TECHNOLOGY", "Technology", 1),
  sectorUniverse(
    "FINANCIALS",
    "Financials",
    2,
    " Real Estate was part of Financials until 2016.",
  ),
  sectorUniverse("HEALTH_CARE", "Health Care", 3),
  sectorUniverse("ENERGY", "Energy", 4),
  sectorUniverse("INDUSTRIALS", "Industrials", 5),
  sectorUniverse("UTILITIES", "Utilities", 6),
  sectorUniverse(
    "COMMUNICATION_SERVICES",
    "Communication Services",
    7,
    " The sector replaced Telecommunication Services in 2018 and took members from Information " +
      "Technology and Consumer Discretionary.",
  ),
  sectorUniverse("CONSUMER_DISCRETIONARY", "Consumer Discretionary", 8),
  sectorUniverse("CONSUMER_STAPLES", "Consumer Staples", 9),
  sectorUniverse("MATERIALS", "Materials", 10),
  sectorUniverse(
    "REAL_ESTATE",
    "Real Estate",
    11,
    " The sector exists only from 2016-09-19; before it, these companies were Financials.",
  ),
  rank({
    key: "sp500-top100-market-cap",
    name: "S&P 500 Top 100 by Market Cap",
    description:
      "The 100 largest S&P 500 members by market capitalization, reconstituted monthly.",
    category: "MARKET_CAPITALIZATION",
    audience: "CATALOG",
    displayOrder: 1,
    metric: "MARKET_CAP",
    select: { count: 100 },
    reconstitution: MONTHLY,
    methodology: `The 100 S&P 500 members with the largest market capitalization. ${MARKET_CAP_METHOD}`,
    requires: WITH_STATEMENTS,
  }),
  rank({
    key: "sp500-top250-market-cap",
    name: "S&P 500 Top 250 by Market Cap",
    description:
      "The 250 largest S&P 500 members by market capitalization, reconstituted monthly.",
    category: "MARKET_CAPITALIZATION",
    audience: "CATALOG",
    displayOrder: 2,
    metric: "MARKET_CAP",
    select: { count: 250 },
    reconstitution: MONTHLY,
    methodology: `The 250 S&P 500 members with the largest market capitalization. ${MARKET_CAP_METHOD}`,
    requires: WITH_STATEMENTS,
  }),
  rank({
    key: "sp500-growth",
    name: "S&P 500 Growth",
    description:
      "The third of S&P 500 members with the strongest growth: revenue, earnings and price. " +
      "A FactorSage method, not the official S&P 500 Growth index.",
    category: "INVESTMENT_STYLES",
    audience: "CATALOG",
    displayOrder: 1,
    metric: "GROWTH_SCORE",
    select: { fraction: 1 / 3 },
    reconstitution: QUARTERLY,
    methodology:
      "The official S&P 500 Growth membership cannot be reconstructed from provider data, so this is " +
      "FactorSage's own: each member's growth score is the mean of its percentile ranks, among the " +
      "S&P 500 members on the date, of trailing-twelve-month revenue growth, trailing-twelve-month " +
      "EPS growth (point-in-time Fundamental Metrics) and 12-month price return; a member needs at " +
      "least two of the three. The top third by score is selected, reconstituted quarterly.",
    requires: [...WITH_FUNDAMENTALS],
  }),
  rank({
    key: "sp500-value",
    name: "S&P 500 Value",
    description:
      "The third of S&P 500 members that are cheapest on book, earnings and sales. A FactorSage " +
      "method, not the official S&P 500 Value index.",
    category: "INVESTMENT_STYLES",
    audience: "CATALOG",
    displayOrder: 2,
    metric: "VALUE_SCORE",
    select: { fraction: 1 / 3 },
    reconstitution: QUARTERLY,
    methodology:
      "The official S&P 500 Value membership cannot be reconstructed from provider data, so this is " +
      "FactorSage's own: each member's value score is the mean of its percentile ranks, among the " +
      "S&P 500 members on the date, of book-to-price, earnings yield and sales-to-price, each from " +
      "the point-in-time valuation ratios (valuation-ratios-v1); a member needs at least two of the " +
      "three. The top third by score is selected, reconstituted quarterly.",
    requires: WITH_STATEMENTS,
  }),
  rank({
    key: "sp500-high-dividend",
    name: "S&P 500 High Dividend",
    description:
      "The 80 S&P 500 members with the highest indicated dividend yield, reconstituted every January and July.",
    category: "INVESTMENT_STYLES",
    audience: "CATALOG",
    displayOrder: 3,
    metric: "INDICATED_DIVIDEND_YIELD",
    select: { count: 80 },
    reconstitution: SEMI_ANNUAL,
    positiveOnly: true,
    methodology:
      "The 80 S&P 500 members with the highest indicated dividend yield: the latest regular " +
      "dividend whose ex-date has passed, times its payments per year, over the close. Special and " +
      "irregular dividends are left out; a dividend counts only once its ex-date (or, earlier, its " +
      "declaration) is on or before the selection date. A security with no regular dividend in the " +
      "last year has no yield.",
    requires: WITH_DIVIDENDS,
  }),
  rank({
    key: "sp500-top50-momentum",
    name: "S&P 500 Top 50 Momentum",
    description:
      "The 50 S&P 500 members with the strongest 12-1 month price momentum, reconstituted monthly.",
    category: "INVESTMENT_STYLES",
    audience: "CATALOG",
    displayOrder: 4,
    metric: "MOMENTUM_12_1",
    select: { count: 50 },
    reconstitution: MONTHLY,
    methodology:
      "The 50 S&P 500 members with the highest 12-1 momentum: the price return from 252 sessions to " +
      "21 sessions before the selection date, skipping the latest month as the conventional " +
      "measure does. A member needs a close on both sessions.",
    requires: PRICE_ONLY,
  }),
  rank({
    key: "sp500-top100-liquidity",
    name: "S&P 500 Top 100 by Liquidity",
    description:
      "The 100 most traded S&P 500 members by average daily dollar volume, reconstituted monthly.",
    category: "INVESTMENT_STYLES",
    audience: "CATALOG",
    displayOrder: 5,
    metric: "DOLLAR_VOLUME_63D",
    select: { count: 100 },
    reconstitution: MONTHLY,
    methodology:
      "The 100 S&P 500 members with the highest average daily dollar volume — close times volume — " +
      "over the 63 sessions to the selection date. A member needs at least 50 of those sessions.",
    requires: PRICE_ONLY,
  }),
  rank({
    key: "dogs-of-the-dow",
    name: "Dogs of the Dow",
    description:
      "The ten Dow stocks with the highest dividend yield at the end of each year, held for the next year.",
    category: "DOW_STRATEGIES",
    audience: "CATALOG",
    displayOrder: 1,
    parent: DOW30,
    metric: "INDICATED_DIVIDEND_YIELD",
    select: { count: 10 },
    reconstitution: ANNUAL,
    positiveOnly: true,
    methodology:
      "On the last trading session of each year, the ten Dow Jones Industrial Average components with " +
      "the highest indicated dividend yield (the latest regular dividend whose ex-date has passed, " +
      "times its payments per year, over that session's close), held from the first session of the " +
      "next year.",
    requires: WITH_DIVIDENDS,
  }),
  rank({
    key: "small-dogs-of-the-dow",
    name: "Small Dogs of the Dow",
    description: "The five lowest-priced of the year's ten Dogs of the Dow.",
    category: "DOW_STRATEGIES",
    audience: "CATALOG",
    displayOrder: 2,
    parent: { kind: "UNIVERSE", key: "dogs-of-the-dow" },
    metric: "NOMINAL_PRICE",
    order: "LOWEST",
    select: { count: 5 },
    reconstitution: ANNUAL,
    methodology:
      "On the same session as the Dogs of the Dow, the five of the ten Dogs with the lowest share " +
      "price as traded on that day: the stored split-adjusted close with every later split undone.",
    requires: [...WITH_DIVIDENDS, "STOCK_SPLITS"],
  }),
];

/** Research candidates: generated and validated internally, never published without a decision. */
const RESEARCH: readonly HistoricalUniverseDefinition[] = (() => {
  const entries: HistoricalUniverseDefinition[] = [];
  let order = 1;
  const add = (
    definition: Omit<
      Parameters<typeof rank>[0],
      "category" | "audience" | "displayOrder"
    >,
  ) => {
    entries.push(
      rank({
        ...definition,
        category: "RESEARCH",
        audience: "INTERNAL",
        displayOrder: order++,
      }),
    );
  };
  for (const count of [25, 50]) {
    add({
      key: `sp500-top${count}-market-cap`,
      name: `S&P 500 Top ${count} by Market Cap`,
      description: `The ${count} largest S&P 500 members by market capitalization, monthly.`,
      metric: "MARKET_CAP",
      select: { count },
      reconstitution: MONTHLY,
      methodology: `The ${count} S&P 500 members with the largest market capitalization. ${MARKET_CAP_METHOD}`,
      requires: WITH_STATEMENTS,
    });
  }
  for (const count of [50, 100]) {
    add({
      key: `sp500-bottom${count}-market-cap`,
      name: `S&P 500 Bottom ${count} by Market Cap`,
      description: `The ${count} smallest S&P 500 members by market capitalization, monthly.`,
      metric: "MARKET_CAP",
      order: "LOWEST",
      select: { count },
      reconstitution: MONTHLY,
      methodology: `The ${count} S&P 500 members with the smallest market capitalization. ${MARKET_CAP_METHOD}`,
      requires: WITH_STATEMENTS,
    });
  }
  for (const count of [25, 100]) {
    add({
      key: `sp500-top${count}-momentum`,
      name: `S&P 500 Top ${count} Momentum`,
      description: `The ${count} S&P 500 members with the strongest 12-1 momentum, monthly.`,
      metric: "MOMENTUM_12_1",
      select: { count },
      reconstitution: MONTHLY,
      methodology: `The ${count} S&P 500 members with the highest 12-1 momentum.`,
      requires: PRICE_ONLY,
    });
  }
  add({
    key: "sp500-top50-return-6m",
    name: "S&P 500 Top 50 by 6-Month Return",
    description:
      "The 50 S&P 500 members with the highest 6-month price return, monthly.",
    metric: "RETURN_6M",
    select: { count: 50 },
    reconstitution: MONTHLY,
    methodology:
      "The 50 S&P 500 members with the highest price return over 126 sessions.",
    requires: PRICE_ONLY,
  });
  add({
    key: "sp500-top50-return-12m",
    name: "S&P 500 Top 50 by 12-Month Return",
    description:
      "The 50 S&P 500 members with the highest 12-month price return, monthly.",
    metric: "RETURN_12M",
    select: { count: 50 },
    reconstitution: MONTHLY,
    methodology:
      "The 50 S&P 500 members with the highest price return over 252 sessions.",
    requires: PRICE_ONLY,
  });
  add({
    key: "sp500-top50-risk-adjusted-momentum",
    name: "S&P 500 Top 50 Risk-Adjusted Momentum",
    description:
      "The 50 S&P 500 members with the best 12-1 momentum per unit of volatility, monthly.",
    metric: "RISK_ADJUSTED_MOMENTUM_12_1",
    select: { count: 50 },
    reconstitution: MONTHLY,
    methodology:
      "The 50 S&P 500 members with the highest 12-1 momentum divided by the annualized volatility of " +
      "daily log returns over the same window.",
    requires: PRICE_ONLY,
  });
  for (const count of [50, 100]) {
    add({
      key: `sp500-low-volatility-${count}`,
      name: `S&P 500 ${count} Lowest Volatility`,
      description: `The ${count} S&P 500 members with the lowest one-year volatility, monthly.`,
      metric: "VOLATILITY_252D",
      order: "LOWEST",
      select: { count },
      reconstitution: MONTHLY,
      methodology: `The ${count} S&P 500 members with the lowest annualized volatility of the last 252 daily log returns; a member needs 240 of them.`,
      requires: PRICE_ONLY,
    });
    add({
      key: `sp500-high-volatility-${count}`,
      name: `S&P 500 ${count} Highest Volatility`,
      description: `The ${count} S&P 500 members with the highest one-year volatility, monthly.`,
      metric: "VOLATILITY_252D",
      select: { count },
      reconstitution: MONTHLY,
      methodology: `The ${count} S&P 500 members with the highest annualized volatility of the last 252 daily log returns; a member needs 240 of them.`,
      requires: PRICE_ONLY,
    });
  }
  add({
    key: "sp500-top50-liquidity",
    name: "S&P 500 Top 50 by Liquidity",
    description:
      "The 50 most traded S&P 500 members by average daily dollar volume, monthly.",
    metric: "DOLLAR_VOLUME_63D",
    select: { count: 50 },
    reconstitution: MONTHLY,
    methodology:
      "The 50 S&P 500 members with the highest 63-session average dollar volume.",
    requires: PRICE_ONLY,
  });
  const fundamental: [
    string,
    string,
    UniverseRankingMetric,
    string,
    readonly UniverseDataRequirement[],
    boolean,
  ][] = [
    [
      "sp500-top50-earnings-yield",
      "Earnings Yield",
      "EARNINGS_YIELD_TTM",
      "earnings yield (1 / P/E TTM, positive earnings)",
      WITH_STATEMENTS,
      true,
    ],
    [
      "sp500-top50-fcf-yield",
      "Free Cash Flow Yield",
      "FCF_YIELD_TTM",
      "free cash flow yield (1 / P/FCF TTM, positive free cash flow)",
      WITH_STATEMENTS,
      true,
    ],
    [
      "sp500-top50-book-to-price",
      "Book-to-Price",
      "BOOK_TO_PRICE",
      "book-to-price (1 / P/B, positive book)",
      WITH_STATEMENTS,
      true,
    ],
    [
      "sp500-top50-revenue-growth",
      "Revenue Growth",
      "REVENUE_GROWTH_TTM_YOY",
      "trailing-twelve-month revenue growth",
      WITH_FUNDAMENTALS,
      false,
    ],
    [
      "sp500-top50-eps-growth",
      "EPS Growth",
      "EPS_GROWTH_TTM_YOY",
      "trailing-twelve-month EPS growth",
      WITH_FUNDAMENTALS,
      false,
    ],
    [
      "sp500-top50-fcf-growth",
      "Free Cash Flow Growth",
      "FCF_GROWTH_TTM_YOY",
      "trailing-twelve-month free cash flow growth",
      WITH_FUNDAMENTALS,
      false,
    ],
    [
      "sp500-top50-roic",
      "ROIC",
      "ROIC_TTM",
      "trailing-twelve-month return on invested capital",
      WITH_FUNDAMENTALS,
      false,
    ],
    [
      "sp500-top50-roe",
      "ROE",
      "ROE_TTM",
      "trailing-twelve-month return on equity",
      WITH_FUNDAMENTALS,
      false,
    ],
    [
      "sp500-top50-gross-margin",
      "Gross Margin",
      "GROSS_MARGIN_TTM",
      "trailing-twelve-month gross margin (profitability)",
      WITH_FUNDAMENTALS,
      false,
    ],
    [
      "sp500-top50-interest-coverage",
      "Interest Coverage",
      "INTEREST_COVERAGE_TTM",
      "trailing-twelve-month interest coverage (financial strength)",
      WITH_FUNDAMENTALS,
      false,
    ],
  ];
  for (const [
    key,
    label,
    metric,
    measure,
    requires,
    positiveOnly,
  ] of fundamental) {
    add({
      key,
      name: `S&P 500 Top 50 by ${label}`,
      description: `The 50 S&P 500 members with the highest ${label.toLowerCase()}, quarterly.`,
      metric,
      select: { count: 50 },
      reconstitution: QUARTERLY,
      positiveOnly,
      methodology: `The 50 S&P 500 members with the highest ${measure}, from point-in-time data only.`,
      requires,
    });
  }
  add({
    key: "sp500-50-lowest-leverage",
    name: "S&P 500 50 Lowest Net Debt to EBITDA",
    description:
      "The 50 S&P 500 members with the lowest net debt to EBITDA, quarterly.",
    metric: "NET_DEBT_TO_EBITDA_TTM",
    order: "LOWEST",
    select: { count: 50 },
    reconstitution: QUARTERLY,
    methodology:
      "The 50 S&P 500 members with the lowest trailing-twelve-month net debt to EBITDA (balance-sheet " +
      "strength), from point-in-time Fundamental Metrics; members with negative EBITDA have no value.",
    requires: WITH_FUNDAMENTALS,
  });
  add({
    key: "nasdaq100-top25-market-cap",
    name: "Nasdaq-100 Top 25 by Market Cap",
    description:
      "The 25 largest Nasdaq-100 members by market capitalization, monthly.",
    parent: NASDAQ100,
    metric: "MARKET_CAP",
    select: { count: 25 },
    reconstitution: MONTHLY,
    methodology: `The 25 Nasdaq-100 members with the largest market capitalization. ${MARKET_CAP_METHOD}`,
    requires: WITH_STATEMENTS,
  });
  add({
    key: "nasdaq100-top20-momentum",
    name: "Nasdaq-100 Top 20 Momentum",
    description:
      "The 20 Nasdaq-100 members with the strongest 12-1 momentum, monthly.",
    parent: NASDAQ100,
    metric: "MOMENTUM_12_1",
    select: { count: 20 },
    reconstitution: MONTHLY,
    methodology: "The 20 Nasdaq-100 members with the highest 12-1 momentum.",
    requires: PRICE_ONLY,
  });
  add({
    key: "dow30-top10-momentum",
    name: "Dow 30 Top 10 Momentum",
    description:
      "The 10 Dow components with the strongest 12-1 momentum, monthly.",
    parent: DOW30,
    metric: "MOMENTUM_12_1",
    select: { count: 10 },
    reconstitution: MONTHLY,
    methodology:
      "The 10 Dow Jones Industrial Average components with the highest 12-1 momentum.",
    requires: PRICE_ONLY,
  });
  return entries;
})();

export const HISTORICAL_UNIVERSES: readonly HistoricalUniverseDefinition[] = [
  ...CATALOG,
  ...RESEARCH,
];

/** The customer-facing universes, in catalog order. */
export const CATALOG_HISTORICAL_UNIVERSES: readonly HistoricalUniverseDefinition[] =
  CATALOG;

export function historicalUniverse(
  key: string | null | undefined,
): HistoricalUniverseDefinition | null {
  if (!key) {
    return null;
  }
  return HISTORICAL_UNIVERSES.find((universe) => universe.key === key) ?? null;
}

export function requireHistoricalUniverse(
  key: string,
): HistoricalUniverseDefinition {
  const universe = historicalUniverse(key);
  if (!universe) {
    throw new Error(`No historical universe is defined with the key ${key}`);
  }
  return universe;
}

/** The data a universe requires that no V1 source provides; empty when it can be generated at all. */
export function unavailableRequirements(
  definition: HistoricalUniverseDefinition,
): readonly UniverseDataRequirement[] {
  return definition.requires.filter((requirement) =>
    UNAVAILABLE_UNIVERSE_DATA.includes(requirement),
  );
}

/**
 * The index a universe is ultimately drawn from: its own index, a sector's index, or its parent's
 * root. Backtests measure and allow a universe through this index (`backtests.maxIndexUniverseConstituents`).
 */
export function rootIndexOf(
  definition: HistoricalUniverseDefinition,
): MarketIndexKey {
  const method = definition.method;
  if (method.kind === "INDEX_MEMBERSHIP" || method.kind === "SECTOR") {
    return method.indexKey;
  }
  if (method.parent.kind === "INDEX") {
    return method.parent.indexKey;
  }
  return rootIndexOf(requireHistoricalUniverse(method.parent.key));
}

/** The reconstitution of a derived universe, or `null` for an index or a sector. */
export function reconstitutionOf(
  definition: HistoricalUniverseDefinition,
): UniverseReconstitution | null {
  return definition.method.kind === "RANK"
    ? definition.method.reconstitution
    : null;
}

/** The earliest date a universe's List is projected from: the thirty-year product horizon. */
export const HISTORICAL_UNIVERSE_FLOOR: LocalDate = "1996-01-02";

/**
 * A built-in List the product maintains rather than edits — an index universe or a derived one —
 * as every process must treat it: premium, measured by its most simultaneous members, refused for
 * duplication, and drawn from `indexKey`, its root index (`docs/decisions/historical-universes-v1.md`
 * §6).
 */
export type MaintainedUniverse = {
  /** The historical universe's key, which is also the List's `systemKey`. */
  readonly universeKey: string;
  readonly listSystemKey: string;
  readonly listName: string;
  readonly listDescription: string;
  readonly category: HistoricalUniverseCategory;
  readonly displayOrder: number;
  /** The root index: the benchmark calendar, the protected-tier decision and the plan's measure. */
  readonly indexKey: MarketIndexKey;
  /** The earliest date its membership is measured from; its List starts no earlier. */
  readonly membershipFloor: LocalDate;
  /** False for an index's own membership, true for a ranking drawn from one. */
  readonly derived: boolean;
};

/** The catalog universe whose built-in List has `systemKey`; `null` for every other List. */
export function maintainedUniverseForList(
  systemKey: string | null | undefined,
): MaintainedUniverse | null {
  const definition = historicalUniverse(systemKey);
  if (!definition || definition.audience !== "CATALOG") {
    return null;
  }
  return maintainedUniverseOf(definition);
}

export function maintainedUniverseOf(
  definition: HistoricalUniverseDefinition,
): MaintainedUniverse {
  // An index universe's List keeps the name and the survivorship disclosure it was published with.
  const index =
    definition.method.kind === "INDEX_MEMBERSHIP"
      ? pointInTimeIndexUniverse(definition.method.indexKey)
      : null;
  return {
    universeKey: definition.key,
    listSystemKey: definition.key,
    listName: index?.listName ?? definition.name,
    listDescription: index?.listDescription ?? definition.description,
    category: definition.category,
    displayOrder: definition.displayOrder,
    indexKey: rootIndexOf(definition),
    membershipFloor: HISTORICAL_UNIVERSE_FLOOR,
    derived: definition.method.kind !== "INDEX_MEMBERSHIP",
  };
}

/**
 * The first day a published universe's List carries: the S&P 500's own List keeps the floor it was
 * published with (`sp500-historical-pit-v1.md`, with its survivorship disclosure); every other
 * universe starts at its validated reliable period's first effective date, `publishFrom`.
 */
export function publishedListFloor(
  key: string,
  publishFrom: LocalDate | null,
): LocalDate | null {
  if (key === SP500_HISTORICAL_PIT_UNIVERSE.listSystemKey) {
    return SP500_HISTORICAL_PIT_UNIVERSE.membershipFloor;
  }
  return publishFrom;
}
