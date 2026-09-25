import type { PrismaClient } from "@intrinsic/database";
import type { AuditWriter } from "../artifacts";
import { ComparisonLedger } from "../comparison";
import {
  ORACLE_RELATIVE_VOLUMES,
  oracleRelativeVolume,
  type OracleRelativeVolumeColumn,
} from "../oracle/relative-volume";

/**
 * Every stored Relative Volume value of every audited security, for its whole persisted history,
 * against the reference recomputed from that security's own `DailyPrice.volume` column.
 *
 * The three periods are checked independently rather than through one shared traversal, because the
 * defect this section exists to catch is a *period* defect: until `RVOL 10`, `RVOL 20` and `RVOL 50`
 * were given distinct semantic identities they shared one fingerprint, and a bug that served one
 * period's column for another would be invisible to any check that compared a period against
 * itself. So the reference is computed from the volume series three times, and each stored column is
 * required to match its own period and to differ from the other two wherever the data says it
 * should.
 *
 * Absence is compared exactly. A warm-up value the engine stores where the reference has none — or
 * the reverse — is a failure, not a rounding difference: the first `p` sessions of a series have no
 * baseline, and a value there would mean a shorter window was silently substituted.
 *
 * Tolerance, per value: half a unit in the eighth decimal, which is what `Decimal(20,8)` storage
 * quantizes to, plus a relative term for the float64 division the engine performs. The reference
 * divides in exact decimal arithmetic, so the whole difference is the engine's.
 */

export const RVOL_TOLERANCE = (value: number): number =>
  0.5e-8 + 1e-12 * Math.max(1, Math.abs(value));

type StoredRow = {
  date: string;
  rvol10: string | null;
  rvol20: string | null;
  rvol50: string | null;
};

export async function readStoredRelativeVolumes(
  prisma: PrismaClient,
  securityId: string,
): Promise<StoredRow[]> {
  return prisma.$queryRawUnsafe<StoredRow[]>(
    `select date::text as date,
            "rvol10"::text as "rvol10",
            "rvol20"::text as "rvol20",
            "rvol50"::text as "rvol50"
       from "DailyDerivedState" where "securityId" = $1 order by date`,
    securityId,
  );
}

export async function readVolumes(
  prisma: PrismaClient,
  securityId: string,
): Promise<{ date: string; volume: number | null }[]> {
  const rows = await prisma.$queryRawUnsafe<
    { date: string; volume: string | null }[]
  >(
    `select date::text as date, volume::text as volume
       from "DailyPrice" where "securityId" = $1 order by date`,
    securityId,
  );
  return rows.map((row) => ({
    date: row.date,
    volume: row.volume === null ? null : Number(row.volume),
  }));
}

export type RelativeVolumeSectionResult = {
  ledger: ComparisonLedger;
  perPeriod: Record<
    string,
    {
      compared: number;
      failed: number;
      storedValues: number;
      maxAbsDifference: number;
      absenceMismatches: number;
    }
  >;
  perSecurity: Record<
    string,
    { compared: number; failed: number; firstValue: Record<string, string | null> }
  >;
  /** Sessions where two periods' stored values were identical although the reference says otherwise. */
  periodCollisions: number;
  warmupRegion: { compared: number; failed: number };
};

export async function runRelativeVolumeSection(input: {
  prisma: PrismaClient;
  writer: AuditWriter;
  securities: readonly { securityId: string; symbol: string }[];
  /** The product horizon; rows before it are checked into a separate ledger. */
  horizonStart: string;
  log: (line: string) => void;
}): Promise<RelativeVolumeSectionResult> {
  const { prisma, writer } = input;
  const ledger = new ComparisonLedger(400);
  const warmup = new ComparisonLedger(50);
  const perPeriod: RelativeVolumeSectionResult["perPeriod"] = {};
  const perSecurity: RelativeVolumeSectionResult["perSecurity"] = {};
  let periodCollisions = 0;

  for (const security of input.securities) {
    const bars = await readVolumes(prisma, security.securityId);
    const stored = await readStoredRelativeVolumes(prisma, security.securityId);
    const indexOf = new Map(bars.map((bar, index) => [bar.date, index]));
    const volumes = bars.map((bar) => bar.volume);
    const reference = new Map<OracleRelativeVolumeColumn, (string | null)[]>();
    for (const entry of ORACLE_RELATIVE_VOLUMES) {
      reference.set(
        entry.column,
        oracleRelativeVolume(volumes, entry.period).map((value) =>
          value === null ? null : value.toString(),
        ),
      );
    }

    const before = { compared: ledger.compared, failed: ledger.failed };
    const mismatches: Record<string, unknown>[] = [];
    const samples: Record<string, unknown>[] = [];
    const firstValue: Record<string, string | null> = {};

    for (const row of stored) {
      const index = indexOf.get(row.date);
      if (index === undefined) {
        ledger.check(
          "relative-volume",
          `${security.symbol} ${row.date} has a DailyPrice row`,
          true,
          false,
          "exact-number",
        );
        continue;
      }
      const visible = row.date >= input.horizonStart;
      const target = visible ? ledger : warmup;
      const storedByColumn: Record<string, number | null> = {};

      for (const entry of ORACLE_RELATIVE_VOLUMES) {
        const expectedText = reference.get(entry.column)![index] ?? null;
        const actualText = row[entry.column];
        const expected = expectedText === null ? null : Number(expectedText);
        const actual = actualText === null ? null : Number(actualText);
        storedByColumn[entry.column] = actual;
        if (visible && actual !== null && firstValue[entry.column] === undefined) {
          firstValue[entry.column] = row.date;
        }
        const stats = (perPeriod[entry.column] ??= {
          compared: 0,
          failed: 0,
          storedValues: 0,
          maxAbsDifference: 0,
          absenceMismatches: 0,
        });
        let ok: boolean;
        if (expected === null || actual === null) {
          // Absence must agree exactly: one side holding a number the other does not means a
          // warm-up boundary moved, which is a methodology difference rather than a rounding one.
          ok = target.check(
            "relative-volume",
            `${security.symbol} ${row.date} ${entry.column}`,
            expected,
            actual,
            "exact-number",
          );
          if (!ok && visible) {
            stats.absenceMismatches += 1;
          }
        } else {
          ok = target.check(
            "relative-volume",
            `${security.symbol} ${row.date} ${entry.column}`,
            expected,
            actual,
            {
              tolerance: RVOL_TOLERANCE(expected),
              justification:
                "Decimal(20,8) storage quantization + float64 division",
            },
          );
          if (visible) {
            stats.maxAbsDifference = Math.max(
              stats.maxAbsDifference,
              Math.abs(actual - expected),
            );
            stats.storedValues += 1;
          }
        }
        if (visible) {
          stats.compared += 1;
          if (!ok) {
            stats.failed += 1;
            if (mismatches.length < 40) {
              mismatches.push({
                date: row.date,
                column: entry.column,
                expected,
                actual,
                volume: bars[index]?.volume ?? null,
              });
            }
          }
        }
      }

      // Two periods holding the identical stored value where the reference says they differ is the
      // shape a period-identity collision would take in the data: one column serving another's
      // number. It is reported rather than asserted, because two periods legitimately agree on a
      // session whose volume happens to sit at both means.
      if (visible) {
        const ten = storedByColumn["rvol10"];
        const twenty = storedByColumn["rvol20"];
        const fifty = storedByColumn["rvol50"];
        const referenceDiffers =
          reference.get("rvol10")![index] !== reference.get("rvol20")![index] ||
          reference.get("rvol10")![index] !== reference.get("rvol50")![index];
        const storedAgree =
          ten !== null &&
          ten !== undefined &&
          ten === twenty &&
          ten === fifty;
        if (referenceDiffers && storedAgree) {
          periodCollisions += 1;
        }
      }

      if (visible && samples.length < 6 && index % 1500 === 0) {
        samples.push({
          date: row.date,
          volume: bars[index]?.volume ?? null,
          ...Object.fromEntries(
            ORACLE_RELATIVE_VOLUMES.map((entry) => [
              entry.column,
              {
                expected: reference.get(entry.column)![index] ?? null,
                actual: row[entry.column],
              },
            ]),
          ),
        });
      }
    }

    perSecurity[security.symbol] = {
      compared: ledger.compared - before.compared,
      failed: ledger.failed - before.failed,
      firstValue,
    };
    writer.writeJson(`relative-volume/${security.symbol}.json`, {
      symbol: security.symbol,
      securityId: security.securityId,
      priceRows: bars.length,
      derivedRows: stored.length,
      visibleFrom: input.horizonStart,
      firstStoredValue: firstValue,
      compared: perSecurity[security.symbol]!.compared,
      failed: perSecurity[security.symbol]!.failed,
      samples,
      mismatches,
    });
    input.log(
      `  relative-volume ${security.symbol}: ${perSecurity[security.symbol]!.compared} compared, ${perSecurity[security.symbol]!.failed} failed`,
    );
  }

  return {
    ledger,
    perPeriod,
    perSecurity,
    periodCollisions,
    warmupRegion: { compared: warmup.compared, failed: warmup.failed },
  };
}
