import type { LocalDate } from "./stock-data.js";

/**
 * Benchmarks are a first-class product concept, deliberately separate from `Security`.
 *
 * A benchmark is passive comparison data: it is never bought, never consumes portfolio cash, never
 * occupies a position slot, and carries no **stored** derived series — no moving averages, no
 * oscillators, no intrinsic values are persisted or cached for it. Modelling it as
 * `Security.isBenchmark = true` would drag every one of those behaviours along with it, so it has
 * its own identity and its own market-data tables.
 *
 * A Strategy Condition that names an ETF as its data source reads technicals of that ETF. They are
 * computed at evaluation time from the stored OHLCV, through the stock calculation methodology,
 * and never stored (`ai/architecture/strategy-etf-conditions.md`).
 *
 * What is *shared* is the loading machinery: coverage reconciliation, the hydration lock, provider
 * retries and cooldown, durable PostgreSQL persistence and the yearly Redis projection all follow
 * the same principles as stock loading, because duplicating them would be the real mistake.
 */

/** How a benchmark's series is sourced. V1 ships one kind; the union is the extension point. */
export const BENCHMARK_SOURCE_KINDS = ["FMP_SYMBOL"] as const;

export type BenchmarkSourceKind = (typeof BENCHMARK_SOURCE_KINDS)[number];

/**
 * What the financial object behind a series actually **is**.
 *
 * Deliberately not folded into `sourceKind`, which says how the numbers are *obtained*: `SPY` and
 * `^GSPC` are both fetched as FMP symbols, and they are not the same kind of thing.
 *
 * - `ETF_PROXY` — a tradable fund that tracks an index. Its price is a share price, it carries the
 *   fund's expense ratio and distribution behaviour, and a funded comparison portfolio can
 *   conceptually buy it. That is why the backtest benchmark is one.
 * - `INDEX` — the index itself. Nothing buys it, it has no expense ratio, and for `^VIX` the number
 *   is not even a price. It is a market reference, which is what the Dashboard reports.
 *
 * It belongs to the **series**, not to the product row, because moving `SP500` from `SPY` to
 * `^GSPC` would change what every stored bar means. Reconciliation therefore treats it as part of
 * the immutable definition: changing it appends a version rather than reinterpreting history.
 */
export const BENCHMARK_SERIES_TYPES = ["ETF_PROXY", "INDEX"] as const;

export type BenchmarkSeriesType = (typeof BENCHMARK_SERIES_TYPES)[number];

export type BenchmarkId = string;
export type BenchmarkSeriesId = string;

/**
 * The product identity a user selects: a stable code and the words shown beside it.
 *
 * Everything that decides what the numbers *are* — the source, the provider identifier, the
 * currency, the methodology — lives on `BenchmarkSeries` instead, because those are not editable
 * facts about a benchmark: changing any of them produces a different series, not a corrected one.
 */
export type Benchmark = {
  id: BenchmarkId;
  code: string;
  name: string;
  description?: string;
  /**
   * Whether the system maintains this benchmark at all. A benchmark the product has retired stops
   * being loaded and stops being resolvable; it is not how a series is kept out of a picker.
   */
  isActive: boolean;
  /**
   * Whether a **user** may choose this benchmark for a backtest.
   *
   * Separate from `isActive` on purpose. The market-reference series behind the Dashboard cards are
   * fully active system series — they hydrate, they are stored, internal services resolve them —
   * and they are still not something a customer compares a portfolio against: nothing can buy
   * `^GSPC`, and `^VIX` is not a price at all. Expressing that as `isActive = false` would have
   * meant switching off the loading the Dashboard depends on in order to tidy a dropdown.
   */
  isBacktestSelectable: boolean;
  displayOrder: number;
};

/**
 * One **immutable** definition of what a benchmark's series is, and the identity its market data
 * is stored under.
 *
 * A benchmark's meaning can change: `SP500` is sourced from the `SPY` ETF today and could be
 * sourced from a direct index feed tomorrow, which would change every number it produces. That is
 * not an edit. Reconciliation therefore never rewrites a series row — a changed definition appends
 * a new version, historical bars stay attached to the version they were fetched for, and a
 * backtest pins the exact `BenchmarkSeriesId` it executed against at submission.
 *
 * The consequence is the invariant that matters: a queued or completed run can never be
 * reinterpreted by a later catalog change, because the data it reads is keyed by a version that no
 * longer moves.
 */
export type BenchmarkSeries = {
  id: BenchmarkSeriesId;
  benchmarkId: BenchmarkId;
  /** 1-based, ascending. The highest version of a benchmark is its current definition. */
  version: number;
  sourceKind: BenchmarkSourceKind;
  /** What the object behind the series is. Part of the immutable definition — see {@link BENCHMARK_SERIES_TYPES}. */
  seriesType: BenchmarkSeriesType;
  /** Provider identifier for `FMP_SYMBOL`. Server-side only; never part of a browser contract. */
  providerSymbol: string;
  currency: string;
  methodologyVersion: number;
};

/** A benchmark together with the definition currently in force for it. */
export type BenchmarkWithSeries = Benchmark & { series: BenchmarkSeries };

/** One daily bar of a benchmark series. Stored apart from `DailyPrice` by design. */
export type BenchmarkDailyPrice = {
  seriesId: BenchmarkSeriesId;
  date: LocalDate;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * The datasets a benchmark materializes. A benchmark has no fundamentals and no stored derived
 * state: what a Strategy Condition reads of an ETF is computed from this one dataset each time.
 */
export const BENCHMARK_DATASETS = ["DAILY_PRICE"] as const;

export type BenchmarkDataset = (typeof BENCHMARK_DATASETS)[number];

/**
 * The canonical registration of every benchmark the product ships.
 *
 * This is the single source of benchmark metadata: the API reconciles it into PostgreSQL at
 * startup, so a normal local, development, CI or test database has the catalog after `migrate`
 * without manual SQL. No frontend array and no second backend list repeats it.
 *
 * `methodologyVersion` describes what the *series* means. V1's `SP500` is currently backed by the
 * `SPY` ETF, which tracks the index including its own expense ratio and distribution behaviour.
 * Replacing that with a direct index feed would change the numbers, so it would raise this version
 * — and because every run snapshots the value it executed under, an old run stays interpretable.
 */
export type BenchmarkCatalogEntry = Omit<Benchmark, "id"> &
  Omit<BenchmarkSeries, "id" | "benchmarkId" | "version">;

export const BENCHMARK_CATALOG: readonly BenchmarkCatalogEntry[] = [
  {
    code: "SP500",
    name: "S&P 500",
    description:
      "Large-cap US equity benchmark. Currently sourced from the SPY ETF, which tracks the S&P 500.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "SPY",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: true,
    displayOrder: 0,
  },
  // ── Market references ──────────────────────────────────────────────────────────────────────
  //
  // The real indices, for reporting what the market did. They are ordinary benchmarks in every
  // structural sense — same tables, same coverage, same hydration lock, same Redis namespace — and
  // they are deliberately **not** selectable for a backtest: a funded comparison portfolio has to
  // be able to buy what it is compared against, and `^VIX` is not even a price.
  //
  // `SP500` above stays `SPY` for exactly that reason. `SP500_INDEX` is a different series, not a
  // correction of it, and the two never share a row, a bar or a cache key.
  {
    code: "SP500_INDEX",
    name: "S&P 500 Index",
    description:
      "The S&P 500 index itself, as a market reference. Not investable, and not the backtest benchmark — that is SP500, sourced from the SPY ETF.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "INDEX",
    providerSymbol: "^GSPC",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 100,
  },
  {
    code: "DJIA_INDEX",
    name: "Dow Jones Industrial Average",
    description:
      "The Dow Jones Industrial Average, as a market reference. Price-weighted and not investable.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "INDEX",
    providerSymbol: "^DJI",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 101,
  },
  {
    code: "VIX_INDEX",
    name: "CBOE Volatility Index",
    description:
      "Expected 30-day volatility of the S&P 500, implied by option prices. A level, not a price: nothing holds it, and it is never a backtest benchmark.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "INDEX",
    providerSymbol: "^VIX",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 102,
  },
  // ── Market-overview ETFs ───────────────────────────────────────────────────────────────────
  //
  // The ETF universe behind the Dashboard's market overview (`docs/decisions/etf-market-data-v1.md`).
  // Ordinary benchmark series in every structural sense — same tables, coverage, hydration lock,
  // provider gate and Redis namespace — and, like the market references above, active system series
  // a user may never select: they are not comparison benchmarks, and adding them changes neither
  // `GET /benchmarks` nor any run snapshot. `SPY` is deliberately absent here: the overview reads it
  // through `SP500`, the one SPY-backed series, so SPY is fetched and stored exactly once.
  //
  // Every one of them is an ETF share price on the provider's split-adjusted basis, never an index
  // level: `ETF_DIA` is not `DJIA_INDEX`, and `ETF_USO` is an oil-futures fund, not the price of oil.
  {
    code: "ETF_QQQ",
    name: "Nasdaq-100 ETF",
    description:
      "Invesco QQQ Trust, an ETF tracking the Nasdaq-100 index. An internal market-overview series, not a backtest benchmark.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "QQQ",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 200,
  },
  {
    code: "ETF_DIA",
    name: "Dow Jones Industrial Average ETF",
    description:
      "SPDR Dow Jones Industrial Average ETF Trust. An ETF share price, not the price-weighted index level reported by DJIA_INDEX.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "DIA",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 201,
  },
  {
    code: "ETF_IWM",
    name: "Russell 2000 ETF",
    description: "iShares Russell 2000 ETF, tracking US small-cap equities.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "IWM",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 202,
  },
  {
    code: "ETF_RSP",
    name: "S&P 500 Equal Weight ETF",
    description:
      "Invesco S&P 500 Equal Weight ETF: the S&P 500 constituents, equally weighted.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "RSP",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 203,
  },
  {
    code: "ETF_XLK",
    name: "Technology Select Sector ETF",
    description: "Technology Select Sector SPDR Fund.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "XLK",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 204,
  },
  {
    code: "ETF_XLF",
    name: "Financial Select Sector ETF",
    description: "Financial Select Sector SPDR Fund.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "XLF",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 205,
  },
  {
    code: "ETF_XLE",
    name: "Energy Select Sector ETF",
    description: "Energy Select Sector SPDR Fund.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "XLE",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 206,
  },
  {
    code: "ETF_XLV",
    name: "Health Care Select Sector ETF",
    description: "Health Care Select Sector SPDR Fund.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "XLV",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 207,
  },
  {
    code: "ETF_XLI",
    name: "Industrial Select Sector ETF",
    description: "Industrial Select Sector SPDR Fund.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "XLI",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 208,
  },
  {
    code: "ETF_XLY",
    name: "Consumer Discretionary Select Sector ETF",
    description: "Consumer Discretionary Select Sector SPDR Fund.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "XLY",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 209,
  },
  {
    code: "ETF_XLP",
    name: "Consumer Staples Select Sector ETF",
    description: "Consumer Staples Select Sector SPDR Fund.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "XLP",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 210,
  },
  {
    code: "ETF_XLU",
    name: "Utilities Select Sector ETF",
    description: "Utilities Select Sector SPDR Fund.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "XLU",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 211,
  },
  {
    code: "ETF_XLB",
    name: "Materials Select Sector ETF",
    description: "Materials Select Sector SPDR Fund.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "XLB",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 212,
  },
  {
    code: "ETF_XLRE",
    name: "Real Estate Select Sector ETF",
    description: "Real Estate Select Sector SPDR Fund.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "XLRE",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 213,
  },
  {
    code: "ETF_XLC",
    name: "Communication Services Select Sector ETF",
    description: "Communication Services Select Sector SPDR Fund.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "XLC",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 214,
  },
  {
    code: "ETF_GLD",
    name: "Gold ETF",
    description: "SPDR Gold Shares, a fund holding physical gold bullion.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "GLD",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 215,
  },
  {
    code: "ETF_USO",
    name: "United States Oil Fund (oil futures)",
    description:
      "Holds near-month WTI crude oil futures contracts. Its price follows those futures, including their roll costs; it is not the spot price of oil.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "USO",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 216,
  },
  {
    code: "ETF_TLT",
    name: "20+ Year Treasury Bond ETF",
    description:
      "iShares 20+ Year Treasury Bond ETF: long-term US Treasury bonds.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "TLT",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 217,
  },
  {
    code: "ETF_HYG",
    name: "High Yield Corporate Bond ETF",
    description: "iShares iBoxx $ High Yield Corporate Bond ETF.",
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: "HYG",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    isBacktestSelectable: false,
    displayOrder: 218,
  },
];

/** The benchmark a submission selects when it names none. */
export const DEFAULT_BENCHMARK_CODE = "SP500";

/**
 * The market references the product reports, in the order it reports them, with the words it uses.
 *
 * One list, here, for the same reason `BENCHMARK_CATALOG` is one list: the browser must not hold a
 * second array that decides which indices exist or what they are called. The card label is shorter
 * than the catalog name deliberately — `S&P 500 Index` is what the series *is*, `S&P 500` is what a
 * reader calls it — and both stay in the domain rather than being retyped in a component.
 */
export const MARKET_REFERENCE_SERIES = [
  { code: "SP500_INDEX", label: "S&P 500" },
  { code: "DJIA_INDEX", label: "DJIA" },
  { code: "VIX_INDEX", label: "VIX" },
] as const satisfies readonly { code: string; label: string }[];

export type MarketReferenceCode =
  (typeof MARKET_REFERENCE_SERIES)[number]["code"];

/**
 * The series whose trading days are the engine's execution calendar.
 *
 * A **system input, not a user choice.** The dates a run simulates decide when a contribution
 * lands and what the return index is based at, so letting the selected comparison benchmark supply
 * them would make two otherwise identical runs disagree on their own portfolio. The engine names
 * one reference instead, and every run pins the exact series version of it at submission.
 *
 * It is the same code the product also offers as a comparison today, which costs nothing: one
 * hydration serves both roles. The separation is in the code and in the snapshot, not in the bytes.
 */
export const EXECUTION_CALENDAR_REFERENCE_CODE = "SP500";

export function findBenchmarkCatalogEntry(
  code: string,
): BenchmarkCatalogEntry | undefined {
  return BENCHMARK_CATALOG.find((entry) => entry.code === code);
}

/** The entries a user may choose between when submitting a backtest. */
export function backtestSelectableBenchmarks(): readonly BenchmarkCatalogEntry[] {
  return BENCHMARK_CATALOG.filter(
    (entry) => entry.isActive && entry.isBacktestSelectable,
  );
}
