import type {
  AlternativeActorType,
  CongressChamber,
  CongressOwner,
  CongressTransactionKind,
  InsiderRole,
  InsiderTransactionCategory,
  InstitutionalPositionChange,
  LocalDate,
  SecurityId,
} from "@intrinsic/domain";

/**
 * The persistence and provider seams of the alternative-data slice.
 *
 * It mirrors `ports.ts` deliberately: one store interface, one set of dataset variants, and a service
 * above it that both the API and the worker construct from the same composition — so API and worker
 * stay different processes rather than different implementations.
 *
 * Coverage bookkeeping reuses the existing `StockDatasetState` rows under three new `StockDataset`
 * values rather than growing a parallel table, which is why the variants below look like the price
 * ones.
 */

/**
 * The provider dataset each domain's coverage describes.
 *
 * Versioned for the same reason `DAILY_PRICE_VARIANT` is: if what an ingested row *means* changes —
 * a different endpoint, a different classification, a different availability rule — bumping the
 * variant makes every earlier state row invisible and the affected securities re-ingest lazily on
 * their next read, without deleting anything.
 *
 * Revision history:
 * - insider v1: `insider-trading/search`, paged to exhaustion, availability = filing date + 1 day.
 * - congress v1: `senate-trades` + `house-trades`, paged to exhaustion, availability = disclosure
 *   date + 1 day.
 * - institutional v1: `institutional-ownership/extract-analytics/holder` per report quarter,
 *   availability = filing date + 1 day, position changes derived from consecutive available filings.
 */
export const INSIDER_TRADE_VARIANT = "form4-insider-search:v1";
export const CONGRESS_TRADE_VARIANT = "congress-periodic-transactions:v1";
export const INSTITUTIONAL_HOLDING_VARIANT = "form13f-holder-extract:v1";

export const ALTERNATIVE_DATA_DOMAINS = [
  "INSIDER",
  "CONGRESS",
  "INSTITUTIONAL",
] as const;

export type AlternativeDataDomain = (typeof ALTERNATIVE_DATA_DOMAINS)[number];

/** The `StockDataset` value and variant one domain's coverage is recorded under. */
export const ALTERNATIVE_DATA_DATASETS = {
  INSIDER: { dataset: "INSIDER_TRADE", variant: INSIDER_TRADE_VARIANT },
  CONGRESS: { dataset: "CONGRESS_TRADE", variant: CONGRESS_TRADE_VARIANT },
  INSTITUTIONAL: {
    dataset: "INSTITUTIONAL_HOLDING",
    variant: INSTITUTIONAL_HOLDING_VARIANT,
  },
} as const satisfies Record<
  AlternativeDataDomain,
  { dataset: string; variant: string }
>;

/**
 * What the ingested history for one security and domain vouches for.
 *
 * `earliestAvailableDate` is the earliest availability date actually ingested and is the floor of the
 * evaluable range — **not** the beginning of time. The provider's endpoints expose no coverage
 * statement and accept no date range, so "we saw no filing before this" cannot be distinguished from
 * "the dataset does not reach back that far", and reporting zero for the difference would be a claim
 * the data does not support.
 *
 * `syncedThroughDate` is the calendar date of the last successful ingest. Past it the product knows
 * nothing, so the column is absent rather than zero.
 */
export type AlternativeDataDatasetState = {
  earliestAvailableDate: LocalDate | null;
  latestAvailableDate: LocalDate | null;
  syncedThroughDate: LocalDate | null;
  lastSuccessfulSyncAt: string | null;
};

/** One canonical actor as the store persists and returns it. */
export type PersistedAlternativeDataActor = {
  id: string;
  type: AlternativeActorType;
  externalId: string;
  displayName: string;
  chamber?: CongressChamber;
  state?: string;
  district?: string;
  cik?: string;
};

/** An actor the ingest observed: created on first sight, refreshed on every later one. */
export type AlternativeDataActorUpsert = {
  type: AlternativeActorType;
  externalId: string;
  displayName: string;
  chamber?: CongressChamber;
  state?: string;
  district?: string;
  cik?: string;
};

/** One insider transaction as the ingest writes it. `securityId` binds it to the catalog. */
export type InsiderTransactionWrite = {
  securityId: SecurityId;
  transactionDate: LocalDate;
  filingDate: LocalDate;
  availableFromDate: LocalDate;
  reportingCik: string;
  reportingName: string;
  companyCik?: string;
  typeOfOwner?: string;
  roles: readonly InsiderRole[];
  transactionCode?: string;
  transactionTypeRaw: string;
  category: InsiderTransactionCategory;
  acquisitionOrDisposition?: string;
  directOrIndirect?: string;
  formType?: string;
  securityName?: string;
  securitiesTransacted?: number;
  securitiesOwned?: number;
  price?: number;
  transactionValue?: number;
  sourceUrl?: string;
  raw: Record<string, unknown>;
  contentHash: string;
};

export type CongressTradeWrite = {
  securityId: SecurityId;
  actorId: string;
  chamber: CongressChamber;
  transactionDate: LocalDate;
  disclosureDate: LocalDate;
  availableFromDate: LocalDate;
  kind: CongressTransactionKind;
  transactionTypeRaw: string;
  owner: CongressOwner;
  ownerRaw?: string;
  assetClass:
    | "STOCK"
    | "STOCK_OPTION"
    | "BOND"
    | "FUND"
    | "CRYPTO"
    | "OTHER";
  assetTypeRaw?: string;
  assetDescription?: string;
  amountRangeRaw?: string;
  amountLowerBound?: number;
  amountUpperBound?: number;
  capitalGainsOver200Usd?: boolean;
  comment?: string;
  sourceUrl?: string;
  raw: Record<string, unknown>;
  contentHash: string;
};

export type InstitutionalFilingWrite = {
  actorId: string;
  reportPeriod: LocalDate;
  filingDate: LocalDate;
  availableFromDate: LocalDate;
  amendmentType?: string;
  providerFilingId?: string;
  raw: Record<string, unknown>;
  contentHash: string;
  holdings: readonly {
    securityId: SecurityId;
    shares: number;
    marketValue?: number;
    portfolioWeightPercent?: number;
    raw: Record<string, unknown>;
  }[];
};

export type InstitutionalPositionEventWrite = {
  securityId: SecurityId;
  actorId: string;
  reportPeriod: LocalDate;
  previousReportPeriod?: LocalDate;
  availableFromDate: LocalDate;
  change: InstitutionalPositionChange;
  shares: number;
  previousShares?: number;
  changePercent?: number;
  portfolioWeightPercent?: number;
  previousPortfolioWeightPercent?: number;
};

/** How many rows a write actually changed, so an ingest can report itself honestly. */
export type AlternativeDataWriteResult = {
  inserted: number;
  unchanged: number;
};

/**
 * One insider disclosure as a column projection reads it.
 *
 * Deliberately three fields. A projected column needs the session the fact became readable, the
 * identity a distinct-actor count is keyed by, and the amount a value measure sums; everything else on
 * the row is audit data that would cost memory per session for no reading.
 */
export type InsiderObservationRow = {
  availableFromDate: LocalDate;
  /** The reporting person's CIK. Never a display name. */
  actorKey: string;
  transactionValue: number | null;
};

export type CongressObservationRow = {
  availableFromDate: LocalDate;
  /** The canonical actor id. */
  actorKey: string;
  /** The **lower bound** of the disclosed band. Never a midpoint. */
  amountLowerBound: number | null;
};

export type InstitutionalObservationRow = {
  availableFromDate: LocalDate;
  actorKey: string;
  shares: number;
  previousShares: number | null;
};

/** The insider rows one configured metric selects. */
export type InsiderObservationQuery = {
  securityId: SecurityId;
  from: LocalDate;
  to: LocalDate;
  category: InsiderTransactionCategory;
  /** Absent means every role counts. */
  roles?: readonly InsiderRole[];
};

export type CongressObservationQuery = {
  securityId: SecurityId;
  from: LocalDate;
  to: LocalDate;
  kind: CongressTransactionKind;
  /** Absent means every in-scope member counts; an empty list selects nobody. */
  actorIds?: readonly string[];
  chamber?: CongressChamber;
  owners?: readonly CongressOwner[];
};

export type InstitutionalObservationQuery = {
  securityId: SecurityId;
  from: LocalDate;
  to: LocalDate;
  changes: readonly InstitutionalPositionChange[];
  actorIds?: readonly string[];
};

/**
 * Persistence for the alternative-data slice.
 *
 * The reads are deliberately narrow and indexed: each one answers a single configured metric over a
 * bounded availability range for one security, which is the only shape a frame projection ever needs.
 */
export interface AlternativeDataStore {
  /**
   * Creates actors on first sight and refreshes their labels afterwards, returning the canonical id
   * of every actor in the batch keyed by `type:externalId`.
   *
   * Idempotent, and it never renames an identity: `(type, externalId)` is the key, so a member whose
   * display name changes keeps the same row — and every group that holds them keeps holding them.
   */
  upsertActors(
    actors: readonly AlternativeDataActorUpsert[],
  ): Promise<Map<string, string>>;

  /** Canonical actors matching a search term, for the searchable picker. */
  searchActors(input: {
    type: AlternativeActorType;
    term?: string;
    limit: number;
  }): Promise<PersistedAlternativeDataActor[]>;

  findActorsByIds(
    ids: readonly string[],
  ): Promise<PersistedAlternativeDataActor[]>;

  /** The actor ids in one group, in a stable order. Empty for a group that does not exist. */
  getActorGroupMemberIds(groupId: string): Promise<string[]>;

  getAlternativeDatasetState(
    securityId: SecurityId,
    domain: AlternativeDataDomain,
  ): Promise<AlternativeDataDatasetState | null>;

  /**
   * Records one successful ingest: the availability window it now holds and the instant it ran.
   *
   * `earliestAvailableDate` is only ever widened downwards, never narrowed, because a later refresh
   * that pages less deeply has not un-learned the older rows it already persisted.
   */
  recordAlternativeDatasetSync(input: {
    securityId: SecurityId;
    domain: AlternativeDataDomain;
    earliestAvailableDate?: LocalDate;
    latestAvailableDate?: LocalDate;
    syncedAt: string;
  }): Promise<void>;

  saveInsiderTransactions(
    rows: readonly InsiderTransactionWrite[],
  ): Promise<AlternativeDataWriteResult>;

  saveCongressTrades(
    rows: readonly CongressTradeWrite[],
  ): Promise<AlternativeDataWriteResult>;

  saveInstitutionalFilings(
    filings: readonly InstitutionalFilingWrite[],
  ): Promise<AlternativeDataWriteResult>;

  /**
   * Every filing that names one security, for one manager, with that security's holding line.
   *
   * The input to the derivation, and it includes the periods where the manager filed but held nothing
   * — those are what make an exit visible.
   */
  getInstitutionalFilingsForSecurity(input: {
    securityId: SecurityId;
    actorId?: string;
  }): Promise<
    {
      actorId: string;
      reportPeriod: LocalDate;
      filingDate: LocalDate;
      availableFromDate: LocalDate;
      amendmentType?: string;
      shares: number | null;
      portfolioWeightPercent: number | null;
    }[]
  >;

  /**
   * Replaces the derived position events for one security, or for one security and manager.
   *
   * A replacement rather than an append, because the events are a pure function of the filings: an
   * amendment changes an existing period's comparison, and appending would leave the superseded one
   * beside it.
   */
  replaceInstitutionalPositionEvents(input: {
    securityId: SecurityId;
    events: readonly InstitutionalPositionEventWrite[];
  }): Promise<void>;

  getInsiderObservations(
    query: InsiderObservationQuery,
  ): Promise<InsiderObservationRow[]>;

  getCongressObservations(
    query: CongressObservationQuery,
  ): Promise<CongressObservationRow[]>;

  getInstitutionalObservations(
    query: InstitutionalObservationQuery,
  ): Promise<InstitutionalObservationRow[]>;
}
