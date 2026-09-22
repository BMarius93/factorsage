import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@intrinsic/database";
import type { AuditWriter } from "../artifacts";
import { readBacktestArchive } from "../backtests/archive-reader";
import { oracleSecurities } from "../backtests/audit-case";
import { readPersistedRun } from "../backtests/persisted-run";
import { readMatrixCases } from "../backtests/run-backtest-audit";
import { readStatements } from "../intrinsic/run-intrinsic-audit";
import { dailyValuations, type OracleStatement } from "../oracle/intrinsic";
import { runReferenceBacktest } from "../oracle/reference-backtester";
import { parseOracleStrategy } from "../oracle/strategy-model";
import { readdirSync } from "node:fs";

/**
 * Look-ahead impact of provider filing dates that equal the fiscal period end (AUD-03).
 *
 * FactorSage makes a statement available the day after its `filingDate`. When the provider has no
 * real filing date it reports the period end, so the statement becomes usable the day after the
 * quarter closes — weeks before any filing could exist. This measures what that does to the
 * Margin-of-Safety strategy (S09) in the matrix: the reference engine recomputes every intrinsic
 * value with those statements made available no earlier than the SEC's large-accelerated-filer
 * deadlines (40 days after a quarter, 60 days after a fiscal year), the reference backtester re-runs
 * every S09 case on the corrected operands, and the result is compared with the persisted run.
 *
 * This is an impact estimate under a stated assumption, not a claim about the true filing dates.
 */

const QUARTER_DEADLINE_DAYS = 40;
const ANNUAL_DEADLINE_DAYS = 60;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function correctedAvailability(
  statement: OracleStatement,
): OracleStatement {
  if (statement.filingDate > statement.fiscalDate) {
    return statement;
  }
  const earliest = addDays(
    statement.fiscalDate,
    statement.period === "FY" || statement.period === "Q4"
      ? ANNUAL_DEADLINE_DAYS
      : QUARTER_DEADLINE_DAYS,
  );
  return earliest > statement.availableFromDate
    ? { ...statement, availableFromDate: earliest }
    : statement;
}

export async function runFilingDateImpact(input: {
  prisma: PrismaClient;
  writer: AuditWriter;
  sweep: string;
  log: (line: string) => void;
}): Promise<Record<string, unknown>> {
  const { prisma, writer, sweep } = input;
  const cases = readMatrixCases(sweep).filter(
    (entry) => entry.caseId.startsWith("S09-") && entry.runId,
  );
  const archives = readdirSync(join(sweep, "archives"));
  const corrected = new Map<
    string,
    Map<
      string,
      { dcf: number | null; balanced: number | null; graham: number | null }
    >
  >();
  const affectedSecurities = new Set<string>();

  const valuesFor = async (securityId: string, dates: readonly string[]) => {
    let cached = corrected.get(securityId);
    if (cached) {
      return cached;
    }
    const statements = await readStatements(prisma, securityId);
    const adjusted = statements.map(correctedAvailability);
    if (adjusted.some((statement, index) => statement !== statements[index])) {
      affectedSecurities.add(securityId);
    }
    const valuations = dailyValuations(adjusted, dates);
    cached = new Map(
      dates.map((date, index) => {
        const valuation = valuations[index]!;
        const dcf = valuation.models.DCF_FCFF;
        const graham = valuation.models.GRAHAM;
        return [
          date,
          {
            dcf: dcf.status === "VALUE" ? dcf.value : null,
            balanced: valuation.blends.BALANCED?.value ?? null,
            graham: graham.status === "VALUE" ? graham.value : null,
          },
        ];
      }),
    );
    corrected.set(securityId, cached);
    return cached;
  };

  const perCase: Record<string, unknown>[] = [];
  let casesChanged = 0;
  let tradesBefore = 0;
  let tradesAfter = 0;
  for (const matrixCase of cases) {
    const name = archives.find((entry) => entry.includes(matrixCase.runId!));
    if (!name) {
      continue;
    }
    const archive = await readBacktestArchive(join(sweep, "archives", name));
    const securities = oracleSecurities(archive, []);
    for (const security of securities) {
      const dates = (
        await prisma.$queryRawUnsafe<{ date: string }[]>(
          `select date::text as date from "DailyPrice" where "securityId" = $1 order by date`,
          security.securityId,
        )
      ).map((row) => row.date);
      const values = await valuesFor(security.securityId, dates);
      for (const row of security.rows) {
        const value = values.get(row.date);
        const map = row.values as Map<string, number>;
        const mos = (iv: number | null): number | null =>
          iv === null || !(iv > 0) ? null : ((iv - row.close) / iv) * 100;
        const set = (key: string, next: number | null): void => {
          if (
            !map.has(key) &&
            !archive.frames.some((frame) => key in frame.operands)
          ) {
            return;
          }
          if (next === null) {
            map.delete(key);
          } else {
            map.set(key, next);
          }
        };
        set("margin-of-safety:DCF_FCFF", mos(value?.dcf ?? null));
        set("margin-of-safety:BALANCED", mos(value?.balanced ?? null));
        set("series:GRAHAM", value?.graham ?? null);
      }
    }
    const result = runReferenceBacktest({
      strategy: parseOracleStrategy(archive.snapshot.strategy.definition),
      securities,
      calendar: archive.calendar,
      startDate: archive.snapshot.period.startDate,
      endDate: archive.snapshot.period.endDate,
      initialCapital: archive.snapshot.capital.initialCapital,
      monthlyContribution: archive.snapshot.capital.monthlyContribution,
      maximumPositions: archive.snapshot.allocation.maximumPositions,
      benchmark: archive.benchmark,
    });
    const persisted = await readPersistedRun(prisma, matrixCase.runId!);
    const signature = (
      trades: readonly { date: string; symbol: string; action: string }[],
    ) => trades.map((trade) => `${trade.date}|${trade.symbol}|${trade.action}`);
    const before = signature(persisted.trades);
    const after = signature(result.trades);
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const removed = before.filter((entry) => !afterSet.has(entry));
    const added = after.filter((entry) => !beforeSet.has(entry));
    const changed = removed.length > 0 || added.length > 0;
    if (changed) {
      casesChanged += 1;
    }
    tradesBefore += before.length;
    tradesAfter += after.length;
    const finalBefore = Number(persisted.summary?.finalValue ?? 0);
    const finalAfter = Number(result.summary.finalValue);
    perCase.push({
      caseId: matrixCase.caseId,
      tradesPersisted: before.length,
      tradesCorrected: after.length,
      tradesOnlyWithLookAhead: removed.length,
      tradesOnlyWithoutLookAhead: added.length,
      finalValuePersisted: finalBefore,
      finalValueCorrected: finalAfter,
      finalValueChangePercent:
        finalBefore > 0
          ? ((finalAfter - finalBefore) / finalBefore) * 100
          : null,
      examples: {
        onlyWithLookAhead: removed.slice(0, 5),
        onlyWithoutLookAhead: added.slice(0, 5),
      },
    });
  }
  const symbols = await prisma.$queryRawUnsafe<{ symbol: string }[]>(
    `select symbol from "Security" where id = any($1) order by symbol`,
    [...affectedSecurities],
  );
  const summary = {
    assumption: `statements whose provider filing date is on or before the fiscal period end made available no earlier than fiscalDate + ${QUARTER_DEADLINE_DAYS} days (quarters) / + ${ANNUAL_DEADLINE_DAYS} days (fiscal year, Q4)`,
    securitiesAffected: symbols.map((row) => row.symbol),
    s09Cases: perCase.length,
    casesWithDifferentTrades: casesChanged,
    tradesPersisted: tradesBefore,
    tradesCorrected: tradesAfter,
    perCase: perCase.sort(
      (left, right) =>
        Number(right.tradesOnlyWithLookAhead) -
        Number(left.tradesOnlyWithLookAhead),
    ),
  };
  writer.writeJson("lookahead/filing-date-impact.json", summary);
  input.log(
    `  filing-date impact: ${casesChanged}/${perCase.length} S09 cases trade differently without the look-ahead`,
  );
  return { ...summary, perCase: undefined };
}

export function sweepHasArchives(sweep: string): boolean {
  return existsSync(join(sweep, "archives"));
}
