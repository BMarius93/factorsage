import type {
  DailyDerivedState,
  DailyPrice,
  DateRange,
  FinancialStatementCadence,
  FinancialStatement,
  FinancialStatementDraft,
  FinancialStatementQuery,
  FinancialStatementType,
  Security,
  SecurityProfile,
  StockDataset,
  StockDatasetState,
} from "@intrinsic/domain";
import type { MappedFmpProfile } from "@intrinsic/fmp";
import type { WeeklyPrice } from "./weekly.js";

export type PersistedStockDataset = StockDataset | "WEEKLY_PRICE";

export type PersistedDatasetState = Omit<StockDatasetState, "dataset"> & {
  dataset: PersistedStockDataset;
  variant: string;
};

export const DAILY_PRICE_VARIANT = "split-adjusted-eod-full";
export const WEEKLY_PRICE_VARIANT = "completed-weeks";
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
  /**
   * Reads the unified daily derived state for one security over an inclusive date range in
   * ascending date order. This is the only historical derived access pattern; symbol/ticker never
   * participates in durable historical identity.
   */
  getDailyDerivedState(
    securityId: string,
    range: DateRange,
  ): Promise<DailyDerivedState[]>;
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
  /**
   * Replaces the materialized derived state for the supplied trading days.
   *
   * There is exactly one current methodology per `(securityId, date)`. Persisting must overwrite
   * the affected rows rather than append a parallel calculation-version history.
   */
  saveDailyDerivedState(input: {
    securityId: string;
    rows: readonly DailyDerivedState[];
    weeklyPrices: readonly WeeklyPrice[];
    successfulCoverage: Required<DateRange>;
    syncedAt: string;
    assertOwned?: () => void;
  }): Promise<void>;
  getWeeklyPrices(
    securityId: string,
    range: DateRange,
  ): Promise<WeeklyPrice[]>;
}
