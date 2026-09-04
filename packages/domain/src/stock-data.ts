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

/**
 * Field carrying one moving average on the persisted/derived daily state.
 *
 * The timeframe suffix is part of the name: `d` for daily bars, `w` for completed weekly bars.
 * `sma20d` and `sma20w` are different indicators over different source bars and never alias.
 */
export type MovingAverageField =
  | `${Lowercase<MovingAverageType>}${number}d`
  | `${Lowercase<MovingAverageType>}${number}w`;

export type MaterializedMovingAverage = MovingAverageDefinition & {
  /** Column/field the calculated value is materialized into on `DailyDerivedState`. */
  field: MovingAverageField;
};

/** Product-supported daily moving averages, materialized from canonical daily closes. */
export const DAILY_MOVING_AVERAGES = [
  { type: "SMA", period: 20, timeframe: "1D", field: "sma20d" },
  { type: "SMA", period: 50, timeframe: "1D", field: "sma50d" },
  { type: "SMA", period: 100, timeframe: "1D", field: "sma100d" },
  { type: "SMA", period: 200, timeframe: "1D", field: "sma200d" },
  { type: "EMA", period: 20, timeframe: "1D", field: "ema20d" },
  { type: "EMA", period: 50, timeframe: "1D", field: "ema50d" },
  { type: "EMA", period: 200, timeframe: "1D", field: "ema200d" },
] as const satisfies readonly MaterializedMovingAverage[];

/**
 * Product-supported weekly moving averages, fixed by the selectable-series catalog decision.
 *
 * The period counts completed weekly bars, never calendar days: `SMA(20, 1W)` averages twenty
 * weekly closes. Values are calculated from weekly bars aggregated out of `DailyPrice` and are
 * never derived by averaging daily moving averages. Each value is carried forward onto every
 * trading day from the close of its source week's final trading day until a newer completed week
 * replaces it.
 */
export const WEEKLY_MOVING_AVERAGES = [
  { type: "SMA", period: 20, timeframe: "1W", field: "sma20w" },
  { type: "SMA", period: 50, timeframe: "1W", field: "sma50w" },
  { type: "SMA", period: 100, timeframe: "1W", field: "sma100w" },
  { type: "SMA", period: 200, timeframe: "1W", field: "sma200w" },
  { type: "EMA", period: 20, timeframe: "1W", field: "ema20w" },
  { type: "EMA", period: 50, timeframe: "1W", field: "ema50w" },
  { type: "EMA", period: 200, timeframe: "1W", field: "ema200w" },
] as const satisfies readonly MaterializedMovingAverage[];

/** Every materialized moving average, daily first, in canonical catalog order. */
export const MATERIALIZED_MOVING_AVERAGES = [
  ...DAILY_MOVING_AVERAGES,
  ...WEEKLY_MOVING_AVERAGES,
] as const satisfies readonly MaterializedMovingAverage[];

export type DailyMovingAverageField =
  (typeof DAILY_MOVING_AVERAGES)[number]["field"];
export type WeeklyMovingAverageField =
  (typeof WEEKLY_MOVING_AVERAGES)[number]["field"];

export const OSCILLATOR_TYPES = ["RSI"] as const;
export type OscillatorType = (typeof OSCILLATOR_TYPES)[number];

/**
 * An oscillator is a bounded, unitless technical series and is a separate family from the moving
 * averages: it is never price-scaled, never drawn over the price series, and its value is never
 * comparable with a price or a moving average — only with fixed thresholds inside its own range or
 * with another oscillator of the same type and timeframe.
 */
export type OscillatorDefinition = {
  type: OscillatorType;
  /** Number of source bars in the oscillator window, never calendar days or weeks. */
  period: number;
  timeframe: TechnicalTimeframe;
};

/**
 * Field carrying one oscillator on the persisted/derived daily state.
 *
 * The timeframe suffix follows the moving-average convention: `d` for daily bars. `rsi14d` can
 * never alias a hypothetical weekly `rsi14w`, and an ambiguous `rsi14` is forbidden.
 */
export type OscillatorField =
  | `${Lowercase<OscillatorType>}${number}d`
  | `${Lowercase<OscillatorType>}${number}w`;

export type MaterializedOscillator = OscillatorDefinition & {
  /** Column/field the calculated value is materialized into on `DailyDerivedState`. */
  field: OscillatorField;
};

/**
 * Product-supported daily oscillators, materialized from canonical completed daily closes — the
 * same close series the daily moving averages consume.
 *
 * All three RSI periods share one Wilder methodology; only the period differs. The period counts
 * trading-day observations: RSI 14D needs fifteen daily closes (fourteen consecutive changes)
 * before its first value, regardless of how many calendar days those bars span.
 */
export const DAILY_OSCILLATORS = [
  { type: "RSI", period: 7, timeframe: "1D", field: "rsi7d" },
  { type: "RSI", period: 14, timeframe: "1D", field: "rsi14d" },
  { type: "RSI", period: 21, timeframe: "1D", field: "rsi21d" },
] as const satisfies readonly MaterializedOscillator[];

export type DailyOscillatorField = (typeof DAILY_OSCILLATORS)[number]["field"];

/**
 * Fixed unit range of every RSI value. The bounds are attained: an all-gain warm-up window is
 * exactly 100 and an all-loss window exactly 0. The shared oscillator chart pane renders this
 * range as its fixed scale, and future Strategy predicates compare RSI operands against
 * thresholds inside it — never against a price.
 */
export const RSI_VALUE_RANGE = { min: 0, max: 100 } as const;

/** Any field served by the daily technical projection: a moving average or a daily oscillator. */
export type TechnicalSeriesField =
  | DailyMovingAverageField
  | WeeklyMovingAverageField
  | DailyOscillatorField;

/**
 * Every technical-series field in canonical wire order: moving averages (daily, then weekly)
 * first, oscillators after them. This is the order fields are projected by the API; the derived
 * row is written from the same registries, so a registered series cannot go missing from either.
 */
export const TECHNICAL_SERIES_FIELDS: readonly TechnicalSeriesField[] = [
  ...MATERIALIZED_MOVING_AVERAGES.map((average) => average.field),
  ...DAILY_OSCILLATORS.map((oscillator) => oscillator.field),
];

/**
 * Daily technical read projection over `DailyDerivedState`.
 *
 * The timeframe suffix is deliberate: `d` values come from daily bars and `w` values from the
 * latest completed weekly bar carried forward onto this trading day. Optional values mean the
 * indicator is not available yet because there are not enough warm-up bars; unavailable values
 * must never be replaced with zero.
 *
 * Every row is still a daily row. A `w` value repeats across the trading days of a week and only
 * changes once a newer week completes; the current, still-running week never contributes.
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
  sma20w?: number;
  sma50w?: number;
  sma100w?: number;
  sma200w?: number;
  ema20w?: number;
  ema50w?: number;
  ema200w?: number;
  /**
   * Daily Wilder RSI values over the same canonical daily closes as the daily moving averages.
   * Unitless, bounded to `RSI_VALUE_RANGE`, and absent until the period's warm-up of `period + 1`
   * closes is complete — never zero during warm-up.
   */
  rsi7d?: number;
  rsi14d?: number;
  rsi21d?: number;
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
/**
 * Retained deliberately: this names the eligibility policy the weekly pipeline implements.
 *
 * Nothing branches on it today because there is exactly one policy and
 * `aggregateCompletedWeeks` enforces it structurally by excluding the in-progress ISO week. It is
 * kept as the published domain name for that rule so Strategy operand evaluation and backtest
 * execution read one constant instead of restating "completed periods only" in feature code, and
 * so introducing a second policy is an explicit change here rather than a silent divergence.
 * `weekly-technicals.test.ts` asserts the implemented behaviour under this name.
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
   * effective on this trading day.
   *
   * It is present from the first trading day that has a completed week behind it, which is earlier
   * than the first week with enough warm-up bars for any weekly average. A present week start with
   * absent weekly values therefore means "a completed week exists, but this indicator has not
   * warmed up yet" — never zero, and never a value borrowed from another period.
   */
  weeklySourceWeekStart?: LocalDate;
  /**
   * Weekly moving averages of the completed week identified by `weeklySourceWeekStart`.
   *
   * Calculated from weekly closes aggregated out of `DailyPrice`, never by averaging daily moving
   * averages. A value first appears on the final trading day of the week that completes its
   * warm-up, is repeated on every later trading day, and is replaced only when a newer completed
   * week becomes eligible. The in-progress week is never represented here.
   */
  sma20w?: number;
  sma50w?: number;
  sma100w?: number;
  sma200w?: number;
  ema20w?: number;
  ema50w?: number;
  ema200w?: number;
  /**
   * Daily Wilder RSI oscillators, calculated per trading day from the same canonical daily closes
   * as the daily moving averages. Values are unitless and lie in `RSI_VALUE_RANGE`; a period is
   * absent until its warm-up of `period + 1` closes is complete, never zero.
   */
  rsi7d?: number;
  rsi14d?: number;
  rsi21d?: number;
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

/**
 * How far back the Stock Details surface may explore one security, and why it stops there.
 *
 * `start` is the earliest date the surface will ask for, and the only boundary a client stops at:
 * `HORIZON` is the configured product limit, `LISTING` the security's own listing date when that
 * is later, and `PROVIDER` the earliest trading day the provider actually has — reported only
 * once complete provider coverage proves that nothing older exists between the horizon-or-listing
 * bound and that day. An empty bounded read is never evidence of where history begins.
 */
export type StockHistoryBounds = {
  start: LocalDate;
  end: LocalDate;
  startOrigin: StockHistoryStartOrigin;
};

export type StockHistoryStartOrigin = "HORIZON" | "LISTING" | "PROVIDER";

export type StockDetails = {
  security: Security;
  profile?: SecurityProfile;
  /** The window this surface is allowed to explore for this security. */
  history: StockHistoryBounds;
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

/*
 * The durable-persistence and cache ports deliberately do not live here.
 *
 * `StockDataStore` and `StockDataCache` in `@intrinsic/stock-data` are the real ports: they are
 * implemented, injected and tested, and they carry infrastructure-shaped concerns (dataset
 * variants, coverage intervals, yearly cache chunks, hydration generations) that must not leak
 * into the pure domain. Earlier `StockDataRepository`/`StockCache` declarations here were never
 * implemented by anything and were removed rather than kept as a second, drifting definition.
 */
