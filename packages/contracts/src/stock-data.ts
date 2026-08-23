/**
 * Inclusive historical date-range query in `YYYY-MM-DD` form.
 *
 * API parsing/validation must reject malformed or inverted ranges. These strings intentionally
 * remain transport types; convert them to domain `LocalDate` values at the API boundary.
 */
export type StockDateRangeQuery = {
  from?: string;
  to?: string;
};

/** Public Stock Details identity payload. Volatile quote/market fields do not belong here. */
export type SecurityResponse = {
  /** Internal product security ID. Clients must not assume ticker symbol is globally immutable. */
  id: string;
  symbol: string;
  name: string;
  exchangeCode: string;
  exchangeName?: string;
  currency: string;
  /** Preserve leading zeroes; CIK is serialized as a string. */
  cik?: string;
  isin?: string;
  cusip?: string;
  country?: string;
  sector?: string;
  industry?: string;
  /** `YYYY-MM-DD` when known. */
  ipoDate?: string;
  type: "STOCK" | "ETF" | "FUND";
  isAdr: boolean;
  isActivelyTrading: boolean;
};

/** Current descriptive profile snapshot. V1 does not claim these fields are historical PIT data. */
export type SecurityProfileResponse = {
  description?: string;
  website?: string;
  logoUrl?: string;
  ceo?: string;
  employees?: number;
};

/**
 * Canonical split-adjusted daily EOD bar returned by the product.
 *
 * Dividends are not baked into these prices. Bars should be serialized in ascending date order for
 * historical endpoints/Stock Details unless a future endpoint explicitly documents otherwise.
 */
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
 * Persisted V1 daily technical snapshot derived by our application from canonical daily closes.
 * Optional fields represent indicator warm-up/unavailability and must not be emitted as zero.
 */
export type DailyTechnicalResponse = {
  date: string;
  sma20?: number;
  sma50?: number;
  sma100?: number;
  sma200?: number;
  ema20?: number;
  ema50?: number;
  ema200?: number;
  /** Algorithm version used to materialize the returned technical values. */
  calculationVersion: number;
};

/** Stable wire-level V1 intrinsic-value model identifiers. */
export type IntrinsicValueModelResponse =
  | "DCF_FCFF"
  | "RESIDUAL_INCOME"
  | "DDM"
  | "GRAHAM";

/**
 * Point-in-time intrinsic-value snapshot.
 *
 * `sourceDataAsOf` is intentionally exposed for auditability: clients/backtests can know when the
 * newest source input used by the valuation was actually public.
 */
export type IntrinsicValueResponse = {
  /** Effective historical valuation date (`YYYY-MM-DD`). */
  valuationDate: string;
  /** ISO-8601 publication/availability instant of the newest source input used. */
  sourceDataAsOf: string;
  model: IntrinsicValueModelResponse;
  valuePerShare: number;
  currency: string;
  /** Version of the intrinsic-value formula/assumption methodology. */
  calculationVersion: number;
};

/** Stable wire-level V1 blend identifiers. */
export type IntrinsicValueBlendIdResponse =
  | "BALANCED"
  | "CONSERVATIVE"
  | "DIVIDEND";

/** Point-in-time materialized result of a versioned intrinsic-value blend definition. */
export type IntrinsicValueBlendResponse = {
  valuationDate: string;
  /** Latest source-data instant across component valuations actually used by this blend point. */
  sourceDataAsOf: string;
  blendId: IntrinsicValueBlendIdResponse;
  valuePerShare: number;
  currency: string;
  /** Version of the blend-calculation implementation. */
  calculationVersion: number;
  /** Version of the product blend weights/membership. */
  blendVersion: number;
};

/**
 * Composite payload for the future Stock Details endpoint.
 *
 * The endpoint should use a bounded historical range by default; this contract must not be read as
 * permission to return every stored historical row for every section on each page request.
 */
export type StockDetailsResponse = {
  security: SecurityResponse;
  profile?: SecurityProfileResponse;
  prices: DailyPriceResponse[];
  technicals: DailyTechnicalResponse[];
  intrinsicValues: IntrinsicValueResponse[];
  intrinsicValueBlends: IntrinsicValueBlendResponse[];
};

/**
 * Historical intrinsic-value endpoint query.
 *
 * `models` filters the requested model families. `asOf` means the response must contain only
 * snapshots eligible using information public at or before that date; for as-of retrieval use the
 * latest eligible snapshot per requested model. When combined with `from`/`to`, all constraints
 * apply.
 */
export type IntrinsicValueHistoryQuery = StockDateRangeQuery & {
  models?: IntrinsicValueModelResponse[];
  asOf?: string;
};

/** Same point-in-time semantics as `IntrinsicValueHistoryQuery`, for blend snapshots. */
export type IntrinsicValueBlendHistoryQuery = StockDateRangeQuery & {
  blendIds?: IntrinsicValueBlendIdResponse[];
  asOf?: string;
};
