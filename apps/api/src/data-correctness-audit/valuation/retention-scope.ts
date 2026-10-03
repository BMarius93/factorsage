import type { PrismaClient } from "@intrinsic/database";
import {
  createValuationOracle,
  ORACLE_VALUATION_RATIO_IDS,
  type OracleValuationStatement,
} from "../oracle/valuation-ratios";
import { readOracleRows } from "./real-data";

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

type ScopeCell = {
  ratio: string;
  change: string;
  count: number;
  first: string;
  last: string;
  /** The withholding side's failing rules, with counts. */
  reasons: Record<string, number>;
};

/**
 * What the fundamentals retention changes, cell by cell (`REPORT.md` §5, interpretation 3): the
 * reference over the retained statement revisions — what the product reads — against the reference
 * over every stored row, on every stored session. The product equals the first everywhere (the
 * `real` run), so this is exactly what an audit fed every stored row would have reported.
 */
export async function retentionScope(
  prisma: PrismaClient,
  securityIds: readonly string[],
): Promise<{
  retainedAvailableAllRowsWithheld: number;
  retainedWithheldAllRowsAvailable: number;
  valuesDiffer: number;
  bySecurity: Record<
    string,
    { retentionFrom: string; outsideRetention: number; cells: ScopeCell[] }
  >;
}> {
  let retainedAvailableAllRowsWithheld = 0;
  let retainedWithheldAllRowsAvailable = 0;
  let valuesDiffer = 0;
  const bySecurity: Record<
    string,
    { retentionFrom: string; outsideRetention: number; cells: ScopeCell[] }
  > = {};
  for (const securityId of securityIds) {
    const rows = await readOracleRows(prisma, securityId);
    if (rows.outsideRetention === 0) {
      continue;
    }
    const everyRow = await prisma.$queryRawUnsafe<OracleValuationStatement[]>(
      `select "statementType"::text as "statementType",
              to_char("fiscalDate", 'YYYY-MM-DD') as "fiscalDate",
              "fiscalYear", period::text as period, "reportedCurrency",
              to_char("availableFromDate", 'YYYY-MM-DD') as "availableFromDate",
              to_char("observedAt", ${ISO}) as "observedAt",
              "contentHash", "values"
         from "FinancialStatement" where "securityId" = $1`,
      securityId,
    );
    const retained = createValuationOracle(rows.security);
    const everything = createValuationOracle({
      ...rows.security,
      statements: everyRow,
    });
    const cells = new Map<string, ScopeCell>();
    for (const session of rows.sessions) {
      const a = retained.reading(session.date, session.close);
      const b = everything.reading(session.date, session.close);
      for (const ratio of ORACLE_VALUATION_RATIO_IDS) {
        const kept = a[ratio];
        const all = b[ratio];
        let change: string | undefined;
        let reasons: readonly string[] = [];
        if (kept.available && !all.available) {
          change = "retained available, every row withheld";
          reasons = all.failing;
          retainedAvailableAllRowsWithheld += 1;
        } else if (!kept.available && all.available) {
          change = "retained withheld, every row available";
          reasons = kept.failing;
          retainedWithheldAllRowsAvailable += 1;
        } else if (
          kept.available &&
          all.available &&
          kept.value.n * all.value.d !== all.value.n * kept.value.d
        ) {
          change = "values differ";
          valuesDiffer += 1;
        }
        if (change === undefined) {
          continue;
        }
        const key = `${ratio} ${change}`;
        const cell = cells.get(key) ?? {
          ratio,
          change,
          count: 0,
          first: session.date,
          last: session.date,
          reasons: {},
        };
        cell.count += 1;
        cell.last = session.date;
        const reason = reasons.join(",");
        cell.reasons[reason] = (cell.reasons[reason] ?? 0) + 1;
        cells.set(key, cell);
      }
    }
    if (cells.size > 0) {
      bySecurity[rows.symbol] = {
        retentionFrom: rows.retentionFrom,
        outsideRetention: rows.outsideRetention,
        cells: [...cells.values()],
      };
    }
  }
  return {
    retainedAvailableAllRowsWithheld,
    retainedWithheldAllRowsAvailable,
    valuesDiffer,
    bySecurity,
  };
}

/**
 * The review's G3 in the store: securities whose walk starts with a count the very next quarter
 * contradicts by more than 25 %, and the readings taken on that first count. Rule 2 accepts a
 * walk's first count unconfirmed, so every one of them is available.
 */
export async function firstCountExposure(
  prisma: PrismaClient,
  securityIds: readonly string[],
): Promise<{
  securities: number;
  availableCells: number;
  rows: {
    symbol: string;
    firstQuarter: string;
    firstCount: number;
    nextQuarter: string;
    nextCount: number;
    nextOverFirst: number;
    from?: string;
    to?: string;
    sessions: number;
    availableCells: Record<string, number>;
  }[];
}> {
  const rows: Awaited<ReturnType<typeof firstCountExposure>>["rows"] = [];
  let availableCells = 0;
  for (const securityId of securityIds) {
    const data = await readOracleRows(prisma, securityId);
    if (data.security.verifiedAt === null) {
      continue;
    }
    // Each retained Income quarter: its first availability and the count it was first reported with.
    const quarters = new Map<
      number,
      { quarter: string; first: string; count?: number }
    >();
    for (const statement of data.security.statements) {
      if (statement.statementType !== "INCOME" || statement.period === "FY") {
        continue;
      }
      const rank = statement.fiscalYear * 4 + Number(statement.period.slice(1));
      const raw = statement.values.weightedAverageShsOutDil;
      const count = typeof raw === "number" && raw > 0 ? raw : undefined;
      const held = quarters.get(rank);
      if (!held || statement.availableFromDate < held.first) {
        quarters.set(rank, {
          quarter: `${statement.fiscalYear}${statement.period}`,
          first: statement.availableFromDate,
          ...(count !== undefined ? { count } : {}),
        });
      }
    }
    const counted = [...quarters.entries()]
      .filter(([, quarter]) => quarter.count !== undefined)
      .sort(([a], [b]) => a - b)
      .map(([, quarter]) => quarter);
    const [first, next] = counted;
    if (first === undefined || next === undefined) {
      continue;
    }
    const nextOverFirst = (next.count as number) / (first.count as number);
    if (Math.abs(nextOverFirst - 1) <= 0.25) {
      continue;
    }
    const oracle = createValuationOracle(data.security);
    const sessions = data.sessions.filter(
      (session) => session.date >= first.first && session.date < next.first,
    );
    const perRatio: Record<string, number> = {};
    for (const session of sessions) {
      const reading = oracle.reading(session.date, session.close);
      for (const ratio of ORACLE_VALUATION_RATIO_IDS) {
        if (reading[ratio].available) {
          perRatio[ratio] = (perRatio[ratio] ?? 0) + 1;
          availableCells += 1;
        }
      }
    }
    rows.push({
      symbol: data.symbol,
      firstQuarter: first.quarter,
      firstCount: first.count as number,
      nextQuarter: next.quarter,
      nextCount: next.count as number,
      nextOverFirst: Number(nextOverFirst.toFixed(4)),
      ...(sessions.length > 0
        ? {
            from: (sessions[0] as { date: string }).date,
            to: (sessions.at(-1) as { date: string }).date,
          }
        : {}),
      sessions: sessions.length,
      availableCells: perRatio,
    });
  }
  return { securities: rows.length, availableCells, rows };
}
