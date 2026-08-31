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
 * Daily technical read projection over `DailyDerivedState`.
 *
 * The `d` suffix is deliberate: it makes the timeframe explicit in storage/API contracts before
 * weekly indicators are introduced. Optional values mean the indicator is not available yet
 * because there are not enough warm-up bars; unavailable values must never be replaced with zero.
 *
 * There is no calculation version: exactly one current methodology is materialized per trading
 * day. A methodology change rebuilds the affected rows instead of adding a parallel version.
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
};

/**
 * Weekly indicators are derived data, not a second canonical market-data source.
 *
 * They must be calculated from `DailyPrice` by aggregating completed trading weeks first, then
 * applying the weekly indicator to those weekly bars. Do not derive weekly indicators by averaging
 * daily indicators. For PIT/backtest use, a weekly value becomes eligible only after the source week
 * is complete. Because the daily derived state is an end-of-trading-day state, that means the
 * week's own final trading day, after its close; earlier days in the same week must never see it.
 * Once eligible, the latest weekly value is intentionally materialized on every subsequent
 * trading-day derived record until a newer completed-week value replaces it. Repeated daily values
 * are part of the backtest-facing data model, not accidental duplication.
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

/**
 * Persisted point-in-time intrinsic-value value for a trading day.
 *
 * The underlying valuation changes only when a newly eligible PIT input replaces one of its
 * sources, but the latest eligible result is materialized forward onto every trading day so
 * backtests can consume a fully daily-aligned series without resolving sparse valuation events.
 * There is one current methodology: a methodology change rebuilds and replaces the affected rows
 * rather than storing a parallel calculation version.
 */
export type IntrinsicValuePoint = {
  securityId: SecurityId;
  /** Trading day for which this materialized valuation value is effective. */
  valuationDate: LocalDate;
  /**
   * Latest publication/availability instant among source inputs actually used by *this* model.
   * It comes from that model's own provenance field on `DailyDerivedState`; models on the same
   * trading day routinely carry different instants.
   */
  sourceDataAsOf: Instant;
  model: IntrinsicValueModel;
  valuePerShare: number;
  currency: string;
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

/**
 * Daily intrinsic-value blend read projection over `DailyDerivedState`.
 *
 * Blend weights are versioned in `IntrinsicValueBlendDefinition` so a weight change is an explicit
 * product decision, but the materialized daily state holds only the current blend definition. A
 * weight change rebuilds the affected daily rows; blend versions never coexist per trading day.
 */
export type IntrinsicValueBlendPoint = {
  securityId: SecurityId;
  valuationDate: LocalDate;
  /**
   * Derived, never stored: the maximum provenance instant of the models that actually compose
   * this blend. A blend is unavailable unless every required component value and every required
   * component provenance instant is present and eligible at the requested cutoff.
   */
  sourceDataAsOf: Instant;
  blendId: IntrinsicValueBlendId;
  valuePerShare: number;
  currency: string;
};

/**
 * Unified daily materialized derived state: exactly one record per security per trading day.
 *
 * This is the single backtest-facing and Stock Details derived representation. It intentionally
 * repeats values whose sources change less frequently than daily (completed-week weekly
 * indicators, fundamentals-driven intrinsic values and blends): once a value first becomes
 * point-in-time eligible it is carried forward onto every subsequent trading day until a newer
 * eligible value replaces it. Repetition is the data model, not a caching artifact, so consumers
 * never resolve sparse events themselves.
 *
 * Invariants that must not be reintroduced:
 * - no calculation/methodology version participates in identity; `(securityId, date)` is the key
 *   and a methodology change rebuilds the affected rows rather than storing a parallel history;
 * - symbol/ticker is never part of durable historical identity; resolve symbol -> securityId once;
 * - an absent value means not yet eligible or insufficient warm-up. Never substitute zero and
 *   never back-fill a value before its first eligible trading day.
 */
export type DailyDerivedState = {
  securityId: SecurityId;
  date: LocalDate;
  sma20d?: number;
  sma50d?: number;
  sma100d?: number;
  sma200d?: number;
  ema20d?: number;
  ema50d?: number;
  ema200d?: number;
  /**
   * Start date of the completed weekly period whose carried-forward weekly indicators are
   * effective on this trading day. Weekly indicator values are added alongside this field once the
   * weekly period catalog is product-defined; they are not invented ahead of that decision.
   */
  weeklySourceWeekStart?: LocalDate;
  /** Per-model intrinsic value per share, present only for models eligible on this trading day. */
  intrinsicValues?: Partial<Record<IntrinsicValueModel, number>>;
  /** Per-blend intrinsic value per share, present only for blends computable on this trading day. */
  intrinsicValueBlends?: Partial<Record<IntrinsicValueBlendId, number>>;
  /**
   * Point-in-time provenance is per intrinsic-value model, not per row.
   *
   * Each model may consume a different financial-statement family/revision, so its inputs can
   * become public at a different instant. Every field below is the latest publication/availability
   * instant among the source inputs actually used by that model on this trading day: a
   * no-look-ahead audit field, never later than the end of `date`.
   *
   * A model value is only readable together with its own provenance: a present value with an
   * absent provenance instant is never returned. Reads must filter each model independently and
   * must never delay one model to the newest provenance instant on the row.
   *
   * Blend provenance is deliberately not stored. It is derived at read time as the maximum
   * provenance of the models that actually compose the blend; see `INTRINSIC_VALUE_BLENDS`.
   */
  dcfFcffSourceAsOf?: Instant;
  residualIncomeSourceAsOf?: Instant;
  ddmSourceAsOf?: Instant;
  grahamSourceAsOf?: Instant;
  intrinsicCurrency?: string;
};

export const STOCK_DATASETS = [
  "SECURITY_PROFILE",
  "DAILY_PRICE",
  "DAILY_DERIVED_STATE",
  "INCOME_STATEMENT",
  "BALANCE_SHEET",
  "CASH_FLOW",
  "DIVIDEND",
  "STOCK_SPLIT",
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

/** Free-text identity search over the persisted securities universe. */
export type SecuritySearchQuery = {
  /** Raw user input; implementations trim and match case-insensitively. */
  term: string;
  /** Maximum rows to return. Implementations apply their own dropdown-sized default. */
  limit?: number;
};

/** Canonical stock-data read boundary shared by API Stock Details and worker backtests. */
export interface StockDataService {
  getSecurity(symbol: string): Promise<Security>;
  /**
   * Identity lookup across the locally persisted securities universe, used by the global stock
   * search. It never reaches the external provider: search runs on every keystroke and must stay a
   * cheap local read.
   */
  searchSecurities(query: SecuritySearchQuery): Promise<Security[]>;
  getStockDetails(symbol: string, range?: DateRange): Promise<StockDetails>;
  getDailyPrices(symbol: string, range: DateRange): Promise<DailyPrice[]>;
  getDailyDerivedState(
    symbol: string,
    range: DateRange,
  ): Promise<DailyDerivedState[]>;
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
  getDailyDerivedState(
    securityId: SecurityId,
    range: DateRange,
  ): Promise<DailyDerivedState[]>;
  getFinancialStatements(
    securityId: SecurityId,
    query: FinancialStatementQuery,
  ): Promise<FinancialStatement[]>;
}

/** Complete-stock LRU residency control for disposable Redis cache. */
export interface StockCache {
  hasResidentStock(securityId: SecurityId): Promise<boolean>;
  touch(securityId: SecurityId): Promise<void>;
  /** Evict every cached dataset for the security as one logical operation. */
  evict(securityId: SecurityId): Promise<void>;
}
