import {
  IndexConstituentResolution as ResolutionEnum,
  IndexMembershipPeriodQuality as QualityEnum,
  IndexMembershipSyncStatus,
  MarketIndexKey as MarketIndexKeyEnum,
  type Prisma,
  type PrismaClient,
} from "@intrinsic/database";
import type {
  IndexConstituentResolution,
  IndexMembershipPeriodQuality,
  LocalDate,
  MarketIndexKey,
} from "@intrinsic/domain";
import type {
  ConstituentResolutionWrite,
  IndexMembershipStore,
  IndexMembershipSyncRecord,
  ReplaceConstituentsOutcome,
  SourceRecordOutcome,
  StoredIndexChange,
  StoredIndexConstituent,
  StoredMembershipPeriod,
  StoredSymbolChange,
} from "./ports.js";
import type {
  ConstituentOrigin,
  ReconstructedConstituent,
  TickerSpan,
} from "./reconstruction.js";

/** Rows per bulk statement: comfortably inside PostgreSQL's bind-parameter limit. */
const CHUNK = 500;

/** One synchronization writes a few thousand rows in one transaction. */
const WRITE_TRANSACTION_TIMEOUT_MS = 120_000;

const toDate = (value: LocalDate): Date => new Date(`${value}T00:00:00.000Z`);
const fromDate = (value: Date): LocalDate => value.toISOString().slice(0, 10);
const optionalDate = (value: LocalDate | null): Date | null =>
  value === null ? null : toDate(value);
const optionalLocal = (value: Date | null): LocalDate | null =>
  value === null ? null : fromDate(value);

function chunks<T>(rows: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += CHUNK) {
    result.push(rows.slice(offset, offset + CHUNK));
  }
  return result;
}

/**
 * The comparable content of a constituent: what, if it changes, means its resolution must be redone.
 * Periods are compared on their dates and quality, tickers on their spans.
 */
function signatureOf(input: {
  ticker: string;
  name: string;
  tickerHistory: readonly TickerSpan[];
  periods: readonly Pick<
    StoredMembershipPeriod,
    "startDate" | "endDate" | "quality"
  >[];
}): string {
  return JSON.stringify([
    input.ticker,
    input.name,
    input.tickerHistory.map((span) => [span.ticker, span.from, span.to]),
    input.periods.map((period) => [
      period.startDate,
      period.endDate,
      period.quality,
    ]),
  ]);
}

/**
 * PostgreSQL persistence of the point-in-time membership dataset
 * (`docs/decisions/sp500-historical-pit-v1.md` §3).
 *
 * The provider's source rows are content-addressed and append-only: a row seen again is confirmed,
 * a row the provider stopped listing is kept and marked, and nothing here ever deletes one. The
 * reconstruction's output, by contrast, is replaced whole in one transaction: it is derived from the
 * source, and a half-replaced membership would be a membership nobody computed.
 */
export class PrismaIndexMembershipStore implements IndexMembershipStore {
  constructor(private readonly prisma: PrismaClient) {}

  async recordIndexChanges(
    indexKey: MarketIndexKey,
    rows: readonly StoredIndexChange[],
    seenAt: Date,
  ): Promise<SourceRecordOutcome> {
    const key = indexKeyOf(indexKey);
    return this.prisma.$transaction(
      async (tx) => {
        const existing = new Set(
          (
            await tx.indexConstituentChange.findMany({
              where: { indexKey: key },
              select: { contentHash: true },
            })
          ).map((row) => row.contentHash),
        );
        const unique = new Map(rows.map((row) => [row.contentHash, row]));
        const seen = [...unique.keys()];
        const fresh = [...unique.values()].filter(
          (row) => !existing.has(row.contentHash),
        );
        for (const batch of chunks(fresh)) {
          await tx.indexConstituentChange.createMany({
            data: batch.map((row) => ({
              indexKey: key,
              effectiveDate: toDate(row.effectiveDate),
              changeType: row.changeType,
              addedTicker: row.addedTicker,
              addedName: row.addedName,
              removedTicker: row.removedTicker,
              removedName: row.removedName,
              reason: row.reason,
              providerDateText: row.providerDateText,
              contentHash: row.contentHash,
              lastSeenAt: seenAt,
            })),
            skipDuplicates: true,
          });
        }
        let confirmed = 0;
        for (const batch of chunks(seen.filter((hash) => existing.has(hash)))) {
          confirmed += (
            await tx.indexConstituentChange.updateMany({
              where: { indexKey: key, contentHash: { in: batch } },
              data: { lastSeenAt: seenAt, inLatestSource: true },
            })
          ).count;
        }
        const retired = (
          await tx.indexConstituentChange.updateMany({
            where: {
              indexKey: key,
              inLatestSource: true,
              contentHash: { notIn: seen },
            },
            data: { inLatestSource: false },
          })
        ).count;
        return { inserted: fresh.length, confirmed, retired };
      },
      { timeout: WRITE_TRANSACTION_TIMEOUT_MS },
    );
  }

  async recordSymbolChanges(
    rows: readonly StoredSymbolChange[],
    seenAt: Date,
  ): Promise<SourceRecordOutcome> {
    return this.prisma.$transaction(
      async (tx) => {
        const existing = new Set(
          (
            await tx.symbolChangeRecord.findMany({
              select: { contentHash: true },
            })
          ).map((row) => row.contentHash),
        );
        const unique = new Map(rows.map((row) => [row.contentHash, row]));
        const fresh = [...unique.values()].filter(
          (row) => !existing.has(row.contentHash),
        );
        for (const batch of chunks(fresh)) {
          await tx.symbolChangeRecord.createMany({
            data: batch.map((row) => ({
              changeDate: toDate(row.date),
              oldSymbol: row.oldSymbol,
              newSymbol: row.newSymbol,
              companyName: row.companyName,
              contentHash: row.contentHash,
              lastSeenAt: seenAt,
            })),
            skipDuplicates: true,
          });
        }
        const seen = [...unique.keys()];
        let confirmed = 0;
        for (const batch of chunks(seen.filter((hash) => existing.has(hash)))) {
          confirmed += (
            await tx.symbolChangeRecord.updateMany({
              where: { contentHash: { in: batch } },
              data: { lastSeenAt: seenAt, inLatestSource: true },
            })
          ).count;
        }
        const retired = (
          await tx.symbolChangeRecord.updateMany({
            where: { inLatestSource: true, contentHash: { notIn: seen } },
            data: { inLatestSource: false },
          })
        ).count;
        return { inserted: fresh.length, confirmed, retired };
      },
      { timeout: WRITE_TRANSACTION_TIMEOUT_MS },
    );
  }

  async loadIndexChanges(indexKey: MarketIndexKey): Promise<StoredIndexChange[]> {
    const rows = await this.prisma.indexConstituentChange.findMany({
      where: { indexKey: indexKeyOf(indexKey), inLatestSource: true },
      orderBy: [{ effectiveDate: "asc" }, { contentHash: "asc" }],
    });
    return rows.map((row) => ({
      contentHash: row.contentHash,
      effectiveDate: fromDate(row.effectiveDate),
      changeType: row.changeType,
      addedTicker: row.addedTicker,
      addedName: row.addedName,
      removedTicker: row.removedTicker,
      removedName: row.removedName,
      reason: row.reason,
      providerDateText: row.providerDateText,
    }));
  }

  async loadSymbolChanges(): Promise<StoredSymbolChange[]> {
    const rows = await this.prisma.symbolChangeRecord.findMany({
      where: { inLatestSource: true },
      orderBy: [{ changeDate: "asc" }, { contentHash: "asc" }],
    });
    return rows.map((row) => ({
      contentHash: row.contentHash,
      date: fromDate(row.changeDate),
      oldSymbol: row.oldSymbol,
      newSymbol: row.newSymbol,
      companyName: row.companyName,
    }));
  }

  async startSync(
    indexKey: MarketIndexKey,
    algorithmVersion: number,
  ): Promise<string> {
    const row = await this.prisma.indexMembershipSync.create({
      data: { indexKey: indexKeyOf(indexKey), algorithmVersion },
      select: { id: true },
    });
    return row.id;
  }

  async completeSync(
    syncId: string,
    result: { sourceDigest: string; currentConstituents: unknown; summary: unknown },
  ): Promise<void> {
    await this.prisma.indexMembershipSync.update({
      where: { id: syncId },
      data: {
        status: IndexMembershipSyncStatus.COMPLETED,
        completedAt: new Date(),
        sourceDigest: result.sourceDigest,
        currentConstituents: result.currentConstituents as Prisma.InputJsonValue,
        summary: result.summary as Prisma.InputJsonValue,
      },
    });
  }

  async failSync(syncId: string, error: string): Promise<void> {
    await this.prisma.indexMembershipSync.update({
      where: { id: syncId },
      data: {
        status: IndexMembershipSyncStatus.FAILED,
        completedAt: new Date(),
        error: error.slice(0, 2_000),
      },
    });
  }

  async latestCompletedSync(
    indexKey: MarketIndexKey,
  ): Promise<IndexMembershipSyncRecord | null> {
    const row = await this.prisma.indexMembershipSync.findFirst({
      where: {
        indexKey: indexKeyOf(indexKey),
        status: IndexMembershipSyncStatus.COMPLETED,
      },
      orderBy: { completedAt: "desc" },
    });
    return row
      ? {
          id: row.id,
          indexKey,
          completedAt: row.completedAt,
          sourceDigest: row.sourceDigest,
          summary: row.summary,
        }
      : null;
  }

  async amendSyncSummary(
    syncId: string,
    section: string,
    value: unknown,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.indexMembershipSync.findUniqueOrThrow({
        where: { id: syncId },
        select: { summary: true },
      });
      const summary =
        row.summary && typeof row.summary === "object" && !Array.isArray(row.summary)
          ? (row.summary as Record<string, unknown>)
          : {};
      await tx.indexMembershipSync.update({
        where: { id: syncId },
        data: {
          summary: { ...summary, [section]: value } as Prisma.InputJsonValue,
        },
      });
    });
  }

  async replaceConstituents(
    indexKey: MarketIndexKey,
    syncId: string,
    constituents: readonly ReconstructedConstituent[],
  ): Promise<ReplaceConstituentsOutcome> {
    const key = indexKeyOf(indexKey);
    return this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.indexConstituent.findMany({
          where: { indexKey: key },
          include: { periods: true },
        });
        const byKey = new Map(existing.map((row) => [row.constituentKey, row]));
        let created = 0;
        let changed = 0;
        let unchanged = 0;

        const fresh = constituents.filter(
          (constituent) => !byKey.has(constituent.constituentKey),
        );
        for (const batch of chunks(fresh)) {
          await tx.indexConstituent.createMany({
            data: batch.map((constituent) => ({
              indexKey: key,
              constituentKey: constituent.constituentKey,
              origin: constituent.origin,
              ticker: constituent.ticker,
              name: constituent.name,
              cik: constituent.cik,
              tickerHistory: constituent.tickerHistory as unknown as Prisma.InputJsonValue,
              syncId,
            })),
          });
          created += batch.length;
        }

        for (const constituent of constituents) {
          const previous = byKey.get(constituent.constituentKey);
          if (!previous) {
            continue;
          }
          const same =
            signatureOf(constituent) ===
            signatureOf({
              ticker: previous.ticker,
              name: previous.name,
              tickerHistory: previous.tickerHistory as unknown as TickerSpan[],
              periods: previous.periods
                .map(toStoredPeriod)
                .sort(comparePeriods),
            });
          if (same) {
            unchanged += 1;
            await tx.indexConstituent.update({
              where: { id: previous.id },
              data: { syncId, origin: constituent.origin, cik: constituent.cik },
            });
          } else {
            changed += 1;
            await tx.indexConstituent.update({
              where: { id: previous.id },
              data: {
                syncId,
                origin: constituent.origin,
                ticker: constituent.ticker,
                name: constituent.name,
                cik: constituent.cik,
                tickerHistory: constituent.tickerHistory as unknown as Prisma.InputJsonValue,
                securityId: null,
                resolution: ResolutionEnum.PENDING,
                // Evidence of a membership that no longer exists would mislead; this says why the
                // resolution starts over instead.
                resolutionEvidence: {
                  pending: "MEMBERSHIP_CHANGED",
                  syncId,
                } as Prisma.InputJsonValue,
                resolvedAt: null,
              },
            });
          }
        }

        const keep = new Set(constituents.map((entry) => entry.constituentKey));
        const removedIds = existing
          .filter((row) => !keep.has(row.constituentKey))
          .map((row) => row.id);
        for (const batch of chunks(removedIds)) {
          await tx.indexConstituent.deleteMany({ where: { id: { in: batch } } });
        }

        // Periods are derived and replaced whole.
        const ids = new Map(
          (
            await tx.indexConstituent.findMany({
              where: { indexKey: key },
              select: { id: true, constituentKey: true },
            })
          ).map((row) => [row.constituentKey, row.id]),
        );
        await tx.indexMembershipPeriod.deleteMany({
          where: { constituent: { indexKey: key } },
        });
        const periods = constituents.flatMap((constituent) =>
          constituent.periods.map((period) => ({
            constituentId: ids.get(constituent.constituentKey) as string,
            startDate: optionalDate(period.startDate),
            startLogDate: optionalDate(period.startLogDate),
            endDate: optionalDate(period.endDate),
            endLogDate: optionalDate(period.endLogDate),
            quality: qualityOf(period.quality),
            startChangeHash: period.startChangeHash,
            endChangeHash: period.endChangeHash,
            startMatch: period.startMatch,
          })),
        );
        for (const batch of chunks(periods)) {
          await tx.indexMembershipPeriod.createMany({ data: batch });
        }
        return { created, changed, unchanged, removed: removedIds.length };
      },
      { timeout: WRITE_TRANSACTION_TIMEOUT_MS },
    );
  }

  async loadConstituents(
    indexKey: MarketIndexKey,
  ): Promise<StoredIndexConstituent[]> {
    const rows = await this.prisma.indexConstituent.findMany({
      where: { indexKey: indexKeyOf(indexKey) },
      include: { periods: true },
      orderBy: { constituentKey: "asc" },
    });
    return rows.map((row) => ({
      id: row.id,
      constituentKey: row.constituentKey,
      origin: row.origin as ConstituentOrigin,
      ticker: row.ticker,
      name: row.name,
      cik: row.cik,
      tickerHistory: row.tickerHistory as unknown as TickerSpan[],
      securityId: row.securityId,
      resolution: row.resolution as IndexConstituentResolution,
      resolutionEvidence: row.resolutionEvidence,
      periods: row.periods.map(toStoredPeriod).sort(comparePeriods),
    }));
  }

  async saveProbe(
    indexKey: MarketIndexKey,
    constituentKey: string,
    probe: unknown,
  ): Promise<void> {
    await this.prisma.indexConstituent.updateMany({
      where: {
        indexKey: indexKeyOf(indexKey),
        constituentKey,
        resolution: ResolutionEnum.PENDING,
      },
      data: { resolutionEvidence: { probe } as Prisma.InputJsonValue },
    });
  }

  async saveResolutions(
    indexKey: MarketIndexKey,
    writes: readonly ConstituentResolutionWrite[],
    resolvedAt: Date,
  ): Promise<void> {
    const key = indexKeyOf(indexKey);
    await this.prisma.$transaction(
      async (tx) => {
        for (const write of writes) {
          await tx.indexConstituent.update({
            where: {
              indexKey_constituentKey: {
                indexKey: key,
                constituentKey: write.constituentKey,
              },
            },
            data: {
              securityId: write.securityId,
              resolution: write.resolution as ResolutionEnum,
              resolutionEvidence: write.evidence as Prisma.InputJsonValue,
              resolvedAt,
            },
          });
        }
      },
      { timeout: WRITE_TRANSACTION_TIMEOUT_MS },
    );
  }
}

function toStoredPeriod(row: {
  startDate: Date | null;
  startLogDate: Date | null;
  endDate: Date | null;
  endLogDate: Date | null;
  quality: string;
  startChangeHash: string | null;
  endChangeHash: string | null;
  startMatch: string | null;
}): StoredMembershipPeriod {
  return {
    startDate: optionalLocal(row.startDate),
    startLogDate: optionalLocal(row.startLogDate),
    endDate: optionalLocal(row.endDate),
    endLogDate: optionalLocal(row.endLogDate),
    quality: row.quality as IndexMembershipPeriodQuality,
    startChangeHash: row.startChangeHash,
    endChangeHash: row.endChangeHash,
    startMatch: row.startMatch,
  };
}

function comparePeriods(
  left: Pick<StoredMembershipPeriod, "startDate" | "endDate">,
  right: Pick<StoredMembershipPeriod, "startDate" | "endDate">,
): number {
  const a = left.startDate ?? "";
  const b = right.startDate ?? "";
  if (a !== b) {
    return a < b ? -1 : 1;
  }
  const c = left.endDate ?? "9999-12-31";
  const d = right.endDate ?? "9999-12-31";
  return c < d ? -1 : c > d ? 1 : 0;
}

function indexKeyOf(indexKey: MarketIndexKey): MarketIndexKeyEnum {
  return MarketIndexKeyEnum[indexKey];
}

function qualityOf(quality: IndexMembershipPeriodQuality): QualityEnum {
  return QualityEnum[quality];
}
