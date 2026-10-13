/**
 * The ETF sources a Strategy Condition may read instead of the evaluated stock.
 *
 * `docs/decisions/strategy-etf-conditions-v1.md` is the product decision: exactly the twenty
 * Dashboard ETFs of `MARKET_OVERVIEW_ETF_GROUPS` (`@intrinsic/domain`), in the same three groups,
 * with the same tickers, market labels and stable benchmark codes. This file is the contracts
 * **projection** of that catalog — stated here because `@intrinsic/contracts` is the only package
 * the web app may depend on and the one registry the pure validator reads, exactly the reason
 * `RELATIVE_VOLUME_PERIODS` is restated here — and
 * `apps/api/src/strategies/strategy-etf-sources.test.ts` is the drift guard that holds the two
 * lists identical. Neither list is ever edited without the other.
 *
 * The stored identity is the **benchmark code** (`SP500`, `ETF_XLK`), never the ticker: `SPY`'s
 * history lives under the existing `SP500` series — the actual SPY ETF's own OHLCV, which is also
 * the backtest benchmark and execution calendar — and the ticker is what the product displays.
 * A condition document therefore survives any future display renaming, and the provider symbol
 * never appears anywhere near a Strategy.
 */

export const STRATEGY_ETF_GROUP_IDS = [
  "BENCHMARKS",
  "US_SECTORS",
  "MACRO_ALTERNATIVES",
] as const;

export type StrategyEtfGroupId = (typeof STRATEGY_ETF_GROUP_IDS)[number];

export type StrategyEtfSource = {
  /** The benchmark code the ETF's history is stored under: the stored, stable identity. */
  readonly code: string;
  /** The exchange ticker the product displays: `XLK · RSI 14D`. */
  readonly ticker: string;
  /** The market the fund tracks — `Technology`, `Gold` — never the fund's own name. */
  readonly label: string;
  readonly group: StrategyEtfGroupId;
};

export type StrategyEtfSourceGroup = {
  readonly id: StrategyEtfGroupId;
  readonly label: string;
  /** The compact name where the full label does not fit. */
  readonly shortLabel: string;
  readonly etfs: readonly StrategyEtfSource[];
};

/** The twenty sources in their three display groups, in catalog order. */
export const STRATEGY_ETF_SOURCE_GROUPS = [
  {
    id: "BENCHMARKS",
    label: "Benchmarks",
    shortLabel: "Benchmarks",
    etfs: [
      { code: "SP500", ticker: "SPY", label: "S&P 500", group: "BENCHMARKS" },
      {
        code: "ETF_QQQ",
        ticker: "QQQ",
        label: "Nasdaq-100",
        group: "BENCHMARKS",
      },
      {
        code: "ETF_DIA",
        ticker: "DIA",
        label: "Dow Jones",
        group: "BENCHMARKS",
      },
      {
        code: "ETF_IWM",
        ticker: "IWM",
        label: "Russell 2000",
        group: "BENCHMARKS",
      },
      {
        code: "ETF_RSP",
        ticker: "RSP",
        label: "S&P 500 Equal Weight",
        group: "BENCHMARKS",
      },
    ],
  },
  {
    id: "US_SECTORS",
    label: "Sector Performance",
    shortLabel: "Sectors",
    etfs: [
      {
        code: "ETF_XLK",
        ticker: "XLK",
        label: "Technology",
        group: "US_SECTORS",
      },
      {
        code: "ETF_XLF",
        ticker: "XLF",
        label: "Financials",
        group: "US_SECTORS",
      },
      { code: "ETF_XLE", ticker: "XLE", label: "Energy", group: "US_SECTORS" },
      {
        code: "ETF_XLV",
        ticker: "XLV",
        label: "Healthcare",
        group: "US_SECTORS",
      },
      {
        code: "ETF_XLI",
        ticker: "XLI",
        label: "Industrials",
        group: "US_SECTORS",
      },
      {
        code: "ETF_XLY",
        ticker: "XLY",
        label: "Consumer Discretionary",
        group: "US_SECTORS",
      },
      {
        code: "ETF_XLP",
        ticker: "XLP",
        label: "Consumer Staples",
        group: "US_SECTORS",
      },
      {
        code: "ETF_XLU",
        ticker: "XLU",
        label: "Utilities",
        group: "US_SECTORS",
      },
      {
        code: "ETF_XLB",
        ticker: "XLB",
        label: "Materials",
        group: "US_SECTORS",
      },
      {
        code: "ETF_XLRE",
        ticker: "XLRE",
        label: "Real Estate",
        group: "US_SECTORS",
      },
      {
        code: "ETF_XLC",
        ticker: "XLC",
        label: "Communication Services",
        group: "US_SECTORS",
      },
    ],
  },
  {
    id: "MACRO_ALTERNATIVES",
    label: "Macro & Alternatives",
    shortLabel: "Macro",
    etfs: [
      {
        code: "ETF_GLD",
        ticker: "GLD",
        label: "Gold",
        group: "MACRO_ALTERNATIVES",
      },
      {
        code: "ETF_USO",
        ticker: "USO",
        label: "Oil Futures",
        group: "MACRO_ALTERNATIVES",
      },
      {
        code: "ETF_TLT",
        ticker: "TLT",
        label: "Long-Term Treasuries",
        group: "MACRO_ALTERNATIVES",
      },
      {
        code: "ETF_HYG",
        ticker: "HYG",
        label: "High-Yield Bonds",
        group: "MACRO_ALTERNATIVES",
      },
    ],
  },
] as const satisfies readonly StrategyEtfSourceGroup[];

/** The twenty sources flat, in catalog order across the three groups. */
export const STRATEGY_ETF_SOURCES = STRATEGY_ETF_SOURCE_GROUPS.flatMap(
  (group) => group.etfs as readonly (typeof STRATEGY_ETF_SOURCE_GROUPS)[number]["etfs"][number][],
);

/** The stored identities, in catalog order. The closed set a document may name. */
export type StrategyEtfSourceCode =
  (typeof STRATEGY_ETF_SOURCE_GROUPS)[number]["etfs"][number]["code"];

const SOURCES_BY_CODE: ReadonlyMap<string, StrategyEtfSource> = new Map(
  STRATEGY_ETF_SOURCES.map((etf) => [etf.code, etf]),
);

export function isStrategyEtfSourceCode(
  value: unknown,
): value is StrategyEtfSourceCode {
  return typeof value === "string" && SOURCES_BY_CODE.has(value);
}

/** The one lookup and validation entry point; `undefined` for a code the catalog does not define. */
export function findStrategyEtfSource(
  code: string,
): StrategyEtfSource | undefined {
  return SOURCES_BY_CODE.get(code);
}

/**
 * The display name of one source — its ticker — falling back to the raw code for a drifted
 * document, exactly as `seriesLabel` falls back to a raw series id: rendering never throws on a
 * document the validator is what rejects.
 */
export function strategyEtfSourceTicker(code: string): string {
  return SOURCES_BY_CODE.get(code)?.ticker ?? code;
}
