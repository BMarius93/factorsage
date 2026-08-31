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
 * The `d` suffix is part of the public contract and explicitly identifies daily indicators. This
 * avoids ambiguity once weekly indicators exist. Missing warm-up values are omitted, never zeroed.
 *
 * No calculation version is exposed: exactly one current methodology is materialized per trading
 * day, and a methodology change rebuilds that state rather than publishing a parallel version.
 */
export type DailyTechnicalResponse = {
  date: string;
  sma20d?: number;
  sma50d?: number;
  sma100d?: number;
  sma200d?: number;
  ema20d?: number;
  ema50d?: number;
  ema200d?: number;
};

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

/** Composite payload for the future bounded Stock Details endpoint. */
export type StockDetailsResponse = {
  security: SecurityResponse;
  profile?: SecurityProfileResponse;
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
 * only identifies a security so the client can navigate to `/stocks/{symbol}`, and must not grow
 * into a second stock model.
 */
export type StockSearchResultResponse = Pick<
  SecurityResponse,
  "symbol" | "name" | "exchangeCode" | "exchangeName"
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
