import type { PrismaClient } from "@intrinsic/database";
import type { BacktestsService } from "../../backtests/backtests.service";
import type { AuditWriter } from "../artifacts";
import { ComparisonLedger } from "../comparison";
import { storedAtScale } from "../oracle/decimal";
import { parseOracleStrategy } from "../oracle/strategy-model";
import type { BacktestExpectation } from "./run-backtest-audit";
import { readPersistedRun } from "./persisted-run";

/**
 * The API layer of the backtest chain:
 *
 *   reference backtester  ──►  expected numbers (at the stored scale)
 *   BacktestsService.getRun / getTrades — the exact code behind GET /backtests/:id and /trades
 *
 * Every summary figure, every annual return, every curve point and every trade the API serves is
 * compared. The HTTP layer itself (routing, guard, serialization) is covered by the UI stage, which
 * reads the same endpoints through a real browser.
 */

const SUMMARY_TEXT = ["firstSimulatedDate", "lastSimulatedDate"] as const;
const SUMMARY_MONEY = [
  "investedCapital",
  "finalCash",
  "finalPositionsValue",
  "finalValue",
  "netProfit",
  "realizedPnl",
  "unrealizedPnl",
] as const;
const SUMMARY_RATIO = [
  "portfolioReturnPercent",
  "benchmarkReturnPercent",
  "alphaPercent",
  "portfolioCagrPercent",
  "maxDrawdownPercent",
  "benchmarkMaxDrawdownPercent",
] as const;
const SUMMARY_COUNT = [
  "tradingDays",
  "totalTrades",
  "buyTrades",
  "sellTrades",
  "finalExitTrades",
  "winningTrades",
  "losingTrades",
  "openPositions",
] as const;

export async function reconcileBacktestApi(input: {
  prisma: PrismaClient;
  backtests: BacktestsService;
  ownerUserId: string;
  expectations: ReadonlyMap<string, BacktestExpectation>;
  writer: AuditWriter;
  log: (line: string) => void;
}): Promise<{
  ledger: ComparisonLedger;
  runs: number;
  summaryFields: number;
  annualReturns: number;
  curvePoints: number;
  tradesServed: number;
  maxAnnualReturnRoundingEffect: number;
  failedRuns: string[];
}> {
  const ledger = new ComparisonLedger(300);
  let runs = 0;
  let summaryFields = 0;
  let annualReturns = 0;
  let curvePoints = 0;
  let tradesServed = 0;
  let maxAnnualReturnRoundingEffect = 0;
  const failedRuns: string[] = [];
  const perRun: Record<string, unknown>[] = [];

  for (const [caseId, expectation] of input.expectations) {
    const before = ledger.failed;
    runs += 1;
    const detail = await input.backtests.getRun(
      input.ownerUserId,
      expectation.runId,
    );
    const result = detail.result;
    ledger.check(
      "api",
      `${caseId} status`,
      "COMPLETED",
      detail.status,
      "exact-text",
    );
    if (!result) {
      ledger.check(
        "api",
        `${caseId} result present`,
        "present",
        "absent",
        "exact-text",
      );
      failedRuns.push(caseId);
      continue;
    }
    const expected = expectation.summary;
    for (const field of SUMMARY_TEXT) {
      summaryFields += 1;
      ledger.check(
        "api-summary",
        `${caseId} summary.${field}`,
        expected[field],
        result.summary[field],
        "exact-text",
      );
    }
    for (const field of SUMMARY_MONEY) {
      summaryFields += 1;
      ledger.check(
        "api-summary",
        `${caseId} summary.${field}`,
        Number(expected[field]),
        result.summary[field],
        "exact-number",
      );
    }
    for (const field of SUMMARY_RATIO) {
      summaryFields += 1;
      const value = expected[field];
      ledger.check(
        "api-summary",
        `${caseId} summary.${field}`,
        value === null ? null : Number(storedAtScale(value, 8)),
        result.summary[field],
        "exact-number",
      );
    }
    for (const field of SUMMARY_COUNT) {
      summaryFields += 1;
      ledger.check(
        "api-summary",
        `${caseId} summary.${field}`,
        expected[field],
        result.summary[field],
        "exact-number",
      );
    }

    // Annual returns: the API derives them from the stored index; the oracle does the same from its
    // own index at the stored scale, and separately from the unrounded index to bound the effect.
    ledger.check(
      "api-annual",
      `${caseId} annualReturns.length`,
      expectation.annualReturnsFromStoredIndex.length,
      result.annualReturns.length,
      "exact-number",
    );
    expectation.annualReturnsFromStoredIndex.forEach((year, index) => {
      const served = result.annualReturns[index];
      annualReturns += 1;
      ledger.check(
        "api-annual",
        `${caseId} ${year.year}.year`,
        year.year,
        served?.year,
        "exact-text",
      );
      ledger.check(
        "api-annual",
        `${caseId} ${year.year}.simulatedThrough`,
        year.simulatedThrough,
        served?.simulatedThrough,
        "exact-text",
      );
      ledger.check(
        "api-annual",
        `${caseId} ${year.year}.partial`,
        year.partial,
        served?.partial,
        "exact-number",
      );
      ledger.check(
        "api-annual",
        `${caseId} ${year.year}.returnPercent`,
        year.returnPercent,
        served?.returnPercent,
        "exact-number",
      );
      const unrounded = expectation.annualReturns[index]?.returnPercent;
      if (unrounded !== undefined && served) {
        maxAnnualReturnRoundingEffect = Math.max(
          maxAnnualReturnRoundingEffect,
          Math.abs(served.returnPercent - unrounded),
        );
      }
    });

    // Curve: every served point is a real equity row, converted exactly; first and last kept.
    const persisted = await readPersistedRun(input.prisma, expectation.runId);
    const byDate = new Map(persisted.equity.map((row) => [row.date, row]));
    const expectedLength = Math.min(persisted.equity.length, 1_500);
    ledger.check(
      "api-curve",
      `${caseId} curve.length`,
      expectedLength,
      result.curve.length,
      "exact-number",
    );
    ledger.check(
      "api-curve",
      `${caseId} curve.first`,
      persisted.equity[0]?.date,
      result.curve[0]?.date,
      "exact-text",
    );
    ledger.check(
      "api-curve",
      `${caseId} curve.last`,
      persisted.equity[persisted.equity.length - 1]?.date,
      result.curve[result.curve.length - 1]?.date,
      "exact-text",
    );
    let previousDate = "";
    for (const point of result.curve) {
      curvePoints += 1;
      const row = byDate.get(point.date);
      if (!row) {
        ledger.check(
          "api-curve",
          `${caseId} curve ${point.date} is an equity row`,
          true,
          false,
          "exact-number",
        );
        continue;
      }
      const ascending = point.date > previousDate;
      previousDate = point.date;
      const ok =
        ascending &&
        point.strategyValue === Number(row.totalValue) &&
        point.cashBaselineValue === Number(row.cashBaselineValue) &&
        point.benchmarkValue ===
          (row.benchmarkValue === null ? null : Number(row.benchmarkValue)) &&
        point.portfolioReturnPercent === (Number(row.returnIndex) - 1) * 100 &&
        point.benchmarkReturnPercent ===
          (row.benchmarkIndex === null
            ? null
            : (Number(row.benchmarkIndex) - 1) * 100);
      ledger.check(
        "api-curve",
        `${caseId} curve ${point.date}`,
        true,
        ok,
        "exact-number",
      );
    }

    // Trade log: every page, newest first, against the persisted rows.
    const definition = parseOracleStrategy(
      (
        await input.prisma.$queryRawUnsafe<{ definition: unknown }[]>(
          `select snapshot->'strategy'->'definition' as definition from "BacktestRun" where id = $1`,
          expectation.runId,
        )
      )[0]?.definition ?? {},
    );
    const levels = new Map<string, { conditions: number; trigger: boolean }>();
    for (const level of [...definition.buyLevels, ...definition.sellLevels]) {
      levels.set(level.id, {
        conditions: level.signal.conditions.length,
        trigger: level.signal.trigger !== null,
      });
    }
    const newestFirst = [...persisted.trades].reverse();
    let page = 1;
    let served = 0;
    for (;;) {
      const response = await input.backtests.getTrades(
        input.ownerUserId,
        expectation.runId,
        { page, pageSize: 200 },
      );
      ledger.check(
        "api-trades",
        `${caseId} trades.totalCount`,
        persisted.trades.length,
        response.totalCount,
        "exact-number",
      );
      for (const item of response.items) {
        const row = newestFirst[served];
        served += 1;
        tradesServed += 1;
        if (!row) {
          ledger.check(
            "api-trades",
            `${caseId} trade ${item.sequence} exists`,
            false,
            true,
            "exact-number",
          );
          continue;
        }
        const expectedSignature = [
          row.sequence,
          row.date,
          row.symbol,
          row.action,
          row.source,
          row.levelPercentage,
          Number(row.shares),
          Number(row.price),
          Number(row.amount),
          row.realizedPnl === null ? null : Number(row.realizedPnl),
          row.realizedPnlPercent === null
            ? null
            : Number(row.realizedPnlPercent),
        ];
        const actualSignature = [
          item.sequence,
          item.date,
          item.symbol,
          item.action,
          item.source,
          item.levelPercentage,
          item.shares,
          item.price,
          item.amount,
          item.realizedPnl,
          item.realizedPnlPercent,
        ];
        ledger.check(
          "api-trades",
          `${caseId} trade ${row.sequence}`,
          JSON.stringify(expectedSignature),
          JSON.stringify(actualSignature),
          "exact-text",
        );
        // The reason is structural evidence of which rule produced the trade.
        let reasonOk: boolean;
        if (row.source === "END_OF_BACKTEST") {
          reasonOk = item.reason?.kind === "END_OF_BACKTEST";
        } else if (row.action === "FINAL_EXIT") {
          const ruleIndex =
            definition.finalExit?.rules.findIndex(
              (rule) => rule.id === row.exitRuleId,
            ) ?? -1;
          const rule = definition.finalExit?.rules[ruleIndex];
          reasonOk =
            item.reason?.kind === "STRATEGY" &&
            rule !== undefined &&
            item.reason.conditions.length === rule.signal.conditions.length &&
            (item.reason.trigger !== undefined) ===
              (rule.signal.trigger !== null) &&
            (definition.finalExit!.rules.length > 1
              ? item.reason.exitRule === ruleIndex + 1
              : item.reason.exitRule === undefined);
        } else {
          const level = levels.get(row.levelId ?? "");
          reasonOk =
            item.reason?.kind === "STRATEGY" &&
            level !== undefined &&
            item.reason.conditions.length === level.conditions &&
            (item.reason.trigger !== undefined) === level.trigger &&
            item.reason.conditions.every((text) => text.trim().length > 0);
        }
        ledger.check(
          "api-trades",
          `${caseId} trade ${row.sequence} reason`,
          true,
          reasonOk,
          "exact-number",
        );
      }
      if (page >= response.pageCount) {
        break;
      }
      page += 1;
    }
    ledger.check(
      "api-trades",
      `${caseId} trades served`,
      persisted.trades.length,
      served,
      "exact-number",
    );
    if (ledger.failed > before) {
      failedRuns.push(caseId);
    }
    perRun.push({
      caseId,
      runId: expectation.runId,
      failed: ledger.failed - before,
      curvePoints: result.curve.length,
      trades: served,
    });
    if (runs % 100 === 0) {
      input.log(`  api ${runs}/${input.expectations.size}`);
    }
  }
  input.writer.writeJson("backtests/api-reconciliation.json", {
    runs,
    summaryFields,
    annualReturns,
    curvePoints,
    tradesServed,
    maxAnnualReturnRoundingEffectPercentPoints: maxAnnualReturnRoundingEffect,
    comparisons: ledger.totals(),
    byCategory: ledger.byCategory(),
    failedRuns,
    differences: ledger.differences,
    perRun,
  });
  return {
    ledger,
    runs,
    summaryFields,
    annualReturns,
    curvePoints,
    tradesServed,
    maxAnnualReturnRoundingEffect,
    failedRuns,
  };
}
