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

export type DailyPriceResponse = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
};

export type DailyTechnicalResponse = {
  date: string;
  sma20?: number;
  sma50?: number;
  sma100?: number;
  sma200?: number;
  ema20?: number;
  ema50?: number;
  ema200?: number;
  calculationVersion: number;
};

export type IntrinsicValueModelResponse =
  | "DCF_FCFF"
  | "RESIDUAL_INCOME"
  | "DDM"
  | "GRAHAM";

export type IntrinsicValueResponse = {
  valuationDate: string;
  sourceDataAsOf: string;
  model: IntrinsicValueModelResponse;
  valuePerShare: number;
  currency: string;
  calculationVersion: number;
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
  calculationVersion: number;
  blendVersion: number;
};

export type StockDetailsResponse = {
  security: SecurityResponse;
  profile?: SecurityProfileResponse;
  prices: DailyPriceResponse[];
  technicals: DailyTechnicalResponse[];
  intrinsicValues: IntrinsicValueResponse[];
  intrinsicValueBlends: IntrinsicValueBlendResponse[];
};

export type IntrinsicValueHistoryQuery = StockDateRangeQuery & {
  models?: IntrinsicValueModelResponse[];
  asOf?: string;
};

export type IntrinsicValueBlendHistoryQuery = StockDateRangeQuery & {
  blendIds?: IntrinsicValueBlendIdResponse[];
  asOf?: string;
};
