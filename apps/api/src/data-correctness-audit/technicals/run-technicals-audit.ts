import type { PrismaClient } from "@intrinsic/database";
import type { AuditWriter } from "../artifacts";
import { ComparisonLedger } from "../comparison";
import {
  INDICATORS,
  isoWeekStart,
  referenceIndicators,
  type IndicatorColumn,
} from "../oracle/indicators";

/**
 * Every stored technical series of every audited security against the reference indicators,
 * recomputed from that security's persisted `DailyPrice` closes.
 *
 * Tolerance, per value: half a unit in the 8th decimal (the `Decimal(20,8)` column quantizes the
 * float) plus 1e-12 relative for float64 accumulation. Absence must match exactly: a warm-up value
 * the engine stores where the reference has none — or the reverse — is a failure.
 */

export const TECHNICAL_TOLERANCE = (value: number): number =>
  0.5e-8 + 1e-12 * Math.max(1, Math.abs(value));

type StoredRow = Record<string, string | null> & {
  date: string;
  weeklySourceWeekStart: string | null;
};

const COLUMNS = INDICATORS.map((indicator) => indicator.column);

export async function readStoredTechnicals(
  prisma: PrismaClient,
  securityId: string,
): Promise<StoredRow[]> {
  const select = COLUMNS.map(
    (column) => `"${column}"::text as "${column}"`,
  ).join(", ");
  return prisma.$queryRawUnsafe<StoredRow[]>(
    `select date::text as date, "weeklySourceWeekStart"::text as "weeklySourceWeekStart", ${select}
       from "DailyDerivedState" where "securityId" = $1 order by date`,
    securityId,
  );
}

export async function readCloses(
  prisma: PrismaClient,
  securityId: string,
): Promise<{ date: string; close: number }[]> {
  const rows = await prisma.$queryRawUnsafe<{ date: string; close: string }[]>(
    `select date::text as date, close::text as close from "DailyPrice" where "securityId" = $1 order by date`,
    securityId,
  );
  return rows.map((row) => ({ date: row.date, close: Number(row.close) }));
}

export type SecurityIndicators = {
  dates: string[];
  values: Map<IndicatorColumn, (number | null)[]>;
  weekStart: (string | null)[];
};

/** The reference series for one security, from its persisted closes. */
export async function referenceForSecurity(
  prisma: PrismaClient,
  securityId: string,
  ipoDate: string | null,
  asOf: string,
): Promise<SecurityIndicators> {
  const closes = await readCloses(prisma, securityId);
  const first = closes[0]?.date ?? null;
  // Stored history that starts after the listing was cut by the retention horizon; a first ISO week
  // that the cut truncates is not a real week and is dropped, exactly as a listing week is kept.
  const truncatedByHorizon =
    first !== null && (ipoDate === null || ipoDate < first);
  const dropFirstWeek =
    truncatedByHorizon && first !== null && isoWeekStart(first) !== first
      ? isoWeekStart(first)
      : null;
  const reference = referenceIndicators(closes, { asOf, dropFirstWeek });
  return {
    dates: closes.map((row) => row.date),
    values: reference.values,
    weekStart: reference.weekStart,
  };
}

export async function runTechnicalsSection(input: {
  prisma: PrismaClient;
  writer: AuditWriter;
  securities: readonly {
    securityId: string;
    symbol: string;
    ipoDate: string | null;
  }[];
  horizonStart: string;
  asOf: string;
  log: (line: string) => void;
}): Promise<{
  ledger: ComparisonLedger;
  perIndicator: Record<
    string,
    {
      compared: number;
      failed: number;
      maxAbsDifference: number;
      nullMismatches: number;
    }
  >;
  perSecurity: Record<string, { compared: number; failed: number }>;
  weekStartMismatches: number;
  warmupRegion: { compared: number; failed: number };
  references: Map<string, SecurityIndicators>;
}> {
  const { prisma, writer } = input;
  const ledger = new ComparisonLedger(400);
  const warmup = new ComparisonLedger(50);
  const perIndicator: Record<
    string,
    {
      compared: number;
      failed: number;
      maxAbsDifference: number;
      nullMismatches: number;
    }
  > = {};
  const perSecurity: Record<string, { compared: number; failed: number }> = {};
  let weekStartMismatches = 0;
  const references = new Map<string, SecurityIndicators>();

  for (const security of input.securities) {
    const reference = await referenceForSecurity(
      prisma,
      security.securityId,
      security.ipoDate,
      input.asOf,
    );
    references.set(security.securityId, reference);
    const stored = await readStoredTechnicals(prisma, security.securityId);
    const indexOf = new Map(
      reference.dates.map((date, index) => [date, index]),
    );
    const before = { compared: ledger.compared, failed: ledger.failed };
    const samples: Record<string, unknown>[] = [];
    const mismatchSamples: Record<string, unknown>[] = [];
    ledger.check(
      "technicals",
      `${security.symbol} derived rows == price rows`,
      reference.dates.length,
      stored.length,
      "exact-number",
    );
    for (const row of stored) {
      const index = indexOf.get(row.date);
      if (index === undefined) {
        ledger.check(
          "technicals",
          `${security.symbol} ${row.date} has a DailyPrice row`,
          true,
          false,
          "exact-number",
        );
        continue;
      }
      const visible = row.date >= input.horizonStart;
      const target = visible ? ledger : warmup;
      // The last completed week is only decidable for rows before the as-of week.
      const decidableWeek = isoWeekStart(row.date) < isoWeekStart(input.asOf);
      for (const indicator of INDICATORS) {
        if (indicator.timeframe === "W" && !decidableWeek) {
          continue;
        }
        const expected = reference.values.get(indicator.column)![index] ?? null;
        const actualText = row[indicator.column];
        const actual =
          actualText === null || actualText === undefined
            ? null
            : Number(actualText);
        const stats = (perIndicator[indicator.column] ??= {
          compared: 0,
          failed: 0,
          maxAbsDifference: 0,
          nullMismatches: 0,
        });
        let ok: boolean;
        if (expected === null || actual === null) {
          ok = target.check(
            "technicals",
            `${security.symbol} ${row.date} ${indicator.column}`,
            expected,
            actual,
            "exact-number",
          );
          if (!ok && visible) {
            stats.nullMismatches += 1;
          }
        } else {
          ok = target.check(
            "technicals",
            `${security.symbol} ${row.date} ${indicator.column}`,
            expected,
            actual,
            {
              tolerance: TECHNICAL_TOLERANCE(expected),
              justification:
                "Decimal(20,8) storage quantization + float64 accumulation",
            },
          );
          if (visible) {
            stats.maxAbsDifference = Math.max(
              stats.maxAbsDifference,
              Math.abs(actual - expected),
            );
          }
        }
        if (visible) {
          stats.compared += 1;
          if (!ok) {
            stats.failed += 1;
            if (mismatchSamples.length < 40) {
              mismatchSamples.push({
                date: row.date,
                field: indicator.column,
                expected,
                actual,
                difference:
                  expected !== null && actual !== null
                    ? actual - expected
                    : null,
              });
            }
          }
        }
      }
      if (decidableWeek && visible) {
        const expectedWeek = reference.weekStart[index] ?? null;
        if (expectedWeek !== row.weeklySourceWeekStart) {
          weekStartMismatches += 1;
          ledger.check(
            "technicals",
            `${security.symbol} ${row.date} weeklySourceWeekStart`,
            expectedWeek,
            row.weeklySourceWeekStart,
            "exact-text",
          );
        }
      }
      if (visible && samples.length < 6 && index % 1500 === 0) {
        samples.push({
          date: row.date,
          ...Object.fromEntries(
            INDICATORS.map((indicator) => [
              indicator.column,
              {
                expected:
                  reference.values.get(indicator.column)![index] ?? null,
                actual: row[indicator.column],
              },
            ]),
          ),
        });
      }
    }
    perSecurity[security.symbol] = {
      compared: ledger.compared - before.compared,
      failed: ledger.failed - before.failed,
    };
    writer.writeJson(`technicals/${security.symbol}.json`, {
      symbol: security.symbol,
      securityId: security.securityId,
      priceRows: reference.dates.length,
      derivedRows: stored.length,
      visibleFrom: input.horizonStart,
      compared: perSecurity[security.symbol]!.compared,
      failed: perSecurity[security.symbol]!.failed,
      samples,
      mismatches: mismatchSamples,
    });
    input.log(
      `  technicals ${security.symbol}: ${perSecurity[security.symbol]!.compared} compared, ${perSecurity[security.symbol]!.failed} failed`,
    );
  }
  return {
    ledger,
    perIndicator,
    perSecurity,
    weekStartMismatches,
    warmupRegion: { compared: warmup.compared, failed: warmup.failed },
    references,
  };
}
