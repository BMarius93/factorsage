import type {
  IndexConstituentResolution,
  IndexMembershipPeriodQuality,
  LocalDate,
  MarketIndexKey,
} from "@intrinsic/domain";
import type {
  ConstituentOrigin,
  ReconstructedConstituent,
  SymbolChangeInput,
  TickerSpan,
} from "./reconstruction.js";

/** One provider change-log row as stored: the reconstruction's input plus its own evidence. */
export type StoredIndexChange = {
  readonly contentHash: string;
  readonly effectiveDate: LocalDate;
  readonly changeType: string;
  readonly addedTicker: string | null;
  readonly addedName: string | null;
  readonly removedTicker: string | null;
  readonly removedName: string | null;
  readonly reason: string | null;
  readonly providerDateText: string | null;
};

export type StoredSymbolChange = SymbolChangeInput & {
  readonly contentHash: string;
  readonly companyName: string | null;
};

export type SourceRecordOutcome = {
  /** Rows seen for the first time. */
  readonly inserted: number;
  /** Rows seen before and seen again. */
  readonly confirmed: number;
  /** Rows seen before that the provider no longer lists; kept, marked not in the latest source. */
  readonly retired: number;
};

export type StoredMembershipPeriod = {
  readonly startDate: LocalDate | null;
  readonly startLogDate: LocalDate | null;
  readonly endDate: LocalDate | null;
  readonly endLogDate: LocalDate | null;
  readonly quality: IndexMembershipPeriodQuality;
  readonly startChangeHash: string | null;
  readonly endChangeHash: string | null;
  readonly startMatch: string | null;
};

export type StoredIndexConstituent = {
  readonly id: string;
  readonly constituentKey: string;
  readonly origin: ConstituentOrigin;
  readonly ticker: string;
  readonly name: string;
  readonly cik: string | null;
  readonly tickerHistory: readonly TickerSpan[];
  readonly securityId: string | null;
  /**
   * The first day `securityId`'s prices are this constituent's history (an identity correction's
   * `securityFrom`); null when they are its history throughout. Membership before it is unpriced.
   */
  readonly securityFrom: LocalDate | null;
  readonly resolution: IndexConstituentResolution;
  readonly resolutionEvidence: unknown;
  readonly periods: readonly StoredMembershipPeriod[];
};

export type ConstituentResolutionWrite = {
  readonly constituentKey: string;
  readonly securityId: string | null;
  readonly securityFrom: LocalDate | null;
  readonly resolution: IndexConstituentResolution;
  readonly evidence: unknown;
};

export type ReplaceConstituentsOutcome = {
  readonly created: number;
  /** Constituents whose ticker, name, history or periods changed: their resolution starts over. */
  readonly changed: number;
  readonly unchanged: number;
  readonly removed: number;
};

export type IndexMembershipSyncRecord = {
  readonly id: string;
  readonly indexKey: MarketIndexKey;
  readonly completedAt: Date | null;
  readonly sourceDigest: string | null;
  readonly summary: unknown;
};

/** PostgreSQL persistence of the canonical membership dataset. */
export interface IndexMembershipStore {
  recordIndexChanges(
    indexKey: MarketIndexKey,
    rows: readonly StoredIndexChange[],
    seenAt: Date,
  ): Promise<SourceRecordOutcome>;
  recordSymbolChanges(
    rows: readonly StoredSymbolChange[],
    seenAt: Date,
  ): Promise<SourceRecordOutcome>;
  /** Every change-log row the newest source listed. */
  loadIndexChanges(indexKey: MarketIndexKey): Promise<StoredIndexChange[]>;
  /** Every rename the newest source listed. */
  loadSymbolChanges(): Promise<StoredSymbolChange[]>;

  startSync(
    indexKey: MarketIndexKey,
    algorithmVersion: number,
  ): Promise<string>;
  completeSync(
    syncId: string,
    result: {
      sourceDigest: string;
      currentConstituents: unknown;
      summary: unknown;
    },
  ): Promise<void>;
  failSync(syncId: string, error: string): Promise<void>;
  latestCompletedSync(
    indexKey: MarketIndexKey,
  ): Promise<IndexMembershipSyncRecord | null>;
  /** Merges a later summary section (resolution, projection) into a completed sync's summary. */
  amendSyncSummary(
    syncId: string,
    section: string,
    value: unknown,
  ): Promise<void>;

  /**
   * Makes the stored constituents exactly `constituents`, in one transaction. A constituent whose
   * ticker, name, ticker history and periods are unchanged keeps its resolution; one that changed
   * starts over at `PENDING`; one no longer reconstructed is removed with its periods.
   */
  replaceConstituents(
    indexKey: MarketIndexKey,
    syncId: string,
    constituents: readonly ReconstructedConstituent[],
  ): Promise<ReplaceConstituentsOutcome>;
  loadConstituents(indexKey: MarketIndexKey): Promise<StoredIndexConstituent[]>;
  saveResolutions(
    indexKey: MarketIndexKey,
    writes: readonly ConstituentResolutionWrite[],
    resolvedAt: Date,
  ): Promise<void>;
  /**
   * Keeps one constituent's probe evidence while it is still `PENDING`, so an interrupted resolution
   * resumes without asking the provider again. Discarded with the rest of the evidence when the
   * constituent's membership changes.
   */
  saveProbe(
    indexKey: MarketIndexKey,
    constituentKey: string,
    probe: unknown,
  ): Promise<void>;
}
