import type {
  FinancialStatement,
  FinancialStatementQuery,
} from "./financial-statements.js";

/** Calendar date in canonical `YYYY-MM-DD` form. No timezone is attached. */
export type LocalDate = string;

/** Absolute timestamp, serialized as an ISO-8601 instant when persisted or sent over a boundary. */
export type Instant = string;

/** Internal immutable product identifier. Never use ticker symbol as the durable primary key. */
export type SecurityId = string;

/** Inclusive calendar-date range used by historical reads. */
export type DateRange = {
  from?: LocalDate;
  to?: LocalDate;
};

export const SECURITY_TYPES = ["STOCK", "ETF", "FUND"] as const;
export type SecurityType = (typeof SECURITY_TYPES)[number];

/** Stable identity/classification data for a listed security. */
export type Security = {
  id: SecurityId;
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
  ipoDate?: LocalDate;
  type: SecurityType;
  isAdr: boolean;
  isActivelyTrading: boolean;
};

/** Current descriptive profile snapshot; V1 does not treat these fields as PIT historical data. */
export type SecurityProfile = {
  securityId: SecurityId;
  description?: string;
  website?: string;
  logoUrl?: string;
  ceo?: string;
  employees?: number;
  address?: {
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
};

/**
 * Canonical persisted daily market bar.
 *
 * V1 uses FMP's normal historical EOD series, whose OHLCV values are split-adjusted. Dividends are
 * not folded into this series. Historical reads must be returned in ascending date order even when
 * the upstream provider returns newest-first.
 */
export type DailyPrice = {
  securityId: SecurityId;
  date: LocalDate;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
};

export const MOVING_AVERAGE_TYPES = ["SMA", "EMA"] as const;
export type MovingAverageType = (typeof MOVING_AVERAGE_TYPES)[number];

/** Timeframe is part of indicator identity: SMA(20, 1D) and SMA(20, 1W) are different indicators. */
export const TECHNICAL_TIMEFRAMES = ["1D", "1W"] as const;
export type TechnicalTimeframe = (typeof TECHNICAL_TIMEFRAMES)[number];

export type MovingAverageDefinition = {
  type: MovingAverageType;
  /** Number of source bars in the moving-average window, not calendar days or weeks. */
  period: number;
  timeframe: TechnicalTimeframe;
};

/** Product-supported V1 moving averages. V1 materializes daily indicators only. */
export const DAILY_MOVING_AVERAGES = [
  { type: "SMA", period: 20, timeframe: "1D" },
  { type: "SMA", period: 50, timeframe: "1D" },
  { type: "SMA", period: 100, timeframe: "1D" },
  { type: "SMA", period: 200, timeframe: "1D" },
  { type: "EMA", period: 20, timeframe: "1D" },
  { type: "EMA", period: 50, timeframe: "1D" },
  { type: "EMA", period: 200, timeframe: "1D" },
] as const satisfies readonly MovingAverageDefinition[];

/**
 * Materialized daily derived values used by Stock Details and backtests.
 *
 * The `d` suffix is deliberate: it makes the timeframe explicit in storage/API contracts before
 * weekly indicators are introduced. Optional values mean the indicator is not available yet
 * because there are not enough warm-up bars; unavailable values must never be replaced with zero.
 */
export type DailyTechnical = {
  securityId: SecurityId;
  date: LocalDate;
  sma20d?: number;
  sma50d?: number;
  sma100d?: number;
  sma200d?: number;
  ema20d?: number;
  ema50d?: number;
  ema200d?: number;
  /** Increment when calculation or seed/warm-up semantics change. */
  calculationVersion: number;
};

/**
 * Weekly indicators are future derived data, not a second canonical market-data source.
 *
 * They must be calculated from `DailyPrice` by aggregating completed trading weeks first, then
 * applying the weekly indicator to those weekly bars. Do not derive weekly indicators by averaging
 * daily indicators. For PIT/backtest reads, a weekly value becomes eligible only after the source
 * week is complete; callers may then observe the same latest eligible weekly value on multiple
 * subsequent daily dates without duplicating that weekly snapshot in durable storage.
 */
export const WEEKLY_TECHNICAL_BACKTEST_POLICY =
  "COMPLETED_PERIODS_ONLY" as const;

export const INTRINSIC_VALUE_MODELS = [
  "DCF_FCFF",
  "RESIDUAL_INCOME",
  "DDM",
  "GRAHAM",
] as const;
export type IntrinsicValueModel = (typeof INTRINSIC_VALUE_MODELS)[number];

/** Persisted point-in-time intrinsic-value snapshot. */
export type IntrinsicValuePoint = {
  securityId: SecurityId;
  /** Product-effective valuation date; never earlier than availability of all required inputs. */
  valuationDate: LocalDate;
  /** Latest publication/availability instant among source inputs actually used. */
  sourceDataAsOf: Instant;
  model: IntrinsicValueModel;
  valuePerShare: number;
  currency: string;
  calculationVersion: number;
};

export const INTRINSIC_VALUE_BLEND_IDS = [
  "BALANCED",
  "CONSERVATIVE",
  "DIVIDEND",
] as const;
export type IntrinsicValueBlendId = (typeof INTRINSIC_VALUE_BLEND_IDS)[number];

export type IntrinsicValueBlendDefinition = {
  id: IntrinsicValueBlendId;
  version: number;
  components: readonly {
    model: IntrinsicValueModel;
    /** Decimal fraction; weights in a valid blend must sum to 1. */
    weight: number;
  }[];
};

export const INTRINSIC_VALUE_BLENDS = {
  BALANCED: {
    id: "BALANCED",
    version: 1,
    components: [
      { model: "DCF_FCFF", weight: 0.5 },
      { model: "RESIDUAL_INCOME", weight: 0.3 },
      { model: "GRAHAM", weight: 0.2 },
    ],
  },
  CONSERVATIVE: {
    id: "CONSERVATIVE",
    version: 1,
    components: [
      { model: "DCF_FCFF", weight: 0.4 },
      { model: "RESIDUAL_INCOME", weight: 0.3 },
      { model: "GRAHAM", weight: 0.3 },
    ],
  },
  DIVIDEND: {
    id: "DIVIDEND",
    version: 1,
    components: [
      { model: "DCF_FCFF", weight: 0.4 },
      { model: "DDM", weight: 0.4 },
      { model: "RESIDUAL_INCOME", weight: 0.2 },
    ],
  },
} as const satisfies Record<
  IntrinsicValueBlendId,
  IntrinsicValueBlendDefinition
>;

export type IntrinsicValueBlendPoint = {
  securityId: SecurityId;
  valuationDate: LocalDate;
  sourceDataAsOf: Instant;
  blendId: IntrinsicValueBlendId;
  valuePerShare: number;
  currency: string;
  calculationVersion: number;
  blendVersion: number;
};

export const STOCK_DATASETS = [
  "SECURITY_PROFILE",
  "DAILY_PRICE",
  "DAILY_TECHNICAL",
  "INCOME_STATEMENT",
  "BALANCE_SHEET",
  "CASH_FLOW",
  "DIVIDEND",
  "STOCK_SPLIT",
  "INTRINSIC_VALUE",
  "INTRINSIC_VALUE_BLEND",
] as const;
export type StockDataset = (typeof STOCK_DATASETS)[number];

/** Per-security dataset watermark used to make canonical delta/freshness decisions. */
export type StockDatasetState = {
  securityId: SecurityId;
  dataset: StockDataset;
  earliestDate?: LocalDate;
  latestDate?: LocalDate;
  /** Last successful persistence/sync operation, not the last attempted request. */
  lastSyncedAt?: Instant;
  /** Present for derived datasets invalidated by calculation-method changes. */
  calculationVersion?: number;
};

export type StockDetails = {
  security: Security;
  profile?: SecurityProfile;
  prices: DailyPrice[];
  technicals: DailyTechnical[];
  intrinsicValues: IntrinsicValuePoint[];
  intrinsicValueBlends: IntrinsicValueBlendPoint[];
};

/** `asOf` means only information eligible at or before this historical date. */
export type IntrinsicValueQuery = DateRange & {
  models?: readonly IntrinsicValueModel[];
  asOf?: LocalDate;
};

/** Same point-in-time semantics as `IntrinsicValueQuery`, applied to blend snapshots. */
export type IntrinsicValueBlendQuery = DateRange & {
  blendIds?: readonly IntrinsicValueBlendId[];
  asOf?: LocalDate;
};

/** Canonical stock-data read boundary shared by API Stock Details and worker backtests. */
export interface StockDataService {
  getSecurity(symbol: string): Promise<Security>;
  getStockDetails(symbol: string, range?: DateRange): Promise<StockDetails>;
  getDailyPrices(symbol: string, range: DateRange): Promise<DailyPrice[]>;
  getDailyTechnicals(
    symbol: string,
    range: DateRange,
  ): Promise<DailyTechnical[]>;
  getFinancialStatements(
    symbol: string,
    query: FinancialStatementQuery,
  ): Promise<FinancialStatement[]>;
  getIntrinsicValues(
    symbol: string,
    query: IntrinsicValueQuery,
  ): Promise<IntrinsicValuePoint[]>;
  getIntrinsicValueBlends(
    symbol: string,
    query: IntrinsicValueBlendQuery,
  ): Promise<IntrinsicValueBlendPoint[]>;
}

/** Durable persistence read port. Implement in the database layer; do not couple domain to Prisma. */
export interface StockDataRepository {
  getDatasetState(
    securityId: SecurityId,
    dataset: StockDataset,
  ): Promise<StockDatasetState | null>;
  getDailyPrices(
    securityId: SecurityId,
    range: DateRange,
  ): Promise<DailyPrice[]>;
  getDailyTechnicals(
    securityId: SecurityId,
    range: DateRange,
  ): Promise<DailyTechnical[]>;
  getFinancialStatements(
    securityId: SecurityId,
    query: FinancialStatementQuery,
  ): Promise<FinancialStatement[]>;
  getIntrinsicValues(
    securityId: SecurityId,
    query: IntrinsicValueQuery,
  ): Promise<IntrinsicValuePoint[]>;
  getIntrinsicValueBlends(
    securityId: SecurityId,
    query: IntrinsicValueBlendQuery,
  ): Promise<IntrinsicValueBlendPoint[]>;
}

/** Complete-stock LRU residency control for disposable Redis cache. */
export interface StockCache {
  hasResidentStock(securityId: SecurityId): Promise<boolean>;
  touch(securityId: SecurityId): Promise<void>;
  /** Evict every cached dataset for the security as one logical operation. */
  evict(securityId: SecurityId): Promise<void>;
}
