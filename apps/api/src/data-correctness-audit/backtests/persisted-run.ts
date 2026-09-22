import type { PrismaClient } from "@intrinsic/database";

/**
 * The run as PostgreSQL holds it — the durable result the API reads — with every decimal read as
 * PostgreSQL's own text rendering, so no float conversion stands between the database and the
 * comparison.
 */

export type PersistedTrade = {
  sequence: number;
  date: string;
  securityId: string;
  symbol: string;
  action: string;
  source: string;
  levelId: string | null;
  exitRuleId: string | null;
  levelPercentage: number | null;
  shares: string;
  price: string;
  amount: string;
  fees: string;
  realizedPnl: string | null;
  realizedPnlPercent: string | null;
  cashAfter: string;
  sharesAfter: string;
  averageCostAfter: string | null;
};

export type PersistedEquity = {
  date: string;
  cash: string;
  positionsValue: string;
  totalValue: string;
  investedCapital: string;
  returnIndex: string;
  benchmarkIndex: string | null;
  benchmarkValue: string | null;
  cashBaselineValue: string;
  openPositions: number;
};

export type PersistedSummary = Record<string, string | number | null>;

export type PersistedRun = {
  runId: string;
  status: string;
  startDate: string;
  endDate: string;
  trades: PersistedTrade[];
  equity: PersistedEquity[];
  summary: PersistedSummary | null;
  positions: number;
};

export async function readPersistedRun(
  prisma: PrismaClient,
  runId: string,
): Promise<PersistedRun> {
  const runs = await prisma.$queryRawUnsafe<
    { status: string; startDate: string; endDate: string }[]
  >(
    `select status::text as "status", "startDate"::text as "startDate", "endDate"::text as "endDate"
       from "BacktestRun" where id = $1`,
    runId,
  );
  const run = runs[0];
  if (!run) {
    throw new Error(`run ${runId} is not in the database`);
  }
  const trades = await prisma.$queryRawUnsafe<PersistedTrade[]>(
    `select sequence, date::text as date, "securityId", symbol, action::text as action,
            source::text as source, "levelId", "exitRuleId", "levelPercentage",
            shares::text as shares, price::text as price, amount::text as amount, fees::text as fees,
            "realizedPnl"::text as "realizedPnl", "realizedPnlPercent"::text as "realizedPnlPercent",
            "cashAfter"::text as "cashAfter", "sharesAfter"::text as "sharesAfter",
            "averageCostAfter"::text as "averageCostAfter"
       from "BacktestTrade" where "runId" = $1 order by sequence`,
    runId,
  );
  const equity = await prisma.$queryRawUnsafe<PersistedEquity[]>(
    `select date::text as date, cash::text as cash, "positionsValue"::text as "positionsValue",
            "totalValue"::text as "totalValue", "investedCapital"::text as "investedCapital",
            "returnIndex"::text as "returnIndex", "benchmarkIndex"::text as "benchmarkIndex",
            "benchmarkValue"::text as "benchmarkValue", "cashBaselineValue"::text as "cashBaselineValue",
            "openPositions"
       from "BacktestDailyEquity" where "runId" = $1 order by date`,
    runId,
  );
  const summaries = await prisma.$queryRawUnsafe<PersistedSummary[]>(
    `select "firstSimulatedDate"::text as "firstSimulatedDate", "lastSimulatedDate"::text as "lastSimulatedDate",
            "tradingDays", "investedCapital"::text as "investedCapital", "finalCash"::text as "finalCash",
            "finalPositionsValue"::text as "finalPositionsValue", "finalValue"::text as "finalValue",
            "netProfit"::text as "netProfit", "portfolioReturnPercent"::text as "portfolioReturnPercent",
            "benchmarkReturnPercent"::text as "benchmarkReturnPercent", "alphaPercent"::text as "alphaPercent",
            "portfolioCagrPercent"::text as "portfolioCagrPercent",
            "maxDrawdownPercent"::text as "maxDrawdownPercent",
            "benchmarkMaxDrawdownPercent"::text as "benchmarkMaxDrawdownPercent",
            "realizedPnl"::text as "realizedPnl", "unrealizedPnl"::text as "unrealizedPnl",
            "totalTrades", "buyTrades", "sellTrades", "finalExitTrades", "winningTrades",
            "losingTrades", "openPositions"
       from "BacktestRunSummary" where "runId" = $1`,
    runId,
  );
  const positions = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `select count(*) as count from "BacktestPosition" where "runId" = $1`,
    runId,
  );
  return {
    runId,
    status: run.status,
    startDate: run.startDate,
    endDate: run.endDate,
    trades,
    equity,
    summary: summaries[0] ?? null,
    positions: Number(positions[0]?.count ?? 0),
  };
}

/** Independent reads of the canonical inputs, for checks that do not trust the archive. */
export async function readCalendarDates(
  prisma: PrismaClient,
  seriesId: string,
  from: string,
  to: string,
): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ date: string }[]>(
    `select date::text as date from "BenchmarkDailyPrice"
      where "seriesId" = $1 and date between $2::date and $3::date order by date`,
    seriesId,
    from,
    to,
  );
  return rows.map((row) => row.date);
}

export async function readBenchmarkCloses(
  prisma: PrismaClient,
  seriesId: string,
  from: string,
  to: string,
): Promise<{ date: string; close: string }[]> {
  return prisma.$queryRawUnsafe<{ date: string; close: string }[]>(
    `select date::text as date, close::text as close from "BenchmarkDailyPrice"
      where "seriesId" = $1 and date between $2::date and $3::date order by date`,
    seriesId,
    from,
    to,
  );
}

export async function readDailyCloses(
  prisma: PrismaClient,
  securityId: string,
  from: string,
  to: string,
): Promise<{ date: string; close: string }[]> {
  return prisma.$queryRawUnsafe<{ date: string; close: string }[]>(
    `select date::text as date, close::text as close from "DailyPrice"
      where "securityId" = $1 and date between $2::date and $3::date order by date`,
    securityId,
    from,
    to,
  );
}
