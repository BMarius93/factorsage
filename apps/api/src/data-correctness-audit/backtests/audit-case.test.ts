import { describe, expect, it } from "vitest";
import { storedAtScale } from "../oracle/decimal";
import { runReferenceBacktest } from "../oracle/reference-backtester";
import { parseOracleStrategy } from "../oracle/strategy-model";
import type { BacktestArchive } from "./archive-reader";
import { auditCase } from "./audit-case";
import type { PersistedRun } from "./persisted-run";

/**
 * Negative controls: the audit must fail when the persisted run is wrong by the smallest amount the
 * ledger can represent. A comparison that cannot fail proves nothing.
 */

const definition = {
  schemaVersion: 2,
  buyLevels: [
    {
      id: "b",
      percentage: 100,
      signal: {
        conditions: [
          {
            id: "c",
            metric: { kind: "PRICE" },
            operator: "IS_ABOVE",
            value: { kind: "NUMBER", value: 9 },
          },
        ],
      },
    },
  ],
  sellLevels: [],
  finalExit: {
    id: "x",
    rules: [
      {
        id: "x",
        signal: {
          conditions: [
            {
              id: "g",
              metric: { kind: "GAIN" },
              operator: "IS_ABOVE",
              value: { kind: "PERCENT", value: 15 },
            },
          ],
        },
      },
    ],
  },
};
const dates = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"];
const closes = [10, 12, 11.6, 11];

function archive(
  windows: { startDate: string; endDate: string | null }[] | null = null,
): BacktestArchive {
  return {
    path: "memory",
    manifest: {
      archiveSchemaVersion: 2,
      run: { runId: "run", attempt: 1, status: "COMPLETED" },
    },
    snapshot: {
      period: { startDate: dates[0]!, endDate: dates[3]! },
      capital: { initialCapital: 1000, monthlyContribution: 0 },
      allocation: { maximumPositions: 1, fullPositionFraction: 1 },
      strategy: { definition, name: "fixture" },
      stockList: { name: "fixture" },
      securities: [
        {
          securityId: "s1",
          symbol: "AAA",
          buyWindowMode: windows ? "CUSTOM" : "FULL",
          buyWindows: windows ?? [],
        },
      ],
      executionCalendar: { seriesId: "cal" },
      benchmark: { seriesId: "cal", code: "SP500" },
    },
    calendar: dates,
    benchmark: { dates, closes: [100, 101, 102, 103] },
    preparation: {
      securities: [
        {
          securityId: "s1",
          symbol: "AAA",
          skipped: false,
          skipReason: null,
          coverage: null,
        },
      ],
    },
    frames: [
      {
        securityId: "s1",
        symbol: "AAA",
        year: "2024",
        contextRowCount: 0,
        dates,
        closes,
        operands: {},
        window: { requestedFrom: dates[0]!, requestedTo: dates[3]! },
      },
    ],
    contributions: [],
    result: { trades: [], equity: [], summary: null },
  };
}

/** A persisted run exactly as a correct engine would have written it. */
function correctRun(): PersistedRun {
  const oracle = runReferenceBacktest({
    strategy: parseOracleStrategy(definition),
    securities: [
      {
        securityId: "s1",
        symbol: "AAA",
        buyWindowMode: "FULL",
        buyWindows: [],
        rows: dates.map((date, index) => ({
          date,
          close: closes[index]!,
          values: new Map(),
        })),
      },
    ],
    calendar: dates,
    startDate: dates[0]!,
    endDate: dates[3]!,
    initialCapital: 1000,
    monthlyContribution: 0,
    maximumPositions: 1,
    benchmark: { dates, closes: [100, 101, 102, 103] },
  });
  const ratio = (value: number | null, scale: number): string | null =>
    value === null ? null : storedAtScale(value, scale);
  const s = oracle.summary;
  return {
    runId: "run",
    status: "COMPLETED",
    startDate: dates[0]!,
    endDate: dates[3]!,
    trades: oracle.trades.map((trade) => ({
      ...trade,
      realizedPnlPercent: ratio(trade.realizedPnlPercent, 8),
    })),
    equity: oracle.equity.map((row) => ({
      ...row,
      returnIndex: storedAtScale(row.returnIndex, 10),
      benchmarkIndex: ratio(row.benchmarkIndex, 10),
    })),
    summary: {
      ...s,
      portfolioReturnPercent: ratio(s.portfolioReturnPercent, 8),
      benchmarkReturnPercent: ratio(s.benchmarkReturnPercent, 8),
      alphaPercent: ratio(s.alphaPercent, 8),
      portfolioCagrPercent: ratio(s.portfolioCagrPercent, 8),
      maxDrawdownPercent: ratio(s.maxDrawdownPercent, 8),
      benchmarkMaxDrawdownPercent: ratio(s.benchmarkMaxDrawdownPercent, 8),
    },
    positions: 0,
  };
}

function failures(
  persisted: PersistedRun,
  windows: { startDate: string; endDate: string | null }[] | null = null,
) {
  const result = auditCase({
    caseId: "fixture",
    index: 0,
    archive: archive(windows),
    persisted,
  });
  return {
    comparisons: result.ledger.failed,
    invariants: result.counts.invariantViolations,
    ledger: result.counts.ledgerViolations,
    liquidation: result.counts.liquidationFailures,
  };
}

describe("the backtest audit on a hand-sized run", () => {
  it("passes a correct run", () => {
    expect(failures(correctRun())).toEqual({
      comparisons: 0,
      invariants: 0,
      ledger: 0,
      liquidation: 0,
    });
  });

  it("fails on a one-ULP execution price", () => {
    const run = correctRun();
    run.trades[0] = { ...run.trades[0]!, price: "10.00000001" };
    expect(failures(run).comparisons).toBeGreaterThan(0);
  });

  it("fails on a missing trade", () => {
    const run = correctRun();
    run.trades.pop();
    const result = failures(run);
    expect(result.comparisons).toBeGreaterThan(0);
    expect(result.liquidation).toBeGreaterThan(0);
  });

  it("fails on a one-micro-dollar cash difference", () => {
    const run = correctRun();
    run.equity[1] = { ...run.equity[1]!, cash: "1200.000001" };
    const result = failures(run);
    expect(result.comparisons).toBeGreaterThan(0);
    expect(result.ledger).toBeGreaterThan(0);
  });

  it("fails on a one-unit difference in the tenth decimal of the return index", () => {
    const run = correctRun();
    run.equity[2] = { ...run.equity[2]!, returnIndex: "1.2000000001" };
    expect(failures(run).comparisons).toBeGreaterThan(0);
  });

  it("flags a BUY outside the frozen buy window even when the ledger is consistent", () => {
    // The oracle then expects no BUY on 2024-01-04; the persisted run bought anyway.
    const result = failures(correctRun(), [
      { startDate: "2024-01-02", endDate: "2024-01-03" },
    ]);
    expect(result.invariants).toBeGreaterThan(0);
    expect(result.comparisons).toBeGreaterThan(0);
  });
});
