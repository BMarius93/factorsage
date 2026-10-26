import { createHash } from "node:crypto";
import {
  applyChangeLogCorrections,
  type IndexChangeLogCorrection,
} from "./change-log-corrections.js";
import {
  pointInTimeIndexUniverse,
  type DailyPrice,
  type DateRange,
  type IndexConstituentResolution,
  type LocalDate,
  type MarketIndexKey,
} from "@intrinsic/domain";
import type {
  FmpIndexMembershipPort,
  MappedFmpDelistedCompany,
  MappedFmpIndexChange,
  MappedFmpIndexConstituent,
  MappedFmpProfile,
} from "@intrinsic/fmp";
import { addDays } from "../dates.js";
import {
  matchIdentityCorrections,
  storedCorrectionId,
  windowsFrom,
  type IndexIdentityCorrection,
} from "./corrections.js";
import type {
  ConstituentResolutionWrite,
  IndexMembershipStore,
  StoredIndexConstituent,
  StoredSymbolChange,
} from "./ports.js";
import {
  membershipQualityReport,
  type MembershipQualityReport,
} from "./quality.js";
import {
  INDEX_RECONSTRUCTION_ALGORITHM_VERSION,
  reconstructIndexMembership,
  type ReconstructionAnomaly,
} from "./reconstruction.js";
import {
  decideConstituentResolution,
  expectedSessions,
  INDEX_ADDITION_MIN_MARKET_CAP,
  INDEX_LEGACY_MEMBER_MIN_MARKET_CAP,
  medianDollarVolume,
  membershipWithinHorizon,
  plausibilityRefusal,
  nameEvidence,
  overlappingClaims,
  resolutionCandidates,
  sessionsWithin,
  type CandidateEvidence,
  type ConstituentResolutionDecision,
  type MembershipWindow,
  type ResolvedConstituentClaim,
} from "./resolution.js";

/** The provider reads a synchronization and a resolution make. */
export type IndexMembershipProvider = FmpIndexMembershipPort & {
  getDailyPrices(
    symbol: string,
    securityId: string,
    range: DateRange,
  ): Promise<DailyPrice[]>;
  getProfile(symbol: string): Promise<MappedFmpProfile | null>;
};

/** A listing the catalog can admit, from a profile or the delisted directory. */
export type IndexUniverseListing = {
  readonly symbol: string;
  readonly name: string;
  readonly exchangeCode: string | null;
  readonly isEtf: boolean;
  readonly isFund: boolean;
  readonly isActivelyTrading: boolean;
  readonly source: "PROFILE" | "DELISTED_DIRECTORY";
};

export type AdmissionOutcome =
  | { readonly symbol: string; readonly securityId: string }
  | { readonly symbol: string; readonly securityId: null; readonly reason: string };

/**
 * Admits the chosen symbols to the catalog through the one catalog writer, returning each symbol's
 * `Security.id` or why it could not be admitted. Symbols the catalog already holds are returned
 * without being re-admitted.
 */
export type IndexUniverseAdmitter = (
  listings: readonly IndexUniverseListing[],
) => Promise<readonly AdmissionOutcome[]>;

export type IndexMembershipEvent =
  | { event: "index.sync.source"; indexKey: MarketIndexKey; changes: number; renames: number; current: number; dropped: Record<string, number> }
  | { event: "index.sync.reconstructed"; indexKey: MarketIndexKey; constituents: number; anomalies: number }
  | { event: "index.sync.correction-unmatched"; indexKey: MarketIndexKey; unmatched: readonly { id: string; reason: string }[] }
  | { event: "index.resolve.progress"; indexKey: MarketIndexKey; done: number; total: number }
  | { event: "index.resolve.completed"; indexKey: MarketIndexKey; byResolution: Record<string, number> }
  | { event: "index.resolve.probe-failed"; indexKey: MarketIndexKey; constituentKey: string; error: string };

export type IndexMembershipSyncResult = {
  readonly syncId: string;
  readonly sourceDigest: string;
  readonly constituents: number;
  /** The reviewed change-log corrections (`change-log-corrections.ts`) applied, and those refused. */
  readonly changeLogCorrections: {
    readonly applied: readonly string[];
    readonly unmatched: readonly { id: string; reason: string }[];
  };
  readonly anomalies: readonly ReconstructionAnomaly[];
  readonly quality: MembershipQualityReport;
  readonly replaced: Awaited<ReturnType<IndexMembershipStore["replaceConstituents"]>>;
};

export type IndexResolutionResult = {
  readonly attempted: number;
  /** Identity corrections applied, by id, and those that matched no single constituent. */
  readonly corrections: {
    readonly applied: readonly string[];
    readonly unmatched: readonly { id: string; matches: number }[];
  };
  /** Probes the provider failed this run; those constituents stay `PENDING` for the next one. */
  readonly failedProbes: number;
  readonly byResolution: Record<IndexConstituentResolution, number>;
  readonly conflicts: number;
  readonly admitted: number;
};

/** The placeholder identity price probes are mapped under: probes are never persisted. */
const PROBE_SECURITY_ID = "index-resolution-probe";

/** Days after the first membership session in which a market capitalization is looked for. */
const MARKET_CAP_LOOKAHEAD_DAYS = 14;

/** The delisted directory is read until an empty page, and never beyond this. */
const DELISTED_DIRECTORY_MAX_PAGES = 400;

export function indexChangeContentHash(row: MappedFmpIndexChange): string {
  return digest([
    row.effectiveDate,
    row.changeType,
    row.addedTicker,
    row.addedName,
    row.removedTicker,
    row.removedName,
    row.reason,
    row.providerDateText,
  ]);
}

export function symbolChangeContentHash(row: {
  date: LocalDate;
  oldSymbol: string;
  newSymbol: string;
  companyName: string | null;
}): string {
  return digest([row.date, row.oldSymbol, row.newSymbol, row.companyName]);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

/**
 * Synchronizes an index's canonical membership with the provider and resolves its constituents to
 * catalog securities (`docs/decisions/sp500-historical-pit-v1.md`).
 *
 * `synchronize` asks three directory requests, stores what it read, reconstructs from what
 * PostgreSQL holds — never from the response directly, so a reconstruction is always reproducible
 * from the database — and replaces the canonical constituents in one transaction. `resolve` then
 * links every constituent whose membership reaches the List horizon to a security, probing the
 * provider only for constituents not already resolved under the same membership.
 */
export class IndexMembershipSyncService {
  private delisted: Promise<Map<string, MappedFmpDelistedCompany[]>> | undefined;

  constructor(
    private readonly store: IndexMembershipStore,
    private readonly provider: IndexMembershipProvider,
    private readonly options: {
      readonly now?: () => Date;
      readonly onEvent?: (event: IndexMembershipEvent) => void;
      /** Probes run at most this many at once; the provider gate still bounds the requests. */
      readonly probeConcurrency?: number;
      /** The reviewed identity corrections (`corrections.ts`); replaced only by tests. */
      readonly identityCorrections?: readonly IndexIdentityCorrection[];
      /** The reviewed change-log corrections (`change-log-corrections.ts`); replaced only by tests. */
      readonly changeLogCorrections?: readonly IndexChangeLogCorrection[];
    } = {},
  ) {}

  async synchronize(input: {
    indexKey: MarketIndexKey;
    floor: LocalDate;
    asOf: LocalDate;
  }): Promise<IndexMembershipSyncResult> {
    const { indexKey } = input;
    const syncId = await this.store.startSync(
      indexKey,
      INDEX_RECONSTRUCTION_ALGORITHM_VERSION,
    );
    try {
      const seenAt = this.now();
      const [current, changes, renames] = await Promise.all([
        this.provider.getIndexConstituents(indexKey),
        this.provider.getIndexChanges(indexKey),
        this.provider.getSymbolChanges(),
      ]);
      if (current.rows.length === 0 || changes.rows.length === 0) {
        throw new Error(
          `The provider returned ${current.rows.length} current constituents and ${changes.rows.length} changes for ${indexKey}; refusing to reconstruct from an empty source`,
        );
      }
      this.options.onEvent?.({
        event: "index.sync.source",
        indexKey,
        changes: changes.rows.length,
        renames: renames.rows.length,
        current: current.rows.length,
        dropped: {
          current: current.dropped,
          changes: changes.dropped,
          renames: renames.dropped,
        },
      });
      await this.store.recordIndexChanges(
        indexKey,
        changes.rows.map((row) => ({ ...row, contentHash: indexChangeContentHash(row) })),
        seenAt,
      );
      await this.store.recordSymbolChanges(
        renames.rows.map((row) => ({ ...row, contentHash: symbolChangeContentHash(row) })),
        seenAt,
      );

      const corrections = applyChangeLogCorrections(
        indexKey,
        await this.store.loadIndexChanges(indexKey),
        this.options.changeLogCorrections,
      );
      const storedChanges = corrections.changes;
      if (corrections.unmatched.length > 0) {
        this.options.onEvent?.({
          event: "index.sync.correction-unmatched",
          indexKey,
          unmatched: corrections.unmatched,
        });
      }
      const storedRenames = await this.store.loadSymbolChanges();
      const currentRows = [...current.rows].sort((left, right) =>
        left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0,
      );
      const result = reconstructIndexMembership({
        current: currentRows.map((row) => ({
          symbol: row.symbol,
          name: row.name,
          cik: row.cik,
          dateFirstAdded: row.dateFirstAdded,
        })),
        changes: storedChanges,
        symbolChanges: storedRenames,
        asOf: input.asOf,
      });
      this.options.onEvent?.({
        event: "index.sync.reconstructed",
        indexKey,
        constituents: result.constituents.length,
        anomalies: result.anomalies.length,
      });
      const replaced = await this.store.replaceConstituents(
        indexKey,
        syncId,
        result.constituents,
      );
      const quality = membershipQualityReport(
        result.constituents,
        { floor: input.floor, asOf: input.asOf },
        undefined,
        pointInTimeIndexUniverse(indexKey).expectedLines,
      );
      const sourceDigest = digest([
        INDEX_RECONSTRUCTION_ALGORITHM_VERSION,
        input.asOf,
        currentRows,
        storedChanges.map((row) => row.contentHash),
        storedRenames.map((row) => row.contentHash),
        // Present only when a correction applies, so an index without one keeps its digest.
        ...(corrections.applied.length > 0 ? [corrections.applied] : []),
      ]);
      await this.store.completeSync(syncId, {
        sourceDigest,
        currentConstituents: currentRows,
        summary: {
          source: {
            currentConstituents: current.rows.length,
            changes: changes.rows.length,
            renames: renames.rows.length,
            dropped: {
              current: current.dropped,
              changes: changes.dropped,
              renames: renames.dropped,
            },
          },
          reconstruction: {
            algorithmVersion: result.algorithmVersion,
            changeLogCorrections: {
              applied: corrections.applied,
              unmatched: corrections.unmatched,
            },
            logStart: result.logStart,
            constituents: result.constituents.length,
            byOrigin: countBy(result.constituents, (entry) => entry.origin),
            periodsByQuality: countBy(
              result.constituents.flatMap((entry) => entry.periods),
              (period) => period.quality,
            ),
            additionsByMatch: countBy(
              result.constituents
                .flatMap((entry) => entry.periods)
                .filter((period) => period.startMatch !== null),
              (period) => period.startMatch as string,
            ),
            // Applied additions by how their start was placed: refined or confirmed by the
            // current list, or deferred to the day after an unconfirmed log date.
            additionStarts: result.additionStarts,
            anomaliesByKind: countBy(result.anomalies, (anomaly) => anomaly.kind),
            anomalies: result.anomalies,
          },
          quality,
          replaced,
        },
      });
      return {
        syncId,
        sourceDigest,
        constituents: result.constituents.length,
        changeLogCorrections: {
          applied: corrections.applied,
          unmatched: corrections.unmatched,
        },
        anomalies: result.anomalies,
        quality,
        replaced,
      };
    } catch (error) {
      await this.store.failSync(
        syncId,
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
      throw error;
    }
  }

  async resolve(input: {
    indexKey: MarketIndexKey;
    floor: LocalDate;
    asOf: LocalDate;
    admit: IndexUniverseAdmitter;
    /** Re-probe constituents already resolved under an unchanged membership. */
    force?: boolean;
  }): Promise<IndexResolutionResult> {
    const { indexKey } = input;
    const horizon = { floor: input.floor, asOf: input.asOf };
    const constituents = await this.store.loadConstituents(indexKey);
    const renames = await this.store.loadSymbolChanges();
    const inScope = constituents.filter(
      (constituent) =>
        membershipWithinHorizon(constituent.periods, horizon).length > 0,
    );
    const corrections = matchIdentityCorrections(
      indexKey,
      inScope,
      this.options.identityCorrections,
    );
    const correctionOf = (constituent: StoredIndexConstituent) =>
      corrections.applied.get(constituent.constituentKey) ?? null;
    // A constituent whose correction changed — added, edited or withdrawn — is decided again.
    const correctionChanged = (constituent: StoredIndexConstituent) =>
      (correctionOf(constituent)?.id ?? null) !==
      storedCorrectionId(constituent);
    const toProbe = inScope.filter(
      (constituent) =>
        input.force ||
        constituent.resolution === "PENDING" ||
        correctionChanged(constituent),
    );

    const decisions = new Map<string, ConstituentResolutionDecision>();
    let done = 0;
    let failedProbes = 0;
    await mapWithConcurrency(
      toProbe,
      this.options.probeConcurrency ?? 4,
      async (constituent) => {
        const stored = correctionChanged(constituent)
          ? null
          : storedProbe(constituent);
        if (stored && !input.force) {
          decisions.set(constituent.constituentKey, stored);
        } else {
          try {
            const decision = await this.probeConstituent(
              constituent,
              horizon,
              renames,
              correctionOf(constituent),
            );
            decisions.set(constituent.constituentKey, decision);
            await this.store.saveProbe(indexKey, constituent.constituentKey, decision);
          } catch (error) {
            // Left PENDING with no decision: the next resolution probes it again. One provider
            // failure must not cost the probes every other constituent already paid for.
            failedProbes += 1;
            this.options.onEvent?.({
              event: "index.resolve.probe-failed",
              indexKey,
              constituentKey: constituent.constituentKey,
              error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            });
          }
        }
        done += 1;
        if (done % 50 === 0 || done === toProbe.length) {
          this.options.onEvent?.({
            event: "index.resolve.progress",
            indexKey,
            done,
            total: toProbe.length,
          });
        }
      },
    );

    // The overlap rule is global: it compares every resolved claim, probed now or earlier.
    const claims: ResolvedConstituentClaim[] = [];
    for (const constituent of inScope) {
      const decision = decisions.get(constituent.constituentKey);
      const symbol = decision ? decision.symbol : symbolOfStored(constituent);
      const resolution = decision ? decision.resolution : constituent.resolution;
      if (symbol === null || (resolution !== "RESOLVED" && resolution !== "RESOLVED_PARTIAL")) {
        continue;
      }
      const chosen = decision?.candidates.find((candidate) => candidate.symbol === symbol);
      claims.push({
        constituentKey: constituent.constituentKey,
        current: constituent.origin === "CURRENT",
        symbol,
        // Only the days the security's prices are this constituent's can clash with another's.
        windows: windowsFrom(
          membershipWithinHorizon(constituent.periods, horizon),
          decision
            ? (decision.correction?.securityFrom ?? null)
            : constituent.securityFrom,
        ),
        ownTicker: symbol === constituent.ticker,
        nameSimilarity: chosen?.nameSimilarity ?? storedNameSimilarity(constituent),
        coverage: decision?.coverage ?? storedCoverage(constituent),
      });
    }
    const conflicts = overlappingClaims(claims);
    const refusedByOverlap = new Map(conflicts.map((conflict) => [conflict.refused, conflict]));

    // Admission: every symbol a constituent was decided to this run, or that has no security yet. A
    // claim kept from an earlier run keeps the security it was admitted as: re-reading every listing
    // on every run cost a profile request per resolved symbol, enough to pass the provider's
    // per-minute allowance on its own.
    const storedSecurity = new Map(
      inScope.map((constituent) => [
        constituent.constituentKey,
        constituent.securityId,
      ]),
    );
    const keepsSecurity = (claim: ResolvedConstituentClaim) =>
      !decisions.has(claim.constituentKey) &&
      (storedSecurity.get(claim.constituentKey) ?? null) !== null;
    const chosenSymbols = new Set(
      claims
        .filter((claim) => !refusedByOverlap.has(claim.constituentKey))
        .filter((claim) => !keepsSecurity(claim))
        .map((claim) => claim.symbol),
    );
    const listings: IndexUniverseListing[] = [];
    const unlisted = new Map<string, string>();
    for (const symbol of [...chosenSymbols].sort()) {
      const listing = await this.listingOf(symbol);
      if (listing) {
        listings.push(listing);
      } else {
        unlisted.set(symbol, "the provider has neither a profile nor a delisted listing for it");
      }
    }
    const admitted = new Map<string, AdmissionOutcome>();
    for (const outcome of await input.admit(listings)) {
      admitted.set(outcome.symbol, outcome);
    }

    const writes: ConstituentResolutionWrite[] = [];
    const tally = Object.fromEntries(
      (["RESOLVED", "RESOLVED_PARTIAL", "NO_PROVIDER_DATA", "IDENTITY_REJECTED", "NOT_ADMISSIBLE", "PENDING"] as const).map(
        (resolution) => [resolution, 0],
      ),
    ) as Record<IndexConstituentResolution, number>;
    for (const constituent of inScope) {
      const decision = decisions.get(constituent.constituentKey);
      if (!decision && constituent.resolution === "PENDING") {
        // A probe that failed this run: nothing to decide yet, and its evidence stays as it is.
        tally.PENDING += 1;
        continue;
      }
      const claim = claims.find((entry) => entry.constituentKey === constituent.constituentKey);
      const conflict = refusedByOverlap.get(constituent.constituentKey);
      let resolution: IndexConstituentResolution = decision?.resolution ?? constituent.resolution;
      let securityId: string | null = null;
      const correction = decision ? (decision.correction ?? null) : null;
      let reason = decision?.reason ?? null;
      if (conflict) {
        resolution = "IDENTITY_REJECTED";
        reason = `${conflict.symbol} is the history of ${conflict.kept}, a member at the same time (${conflict.overlap.from} to ${conflict.overlap.to}); two simultaneous members cannot share one security`;
      } else if (claim) {
        const outcome = admitted.get(claim.symbol);
        if (keepsSecurity(claim)) {
          securityId = constituent.securityId;
        } else if (outcome && outcome.securityId !== null) {
          securityId = outcome.securityId;
        } else {
          resolution = "NOT_ADMISSIBLE";
          reason =
            outcome && outcome.securityId === null
              ? outcome.reason
              : (unlisted.get(claim.symbol) ?? "not admitted");
        }
      }
      tally[resolution] += 1;
      if (!decision && !conflict && resolution === constituent.resolution && securityId === constituent.securityId) {
        continue;
      }
      const storedCorrection = decision
        ? null
        : ((constituent.resolutionEvidence as { correction?: unknown } | null)
            ?.correction ?? null);
      writes.push({
        constituentKey: constituent.constituentKey,
        securityId,
        securityFrom:
          securityId === null
            ? null
            : decision
              ? (correction?.securityFrom ?? null)
              : constituent.securityFrom,
        resolution,
        evidence: {
          reason,
          symbol: claim && !conflict ? claim.symbol : null,
          coverage: decision?.coverage ?? claim?.coverage ?? null,
          candidates: decision?.candidates ?? candidatesOfStored(constituent),
          ...(conflict ? { overlapConflict: conflict } : {}),
          ...(correction
            ? { correction }
            : storedCorrection
              ? { correction: storedCorrection }
              : {}),
        },
      });
    }
    await this.store.saveResolutions(indexKey, writes, this.now());
    this.options.onEvent?.({
      event: "index.resolve.completed",
      indexKey,
      byResolution: tally,
    });
    return {
      attempted: toProbe.length,
      corrections: {
        applied: [...corrections.applied.values()]
          .map((correction) => correction.id)
          .sort(),
        unmatched: corrections.unmatched,
      },
      failedProbes,
      byResolution: tally,
      conflicts: conflicts.length,
      admitted: [...admitted.values()].filter((outcome) => outcome.securityId !== null).length,
    };
  }

  private async probeConstituent(
    constituent: StoredIndexConstituent,
    horizon: { floor: LocalDate; asOf: LocalDate },
    renames: readonly StoredSymbolChange[],
    correction: IndexIdentityCorrection | null,
  ): Promise<ConstituentResolutionDecision> {
    const membership = membershipWithinHorizon(constituent.periods, horizon);
    // A correction's symbol is probed only over the days its prices are this constituent's.
    const windows = windowsFrom(membership, correction?.securityFrom);
    const lastDay = membership.at(-1)?.to as LocalDate;
    const candidates = correction
      ? [correction.symbol]
      : resolutionCandidates(constituent, lastDay, renames);

    const firstPeriod = constituent.periods.find(
      (period) =>
        period.quality !== "END_UNKNOWN" &&
        (period.endDate === null || period.endDate >= horizon.floor),
    );
    const addedInsideHorizon =
      firstPeriod?.startDate !== null &&
      firstPeriod?.startDate !== undefined &&
      firstPeriod.startDate >= horizon.floor;
    const marketCapFloor = addedInsideHorizon
      ? INDEX_ADDITION_MIN_MARKET_CAP
      : INDEX_LEGACY_MEMBER_MIN_MARKET_CAP;
    const evidence: CandidateEvidence[] = [];
    // A correction whose prices begin after the whole membership has nothing to probe.
    for (const symbol of windows.length === 0 ? [] : candidates) {
      const item = await this.probeCandidate(
        symbol,
        constituent.name,
        windows,
        marketCapFloor,
      );
      evidence.push(item);
      if (item.refusal === null) {
        break;
      }
    }
    const decision = decideConstituentResolution(evidence);
    if (!correction) {
      return decision;
    }
    return {
      ...decision,
      reason: `identity correction ${correction.id}: ${decision.reason}`,
      correction: {
        id: correction.id,
        symbol: correction.symbol,
        securityFrom: correction.securityFrom ?? null,
        evidence: correction.evidence,
      },
    };
  }

  private async probeCandidate(
    symbol: string,
    constituentName: string,
    windows: readonly MembershipWindow[],
    marketCapFloor: number,
  ): Promise<CandidateEvidence> {
    const range = {
      from: windows[0]?.from as LocalDate,
      to: windows.at(-1)?.to as LocalDate,
    };
    const prices = await this.provider.getDailyPrices(symbol, PROBE_SECURITY_ID, range);
    const sessions = sessionsWithin(
      prices.map((row) => row.date).sort(),
      windows,
    );
    const ascending = [...prices].sort((left, right) =>
      left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
    );
    const base = {
      symbol,
      sessionsInMembership: sessions.count,
      expectedSessions: expectedSessions(windows),
      firstSessionInMembership: sessions.first,
      lastSessionInMembership: sessions.last,
      marketCapFloor,
      medianDollarVolume: medianDollarVolume(ascending, windows),
    };
    if (sessions.count === 0 || sessions.first === null) {
      // Nothing to identify: the listing is only read for a candidate that could be the history.
      return {
        ...base,
        listingName: null,
        nameSimilarity: 0,
        marketCapAtFirstSession: null,
        marketCapTrusted: null,
        refusal: "NO_PRICES_IN_MEMBERSHIP",
      };
    }
    const listingName = (await this.listingOf(symbol))?.name ?? null;
    const caps = await this.provider.getHistoricalMarketCapitalization(symbol, {
      from: sessions.first,
      to: addDays(sessions.first, MARKET_CAP_LOOKAHEAD_DAYS),
    });
    const marketCap = caps[0]?.marketCap ?? null;
    const plausibility = plausibilityRefusal({
      marketCap,
      marketCapFloor,
      medianDollarVolume: base.medianDollarVolume,
    });
    return {
      ...base,
      listingName,
      nameSimilarity: nameEvidence(constituentName, listingName),
      marketCapAtFirstSession: marketCap,
      marketCapTrusted: plausibility.marketCapTrusted,
      refusal: plausibility.refusal,
    };
  }

  private readonly listingCache = new Map<string, Promise<IndexUniverseListing | null>>();

  /** The candidate's listing: its profile, or else the delisted directory's row for it. */
  private listingOf(symbol: string): Promise<IndexUniverseListing | null> {
    let pending = this.listingCache.get(symbol);
    if (!pending) {
      pending = this.readListing(symbol);
      this.listingCache.set(symbol, pending);
    }
    return pending;
  }

  private async readListing(symbol: string): Promise<IndexUniverseListing | null> {
    const profile = await this.provider.getProfile(symbol);
    if (profile && profile.providerSymbol === symbol) {
      return {
        symbol,
        name: profile.security.name,
        exchangeCode: profile.security.exchangeCode || null,
        isEtf: profile.security.type === "ETF",
        isFund: profile.security.type === "FUND",
        isActivelyTrading: profile.security.isActivelyTrading,
        source: "PROFILE",
      };
    }
    const directory = await this.delistedDirectory();
    const rows = directory.get(symbol) ?? [];
    // The newest delisting under the symbol: the directory reuses symbols across issuers too.
    const row = [...rows].sort((left, right) =>
      (left.delistedDate ?? "") < (right.delistedDate ?? "") ? 1 : -1,
    )[0];
    if (!row || !row.companyName) {
      return null;
    }
    return {
      symbol,
      name: row.companyName,
      exchangeCode: row.exchange,
      isEtf: false,
      isFund: false,
      isActivelyTrading: false,
      source: "DELISTED_DIRECTORY",
    };
  }

  /** The delisted directory, read once per service: concurrent probes share the one read. */
  private delistedDirectory(): Promise<Map<string, MappedFmpDelistedCompany[]>> {
    this.delisted ??= this.readDelistedDirectory().catch((error: unknown) => {
      // A failed read is not remembered: the next listing that needs it asks again.
      this.delisted = undefined;
      throw error;
    });
    return this.delisted;
  }

  private async readDelistedDirectory(): Promise<Map<string, MappedFmpDelistedCompany[]>> {
    const directory = new Map<string, MappedFmpDelistedCompany[]>();
    for (let page = 0; page < DELISTED_DIRECTORY_MAX_PAGES; page += 1) {
      const { providerRowCount, rows } = await this.provider.getDelistedCompanies(page);
      for (const row of rows) {
        directory.set(row.symbol, [...(directory.get(row.symbol) ?? []), row]);
      }
      if (providerRowCount === 0) {
        break;
      }
    }
    return directory;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

/** A probe an earlier, interrupted resolution stored for a still-pending constituent. */
function storedProbe(
  constituent: StoredIndexConstituent,
): ConstituentResolutionDecision | null {
  if (constituent.resolution !== "PENDING") {
    return null;
  }
  const evidence = constituent.resolutionEvidence as { probe?: unknown } | null;
  const probe = evidence?.probe as ConstituentResolutionDecision | undefined;
  return probe && typeof probe.resolution === "string" && Array.isArray(probe.candidates)
    ? probe
    : null;
}

function symbolOfStored(constituent: StoredIndexConstituent): string | null {
  const evidence = constituent.resolutionEvidence as { symbol?: unknown } | null;
  return typeof evidence?.symbol === "string" ? evidence.symbol : null;
}

function storedCoverage(constituent: StoredIndexConstituent): number {
  const evidence = constituent.resolutionEvidence as { coverage?: unknown } | null;
  return typeof evidence?.coverage === "number" ? evidence.coverage : 0;
}

function candidatesOfStored(constituent: StoredIndexConstituent): unknown {
  const evidence = constituent.resolutionEvidence as { candidates?: unknown } | null;
  return evidence?.candidates ?? [];
}

function storedNameSimilarity(constituent: StoredIndexConstituent): number {
  const symbol = symbolOfStored(constituent);
  const candidates = candidatesOfStored(constituent);
  if (!Array.isArray(candidates)) {
    return 0;
  }
  const chosen = candidates.find(
    (candidate: { symbol?: unknown }) => candidate?.symbol === symbol,
  ) as { nameSimilarity?: unknown } | undefined;
  return typeof chosen?.nameSimilarity === "number" ? chosen.nameSimilarity : 0;
}

function countBy<T>(rows: readonly T[], key: (row: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = key(row);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) {
          return;
        }
        await work(items[index] as T);
      }
    },
  );
  await Promise.all(workers);
}

export type { MappedFmpIndexConstituent };
