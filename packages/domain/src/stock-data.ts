/** Calendar date in canonical `YYYY-MM-DD` form. No timezone is attached. */
export type LocalDate = string;

/** Absolute timestamp, serialized as an ISO-8601 instant when persisted or sent over a boundary. */
export type Instant = string;

/** Internal immutable product identifier. Never use ticker symbol as the durable primary key. */
export type SecurityId = string;

/**
 * Inclusive calendar-date range used by historical reads.
 *
 * `from` and `to` are optional so callers can request open-ended history. Implementations must
 * reject inverted ranges (`from > to`) at an appropriate boundary rather than silently swapping
 * them.
 */
export type DateRange = {
  from?: LocalDate;
  to?: LocalDate;
};

export const SECURITY_TYPES = ["STOCK", "ETF", "FUND"] as const;
export type SecurityType = (typeof SECURITY_TYPES)[number];

/**
 * Stable identity/classification data for a listed security.
 *
 * Keep volatile market fields (price, market cap, volume, daily change, beta, etc.) out of this
 * object even if an upstream FMP profile endpoint happens to return them. `symbol` is a market
 * identifier scoped by listing/exchange and is not the durable product identity.
 */
export type Security = {
  id: SecurityId;
  symbol: string;
  name: string;
  /** Short exchange/listing code used by the product, e.g. NASDAQ. */
  exchangeCode: string;
  /** Human-readable exchange name when the provider exposes one. */
  exchangeName?: string;
  /** Trading/reporting currency associated with this listing, e.g. USD. */
  currency: string;
  /** SEC CIK when applicable. Preserve provider leading zeroes by keeping it as a string. */
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

/**
 * Descriptive company/listing profile separated from `Security` identity.
 *
 * V1 treats these fields as the current profile snapshot. Do not pretend they are point-in-time
 * historical attributes unless a future model explicitly versions them.
 */
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
 * NOT folded into this price series; dividend events remain separate so total-return behavior can
 * be modeled explicitly. The application must not re-apply stock splits to these values.
 *
 * Service/repository implementations should return bars in ascending chronological order even if
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
  /** Provider VWAP for the same canonical daily bar when available. */
  vwap?: number;
};

export const MOVING_AVERAGE_TYPES = ["SMA", "EMA"] as const;
export type MovingAverageType = (typeof MOVING_AVERAGE_TYPES)[number];

/**
 * Timeframe is part of an indicator's identity: SMA(50, 1D) is not SMA(50, 1W).
 *
 * `1W` is reserved in the contract for later use. V1 persists only `1D` technicals.
 */
export const TECHNICAL_TIMEFRAMES = ["1D", "1W"] as const;
export type TechnicalTimeframe = (typeof TECHNICAL_TIMEFRAMES)[number];

export type MovingAverageDefinition = {
  type: MovingAverageType;
  /** Number of bars in the moving-average window, not calendar days/weeks. */
  period: number;
  timeframe: TechnicalTimeframe;
};

/**
 * Product-supported V1 moving-average catalog.
 *
 * These are calculated by our application from canonical daily closes. FMP technical-indicator
 * endpoints may be used in tests as an external oracle, but production reads must not depend on
 * FMP pre-calculated SMA/EMA values.
 */
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
 * Indicator fields are optional because the beginning of a price history may not have enough
 * warm-up bars to produce a valid value. Do not fill unavailable warm-up values with zero.
 */
export type DailyTechnical = {
  securityId: SecurityId;
  date: LocalDate;
  sma20?: number;
  sma50?: number;
  sma100?: number;
  sma200?: number;
  ema20?: number;
  ema50?: number;
  ema200?: number;
  /**
   * Version of our calculation methodology. Increment when an algorithm/seed convention changes
   * in a way that requires persisted derived values to be recomputed.
   */
  calculationVersion: number;
};

/**
 * V1 absolute intrinsic-value model catalog.
 *
 * Relative valuation/multiples are intentionally not represented as intrinsic-value models here.
 */
export const INTRINSIC_VALUE_MODELS = [
  "DCF_FCFF",
  "RESIDUAL_INCOME",
  "DDM",
  "GRAHAM",
] as const;
export type IntrinsicValueModel = (typeof INTRINSIC_VALUE_MODELS)[number];

/**
 * Persisted point-in-time valuation snapshot.
 *
 * Historical correctness invariant: no input used by this point may have become public after
 * `sourceDataAsOf`. A backtest requesting an earlier date must never see this point.
 */
export type IntrinsicValuePoint = {
  securityId: SecurityId;
  /**
   * Product-effective valuation date used for historical lookup/charting. The implementation must
   * never make a valuation effective before all of its source inputs were publicly available.
   */
  valuationDate: LocalDate;
  /**
   * Latest publication/availability instant among the source inputs actually used by the model.
   * This is the primary audit field for preventing look-ahead bias.
   */
  sourceDataAsOf: Instant;
  model: IntrinsicValueModel;
  valuePerShare: number;
  currency: string;
  /** Version of the model formula/assumption methodology that produced this persisted value. */
  calculationVersion: number;
};

export const INTRINSIC_VALUE_BLEND_IDS = [
  "BALANCED",
  "CONSERVATIVE",
  "DIVIDEND",
] as const;
export type IntrinsicValueBlendId = (typeof INTRINSIC_VALUE_BLEND_IDS)[number];

/** Versioned product methodology for combining eligible intrinsic-value model snapshots. */
export type IntrinsicValueBlendDefinition = {
  id: IntrinsicValueBlendId;
  /** Increment when component weights or membership change. Never rewrite old blend semantics. */
  version: number;
  components: readonly {
    model: IntrinsicValueModel;
    /** Decimal fraction in [0, 1]. Component weights for a valid definition must sum to 1. */
    weight: number;
  }[];
};

/**
 * V1 product blend catalog.
 *
 * Missing/not-applicable component models (for example DDM on a non-dividend payer) must be
 * handled explicitly by the future blend engine. It must not silently use a future snapshot or
 * invent a replacement model to force a result.
 */
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
} as const satisfies Record<IntrinsicValueBlendId, IntrinsicValueBlendDefinition>;

/** Materialized result of one versioned blend at one point in historical time. */
export type IntrinsicValueBlendPoint = {
  securityId: SecurityId;
  valuationDate: LocalDate;
  /** Latest source-data instant across every component snapshot actually used by the blend. */
  sourceDataAsOf: Instant;
  blendId: IntrinsicValueBlendId;
  valuePerShare: number;
  currency: string;
  /** Version of the blend-calculation implementation, separate from the blend weight definition. */
  calculationVersion: number;
  /** Must match the `IntrinsicValueBlendDefinition.version` used to calculate this row. */
  blendVersion: number;
};

/**
 * Independently loadable/persistable stock datasets tracked by the loader.
 *
 * Add a new entry only when the dataset has distinct freshness/range/calculation semantics.
 */
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

/**
 * Per-security dataset watermark used to make range-aware loading decisions.
 *
 * This replaces proliferating fields such as `lastUpdatedPrice` on `Security`. Bounds are an
 * optimization/watermark, not proof that there can never be an internal gap; implementations must
 * remain calendar/data aware when determining a missing range.
 */
export type StockDatasetState = {
  securityId: SecurityId;
  dataset: StockDataset;
  /** Earliest persisted business/effective date currently known for this dataset. */
  earliestDate?: LocalDate;
  /** Latest persisted business/effective date currently known for this dataset. */
  latestDate?: LocalDate;
  /** Time of the last successful sync/persist operation, not the last attempted request. */
  lastSyncedAt?: Instant;
  /** Present for derived datasets whose persisted rows are invalidated by algorithm changes. */
  calculationVersion?: number;
};

/**
 * Domain composition consumed by a Stock Details application service.
 *
 * This is not an instruction to always load all available history. `getStockDetails` should use
 * its requested/default range for historical arrays and avoid accidental unbounded provider loads.
 */
export type StockDetails = {
  security: Security;
  profile?: SecurityProfile;
  prices: DailyPrice[];
  technicals: DailyTechnical[];
  intrinsicValues: IntrinsicValuePoint[];
  intrinsicValueBlends: IntrinsicValueBlendPoint[];
};

/**
 * Historical intrinsic-value filter.
 *
 * `asOf` means "only information eligible at or before this date". When a caller asks for an as-of
 * snapshot, return the latest eligible point per requested model rather than a later valuation
 * whose source data was not yet public. If combined with `from`/`to`, all supplied constraints
 * apply.
 */
export type IntrinsicValueQuery = DateRange & {
  models?: readonly IntrinsicValueModel[];
  asOf?: LocalDate;
};

/** Same point-in-time semantics as `IntrinsicValueQuery`, applied to versioned blend snapshots. */
export type IntrinsicValueBlendQuery = DateRange & {
  blendIds?: readonly IntrinsicValueBlendId[];
  asOf?: LocalDate;
};

/**
 * Canonical stock-data read boundary shared by interactive API flows and worker backtests.
 *
 * Callers must depend on this behavior rather than reading Prisma, Redis, or FMP directly. The
 * implementation is responsible for cache -> PostgreSQL -> missing-delta upstream/calculation
 * orchestration while preserving identical domain results for all callers.
 */
export interface StockDataService {
  /** Resolve a listing by symbol and return stable product identity data. */
  getSecurity(symbol: string): Promise<Security>;

  /**
   * Compose Stock Details for a symbol. `range` applies to historical arrays; identity/profile
   * data is not clipped by it. When omitted, the API implementation must choose and document a
   * bounded UI default rather than implicitly fetching all history.
   */
  getStockDetails(symbol: string, range?: DateRange): Promise<StockDetails>;

  /** Return canonical split-adjusted daily bars in ascending date order for the inclusive range. */
  getDailyPrices(symbol: string, range: DateRange): Promise<DailyPrice[]>;

  /** Return persisted V1 daily derived values in ascending date order for the inclusive range. */
  getDailyTechnicals(symbol: string, range: DateRange): Promise<DailyTechnical[]>;

  /** Return point-in-time-correct model snapshots filtered by model/range/as-of semantics. */
  getIntrinsicValues(
    symbol: string,
    query: IntrinsicValueQuery,
  ): Promise<IntrinsicValuePoint[]>;

  /** Return point-in-time-correct blend snapshots with calculation/blend version metadata. */
  getIntrinsicValueBlends(
    symbol: string,
    query: IntrinsicValueBlendQuery,
  ): Promise<IntrinsicValueBlendPoint[]>;
}

/**
 * Durable persistence read port for the stock loader.
 *
 * Implement in the database layer. Do not make the domain package depend on Prisma. Returned
 * historical rows follow the same ordering/range/as-of semantics as `StockDataService`.
 */
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

  getIntrinsicValues(
    securityId: SecurityId,
    query: IntrinsicValueQuery,
  ): Promise<IntrinsicValuePoint[]>;

  getIntrinsicValueBlends(
    securityId: SecurityId,
    query: IntrinsicValueBlendQuery,
  ): Promise<IntrinsicValueBlendPoint[]>;
}

/**
 * Symbol-residency/LRU control port for the disposable cache.
 *
 * The unit of eviction is the complete symbol, not an individual dataset key. Evicting a symbol
 * must remove all stock-data cache keys owned by that symbol. PostgreSQL remains authoritative.
 * This interface intentionally describes residency policy only; concrete cache data structures
 * remain an implementation concern of the later loader/cache slice.
 */
export interface StockCache {
  /** True only when the symbol is considered resident under the cache implementation's contract. */
  hasResidentSymbol(symbol: string): Promise<boolean>;

  /** Record successful use of a resident/admitted symbol for LRU ordering. */
  touch(symbol: string): Promise<void>;

  /** Evict every cache dataset associated with the symbol as one logical operation. */
  evict(symbol: string): Promise<void>;
}
