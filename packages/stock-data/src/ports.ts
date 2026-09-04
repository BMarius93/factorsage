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

/**
 * Revision of the canonical daily price dataset: what a persisted coverage interval *means*.
 *
 * Like `DERIVED_STATE_REVISION` for calculated series, this is a rebuild trigger and never a row
 * identity. It is recorded in two places that must agree — the durable coverage/state variant
 * (`DAILY_PRICE_VARIANT`) and the Redis manifest field `priceDatasetVersion` — so bumping it makes
 * every earlier manifest stale and every earlier coverage interval invisible to the loader. The
 * affected range is then re-verified against the provider lazily, on the next read that needs it;
 * already-persisted rows are kept and deduplicated on write, so a bump costs provider requests,
 * never data.
 *
 * Revision history:
 * - v1: one provider request per missing interval, and the whole interval recorded as covered.
 *   `historical-price-eod/full` silently caps a response at 5000 rows, so any interval longer than
 *   about twenty trading years was persisted short and its oldest years recorded as "covered, no
 *   rows" — for `AAPL`, coverage from 1996 with a first row in 2006. A v1 interval therefore does
 *   not prove that the provider was asked for every date in it.
 * - v2: the adapter paginates every request to completeness, so coverage means "asked for every
 *   date in the interval with complete requests, and every returned row persisted". v1 coverage
 *   and manifests are not trusted; a stock heals itself on its next read.
 */
export const PRICE_DATASET_VERSION = 2;

/** The provider dataset every price-dataset revision describes; revisions share this prefix. */
export const DAILY_PRICE_VARIANT_FAMILY = "split-adjusted-eod-full";
export const DAILY_PRICE_VARIANT = `${DAILY_PRICE_VARIANT_FAMILY}:v${PRICE_DATASET_VERSION}`;
export const WEEKLY_PRICE_VARIANT = "completed-weeks";
/**
 * Recent-tail freshness watermark. Not coverage: it records through which day the bounded tail
 * refresh last succeeded, and the tail window is far below the provider's page cap, so it is
 * deliberately not revisioned with `PRICE_DATASET_VERSION`.
 */
export const DAILY_PRICE_FRESHNESS_VARIANT = `${DAILY_PRICE_VARIANT_FAMILY}:recent-tail`;

/**
 * Whether a persisted `DAILY_PRICE` variant is an earlier revision of the canonical price
 * dataset — the unversioned v1 name or a `:v<N>` other than the current one. Unrelated variants
 * of the same dataset are not superseded by a revision bump and are left alone.
 */
export function isSupersededDailyPriceVariant(variant: string): boolean {
  return (
    variant.startsWith(DAILY_PRICE_VARIANT_FAMILY) &&
    variant !== DAILY_PRICE_VARIANT &&
    variant !== DAILY_PRICE_FRESHNESS_VARIANT
  );
}

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
  /**
   * The earliest persisted trading day for the security, or `null` when it has no price rows.
   * Together with complete coverage back to the permitted bound, this is what proves that the
   * provider has nothing older — the one durable basis for reporting a `PROVIDER` history start.
   */
  getEarliestDailyPriceDate(securityId: string): Promise<string | null>;
  /**
   * Persists provider rows and records `successfulCoverage` under the current
   * `DAILY_PRICE_VARIANT`. Each interval must have been asked for completely: the adapter's
   * pagination is what makes that true, and a coverage interval is the durable claim that asking
   * again is pointless. Coverage and state rows of superseded price-dataset variants are removed
   * in the same transaction, so a stock never carries two generations of coverage.
   */
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
  /**
   * Persists the completed-week OHLCV aggregate alongside the derived rows it fed.
   *
   * `WeeklyPrice` is source data, not a derived series value, so it is written at weekly cadence
   * and has no read port: every rebuild re-aggregates completed weeks from canonical `DailyPrice`
   * rather than reading these rows back, and consumers get the weekly *indicator* values carried
   * forward on the daily derived row instead.
   */
  saveDailyDerivedState(input: {
    securityId: string;
    rows: readonly DailyDerivedState[];
    weeklyPrices: readonly WeeklyPrice[];
    successfulCoverage: Required<DateRange>;
    syncedAt: string;
    assertOwned?: () => void;
  }): Promise<void>;
}
