import {
  MarketIndexKey as MarketIndexKeyEnum,
  type PrismaClient,
} from "@intrinsic/database";
import type {
  LocalDate,
  MarketIndexKey,
  PointInTimeIndexUniverse,
} from "@intrinsic/domain";
import { membershipWithinHorizon, windowsFrom } from "@intrinsic/stock-data";

/**
 * What the canonical membership and the stored data actually hold for an index universe, measured
 * from PostgreSQL alone (`docs/decisions/sp500-historical-pit-v1.md` §7).
 *
 * Every figure is read back with aggregate queries: a run exiting successfully is never taken as
 * evidence of coverage. It prints names, tickers, counts and dates, never a provider row.
 */
export type IndexUniverseReport = {
  readonly generatedAt: string;
  readonly indexKey: MarketIndexKey;
  readonly horizon: { floor: LocalDate; asOf: LocalDate };
  readonly membership: {
    syncId: string | null;
    syncedAt: string | null;
    sourceDigest: string | null;
    summary: unknown;
    constituentsTotal: number;
    constituentsInHorizon: number;
    byResolution: Record<string, number>;
    uniqueTradeableSecurities: number;
    endUnknownPeriods: {
      constituentKey: string;
      ticker: string;
      name: string;
    }[];
    unresolved: {
      ticker: string;
      name: string;
      origin: string;
      resolution: string;
      membership: { from: LocalDate; to: LocalDate }[];
      reason: string | null;
    }[];
  };
  readonly list: {
    id: string;
    name: string;
    members: number;
    windows: number;
  } | null;
  readonly data: {
    datasets: unknown;
    securitiesWithPrices: number;
    earliestPrice: LocalDate | null;
    latestPrice: LocalDate | null;
    sessionsInCalendar: number;
    coverageByYear: {
      year: string;
      averageMembers: number;
      memberSessions: number;
      pricedMemberSessions: number;
      pricedShare: number | null;
    }[];
    securitiesWithInteriorGaps: number;
    interiorGapSessions: number;
    largestInteriorGaps: { ticker: string; sessions: number }[];
  };
  readonly ingestion: {
    byStatus: Record<string, { securities: number; providerRequests: number }>;
    failures: { symbol: string; attempts: number; error: string | null }[];
  };
};

type ConstituentRow = {
  constituentKey: string;
  origin: string;
  ticker: string;
  name: string;
  resolution: string;
  securityId: string | null;
  securityFrom: Date | null;
  resolutionEvidence: unknown;
  periods: { startDate: Date | null; endDate: Date | null; quality: string }[];
};

const iso = (value: Date | null): LocalDate | null =>
  value === null ? null : value.toISOString().slice(0, 10);

export async function buildIndexUniverseReport(input: {
  readonly prisma: PrismaClient;
  readonly indexKey: MarketIndexKey;
  readonly universe: PointInTimeIndexUniverse;
  readonly asOf: LocalDate;
}): Promise<IndexUniverseReport> {
  const { prisma } = input;
  const indexKey = MarketIndexKeyEnum[input.indexKey];
  const horizon = { floor: input.universe.membershipFloor, asOf: input.asOf };
  const sync = await prisma.indexMembershipSync.findFirst({
    where: { indexKey, status: "COMPLETED" },
    orderBy: { completedAt: "desc" },
  });
  const constituents = (await prisma.indexConstituent.findMany({
    where: { indexKey },
    include: { periods: true },
    orderBy: { constituentKey: "asc" },
  })) as ConstituentRow[];

  const toPeriods = (row: ConstituentRow) =>
    row.periods.map((period) => ({
      startDate: iso(period.startDate),
      endDate: iso(period.endDate),
      quality: period.quality as
        "CONFIRMED" | "START_BEFORE_LOG" | "END_UNKNOWN",
    }));
  const inHorizon = constituents.filter(
    (row) => membershipWithinHorizon(toPeriods(row), horizon).length > 0,
  );
  const byResolution: Record<string, number> = {};
  for (const row of inHorizon) {
    byResolution[row.resolution] = (byResolution[row.resolution] ?? 0) + 1;
  }
  const tradeable = inHorizon.filter(
    (row) =>
      (row.resolution === "RESOLVED" ||
        row.resolution === "RESOLVED_PARTIAL") &&
      row.securityId !== null,
  );
  const securityIds = [
    ...new Set(tradeable.map((row) => row.securityId as string)),
  ];
  const endUnknown = constituents.flatMap((row) =>
    row.periods
      .filter((period) => period.quality === "END_UNKNOWN")
      .filter(
        (period) =>
          period.startDate === null || iso(period.startDate)! <= input.asOf,
      )
      .map(() => ({
        constituentKey: row.constituentKey,
        ticker: row.ticker,
        name: row.name,
      })),
  );
  const unresolved = inHorizon
    .filter((row) => !tradeable.includes(row))
    .map((row) => ({
      ticker: row.ticker,
      name: row.name,
      origin: row.origin,
      resolution: row.resolution,
      membership: membershipWithinHorizon(toPeriods(row), horizon),
      reason:
        (row.resolutionEvidence as { reason?: string } | null)?.reason ?? null,
    }))
    .sort((left, right) =>
      (left.membership[0]?.from ?? "") < (right.membership[0]?.from ?? "")
        ? -1
        : 1,
    );

  // Stored data for the universe's securities, by table.
  const datasets =
    securityIds.length === 0 ? null : await datasetTotals(prisma, securityIds);
  const perSecurity =
    securityIds.length === 0
      ? []
      : await perSecurityPriceBounds(prisma, securityIds);
  const bounds = new Map(perSecurity.map((row) => [row.securityId, row]));

  // Members on a date, and how many of them have a stored price that date. The trading calendar is
  // the union of the universe's own price dates that at least a fifth of the members on that date
  // printed — the dev database holds no benchmark calendar, and a bar from one security on a
  // holiday is not a session.
  const sessions =
    securityIds.length === 0
      ? []
      : await sessionMembership(prisma, securityIds);
  const coverageByYear = new Map<
    string,
    { memberSessions: number; pricedMemberSessions: number }
  >();
  const windowsBySecurity = new Map<
    string,
    { from: LocalDate; to: LocalDate }[]
  >();
  for (const row of tradeable) {
    // Only the days the security's prices are this constituent's are priced member-days.
    const windows = windowsFrom(
      membershipWithinHorizon(toPeriods(row), horizon),
      iso(row.securityFrom),
    );
    windowsBySecurity.set(row.securityId as string, [
      ...(windowsBySecurity.get(row.securityId as string) ?? []),
      ...windows,
    ]);
  }
  const membersByDate = new Map<LocalDate, number>();
  for (const row of inHorizon) {
    for (const window of membershipWithinHorizon(toPeriods(row), horizon)) {
      for (const session of sessions) {
        if (session.date >= window.from && session.date <= window.to) {
          membersByDate.set(
            session.date,
            (membersByDate.get(session.date) ?? 0) + 1,
          );
        }
      }
    }
  }
  const missingInterior: { ticker: string; sessions: number }[] = [];
  const tickers = new Map(
    tradeable.map((row) => [row.securityId as string, row.ticker]),
  );
  for (const session of sessions) {
    const members = membersByDate.get(session.date) ?? 0;
    let priced = 0;
    for (const [securityId, windows] of windowsBySecurity) {
      if (
        !windows.some(
          (window) => session.date >= window.from && session.date <= window.to,
        )
      ) {
        continue;
      }
      if (session.priced.has(securityId)) {
        priced += 1;
      }
    }
    const year = session.date.slice(0, 4);
    const entry = coverageByYear.get(year) ?? {
      memberSessions: 0,
      pricedMemberSessions: 0,
    };
    entry.memberSessions += members;
    entry.pricedMemberSessions += priced;
    coverageByYear.set(year, entry);
  }
  for (const [securityId, windows] of windowsBySecurity) {
    const own = bounds.get(securityId);
    if (!own) {
      continue;
    }
    let gaps = 0;
    for (const session of sessions) {
      if (session.date < own.first || session.date > own.last) {
        continue;
      }
      if (
        !windows.some(
          (window) => session.date >= window.from && session.date <= window.to,
        )
      ) {
        continue;
      }
      if (!session.priced.has(securityId)) {
        gaps += 1;
      }
    }
    if (gaps > 0) {
      missingInterior.push({
        ticker: tickers.get(securityId) ?? securityId,
        sessions: gaps,
      });
    }
  }

  const ingestion = await prisma.indexUniverseIngestion.groupBy({
    by: ["status"],
    where: { indexKey },
    _count: { _all: true },
    _sum: { providerRequests: true },
  });
  const ingestionFailures = await prisma.indexUniverseIngestion.findMany({
    where: { indexKey, status: "FAILED" },
    select: {
      lastError: true,
      attempts: true,
      security: { select: { providerSymbol: true } },
    },
    orderBy: { security: { providerSymbol: "asc" } },
  });
  const list = await prisma.stockList.findUnique({
    where: { systemKey: input.universe.listSystemKey },
    select: { id: true, name: true, _count: { select: { items: true } } },
  });
  const listWindows = list
    ? await prisma.stockListBuyWindow.count({
        where: { item: { stockListId: list.id } },
      })
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    indexKey: input.indexKey,
    horizon,
    membership: {
      syncId: sync?.id ?? null,
      syncedAt: sync?.completedAt?.toISOString() ?? null,
      sourceDigest: sync?.sourceDigest ?? null,
      summary: (sync?.summary ?? null) as unknown,
      constituentsTotal: constituents.length,
      constituentsInHorizon: inHorizon.length,
      byResolution,
      uniqueTradeableSecurities: securityIds.length,
      endUnknownPeriods: endUnknown,
      unresolved,
    },
    list: list
      ? {
          id: list.id,
          name: list.name,
          members: list._count.items,
          windows: listWindows,
        }
      : null,
    data: {
      datasets,
      securitiesWithPrices: perSecurity.length,
      earliestPrice: perSecurity.reduce<LocalDate | null>(
        (min, row) => (min === null || row.first < min ? row.first : min),
        null,
      ),
      latestPrice: perSecurity.reduce<LocalDate | null>(
        (max, row) => (max === null || row.last > max ? row.last : max),
        null,
      ),
      sessionsInCalendar: sessions.length,
      coverageByYear: [...coverageByYear.entries()]
        .sort()
        .map(([year, entry]) => ({
          year,
          averageMembers: Math.round(
            entry.memberSessions /
              Math.max(
                1,
                sessions.filter((session) => session.date.startsWith(year))
                  .length,
              ),
          ),
          memberSessions: entry.memberSessions,
          pricedMemberSessions: entry.pricedMemberSessions,
          pricedShare:
            entry.memberSessions === 0
              ? null
              : Math.round(
                  (entry.pricedMemberSessions / entry.memberSessions) * 10_000,
                ) / 10_000,
        })),
      securitiesWithInteriorGaps: missingInterior.length,
      interiorGapSessions: missingInterior.reduce(
        (total, row) => total + row.sessions,
        0,
      ),
      largestInteriorGaps: missingInterior
        .sort((left, right) => right.sessions - left.sessions)
        .slice(0, 25),
    },
    ingestion: {
      byStatus: Object.fromEntries(
        ingestion.map((row) => [
          row.status,
          {
            securities: row._count._all,
            providerRequests: row._sum.providerRequests ?? 0,
          },
        ]),
      ),
      failures: ingestionFailures.map((row) => ({
        symbol: row.security.providerSymbol,
        attempts: row.attempts,
        error: row.lastError,
      })),
    },
  };
}

async function datasetTotals(
  prisma: PrismaClient,
  securityIds: readonly string[],
) {
  const ids = [...securityIds];
  const [prices, derived, statements, insider, congress, splits, weekly] =
    await Promise.all([
      prisma.dailyPrice.aggregate({
        where: { securityId: { in: ids } },
        _count: { _all: true },
        _min: { date: true },
        _max: { date: true },
      }),
      prisma.dailyDerivedState.aggregate({
        where: { securityId: { in: ids } },
        _count: { _all: true },
        _min: { date: true },
        _max: { date: true },
      }),
      prisma.financialStatement.aggregate({
        where: { securityId: { in: ids } },
        _count: { _all: true },
        _min: { fiscalDate: true },
        _max: { fiscalDate: true },
      }),
      prisma.insiderTransaction.aggregate({
        where: { securityId: { in: ids } },
        _count: { _all: true },
        _min: { availableFromDate: true },
        _max: { availableFromDate: true },
      }),
      prisma.congressTrade.aggregate({
        where: { securityId: { in: ids } },
        _count: { _all: true },
        _min: { availableFromDate: true },
        _max: { availableFromDate: true },
      }),
      prisma.stockSplit.aggregate({
        where: { securityId: { in: ids } },
        _count: { _all: true },
      }),
      prisma.weeklyPrice.aggregate({
        where: { securityId: { in: ids } },
        _count: { _all: true },
      }),
    ]);
  const securitiesWith = async (table: string): Promise<number> => {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(DISTINCT "securityId") AS count FROM "${table}" WHERE "securityId" = ANY($1::text[])`,
      ids,
    );
    return Number(rows[0]?.count ?? 0);
  };
  return {
    dailyPrices: {
      rows: prices._count._all,
      securities: await securitiesWith("DailyPrice"),
      earliest: iso(prices._min.date),
      latest: iso(prices._max.date),
    },
    dailyDerivedState: {
      rows: derived._count._all,
      securities: await securitiesWith("DailyDerivedState"),
      earliest: iso(derived._min.date),
      latest: iso(derived._max.date),
    },
    financialStatements: {
      rows: statements._count._all,
      securities: await securitiesWith("FinancialStatement"),
      earliestFiscalDate: iso(statements._min.fiscalDate),
      latestFiscalDate: iso(statements._max.fiscalDate),
    },
    insiderTransactions: {
      rows: insider._count._all,
      securities: await securitiesWith("InsiderTransaction"),
      earliestAvailable: iso(insider._min.availableFromDate),
      latestAvailable: iso(insider._max.availableFromDate),
    },
    congressTrades: {
      rows: congress._count._all,
      securities: await securitiesWith("CongressTrade"),
      earliestAvailable: iso(congress._min.availableFromDate),
      latestAvailable: iso(congress._max.availableFromDate),
    },
    stockSplits: {
      rows: splits._count._all,
      securities: await securitiesWith("StockSplit"),
    },
    weeklyPrices: { rows: weekly._count._all },
  };
}

async function perSecurityPriceBounds(
  prisma: PrismaClient,
  securityIds: readonly string[],
) {
  const rows = await prisma.$queryRawUnsafe<
    { securityId: string; first: Date; last: Date; count: bigint }[]
  >(
    `SELECT "securityId", min(date) AS first, max(date) AS last, count(*) AS count
       FROM "DailyPrice" WHERE "securityId" = ANY($1::text[]) GROUP BY "securityId"`,
    [...securityIds],
  );
  return rows.map((row) => ({
    securityId: row.securityId,
    first: iso(row.first) as LocalDate,
    last: iso(row.last) as LocalDate,
    count: Number(row.count),
  }));
}

/** Sessions of the universe's own price history, each with the securities priced on it. */
async function sessionMembership(
  prisma: PrismaClient,
  securityIds: readonly string[],
) {
  const rows = await prisma.$queryRawUnsafe<{ date: Date; ids: string[] }[]>(
    `SELECT date, array_agg("securityId") AS ids FROM "DailyPrice"
      WHERE "securityId" = ANY($1::text[]) GROUP BY date ORDER BY date`,
    [...securityIds],
  );
  const counts = rows.map((row) => row.ids.length);
  // A session is a date at least a fifth as many securities printed as the busiest nearby date.
  return rows
    .filter((row, index) => {
      const window = counts.slice(Math.max(0, index - 10), index + 11);
      return row.ids.length * 5 >= Math.max(...window);
    })
    .map((row) => ({
      date: iso(row.date) as LocalDate,
      priced: new Set(row.ids),
    }));
}
