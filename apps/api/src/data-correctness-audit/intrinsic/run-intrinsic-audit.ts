import type { PrismaClient } from "@intrinsic/database";
import type { AuditWriter } from "../artifacts";
import { ComparisonLedger } from "../comparison";
import {
  dailyValuations,
  type BlendId,
  type ModelId,
  type OracleStatement,
  type Valuation,
} from "../oracle/intrinsic";

/**
 * Every stored intrinsic value, blend and provenance instant of every audited security against the
 * reference engine, recomputed from the security's persisted `FinancialStatement` revisions.
 */

export const INTRINSIC_TOLERANCE = (value: number): number =>
  0.5e-8 + 1e-12 * Math.max(1, Math.abs(value));

const MODEL_COLUMNS: Record<ModelId, { value: string; source: string }> = {
  DCF_FCFF: { value: "dcfFcff", source: "dcfFcffSourceAsOf" },
  RESIDUAL_INCOME: {
    value: "residualIncome",
    source: "residualIncomeSourceAsOf",
  },
  DDM: { value: "ddm", source: "ddmSourceAsOf" },
  GRAHAM: { value: "graham", source: "grahamSourceAsOf" },
};
const BLEND_COLUMNS: Record<BlendId, string> = {
  BALANCED: "blendBalanced",
  CONSERVATIVE: "blendConservative",
  DIVIDEND: "blendDividend",
};

export async function readStatements(
  prisma: PrismaClient,
  securityId: string,
): Promise<OracleStatement[]> {
  const rows = await prisma.$queryRawUnsafe<
    (Omit<OracleStatement, "values"> & { values: Record<string, unknown> })[]
  >(
    `select "statementType"::text as "statementType", "fiscalYear", period::text as period,
            "fiscalDate"::text as "fiscalDate", "filingDate"::text as "filingDate",
            "availableFromDate"::text as "availableFromDate", to_char("observedAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') as "observedAt",
            "contentHash", "reportedCurrency", values
       from "FinancialStatement" where "securityId" = $1`,
    securityId,
  );
  return rows as OracleStatement[];
}

type StoredIntrinsicRow = Record<string, string | null> & { date: string };

async function readStoredIntrinsic(
  prisma: PrismaClient,
  securityId: string,
): Promise<StoredIntrinsicRow[]> {
  const columns = [
    ...Object.values(MODEL_COLUMNS).flatMap((column) => [
      `"${column.value}"::text as "${column.value}"`,
      `to_char("${column.source}", 'YYYY-MM-DD') as "${column.source}"`,
    ]),
    ...Object.values(BLEND_COLUMNS).map(
      (column) => `"${column}"::text as "${column}"`,
    ),
    `"intrinsicCurrency"`,
  ].join(", ");
  return prisma.$queryRawUnsafe<StoredIntrinsicRow[]>(
    `select date::text as date, ${columns} from "DailyDerivedState" where "securityId" = $1 order by date`,
    securityId,
  );
}

export type IntrinsicSecurityResult = {
  symbol: string;
  compared: number;
  failed: number;
  valuesPresent: Record<string, number>;
  valuesAbsent: Record<string, number>;
  unavailableReasons: Record<string, Record<string, number>>;
  pitViolations: number;
  implausibleFilingDates: number;
  availabilityRuleViolations: number;
};

export async function runIntrinsicSection(input: {
  prisma: PrismaClient;
  writer: AuditWriter;
  securities: readonly { securityId: string; symbol: string }[];
  horizonStart: string;
  log: (line: string) => void;
}): Promise<{
  ledger: ComparisonLedger;
  perSecurity: Record<string, IntrinsicSecurityResult>;
  perModel: Record<
    string,
    {
      compared: number;
      failed: number;
      present: number;
      absent: number;
      maxAbsDifference: number;
    }
  >;
  pit: {
    checks: number;
    violations: number;
    implausibleFilingDates: number;
    availabilityRuleViolations: number;
    statements: number;
  };
  references: Map<string, { dates: string[]; valuations: Valuation[] }>;
}> {
  const { prisma, writer } = input;
  const ledger = new ComparisonLedger(400);
  const perSecurity: Record<string, IntrinsicSecurityResult> = {};
  const perModel: Record<
    string,
    {
      compared: number;
      failed: number;
      present: number;
      absent: number;
      maxAbsDifference: number;
    }
  > = {};
  const pit = {
    checks: 0,
    violations: 0,
    implausibleFilingDates: 0,
    availabilityRuleViolations: 0,
    statements: 0,
  };
  const references = new Map<
    string,
    { dates: string[]; valuations: Valuation[] }
  >();

  for (const security of input.securities) {
    const statements = await readStatements(prisma, security.securityId);
    const stored = await readStoredIntrinsic(prisma, security.securityId);
    const dates = stored.map((row) => row.date);
    const valuations = dailyValuations(statements, dates);
    references.set(security.securityId, { dates, valuations });
    const result: IntrinsicSecurityResult = {
      symbol: security.symbol,
      compared: 0,
      failed: 0,
      valuesPresent: {},
      valuesAbsent: {},
      unavailableReasons: {},
      pitViolations: 0,
      implausibleFilingDates: 0,
      availabilityRuleViolations: 0,
    };
    const before = { compared: ledger.compared, failed: ledger.failed };
    const mismatches: Record<string, unknown>[] = [];
    const quarterlySamples: Record<string, unknown>[] = [];

    // Point-in-time rules of the statements themselves.
    for (const statement of statements) {
      pit.statements += 1;
      const dayAfterFiling = new Date(
        Date.parse(`${statement.filingDate}T00:00:00Z`) + 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      pit.checks += 1;
      if (statement.availableFromDate < dayAfterFiling) {
        pit.availabilityRuleViolations += 1;
        result.availabilityRuleViolations += 1;
      }
      // A filing dated on (or before) the fiscal period end cannot be a real filing date: the
      // provider supplied the period end instead. Availability derived from it is look-ahead.
      if (statement.filingDate <= statement.fiscalDate) {
        pit.implausibleFilingDates += 1;
        result.implausibleFilingDates += 1;
      }
    }

    let lastQuarterSample = "";
    stored.forEach((row, index) => {
      const valuation = valuations[index]!;
      const visible = row.date >= input.horizonStart;
      for (const [model, columns] of Object.entries(MODEL_COLUMNS) as [
        ModelId,
        { value: string; source: string },
      ][]) {
        const outcome = valuation.models[model];
        const actualText = row[columns.value];
        const actual =
          actualText === null || actualText === undefined
            ? null
            : Number(actualText);
        const source = row[columns.source] ?? null;
        // PIT invariant on every stored row, visible or not: provenance never after the row date.
        if (actual !== null) {
          pit.checks += 1;
          if (source === null || source > row.date) {
            pit.violations += 1;
            result.pitViolations += 1;
          }
        }
        if (!visible) {
          continue;
        }
        const stats = (perModel[model] ??= {
          compared: 0,
          failed: 0,
          present: 0,
          absent: 0,
          maxAbsDifference: 0,
        });
        stats.compared += 1;
        const expected = outcome.status === "VALUE" ? outcome.value : null;
        if (expected === null) {
          stats.absent += 1;
          result.valuesAbsent[model] = (result.valuesAbsent[model] ?? 0) + 1;
          const reasons = (result.unavailableReasons[model] ??= {});
          const reason =
            outcome.status === "NOT_APPLICABLE" ? outcome.reason : "?";
          reasons[reason] = (reasons[reason] ?? 0) + 1;
        } else {
          stats.present += 1;
          result.valuesPresent[model] = (result.valuesPresent[model] ?? 0) + 1;
        }
        let ok: boolean;
        if (expected === null || actual === null) {
          ok = ledger.check(
            "intrinsic",
            `${security.symbol} ${row.date} ${model}`,
            expected,
            actual,
            "exact-number",
          );
        } else {
          ok = ledger.check(
            "intrinsic",
            `${security.symbol} ${row.date} ${model}`,
            expected,
            actual,
            {
              tolerance: INTRINSIC_TOLERANCE(expected),
              justification:
                "Decimal(20,8) storage quantization + float64 evaluation order",
            },
          );
          stats.maxAbsDifference = Math.max(
            stats.maxAbsDifference,
            Math.abs(actual - expected),
          );
          ok =
            ledger.check(
              "intrinsic-provenance",
              `${security.symbol} ${row.date} ${model}.sourceAsOf`,
              outcome.status === "VALUE" ? outcome.sourceAsOf : null,
              source,
              "exact-text",
            ) && ok;
        }
        if (!ok) {
          stats.failed += 1;
          if (mismatches.length < 60) {
            mismatches.push({
              date: row.date,
              model,
              expected,
              actual,
              expectedSourceAsOf:
                outcome.status === "VALUE" ? outcome.sourceAsOf : null,
              actualSourceAsOf: source,
              reason:
                outcome.status === "NOT_APPLICABLE" ? outcome.reason : null,
              inputs: outcome.status === "VALUE" ? outcome.inputs : null,
            });
          }
        }
      }
      if (!visible) {
        return;
      }
      for (const [blend, column] of Object.entries(BLEND_COLUMNS) as [
        BlendId,
        string,
      ][]) {
        const expected = valuation.blends[blend]?.value ?? null;
        const actualText = row[column];
        const actual =
          actualText === null || actualText === undefined
            ? null
            : Number(actualText);
        const stats = (perModel[blend] ??= {
          compared: 0,
          failed: 0,
          present: 0,
          absent: 0,
          maxAbsDifference: 0,
        });
        stats.compared += 1;
        if (expected === null) {
          stats.absent += 1;
        } else {
          stats.present += 1;
        }
        const ok =
          expected === null || actual === null
            ? ledger.check(
                "intrinsic",
                `${security.symbol} ${row.date} ${blend}`,
                expected,
                actual,
                "exact-number",
              )
            : ledger.check(
                "intrinsic",
                `${security.symbol} ${row.date} ${blend}`,
                expected,
                actual,
                {
                  tolerance: INTRINSIC_TOLERANCE(expected),
                  justification:
                    "Decimal(20,8) storage quantization + float64 evaluation order",
                },
              );
        if (expected !== null && actual !== null) {
          stats.maxAbsDifference = Math.max(
            stats.maxAbsDifference,
            Math.abs(actual - expected),
          );
        }
        if (!ok) {
          stats.failed += 1;
          if (mismatches.length < 60) {
            mismatches.push({ date: row.date, model: blend, expected, actual });
          }
        }
      }
      // One sample per fiscal quarter change: the "quarterly intrinsic history" a reviewer can read.
      const signature = JSON.stringify(
        Object.values(valuation.models).map((outcome) =>
          outcome.status === "VALUE" ? outcome.sourceAsOf : outcome.reason,
        ),
      );
      if (signature !== lastQuarterSample && quarterlySamples.length < 400) {
        lastQuarterSample = signature;
        quarterlySamples.push({
          effectiveFrom: row.date,
          expected: Object.fromEntries(
            Object.entries(valuation.models).map(([model, outcome]) => [
              model,
              outcome.status === "VALUE"
                ? {
                    value: outcome.value,
                    sourceAsOf: outcome.sourceAsOf,
                    inputs: outcome.inputs,
                  }
                : { unavailable: outcome.reason },
            ]),
          ),
          actual: Object.fromEntries(
            Object.entries(MODEL_COLUMNS).map(([model, columns]) => [
              model,
              { value: row[columns.value], sourceAsOf: row[columns.source] },
            ]),
          ),
          blends: Object.fromEntries(
            Object.entries(BLEND_COLUMNS).map(([blend, column]) => [
              blend,
              {
                expected: valuation.blends[blend as BlendId]?.value ?? null,
                actual: row[column],
              },
            ]),
          ),
        });
      }
    });
    result.compared = ledger.compared - before.compared;
    result.failed = ledger.failed - before.failed;
    perSecurity[security.symbol] = result;
    writer.writeJson(`intrinsic/${security.symbol}.json`, {
      ...result,
      mismatches,
      quarterlyHistory: quarterlySamples,
    });
    input.log(
      `  intrinsic ${security.symbol}: ${result.compared} compared, ${result.failed} failed, ` +
        `pit violations ${result.pitViolations}, implausible filing dates ${result.implausibleFilingDates}`,
    );
  }
  return { ledger, perSecurity, perModel, pit, references };
}
