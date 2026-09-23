import { existsSync, readFileSync } from "node:fs";
import type { PrismaClient } from "@intrinsic/database";
import type { AuditWriter } from "../artifacts";
import { ComparisonLedger } from "../comparison";
import { dec } from "../oracle/decimal";

/**
 * Source data: the persisted canonical rows against the provider's raw responses.
 *
 * The raw responses are fetched once with a plain `fetch` (not the product's FMP client, whose
 * interpretation is what is being checked) and frozen under `source-data/raw/`. Every later run
 * compares against the frozen snapshot, so the audit does not depend on today's mutable provider
 * data; delete a snapshot to refresh it deliberately.
 */

const FMP = "https://financialmodelingprep.com/stable";

type RawBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
type RawStatement = Record<string, unknown> & {
  date: string;
  period: string;
  filingDate?: string;
  acceptedDate?: string;
  fiscalYear?: string;
};

async function snapshot<T>(
  writer: AuditWriter,
  name: string,
  url: () => string,
): Promise<{ data: T; fetchedAt: string; fromCache: boolean }> {
  const path = writer.path(`source-data/raw/${name}.json`);
  if (existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, "utf8")) as {
      data: T;
      fetchedAt: string;
    };
    return { ...cached, fromCache: true };
  }
  const response = await fetch(url());
  if (!response.ok) {
    throw new Error(
      `provider snapshot ${name} failed with HTTP ${response.status}`,
    );
  }
  const data = (await response.json()) as T;
  const fetchedAt = new Date().toISOString();
  writer.writeJson(`source-data/raw/${name}.json`, {
    source: url().replace(/apikey=[^&]+/, "apikey=REDACTED"),
    fetchedAt,
    data,
  });
  return { data, fetchedAt, fromCache: false };
}

export async function runSourceDataAudit(input: {
  prisma: PrismaClient;
  writer: AuditWriter;
  apiKey: string | undefined;
  lastClosedSession: string;
  log: (line: string) => void;
}): Promise<{ ledger: ComparisonLedger; summary: Record<string, unknown> }> {
  const { prisma, writer } = input;
  const ledger = new ComparisonLedger(200);
  const key = input.apiKey;
  const need = (name: string): boolean =>
    !existsSync(writer.path(`source-data/raw/${name}.json`));
  const symbols = ["AAPL", "NVDA", "KO", "MRNA", "DIS", "GOOGL"];
  const ranges = [
    ["1992-09-01", "2006-12-31"],
    ["2007-01-01", "2020-12-31"],
    ["2021-01-01", input.lastClosedSession],
  ] as const;
  const perSymbol: Record<string, unknown> = {};
  const samples: Record<string, unknown>[] = [];

  const missingKey =
    [...symbols, "SPY"].some((symbol) =>
      ranges.some((_, index) => need(`${symbol}-eod-${index}`)),
    ) && !key;
  if (missingKey) {
    ledger.skip(
      "source",
      "provider snapshots",
      "no frozen snapshot and no FMP_API_KEY to take one",
    );
    return { ledger, summary: { skipped: "no snapshot and no FMP_API_KEY" } };
  }

  const loadBars = async (
    symbol: string,
  ): Promise<{ bars: Map<string, RawBar>; fetchedAt: string }> => {
    const bars = new Map<string, RawBar>();
    let fetchedAt = "";
    for (const [index, [from, to]] of ranges.entries()) {
      const result = await snapshot<RawBar[]>(
        writer,
        `${symbol}-eod-${index}`,
        () =>
          `${FMP}/historical-price-eod/full?symbol=${symbol}&from=${from}&to=${to}&apikey=${key}`,
      );
      fetchedAt = result.fetchedAt;
      for (const bar of result.data) {
        bars.set(bar.date, bar);
      }
    }
    return { bars, fetchedAt };
  };

  for (const symbol of symbols) {
    const { bars, fetchedAt } = await loadBars(symbol);
    const rows = await prisma.$queryRawUnsafe<
      {
        date: string;
        open: string;
        high: string;
        low: string;
        close: string;
        volume: string;
      }[]
    >(
      `select p.date::text as date, p.open::text as open, p.high::text as high, p.low::text as low, p.close::text as close, p.volume::text as volume
         from "DailyPrice" p join "Security" s on s.id = p."securityId"
        where s.symbol = $1 and s."exchangeCode" in ('NASDAQ','NYSE') and p.date <= $2::date order by p.date`,
      symbol,
      input.lastClosedSession,
    );
    let compared = 0;
    let mismatched = 0;
    let missingInProvider = 0;
    for (const row of rows) {
      const bar = bars.get(row.date);
      if (!bar) {
        missingInProvider += 1;
        ledger.check(
          "source-prices",
          `${symbol} ${row.date} present at the provider`,
          true,
          false,
          "exact-number",
        );
        continue;
      }
      for (const field of ["open", "high", "low", "close"] as const) {
        compared += 1;
        if (
          !ledger.check(
            "source-prices",
            `${symbol} ${row.date} ${field}`,
            String(bar[field]),
            row[field],
            "exact-decimal",
          )
        ) {
          mismatched += 1;
        }
      }
      compared += 1;
      if (
        !ledger.check(
          "source-prices",
          `${symbol} ${row.date} volume`,
          String(bar.volume),
          row.volume,
          "exact-decimal",
        )
      ) {
        mismatched += 1;
      }
      if (
        samples.length < 30 &&
        (row.date.endsWith("-13") || row.date === rows[rows.length - 1]!.date)
      ) {
        samples.push({
          symbol,
          date: row.date,
          field: "close",
          source: bar.close,
          factorSage: Number(row.close),
          difference: Number(row.close) - bar.close,
          result: dec(String(bar.close)).eq(dec(row.close)) ? "PASS" : "FAIL",
        });
      }
    }
    const providerOnly = [...bars.keys()].filter(
      (date) =>
        date <= input.lastClosedSession &&
        date >= (rows[0]?.date ?? "9999") &&
        !rows.some((row) => row.date === date),
    );
    ledger.check(
      "source-prices",
      `${symbol} provider dates missing from DailyPrice`,
      0,
      providerOnly.length,
      "exact-number",
    );
    perSymbol[symbol] = {
      rows: rows.length,
      compared,
      mismatched,
      missingInProvider,
      providerOnlyDates: providerOnly.slice(0, 20),
      snapshotFetchedAt: fetchedAt,
    };
    input.log(
      `  source ${symbol}: ${rows.length} rows, ${compared} fields, ${mismatched} mismatched`,
    );
  }

  // Splits: the persisted series must be split-adjusted — no split ratio survives as a price jump.
  const splitEvidence: Record<string, unknown>[] = [];
  for (const symbol of ["AAPL", "NVDA", "GOOGL"]) {
    const splits = await snapshot<
      { date: string; numerator: number; denominator: number }[]
    >(
      writer,
      `${symbol}-splits`,
      () => `${FMP}/splits?symbol=${symbol}&apikey=${key}`,
    );
    for (const split of splits.data.filter(
      (entry) =>
        entry.date >= "1992-09-10" && entry.date <= input.lastClosedSession,
    )) {
      const around = await prisma.$queryRawUnsafe<
        { date: string; close: string }[]
      >(
        `select p.date::text as date, p.close::text as close from "DailyPrice" p join "Security" s on s.id = p."securityId"
          where s.symbol = $1 and s."exchangeCode" in ('NASDAQ','NYSE') and p.date between ($2::date - 7) and ($2::date + 7) order by p.date`,
        symbol,
        split.date,
      );
      const before = [...around].reverse().find((row) => row.date < split.date);
      const on = around.find((row) => row.date >= split.date);
      const ratio =
        before && on ? Number(on.close) / Number(before.close) : null;
      const splitRatio = split.numerator / split.denominator;
      // An unadjusted series would jump by about 1/splitRatio on the split date.
      const adjusted =
        ratio !== null &&
        Math.abs(Math.log(ratio)) < Math.abs(Math.log(splitRatio)) / 2;
      ledger.check(
        "source-splits",
        `${symbol} ${split.date} ${split.numerator}:${split.denominator} is adjusted`,
        true,
        adjusted,
        "exact-number",
      );
      splitEvidence.push({
        symbol,
        split: `${split.numerator}:${split.denominator}`,
        date: split.date,
        closeBefore: before?.close,
        closeOn: on?.close,
        dayOverDayRatio: ratio,
        adjusted,
      });
    }
  }
  // Every persisted day-over-day move beyond +80% / -45% across the matrix universe, for review.
  const jumps = await prisma.$queryRawUnsafe<
    { symbol: string; date: string; ratio: number }[]
  >(
    `select symbol, date::text as date, ratio from (
       select s.symbol, p.date, p.close / lag(p.close) over (partition by p."securityId" order by p.date) as ratio
         from "DailyPrice" p join "Security" s on s.id = p."securityId") x
      where ratio > 1.8 or ratio < 0.55 order by symbol, date`,
  );

  // Statements: values FactorSage reads, and the filing date it derives availability from.
  const statementEvidence: Record<string, unknown>[] = [];
  for (const symbol of ["KO", "AAPL", "DIS"]) {
    const raw = await snapshot<RawStatement[]>(
      writer,
      `${symbol}-income-quarter`,
      () =>
        `${FMP}/income-statement?symbol=${symbol}&period=quarter&limit=40&apikey=${key}`,
    );
    for (const statement of raw.data) {
      const stored = await prisma.$queryRawUnsafe<
        {
          values: Record<string, unknown>;
          filingDate: string;
          providerAcceptedDate: string | null;
        }[]
      >(
        `select f.values, f."filingDate"::text as "filingDate", f."providerAcceptedDate" from "FinancialStatement" f join "Security" s on s.id = f."securityId"
          where s.symbol = $1 and s."exchangeCode" in ('NASDAQ','NYSE') and f."statementType" = 'INCOME' and f.period::text = $2 and f."fiscalDate" = $3::date
          order by f."availableFromDate" desc, f."observedAt" desc limit 1`,
        symbol,
        statement.period,
        statement.date,
      );
      const row = stored[0];
      if (!row) {
        ledger.skip(
          "source-statements",
          `${symbol} ${statement.date} ${statement.period}`,
          "not retained in the matrix database",
        );
        continue;
      }
      for (const field of [
        "revenue",
        "netIncome",
        "epsDiluted",
        "weightedAverageShsOutDil",
        "interestExpense",
      ]) {
        if (statement[field] === undefined) {
          continue;
        }
        ledger.check(
          "source-statements",
          `${symbol} ${statement.date} ${statement.period} ${field}`,
          statement[field],
          row.values[field] ?? null,
          "exact-number",
        );
      }
      ledger.check(
        "source-statements",
        `${symbol} ${statement.date} ${statement.period} filingDate`,
        statement.filingDate,
        row.filingDate,
        "exact-text",
      );
      if (statementEvidence.length < 24) {
        statementEvidence.push({
          symbol,
          fiscalDate: statement.date,
          period: statement.period,
          provider: {
            filingDate: statement.filingDate,
            acceptedDate: statement.acceptedDate,
            revenue: statement.revenue,
            epsDiluted: statement.epsDiluted,
          },
          factorSage: {
            filingDate: row.filingDate,
            providerAcceptedDate: row.providerAcceptedDate,
            revenue: row.values.revenue,
            epsDiluted: row.values.epsDiluted,
          },
        });
      }
    }
  }

  // Benchmark: SPY closes against the SP500 series bars.
  const spy = await loadBars("SPY");
  const benchmarkRows = await prisma.$queryRawUnsafe<
    { date: string; close: string }[]
  >(
    `select b.date::text as date, b.close::text as close from "BenchmarkDailyPrice" b
       join "BenchmarkSeries" s on s.id = b."seriesId" join "Benchmark" k on k.id = s."benchmarkId"
      where k.code = 'SP500' and b.date <= $1::date order by b.date`,
    input.lastClosedSession,
  );
  let benchmarkMismatches = 0;
  for (const row of benchmarkRows) {
    const bar = spy.bars.get(row.date);
    if (
      !bar ||
      !ledger.check(
        "source-benchmark",
        `SPY ${row.date} close`,
        String(bar.close),
        row.close,
        "exact-decimal",
      )
    ) {
      benchmarkMismatches += 1;
    }
  }

  const summary = {
    comparisons: ledger.totals(),
    byCategory: ledger.byCategory(),
    perSymbol,
    samples,
    splits: splitEvidence,
    largeDailyMoves: jumps,
    statements: statementEvidence,
    benchmark: { rows: benchmarkRows.length, mismatches: benchmarkMismatches },
    differences: ledger.differences,
  };
  writer.writeJson("source-data/summary.json", summary);
  return { ledger, summary };
}
