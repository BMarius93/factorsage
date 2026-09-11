import type { BacktestRunSnapshot } from "@intrinsic/contracts";
import type { RunEvidence } from "./matrix-invariants";

/**
 * A minimal, valid `RunEvidence` the invariant and runner suites build on.
 *
 * Every field is present and internally consistent, so a test states only the one thing it is
 * about. A helper that produced a subtly broken baseline would make every suite that used it prove
 * the helper rather than the subject.
 */
export function emptyEvidence(
  overrides: Partial<RunEvidence> & { runId: string; caseId: string },
): RunEvidence {
  const snapshot = {
    securities: [],
    strategy: { definition: { buyLevels: [], sellLevels: [] } },
  } as unknown as BacktestRunSnapshot;
  return {
    status: "COMPLETED",
    failureCode: null,
    failureMessage: null,
    failurePhase: null,
    snapshot,
    startDate: "2026-01-01",
    endDate: "2026-01-02",
    initialCapital: "100.000000",
    monthlyContribution: "0.000000",
    maximumPositions: 10,
    summary: null,
    equity: [],
    trades: [],
    positions: [],
    executionCalendarDates: [],
    benchmarkCloses: [],
    firstPriceDateBySecurityId: new Map(),
    ...overrides,
  };
}

/**
 * A fully populated `RunEvidence`: one trade, one equity row, one open position, one summary, and
 * every persisted column set to a distinguishable value.
 *
 * The determinism suite mutates exactly one field at a time against this, so a field left at a
 * default that happens to equal its mutation would silently make that test vacuous. Everything
 * here is therefore a real, distinct value rather than a zero.
 */
export function completeEvidence(
  overrides: Partial<RunEvidence> & { runId: string; caseId: string },
): RunEvidence {
  const securityId = "sec-1";
  return emptyEvidence({
    startDate: "2026-01-01",
    endDate: "2026-01-02",
    initialCapital: "100000.000000",
    monthlyContribution: "0.000000",
    maximumPositions: 10,
    trades: [
      {
        sequence: 1,
        date: "2026-01-02",
        securityId,
        symbol: "AAA",
        name: "AAA Inc.",
        action: "BUY",
        levelId: "b100",
        levelPercentage: 100,
        shares: "10.0000000000",
        price: "50.00000000",
        amount: "5000.000000",
        fees: "0.000000",
        realizedPnl: null,
        realizedPnlPercent: null,
        cashAfter: "95000.000000",
        sharesAfter: "10.0000000000",
        averageCostAfter: "50.00000000",
      },
    ],
    equity: [
      {
        date: "2026-01-02",
        cash: "95000.000000",
        positionsValue: "5000.000000",
        totalValue: "100000.000000",
        investedCapital: "100000.000000",
        returnIndex: "1.0000000000",
        benchmarkIndex: "1.0000000000",
        benchmarkValue: "100000.000000",
        cashBaselineValue: "100000.000000",
        openPositions: 1,
      },
    ],
    positions: [
      {
        securityId,
        symbol: "AAA",
        name: "AAA Inc.",
        openedDate: "2026-01-02",
        shares: "10.0000000000",
        averageCost: "50.00000000",
        lastPrice: "60.00000000",
        lastPriceDate: "2026-01-02",
        marketValue: "600.000000",
        unrealizedPnl: "100.000000",
        unrealizedPnlPercent: "20.00000000",
        allocationPercent: "5.00000000",
      },
    ],
    summary: {
      firstSimulatedDate: "2026-01-02",
      lastSimulatedDate: "2026-01-02",
      tradingDays: 1,
      investedCapital: "100000.000000",
      finalCash: "95000.000000",
      finalPositionsValue: "600.000000",
      finalValue: "95600.000000",
      netProfit: "-4400.000000",
      portfolioReturnPercent: "-4.40000000",
      benchmarkReturnPercent: "1.50000000",
      alphaPercent: "-5.90000000",
      portfolioCagrPercent: "-4.40000000",
      maxDrawdownPercent: "4.40000000",
      benchmarkMaxDrawdownPercent: "0.25000000",
      realizedPnl: "0.000000",
      unrealizedPnl: "100.000000",
      totalTrades: 1,
      buyTrades: 1,
      sellTrades: 0,
      finalExitTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      openPositions: 1,
    },
    ...overrides,
  });
}
