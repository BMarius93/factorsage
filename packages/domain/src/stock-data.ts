export type LocalDate = string;
export type Instant = string;
export type SecurityId = string;

export type DateRange = {
  from?: LocalDate;
  to?: LocalDate;
};

export const SECURITY_TYPES = ["STOCK", "ETF", "FUND"] as const;
export type SecurityType = (typeof SECURITY_TYPES)[number];

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

export const TECHNICAL_TIMEFRAMES = ["1D", "1W"] as const;
export type TechnicalTimeframe = (typeof TECHNICAL_TIMEFRAMES)[number];

export type MovingAverageDefinition = {
  type: MovingAverageType;
  period: number;
  timeframe: TechnicalTimeframe;
};

export const DAILY_MOVING_AVERAGES = [
  { type: "SMA", period: 20, timeframe: "1D" },
  { type: "SMA", period: 50, timeframe: "1D" },
  { type: "SMA", period: 100, timeframe: "1D" },
  { type: "SMA", period: 200, timeframe: "1D" },
  { type: "EMA", period: 20, timeframe: "1D" },
  { type: "EMA", period: 50, timeframe: "1D" },
  { type: "EMA", period: 200, timeframe: "1D" },
] as const satisfies readonly MovingAverageDefinition[];

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
  calculationVersion: number;
};

export const INTRINSIC_VALUE_MODELS = [
  "DCF_FCFF",
  "RESIDUAL_INCOME",
  "DDM",
  "GRAHAM",
] as const;
export type IntrinsicValueModel = (typeof INTRINSIC_VALUE_MODELS)[number];

export type IntrinsicValuePoint = {
  securityId: SecurityId;
  valuationDate: LocalDate;
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
} as const satisfies Record<IntrinsicValueBlendId, IntrinsicValueBlendDefinition>;

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

export type StockDatasetState = {
  securityId: SecurityId;
  dataset: StockDataset;
  earliestDate?: LocalDate;
  latestDate?: LocalDate;
  lastSyncedAt?: Instant;
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

export type IntrinsicValueQuery = DateRange & {
  models?: readonly IntrinsicValueModel[];
  asOf?: LocalDate;
};

export type IntrinsicValueBlendQuery = DateRange & {
  blendIds?: readonly IntrinsicValueBlendId[];
  asOf?: LocalDate;
};

export interface StockDataService {
  getSecurity(symbol: string): Promise<Security>;
  getStockDetails(symbol: string, range?: DateRange): Promise<StockDetails>;
  getDailyPrices(symbol: string, range: DateRange): Promise<DailyPrice[]>;
  getDailyTechnicals(symbol: string, range: DateRange): Promise<DailyTechnical[]>;
  getIntrinsicValues(
    symbol: string,
    query: IntrinsicValueQuery,
  ): Promise<IntrinsicValuePoint[]>;
  getIntrinsicValueBlends(
    symbol: string,
    query: IntrinsicValueBlendQuery,
  ): Promise<IntrinsicValueBlendPoint[]>;
}

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

export interface StockCache {
  hasResidentSymbol(symbol: string): Promise<boolean>;
  touch(symbol: string): Promise<void>;
  evict(symbol: string): Promise<void>;
}
