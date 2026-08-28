import type {
  DailyPrice,
  DailyTechnical,
  DateRange,
  FinancialStatementCadence,
  FinancialStatement,
  FinancialStatementDraft,
  FinancialStatementQuery,
  FinancialStatementType,
  IntrinsicValueBlendPoint,
  IntrinsicValueBlendQuery,
  IntrinsicValuePoint,
  IntrinsicValueQuery,
  Security,
  SecurityProfile,
  StockDataset,
  StockDatasetState,
} from "@intrinsic/domain";
import type { MappedFmpProfile } from "@intrinsic/fmp";
import type { WeeklyPrice } from "./weekly.js";

export type PersistedStockDataset =
  StockDataset | "WEEKLY_PRICE" | "WEEKLY_TECHNICAL";

export type PersistedDatasetState = Omit<StockDatasetState, "dataset"> & {
  dataset: PersistedStockDataset;
  variant: string;
};

export const DAILY_PRICE_VARIANT = "split-adjusted-eod-full";
export const DAILY_PRICE_FRESHNESS_VARIANT =
  "split-adjusted-eod-full:recent-tail";

export interface StockDataStore {
  findSecurityByProviderSymbol(symbol: string): Promise<Security | null>;
  saveSecurityProfile(
    mapped: MappedFmpProfile,
    syncedAt: string,
  ): Promise<{ security: Security; profile: SecurityProfile }>;
  getProfile(securityId: string): Promise<SecurityProfile | null>;
  getDatasetState(
    securityId: string,
    dataset: PersistedStockDataset,
    variant?: string,
  ): Promise<PersistedDatasetState | null>;
  getDatasetCoverage(
    securityId: string,
    dataset: PersistedStockDataset,
    variant: string,
    range: Required<DateRange>,
  ): Promise<Required<DateRange>[]>;
  getLatestCoverageSyncContainingDate(
    securityId: string,
    dataset: PersistedStockDataset,
    variant: string,
    date: string,
  ): Promise<string | null>;
  getDailyPrices(securityId: string, range: DateRange): Promise<DailyPrice[]>;
  saveDailyPriceSync(input: {
    securityId: string;
    prices: readonly DailyPrice[];
    successfulCoverage: readonly Required<DateRange>[];
    syncedAt: string;
    tailDate: string;
    freshThrough?: string;
    assertOwned?: () => void;
  }): Promise<{ earliestChangedDate?: string }>;
  getDailyTechnicals(
    securityId: string,
    range: DateRange,
    calculationVersion: number,
  ): Promise<DailyTechnical[]>;
  getFinancialStatements(
    securityId: string,
    query: FinancialStatementQuery,
  ): Promise<FinancialStatement[]>;
  getFinancialStatementRevisions(input: {
    securityId: string;
    statementType?: FinancialStatementType;
    cadence?: FinancialStatementCadence;
    from?: string;
    to?: string;
  }): Promise<FinancialStatement[]>;
  saveFinancialStatements(input: {
    securityId: string;
    statements: readonly FinancialStatementDraft[];
    syncedAt: string;
  }): Promise<{ insertedRevisionCount: number; unchangedCount: number }>;
  upsertDatasetState(input: {
    securityId: string;
    dataset: PersistedStockDataset;
    variant: string;
    syncedAt: string;
    earliestDate?: string;
    latestDate?: string;
  }): Promise<void>;
  saveDerivedTechnicals(input: {
    securityId: string;
    technicals: readonly DailyTechnical[];
    weeklyPrices: readonly WeeklyPrice[];
    successfulCoverage: Required<DateRange>;
    syncedAt: string;
    dailyTechnicalCalculationVersion: number;
    weeklyCalculationVersion: number;
    assertOwned?: () => void;
  }): Promise<void>;
  getWeeklyPrices(
    securityId: string,
    range: DateRange,
    calculationVersion: number,
  ): Promise<WeeklyPrice[]>;
  getIntrinsicValues(
    securityId: string,
    query: IntrinsicValueQuery,
  ): Promise<IntrinsicValuePoint[]>;
  getIntrinsicValuesForBlend(
    securityId: string,
    query: IntrinsicValueQuery,
  ): Promise<IntrinsicValuePoint[]>;
  getIntrinsicValueBlends(
    securityId: string,
    query: IntrinsicValueBlendQuery,
  ): Promise<IntrinsicValueBlendPoint[]>;
}
