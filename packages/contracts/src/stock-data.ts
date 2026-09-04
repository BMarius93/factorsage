/**
 * Inclusive historical date-range query in `YYYY-MM-DD` form.
 * API parsing/validation must reject malformed or inverted ranges.
 */
export type StockDateRangeQuery = {
  from?: string;
  to?: string;
};

export type SecurityResponse = {
  id: string;
  symbol: string;
  name: string;
  exchangeCode: string;
  exchangeName?: string;
  currency: string;
  cik?: string;
  isin?: string;
  cusip?: string;
  country?: string;
  sector?: string;
  industry?: string;
  ipoDate?: string;
  type: "STOCK" | "ETF" | "FUND";
  isAdr: boolean;
  isActivelyTrading: boolean;
};

export type SecurityProfileResponse = {
  description?: string;
  website?: string;
  logoUrl?: string;
  ceo?: string;
  employees?: number;
};

/** Canonical split-adjusted, non-dividend-adjusted daily EOD bar. */
export type DailyPriceResponse = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
};

/**
 * Daily technical projection over the unified daily derived state.
 *
 * The timeframe suffix is part of the public contract: `d` values are calculated over daily bars,
 * `w` values over completed weekly bars. `sma20d` and `sma20w` are different indicators and never
 * alias. Missing warm-up values are omitted, never zeroed.
 *
 * Every row is a trading day. A `w` value is the latest completed week's value carried forward, so
 * it repeats across the days of a week and changes only once a newer week completes. The
 * in-progress week is never exposed: a Monday-Thursday row can never carry a value that depends on
 * the upcoming Friday close.
 *
 * No calculation version is exposed: exactly one current methodology is materialized per trading
 * day, and a methodology change rebuilds that state rather than publishing a parallel version.
 */
export type MovingAverageValuesResponse = {
  sma20d?: number;
  sma50d?: number;
  sma100d?: number;
  sma200d?: number;
  ema20d?: number;
  ema50d?: number;
  ema200d?: number;
  sma20w?: number;
  sma50w?: number;
  sma100w?: number;
  sma200w?: number;
  ema20w?: number;
  ema50w?: number;
  ema200w?: number;
};

/**
 * Daily oscillator values riding on the same technical row.
 *
 * Wilder RSI over canonical completed daily closes, one field per period. Values are unitless and
 * lie in `[0, 100]`; warm-up rows omit the field entirely — RSI 14D needs fifteen closes before
 * its first value. An oscillator is not a moving average: it is a separate catalog family, drawn
 * in its own chart pane, and its fields are deliberately not part of
 * `MovingAverageFieldResponse`.
 */
export type OscillatorValuesResponse = {
  rsi7d?: number;
  rsi14d?: number;
  rsi21d?: number;
};

export type DailyTechnicalResponse = { date: string } & MovingAverageValuesResponse &
  OscillatorValuesResponse;

/**
 * Field on `DailyTechnicalResponse` that carries a moving average.
 *
 * Derived from the moving-average slice alone, not from the whole row: deriving it as
 * `Exclude<keyof DailyTechnicalResponse, "date">` would silently classify every future non-average
 * field (such as the RSI oscillators) as a moving average.
 */
export type MovingAverageFieldResponse = keyof MovingAverageValuesResponse;

/** Field on `DailyTechnicalResponse` that carries a daily oscillator. */
export type OscillatorFieldResponse = keyof OscillatorValuesResponse;

/** Any value field the daily technical endpoint serves. */
export type TechnicalSeriesFieldResponse =
  | MovingAverageFieldResponse
  | OscillatorFieldResponse;

export type IntrinsicValueModelResponse =
  | "DCF_FCFF"
  | "RESIDUAL_INCOME"
  | "DDM"
  | "GRAHAM";

/**
 * Daily intrinsic value effective on `valuationDate`.
 *
 * The series is materialized per trading day: once a value becomes point-in-time eligible it is
 * repeated on subsequent trading days until newly eligible inputs change it.
 */
export type IntrinsicValueResponse = {
  valuationDate: string;
  /** ISO-8601 instant when the newest source input used by the valuation was public. */
  sourceDataAsOf: string;
  model: IntrinsicValueModelResponse;
  valuePerShare: number;
  currency: string;
};

export type IntrinsicValueBlendIdResponse =
  | "BALANCED"
  | "CONSERVATIVE"
  | "DIVIDEND";

export type IntrinsicValueBlendResponse = {
  valuationDate: string;
  sourceDataAsOf: string;
  blendId: IntrinsicValueBlendIdResponse;
  valuePerShare: number;
  currency: string;
};

/**
 * Maximum historical horizon the Stock Details surface may explore, in years.
 *
 * This is the one definition of that product limit. The API derives every `history.start` it
 * reports from it and clamps every Stock Details range read to it, and the web app navigates
 * against the reported bound rather than a second copy of the number. It is a limit on *this*
 * surface only: a backtest names its own period through the loader and is unaffected.
 */
export const STOCK_DETAILS_MAX_HISTORY_YEARS = 30;

/**
 * How far back Stock Details may go for one security, and why it stops there.
 *
 * `start` is the earliest date this surface will request, and the only thing that ends a
 * client's exploration. It comes from exactly one of three explicit boundaries:
 *
 * - `HORIZON`: the 30-year product limit;
 * - `LISTING`: the security's listing date, when that is later than the horizon;
 * - `PROVIDER`: the earliest trading day the market-data provider has for this security, reported
 *   only once the loader has verified, with complete provider requests, that nothing older exists
 *   between the horizon-or-listing bound and that day.
 *
 * Until a `PROVIDER` boundary is proven the surface reports the wider bound, and a client keeps
 * asking, in bounded windows, until it reaches it. A window that comes back empty is never read
 * as the start of the security's history: that inference is what turned a truncated provider
 * response into a fake listing date.
 */
export type StockHistoryBoundsResponse = {
  start: string;
  end: string;
  startOrigin: StockHistoryStartOrigin;
};

/** Why `StockHistoryBoundsResponse.start` is where it is. */
export type StockHistoryStartOrigin = "HORIZON" | "LISTING" | "PROVIDER";

/** Composite payload for the bounded Stock Details endpoint. */
export type StockDetailsResponse = {
  security: SecurityResponse;
  profile?: SecurityProfileResponse;
  /** The window this surface is allowed to explore for this security. */
  history: StockHistoryBoundsResponse;
  prices: DailyPriceResponse[];
  technicals: DailyTechnicalResponse[];
  intrinsicValues: IntrinsicValueResponse[];
  intrinsicValueBlends: IntrinsicValueBlendResponse[];
};

/** `asOf` restricts results to information that was historically eligible by that date. */
export type IntrinsicValueHistoryQuery = StockDateRangeQuery & {
  models?: IntrinsicValueModelResponse[];
  asOf?: string;
};

export type IntrinsicValueBlendHistoryQuery = StockDateRangeQuery & {
  blendIds?: IntrinsicValueBlendIdResponse[];
  asOf?: string;
};

/**
 * One row of the global stock search dropdown.
 *
 * Deliberately a projection of `SecurityResponse` rather than a parallel DTO: the search surface
 * only identifies a security — `id` so features such as stock lists can reference the canonical
 * catalog row, `symbol` so the client can navigate to `/stocks/{symbol}` — and must not grow into
 * a second stock model.
 */
export type StockSearchResultResponse = Pick<
  SecurityResponse,
  "id" | "symbol" | "name" | "exchangeCode" | "exchangeName"
>;

/**
 * Outcome of one admin-triggered synchronization of the supported stock catalog.
 *
 * `deactivated` counts rows inside `updated` that stopped trading upstream; it is not a separate
 * bucket. `received + skipped` do not partition the rest either: `skipped` is the share of
 * `received` this product does not support, and the remainder resolves to
 * `created + updated + unchanged + failed`.
 */
export type SecurityCatalogSyncResponse = {
  received: number;
  created: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  skipped: number;
  failed: number;
  durationMs: number;
};
