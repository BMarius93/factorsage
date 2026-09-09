import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Refreshes `src/qa-matrix/captured-execution-calendar.ts` from a live database.
 *
 * It reads the pinned execution-calendar series' own bars — the same rows, in the same order, that
 * the worker's `loadExecutionCalendar` reads — and writes them out in the `readonly LocalDate[]`
 * representation the simulation consumes. Nothing is computed: if a date is not in the series, it
 * does not appear here, and the QA matrix has no other way to learn about it.
 *
 * Point it at a database whose `SP500` series carries **real** provider history; a synthetic
 * fixture series would capture a calendar the real runs do not execute on.
 *
 *   DATABASE_URL=postgresql://… pnpm --filter @intrinsic/testing capture:execution-calendar
 */
const QUERY = `
  SELECT to_char(p.date, 'YYYY-MM-DD')
    FROM "BenchmarkDailyPrice" p
    JOIN "BenchmarkSeries" s ON s.id = p."seriesId"
    JOIN "Benchmark" b ON b.id = s."benchmarkId"
   WHERE b.code = 'SP500' AND s.version = 1
   ORDER BY p.date
`;

function query(databaseUrl: string): string[] {
  const output = execFileSync("psql", [databaseUrl, "-t", "-A", "-c", QUERY], {
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d{4}-\d{2}-\d{2}$/.test(line));
}

function main(): void {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "Set DATABASE_URL to a database whose SP500 series carries real provider history.",
    );
  }
  const dates = query(databaseUrl);
  if (dates.length === 0) {
    throw new Error(
      "The SP500 execution-calendar series has no bars in that database; nothing to capture.",
    );
  }

  const byYear = new Map<string, string[]>();
  for (const date of dates) {
    const year = date.slice(0, 4);
    byYear.set(year, [...(byYear.get(year) ?? []), date.slice(5)]);
  }

  const target = join(
    import.meta.dirname,
    "..",
    "src",
    "qa-matrix",
    "captured-execution-calendar.ts",
  );
  const existing = readFileSyncSafe(target);
  const header = existing.slice(
    0,
    existing.indexOf("const CAPTURED_SESSIONS_BY_YEAR"),
  );
  const footer = existing.slice(existing.indexOf("};\n\n/**"));
  const body = [...byYear.entries()]
    .map(([year, days]) => `  "${year}":\n    "${days.join(",")}",`)
    .join("\n");

  writeFileSync(
    target,
    `${header}const CAPTURED_SESSIONS_BY_YEAR: Readonly<Record<string, string>> = {\n${body}\n${footer}`,
  );
  console.log(
    `Captured ${dates.length} execution dates, ${dates[0]} to ${dates[dates.length - 1]}.`,
  );
}

function readFileSyncSafe(path: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:fs").readFileSync(path, "utf8") as string;
}

main();
