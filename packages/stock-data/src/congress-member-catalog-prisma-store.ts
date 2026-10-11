import {
  CongressChamber as CongressChamberEnum,
  type Prisma,
  type PrismaClient,
} from "@intrinsic/database";
import type { CongressChamber } from "@intrinsic/domain";
import {
  CONGRESS_MEMBER_CATALOG_SYNC_ID,
  type CongressMemberCatalogChanges,
  type CongressMemberCatalogIdentity,
  type CongressMemberCatalogStore,
  type CongressMemberCatalogSyncState,
  type CongressMemberCatalogSyncSummary,
} from "./congress-member-catalog.js";

/** Bind-parameter-safe chunk for a bulk insert of new identities. */
const CREATE_CHUNK = 500;

/**
 * How long the one write transaction may take.
 *
 * A first synchronization inserts about a thousand rows and labels a few hundred; every later one
 * writes only what moved. Generous, because a transaction that times out writes nothing and the run
 * is simply reported as failed.
 */
const WRITE_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * PostgreSQL persistence for the member catalog's synchronization.
 *
 * It writes `AlternativeDataActor` labels and its own state row, and nothing else: no disclosure,
 * no dataset state, no group. Three properties, each implemented once here:
 *
 * 1. **The claim is the durable-claim idiom** `MonitorScanSchedule` and `MarketDataRefreshSchedule`
 *    use (`AGENTS.md` invariant 15): one singleton row, `SELECT … FOR UPDATE SKIP LOCKED`, a lease,
 *    and every write after the claim guarded on `claimedBy`. It is not a schedule — nothing here is
 *    ever due — only the part of the idiom that makes two runs impossible.
 * 2. **A run's changes are one transaction.** A failure part-way leaves the catalog exactly as it
 *    was rather than half-labelled.
 * 3. **It only adds and labels.** There is no delete in this file. An insert that finds the
 *    identity already there — a disclosure was ingested first — is skipped, and its canonical id is
 *    the one ingestion gave it.
 */
export class PrismaCongressMemberCatalogStore implements CongressMemberCatalogStore {
  constructor(
    private readonly prisma: PrismaClient,
    /**
     * The state row this store claims. Every composition uses the default, which is what makes the
     * claim exclusive across processes; a test names its own so suites sharing one database do not
     * hold each other's claim.
     */
    private readonly syncId: string = CONGRESS_MEMBER_CATALOG_SYNC_ID,
  ) {}

  async getCatalogSyncState(
    now: Date,
  ): Promise<CongressMemberCatalogSyncState | null> {
    const row = await this.prisma.congressMemberCatalogSync.findUnique({
      where: { id: this.syncId },
    });
    if (!row) {
      return null;
    }
    return {
      // A claim whose lease has run out is a run that died, not a run in progress.
      running:
        row.claimedBy !== null &&
        row.leaseExpiresAt !== null &&
        row.leaseExpiresAt.getTime() >= now.getTime(),
      runSequence: row.runSequence,
      lastStartedAt: row.lastStartedAt?.toISOString() ?? null,
      lastCompletedAt: row.lastCompletedAt?.toISOString() ?? null,
      lastFailedAt: row.lastFailedAt?.toISOString() ?? null,
      consecutiveFailures: row.consecutiveFailures,
      lastError: row.lastError,
      lastSummary:
        (row.lastSummary as CongressMemberCatalogSyncSummary | null) ?? null,
    };
  }

  async claimCatalogSync(input: {
    owner: string;
    now: Date;
    leaseMs: number;
  }): Promise<{ runSequence: number } | null> {
    const { owner, now } = input;
    const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
    // `ON CONFLICT DO NOTHING`: the first two runs ever may start together, and the loser of that
    // race must find the row rather than fail on it.
    await this.prisma.$executeRaw`
      INSERT INTO "CongressMemberCatalogSync" ("id", "updatedAt")
      VALUES (${this.syncId}, ${now})
      ON CONFLICT ("id") DO NOTHING
    `;
    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "CongressMemberCatalogSync"
        WHERE "id" = ${this.syncId}
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${now})
        FOR UPDATE SKIP LOCKED
      `;
      if (!candidates[0]) {
        return null;
      }
      const claimed = await tx.$queryRaw<{ runSequence: number }[]>`
        UPDATE "CongressMemberCatalogSync"
        SET "claimedBy" = ${owner},
            "claimedAt" = ${now},
            "leaseExpiresAt" = ${leaseExpiresAt},
            "lastStartedAt" = ${now},
            "runSequence" = "runSequence" + 1,
            "updatedAt" = ${now}
        WHERE "id" = ${this.syncId}
        RETURNING "runSequence"
      `;
      const row = claimed[0];
      return row ? { runSequence: row.runSequence } : null;
    });
  }

  async renewCatalogSyncClaim(input: {
    owner: string;
    now: Date;
    leaseMs: number;
  }): Promise<boolean> {
    const renewed = await this.prisma.congressMemberCatalogSync.updateMany({
      where: {
        id: this.syncId,
        claimedBy: input.owner,
        // An expired lease is not renewed: by then another run may have been entitled to start.
        leaseExpiresAt: { gte: input.now },
      },
      data: {
        leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
      },
    });
    return renewed.count === 1;
  }

  async completeCatalogSync(input: {
    owner: string;
    now: Date;
    summary: CongressMemberCatalogSyncSummary;
  }): Promise<boolean> {
    const completed = await this.prisma.congressMemberCatalogSync.updateMany({
      where: { id: this.syncId, claimedBy: input.owner },
      data: {
        claimedBy: null,
        claimedAt: null,
        leaseExpiresAt: null,
        lastCompletedAt: input.now,
        consecutiveFailures: 0,
        lastError: null,
        lastSummary: input.summary as unknown as Prisma.InputJsonValue,
      },
    });
    return completed.count === 1;
  }

  async failCatalogSync(input: {
    owner: string;
    now: Date;
    error: string;
  }): Promise<boolean> {
    // `lastCompletedAt` and `lastSummary` are deliberately untouched: a failed run changes nothing
    // about what the last complete one wrote, and the picker keeps describing that.
    const failed = await this.prisma.congressMemberCatalogSync.updateMany({
      where: { id: this.syncId, claimedBy: input.owner },
      data: {
        claimedBy: null,
        claimedAt: null,
        leaseExpiresAt: null,
        lastFailedAt: input.now,
        consecutiveFailures: { increment: 1 },
        lastError: input.error,
      },
    });
    return failed.count === 1;
  }

  async readCatalogIdentities(): Promise<CongressMemberCatalogIdentity[]> {
    const rows = await this.prisma.alternativeDataActor.findMany({
      select: {
        externalId: true,
        displayName: true,
        profileName: true,
        chamber: true,
        state: true,
        // One row is enough to know a disclosure names them.
        congressTrades: { select: { id: true }, take: 1 },
      },
      orderBy: { externalId: "asc" },
    });
    return rows.map((row) => ({
      externalId: row.externalId,
      displayName: row.displayName,
      profileName: row.profileName,
      chamber: row.chamber as CongressChamber,
      state: row.state,
      hasDisclosures: row.congressTrades.length > 0,
    }));
  }

  async applyCatalogChanges(
    changes: CongressMemberCatalogChanges,
  ): Promise<{ created: number; updated: number; relabelled: number }> {
    if (changes.create.length === 0 && changes.update.length === 0) {
      return { created: 0, updated: 0, relabelled: 0 };
    }
    return this.prisma.$transaction(
      async (tx) => {
        let created = 0;
        for (
          let start = 0;
          start < changes.create.length;
          start += CREATE_CHUNK
        ) {
          const inserted = await tx.alternativeDataActor.createMany({
            data: changes.create
              .slice(start, start + CREATE_CHUNK)
              .map((member) => ({
                externalId: member.externalId,
                displayName: member.displayName,
                profileName: member.profileName,
                chamber: CongressChamberEnum[member.chamber],
                ...(member.state ? { state: member.state } : {}),
              })),
            // An identity a disclosure created while this run was reading keeps the row — and the
            // canonical id — ingestion gave it.
            skipDuplicates: true,
          });
          created += inserted.count;
        }

        let updated = 0;
        let relabelled = 0;
        for (const update of changes.update) {
          let wrote = false;
          if (update.profileName !== undefined) {
            const named = await tx.alternativeDataActor.updateMany({
              where: { externalId: update.externalId },
              data: { profileName: update.profileName },
            });
            wrote = named.count === 1;
          }
          if (update.label) {
            // Guarded in the statement itself, not only in the plan: a disclosure ingested since
            // the catalog was read has already labelled this member, and it wins.
            const labelled = await tx.alternativeDataActor.updateMany({
              where: {
                externalId: update.externalId,
                congressTrades: { none: {} },
              },
              data: {
                displayName: update.label.displayName,
                chamber: CongressChamberEnum[update.label.chamber],
                state: update.label.state,
              },
            });
            if (labelled.count === 1) {
              relabelled += 1;
              wrote = true;
            }
          }
          if (wrote) {
            updated += 1;
          }
        }
        return { created, updated, relabelled };
      },
      { timeout: WRITE_TRANSACTION_TIMEOUT_MS },
    );
  }
}
