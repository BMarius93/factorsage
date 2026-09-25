import {
  AlternativeActorType as AlternativeActorTypeEnum,
  CongressAssetClass as CongressAssetClassEnum,
  CongressChamber as CongressChamberEnum,
  CongressOwner as CongressOwnerEnum,
  CongressTransactionKind as CongressTransactionKindEnum,
  InsiderRole as InsiderRoleEnum,
  InsiderTransactionCategory as InsiderTransactionCategoryEnum,
  InstitutionalPositionChange as InstitutionalPositionChangeEnum,
  type Prisma,
  PrismaClient,
  StockDataset,
} from "@intrinsic/database";
import type {
  AlternativeActorType,
  LocalDate,
  SecurityId,
} from "@intrinsic/domain";
import {
  ALTERNATIVE_DATA_DATASETS,
  type AlternativeDataActorUpsert,
  type AlternativeDataDatasetState,
  type AlternativeDataDomain,
  type AlternativeDataStore,
  type AlternativeDataWriteResult,
  type CongressObservationQuery,
  type CongressObservationRow,
  type CongressTradeWrite,
  type InsiderObservationQuery,
  type InsiderObservationRow,
  type InsiderTransactionWrite,
  type InstitutionalFilingWrite,
  type InstitutionalObservationQuery,
  type InstitutionalObservationRow,
  type InstitutionalPositionEventWrite,
  type PersistedAlternativeDataActor,
} from "./alternative-data-ports.js";

/**
 * PostgreSQL persistence for the alternative-data slice.
 *
 * Three properties matter, and each is implemented once here:
 *
 * 1. **Writes are idempotent.** Every row carries a `contentHash` over the provider's meaningful
 *    fields and a unique constraint on it, and inserts use `skipDuplicates`. Re-ingesting an unchanged
 *    history changes nothing; a corrected or amended disclosure inserts a new row beside the old one
 *    rather than overwriting it, so a historical signal stays auditable.
 * 2. **Reads are narrow and indexed.** Each observation read answers one configured metric over a
 *    bounded availability range for one security, which is the only shape a frame column needs, and
 *    selects three columns rather than the whole audit row.
 * 3. **Availability is the only date a read filters on.** The transaction date and the report period
 *    are stored and reported but never appear in a `where` clause here, so no query can accidentally
 *    window on a date a point-in-time reader could not have used.
 */

/** Bind-parameter-safe chunk for a bulk insert of provider rows. */
const WRITE_CHUNK = 500;

function toDatabaseDate(value: LocalDate): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function fromDatabaseDate(value: Date): LocalDate {
  return value.toISOString().slice(0, 10);
}

type DecimalLike = { toNumber(): number };

function decimalToNumber(value: DecimalLike | null): number | null {
  return value === null ? null : value.toNumber();
}

function actorKeyOf(type: AlternativeActorType, externalId: string): string {
  return `${type}:${externalId}`;
}

function chunk<T>(rows: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

export class PrismaAlternativeDataStore implements AlternativeDataStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Creates actors on first sight and refreshes their labels afterwards.
   *
   * One `createMany` with `skipDuplicates` then one read, rather than an upsert per actor: an ingest of
   * a busy symbol can see two hundred distinct members, and a per-row upsert would be two hundred round
   * trips. The label refresh is a second pass over only the rows whose display name actually moved, so a
   * steady state writes nothing.
   *
   * `(type, externalId)` is the identity. A member whose display name changes keeps their row — and
   * therefore keeps their place in every group that holds them.
   */
  async upsertActors(
    actors: readonly AlternativeDataActorUpsert[],
  ): Promise<Map<string, string>> {
    const unique = new Map<string, AlternativeDataActorUpsert>();
    for (const actor of actors) {
      unique.set(actorKeyOf(actor.type, actor.externalId), actor);
    }
    if (unique.size === 0) {
      return new Map();
    }
    const wanted = [...unique.values()];

    await this.prisma.alternativeDataActor.createMany({
      data: wanted.map((actor) => ({
        type: AlternativeActorTypeEnum[actor.type],
        externalId: actor.externalId,
        displayName: actor.displayName,
        ...(actor.chamber
          ? { chamber: CongressChamberEnum[actor.chamber] }
          : {}),
        ...(actor.state ? { state: actor.state } : {}),
        ...(actor.district ? { district: actor.district } : {}),
        ...(actor.cik ? { cik: actor.cik } : {}),
      })),
      skipDuplicates: true,
    });

    const rows = await this.prisma.alternativeDataActor.findMany({
      where: {
        OR: wanted.map((actor) => ({
          type: AlternativeActorTypeEnum[actor.type],
          externalId: actor.externalId,
        })),
      },
      select: {
        id: true,
        type: true,
        externalId: true,
        displayName: true,
        chamber: true,
        state: true,
        district: true,
        cik: true,
      },
    });

    const ids = new Map<string, string>();
    const refreshes: Promise<unknown>[] = [];
    for (const row of rows) {
      const key = actorKeyOf(row.type, row.externalId);
      ids.set(key, row.id);
      const observed = unique.get(key);
      if (!observed) {
        continue;
      }
      // Only the presentational fields are refreshed, and only when one of them actually moved.
      const changed =
        observed.displayName !== row.displayName ||
        (observed.chamber ?? null) !== row.chamber ||
        (observed.state ?? null) !== row.state ||
        (observed.district ?? null) !== row.district ||
        (observed.cik ?? null) !== row.cik;
      if (changed) {
        refreshes.push(
          this.prisma.alternativeDataActor.update({
            where: { id: row.id },
            data: {
              displayName: observed.displayName,
              chamber: observed.chamber
                ? CongressChamberEnum[observed.chamber]
                : null,
              state: observed.state ?? null,
              district: observed.district ?? null,
              cik: observed.cik ?? null,
            },
          }),
        );
      }
    }
    await Promise.all(refreshes);
    return ids;
  }

  async searchActors(input: {
    type: AlternativeActorType;
    term?: string;
    limit: number;
  }): Promise<PersistedAlternativeDataActor[]> {
    const term = input.term?.trim();
    const rows = await this.prisma.alternativeDataActor.findMany({
      where: {
        type: AlternativeActorTypeEnum[input.type],
        ...(term
          ? {
              OR: [
                { displayName: { contains: term, mode: "insensitive" } },
                { externalId: { startsWith: term, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: [{ displayName: "asc" }, { externalId: "asc" }],
      take: input.limit,
    });
    return rows.map(actorResponse);
  }

  async findActorsByIds(
    ids: readonly string[],
  ): Promise<PersistedAlternativeDataActor[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.prisma.alternativeDataActor.findMany({
      where: { id: { in: [...new Set(ids)] } },
      orderBy: [{ displayName: "asc" }, { externalId: "asc" }],
    });
    return rows.map(actorResponse);
  }

  async getActorGroupMemberIds(groupId: string): Promise<string[]> {
    const rows = await this.prisma.actorGroupMember.findMany({
      where: { groupId },
      orderBy: { createdAt: "asc" },
      select: { actorId: true },
    });
    return rows.map((row) => row.actorId);
  }

  async getAlternativeDatasetState(
    securityId: SecurityId,
    domain: AlternativeDataDomain,
  ): Promise<AlternativeDataDatasetState | null> {
    const { dataset, variant } = ALTERNATIVE_DATA_DATASETS[domain];
    const row = await this.prisma.stockDatasetState.findUnique({
      where: {
        securityId_dataset_variant: {
          securityId,
          dataset: StockDataset[dataset as keyof typeof StockDataset],
          variant,
        },
      },
    });
    if (!row) {
      return null;
    }
    return {
      earliestAvailableDate: row.earliestDate
        ? fromDatabaseDate(row.earliestDate)
        : null,
      latestAvailableDate: row.latestDate
        ? fromDatabaseDate(row.latestDate)
        : null,
      // The calendar date of the last successful ingest: past it the product knows nothing about this
      // domain for this security, which is what bounds the evaluable range from above.
      syncedThroughDate: row.lastSuccessfulSyncAt
        ? row.lastSuccessfulSyncAt.toISOString().slice(0, 10)
        : null,
      lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString() ?? null,
    };
  }

  async recordAlternativeDatasetSync(input: {
    securityId: SecurityId;
    domain: AlternativeDataDomain;
    earliestAvailableDate?: LocalDate;
    latestAvailableDate?: LocalDate;
    syncedAt: string;
  }): Promise<void> {
    const { dataset, variant } = ALTERNATIVE_DATA_DATASETS[input.domain];
    const key = {
      securityId: input.securityId,
      dataset: StockDataset[dataset as keyof typeof StockDataset],
      variant,
    };
    const existing = await this.prisma.stockDatasetState.findUnique({
      where: { securityId_dataset_variant: key },
      select: { earliestDate: true, latestDate: true },
    });
    // The earliest known availability only ever moves **downwards**. A refresh that paged less deeply
    // than the first ingest has not un-learned the older rows it already persisted, and narrowing the
    // floor would silently make years of already-ingested history NOT_EVALUABLE again.
    const earliest = [
      existing?.earliestDate ? fromDatabaseDate(existing.earliestDate) : undefined,
      input.earliestAvailableDate,
    ]
      .filter((date): date is LocalDate => date !== undefined)
      .sort()[0];
    const latest = [
      existing?.latestDate ? fromDatabaseDate(existing.latestDate) : undefined,
      input.latestAvailableDate,
    ]
      .filter((date): date is LocalDate => date !== undefined)
      .sort()
      .at(-1);
    const data = {
      ...(earliest ? { earliestDate: toDatabaseDate(earliest) } : {}),
      ...(latest ? { latestDate: toDatabaseDate(latest) } : {}),
      lastSuccessfulSyncAt: new Date(input.syncedAt),
    };
    await this.prisma.stockDatasetState.upsert({
      where: { securityId_dataset_variant: key },
      create: { ...key, ...data },
      update: data,
    });
  }

  async saveInsiderTransactions(
    rows: readonly InsiderTransactionWrite[],
  ): Promise<AlternativeDataWriteResult> {
    let inserted = 0;
    for (const page of chunk(rows, WRITE_CHUNK)) {
      const result = await this.prisma.insiderTransaction.createMany({
        data: page.map((row) => ({
          securityId: row.securityId,
          transactionDate: toDatabaseDate(row.transactionDate),
          filingDate: toDatabaseDate(row.filingDate),
          availableFromDate: toDatabaseDate(row.availableFromDate),
          reportingCik: row.reportingCik,
          reportingName: row.reportingName,
          companyCik: row.companyCik ?? null,
          typeOfOwner: row.typeOfOwner ?? null,
          roles: row.roles.map((role) => InsiderRoleEnum[role]),
          transactionCode: row.transactionCode ?? null,
          transactionTypeRaw: row.transactionTypeRaw,
          category: InsiderTransactionCategoryEnum[row.category],
          acquisitionOrDisposition: row.acquisitionOrDisposition ?? null,
          directOrIndirect: row.directOrIndirect ?? null,
          formType: row.formType ?? null,
          securityName: row.securityName ?? null,
          securitiesTransacted: row.securitiesTransacted ?? null,
          securitiesOwned: row.securitiesOwned ?? null,
          price: row.price ?? null,
          transactionValue: row.transactionValue ?? null,
          sourceUrl: row.sourceUrl ?? null,
          raw: row.raw as Prisma.InputJsonValue,
          contentHash: row.contentHash,
        })),
        skipDuplicates: true,
      });
      inserted += result.count;
    }
    return { inserted, unchanged: rows.length - inserted };
  }

  async saveCongressTrades(
    rows: readonly CongressTradeWrite[],
  ): Promise<AlternativeDataWriteResult> {
    let inserted = 0;
    for (const page of chunk(rows, WRITE_CHUNK)) {
      const result = await this.prisma.congressTrade.createMany({
        data: page.map((row) => ({
          securityId: row.securityId,
          actorId: row.actorId,
          chamber: CongressChamberEnum[row.chamber],
          transactionDate: toDatabaseDate(row.transactionDate),
          disclosureDate: toDatabaseDate(row.disclosureDate),
          availableFromDate: toDatabaseDate(row.availableFromDate),
          kind: CongressTransactionKindEnum[row.kind],
          transactionTypeRaw: row.transactionTypeRaw,
          owner: CongressOwnerEnum[row.owner],
          ownerRaw: row.ownerRaw ?? null,
          assetClass: CongressAssetClassEnum[row.assetClass],
          assetTypeRaw: row.assetTypeRaw ?? null,
          assetDescription: row.assetDescription ?? null,
          amountRangeRaw: row.amountRangeRaw ?? null,
          amountLowerBound: row.amountLowerBound ?? null,
          amountUpperBound: row.amountUpperBound ?? null,
          capitalGainsOver200Usd: row.capitalGainsOver200Usd ?? null,
          comment: row.comment ?? null,
          sourceUrl: row.sourceUrl ?? null,
          raw: row.raw as Prisma.InputJsonValue,
          contentHash: row.contentHash,
        })),
        skipDuplicates: true,
      });
      inserted += result.count;
    }
    return { inserted, unchanged: rows.length - inserted };
  }

  /**
   * Persists 13F filings and their holdings.
   *
   * A filing and its holdings are written together in one transaction: a filing row with no holdings
   * would read as "this manager reported nothing", which is exactly the shape the derivation treats as
   * an exit. `skipDuplicates` on the filing makes reingestion a no-op, and the holdings are only
   * written for a filing this call actually created.
   */
  async saveInstitutionalFilings(
    filings: readonly InstitutionalFilingWrite[],
  ): Promise<AlternativeDataWriteResult> {
    let inserted = 0;
    for (const filing of filings) {
      const created = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.institutionalFiling.findUnique({
          where: {
            actorId_reportPeriod_contentHash: {
              actorId: filing.actorId,
              reportPeriod: toDatabaseDate(filing.reportPeriod),
              contentHash: filing.contentHash,
            },
          },
          select: { id: true },
        });
        if (existing) {
          return false;
        }
        await tx.institutionalFiling.create({
          data: {
            actorId: filing.actorId,
            reportPeriod: toDatabaseDate(filing.reportPeriod),
            filingDate: toDatabaseDate(filing.filingDate),
            availableFromDate: toDatabaseDate(filing.availableFromDate),
            amendmentType: filing.amendmentType ?? null,
            providerFilingId: filing.providerFilingId ?? null,
            raw: filing.raw as Prisma.InputJsonValue,
            contentHash: filing.contentHash,
            holdings: {
              create: filing.holdings.map((holding) => ({
                securityId: holding.securityId,
                shares: holding.shares,
                marketValue: holding.marketValue ?? null,
                portfolioWeightPercent: holding.portfolioWeightPercent ?? null,
                raw: holding.raw as Prisma.InputJsonValue,
              })),
            },
          },
        });
        return true;
      });
      if (created) {
        inserted += 1;
      }
    }
    return { inserted, unchanged: filings.length - inserted };
  }

  async getInstitutionalFilingsForSecurity(input: {
    securityId: SecurityId;
    actorId?: string;
  }) {
    const rows = await this.prisma.institutionalFiling.findMany({
      where: input.actorId ? { actorId: input.actorId } : {},
      orderBy: [{ actorId: "asc" }, { reportPeriod: "asc" }],
      select: {
        actorId: true,
        reportPeriod: true,
        filingDate: true,
        availableFromDate: true,
        amendmentType: true,
        holdings: {
          where: { securityId: input.securityId },
          select: { shares: true, portfolioWeightPercent: true },
        },
      },
    });
    return rows.map((row) => {
      const holding = row.holdings[0];
      return {
        actorId: row.actorId,
        reportPeriod: fromDatabaseDate(row.reportPeriod),
        filingDate: fromDatabaseDate(row.filingDate),
        availableFromDate: fromDatabaseDate(row.availableFromDate),
        ...(row.amendmentType ? { amendmentType: row.amendmentType } : {}),
        shares: holding ? holding.shares.toNumber() : null,
        portfolioWeightPercent: holding
          ? decimalToNumber(holding.portfolioWeightPercent)
          : null,
      };
    });
  }

  async replaceInstitutionalPositionEvents(input: {
    securityId: SecurityId;
    events: readonly InstitutionalPositionEventWrite[];
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.institutionalPositionEvent.deleteMany({
        where: { securityId: input.securityId },
      });
      for (const page of chunk(input.events, WRITE_CHUNK)) {
        await tx.institutionalPositionEvent.createMany({
          data: page.map((event) => ({
            securityId: event.securityId,
            actorId: event.actorId,
            reportPeriod: toDatabaseDate(event.reportPeriod),
            previousReportPeriod: event.previousReportPeriod
              ? toDatabaseDate(event.previousReportPeriod)
              : null,
            availableFromDate: toDatabaseDate(event.availableFromDate),
            change: InstitutionalPositionChangeEnum[event.change],
            shares: event.shares,
            previousShares: event.previousShares ?? null,
            changePercent: event.changePercent ?? null,
            portfolioWeightPercent: event.portfolioWeightPercent ?? null,
            previousPortfolioWeightPercent:
              event.previousPortfolioWeightPercent ?? null,
          })),
        });
      }
    });
  }

  async getInsiderObservations(
    query: InsiderObservationQuery,
  ): Promise<InsiderObservationRow[]> {
    const rows = await this.prisma.insiderTransaction.findMany({
      where: {
        securityId: query.securityId,
        category: InsiderTransactionCategoryEnum[query.category],
        availableFromDate: {
          gte: toDatabaseDate(query.from),
          lte: toDatabaseDate(query.to),
        },
        // A role filter matches when the row states *any* of the selected roles, because one person is
        // frequently more than one thing ("officer: President and CEO").
        ...(query.roles && query.roles.length > 0
          ? {
              roles: {
                hasSome: query.roles.map((role) => InsiderRoleEnum[role]),
              },
            }
          : {}),
      },
      orderBy: { availableFromDate: "asc" },
      select: {
        availableFromDate: true,
        reportingCik: true,
        transactionValue: true,
      },
    });
    return rows.map((row) => ({
      availableFromDate: fromDatabaseDate(row.availableFromDate),
      actorKey: row.reportingCik,
      transactionValue: decimalToNumber(row.transactionValue),
    }));
  }

  async getCongressObservations(
    query: CongressObservationQuery,
  ): Promise<CongressObservationRow[]> {
    // An empty `actorIds` list selects nobody, and it is a legitimate state: a group with no members
    // counts nothing rather than everything. Answering without a query keeps that explicit.
    if (query.actorIds && query.actorIds.length === 0) {
      return [];
    }
    const rows = await this.prisma.congressTrade.findMany({
      where: {
        securityId: query.securityId,
        kind: CongressTransactionKindEnum[query.kind],
        // V1 counts common stock only. Other asset classes are ingested and preserved; a metric never
        // reads a corporate bond as a share purchase.
        assetClass: CongressAssetClassEnum.STOCK,
        availableFromDate: {
          gte: toDatabaseDate(query.from),
          lte: toDatabaseDate(query.to),
        },
        ...(query.actorIds ? { actorId: { in: [...query.actorIds] } } : {}),
        ...(query.chamber
          ? { chamber: CongressChamberEnum[query.chamber] }
          : {}),
        ...(query.owners && query.owners.length > 0
          ? {
              owner: {
                in: query.owners.map((owner) => CongressOwnerEnum[owner]),
              },
            }
          : {}),
      },
      orderBy: { availableFromDate: "asc" },
      select: {
        availableFromDate: true,
        actorId: true,
        amountLowerBound: true,
      },
    });
    return rows.map((row) => ({
      availableFromDate: fromDatabaseDate(row.availableFromDate),
      actorKey: row.actorId,
      amountLowerBound: decimalToNumber(row.amountLowerBound),
    }));
  }

  async getInstitutionalObservations(
    query: InstitutionalObservationQuery,
  ): Promise<InstitutionalObservationRow[]> {
    if (query.actorIds && query.actorIds.length === 0) {
      return [];
    }
    if (query.changes.length === 0) {
      return [];
    }
    const rows = await this.prisma.institutionalPositionEvent.findMany({
      where: {
        securityId: query.securityId,
        change: {
          in: query.changes.map(
            (change) => InstitutionalPositionChangeEnum[change],
          ),
        },
        availableFromDate: {
          gte: toDatabaseDate(query.from),
          lte: toDatabaseDate(query.to),
        },
        ...(query.actorIds ? { actorId: { in: [...query.actorIds] } } : {}),
      },
      orderBy: { availableFromDate: "asc" },
      select: {
        availableFromDate: true,
        actorId: true,
        shares: true,
        previousShares: true,
      },
    });
    return rows.map((row) => ({
      availableFromDate: fromDatabaseDate(row.availableFromDate),
      actorKey: row.actorId,
      shares: row.shares.toNumber(),
      previousShares: decimalToNumber(row.previousShares),
    }));
  }
}

function actorResponse(row: {
  id: string;
  type: AlternativeActorTypeEnum;
  externalId: string;
  displayName: string;
  chamber: CongressChamberEnum | null;
  state: string | null;
  district: string | null;
  cik: string | null;
}): PersistedAlternativeDataActor {
  return {
    id: row.id,
    type: row.type,
    externalId: row.externalId,
    displayName: row.displayName,
    ...(row.chamber ? { chamber: row.chamber } : {}),
    ...(row.state ? { state: row.state } : {}),
    ...(row.district ? { district: row.district } : {}),
    ...(row.cik ? { cik: row.cik } : {}),
  };
}
