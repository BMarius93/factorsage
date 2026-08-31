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
  SecurityId,
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

/**
 * One catalog row: the provider identity the upsert keys on, plus the lightweight identity fields
 * a universe synchronization owns.
 */
export type SecurityCatalogEntry = {
  providerSymbol: string;
  security: Omit<Security, "id">;
};

/** A persisted catalog row read back with the provider identity it is keyed by. */
export type PersistedSecurityCatalogEntry = {
  providerSymbol: string;
  security: Security;
};

export const DAILY_PRICE_VARIANT = "split-adjusted-eod-full";
export const WEEKLY_PRICE_VARIANT = "completed-weeks";
export const DAILY_PRICE_FRESHNESS_VARIANT =
  "split-adjusted-eod-full:recent-tail";

export interface StockDataStore {
  findSecurityByProviderSymbol(symbol: string): Promise<Security | null>;
  /**
   * Candidate securities for the global search, matched case-insensitively on symbol prefix or
   * name substring. Returns unranked candidates: relevance ordering is a domain concern applied by
   * the service, so the store stays a plain persistence read.
   */
  searchSecurities(input: {
    term: string;
    limit: number;
  }): Promise<Security[]>;
  /** Reads existing catalog rows so a synchronization can tell created from updated. */
  findSecurityCatalogEntries(
    providerSymbols: readonly string[],
  ): Promise<PersistedSecurityCatalogEntry[]>;
  /**
   * Inserts catalog rows, ignoring any whose provider identity already exists. Returning the
   * inserted count keeps the caller honest when a concurrent sync wins a race.
   */
  createSecurityCatalogEntries(
    entries: readonly SecurityCatalogEntry[],
  ): Promise<number>;
  /**
   * Updates the lightweight catalog fields of one existing row. Never creates: a `Security` may
   * only come into existence through an explicit catalog synchronization.
   */
  updateSecurityCatalogEntry(entry: SecurityCatalogEntry): Promise<void>;
  /**
   * Persists the per-stock profile and refreshes the identity fields the bulk catalog cannot
   * supply. Keyed by `securityId` rather than provider symbol so it can only ever refine a
   * `Security` the catalog already admits, never conjure one.
   */
  saveSecurityProfile(input: {
    securityId: SecurityId;
    mapped: MappedFmpProfile;
    syncedAt: string;
  }): Promise<{ security: Security; profile: SecurityProfile }>;
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
