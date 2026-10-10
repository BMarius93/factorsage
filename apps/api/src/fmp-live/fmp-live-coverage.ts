import type { PrismaClient } from "@intrinsic/database";

/**
 * What the database holds for one security after a run: row counts and date bounds, per dataset.
 *
 * Read back from PostgreSQL rather than taken from what the loaders reported, because a run is
 * judged on what was stored. Counts and dates only — no row's content is read, so nothing a
 * report prints can carry provider data.
 */

export type LiveFmpStoredDataset = {
  readonly dataset: string;
  readonly rows: number;
  /** The date bound meaningful for the dataset; `null` when it has none or holds no rows. */
  readonly earliest: string | null;
  readonly latest: string | null;
  /** When the loader last synchronized it, where the dataset records that. */
  readonly lastSyncedAt: string | null;
};

type Bounds = {
  readonly _count: { readonly _all: number };
  readonly _min: Readonly<Record<string, Date | null>>;
  readonly _max: Readonly<Record<string, Date | null>>;
};

/** A stored statement's type, and the dataset its synchronization is recorded under. */
const STATEMENT_DATASETS = [
  ["INCOME", "INCOME_STATEMENT"],
  ["BALANCE_SHEET", "BALANCE_SHEET"],
  ["CASH_FLOW", "CASH_FLOW"],
] as const;

const day = (value: Date | null | undefined): string | null =>
  value ? value.toISOString().slice(0, 10) : null;

function bounded(
  dataset: string,
  aggregate: Bounds,
  field: string,
  lastSyncedAt: string | null = null,
): LiveFmpStoredDataset {
  return {
    dataset,
    rows: aggregate._count._all,
    earliest: day(aggregate._min[field]),
    latest: day(aggregate._max[field]),
    lastSyncedAt,
  };
}

export async function readLiveFmpStoredCoverage(
  prisma: PrismaClient,
  securityId: string,
): Promise<LiveFmpStoredDataset[]> {
  const where = { securityId };
  const [
    profile,
    prices,
    derived,
    statements,
    splits,
    insiders,
    congress,
    states,
  ] = await Promise.all([
    prisma.securityProfile.count({ where }),
    prisma.dailyPrice.aggregate({
      where,
      _count: { _all: true },
      _min: { date: true },
      _max: { date: true },
    }),
    prisma.dailyDerivedState.aggregate({
      where,
      _count: { _all: true },
      _min: { date: true },
      _max: { date: true },
    }),
    prisma.financialStatement.groupBy({
      by: ["statementType", "period"],
      where,
      _count: { _all: true },
      _min: { fiscalDate: true },
      _max: { fiscalDate: true },
    }),
    prisma.stockSplit.aggregate({
      where,
      _count: { _all: true },
      _min: { date: true },
      _max: { date: true },
    }),
    prisma.insiderTransaction.aggregate({
      where,
      _count: { _all: true },
      _min: { availableFromDate: true },
      _max: { availableFromDate: true },
    }),
    prisma.congressTrade.aggregate({
      where,
      _count: { _all: true },
      _min: { availableFromDate: true },
      _max: { availableFromDate: true },
    }),
    prisma.stockDatasetState.findMany({
      where,
      select: { dataset: true, lastSuccessfulSyncAt: true },
    }),
  ]);

  // The oldest sync of a dataset's variants: a dataset is as fresh as its stalest part.
  const syncedAt = (...datasets: string[]): string | null => {
    const instants = states
      .filter((state) => datasets.includes(state.dataset))
      .map((state) => state.lastSuccessfulSyncAt?.toISOString())
      .filter((value): value is string => value !== undefined)
      .sort();
    return instants[0] ?? null;
  };

  const statementRows = (
    [statementType, dataset]: (typeof STATEMENT_DATASETS)[number],
    cadence: "ANNUAL" | "QUARTERLY",
  ): LiveFmpStoredDataset => {
    const groups = statements.filter(
      (group) =>
        group.statementType === statementType &&
        (group.period === "FY") === (cadence === "ANNUAL"),
    );
    const earliest = groups
      .map((group) => group._min.fiscalDate)
      .filter((value): value is Date => value !== null)
      .sort((left, right) => left.getTime() - right.getTime())[0];
    const latest = groups
      .map((group) => group._max.fiscalDate)
      .filter((value): value is Date => value !== null)
      .sort((left, right) => right.getTime() - left.getTime())[0];
    return {
      dataset: `${dataset} ${cadence.toLowerCase()} (fiscal period end)`,
      rows: groups.reduce((sum, group) => sum + group._count._all, 0),
      earliest: day(earliest),
      latest: day(latest),
      lastSyncedAt: syncedAt(dataset),
    };
  };

  return [
    {
      dataset: "SECURITY_PROFILE",
      rows: profile,
      earliest: null,
      latest: null,
      lastSyncedAt: syncedAt("SECURITY_PROFILE"),
    },
    bounded("DAILY_PRICE", prices, "date", syncedAt("DAILY_PRICE")),
    bounded("DAILY_DERIVED_STATE", derived, "date"),
    ...STATEMENT_DATASETS.flatMap((statement) => [
      statementRows(statement, "QUARTERLY"),
      statementRows(statement, "ANNUAL"),
    ]),
    bounded("STOCK_SPLIT", splits, "date", syncedAt("STOCK_SPLIT")),
    bounded(
      "INSIDER_TRADE (available from)",
      insiders,
      "availableFromDate",
      syncedAt("INSIDER_TRADE"),
    ),
    bounded(
      "CONGRESS_TRADE (available from)",
      congress,
      "availableFromDate",
      syncedAt("CONGRESS_TRADE"),
    ),
  ];
}
