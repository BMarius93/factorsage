import {
  CongressAssetClass as CongressAssetClassEnum,
  CongressChamber as CongressChamberEnum,
  CongressOwner as CongressOwnerEnum,
  CongressTransactionKind as CongressTransactionKindEnum,
  InsiderRole as InsiderRoleEnum,
  InsiderTransactionCategory as InsiderTransactionCategoryEnum,
  type Prisma,
  PrismaClient,
  StockDataset,
} from "@intrinsic/database";
import type { CongressChamber, LocalDate, SecurityId } from "@intrinsic/domain";
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

/**
 * How many partially matching actors a search reads before ranking them.
 *
 * A bound on one read of a small reference table, not a page size: the ranked result is cut to the
 * caller's own limit afterwards. It is deliberately larger than the catalog — about 1,260 members
 * once the provider's directory is loaded — because candidates are read in name order, and a bound
 * below the number of names sharing a short word ("ed", "al") would drop the later half of the
 * alphabet before anything had been ranked.
 */
const PARTIAL_MATCH_CANDIDATES = 2_000;

/** Words of a search term long enough to be worth matching on their own. */
function searchWords(term: string): string[] {
  return [
    ...new Set(
      term
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word.length >= 2),
    ),
  ];
}

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
      unique.set(actor.externalId, actor);
    }
    if (unique.size === 0) {
      return new Map();
    }
    const wanted = [...unique.values()];

    await this.prisma.alternativeDataActor.createMany({
      data: wanted.map((actor) => ({
        externalId: actor.externalId,
        displayName: actor.displayName,
        chamber: CongressChamberEnum[actor.chamber],
        ...(actor.state ? { state: actor.state } : {}),
        ...(actor.district ? { district: actor.district } : {}),
      })),
      skipDuplicates: true,
    });

    const rows = await this.prisma.alternativeDataActor.findMany({
      where: { externalId: { in: wanted.map((actor) => actor.externalId) } },
      select: {
        id: true,
        externalId: true,
        displayName: true,
        chamber: true,
        state: true,
        district: true,
      },
    });

    const ids = new Map<string, string>();
    const refreshes: Promise<unknown>[] = [];
    for (const row of rows) {
      ids.set(row.externalId, row.id);
      const observed = unique.get(row.externalId);
      if (!observed) {
        continue;
      }
      // Only the presentational fields are refreshed, and only when one of them actually moved.
      const changed =
        observed.displayName !== row.displayName ||
        observed.chamber !== row.chamber ||
        (observed.state ?? null) !== row.state ||
        (observed.district ?? null) !== row.district;
      if (changed) {
        refreshes.push(
          this.prisma.alternativeDataActor.update({
            where: { id: row.id },
            data: {
              displayName: observed.displayName,
              chamber: CongressChamberEnum[observed.chamber],
              state: observed.state ?? null,
              district: observed.district ?? null,
            },
          }),
        );
      }
    }
    await Promise.all(refreshes);
    return ids;
  }

  /**
   * Actors matching a term — and, when the whole term matches nobody, the names that match some of
   * its words.
   *
   * A member has up to two spellings, both the provider's own: the one their disclosures use
   * (`displayName`) and the one the member directory uses (`profileName`). They differ more often
   * than not — "William Cassidy" and "Bill Cassidy", "Richard W. Allen" and "Rick W. Allen" — so a
   * term is matched against both, and either one finds the member. Nothing here is a guess: an
   * alias is a spelling the provider sent for that bioguide id, never one this product made up.
   *
   * The fallback exists because neither spelling is always what a person types: the provider has
   * no nickname field, and holds "Rafael E Cruz" and "Rafael Edward Cruz" for the senator everybody
   * searches for as "Ted Cruz". Matched whole, that term finds nobody, and an empty result reads as
   * "this member is not here". Matching the words separately still surfaces him — by surname, with
   * the chamber and state beside the name to recognize him by.
   *
   * Partial matches are ordered by how many of the term's words a spelling shares, and among equals
   * the ones sharing its **last** word come first. People type a given name and then a family name,
   * and the family name is the part that identifies: with the whole directory loaded, "ted" alone
   * is inside "Husted" and in front of "Lieu", and the senator belongs above both.
   *
   * It is a fallback and nothing more: a term that matches anybody whole returns exactly what it
   * always returned, so a search that works is never diluted with near misses. It reads only the
   * actor table and never a disclosure, so it changes nothing about what a metric counts.
   */
  async searchActors(input: {
    term?: string;
    limit: number;
  }): Promise<PersistedAlternativeDataActor[]> {
    const term = input.term?.trim();
    const order = [
      { displayName: "asc" as const },
      { externalId: "asc" as const },
    ];
    const whole = await this.prisma.alternativeDataActor.findMany({
      where: term
        ? {
            OR: [
              { displayName: { contains: term, mode: "insensitive" } },
              { profileName: { contains: term, mode: "insensitive" } },
              { externalId: { startsWith: term, mode: "insensitive" } },
            ],
          }
        : {},
      orderBy: order,
      take: input.limit,
    });
    const words = term ? searchWords(term) : [];
    if (whole.length > 0 || words.length < 2) {
      return whole.map(actorResponse);
    }

    const partial = await this.prisma.alternativeDataActor.findMany({
      where: {
        OR: words.flatMap((word) => [
          { displayName: { contains: word, mode: "insensitive" as const } },
          { profileName: { contains: word, mode: "insensitive" as const } },
        ]),
      },
      orderBy: order,
      take: PARTIAL_MATCH_CANDIDATES,
    });
    // Ranked by the spelling that shares most words with the term, whichever of the two it is, and
    // then by whether either spelling holds the term's last word.
    const lastWord = words[words.length - 1] as string;
    const rank = (row: {
      displayName: string;
      profileName: string | null;
    }): { matched: number; family: number } => {
      const spellings = [row.displayName, row.profileName ?? ""].map(
        (spelling) => spelling.toLowerCase(),
      );
      return {
        matched: Math.max(
          ...spellings.map(
            (name) => words.filter((word) => name.includes(word)).length,
          ),
        ),
        family: spellings.some((name) => name.includes(lastWord)) ? 1 : 0,
      };
    };
    return (
      partial
        .map((row) => ({ row, ...rank(row) }))
        // The read is already in name order and the sort is stable, so equal ranks stay
        // alphabetical.
        .sort(
          (left, right) =>
            right.matched - left.matched || right.family - left.family,
        )
        .slice(0, input.limit)
        .map((entry) => actorResponse(entry.row))
    );
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

}

function actorResponse(row: {
  id: string;
  externalId: string;
  displayName: string;
  chamber: CongressChamberEnum;
  state: string | null;
  district: string | null;
}): PersistedAlternativeDataActor {
  return {
    id: row.id,
    externalId: row.externalId,
    displayName: row.displayName,
    chamber: row.chamber as CongressChamber,
    ...(row.state ? { state: row.state } : {}),
    ...(row.district ? { district: row.district } : {}),
  };
}
