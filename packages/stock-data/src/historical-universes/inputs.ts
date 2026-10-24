import { Prisma, type PrismaClient } from "@intrinsic/database";
import type { LocalDate, MarketIndexKey } from "@intrinsic/domain";
import { loadDividendEvents, securitiesWithDividends } from "../dividends.js";
import { projectIndexList } from "../index-membership/quality.js";
import { PrismaIndexMembershipStore } from "../index-membership/prisma-store.js";
import type { StoredIndexConstituent } from "../index-membership/ports.js";
import {
  listingFloor,
  statementsWithEvidencedAvailability,
} from "../listing-evidence.js";
import { PrismaStockDataStore } from "../prisma-store.js";
import {
  buildValuationTimeline,
  marketCapitalizationColumn,
  valuationRatioColumns,
} from "../valuation-ratios.js";
import type { MembershipRange } from "./engine.js";
import {
  FUNDAMENTAL_RANKING_COLUMNS,
  type FundamentalRankingColumn,
  type SecuritySeries,
} from "./metrics.js";

/**
 * What the generator reads from PostgreSQL (`docs/decisions/historical-universes-v1.md` §4). Provider
 * free: nothing here can reach FMP, and a security missing a dataset is reported as missing rather
 * than filled in.
 */

export type ParentIndexMembership = {
  readonly indexKey: MarketIndexKey;
  /** Tradeable members' ranges, exactly as the index's built-in List projects them. */
  readonly ranges: ReadonlyMap<string, readonly MembershipRange[]>;
  /**
   * The index's lines on a date — every reconstructed constituent's period that holds it, priced or
   * not — the denominator of every coverage figure: a member with no provider data is still a member.
   */
  linesOn(date: LocalDate): number;
  /** The constituent keys behind each security, for the diagnostics. */
  readonly constituentsOf: ReadonlyMap<string, readonly string[]>;
  /** The newest completed synchronization's source digest, for the generation's input digest. */
  readonly sourceDigest: string | null;
};

export async function loadParentIndexMembership(
  prisma: PrismaClient,
  indexKey: MarketIndexKey,
  floor: LocalDate,
): Promise<ParentIndexMembership> {
  const store = new PrismaIndexMembershipStore(prisma);
  const constituents: StoredIndexConstituent[] =
    await store.loadConstituents(indexKey);
  const projected = projectIndexList(constituents, floor);
  const periods: { start: LocalDate | null; end: LocalDate | null }[] = [];
  for (const constituent of constituents) {
    for (const period of constituent.periods) {
      if (period.quality !== "END_UNKNOWN") {
        periods.push({ start: period.startDate, end: period.endDate });
      }
    }
  }
  const sync = await prisma.indexMembershipSync.findFirst({
    where: { indexKey, status: "COMPLETED" },
    orderBy: { completedAt: "desc" },
    select: { sourceDigest: true },
  });
  return {
    indexKey,
    ranges: new Map(
      projected.map((member) => [
        member.securityId,
        member.ranges.map((range) => ({
          startDate: range.startDate as LocalDate,
          endDate: range.endDate as LocalDate | null,
        })),
      ]),
    ),
    constituentsOf: new Map(
      projected.map((member) => [member.securityId, member.constituentKeys]),
    ),
    linesOn: (date) =>
      periods.filter(
        (period) =>
          (period.start === null || period.start <= date) &&
          (period.end === null || date <= period.end),
      ).length,
    sourceDigest: sync?.sourceDigest ?? null,
  };
}

/**
 * The trading sessions observed in the parent's stored prices, by the rule the index report uses
 * (`index-universe-report.ts`): a date on which at least a fifth as many securities printed as on
 * the busiest date within ten rows either side. A provider row for a holiday on one security is not a
 * session, and the rule follows the number of priced securities as it grows over thirty years.
 */
export async function observedSessions(
  prisma: PrismaClient,
  securityIds: readonly string[],
  from: LocalDate,
): Promise<LocalDate[]> {
  if (securityIds.length === 0) {
    return [];
  }
  const rows = await prisma.$queryRaw<{ date: Date; count: bigint }[]>(
    Prisma.sql`SELECT "date", COUNT(*)::bigint AS "count" FROM "DailyPrice"
      WHERE "securityId" IN (${Prisma.join([...securityIds])}) AND "date" >= ${new Date(`${from}T00:00:00.000Z`)}
      GROUP BY "date" ORDER BY "date"`,
  );
  const counts = rows.map((row) => Number(row.count));
  return rows
    .filter((_row, index) => {
      const window = counts.slice(Math.max(0, index - 10), index + 11);
      return (counts[index] as number) * 5 >= Math.max(...window);
    })
    .map((row) => row.date.toISOString().slice(0, 10) as LocalDate);
}

export type SeriesNeeds = {
  readonly valuation: boolean;
  readonly ratios: boolean;
  readonly fundamentals: readonly FundamentalRankingColumn[];
  readonly dividends: boolean;
  readonly splits: boolean;
};

/** One security's series from PostgreSQL, loaded only as far as the metrics need. */
export async function loadSecuritySeries(
  prisma: PrismaClient,
  input: {
    readonly securityId: string;
    readonly from: LocalDate;
    readonly needs: SeriesNeeds;
    /** The reconstitution dates the fundamental columns are read on. */
    readonly fundamentalDates: readonly LocalDate[];
    readonly dividendsSynced: boolean;
  },
): Promise<SecuritySeries> {
  const { securityId, needs } = input;
  const prices = await prisma.dailyPrice.findMany({
    where: {
      securityId,
      date: { gte: new Date(`${input.from}T00:00:00.000Z`) },
    },
    select: { date: true, close: true, volume: true },
    orderBy: { date: "asc" },
  });
  const dates = prices.map(
    (row) => row.date.toISOString().slice(0, 10) as LocalDate,
  );
  const closes = Float64Array.from(prices, (row) => row.close.toNumber());
  const volumes = Float64Array.from(prices, (row) => Number(row.volume));

  const store = new PrismaStockDataStore(prisma);
  const needsTimeline = needs.valuation || needs.ratios;
  const splits =
    needsTimeline || needs.splits ? await store.getStockSplits(securityId) : [];

  let marketCaps: Float64Array | undefined;
  let ratios: SecuritySeries["ratios"] | undefined;
  if (needsTimeline && dates.length > 0) {
    const [security] = await store.findSecuritiesByIds([securityId]);
    const [revisions, basis, events, earliestPriceDate] = await Promise.all([
      store.getFinancialStatementRevisions({
        securityId,
        cadence: "QUARTERLY",
      }),
      store.getPriceBasis(securityId),
      store.getPriceBasisEvents(securityId),
      store.getEarliestDailyPriceDate(securityId),
    ]);
    // The same statements every statement-derived calculation reads (DATA-03).
    const statements = statementsWithEvidencedAvailability(
      revisions,
      listingFloor({ ipoDate: security?.ipoDate, earliestPriceDate }),
    );
    const timeline = buildValuationTimeline({
      securityId,
      currency: security?.currency ?? "USD",
      statements,
      verifiedAt: basis?.verifiedAt ?? null,
      events,
      splits,
    });
    marketCaps = marketCapitalizationColumn({ timeline, dates, closes });
    if (needs.ratios) {
      const columns = valuationRatioColumns({
        timeline,
        dates,
        closes,
        ratios: [
          "PRICE_TO_EARNINGS_TTM",
          "PRICE_TO_BOOK",
          "PRICE_TO_SALES_TTM",
          "PRICE_TO_FCF_TTM",
        ],
      });
      ratios = {
        priceToEarnings: columns.get("PRICE_TO_EARNINGS_TTM"),
        priceToBook: columns.get("PRICE_TO_BOOK"),
        priceToSales: columns.get("PRICE_TO_SALES_TTM"),
        priceToFcf: columns.get("PRICE_TO_FCF_TTM"),
      };
    }
  }

  let fundamentals: SecuritySeries["fundamentals"];
  if (needs.fundamentals.length > 0 && input.fundamentalDates.length > 0) {
    const select = Object.fromEntries(
      needs.fundamentals.map((column) => [column, true]),
    ) as Record<FundamentalRankingColumn, true>;
    const rows = await prisma.dailyDerivedState.findMany({
      where: {
        securityId,
        date: {
          in: input.fundamentalDates.map(
            (date) => new Date(`${date}T00:00:00.000Z`),
          ),
        },
      },
      select: { date: true, ...select },
    });
    fundamentals = new Map(
      rows.map((row) => {
        const values: Partial<Record<FundamentalRankingColumn, number | null>> =
          {};
        for (const column of needs.fundamentals) {
          const value = (
            row as unknown as Record<string, Prisma.Decimal | null>
          )[column];
          values[column] =
            value === null || value === undefined ? null : value.toNumber();
        }
        return [row.date.toISOString().slice(0, 10) as LocalDate, values];
      }),
    );
  }

  let dividends: SecuritySeries["dividends"];
  if (needs.dividends) {
    dividends = input.dividendsSynced
      ? ((await loadDividendEvents(prisma, [securityId])).get(securityId) ?? [])
      : null;
  }

  return {
    securityId,
    dates,
    closes,
    volumes,
    ...(marketCaps ? { marketCaps } : {}),
    ...(ratios ? { ratios } : {}),
    ...(fundamentals ? { fundamentals } : {}),
    ...(needs.dividends ? { dividends } : {}),
    ...(needs.splits || needsTimeline ? { splits } : {}),
  };
}

export { securitiesWithDividends };

/** Every fundamental column a set of base metrics reads. */
export function fundamentalColumnsFor(
  metrics: Iterable<string>,
): FundamentalRankingColumn[] {
  const columns = new Set<FundamentalRankingColumn>();
  for (const metric of metrics) {
    const column = (
      FUNDAMENTAL_RANKING_COLUMNS as Record<string, FundamentalRankingColumn>
    )[metric];
    if (column) {
      columns.add(column);
    }
  }
  return [...columns].sort();
}
