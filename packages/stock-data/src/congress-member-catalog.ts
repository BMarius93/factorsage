import { isBioguideId, type CongressChamber } from "@intrinsic/domain";
import {
  FmpProviderError,
  type FmpCongressMemberDirectoryPort,
  type MappedFmpCongressMember,
} from "@intrinsic/fmp";

/**
 * The member catalog: who a Congressional rule may select, kept independently of whose disclosures
 * happen to have been loaded (`docs/development/congress-member-catalog.md`).
 *
 * Disclosure ingestion is lazy and per security, so until 2026-10-11 the catalog held only the
 * members some ingested security's disclosures had named: a member could be missing from the
 * picker for no better reason than that nobody had opened a stock they traded. This synchronizes
 * the catalog with the provider's member directory instead — every member in office and every
 * former member the directory lists — so the picker does not depend on trading activity at all.
 *
 * Four rules, each of which is a refusal rather than a best effort:
 *
 * 1. **An identity is a bioguide id and nothing else.** A directory row and a disclosure carry the
 *    same identifier, so a member both sources know is one row with one canonical id. No identity is
 *    ever made from a name, and a directory row whose id is not a bioguide id is declined.
 * 2. **Nothing is ever deleted.** A member the directory stops listing keeps their row, their
 *    canonical id and every strategy, snapshot and Monitor that names them.
 * 3. **The whole directory or nothing.** Every page of both halves is read before anything is
 *    written. A page that fails, an empty half, a filter the provider did not honour or paging that
 *    does not advance fails the run and leaves the catalog exactly as it was; a run is recorded as
 *    complete only when the directory it wrote was whole.
 * 4. **A directory row is an identity, never a trade.** This file writes `AlternativeDataActor`
 *    labels and nothing else: no disclosure, no coverage statement, no dataset state. A member it
 *    adds has no disclosures, and whether a metric is evaluable for a security is still decided by
 *    that security's own ingested coverage — which this cannot reach.
 *
 * **Labels.** A member's displayed name, chamber and state belong to their disclosures once one has
 * been loaded, exactly as before, because ingestion refreshes them on every read and two writers of
 * one label would undo each other. Until then they are the directory's. The directory's spelling is
 * kept beside the label either way (`profileName`), which is what lets a search for "Bill Cassidy"
 * find the senator a disclosure calls "William Cassidy".
 */

/** The singleton state row's id. */
export const CONGRESS_MEMBER_CATALOG_SYNC_ID = "CONGRESS_MEMBERS";

/**
 * The most directory pages one half of one run may read.
 *
 * The directory held 540 members in office and 721 former ones on 2026-10-11, two pages each. This
 * is a bound, not an expectation: it is what stops a provider that never returns an empty page from
 * being asked forever.
 */
export const CONGRESS_MEMBER_DIRECTORY_MAX_PAGES = 20;

/** How long a run holds its claim. A whole run is a handful of requests and one transaction. */
export const CONGRESS_MEMBER_CATALOG_SYNC_LEASE_MS = 10 * 60_000;

/** How many declined rows a result names. The counts are always exact. */
const DECLINED_SAMPLE_SIZE = 25;

/** Why a directory row was not written. */
export const CONGRESS_MEMBER_DECLINE_REASONS = [
  /** The identifier is not a bioguide id, so it cannot be reconciled with a disclosure's. */
  "MALFORMED_ID",
  /** The directory listed the identifier more than once and the rows disagree. */
  "CONFLICTING_ROWS",
  /** The row carries no name to show. */
  "UNNAMED",
  /**
   * The latest position is not a seat in Congress and no disclosure has named them, so there is no
   * chamber to file them under. A former member who became Vice President is the case.
   */
  "NO_CHAMBER",
] as const;

export type CongressMemberDeclineReason =
  (typeof CONGRESS_MEMBER_DECLINE_REASONS)[number];

/** Why a run wrote nothing. */
export const CONGRESS_MEMBER_CATALOG_FAILURE_CODES = [
  /** The provider did not answer a page, after the client's own retries. */
  "PROVIDER_UNAVAILABLE",
  /** A half of the directory came back empty, which the real directory never is. */
  "DIRECTORY_EMPTY",
  /** A row did not belong to the half that was asked for: the filter was not honoured. */
  "DIRECTORY_FILTER_NOT_HONOURED",
  /** A page repeated rows already received instead of advancing. */
  "DIRECTORY_PAGING_NOT_ADVANCING",
  /** A half was still returning rows at the page bound. */
  "DIRECTORY_TOO_LARGE",
  /** The run's claim expired before it could write, so another run may have started. */
  "CLAIM_LOST",
  /** The directory was read whole but could not be written. */
  "WRITE_FAILED",
] as const;

export type CongressMemberCatalogFailureCode =
  (typeof CONGRESS_MEMBER_CATALOG_FAILURE_CODES)[number];

export type CongressMemberCatalogSyncSummary = {
  /** HTTP requests asked of the provider's directory, the final empty page of each half included. */
  providerRequests: number;
  /** Distinct identities the directory held. `created + updated + unchanged + declined`. */
  received: number;
  /** Of `received`, the members the directory lists as in office, and as former. */
  inOffice: number;
  former: number;
  /** Identities the catalog did not hold. */
  created: number;
  /** Identities the catalog held whose directory spelling or label was written. */
  updated: number;
  /**
   * Of `updated`, the ones whose displayed name, chamber or state changed. Only a member no
   * disclosure has named can be among them.
   */
  relabelled: number;
  unchanged: number;
  /** Directory rows that were not written. Explained by `declinedByReason`. */
  declined: number;
  declinedByReason: Record<CongressMemberDeclineReason, number>;
  /** Rows the directory repeated identically. Counted once in `received`. */
  repeatedRows: number;
  /** Catalog identities the directory did not hold. Every one of them is kept. */
  retained: number;
};

export type DeclinedCongressMember = {
  externalId: string;
  reason: CongressMemberDeclineReason;
  /** The provider's own position, where that is what the reason turned on. */
  position?: string;
};

/** The durable state of the synchronization, as the store reads it back. */
export type CongressMemberCatalogSyncState = {
  /** A run holds the claim right now. */
  running: boolean;
  runSequence: number;
  lastStartedAt: string | null;
  /** When the directory was last read whole and written. Null until that has happened. */
  lastCompletedAt: string | null;
  lastFailedAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastSummary: CongressMemberCatalogSyncSummary | null;
};

export type CongressMemberCatalogSyncResult =
  | {
      outcome: "COMPLETED";
      runSequence: number;
      summary: CongressMemberCatalogSyncSummary;
      /** Up to `DECLINED_SAMPLE_SIZE` of the declined rows, by identifier. */
      declined: DeclinedCongressMember[];
    }
  /** The directory was synchronized recently enough for the caller; the provider was not asked. */
  | { outcome: "UP_TO_DATE"; lastCompletedAt: string }
  /** Another run holds the claim; the provider was not asked. */
  | { outcome: "ALREADY_RUNNING" }
  | {
      outcome: "FAILED";
      runSequence: number;
      code: CongressMemberCatalogFailureCode;
      /** A sentence for an operator. Never a provider payload, never a credential. */
      message: string;
      providerRequests: number;
      /** The original error, for the caller's logger. Never sent to a client. */
      cause?: unknown;
    };

/** One catalog identity, as far as a synchronization needs to know it. */
export type CongressMemberCatalogIdentity = {
  externalId: string;
  displayName: string;
  profileName: string | null;
  chamber: CongressChamber;
  state: string | null;
  /** A loaded disclosure names them, so their label is their disclosures' and is left alone. */
  hasDisclosures: boolean;
};

export type CongressMemberCatalogCreate = {
  externalId: string;
  displayName: string;
  profileName: string;
  chamber: CongressChamber;
  state?: string;
};

export type CongressMemberCatalogUpdate = {
  externalId: string;
  /** The directory's spelling, when it is not the one already recorded. */
  profileName?: string;
  /**
   * The directory's label. Applied only while no disclosure names the member — the store re-checks
   * that at write time, so a disclosure ingested during the run wins.
   */
  label?: {
    displayName: string;
    chamber: CongressChamber;
    state: string | null;
  };
};

export type CongressMemberCatalogChanges = {
  create: CongressMemberCatalogCreate[];
  update: CongressMemberCatalogUpdate[];
};

export interface CongressMemberCatalogStore {
  getCatalogSyncState(
    now: Date,
  ): Promise<CongressMemberCatalogSyncState | null>;
  /** Takes the claim, or returns null when a live run holds it. */
  claimCatalogSync(input: {
    owner: string;
    now: Date;
    leaseMs: number;
  }): Promise<{ runSequence: number } | null>;
  /** Extends the claim. False when it is no longer this owner's. */
  renewCatalogSyncClaim(input: {
    owner: string;
    now: Date;
    leaseMs: number;
  }): Promise<boolean>;
  completeCatalogSync(input: {
    owner: string;
    now: Date;
    summary: CongressMemberCatalogSyncSummary;
  }): Promise<boolean>;
  failCatalogSync(input: {
    owner: string;
    now: Date;
    error: string;
  }): Promise<boolean>;
  /** Every identity the catalog holds. A small reference table, read whole. */
  readCatalogIdentities(): Promise<CongressMemberCatalogIdentity[]>;
  /** Writes one run's changes as one transaction: all of them, or none. */
  applyCatalogChanges(
    changes: CongressMemberCatalogChanges,
  ): Promise<{ created: number; updated: number; relabelled: number }>;
}

export type CongressMemberCatalogSyncOptions = {
  /**
   * Do nothing when the directory was synchronized completely within this long. What makes the
   * command safe to run on every deploy: a fresh catalog costs no provider request.
   */
  unlessCompletedWithinMs?: number;
};

/**
 * The synchronization boundary. The API depends on this rather than on the concrete service so
 * logging can decorate it, exactly as `SecurityCatalogService` is decorated.
 */
export interface CongressMemberCatalogService {
  sync(
    options?: CongressMemberCatalogSyncOptions,
  ): Promise<CongressMemberCatalogSyncResult>;
  state(): Promise<CongressMemberCatalogSyncState | null>;
}

class DirectoryRefusedError extends Error {
  constructor(
    readonly code: CongressMemberCatalogFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "DirectoryRefusedError";
  }
}

/** One distinct identity read from the directory, with every row that named it. */
type DirectoryEntry = {
  member: MappedFmpCongressMember;
  inOffice: boolean;
  conflicting: boolean;
};

type DirectoryRead = {
  entries: Map<string, DirectoryEntry>;
  providerRequests: number;
  repeatedRows: number;
};

function sameMember(
  left: MappedFmpCongressMember,
  right: MappedFmpCongressMember,
): boolean {
  return (
    left.name === right.name &&
    left.chamber === right.chamber &&
    left.positionRaw === right.positionRaw &&
    left.state === right.state &&
    left.inOffice === right.inOffice
  );
}

function emptyDeclinedByReason(): Record<CongressMemberDeclineReason, number> {
  return Object.fromEntries(
    CONGRESS_MEMBER_DECLINE_REASONS.map((reason) => [reason, 0]),
  ) as Record<CongressMemberDeclineReason, number>;
}

export type CongressMemberCatalogPlan = {
  changes: CongressMemberCatalogChanges;
  unchanged: number;
  declined: DeclinedCongressMember[];
  retained: number;
};

/**
 * Decides what one whole directory changes in the catalog. Pure: no clock, no I/O.
 *
 * Every distinct identity the directory held ends in exactly one of `create`, `update`, unchanged
 * or declined, which is what makes a run's counts add up to what was received.
 */
export function planCongressMemberCatalog(
  directory: ReadonlyMap<
    string,
    { member: MappedFmpCongressMember; conflicting: boolean }
  >,
  catalog: readonly CongressMemberCatalogIdentity[],
): CongressMemberCatalogPlan {
  const existing = new Map(
    catalog.map((identity) => [identity.externalId, identity]),
  );
  const changes: CongressMemberCatalogChanges = { create: [], update: [] };
  const declined: DeclinedCongressMember[] = [];
  let unchanged = 0;

  // In identifier order, so two runs over one directory plan — and write — identically.
  const ordered = [...directory.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [externalId, { member, conflicting }] of ordered) {
    if (!isBioguideId(externalId)) {
      declined.push({ externalId, reason: "MALFORMED_ID" });
      continue;
    }
    if (conflicting) {
      declined.push({ externalId, reason: "CONFLICTING_ROWS" });
      continue;
    }
    if (!member.name) {
      declined.push({ externalId, reason: "UNNAMED" });
      continue;
    }

    const known = existing.get(externalId);
    if (!known) {
      if (!member.chamber) {
        declined.push({
          externalId,
          reason: "NO_CHAMBER",
          ...(member.positionRaw ? { position: member.positionRaw } : {}),
        });
        continue;
      }
      changes.create.push({
        externalId,
        displayName: member.name,
        profileName: member.name,
        chamber: member.chamber,
        // A state is read only beside a seat: the directory files a Vice President under `US`.
        ...(member.state ? { state: member.state } : {}),
      });
      continue;
    }

    const update: CongressMemberCatalogUpdate = { externalId };
    if (known.profileName !== member.name) {
      update.profileName = member.name;
    }
    // A member a disclosure has named keeps the label their disclosures gave them. So does one
    // whose latest position is outside Congress: there is no chamber to relabel them with.
    if (!known.hasDisclosures && member.chamber) {
      const state = member.state ?? null;
      if (
        known.displayName !== member.name ||
        known.chamber !== member.chamber ||
        known.state !== state
      ) {
        update.label = {
          displayName: member.name,
          chamber: member.chamber,
          state,
        };
      }
    }
    if (update.profileName === undefined && update.label === undefined) {
      unchanged += 1;
      continue;
    }
    changes.update.push(update);
  }

  const retained = catalog.filter(
    (identity) => !directory.has(identity.externalId),
  ).length;
  return { changes, unchanged, declined, retained };
}

export class CanonicalCongressMemberCatalogService implements CongressMemberCatalogService {
  private readonly now: () => Date;
  private readonly owner: string;
  private readonly leaseMs: number;

  constructor(
    private readonly store: CongressMemberCatalogStore,
    private readonly provider: FmpCongressMemberDirectoryPort,
    options: {
      /** Names this process's claim. Two services must not share one. */
      owner: string;
      now?: () => Date;
      leaseMs?: number;
    },
  ) {
    this.owner = options.owner;
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? CONGRESS_MEMBER_CATALOG_SYNC_LEASE_MS;
  }

  state(): Promise<CongressMemberCatalogSyncState | null> {
    return this.store.getCatalogSyncState(this.now());
  }

  async sync(
    options: CongressMemberCatalogSyncOptions = {},
  ): Promise<CongressMemberCatalogSyncResult> {
    if (options.unlessCompletedWithinMs !== undefined) {
      const state = await this.store.getCatalogSyncState(this.now());
      if (
        state?.lastCompletedAt &&
        this.now().getTime() - Date.parse(state.lastCompletedAt) <
          options.unlessCompletedWithinMs
      ) {
        return {
          outcome: "UP_TO_DATE",
          lastCompletedAt: state.lastCompletedAt,
        };
      }
    }

    const claim = await this.store.claimCatalogSync({
      owner: this.owner,
      now: this.now(),
      leaseMs: this.leaseMs,
    });
    if (!claim) {
      return { outcome: "ALREADY_RUNNING" };
    }

    let providerRequests = 0;
    const fail = async (
      code: CongressMemberCatalogFailureCode,
      message: string,
      cause?: unknown,
    ): Promise<CongressMemberCatalogSyncResult> => {
      await this.store.failCatalogSync({
        owner: this.owner,
        now: this.now(),
        error: `${code}: ${message}`,
      });
      return {
        outcome: "FAILED",
        runSequence: claim.runSequence,
        code,
        message,
        providerRequests,
        ...(cause === undefined ? {} : { cause }),
      };
    };

    let directory: DirectoryRead;
    try {
      directory = await this.readDirectory((requests) => {
        providerRequests = requests;
      });
    } catch (error) {
      if (error instanceof DirectoryRefusedError) {
        return fail(error.code, error.message);
      }
      // The class and status say what happened, and the message is the client's own fixed text.
      // A response body is never carried into the stored reason.
      return fail(
        "PROVIDER_UNAVAILABLE",
        error instanceof FmpProviderError
          ? `${error.name}${error.statusCode ? ` (HTTP ${error.statusCode})` : ""}: ${error.message}`
          : "The directory could not be read",
        error,
      );
    }

    // Reading can take as long as the provider makes it. The claim is re-asserted before anything
    // is written, so a run that outlived its lease never writes beside the run that replaced it.
    const stillClaimed = await this.store.renewCatalogSyncClaim({
      owner: this.owner,
      now: this.now(),
      leaseMs: this.leaseMs,
    });
    if (!stillClaimed) {
      return {
        outcome: "FAILED",
        runSequence: claim.runSequence,
        code: "CLAIM_LOST",
        message:
          "The run's claim expired while the directory was being read; nothing was written",
        providerRequests,
      };
    }

    let plan: CongressMemberCatalogPlan;
    let written: { created: number; updated: number; relabelled: number };
    try {
      plan = planCongressMemberCatalog(
        directory.entries,
        await this.store.readCatalogIdentities(),
      );
      written = await this.store.applyCatalogChanges(plan.changes);
    } catch (error) {
      return fail(
        "WRITE_FAILED",
        "The directory was read whole but could not be written; the catalog is unchanged",
        error,
      );
    }

    const declinedByReason = emptyDeclinedByReason();
    for (const entry of plan.declined) {
      declinedByReason[entry.reason] += 1;
    }
    const entries = [...directory.entries.values()];
    const summary: CongressMemberCatalogSyncSummary = {
      providerRequests,
      received: directory.entries.size,
      inOffice: entries.filter((entry) => entry.inOffice).length,
      former: entries.filter((entry) => !entry.inOffice).length,
      created: written.created,
      updated: written.updated,
      relabelled: written.relabelled,
      // Whatever the plan meant to write and the store found already written — a member a
      // concurrent ingest created first — is unchanged, so the counts still add up to `received`.
      unchanged:
        directory.entries.size -
        plan.declined.length -
        written.created -
        written.updated,
      declined: plan.declined.length,
      declinedByReason,
      repeatedRows: directory.repeatedRows,
      retained: plan.retained,
    };

    await this.store.completeCatalogSync({
      owner: this.owner,
      now: this.now(),
      summary,
    });
    return {
      outcome: "COMPLETED",
      runSequence: claim.runSequence,
      summary,
      declined: plan.declined.slice(0, DECLINED_SAMPLE_SIZE),
    };
  }

  /**
   * Reads both halves of the directory, every page of each.
   *
   * A half ends at its first **empty** page, never at a short one: the provider's page size is a
   * fact about today, and a walk that stopped at "fewer rows than the cap" would silently truncate
   * the directory the day the cap was lowered. The price is one extra request per half.
   */
  private async readDirectory(
    onRequest: (requests: number) => void,
  ): Promise<DirectoryRead> {
    const entries = new Map<string, DirectoryEntry>();
    let providerRequests = 0;
    let repeatedRows = 0;

    for (const inOffice of [true, false]) {
      const half = inOffice ? "members in office" : "former members";
      const seenInHalf = new Set<string>();
      let ended = false;
      for (
        let page = 0;
        page < CONGRESS_MEMBER_DIRECTORY_MAX_PAGES;
        page += 1
      ) {
        providerRequests += 1;
        onRequest(providerRequests);
        const result = await this.provider.getCongressMemberProfiles({
          inOffice,
          page,
        });
        if (result.providerRowCount === 0) {
          ended = true;
          break;
        }

        let advanced = false;
        for (const member of result.rows) {
          // Held to the half that was asked for. A row that says otherwise — or says nothing —
          // means the filter is not doing what this walk relies on, and the two halves can no
          // longer be told apart or known to be whole.
          if (member.inOffice !== inOffice) {
            throw new DirectoryRefusedError(
              "DIRECTORY_FILTER_NOT_HONOURED",
              `The directory was asked for ${half} and page ${page} held a row that is not one`,
            );
          }
          if (!seenInHalf.has(member.externalId)) {
            seenInHalf.add(member.externalId);
            advanced = true;
          }
          const known = entries.get(member.externalId);
          if (!known) {
            entries.set(member.externalId, {
              member,
              inOffice,
              conflicting: false,
            });
          } else if (sameMember(known.member, member)) {
            repeatedRows += 1;
          } else {
            known.conflicting = true;
          }
        }
        if (!advanced && result.rows.length > 0) {
          throw new DirectoryRefusedError(
            "DIRECTORY_PAGING_NOT_ADVANCING",
            `Page ${page} of the ${half} repeated rows already received instead of advancing`,
          );
        }
      }
      if (!ended) {
        throw new DirectoryRefusedError(
          "DIRECTORY_TOO_LARGE",
          `The ${half} were still being returned after ${CONGRESS_MEMBER_DIRECTORY_MAX_PAGES} pages`,
        );
      }
      if (seenInHalf.size === 0) {
        throw new DirectoryRefusedError(
          "DIRECTORY_EMPTY",
          `The directory returned no ${half}`,
        );
      }
    }
    return { entries, providerRequests, repeatedRows };
  }
}
