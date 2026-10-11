import {
  BENCHMARK_CATALOG,
  DEFAULT_BENCHMARK_CODE,
  type BenchmarkCatalogEntry,
} from "./benchmarks.js";
import type { LocalDate } from "./stock-data.js";

/**
 * The approved ETF universe of the market overview, grouped as the Dashboard will show it.
 *
 * `docs/decisions/etf-market-data-v1.md` is the decision. Exactly twenty ETFs in three groups, in
 * display order. This is the **one** list: a later Dashboard reads it rather than keeping a second
 * array of tickers, and the refresh job and the bootstrap tool read it to know which series to
 * maintain. `GET /market-overview` reads it to answer in this order, with these words; the provider
 * symbol behind each benchmark code never crosses that contract.
 *
 * Each entry names the benchmark **code** its history is stored under. `SPY` names `SP500`: the
 * backtest benchmark and execution calendar are the same SPY series, so the overview reuses it
 * rather than storing and fetching SPY twice. Every other entry has a catalog row of its own, active
 * and never backtest-selectable.
 *
 * `listedIn` is the month the fund began trading, from the issuers' own fund documentation. It is
 * not a claim about how much history the provider has: the bootstrap reads whatever the provider
 * returns from {@link MARKET_OVERVIEW_HISTORY_FLOOR} and only uses `listedIn` to flag a history
 * that begins suspiciously later than the fund itself.
 */

export const MARKET_OVERVIEW_GROUP_IDS = [
  "BENCHMARKS",
  "US_SECTORS",
  "MACRO_ALTERNATIVES",
] as const;

export type MarketOverviewGroupId = (typeof MARKET_OVERVIEW_GROUP_IDS)[number];

export type MarketOverviewEtf = {
  /** The exchange ticker the product displays. */
  readonly ticker: string;
  /** What the overview calls it. */
  readonly label: string;
  /** The benchmark code the history is stored under. */
  readonly benchmarkCode: string;
  /** `YYYY-MM`: the month the fund began trading. */
  readonly listedIn: string;
  /** A qualification the overview must show beside the instrument, when it has one. */
  readonly note?: string;
};

export type MarketOverviewGroup = {
  readonly id: MarketOverviewGroupId;
  readonly label: string;
  /** The compact name a category selector uses where the full label does not fit. */
  readonly shortLabel: string;
  readonly etfs: readonly MarketOverviewEtf[];
};

export const MARKET_OVERVIEW_ETF_GROUPS = [
  {
    id: "BENCHMARKS",
    label: "Benchmarks",
    shortLabel: "Benchmarks",
    etfs: [
      {
        ticker: "SPY",
        label: "S&P 500 ETF",
        benchmarkCode: DEFAULT_BENCHMARK_CODE,
        listedIn: "1993-01",
      },
      {
        ticker: "QQQ",
        label: "Nasdaq-100 ETF",
        benchmarkCode: "ETF_QQQ",
        listedIn: "1999-03",
      },
      {
        ticker: "DIA",
        label: "Dow Jones Industrial Average ETF",
        benchmarkCode: "ETF_DIA",
        listedIn: "1998-01",
      },
      {
        ticker: "IWM",
        label: "Russell 2000 ETF",
        benchmarkCode: "ETF_IWM",
        listedIn: "2000-05",
      },
      {
        ticker: "RSP",
        label: "S&P 500 Equal Weight ETF",
        benchmarkCode: "ETF_RSP",
        listedIn: "2003-04",
      },
    ],
  },
  {
    id: "US_SECTORS",
    label: "Sector Performance",
    shortLabel: "Sectors",
    etfs: [
      {
        ticker: "XLK",
        label: "Technology",
        benchmarkCode: "ETF_XLK",
        listedIn: "1998-12",
      },
      {
        ticker: "XLF",
        label: "Financials",
        benchmarkCode: "ETF_XLF",
        listedIn: "1998-12",
      },
      {
        ticker: "XLE",
        label: "Energy",
        benchmarkCode: "ETF_XLE",
        listedIn: "1998-12",
      },
      {
        ticker: "XLV",
        label: "Healthcare",
        benchmarkCode: "ETF_XLV",
        listedIn: "1998-12",
      },
      {
        ticker: "XLI",
        label: "Industrials",
        benchmarkCode: "ETF_XLI",
        listedIn: "1998-12",
      },
      {
        ticker: "XLY",
        label: "Consumer Discretionary",
        benchmarkCode: "ETF_XLY",
        listedIn: "1998-12",
      },
      {
        ticker: "XLP",
        label: "Consumer Staples",
        benchmarkCode: "ETF_XLP",
        listedIn: "1998-12",
      },
      {
        ticker: "XLU",
        label: "Utilities",
        benchmarkCode: "ETF_XLU",
        listedIn: "1998-12",
      },
      {
        ticker: "XLB",
        label: "Materials",
        benchmarkCode: "ETF_XLB",
        listedIn: "1998-12",
      },
      {
        ticker: "XLRE",
        label: "Real Estate",
        benchmarkCode: "ETF_XLRE",
        listedIn: "2015-10",
      },
      {
        ticker: "XLC",
        label: "Communication Services",
        benchmarkCode: "ETF_XLC",
        listedIn: "2018-06",
      },
    ],
  },
  {
    id: "MACRO_ALTERNATIVES",
    label: "Macro & Alternatives",
    shortLabel: "Macro",
    etfs: [
      {
        ticker: "GLD",
        label: "Gold",
        benchmarkCode: "ETF_GLD",
        listedIn: "2004-11",
      },
      {
        ticker: "USO",
        label: "Oil futures",
        benchmarkCode: "ETF_USO",
        listedIn: "2006-04",
        note: "Tracks near-month WTI crude oil futures, not the spot price of oil.",
      },
      {
        ticker: "TLT",
        label: "Long-term US Treasury bonds",
        benchmarkCode: "ETF_TLT",
        listedIn: "2002-07",
      },
      {
        ticker: "HYG",
        label: "High-yield corporate bonds",
        benchmarkCode: "ETF_HYG",
        listedIn: "2007-04",
      },
    ],
  },
] as const satisfies readonly MarketOverviewGroup[];

/**
 * The earliest date the bootstrap asks the provider for.
 *
 * Every approved fund began trading after it (`SPY`, the oldest, in January 1993), so asking from
 * here reaches each fund's first session and records the months before it as covered and empty —
 * which is what stops the loader asking for them again. It is a floor below the universe, not an
 * inception date: the first stored bar is whatever the provider returns.
 */
export const MARKET_OVERVIEW_HISTORY_FLOOR: LocalDate = "1993-01-01";

/** Every approved ETF, in display order across the three groups. */
export function marketOverviewEtfs(): readonly MarketOverviewEtf[] {
  return MARKET_OVERVIEW_ETF_GROUPS.flatMap(
    (group): readonly MarketOverviewEtf[] => group.etfs,
  );
}

/** The benchmark codes the overview's history is stored under, in display order. */
export function marketOverviewBenchmarkCodes(): readonly string[] {
  return marketOverviewEtfs().map((etf) => etf.benchmarkCode);
}

/** The catalog entry behind each approved ETF, in display order. Throws if one is missing. */
export function marketOverviewCatalogEntries(): readonly BenchmarkCatalogEntry[] {
  return marketOverviewEtfs().map((etf) => {
    const entry = BENCHMARK_CATALOG.find(
      (candidate) => candidate.code === etf.benchmarkCode,
    );
    if (!entry) {
      throw new Error(
        `Market-overview ETF ${etf.ticker} names benchmark '${etf.benchmarkCode}', which is not in BENCHMARK_CATALOG`,
      );
    }
    return entry;
  });
}
