import type { PrismaClient } from "@intrinsic/database";
import {
  isBuyWindowEligible,
  normalizeBuyWindowRanges,
  type BuyWindowRange,
} from "@intrinsic/domain";
import type { AuditWriter } from "../artifacts";
import { ComparisonLedger } from "../comparison";

/**
 * Lists and Buy Windows.
 *
 * 1. Normalization and eligibility (production) against a day-by-day reference: a set of ranges is
 *    the set of calendar dates it covers, and normalization must preserve that set exactly while
 *    producing sorted, non-overlapping, non-adjacent ranges with at most one open end, last.
 * 2. The matrix itself, read from PostgreSQL: every BUY inside its frozen window; SELL and FINAL
 *    EXIT observed outside windows (they are not gated); BUYs landing exactly on window boundaries.
 */

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function covered(ranges: readonly BuyWindowRange[], date: string): boolean {
  return ranges.some(
    (range) =>
      range.startDate <= date &&
      (range.endDate === null || date <= range.endDate),
  );
}

export async function runBuyWindowAudit(input: {
  prisma: PrismaClient;
  writer: AuditWriter;
}): Promise<{
  ledger: ComparisonLedger;
  evidence: Record<string, number>;
}> {
  const ledger = new ComparisonLedger(200);
  // Days around a leap day, a month end and a year end.
  const origin = "2023-12-20";
  const probeDays = Array.from({ length: 90 }, (_, index) =>
    addDays(origin, index),
  ).concat(["2024-02-29", "2023-02-28", "2025-03-01"]);
  let seed = 7;
  const random = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = (): string => addDays(origin, Math.floor(random() * 80));
  const fixed: BuyWindowRange[][] = [
    [
      { startDate: "2024-02-28", endDate: "2024-02-29" },
      { startDate: "2024-03-01", endDate: "2024-03-02" },
    ], // adjacent across a leap day
    [
      { startDate: "2024-01-01", endDate: "2024-01-10" },
      { startDate: "2024-01-05", endDate: "2024-01-20" },
    ], // overlapping
    [{ startDate: "2024-01-01", endDate: "2024-01-01" }], // one day
    [{ startDate: "2024-02-29", endDate: null }], // open from a leap day
    [
      { startDate: "2024-01-15", endDate: null },
      { startDate: "2024-01-01", endDate: "2024-01-14" },
    ], // adjacent then open
    [
      { startDate: "2023-12-31", endDate: "2023-12-31" },
      { startDate: "2024-01-01", endDate: "2024-01-01" },
    ], // across a year boundary
    [
      { startDate: "2024-01-10", endDate: "2024-01-20" },
      { startDate: "2024-01-12", endDate: "2024-01-15" },
    ], // nested
    [
      { startDate: "2024-01-01", endDate: "2024-01-05" },
      { startDate: "2024-01-07", endDate: "2024-01-09" },
    ], // one-day gap stays a gap
  ];
  const generated: BuyWindowRange[][] = Array.from({ length: 1500 }, () => {
    const count = 1 + Math.floor(random() * 4);
    return Array.from({ length: count }, () => {
      const start = pick();
      const open = random() < 0.15;
      return {
        startDate: start,
        endDate: open ? null : addDays(start, Math.floor(random() * 12)),
      };
    });
  });
  let cases = 0;
  for (const ranges of [...fixed, ...generated]) {
    cases += 1;
    const normalized = normalizeBuyWindowRanges(ranges);
    const label = JSON.stringify(ranges);
    // Structural canonical form.
    let canonical = true;
    normalized.forEach((range, index) => {
      if (range.endDate !== null && range.endDate < range.startDate) {
        canonical = false;
      }
      if (range.endDate === null && index !== normalized.length - 1) {
        canonical = false;
      }
      const next = normalized[index + 1];
      if (
        next &&
        (range.endDate === null || addDays(range.endDate, 1) >= next.startDate)
      ) {
        canonical = false;
      }
    });
    ledger.check(
      "buy-windows",
      `${label} canonical`,
      true,
      canonical,
      "exact-number",
    );
    for (const day of probeDays) {
      const reference = covered(ranges, day);
      ledger.check(
        "buy-windows",
        `${label} ${day} covered after normalization`,
        reference,
        covered(normalized, day),
        "exact-number",
      );
      ledger.check(
        "buy-windows",
        `${label} ${day} isBuyWindowEligible`,
        reference,
        isBuyWindowEligible({ mode: "CUSTOM", ranges: normalized }, day),
        "exact-number",
      );
    }
    // Idempotent.
    ledger.check(
      "buy-windows",
      `${label} idempotent`,
      JSON.stringify(normalized),
      JSON.stringify(normalizeBuyWindowRanges(normalized)),
      "exact-text",
    );
  }
  for (const day of probeDays) {
    ledger.check(
      "buy-windows",
      `FULL ${day}`,
      true,
      isBuyWindowEligible({ mode: "FULL", ranges: [] }, day),
      "exact-number",
    );
  }

  // Matrix evidence straight from PostgreSQL.
  const rows = await input.prisma.$queryRawUnsafe<
    {
      runId: string;
      list: string;
      action: string;
      source: string;
      date: string;
      securityId: string;
      windows: { startDate: string; endDate: string | null }[] | null;
      mode: string;
    }[]
  >(
    `select t."runId", r."stockListName" as list, t.action::text as action, t.source::text as source,
            t.date::text as date, t."securityId",
            (select s->'buyWindows' from jsonb_array_elements(r.snapshot->'securities') s where s->>'securityId' = t."securityId") as windows,
            (select s->>'buyWindowMode' from jsonb_array_elements(r.snapshot->'securities') s where s->>'securityId' = t."securityId") as mode
       from "BacktestTrade" t join "BacktestRun" r on r.id = t."runId"
      where r."stockListName" like 'QA-MATRIX-L%' and r.status = 'COMPLETED'
        and exists (select 1 from jsonb_array_elements(r.snapshot->'securities') s where s->>'buyWindowMode' = 'CUSTOM')`,
  );
  const evidence = {
    tradesInCustomWindowLists: rows.length,
    buysInsideWindow: 0,
    buysOutsideWindow: 0,
    buysOnWindowStart: 0,
    buysOnWindowEnd: 0,
    sellsOutsideWindow: 0,
    finalExitsOutsideWindow: 0,
    liquidationsOutsideWindow: 0,
  };
  for (const row of rows) {
    if (row.mode !== "CUSTOM" || !row.windows) {
      continue;
    }
    const inside = covered(row.windows, row.date);
    if (row.action === "BUY") {
      if (inside) {
        evidence.buysInsideWindow += 1;
      } else {
        evidence.buysOutsideWindow += 1;
      }
      if (row.windows.some((window) => window.startDate === row.date)) {
        evidence.buysOnWindowStart += 1;
      }
      if (row.windows.some((window) => window.endDate === row.date)) {
        evidence.buysOnWindowEnd += 1;
      }
    } else if (!inside) {
      if (row.source === "END_OF_BACKTEST") {
        evidence.liquidationsOutsideWindow += 1;
      } else if (row.action === "FINAL_EXIT") {
        evidence.finalExitsOutsideWindow += 1;
      } else {
        evidence.sellsOutsideWindow += 1;
      }
    }
  }
  ledger.check(
    "buy-windows-matrix",
    "BUY outside a CUSTOM window (must be 0)",
    0,
    evidence.buysOutsideWindow,
    "exact-number",
  );
  input.writer.writeJson("lists/buy-windows.json", {
    description:
      "Production normalizeBuyWindowRanges / isBuyWindowEligible against a date-set reference (leap, month and year boundaries, overlap, adjacency, nesting, open ends), plus the matrix's persisted trades in CUSTOM-window lists.",
    rangeSets: cases,
    probeDaysPerSet: probeDays.length,
    comparisons: ledger.totals(),
    differences: ledger.differences,
    matrixEvidence: evidence,
  });
  return { ledger, evidence };
}
