import { CONGRESS_CHAMBERS } from "@intrinsic/domain";
import { FMP_EOD_MAX_ROWS_PER_RESPONSE } from "@intrinsic/fmp";
import {
  fundamentalsDatasetOperations,
  priceRetentionYears,
  VALUATION_FUNDAMENTALS_WARMUP_YEARS,
} from "@intrinsic/stock-data";

/**
 * What "full history" is made of, what it leaves out, and how many requests it can cost.
 *
 * Every dataset FactorSage reads from the provider is classified here, once, and the same lists
 * are printed by `--plan`, checked by the tests and described in
 * `docs/development/fmp-live-hydration.md`. Nothing is added to make the phrase sound broader: a
 * dataset is included only if the product already loads it, per security, through a loader this
 * command can call unchanged.
 */

export type LiveFmpIncludedDataset = {
  readonly dataset: string;
  /** Provider endpoints the dataset is read from; empty when it is derived from stored data. */
  readonly endpoints: readonly string[];
  readonly history: string;
  readonly loader: string;
};

/** Safe per security, and hydrated. In the order a cold run reaches them. */
export function liveFmpIncludedDatasets(
  productHistoryYears: number,
): readonly LiveFmpIncludedDataset[] {
  const priceYears = priceRetentionYears(productHistoryYears);
  const statementYears =
    productHistoryYears + VALUATION_FUNDAMENTALS_WARMUP_YEARS;
  return [
    {
      dataset: "Security identity",
      endpoints: ["profile"],
      history: "one row; asked only for a symbol the catalog does not hold yet",
      loader: "CanonicalSecurityCatalogService.sync, fed the approved symbols",
    },
    {
      dataset: "Security profile",
      endpoints: ["profile"],
      history: "one row (CIK, ISIN, listing date, description)",
      loader: "CanonicalStockDataService hydration, once per security",
    },
    {
      dataset: "Daily prices",
      endpoints: ["historical-price-eod/full"],
      history:
        `${priceYears} years: the ${productHistoryYears}-year product horizon plus the ` +
        "derived-series warm-up, clamped to the listing date",
      loader: "CanonicalStockDataService.getDailyDerivedState",
    },
    {
      dataset: "Financial statements",
      endpoints: [
        "income-statement",
        "balance-sheet-statement",
        "cash-flow-statement",
      ],
      history:
        `${statementYears} years, quarterly and annual: the product horizon plus the ` +
        "valuation warm-up",
      loader: "CanonicalStockDataService.getDailyDerivedState",
    },
    {
      dataset:
        "Daily derived state (technicals, weekly state, intrinsic values, Fundamental Metrics)",
      endpoints: [],
      history: "every trading day of the product horizon, calculated locally",
      loader: "CanonicalStockDataService.getDailyDerivedState",
    },
    {
      dataset: "Split list",
      endpoints: ["splits"],
      history: "the provider's whole list for the security",
      loader: "CanonicalStockDataService.getDailyValuationRatio",
    },
    {
      dataset: "Valuation ratios (P/E, P/S, P/B, P/FCF, EV/EBITDA)",
      endpoints: [],
      history: "computed on read from stored closes, statements and splits",
      loader: "CanonicalStockDataService.getDailyValuationRatio",
    },
    {
      dataset: "Insider transactions (Form 4)",
      endpoints: ["insider-trading/search"],
      history: "paged back from the newest filing, to the loader's page bound",
      loader: "CanonicalAlternativeDataService.ensureIngested",
    },
    {
      dataset: "Congressional trades (Senate and House)",
      endpoints: ["senate-trades", "house-trades"],
      history:
        "paged back from the newest disclosure, to the loader's page bound",
      loader: "CanonicalAlternativeDataService.ensureIngested",
    },
  ];
}

export type LiveFmpExclusionClass =
  /** Not a historical per-security dataset at all. */
  | "NOT_APPLICABLE"
  /** One request answers for a whole exchange or the whole market. */
  | "PROVIDER_WIDE"
  /** It would ask the provider about symbols outside the approved set. */
  | "WIDENS_UNIVERSE";

export type LiveFmpExclusion = {
  readonly operation: string;
  readonly classification: LiveFmpExclusionClass;
  readonly endpoints: readonly string[];
  readonly reason: string;
};

/** Everything else the product can ask the provider for, and why this mode never does. */
export const LIVE_FMP_EXCLUSIONS: readonly LiveFmpExclusion[] = [
  {
    operation: "Security catalog synchronization (POST /admin/securities/sync)",
    classification: "PROVIDER_WIDE",
    endpoints: ["company-screener"],
    reason:
      "returns every listing on an exchange; the scope refuses the endpoint, and a symbol the " +
      "catalog lacks is admitted from its own profile instead",
  },
  {
    operation: "Current quotes (the Monitor cycle's current observation)",
    classification: "WIDENS_UNIVERSE",
    endpoints: ["batch-quote"],
    reason:
      "takes whatever symbol list its caller built, and is current data rather than history; " +
      "the scope refuses the endpoint",
  },
  {
    operation: "Exchange trading calendar",
    classification: "PROVIDER_WIDE",
    endpoints: ["holidays-by-exchange"],
    reason:
      "a venue's schedule, held in memory by the Monitor worker and never stored; the scope " +
      "refuses the endpoint",
  },
  {
    operation:
      "Benchmark series (SP500/SPY, ^GSPC, ^DJI, ^VIX): prewarm, market overview, backtests",
    classification: "WIDENS_UNIVERSE",
    endpoints: ["historical-price-eod/full"],
    reason:
      "each benchmark is another provider symbol, not one of the approved securities; the scope " +
      "refuses the symbol",
  },
  {
    operation:
      "Monitor scans, including the built-in Monitors' thirty securities",
    classification: "WIDENS_UNIVERSE",
    endpoints: [
      "batch-quote",
      "holidays-by-exchange",
      "historical-price-eod/full",
    ],
    reason:
      "hydrates every member of every active Monitor's list; this command starts no worker, and " +
      "a worker holds no provider key",
  },
  {
    operation: "Backtests and the QA matrix sweep",
    classification: "WIDENS_UNIVERSE",
    endpoints: ["historical-price-eod/full"],
    reason:
      "hydrates a whole Stock List (up to 200 securities) plus a benchmark; this command starts " +
      "no worker",
  },
  {
    operation: "Institutional holdings (Form 13F)",
    classification: "NOT_APPLICABLE",
    endpoints: [],
    reason: "not part of the product (AGENTS.md invariant 23)",
  },
  {
    operation: "Company logos",
    classification: "NOT_APPLICABLE",
    endpoints: [],
    reason:
      "served by the web app from the provider's unmetered image host; no key, no dataset",
  },
];

/** Weekdays in a year: no exchange holds more sessions than this. */
const MAX_SESSIONS_PER_YEAR = 262;

export type LiveFmpRequestCeiling = {
  /** The most requests one cold security can cost, by cause, with no retry. */
  readonly perSecurity: {
    readonly identity: number;
    readonly profile: number;
    readonly prices: number;
    readonly statements: number;
    readonly splits: number;
    readonly insider: number;
    readonly congress: number;
  };
  readonly perSecurityTotal: number;
  /** `perSecurityTotal` for every security, with no retry. */
  readonly total: number;
  /** The same run with every request retried to the client's limit. */
  readonly totalWithEveryRetry: number;
};

/**
 * The most provider requests a cold full-history run can send, from the loaders' own bounds.
 *
 * An upper bound, not an estimate. The price walk is bounded by the retained years and the
 * provider's page cap (a full page is followed by one more request); the statements are one
 * request per type and cadence; and an alternative-data ingest stops at `maxPagesPerIngest` pages
 * per endpoint however much history the provider has. A real cold run sits well below it — about
 * ten requests for the identity, profile, prices, statements and split list, plus however many
 * insider and congressional pages the security actually has.
 */
export function liveFmpRequestCeiling(input: {
  readonly securities: number;
  readonly productHistoryYears: number;
  readonly alternativeDataMaxPages: number;
  readonly maxRetries: number;
}): LiveFmpRequestCeiling {
  const maxSessions =
    priceRetentionYears(input.productHistoryYears) * MAX_SESSIONS_PER_YEAR;
  const perSecurity = {
    identity: 1,
    profile: 1,
    prices: Math.floor(maxSessions / FMP_EOD_MAX_ROWS_PER_RESPONSE) + 1,
    statements: fundamentalsDatasetOperations(input.productHistoryYears).length,
    splits: 1,
    insider: input.alternativeDataMaxPages,
    // One endpoint per chamber.
    congress: input.alternativeDataMaxPages * CONGRESS_CHAMBERS.length,
  };
  const perSecurityTotal = Object.values(perSecurity).reduce(
    (sum, count) => sum + count,
    0,
  );
  const total = perSecurityTotal * input.securities;
  return {
    perSecurity,
    perSecurityTotal,
    total,
    totalWithEveryRetry: total * (1 + input.maxRetries),
  };
}
