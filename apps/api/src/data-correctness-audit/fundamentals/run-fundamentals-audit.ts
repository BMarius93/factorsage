import type { PrismaClient } from "@intrinsic/database";
import { DAILY_DERIVED_STATE_VARIANT } from "@intrinsic/stock-data";
import type { AuditWriter } from "../artifacts";
import type { FundamentalReference } from "../backtests/frame-provenance";
import { ComparisonLedger } from "../comparison";
import {
  ORACLE_FUNDAMENTAL_METRICS,
  oracleFundamentalOutcomes,
  type OracleFundamentalOutcome,
  type OracleFundamentalMetricId,
  type OracleFundamentalStatement,
} from "../oracle/fundamentals";
import { differentialAudit, type DifferentialReport } from "./differential";
import { AUDIT_HISTORY_PROFILES, generateHistory } from "./generated-history";

/**
 * The Fundamental Metrics section: every persisted reading of every audited security, for its whole
 * stored history, against the independent oracle recomputed from that security's own retained
 * `FinancialStatement` revisions — plus the eight seeded synthetic histories run through the
 * production materializer, for the situations real filings rarely produce.
 *
 * Availability is compared exactly: a stored number where the oracle says unavailable (or the
 * reverse) is a failure, never a rounding difference. Values are compared at storage precision:
 * the write path binds a double through sixteen significant digits and PostgreSQL rounds it to
 * eight decimals, so the tolerance is half a unit in the eighth decimal plus the sixteen-digit
 * binding's error at the value's magnitude.
 *
 * Only what the methodology retains is judged. The rebuild reads the revisions inside the
 * fundamentals retention — `[today - 30 - 7 years, today]`, clamped to the listing date
 * (`docs/decisions/fundamentals-loader.md`, "Valuation warm-up retention") — so the oracle is given
 * exactly those, restated here from the decision; revisions an earlier sync stored outside it (a
 * pre-listing quarter, for instance) are counted and reported, never silently used. And only rows
 * inside the security's current derived-state coverage are compared: a row outside it predates the
 * current retention and was never rebuilt under this methodology.
 *
 * It also checks the one upstream rule every reading depends on: no stored revision is available
 * before the day after its filing, or — for a period-end placeholder filing date — before the day
 * after its statutory deadline (`docs/decisions/fundamentals-loader.md`). The rule is restated here
 * rather than imported, so a loader defect cannot vouch for itself.
 *
 * The securities' stored values are returned as the frame-provenance audit's references, so a
 * backtest frame's `fundamental:*` column can be traced to exactly these rows.
 */

export const FUNDAMENTAL_STORAGE_TOLERANCE = (value: number): number =>
  0.5e-8 + Math.abs(value) * 1e-15 + 1e-12;

/** Thirty product years plus the seven-year valuation warm-up (`fundamentals-loader.md`). */
export const FUNDAMENTALS_RETENTION_YEARS = 37;

/** The same calendar day `years` earlier, 29 February falling back to the 28th. */
function yearsBefore(date: string, years: number): string {
  const year = Number(date.slice(0, 4)) - years;
  const candidate = `${String(year).padStart(4, "0")}${date.slice(4)}`;
  return date.slice(5) === "02-29" &&
    new Date(`${candidate}T00:00:00.000Z`).getUTCDate() !== 29
    ? `${String(year).padStart(4, "0")}-02-28`
    : candidate;
}

type StoredRow = { date: string } & Record<string, string | null>;

type StatementRow = {
  statementType: string;
  fiscalDate: string;
  fiscalYear: number;
  period: string;
  reportedCurrency: string;
  filingDate: string;
  availableFromDate: string;
  observedAt: Date;
  contentHash: string;
  values: Record<string, unknown>;
};

export type FundamentalMetricTally = {
  compared: number;
  available: number;
  unavailable: number;
  failed: number;
  maxAbsDifference: number;
};

export type FundamentalsSectionResult = {
  ledger: ComparisonLedger;
  perMetric: Record<OracleFundamentalMetricId, FundamentalMetricTally>;
  perSecurity: Record<
    string,
    {
      compared: number;
      failed: number;
      revisions: number;
      retainedRevisions: number;
      rows: number;
      rowsOutsideCoverage: number;
      retentionFrom: string;
    }
  >;
  /** Securities whose derived state predates Fundamental Metrics, and so cannot be judged. */
  notCurrent: string[];
  pitViolations: number;
  unavailableReasons: Record<string, number>;
  generated: DifferentialReport[];
  references: Map<string, FundamentalReference>;
};

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** The earliest date a statement may be used, restated from the loader decision (AUD-03). */
function earliestPublicDate(row: StatementRow): string {
  if (row.filingDate > row.fiscalDate) {
    return addDays(row.filingDate, 1);
  }
  let due = addDays(
    row.fiscalDate,
    row.period === "FY" || row.period === "Q4" ? 90 : 45,
  );
  const weekday = new Date(`${due}T00:00:00.000Z`).getUTCDay();
  due = weekday === 6 ? addDays(due, 2) : weekday === 0 ? addDays(due, 1) : due;
  return addDays(due, 1);
}

async function readStatements(
  prisma: PrismaClient,
  securityId: string,
): Promise<StatementRow[]> {
  return prisma.$queryRawUnsafe<StatementRow[]>(
    `select "statementType"::text as "statementType", "fiscalDate"::text as "fiscalDate", "fiscalYear",
            period::text as period, "reportedCurrency", "filingDate"::text as "filingDate",
            "availableFromDate"::text as "availableFromDate", "observedAt", "contentHash", "values"
       from "FinancialStatement" where "securityId" = $1`,
    securityId,
  );
}

async function readStored(
  prisma: PrismaClient,
  securityId: string,
): Promise<StoredRow[]> {
  const columns = ORACLE_FUNDAMENTAL_METRICS.map(
    (metric) => `"${metric.column}"::text as "${metric.column}"`,
  );
  return prisma.$queryRawUnsafe<StoredRow[]>(
    `select date::text as date, ${columns.join(", ")} from "DailyDerivedState" where "securityId" = $1 order by date`,
    securityId,
  );
}

function upperBound(sorted: readonly string[], date: string): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] as string) <= date) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export async function runFundamentalsSection(input: {
  prisma: PrismaClient;
  writer: AuditWriter;
  securities: readonly {
    securityId: string;
    symbol: string;
    ipoDate?: string | null;
  }[];
  log: (line: string) => void;
}): Promise<FundamentalsSectionResult> {
  const { prisma, writer } = input;
  const ledger = new ComparisonLedger(400);
  const perMetric = Object.fromEntries(
    ORACLE_FUNDAMENTAL_METRICS.map((metric) => [
      metric.id,
      {
        compared: 0,
        available: 0,
        unavailable: 0,
        failed: 0,
        maxAbsDifference: 0,
      },
    ]),
  ) as Record<OracleFundamentalMetricId, FundamentalMetricTally>;
  const perSecurity: FundamentalsSectionResult["perSecurity"] = {};
  const notCurrent: string[] = [];
  const unavailableReasons: Record<string, number> = {};
  const references = new Map<string, FundamentalReference>();
  let pitViolations = 0;

  for (const security of input.securities) {
    const coverage = await prisma.$queryRawUnsafe<
      { fromDate: string; toDate: string }[]
    >(
      `select "fromDate"::text as "fromDate", "toDate"::text as "toDate" from "StockDatasetCoverage"
        where "securityId" = $1 and dataset = 'DAILY_DERIVED_STATE' and variant = $2 order by "fromDate"`,
      security.securityId,
      DAILY_DERIVED_STATE_VARIANT,
    );
    if (coverage.length === 0) {
      notCurrent.push(security.symbol);
      ledger.skip(
        "fundamentals",
        security.symbol,
        `derived state is not ${DAILY_DERIVED_STATE_VARIANT}; rebuild it before auditing`,
      );
      continue;
    }
    const covered = (date: string) =>
      coverage.some((range) => date >= range.fromDate && date <= range.toDate);
    // "Today" of the rebuild that wrote this coverage: its newest covered day.
    const asOf = coverage
      .map((range) => range.toDate)
      .sort()
      .at(-1)!;
    const horizonFrom = yearsBefore(asOf, FUNDAMENTALS_RETENTION_YEARS);
    const retentionFrom =
      security.ipoDate && security.ipoDate > horizonFrom
        ? security.ipoDate
        : horizonFrom;
    const stored_ = await readStatements(prisma, security.securityId);
    const raw = stored_.filter(
      (row) => row.fiscalDate >= retentionFrom && row.fiscalDate <= asOf,
    );
    const statements: OracleFundamentalStatement[] = raw.map((row) => ({
      statementType:
        row.statementType as OracleFundamentalStatement["statementType"],
      fiscalDate: row.fiscalDate,
      fiscalYear: row.fiscalYear,
      period: row.period as OracleFundamentalStatement["period"],
      reportedCurrency: row.reportedCurrency,
      filingDate: row.filingDate,
      availableFromDate: row.availableFromDate,
      observedAt: row.observedAt.toISOString(),
      contentHash: row.contentHash,
      values: row.values,
    }));
    // Every stored revision, retained or not: availability before publication is look-ahead
    // wherever the row sits.
    for (const row of stored_) {
      const earliest = earliestPublicDate(row);
      if (row.availableFromDate < earliest) {
        pitViolations += 1;
        ledger.check(
          "fundamentals-pit",
          `${security.symbol} ${row.statementType} ${row.fiscalYear} ${row.period} ${row.fiscalDate} filed ${row.filingDate}`,
          `available on or after ${earliest}`,
          row.availableFromDate,
          "exact-text",
        );
      }
    }
    const allStored = await readStored(prisma, security.securityId);
    const stored = allStored.filter((row) => covered(row.date));
    const rowsOutsideCoverage = allStored.length - stored.length;
    if (rowsOutsideCoverage > 0) {
      ledger.skip(
        "fundamentals",
        `${security.symbol} ${rowsOutsideCoverage} row(s) outside ${DAILY_DERIVED_STATE_VARIANT} coverage`,
        "rows older than the current retention are never rebuilt or read under this methodology",
      );
    }
    const availability = statements
      .map((statement) => statement.availableFromDate)
      .sort();
    const memo = new Map<
      number,
      Record<OracleFundamentalMetricId, OracleFundamentalOutcome>
    >();
    const before = { compared: ledger.compared, failed: ledger.failed };
    const mismatches: Record<string, unknown>[] = [];

    for (const row of stored) {
      const eligible = upperBound(availability, row.date);
      let outcomes = memo.get(eligible);
      if (!outcomes) {
        outcomes = oracleFundamentalOutcomes(statements, row.date);
        memo.set(eligible, outcomes);
      }
      for (const metric of ORACLE_FUNDAMENTAL_METRICS) {
        const outcome = outcomes[metric.id];
        const text = row[metric.column] ?? null;
        const actual = text === null ? null : Number(text);
        const tally = perMetric[metric.id];
        tally.compared += 1;
        let ok: boolean;
        if (outcome.status === "UNAVAILABLE" || actual === null) {
          ok = ledger.check(
            "fundamentals",
            `${security.symbol} ${row.date} ${metric.id}`,
            outcome.status === "VALUE" ? outcome.value : null,
            actual,
            "exact-number",
          );
          if (outcome.status === "UNAVAILABLE") {
            unavailableReasons[outcome.reason] =
              (unavailableReasons[outcome.reason] ?? 0) + 1;
            if (ok) {
              tally.unavailable += 1;
            }
          }
        } else {
          ok = ledger.check(
            "fundamentals",
            `${security.symbol} ${row.date} ${metric.id}`,
            outcome.value,
            actual,
            {
              tolerance: FUNDAMENTAL_STORAGE_TOLERANCE(outcome.value),
              justification:
                "DECIMAL(20,8) storage of a double bound through sixteen significant digits",
            },
          );
          tally.maxAbsDifference = Math.max(
            tally.maxAbsDifference,
            Math.abs(actual - outcome.value),
          );
          if (ok) {
            tally.available += 1;
          }
        }
        if (!ok) {
          tally.failed += 1;
          if (mismatches.length < 40) {
            mismatches.push({
              date: row.date,
              metric: metric.id,
              expected:
                outcome.status === "VALUE"
                  ? outcome.value
                  : `unavailable (${outcome.reason})`,
              actual: text,
            });
          }
        }
      }
    }

    references.set(security.securityId, {
      dates: stored.map((row) => row.date),
      stored: Object.fromEntries(
        ORACLE_FUNDAMENTAL_METRICS.map((metric) => [
          metric.column,
          stored.map((row) =>
            row[metric.column] === null || row[metric.column] === undefined
              ? null
              : Number(row[metric.column]),
          ),
        ]),
      ),
    });
    perSecurity[security.symbol] = {
      compared: ledger.compared - before.compared,
      failed: ledger.failed - before.failed,
      revisions: stored_.length,
      retainedRevisions: raw.length,
      rows: stored.length,
      rowsOutsideCoverage,
      retentionFrom,
    };
    writer.writeJson(`fundamentals/${security.symbol}.json`, {
      symbol: security.symbol,
      securityId: security.securityId,
      retentionFrom,
      revisions: stored_.length,
      retainedRevisions: raw.length,
      derivedRows: stored.length,
      rowsOutsideCoverage,
      compared: perSecurity[security.symbol]!.compared,
      failed: perSecurity[security.symbol]!.failed,
      mismatches,
    });
    input.log(
      `  fundamentals ${security.symbol}: ${perSecurity[security.symbol]!.compared} compared, ${perSecurity[security.symbol]!.failed} failed`,
    );
  }

  // The seeded synthetic histories: about a million comparisons, a few seconds.
  const generated = AUDIT_HISTORY_PROFILES.map((profile) =>
    differentialAudit(generateHistory(profile)),
  );
  for (const report of generated) {
    ledger.compared += report.comparisons;
    ledger.passed += report.comparisons - report.mismatches;
    ledger.failed += report.mismatches;
    input.log(
      `  fundamentals generated ${report.history} (seed ${report.seed}): ${report.comparisons} compared, ${report.available} available, ${report.unavailable} unavailable, ${report.mismatches} mismatches`,
    );
  }

  return {
    ledger,
    perMetric,
    perSecurity,
    notCurrent,
    pitViolations,
    unavailableReasons,
    generated,
    references,
  };
}
